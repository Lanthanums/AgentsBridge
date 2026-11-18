# AgentsBridge v1.0

[简体中文](README.md) · English

AgentsBridge is a local orchestration tool for multi-agent work on Windows. It coordinates Codex, DeepSeek Harness (DSH), Cursor Agent (Grok), and Kimi Code through independent CLI adapters. An Electron desktop note shows assignments, live execution, deliverables, and review. There is no separate orchestration service to deploy; model calls still go through the respective CLIs and providers.

## Capabilities

- **Asynchronous collaboration.** Create collaborations with MCP, inspect available models and reasoning settings, and get a task ID immediately on dispatch. A collaboration serializes turns for each CLI session and verifies its identity on resume. New collaborations start fresh sessions and use handoff files for context.
- **Task-aware routing.** Choose a worker explicitly or route by task type, complexity, and acceptance criteria. DSH handles small, familiar work; Codex handles backend and higher-requirement work; Cursor/Grok is reserved for large, repetitive, low-risk batches; Kimi is preferred for well-specified 3D work.
- **Adjustable budgets.** Choose a small, standard, or complex preset, or raise specific limits with a recorded reason. Exhaustion blocks new dispatches, not admitted tasks, result callbacks, or review. Usage limits cover reported usage, not the provider invoice.
- **Delivery and review.** SHA-256 manifests record delivered files. A designated reviewer accepts or returns work. The desktop note offers a live timeline, paged history, replay, and direct cancellation without waiting for a model.

## Architecture

| Layer | Implementation |
| --- | --- |
| Desktop | Electron, React, and TypeScript, with a preload boundary between renderer and main process |
| Orchestration | Local Node.js daemon; MCP over stdio; token-authenticated local control and event stream; queue, overlapping write-scope checks, delegation limits, and budgets |
| Adapters | Codex app-server JSON-RPC, DSH/Kimi ACP, and Cursor stream-json; checked session identity; Windows Job Objects for process-tree lifecycle |
| Storage | Append-only JSONL source of truth; rebuildable SQLite WAL index for paging; content-addressed local blobs |
| Cancellation | A collaboration epoch invalidates late results, callbacks, and dispatches; process-tree cleanup runs independently |

Declared write scopes prevent scheduling conflicts inside the bridge. They are **not** a filesystem sandbox. CLI permissions, authentication, and billing remain with the corresponding CLI and provider.

## Quick Start

Requirements: 64-bit Windows, Node.js 24 with `node:sqlite`, and npm. Live collaboration requires at least one installed and authenticated CLI. Building the Windows native helpers requires the system .NET Framework 4.x C# compiler.

```powershell
npm ci
npm run build
npm test
npm run replay
```

Replay uses synthetic data and does not call a model. To enable a real adapter from the same PowerShell environment:

```powershell
npm run verify:adapters -- codex
npm start
```

Substitute `dsh`, `kimi`, or `cursor` to enable another adapter. Verification uses two short live turns to check both fresh and resumed sessions. Reverify after CLI upgrades that change the fingerprint. For non-default install locations, set `MESH_CODEX_EXE`, `MESH_DSH_BIN`, `MESH_KIMI_MAIN`, or `MESH_CURSOR_EXE` to the appropriate executable or entry point. See the [MCP contract](docs/mcp-contract.md) for integration, routing, and budget examples.

## Data and Maintenance

- Live collaboration data defaults to `%LOCALAPPDATA%\AgentsBridge\mesh-v2`. Set `AGENTSBRIDGE_HOME` to isolate an environment. Real collaboration history, installation reports, and local CLI fingerprints are not shipped.
- The versioned [model profiles](src/bridge/model-profiles.json) feed routing guidance. They are qualitative observations, not benchmark scores or live prices. The [maintenance guide](docs/model-profiles.md) calls for review every 30 days and after material model or CLI changes.
- Further reading: [Architecture (Chinese)](docs/architecture.md) · [MCP contract](docs/mcp-contract.md) · [Event protocol (Chinese)](docs/events.md).
