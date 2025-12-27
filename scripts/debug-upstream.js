#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

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

function parseDataUrl(maybeDataUrl) {
  const s = String(maybeDataUrl ?? "");
  const match = /^data:([^;]+);base64,(.+)$/s.exec(s);
  if (!match) return null;
  return {
    mimeType: match[1].trim() || "application/octet-stream",
    base64: match[2],
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--prompt" || a === "-p") {
      out.prompt = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--prompt=")) {
      out.prompt = a.slice("--prompt=".length);
      continue;
    }
    if (a === "--size" || a === "-s") {
      out.size = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--size=")) {
      out.size = a.slice("--size=".length);
      continue;
    }
    if (a === "--out" || a === "-o") {
      out.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--out=")) {
      out.out = a.slice("--out=".length);
      continue;
    }
    out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const prompt = String(args.prompt ?? args._.join(" ") ?? "").trim();
if (!prompt) {
  console.error(
    "用法：npm run debug:upstream -- --prompt \"A cat\" --size 1024x1024",
  );
  process.exit(2);
}

const baseUrl = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8999";
const apiKey = process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
const model = process.env.OPENAI_MODEL ?? "gemini-3-pro-image-preview";
const size = String(args.size ?? process.env.OPENAI_IMAGE_SIZE ?? "1024x1024").trim();
const outDir = path.resolve(process.cwd(), String(args.out ?? "debug-output"));
const timeoutMs = Number.parseInt(process.env.OPENAI_TIMEOUT_MS ?? "120000", 10);

if (!apiKey) {
  console.error("缺少 API Key：请设置 OPENAI_API_KEY（或 GEMINI_API_KEY）");
  process.exit(2);
}

const v1 = toV1BaseUrl(baseUrl);

// 1) sanity: /v1/models
{
  const res = await fetchWithTimeout(
    `${v1}/models`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    },
    timeoutMs,
  );
  console.log(`/v1/models => HTTP ${res.status}`);
}

// 2) image via /v1/chat/completions
{
  const url = `${v1}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    modalities: ["image"],
    image_config: { image_size: size },
  };

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );

  const text = await res.text().catch(() => "");
  console.log(`/v1/chat/completions => HTTP ${res.status}`);
  if (!res.ok) {
    console.error(text);
    process.exit(1);
  }

  const json = JSON.parse(text);
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  /** @type {Array<{base64:string; mimeType:string}>} */
  const images = [];
  for (const choice of choices) {
    const messageImages = choice?.message?.images;
    if (!Array.isArray(messageImages)) continue;
    for (const img of messageImages) {
      const imageUrl = img?.image_url?.url ?? "";
      const parsed = parseDataUrl(imageUrl);
      if (parsed) images.push(parsed);
    }
  }

  if (images.length === 0) {
    console.log("没有在 choices[].message.images 里找到图片，响应如下：");
    console.log(JSON.stringify(json, null, 2));
    process.exit(1);
  }

  await fs.mkdir(outDir, { recursive: true });
  let saved = 0;
  for (const img of images) {
    const ext = extFromMime(img.mimeType);
    const filePath = path.join(outDir, `upstream-image-${saved + 1}.${ext}`);
    await fs.writeFile(filePath, Buffer.from(img.base64, "base64"));
    saved += 1;
    console.log(`已保存：${filePath}`);
  }
}
