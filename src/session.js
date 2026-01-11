/**
 * 会话管理模块 - 多轮对话状态管理
 */
import crypto from "node:crypto";
import { config, DEFAULTS } from "./config.js";
import { debugLog } from "./utils.js";

/**
 * @typedef {Object} Session
 * @property {string} id - 会话 ID
 * @property {Array<{role: string, content: any}>} messages - 对话历史
 * @property {{base64: string, mimeType: string} | null} lastImage - 上一次生成的图片
 * @property {number} createdAt - 创建时间
 * @property {number} lastUsedAt - 最后使用时间
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * 生成会话 ID
 */
function generateSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * 获取或创建会话
 * @param {string | null} sessionId - 会话 ID，为空则创建新会话
 * @returns {Session}
 */
export function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastUsedAt = Date.now();
    return session;
  }

  const newSession = {
    id: generateSessionId(),
    messages: [],
    lastImage: null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  sessions.set(newSession.id, newSession);
  return newSession;
}

/**
 * 检查是否为新会话
 */
export function isNewSession(sessionId, session) {
  return !sessionId || sessionId !== session.id;
}

/**
 * 更新会话状态
 * @param {Session} session - 会话对象
 * @param {string | Array} userContent - 用户消息内容
 * @param {Array<{base64: string, mimeType: string}>} images - 生成的图片
 */
export function updateSession(session, userContent, images) {
  // 保存用户消息到历史
  session.messages.push({ role: "user", content: userContent });

  // 保存助手响应到历史（包含生成的图片）
  if (images.length > 0) {
    const firstImage = images[0];
    session.lastImage = firstImage;

    // 构建助手消息（简化存储，只保存第一张图片的引用）
    session.messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `[已生成 ${images.length} 张图片]` },
        {
          type: "image_url",
          image_url: {
            url: `data:${firstImage.mimeType};base64,${firstImage.base64.slice(0, 100)}...`,
          },
        },
      ],
    });
  }

  session.lastUsedAt = Date.now();
  debugLog(`[session] 会话 ${session.id} 已更新，当前消息数: ${session.messages.length}`);
}

/**
 * 构建用户消息内容（用于保存到历史）
 */
export function buildUserContent(prompt, inputImage) {
  if (inputImage) {
    return [
      { type: "text", text: prompt },
      {
        type: "image_url",
        image_url: {
          url: `data:${inputImage.mimeType};base64,${inputImage.base64.slice(0, 100)}...`,
        },
      },
    ];
  }
  return prompt;
}

/**
 * 清理过期会话
 */
export function cleanupExpiredSessions() {
  const ttl = config.sessionTtlMs;
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > ttl) {
      sessions.delete(id);
      debugLog(`[session] 清理过期会话: ${id}`);
    }
  }
}

/**
 * 启动会话清理定时器
 */
export function startSessionCleanup() {
  setInterval(cleanupExpiredSessions, DEFAULTS.SESSION_CLEANUP_INTERVAL_MS);
}

/**
 * 获取会话统计信息（用于调试）
 */
export function getSessionStats() {
  return {
    count: sessions.size,
    ids: Array.from(sessions.keys()),
  };
}
