/**
 * 工具函数模块 - 通用辅助函数
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { config } from "./config.js";

// ============ 日志工具 ============
let mcpServer = null;

/**
 * 设置 MCP 服务器实例（用于发送日志）
 */
export function setMcpServer(server) {
  mcpServer = server;
}

/**
 * 发送日志消息
 */
export function sendLog(level, data) {
  const message = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  console.error(`[${level}] ${message}`);

  try {
    if (mcpServer?.transport) {
      mcpServer.sendLoggingMessage({ level, data: message }).catch(() => {});
    }
  } catch {
    // 忽略错误
  }
}

/**
 * 调试日志
 */
export function debugLog(...args) {
  if (config.isDebugEnabled) {
    sendLog("debug", args.join(" "));
  }
}

// ============ 数值解析工具 ============
/**
 * 安全解析整数，失败返回默认值
 */
export function parseIntOr(value, fallback) {
  const n = parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 限制数值在指定范围内
 */
export function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, n));
}

// ============ URL 处理工具 ============
/**
 * 规范化 Base URL
 */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "http://127.0.0.1:8317";
  return trimmed.replace(/\/+$/, "");
}

/**
 * 转换为 v1 API 路径
 */
export function toV1BaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

// ============ 图片数据处理工具 ============
/**
 * 根据 MIME 类型获取文件扩展名
 */
export function extFromMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  const mimeMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/png": "png",
  };
  return mimeMap[mime] ?? "png";
}

/**
 * 解析 Data URL
 */
export function parseDataUrl(maybeDataUrl) {
  const s = String(maybeDataUrl ?? "");
  const match = /^data:([^;]+);base64,(.+)$/s.exec(s);
  if (!match) return null;
  return {
    mimeType: match[1].trim() || "application/octet-stream",
    base64: match[2],
  };
}

/**
 * 去除 Data URL 前缀，返回纯 base64
 */
export function stripDataUrlPrefix(maybeDataUrl) {
  const parsed = parseDataUrl(maybeDataUrl);
  return parsed ? parsed.base64 : String(maybeDataUrl ?? "");
}

/**
 * 验证 base64 字符串是否有效
 */
export function isValidBase64(str) {
  if (typeof str !== "string" || !str.trim()) return false;
  try {
    const decoded = Buffer.from(str, "base64");
    return decoded.length > 0 && Buffer.from(decoded).toString("base64") === str.replace(/\s/g, "");
  } catch {
    return false;
  }
}

// ============ 路径处理工具 ============
/**
 * 获取默认图片目录
 */
export async function getDefaultPicturesDir() {
  const home = os.homedir();

  // Windows & macOS: 默认 ~/Pictures
  if (process.platform === "win32" || process.platform === "darwin") {
    return path.join(home, "Pictures");
  }

  // Linux: 尝试读取 XDG 配置
  try {
    const configPath = path.join(home, ".config", "user-dirs.dirs");
    const content = await fs.readFile(configPath, "utf-8");
    const match = content.match(/^XDG_PICTURES_DIR="?([^"\n]+)"?$/m);
    if (match) {
      let dir = match[1];
      if (dir.startsWith("$HOME/")) {
        dir = path.join(home, dir.slice(6));
      } else if (dir === "$HOME") {
        dir = home;
      }
      return dir;
    }
  } catch {
    // 忽略读取错误，回退到默认
  }

  return path.join(home, "Pictures");
}

/**
 * 解析输出目录路径
 */
export function resolveOutDir(rawOutDir) {
  let outDir = String(rawOutDir ?? "").trim();
  if (!outDir) return "";

  // 处理 ~ 路径 (Home 目录)
  if (outDir.startsWith("~")) {
    outDir = path.join(os.homedir(), outDir.slice(1));
  }

  if (path.isAbsolute(outDir)) return outDir;
  return path.resolve(process.cwd(), outDir);
}

/**
 * 转换为显示路径（统一使用正斜杠）
 */
export function toDisplayPath(filePath) {
  return String(filePath ?? "").replaceAll("\\", "/");
}

/**
 * 格式化日期为文件名格式
 */
export function formatDateForFilename(date) {
  const d = date instanceof Date ? date : new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * 生成批次 ID
 */
export function generateBatchId() {
  return `${formatDateForFilename(new Date())}-${crypto.randomBytes(4).toString("hex")}`;
}

// ============ 网络请求工具 ============
/**
 * 带超时的 fetch 请求
 */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒），请检查网络或增加 OPENAI_TIMEOUT_MS`);
    }
    throw new Error(`网络请求失败: ${err.message || err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 从 URL 获取图片并转为 base64
 */
export async function fetchUrlAsBase64(url, timeoutMs) {
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

// ============ 自定义错误类 ============
export class HttpError extends Error {
  constructor(message, { status, url, body }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}
