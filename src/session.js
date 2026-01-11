/**
 * 会话管理模块 - 多轮对话状态管理（支持持久化）
 *
 * 存储结构：
 * ~/.gemini-images/
 * ├── sessions/          # 会话元数据
 * │   └── {id}.json
 * └── images/            # 会话图片（分离存储，减少文件大小）
 *     └── {id}_last.png
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, DEFAULTS } from "./config.js";
import { debugLog } from "./utils.js";

/**
 * @typedef {Object} SessionImage
 * @property {string} base64 - 图片 base64 数据
 * @property {string} mimeType - 图片 MIME 类型
 */

/**
 * @typedef {Object} SessionImageRef
 * @property {string} path - 图片文件路径
 * @property {string} mimeType - 图片 MIME 类型
 */

/**
 * @typedef {Object} Session
 * @property {string} id - 会话 ID
 * @property {Array<{role: string, content: any}>} messages - 对话历史
 * @property {SessionImage | null} lastImage - 上一次生成的图片（内存中为完整数据）
 * @property {number} createdAt - 创建时间
 * @property {number} lastUsedAt - 最后使用时间
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/** 存储目录是否已初始化 */
let storageInitialized = false;
let imagesInitialized = false;

// ============ 目录初始化 ============

/**
 * 初始化会话存储目录
 */
function ensureStorageDir() {
  if (storageInitialized || !config.sessionPersistEnabled) return;

  const dir = config.sessionStorageDir;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      debugLog(`[session] 创建会话存储目录: ${dir}`);
    }
    storageInitialized = true;
  } catch (err) {
    debugLog(`[session] 创建存储目录失败: ${err.message}`);
  }
}

/**
 * 初始化图片存储目录
 */
function ensureImagesDir() {
  if (imagesInitialized || !config.sessionPersistEnabled) return;

  const dir = config.sessionImagesDir;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      debugLog(`[session] 创建图片存储目录: ${dir}`);
    }
    imagesInitialized = true;
  } catch (err) {
    debugLog(`[session] 创建图片目录失败: ${err.message}`);
  }
}

// ============ 文件路径 ============

/**
 * 获取会话文件路径
 */
function getSessionFilePath(sessionId) {
  return path.join(config.sessionStorageDir, `${sessionId}.json`);
}

/**
 * 获取会话图片文件路径
 */
function getSessionImagePath(sessionId, suffix = "last") {
  return path.join(config.sessionImagesDir, `${sessionId}_${suffix}.png`);
}

// ============ 图片存储 ============

/**
 * 保存图片到文件
 * @param {string} sessionId
 * @param {SessionImage} image
 * @returns {SessionImageRef | null}
 */
function saveImageToFile(sessionId, image) {
  if (!config.sessionPersistEnabled || !image) return null;

  ensureImagesDir();
  const imagePath = getSessionImagePath(sessionId);

  try {
    const buffer = Buffer.from(image.base64, "base64");
    fs.writeFileSync(imagePath, buffer);
    debugLog(`[session] 保存图片: ${imagePath} (${Math.round(buffer.length / 1024)}KB)`);
    return { path: imagePath, mimeType: image.mimeType };
  } catch (err) {
    debugLog(`[session] 保存图片失败: ${err.message}`);
    return null;
  }
}

/**
 * 从文件加载图片
 * @param {SessionImageRef} imageRef
 * @returns {SessionImage | null}
 */
function loadImageFromFile(imageRef) {
  if (!imageRef?.path) return null;

  try {
    if (fs.existsSync(imageRef.path)) {
      const buffer = fs.readFileSync(imageRef.path);
      const base64 = buffer.toString("base64");
      debugLog(`[session] 加载图片: ${imageRef.path}`);
      return { base64, mimeType: imageRef.mimeType || "image/png" };
    }
  } catch (err) {
    debugLog(`[session] 加载图片失败: ${err.message}`);
  }
  return null;
}

/**
 * 删除会话图片文件
 */
function deleteSessionImages(sessionId) {
  if (!config.sessionPersistEnabled) return;

  const imagePath = getSessionImagePath(sessionId);
  try {
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
      debugLog(`[session] 删除图片: ${imagePath}`);
    }
  } catch (err) {
    debugLog(`[session] 删除图片失败: ${err.message}`);
  }
}

// ============ 会话文件操作 ============

/**
 * 从文件加载会话
 */
function loadSessionFromFile(sessionId) {
  if (!config.sessionPersistEnabled) return null;

  const filePath = getSessionFilePath(sessionId);
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      const sessionData = JSON.parse(data);

      // 从文件加载 lastImage
      if (sessionData.lastImageRef) {
        const loadedImage = loadImageFromFile(sessionData.lastImageRef);
        sessionData.lastImage = loadedImage;
        delete sessionData.lastImageRef;
      }

      // 恢复 messages 中的图片引用
      if (sessionData.messageImageRefs) {
        restoreMessageImages(sessionData);
      }

      debugLog(`[session] 从文件加载会话: ${sessionId}`);
      return sessionData;
    }
  } catch (err) {
    debugLog(`[session] 加载会话文件失败: ${err.message}`);
  }
  return null;
}

/**
 * 恢复消息中的图片（从引用加载）
 */
function restoreMessageImages(sessionData) {
  const refs = sessionData.messageImageRefs || {};

  for (let i = 0; i < sessionData.messages.length; i++) {
    const msg = sessionData.messages[i];
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (part.type === "image_url" && part._imageRefKey) {
        const ref = refs[part._imageRefKey];
        if (ref) {
          const image = loadImageFromFile(ref);
          if (image) {
            part.image_url = { url: `data:${image.mimeType};base64,${image.base64}` };
          }
        }
        delete part._imageRefKey;
      }
    }
  }

  delete sessionData.messageImageRefs;
}

/**
 * 保存会话到文件
 */
function saveSessionToFile(session) {
  if (!config.sessionPersistEnabled) return;

  ensureStorageDir();
  const filePath = getSessionFilePath(session.id);

  try {
    // 限制历史消息数量
    const messages = session.messages.slice(-DEFAULTS.SESSION_MAX_HISTORY * 2);

    // 提取消息中的图片，转为引用
    const { processedMessages, imageRefs } = extractMessageImages(session.id, messages);

    // 保存 lastImage 到文件，会话中只保存引用
    let lastImageRef = null;
    if (session.lastImage) {
      lastImageRef = saveImageToFile(session.id, session.lastImage);
    }

    const sessionToSave = {
      id: session.id,
      messages: processedMessages,
      messageImageRefs: Object.keys(imageRefs).length > 0 ? imageRefs : undefined,
      lastImageRef,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
    };

    fs.writeFileSync(filePath, JSON.stringify(sessionToSave, null, 2), "utf-8");
    debugLog(`[session] 保存会话: ${session.id}`);
  } catch (err) {
    debugLog(`[session] 保存会话文件失败: ${err.message}`);
  }
}

/**
 * 提取消息中的图片，返回处理后的消息和图片引用
 */
function extractMessageImages(sessionId, messages) {
  const imageRefs = {};
  let imageIndex = 0;

  const processedMessages = messages.map((msg) => {
    if (!Array.isArray(msg.content)) {
      return msg;
    }

    const processedContent = msg.content.map((part) => {
      if (part.type === "image_url" && part.image_url?.url?.startsWith("data:")) {
        // 提取 base64 数据
        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          const mimeType = match[1];
          const base64 = match[2];
          const refKey = `img_${imageIndex++}`;

          // 保存图片到文件
          const imagePath = path.join(
            config.sessionImagesDir,
            `${sessionId}_msg_${refKey}.png`
          );
          try {
            ensureImagesDir();
            const buffer = Buffer.from(base64, "base64");
            fs.writeFileSync(imagePath, buffer);
            imageRefs[refKey] = { path: imagePath, mimeType };
          } catch {
            // 保存失败，保留原始数据
            return part;
          }

          // 返回带引用标记的内容
          return {
            type: "image_url",
            _imageRefKey: refKey,
            image_url: { url: "[image stored separately]" },
          };
        }
      }
      return part;
    });

    return { ...msg, content: processedContent };
  });

  return { processedMessages, imageRefs };
}

/**
 * 删除会话文件
 */
function deleteSessionFile(sessionId) {
  if (!config.sessionPersistEnabled) return;

  const filePath = getSessionFilePath(sessionId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      debugLog(`[session] 删除会话文件: ${sessionId}`);
    }
  } catch (err) {
    debugLog(`[session] 删除会话文件失败: ${err.message}`);
  }

  // 同时删除关联的图片
  deleteSessionImages(sessionId);

  // 删除消息中的图片
  try {
    const imagesDir = config.sessionImagesDir;
    if (fs.existsSync(imagesDir)) {
      const files = fs.readdirSync(imagesDir);
      for (const file of files) {
        if (file.startsWith(`${sessionId}_`)) {
          fs.unlinkSync(path.join(imagesDir, file));
        }
      }
    }
  } catch {
    // 忽略清理错误
  }
}

// ============ 会话管理 API ============

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
  // 1. 先检查内存缓存
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastUsedAt = Date.now();
    return session;
  }

  // 2. 尝试从文件加载
  if (sessionId) {
    const fileSession = loadSessionFromFile(sessionId);
    if (fileSession) {
      // 检查是否过期
      if (Date.now() - fileSession.lastUsedAt <= config.sessionTtlMs) {
        fileSession.lastUsedAt = Date.now();
        sessions.set(sessionId, fileSession);
        return fileSession;
      } else {
        // 过期，删除文件
        deleteSessionFile(sessionId);
        debugLog(`[session] 会话已过期: ${sessionId}`);
      }
    }
  }

  // 3. 创建新会话
  const newSession = {
    id: generateSessionId(),
    messages: [],
    lastImage: null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  sessions.set(newSession.id, newSession);
  saveSessionToFile(newSession);
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
 * @param {Array<SessionImage>} images - 生成的图片
 */
export function updateSession(session, userContent, images) {
  // 保存用户消息到历史
  session.messages.push({ role: "user", content: userContent });

  // 保存助手响应到历史（包含生成的图片）
  if (images.length > 0) {
    const firstImage = images[0];
    session.lastImage = firstImage;

    // 构建助手消息（保存完整 base64，确保历史回放可用）
    session.messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `[已生成 ${images.length} 张图片]` },
        {
          type: "image_url",
          image_url: {
            url: `data:${firstImage.mimeType};base64,${firstImage.base64}`,
          },
        },
      ],
    });
  }

  session.lastUsedAt = Date.now();

  // 限制内存中的历史消息数量
  if (session.messages.length > DEFAULTS.SESSION_MAX_HISTORY * 2) {
    session.messages = session.messages.slice(-DEFAULTS.SESSION_MAX_HISTORY * 2);
  }

  // 持久化到文件（图片会分离存储）
  saveSessionToFile(session);

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
          url: `data:${inputImage.mimeType};base64,${inputImage.base64}`,
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

  // 清理内存中的过期会话
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > ttl) {
      sessions.delete(id);
      deleteSessionFile(id);
      debugLog(`[session] 清理过期会话: ${id}`);
    }
  }

  // 清理文件系统中的过期会话
  if (config.sessionPersistEnabled) {
    try {
      const dir = config.sessionStorageDir;
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;

          const filePath = path.join(dir, file);
          const sessionId = file.replace(".json", "");
          try {
            const data = fs.readFileSync(filePath, "utf-8");
            const session = JSON.parse(data);
            if (now - session.lastUsedAt > ttl) {
              deleteSessionFile(sessionId);
              debugLog(`[session] 清理过期会话文件: ${file}`);
            }
          } catch {
            // 无法解析的文件，跳过
          }
        }
      }
    } catch (err) {
      debugLog(`[session] 清理会话文件目录失败: ${err.message}`);
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
    persistEnabled: config.sessionPersistEnabled,
    storageDir: config.sessionStorageDir,
    imagesDir: config.sessionImagesDir,
  };
}

/**
 * 列出所有可用会话（包括文件中的）
 */
export function listAllSessions() {
  const result = [];
  const seenIds = new Set();

  // 内存中的会话
  for (const [id, session] of sessions) {
    result.push({
      id,
      messageCount: session.messages.length,
      hasImage: !!session.lastImage,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      source: "memory",
    });
    seenIds.add(id);
  }

  // 文件中的会话
  if (config.sessionPersistEnabled) {
    try {
      const dir = config.sessionStorageDir;
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;

          const sessionId = file.replace(".json", "");
          if (seenIds.has(sessionId)) continue;

          const filePath = path.join(dir, file);
          try {
            const data = fs.readFileSync(filePath, "utf-8");
            const session = JSON.parse(data);
            result.push({
              id: session.id,
              messageCount: session.messages?.length ?? 0,
              hasImage: !!(session.lastImage || session.lastImageRef),
              createdAt: session.createdAt,
              lastUsedAt: session.lastUsedAt,
              source: "file",
            });
          } catch {
            // 无法解析的文件，跳过
          }
        }
      }
    } catch {
      // 忽略错误
    }
  }

  return result;
}
