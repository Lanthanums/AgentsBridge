# AgentsBridge v1.0

简体中文 · [English](README.en.md)

AgentsBridge 是一个面向 Windows 的本地多智能体协作工具。它以同一个协作目标为边界，通过独立适配器调度 Codex、DeepSeek Harness（DSH）、Cursor Agent（Grok）和 Kimi Code CLI，并用 Electron 桌面便签呈现派工、执行进度、交付与验收。无需另行部署编排服务；模型请求仍由对应 CLI 和供应商处理。

## 功能

- **异步协作**：通过 MCP 创建协作、查询本机模型和思考强度、派工并立即获得任务 ID。同一个协作内串行复用经过校验的 CLI 会话；新协作使用新会话，通过交接文件传递上下文。
- **模型路由**：可显式选择执行者，或按任务类型、复杂度和验收条件自动选择。熟悉的小任务优先 DSH，高要求与后端任务优先 Codex，批量低风险重复工作才选 Cursor/Grok，验收标准明确的 3D 工作优先 Kimi。
- **分阶段规划预算**：协调者可以选择小型、标准或复杂预算，也可在执行中说明理由提高上限。触顶时拒绝新派工，已接纳任务、结果回传和验收仍可继续。用量以 CLI 已报告数据为准，不等于账单硬上限。
- **交付与验收**：文件用 SHA-256 核验；有明确的审查者、退回与重新提交状态。便签支持查看流式事件、按页浏览历史、回放与直接停止，不依赖模型同意。

## 技术实现

| 层 | 实现 |
| --- | --- |
| 桌面 | Electron、React、TypeScript；独立 preload 连接渲染层与主进程 |
| 编排 | Node.js 本地 daemon；MCP stdio 接入、带令牌的本机控制与事件流；队列、写范围冲突检查、派工深度和预算约束 |
| 适配 | Codex app-server JSON-RPC、DSH/Kimi ACP、Cursor stream-json；验证会话身份；Windows Job Object 管理子进程树 |
| 数据 | 追加式 JSONL 为事实源；SQLite WAL 索引支持分页与重建；大内容进入按哈希命名的本地对象 |
| 停止 | 提升协作 epoch，拦截迟到结果、回调和派工；独立清理进程树 |

声明写范围用于防止桥内调度冲突，**不是**文件系统沙箱。实际权限、鉴权和计费仍由 CLI 及供应商决定。

## 快速开始

前置条件：64 位 Windows、Node.js 24（含 `node:sqlite`）、npm。实时协作还需安装并登录至少一个受支持的 CLI。构建 Windows 原生助手需要系统 .NET Framework 4.x C# 编译器。

```powershell
npm ci
npm run build
npm test
npm run replay
```

`replay` 使用合成样例，不呼叫模型。要接入真实 CLI，在同一个 PowerShell 环境执行：

```powershell
npm run verify:adapters -- codex
npm start
```

将 `codex` 替换为 `dsh`、`kimi` 或 `cursor` 可逐个启用适配器。探测会发起两轮简短的真实请求，检查新会话和恢复行为；升级 CLI 后若指纹变化，需重新探测。CLI 不在默认路径时，可使用 `MESH_CODEX_EXE`、`MESH_DSH_BIN`、`MESH_KIMI_MAIN` 或 `MESH_CURSOR_EXE` 指向实际可执行文件或入口。模型端接入、路由与预算示例见 [MCP 契约](docs/mcp-contract.md)。

## 数据与维护

- 实际协作记录默认落在 `%LOCALAPPDATA%\AgentsBridge\mesh-v2`；可通过 `AGENTSBRIDGE_HOME` 指定隔离目录。发布仓库不包含真实合作记录、安装回执或本机 CLI 指纹。
- [模型画像](src/bridge/model-profiles.json) 是调度提示读取的版本化定性指标，不是跑分或实时价格。[维护说明](docs/model-profiles.md)规定每 30 天校核一次，并在模型或 CLI 行为变化时立即复核。
- 进一步阅读：[架构](docs/architecture.md) · [MCP 契约](docs/mcp-contract.md) · [事件协议](docs/events.md)。
