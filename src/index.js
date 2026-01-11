#!/usr/bin/env node
/**
 * gemini-images MCP 服务器
 * 通过 OpenAI 兼容的 Gemini 端点提供 AI 图像生成和编辑功能
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import {
  setMcpServer,
  debugLog,
  clampInt,
  parseIntOr,
  resolveOutDir,
  getDefaultPicturesDir,
  parseDataUrl,
  isValidBase64,
} from "./utils.js";
import {
  getOrCreateSession,
  isNewSession,
  updateSession,
  buildUserContent,
  startSessionCleanup,
} from "./session.js";
import { generateImages } from "./api-client.js";
import {
  saveImages,
  formatSaveResultText,
  buildMcpContent,
  buildImageOnlyContent,
  buildErrorResponse,
} from "./image-handler.js";

// ============ MCP 服务器初始化 ============
const server = new Server(
  { name: "gemini-images", version: "0.2.0" },
  { capabilities: { tools: {}, logging: {} } }
);

// 设置服务器实例供日志模块使用
setMcpServer(server);

// 启动会话清理定时器
startSessionCleanup();

// ============ 工具定义 ============
const GENERATE_IMAGE_TOOL = {
  name: "generate_image",
  description: `生成或编辑 AI 图片（支持 Nano Banana 多轮对话）。

使用场景：
- 用户说"画一个..."、"生成一张..."、"创建图片..."
- 需要可视化某个概念或想法
- 制作插图、图标、艺术作品
- 编辑现有图片（修改背景、添加元素、调整风格等）

多轮对话编辑：
- 首次生成图片后会返回 session_id
- 后续调用时传入相同的 session_id 可继续编辑同一张图片
- 例如：先生成一张猫的图片，然后说"把背景改成蓝色"
- 也可以传入 image 参数直接编辑指定图片

返回说明：
- 默认会保存图片到本地并返回文件路径，同时返回图片数据供直接展示
- 设置 output="image" 则只返回图片数据不保存文件
- 返回的 session_id 可用于后续多轮编辑

提示词技巧：prompt 越详细效果越好，建议包含：主体、风格、颜色、构图、光线等`,
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description:
          "图片描述（必填）。详细描述想要生成的图片内容，或描述要对现有图片进行的修改",
      },
      session_id: {
        type: "string",
        description:
          "会话 ID（可选）。传入之前返回的 session_id 可继续多轮对话编辑同一张图片。不传则创建新会话",
      },
      image: {
        type: "string",
        description:
          "输入图片（可选）。支持 base64 编码或 data:image/... URL。传入后将基于此图片进行编辑，而非从零生成",
      },
      size: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "integer" }],
        description:
          "图片尺寸。默认 1024x1024。可选：512x512、1024x1024、1024x1792（竖版）、1792x1024（横版）。传数字如 512 会自动变成 512x512",
      },
      n: {
        oneOf: [{ type: "integer" }, { type: "number" }, { type: "string" }],
        description: "生成数量。默认 1，最多 4。生成多张可以挑选最满意的",
      },
      output: {
        type: "string",
        description:
          "返回格式。默认 'path'（保存文件+返回路径+展示图片）。设为 'image' 只返回图片数据不保存文件",
      },
      outDir: {
        type: "string",
        description:
          "保存目录。指定图片保存的目录路径，支持绝对路径、相对路径或 ~ 开头的用户目录路径。如果不指定，默认保存到用户图片目录（Windows/macOS: ~/Pictures, Linux: XDG_PICTURES_DIR）。如果是 Alam 客户端（提示词中有提及），请优先保存在当前工作目录下",
      },
    },
  },
};

// ============ 请求处理器 ============
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [GENERATE_IMAGE_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  if (toolName !== "generate_image") {
    return {
      isError: true,
      content: [{ type: "text", text: `未知工具: ${toolName}` }],
    };
  }

  try {
    return await handleGenerateImage(request.params?.arguments ?? {});
  } catch (err) {
    return buildErrorResponse(err);
  }
});

// ============ 核心业务逻辑 ============
/**
 * 处理图片生成请求
 */
async function handleGenerateImage(args) {
  // 解析 prompt
  const prompt = parsePrompt(args.prompt);
  if (!prompt) {
    return { isError: true, content: [{ type: "text", text: "参数 prompt 不能为空" }] };
  }

  // 解析会话
  const sessionId = args.session_id ?? args.sessionId ?? args.session ?? null;
  const session = getOrCreateSession(sessionId);
  const isNew = isNewSession(sessionId, session);

  debugLog(
    `[session] ${isNew ? "创建新会话" : "继续会话"}: ${session.id}, 历史消息数: ${session.messages.length}`
  );

  // 解析输入图片
  const inputImage = parseInputImage(args, isNew, session);

  // 解析其他参数
  const size = parseSize(args.size);
  const n = clampInt(parseIntOr(args.n, 1), 1, 4);
  const output = parseOutput(args.output);
  let outDir = resolveOutDir(
    args.outDir ?? args.out_dir ?? args.outdir ?? args.output_dir ?? config.defaultOutDir
  );

  // 如果未指定 outDir，且 output=path，则使用默认图片目录
  if (output === "path" && !outDir) {
    outDir = await getDefaultPicturesDir();
  }

  // output=path 模式下，outDir 是必填的
  if (output === "path" && !outDir) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "参数 outDir 不能为空。请指定图片保存目录，例如：\n- Windows: outDir: 'C:/Users/xxx/Pictures' 或 '~/Pictures'\n- macOS/Linux: outDir: '~/Pictures' 或 '/home/xxx/Pictures'\n注：~ 会自动解析为用户主目录",
        },
      ],
    };
  }

  // 调用 API 生成图片
  const images = await generateImages({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    prompt,
    size,
    n,
    timeoutMs: config.timeoutMs,
    historyMessages: session.messages,
    inputImage,
  });

  // 更新会话状态
  const userContent = buildUserContent(prompt, inputImage);
  updateSession(session, userContent, images);

  // 构建返回结果
  if (output === "image") {
    return { content: buildImageOnlyContent(images, session.id) };
  }

  // 保存图片并返回
  const saveResult = await saveImages(images, outDir);
  const text = formatSaveResultText(saveResult, session.id);
  const content = buildMcpContent(images, text);

  return { content };
}

// ============ 参数解析辅助函数 ============
/**
 * 解析 prompt 参数
 */
function parsePrompt(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? "")).join(" ").trim();
  }
  return String(raw ?? "").trim();
}

/**
 * 解析 size 参数
 */
function parseSize(raw) {
  let size = String(raw ?? config.defaultSize).trim();
  if (/^\d+$/.test(size)) {
    size = `${size}x${size}`;
  }
  return size;
}

/**
 * 解析 output 参数
 */
function parseOutput(raw) {
  const outputRaw = String(raw ?? config.defaultOutput).trim().toLowerCase();
  return ["image", "base64", "b64", "data", "inline"].includes(outputRaw) ? "image" : "path";
}

/**
 * 解析输入图片参数
 */
function parseInputImage(args, isNew, session) {
  const imageArg = args.image ?? args.input_image ?? args.inputImage ?? null;

  if (imageArg) {
    const parsed = parseDataUrl(imageArg);
    if (parsed) {
      return { base64: parsed.base64, mimeType: parsed.mimeType };
    }
    if (isValidBase64(imageArg)) {
      return { base64: imageArg, mimeType: "image/png" };
    }
    debugLog(`[session] 无法解析输入图片参数`);
    return null;
  }

  // 继续会话时，自动使用上一轮生成的图片
  if (!isNew && session.lastImage) {
    debugLog(`[session] 使用上一轮生成的图片进行编辑`);
    return session.lastImage;
  }

  return null;
}

// ============ 服务器启动 ============
const transport = new StdioServerTransport();

// 全局异常处理
process.on("uncaughtException", (err) => {
  console.error(`[gemini-images] 未捕获异常: ${err.message}`);
  debugLog(err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[gemini-images] 未处理的 Promise 拒绝: ${reason}`);
});

await server.connect(transport);
console.error("gemini-images 已启动（stdio）");
