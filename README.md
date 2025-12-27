# gemini-image-mcp

一个基于 **MCP (Model Context Protocol)** 的 Node.js 服务：通过本地 `OpenAI-compatible` 网关（默认 `http://127.0.0.1:8317`）调用 Gemini 图片模型 `gemini-3-pro-image-preview` 生成图片，供 Claude Code/Claude Desktop 等 IDE 工具动态使用。

## 1) 安装

```bash
npm install
```

## 2) 环境变量（可选）

- `OPENAI_BASE_URL`：OpenAI-compatible 服务地址（默认 `http://127.0.0.1:8317`）
- `OPENAI_API_KEY`：如果你的网关需要鉴权就填（可留空）
- `OPENAI_MODEL`：默认 `gemini-3-pro-image-preview`
- `OPENAI_IMAGE_SIZE`：可选，仅作为未传入 `size` 时的默认值；建议让客户端在调用 `generate_image` 时自己传 `size`
- `OPENAI_IMAGE_MODE`：`chat|images|auto`，默认 `chat`（CLIProxyAPI 这类网关通常用 `/v1/chat/completions` 出图；若你的网关支持 `/v1/images/generations` 可设为 `images`）
- `OPENAI_IMAGE_RETURN`：`path|image`，默认 `path`（`path` 会把图片保存到本地并返回文件路径，避免 base64 导致 token 暴涨；`image` 返回 MCP `image` content）
- `OPENAI_IMAGE_OUT_DIR`：保存目录（默认 `debug-output/`；相对路径以项目根目录为基准）
- `OPENAI_DEBUG`：设为 `1` 时会在 stderr 打印上游请求信息（不打印 key）
- `OPENAI_TIMEOUT_MS`：默认 `120000`

可参考 `.env.example`。

## 3) 本地调试（不用放进 Claude Code）

推荐把 `.env.example` 复制成 `.env`，然后在 `.env` 里填好 `OPENAI_API_KEY`（`.gitignore` 已忽略 `.env`）。

- 直连上游调试（确认你的 `http://127.0.0.1:8317` 是否能出图）：
  - `npm run debug:upstream -- --prompt "A beautiful sunset over mountains" --size 1024x1024`
- 走 MCP 工具调试（等价于 Claude Code 调用 `generate_image`）：
  - `npm run debug:mcp -- --prompt "A beautiful sunset over mountains" --n 1 --size 1024x1024`

图片会输出到 `debug-output/`。

## 4) 作为 MCP Server 使用（stdio）

该项目是 **stdio** 传输方式的 MCP Server，不建议直接在终端手动运行（会等待客户端请求）。

在 Claude Code / Claude Desktop 的 MCP 配置里添加类似如下（按你的实际路径修改）：

```json
{
  "mcpServers": {
    "gemini-image": {
      "command": "node",
      "args": ["d:/task/myself/nodejs/geminiimagemcp/src/index.js"],
      "env": {
        "OPENAI_BASE_URL": "http://127.0.0.1:8317",
        "OPENAI_API_KEY": "<YOUR_KEY>",
        "OPENAI_MODEL": "gemini-3-pro-image-preview"
      }
    }
  }
}
```

也可以直接参考 `mcp.example.json`。

## 5) 可用工具

- `generate_image`
  - 入参：`prompt`（必填）, `size`（可选）, `n`（可选，1-4）, `output`（可选：`path|image`）, `outDir`（可选）
  - 返回：默认返回保存后的图片文件路径（多行）；`output=image` 时返回 MCP `image` content（base64 + mimeType）
