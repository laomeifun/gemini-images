# gemini-images Copilot 指南

## 项目概述

这是一个 **MCP (Model Context Protocol) 服务器**，通过 OpenAI 兼容的 Gemini 端点提供 AI 图像生成和编辑功能。支持 **Nano Banana 多轮对话** 实现迭代式图像编辑。

## 架构

```
src/
├── index.js          # MCP 服务器入口 (~200 行) - 工具注册和请求处理
├── config.js         # 配置模块 (~70 行) - 常量和环境变量管理
├── utils.js          # 工具函数 (~220 行) - 通用辅助函数
├── session.js        # 会话管理 (~120 行) - 多轮对话状态
├── api-client.js     # API 客户端 (~350 行) - 图片生成 API 调用
└── image-handler.js  # 图片处理 (~170 行) - 保存和结果格式化
```

**模块职责：**
- `config.js` - 集中管理所有配置常量和环境变量读取
- `utils.js` - 日志、数值解析、URL/路径处理、网络请求等通用函数
- `session.js` - 会话创建、更新、清理，支持多轮对话编辑
- `api-client.js` - 封装 Gemini Native、OpenAI Images、Chat Completions 三种 API
- `image-handler.js` - 图片保存、结果格式化、错误响应构建
- `index.js` - MCP 服务器初始化、工具定义、请求路由

**核心设计决策：**
- 模块化架构，职责分离，便于维护和测试
- 内存会话存储，基于 TTL 自动过期（无持久化）
- 三种 API 模式支持：`gemini`（默认）、`openai`、`chat`、`auto`
- 宽松的参数解析（接受多种命名约定，如 `outDir`、`out_dir`、`outdir`）

## 开发命令

```bash
# 测试上游 API 连接（绕过 MCP）
npm run debug:upstream -- --prompt "一只可爱的猫" --size 1024x1024

# 测试完整 MCP 工具调用
npm run debug:mcp -- --prompt "一只可爱的猫" --out ~/Pictures

# 启用调试日志
OPENAI_DEBUG=1 npm start
```

## 代码模式

### 参数解析
始终使用宽松解析以接受多种命名约定：
```javascript
const outDir = resolveOutDir(
  args.outDir ?? args.out_dir ?? args.outdir ?? args.output_dir ?? process.env.OPENAI_IMAGE_OUT_DIR
);
```

### 错误处理
返回用户友好的错误信息，并提供可操作的建议：
```javascript
if (errMsg.includes("401")) {
  suggestion = "\n💡 建议：设置 OPENAI_API_KEY 或 GEMINI_API_KEY 环境变量";
}
```

### 会话管理
会话存储在 `Map` 中，每 5 分钟自动清理：
```javascript
import { getOrCreateSession, updateSession, buildUserContent } from "./session.js";

const session = getOrCreateSession(sessionId);  // 如果不存在则创建新会话
const userContent = buildUserContent(prompt, inputImage);
updateSession(session, userContent, images);  // 更新会话状态
```

## 环境变量

所有配置通过环境变量完成（参见 `.env.example`）。主要变量：
- `OPENAI_BASE_URL` - API 端点（默认：`http://127.0.0.1:8317`）
- `OPENAI_IMAGE_MODE` - `gemini`（默认）、`openai`、`chat` 或 `auto`
- `SESSION_TTL_MS` - 会话过期时间（默认：30 分钟）

## 测试更改

1. 将 `.env.example` 复制为 `.env` 并配置
2. 运行 `npm run debug:mcp -- --prompt "test"` 验证工具执行
3. 检查 `debug-output/` 目录中生成的图像

## 发布

```bash
npm version patch|minor|major
npm publish --access public
```

GitHub Actions 会在版本变更时自动发布（参见 `.github/workflows/publish.yml`）。
