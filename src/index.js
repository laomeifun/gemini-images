#!/usr/bin/env node
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "http://127.0.0.1:8317";
  return trimmed.replace(/\/+$/, "");
}

function toV1BaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/v1")) return normalized;
  return `${normalized}/v1`;
}

function parseIntOr(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, n));
}

function extFromMime(mimeType) {
  switch (String(mimeType || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

function resolveOutDir(rawOutDir) {
  const outDir = String(rawOutDir ?? "").trim();
  if (!outDir) return path.join(PROJECT_ROOT, "debug-output");
  if (path.isAbsolute(outDir)) return outDir;
  return path.resolve(PROJECT_ROOT, outDir);
}

function toDisplayPath(filePath) {
  return String(filePath ?? "").replaceAll("\\", "/");
}

function formatDateForFilename(date) {
  const d = date instanceof Date ? date : new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function isDebugEnabled() {
  return process.env.OPENAI_DEBUG === "1" || process.env.DEBUG === "1";
}

function debugLog(...args) {
  if (isDebugEnabled()) console.error(...args);
}

function parseDataUrl(maybeDataUrl) {
  const s = String(maybeDataUrl ?? "");
  const match = /^data:([^;]+);base64,(.+)$/s.exec(s);
  if (!match) return null;
  return {
    mimeType: match[1].trim() || "application/octet-stream",
    base64: match[2],
  };
}

function stripDataUrlPrefix(maybeDataUrl) {
  const parsed = parseDataUrl(maybeDataUrl);
  return parsed ? parsed.base64 : String(maybeDataUrl ?? "");
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUrlAsBase64(url, timeoutMs) {
  const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`拉取图片失败: HTTP ${res.status} ${body}`);
  }
  const mimeTypeHeader = res.headers.get("content-type") ?? "image/png";
  const mimeType = mimeTypeHeader.split(";")[0].trim() || "image/png";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mimeType };
}

class HttpError extends Error {
  constructor(message, { status, url, body }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

async function generateImagesViaImagesApi({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  n,
  timeoutMs,
}) {
  const v1BaseUrl = toV1BaseUrl(baseUrl);
  const url = `${v1BaseUrl}/images/generations`;

  const headers = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    prompt,
    size,
    n,
    response_format: "b64_json",
  };

  debugLog(
    `[upstream] POST ${url} (images/generations) model=${model} size=${size} n=${n} hasApiKey=${Boolean(apiKey)}`,
  );

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 ? "（看起来需要 API Key，请设置 OPENAI_API_KEY）" : "";
    throw new HttpError(`图片生成失败: HTTP ${res.status}${hint} ${text}`, {
      status: res.status,
      url,
      body: text,
    });
  }

  /** @type {{ data?: Array<{ b64_json?: string; url?: string }>} } */
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];

  /** @type {Array<{base64:string; mimeType:string}>} */
  const images = [];
  for (const item of data) {
    if (typeof item?.b64_json === "string" && item.b64_json.trim()) {
      const parsed = parseDataUrl(item.b64_json);
      images.push({
        base64: stripDataUrlPrefix(item.b64_json),
        mimeType: parsed?.mimeType ?? "image/png",
      });
      continue;
    }
    if (typeof item?.url === "string" && item.url.trim()) {
      images.push(await fetchUrlAsBase64(item.url, timeoutMs));
    }
  }

  if (images.length === 0) throw new Error("接口未返回可用的图片数据");
  return images;
}

async function generateImagesViaChatCompletions({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  timeoutMs,
}) {
  const v1BaseUrl = toV1BaseUrl(baseUrl);
  const url = `${v1BaseUrl}/chat/completions`;

  const headers = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    modalities: ["image"],
    image_config: {
      image_size: size,
    },
  };

  debugLog(
    `[upstream] POST ${url} (chat/completions) model=${model} image_config.image_size=${size} hasApiKey=${Boolean(apiKey)}`,
  );

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 ? "（看起来需要 API Key，请设置 OPENAI_API_KEY）" : "";
    throw new HttpError(`图片生成失败: HTTP ${res.status}${hint} ${text}`, {
      status: res.status,
      url,
      body: text,
    });
  }

  /** @type {{ choices?: Array<{ message?: { images?: Array<any> } }> }} */
  const json = await res.json();
  const choices = Array.isArray(json?.choices) ? json.choices : [];

  /** @type {Array<{base64:string; mimeType:string}>} */
  const images = [];

  for (const choice of choices) {
    const messageImages = choice?.message?.images;
    if (!Array.isArray(messageImages)) continue;
    for (const img of messageImages) {
      const imageUrl =
        img?.image_url?.url ?? img?.url ?? img?.imageUrl ?? img?.image_url ?? "";
      if (typeof imageUrl !== "string" || !imageUrl.trim()) continue;

      const parsed = parseDataUrl(imageUrl);
      if (parsed) {
        images.push({ base64: parsed.base64, mimeType: parsed.mimeType });
        continue;
      }
      images.push(await fetchUrlAsBase64(imageUrl, timeoutMs));
    }
  }

  if (images.length === 0) {
    throw new Error(
      "接口未返回可用的图片数据（chat/completions 未找到 choices[].message.images）",
    );
  }

  return images;
}

async function generateImages(params) {
  const mode = String(process.env.OPENAI_IMAGE_MODE ?? "chat")
    .trim()
    .toLowerCase();

  if (mode === "images") {
    return await generateImagesViaImagesApi(params);
  }

  const count = clampInt(parseIntOr(params?.n, 1), 1, 4);

  if (mode === "auto") {
    try {
      return await generateImagesViaImagesApi(params);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        debugLog("[upstream] images/generations 返回 404，改用 chat/completions");
        /** @type {Array<{base64:string; mimeType:string}>} */
        const out = [];
        for (let i = 0; i < count; i += 1) {
          const batch = await generateImagesViaChatCompletions(params);
          out.push(...batch);
          if (out.length >= count) break;
        }
        return out.slice(0, count);
      }
      throw err;
    }
  }

  // chat (default)
  /** @type {Array<{base64:string; mimeType:string}>} */
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const batch = await generateImagesViaChatCompletions(params);
    out.push(...batch);
    if (out.length >= count) break;
  }
  return out.slice(0, count);
}

const DEFAULT_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT = "path"; // path|image

const server = new Server(
  { name: "gemini-image-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        '通过 OpenAI-compatible 接口调用 Gemini 的 "gemini-3-pro-image-preview" 生成图片：默认保存到本地并返回文件路径（避免 base64 导致 token 暴涨）；也可用 output=image 返回 MCP image content。',
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "图片描述/提示词（必填）",
          },
          size: {
            type: "string",
            description: `图片尺寸，默认 ${DEFAULT_SIZE}（按你的网关/模型支持填写）`,
          },
          n: {
            type: "integer",
            description: "生成张数，默认 1（建议 1-4）",
            minimum: 1,
            maximum: 4,
          },
          output: {
            type: "string",
            description: `返回格式：path（默认，保存后返回路径）或 image（返回 MCP image base64）`,
            enum: ["path", "image"],
          },
          outDir: {
            type: "string",
            description:
              "保存目录（可选）：相对路径以项目根目录为基准；默认 debug-output/；也可用环境变量 OPENAI_IMAGE_OUT_DIR",
          },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  if (toolName !== "generate_image") {
    return {
      isError: true,
      content: [{ type: "text", text: `未知工具: ${toolName}` }],
    };
  }

  const args = request.params?.arguments ?? {};
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) {
    return { isError: true, content: [{ type: "text", text: "参数 prompt 不能为空" }] };
  }

  const size = String(args.size ?? process.env.OPENAI_IMAGE_SIZE ?? DEFAULT_SIZE).trim();
  const n = clampInt(parseIntOr(args.n, 1), 1, 4);
  const output = String(args.output ?? process.env.OPENAI_IMAGE_RETURN ?? DEFAULT_OUTPUT)
    .trim()
    .toLowerCase();
  const outDir = resolveOutDir(args.outDir ?? args.out_dir ?? process.env.OPENAI_IMAGE_OUT_DIR);

  const baseUrl = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8317";
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = clampInt(
    parseIntOr(process.env.OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    5_000,
    600_000,
  );

  try {
    const images = await generateImages({
      baseUrl,
      apiKey,
      model,
      prompt,
      size,
      n,
      timeoutMs,
    });

    if (output === "image") {
      return {
        content: images.map((img) => ({
          type: "image",
          mimeType: img.mimeType,
          data: img.base64,
        })),
      };
    }

    await fs.mkdir(outDir, { recursive: true });
    const batchId = `${formatDateForFilename(new Date())}-${crypto.randomBytes(4).toString("hex")}`;
    const saved = [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      const ext = extFromMime(img.mimeType);
      const filePath = path.join(outDir, `image-${batchId}-${i + 1}.${ext}`);
      await fs.writeFile(filePath, Buffer.from(img.base64, "base64"));
      saved.push(filePath);
    }

    debugLog(`[local] 已保存 ${saved.length} 张图片到 ${outDir}`);

    return {
      content: [
        {
          type: "text",
          text: saved.map((p) => toDisplayPath(p)).join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `生成失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("gemini-image-mcp 已启动（stdio）");
