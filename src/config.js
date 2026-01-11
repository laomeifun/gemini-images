/**
 * 配置模块 - 集中管理所有配置常量和环境变量
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// 加载环境变量：优先 .env.local，然后 .env
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

// ============ 默认值常量 ============
export const DEFAULTS = {
  MODEL: "gemini-3-pro-image-preview",
  SIZE: "1024x1024",
  TIMEOUT_MS: 120_000,
  OUTPUT: "path", // path | image
  SESSION_TTL_MS: 30 * 60 * 1000, // 30 分钟
  SESSION_CLEANUP_INTERVAL_MS: 5 * 60 * 1000, // 5 分钟
  INLINE_MAX_SIZE: 512 * 1024, // 512KB
};

// ============ 环境变量读取器 ============
export const config = {
  get baseUrl() {
    return process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8317";
  },
  
  get apiKey() {
    return process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  },
  
  get model() {
    return process.env.OPENAI_MODEL ?? DEFAULTS.MODEL;
  },
  
  get imageMode() {
    return String(process.env.OPENAI_IMAGE_MODE ?? "gemini").trim().toLowerCase();
  },
  
  get defaultSize() {
    return process.env.OPENAI_IMAGE_SIZE ?? DEFAULTS.SIZE;
  },
  
  get defaultOutput() {
    return process.env.OPENAI_IMAGE_RETURN ?? DEFAULTS.OUTPUT;
  },
  
  get defaultOutDir() {
    return process.env.OPENAI_IMAGE_OUT_DIR ?? "";
  },
  
  get timeoutMs() {
    const n = parseInt(process.env.OPENAI_TIMEOUT_MS ?? "", 10);
    return Number.isFinite(n) ? Math.max(5_000, Math.min(600_000, n)) : DEFAULTS.TIMEOUT_MS;
  },
  
  get sessionTtlMs() {
    const n = parseInt(process.env.SESSION_TTL_MS ?? "", 10);
    return Number.isFinite(n) ? n : DEFAULTS.SESSION_TTL_MS;
  },
  
  get inlineMaxSize() {
    const n = parseInt(process.env.OPENAI_IMAGE_INLINE_MAX_SIZE ?? "", 10);
    return Number.isFinite(n) ? n : DEFAULTS.INLINE_MAX_SIZE;
  },
  
  get isDebugEnabled() {
    return process.env.OPENAI_DEBUG === "1" || process.env.DEBUG === "1";
  },
};

export { PROJECT_ROOT };
