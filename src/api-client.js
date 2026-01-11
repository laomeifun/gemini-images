/**
 * API 客户端模块 - 封装各种图片生成 API 调用
 */
import { config } from "./config.js";
import {
  debugLog,
  normalizeBaseUrl,
  toV1BaseUrl,
  fetchWithTimeout,
  fetchUrlAsBase64,
  parseDataUrl,
  stripDataUrlPrefix,
  clampInt,
  parseIntOr,
  HttpError,
} from "./utils.js";

/**
 * @typedef {Object} ImageResult
 * @property {string} base64 - Base64 编码的图片数据
 * @property {string} mimeType - MIME 类型
 */

/**
 * @typedef {Object} GenerateParams
 * @property {string} baseUrl - API 基础 URL
 * @property {string} apiKey - API 密钥
 * @property {string} model - 模型名称
 * @property {string} prompt - 图片描述
 * @property {string} size - 图片尺寸
 * @property {number} n - 生成数量
 * @property {number} timeoutMs - 超时时间
 * @property {Array} [historyMessages] - 历史消息
 * @property {ImageResult | null} [inputImage] - 输入图片
 */

// ============ OpenAI Images API ============
/**
 * 通过 OpenAI images/generations API 生成图片
 * @param {GenerateParams} params
 * @returns {Promise<ImageResult[]>}
 */
export async function generateImagesViaImagesApi({
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

  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    prompt,
    size,
    n,
    response_format: "b64_json",
  };

  debugLog(
    `[upstream] POST ${url} (images/generations) model=${model} size=${size} n=${n} hasApiKey=${Boolean(apiKey)}`
  );

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint = res.status === 401 ? "（看起来需要 API Key，请设置 OPENAI_API_KEY）" : "";
    throw new HttpError(`图片生成失败: HTTP ${res.status}${hint} ${text}`, {
      status: res.status,
      url,
      body: text,
    });
  }

  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];

  /** @type {ImageResult[]} */
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

// ============ Gemini Native API ============
/**
 * 解析尺寸为宽高比
 */
function sizeToAspectRatio(size) {
  if (!size) return "1:1";
  
  const sizeMatch = /^(\d+)x(\d+)$/i.exec(size);
  if (!sizeMatch) return "1:1";
  
  const w = parseInt(sizeMatch[1], 10);
  const h = parseInt(sizeMatch[2], 10);
  const ratio = w / h;
  
  const ratioMap = [
    { ratio: 1, value: "1:1" },
    { ratio: 16 / 9, value: "16:9" },
    { ratio: 9 / 16, value: "9:16" },
    { ratio: 4 / 3, value: "4:3" },
    { ratio: 3 / 4, value: "3:4" },
    { ratio: 3 / 2, value: "3:2" },
    { ratio: 2 / 3, value: "2:3" },
  ];
  
  for (const { ratio: r, value } of ratioMap) {
    if (Math.abs(ratio - r) < 0.1) return value;
  }
  return "1:1";
}

/**
 * 通过 Gemini 原生 API (generateContent) 生成图片
 * @param {GenerateParams} params
 * @returns {Promise<ImageResult[]>}
 */
export async function generateImagesViaGeminiNative({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  timeoutMs,
  historyMessages = [],
  inputImage = null,
}) {
  const normalizedBase = normalizeBaseUrl(baseUrl).replace(/\/+$/, "");
  const url = `${normalizedBase}/models/${model}:generateContent?key=${apiKey}`;

  const headers = { "content-type": "application/json" };

  // 构建 Gemini 原生格式的 contents
  const contents = [];

  // 添加历史消息
  for (const msg of historyMessages) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: Array.isArray(msg.content)
        ? msg.content.map((item) => {
            if (item.type === "text") return { text: item.text };
            if (item.type === "image_url" && item.image_url?.url) {
              const parsed = parseDataUrl(item.image_url.url);
              if (parsed) {
                return { inline_data: { data: parsed.base64, mime_type: parsed.mimeType } };
              }
            }
            return { text: String(item.text || "") };
          })
        : [{ text: String(msg.content) }],
    });
  }

  // 构建当前用户消息
  const currentParts = [{ text: prompt }];
  if (inputImage?.base64) {
    currentParts.push({
      inline_data: {
        data: inputImage.base64,
        mime_type: inputImage.mimeType || "image/png",
      },
    });
  }
  contents.push({ role: "user", parts: currentParts });

  const aspectRatio = sizeToAspectRatio(size);

  const body = {
    contents,
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio },
    },
  };

  debugLog(
    `[upstream] POST ${url.replace(/key=[^&]+/, "key=***")} (Gemini native) model=${model} aspectRatio=${aspectRatio} historyLen=${historyMessages.length} hasInputImage=${Boolean(inputImage)}`
  );

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 || res.status === 403
        ? "（API Key 无效或无权限，请检查 GEMINI_API_KEY）"
        : "";
    throw new HttpError(`图片生成失败: HTTP ${res.status}${hint} ${text}`, {
      status: res.status,
      url: url.replace(/key=[^&]+/, "key=***"),
      body: text,
    });
  }

  const json = await res.json();
  const images = parseGeminiResponse(json);

  if (images.length === 0) {
    const debugInfo = config.isDebugEnabled
      ? `\n响应结构: ${JSON.stringify(json, null, 2).slice(0, 500)}`
      : "";
    throw new Error(
      `Gemini 原生 API 未返回图片数据。请确保使用支持图片生成的模型（如 gemini-2.5-flash-image 或 gemini-3-pro-image-preview）${debugInfo}`
    );
  }

  return images;
}

// ============ Chat Completions API ============
/**
 * 通过 chat/completions API 生成图片
 * @param {GenerateParams} params
 * @returns {Promise<ImageResult[]>}
 */
export async function generateImagesViaChatCompletions({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  timeoutMs,
  historyMessages = [],
  inputImage = null,
}) {
  const v1BaseUrl = toV1BaseUrl(baseUrl);
  const url = `${v1BaseUrl}/chat/completions`;

  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  // 构建当前用户消息内容
  let currentUserContent;
  if (inputImage?.base64) {
    currentUserContent = [
      { type: "text", text: prompt },
      {
        type: "image_url",
        image_url: {
          url: `data:${inputImage.mimeType || "image/png"};base64,${inputImage.base64}`,
        },
      },
    ];
  } else {
    currentUserContent = prompt;
  }

  const messages = [...historyMessages, { role: "user", content: currentUserContent }];

  const body = {
    model,
    messages,
    stream: false,
    modalities: ["text", "image"],
    extra_body: {
      google: {
        response_modalities: ["TEXT", "IMAGE"],
        image_config: { image_size: size },
      },
    },
    image_config: { image_size: size },
  };

  debugLog(
    `[upstream] POST ${url} (chat/completions) model=${model} image_config.image_size=${size} hasApiKey=${Boolean(apiKey)} historyLen=${historyMessages.length} hasInputImage=${Boolean(inputImage)}`
  );

  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint = res.status === 401 ? "（看起来需要 API Key，请设置 OPENAI_API_KEY）" : "";
    throw new HttpError(`图片生成失败: HTTP ${res.status}${hint} ${text}`, {
      status: res.status,
      url,
      body: text,
    });
  }

  const json = await res.json();
  const images = await parseOpenAICompatibleResponse(json, timeoutMs);

  if (images.length === 0) {
    const debugInfo = config.isDebugEnabled
      ? `\n响应结构: ${JSON.stringify(Object.keys(json || {}))}`
      : "";
    throw new Error(
      `接口未返回可用的图片数据。支持的格式：candidates[].content.parts[].inline_data, choices[].message.content[], choices[].message.images[]${debugInfo}`
    );
  }

  return images;
}

// ============ 响应解析器 ============
/**
 * 解析 Gemini 原生 API 响应
 * @param {Object} json - API 响应
 * @returns {ImageResult[]}
 */
function parseGeminiResponse(json) {
  /** @type {ImageResult[]} */
  const images = [];
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      // Gemini API 使用 camelCase
      if (part?.inlineData?.data) {
        images.push({
          base64: part.inlineData.data,
          mimeType: part.inlineData.mimeType || "image/png",
        });
      } else if (part?.inline_data?.data) {
        // 也支持 snake_case
        images.push({
          base64: part.inline_data.data,
          mimeType: part.inline_data.mime_type || "image/png",
        });
      }
    }
  }

  return images;
}

/**
 * 解析 OpenAI 兼容格式响应
 * @param {Object} json - API 响应
 * @param {number} timeoutMs - 超时时间
 * @returns {Promise<ImageResult[]>}
 */
async function parseOpenAICompatibleResponse(json, timeoutMs) {
  /** @type {ImageResult[]} */
  const images = [];

  // 格式 1: Gemini 原生 API (generateContent 响应)
  images.push(...parseGeminiResponse(json));

  // 格式 2-4: OpenAI 兼容格式
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  for (const choice of choices) {
    const message = choice?.message;
    if (!message) continue;

    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        // Gemini 格式
        if (item?.inline_data?.data) {
          images.push({
            base64: item.inline_data.data,
            mimeType: item.inline_data.mime_type || "image/png",
          });
          continue;
        }
        // OpenAI 多模态格式
        if (item?.type === "image_url" && item?.image_url?.url) {
          const parsed = parseDataUrl(item.image_url.url);
          if (parsed) {
            images.push({ base64: parsed.base64, mimeType: parsed.mimeType });
          } else if (item.image_url.url.startsWith("http")) {
            images.push(await fetchUrlAsBase64(item.image_url.url, timeoutMs));
          }
        }
      }
    }

    // 第三方代理格式
    const messageImages = message.images;
    if (Array.isArray(messageImages)) {
      for (const img of messageImages) {
        const imageUrl = img?.image_url?.url ?? img?.url ?? img?.imageUrl ?? img?.image_url ?? "";
        if (typeof imageUrl !== "string" || !imageUrl.trim()) continue;

        const parsed = parseDataUrl(imageUrl);
        if (parsed) {
          images.push({ base64: parsed.base64, mimeType: parsed.mimeType });
          continue;
        }
        if (imageUrl.startsWith("http")) {
          images.push(await fetchUrlAsBase64(imageUrl, timeoutMs));
        }
      }
    }
  }

  return images;
}

// ============ 统一入口 ============
/**
 * 生成图片（根据配置选择 API）
 * @param {GenerateParams} params
 * @returns {Promise<ImageResult[]>}
 */
export async function generateImages(params) {
  const mode = config.imageMode;
  const count = clampInt(parseIntOr(params?.n, 1), 1, 4);

  if (mode === "gemini") {
    return await generateMultiple(() => generateImagesViaGeminiNative(params), count);
  }

  if (mode === "openai" || mode === "images") {
    return await generateImagesViaImagesApi(params);
  }

  if (mode === "auto") {
    return await generateWithFallback(params, count);
  }

  // chat (兼容模式)
  return await generateMultiple(() => generateImagesViaChatCompletions(params), count);
}

/**
 * 多次调用生成器以获取指定数量的图片
 */
async function generateMultiple(generator, count) {
  /** @type {ImageResult[]} */
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const batch = await generator();
    out.push(...batch);
    if (out.length >= count) break;
  }
  return out.slice(0, count);
}

/**
 * 自动检测模式：依次尝试不同 API
 */
async function generateWithFallback(params, count) {
  try {
    return await generateImagesViaImagesApi(params);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
      debugLog("[upstream] images/generations 失败，尝试 Gemini 原生 API");
      try {
        return await generateMultiple(() => generateImagesViaGeminiNative(params), count);
      } catch {
        debugLog("[upstream] Gemini 原生 API 失败，回退到 chat/completions");
        return await generateMultiple(() => generateImagesViaChatCompletions(params), count);
      }
    }
    throw err;
  }
}
