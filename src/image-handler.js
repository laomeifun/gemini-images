/**
 * 图片处理模块 - 图片保存和结果格式化
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";
import {
  debugLog,
  extFromMime,
  toDisplayPath,
  generateBatchId,
} from "./utils.js";

/**
 * @typedef {Object} ImageResult
 * @property {string} base64 - Base64 编码的图片数据
 * @property {string} mimeType - MIME 类型
 */

/**
 * @typedef {Object} SaveResult
 * @property {string[]} saved - 成功保存的文件路径
 * @property {string[]} errors - 错误信息
 * @property {string} finalOutDir - 最终使用的输出目录
 * @property {string} warningMsg - 警告信息
 */

/**
 * 确保目录存在且可写
 * @param {string} outDir - 目标目录
 * @returns {Promise<{dir: string, warning: string}>}
 */
async function ensureWritableDir(outDir) {
  let finalDir = outDir;
  let warning = "";

  try {
    await fs.mkdir(finalDir, { recursive: true });
    await fs.access(finalDir, fs.constants.W_OK);
  } catch (err) {
    const tmpDir = os.tmpdir();
    debugLog(`[local] 目录 ${finalDir} 无法写入 (${err.message})，回退到临时目录: ${tmpDir}`);
    warning = `⚠️ 原定目录 "${toDisplayPath(finalDir)}" 无法写入，已自动保存到临时目录。\n`;
    finalDir = tmpDir;
    await fs.mkdir(finalDir, { recursive: true });
  }

  return { dir: finalDir, warning };
}

/**
 * 保存图片到本地
 * @param {ImageResult[]} images - 图片数据
 * @param {string} outDir - 输出目录
 * @returns {Promise<SaveResult>}
 */
export async function saveImages(images, outDir) {
  const { dir: finalOutDir, warning: warningMsg } = await ensureWritableDir(outDir);

  const batchId = generateBatchId();
  const saved = [];
  const errors = [];

  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    const ext = extFromMime(img.mimeType);
    const filePath = path.join(finalOutDir, `image-${batchId}-${i + 1}.${ext}`);

    try {
      if (!img.base64 || typeof img.base64 !== "string") {
        errors.push(`图片 ${i + 1}: 无效的图片数据`);
        continue;
      }
      const buffer = Buffer.from(img.base64, "base64");
      if (buffer.length === 0) {
        errors.push(`图片 ${i + 1}: 图片数据为空`);
        continue;
      }
      await fs.writeFile(filePath, buffer);
      saved.push(filePath);
    } catch (writeErr) {
      errors.push(`图片 ${i + 1}: 保存失败 - ${writeErr.message}`);
    }
  }

  debugLog(`[local] 已保存 ${saved.length} 张图片到 ${finalOutDir}`);

  return { saved, errors, finalOutDir, warningMsg };
}

/**
 * 构建保存结果的文本消息
 * @param {SaveResult} saveResult - 保存结果
 * @param {string} sessionId - 会话 ID
 * @returns {string}
 */
export function formatSaveResultText(saveResult, sessionId) {
  const { saved, errors, warningMsg } = saveResult;
  const lines = [];

  if (warningMsg) {
    lines.push(warningMsg);
  }

  if (saved.length > 0) {
    lines.push(`✅ 成功生成 ${saved.length} 张图片：\n`);
    for (const p of saved) {
      const displayPath = toDisplayPath(p);
      const fileUri = `file:///${displayPath.replace(/^\//, "")}`;
      lines.push(`![${path.basename(p)}](${fileUri})`);
      lines.push(`📁 ${displayPath}\n`);
    }
  }

  if (errors.length > 0) {
    lines.push(`⚠️ 部分失败：`);
    lines.push(...errors);
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔗 session_id: ${sessionId}`);
  lines.push(`📌 如需修改此图片，下次调用时传入此 session_id`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return lines.join("\n");
}

/**
 * 构建 MCP 返回内容
 * @param {ImageResult[]} images - 图片数据
 * @param {string} text - 文本消息
 * @param {boolean} includeInlineImages - 是否包含内联图片
 * @returns {Array}
 */
export function buildMcpContent(images, text, includeInlineImages = true) {
  const content = [{ type: "text", text }];

  if (!includeInlineImages) {
    return content;
  }

  const inlineMaxSize = config.inlineMaxSize;
  if (inlineMaxSize <= 0) {
    return content;
  }

  for (const img of images) {
    if (img.base64 && typeof img.base64 === "string") {
      const estimatedSize = img.base64.length * 0.75;
      if (estimatedSize <= inlineMaxSize) {
        content.push({
          type: "image",
          mimeType: img.mimeType || "image/png",
          data: img.base64,
        });
      }
    }
  }

  return content;
}

/**
 * 构建仅图片模式的返回内容
 * @param {ImageResult[]} images - 图片数据
 * @param {string} sessionId - 会话 ID
 * @returns {Array}
 */
export function buildImageOnlyContent(images, sessionId) {
  const text = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🔗 session_id: ${sessionId}`,
    `📌 如需修改此图片，下次调用时传入此 session_id`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");

  return [
    { type: "text", text },
    ...images.map((img) => ({
      type: "image",
      mimeType: img.mimeType,
      data: img.base64,
    })),
  ];
}

/**
 * 构建错误响应
 * @param {Error} err - 错误对象
 * @returns {{isError: boolean, content: Array}}
 */
export function buildErrorResponse(err) {
  const errMsg = err instanceof Error ? err.message : String(err);
  
  // 提供更友好的错误信息和建议
  let suggestion = "";
  if (errMsg.includes("ECONNREFUSED") || errMsg.includes("ENOTFOUND")) {
    suggestion = "\n💡 建议：检查 OPENAI_BASE_URL 是否正确，服务是否已启动";
  } else if (errMsg.includes("401") || errMsg.includes("API Key")) {
    suggestion = "\n💡 建议：设置 OPENAI_API_KEY 或 GEMINI_API_KEY 环境变量";
  } else if (errMsg.includes("超时")) {
    suggestion = "\n💡 建议：增加 OPENAI_TIMEOUT_MS 环境变量（当前默认 120 秒）";
  } else if (errMsg.includes("ENOSPC")) {
    suggestion = "\n💡 建议：磁盘空间不足，请清理后重试";
  } else if (errMsg.includes("EACCES") || errMsg.includes("EPERM")) {
    suggestion = "\n💡 建议：没有写入权限，请检查 outDir 目录权限";
  }

  return {
    isError: true,
    content: [{ type: "text", text: `❌ 生成失败: ${errMsg}${suggestion}` }],
  };
}
