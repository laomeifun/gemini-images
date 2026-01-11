# Copilot Instructions for gemini-images

## Project Overview

This is an **MCP (Model Context Protocol) server** that provides AI image generation and editing capabilities via OpenAI-compatible Gemini endpoints. It supports **Nano Banana multi-turn conversation** for iterative image editing.

## Architecture

```
src/index.js          # Single-file MCP server (~860 lines)
├── Session Management  # Lines 25-80: Multi-turn conversation state
├── Utility Functions   # Lines 100-220: URL normalization, path handling
├── API Clients         # Lines 275-450: generateImagesViaImagesApi, generateImagesViaChatCompletions
├── Tool Definition     # Lines 490-560: ListToolsRequestSchema handler
└── Tool Execution      # Lines 560-850: CallToolRequestSchema handler
```

**Key Design Decisions:**
- Single-file architecture for easy `npx` distribution
- In-memory session storage with TTL-based expiration (no persistence)
- Dual API mode support: `chat/completions` (default) and `images/generations`
- Lenient parameter parsing (accepts multiple naming conventions like `outDir`, `out_dir`, `outdir`)

## Development Commands

```bash
# Test upstream API connectivity (bypasses MCP)
npm run debug:upstream -- --prompt "A cute cat" --size 1024x1024

# Test full MCP tool invocation
npm run debug:mcp -- --prompt "A cute cat" --out ~/Pictures

# Enable debug logging
OPENAI_DEBUG=1 npm start
```

## Code Patterns

### Parameter Parsing
Always use lenient parsing to accept multiple naming conventions:
```javascript
const outDir = resolveOutDir(
  args.outDir ?? args.out_dir ?? args.outdir ?? args.output_dir ?? process.env.OPENAI_IMAGE_OUT_DIR
);
```

### Error Handling
Return user-friendly errors with actionable suggestions:
```javascript
if (errMsg.includes("401")) {
  suggestion = "\n💡 建议：设置 OPENAI_API_KEY 或 GEMINI_API_KEY 环境变量";
}
```

### Session Management
Sessions are stored in a `Map` with automatic cleanup every 5 minutes:
```javascript
const session = getOrCreateSession(sessionId);  // Creates new if not found
session.messages.push({ role: "user", content: prompt });
session.lastImage = generatedImage;  // For multi-turn editing
```

## Environment Variables

All config is via environment variables (see `.env.example`). Key ones:
- `OPENAI_BASE_URL` - API endpoint (default: `http://127.0.0.1:8317`)
- `OPENAI_IMAGE_MODE` - `chat` (default), `images`, or `auto`
- `SESSION_TTL_MS` - Session expiration (default: 30 min)

## Testing Changes

1. Copy `.env.example` to `.env` and configure
2. Run `npm run debug:mcp -- --prompt "test"` to verify tool execution
3. Check `debug-output/` for generated images

## Publishing

```bash
npm version patch|minor|major
npm publish --access public
```

GitHub Actions auto-publishes on version change (see `.github/workflows/publish.yml`).
