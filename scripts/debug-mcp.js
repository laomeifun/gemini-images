#!/usr/bin/env node
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// 加载环境变量：优先 .env.local，然后 .env
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

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
    if (a === "--n" || a === "-n") {
      out.n = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--n=")) {
      out.n = a.slice("--n=".length);
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
    if (a === "--output") {
      out.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--output=")) {
      out.output = a.slice("--output=".length);
      continue;
    }
    if (a === "--session" || a === "--session_id") {
      out.session_id = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--session=")) {
      out.session_id = a.slice("--session=".length);
      continue;
    }
    if (a.startsWith("--session_id=")) {
      out.session_id = a.slice("--session_id=".length);
      continue;
    }
    if (a === "--image" || a === "-i") {
      out.image = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--image=")) {
      out.image = a.slice("--image=".length);
      continue;
    }
    out._.push(a);
  }
  return out;
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

const args = parseArgs(process.argv.slice(2));
const prompt = String(args.prompt ?? args._.join(" ") ?? "").trim();
if (!prompt) {
  console.error(
    "用法：npm run debug:mcp -- --prompt \"A cat\" --n 1 --size 1024x1024",
  );
  process.exit(2);
}

const size = String(args.size ?? process.env.OPENAI_IMAGE_SIZE ?? "1024x1024").trim();
const n = Number.parseInt(String(args.n ?? "1"), 10);
const outDir = path.resolve(process.cwd(), String(args.out ?? "debug-output"));
const output = String(args.output ?? "").trim();
const sessionId = args.session_id ?? null;
const imagePath = args.image ?? null;

// 如果提供了图片路径，读取并转换为 base64
let imageBase64 = null;
if (imagePath) {
  try {
    const imageBuffer = await fs.readFile(imagePath);
    imageBase64 = imageBuffer.toString("base64");
    // 根据扩展名确定 MIME 类型
    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
    const mimeType = mimeMap[ext] || "image/png";
    imageBase64 = `data:${mimeType};base64,${imageBase64}`;
    console.log(`已加载图片: ${imagePath}`);
  } catch (err) {
    console.error(`无法读取图片文件: ${imagePath} - ${err.message}`);
    process.exit(2);
  }
}

const client = new Client({ name: "debug-client", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  env: { ...process.env, OPENAI_IMAGE_OUT_DIR: outDir },
  stderr: "inherit",
  cwd: process.cwd(),
});

try {
  await client.connect(transport);

  const toolArgs = { prompt, n, size };
  if (output) toolArgs.output = output;
  if (sessionId) toolArgs.session_id = sessionId;
  if (imageBase64) toolArgs.image = imageBase64;

  const result = await client.callTool({
    name: "generate_image",
    arguments: toolArgs,
  });

  if (result.isError) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const images = [];
  const texts = [];
  for (const item of result.content ?? []) {
    if (item?.type === "image") images.push(item);
    if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
  }

  if (images.length > 0) {
    await fs.mkdir(outDir, { recursive: true });
    let saved = 0;
    for (const item of images) {
      const ext = extFromMime(item.mimeType);
      const filePath = path.join(outDir, `image-${saved + 1}.${ext}`);
      const buf = Buffer.from(item.data, "base64");
      await fs.writeFile(filePath, buf);
      saved += 1;
      console.log(`已保存：${filePath}`);
    }
  } else if (texts.length > 0) {
    console.log(texts.join("\n"));
  } else {
    console.log("没有返回 image/text 内容，完整结果如下：");
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await transport.close().catch(() => {});
}

