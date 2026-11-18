# AgentsBridge 架构

Windows 本地应用。CLI 是执行者，mesh 是唯一事实来源；Electron 只订阅事件并发送控制请求。
没有 Grix 服务、平台 scope、Inter-agent 协议、ConPTY 或交互式 TUI 驱动。

```
CLI / 可选 MCP ─→ localhost bridge ─→ 独立 adapter ─→ Windows Job Object ─→ CLI
                        │
                    fsync JSONL + blobs + manifests + handoff
                        │
                 authenticated NDJSON subscription
                        ↓
                  Electron 协作便签
                        │
                  direct local stop API
```

## 数据与控制

- Project: canonical cwd 的稳定 id；Collaboration: 目标、预算、epoch、验收方；Message: 幂等 id、方向和类型。
- CLI session 是 `(collab_id, agent)` 下的附属资源。相同合作的常驻连接复用 session；进程重建必须校验恢复身份；新合作不得继承旧 session。
- `send` 在同步落盘后返回 task_id。队列默认 64，上限与排队超时可配置。每合作每 agent 串行，全局默认 4 个运行槽。结果投递回原 agent 的新一轮；结果通知本身不会产生自动 ACK 循环。
- 状态：active → awaiting_review → done / needs_work。needs_work 可继续派工或再次提交验收。stopped 是单独终态，不能转为 done。
- stop 在控制 HTTP handler 内同步提升 epoch 并 fsync stopped 屏障，取消待办，然后异步杀整个 Job Object 进程树。它不排队、不请求模型许可。UI 可立即显示已停止，进程清理由独立 `processes.terminated` 事件确认。
- 交接文件写入失败不能阻止进程清理。事件日志本身不可写时仍执行内存停止屏障和进程清理，本地控制 API 明确返回 `STOP_APPLIED_BUT_NOT_PERSISTED`，不能伪称已持久化。清理失败保留会话、运行容量和写锁；显式重试清理成功后才释放，空闲重载也不能绕过此约束。
- 硬超时终止请求绑定原任务和 adapter；前一轮 interrupt 尚未结算时，不恢复同会话或释放运行槽，避免迟到的终止操作影响下一轮。
- 所有 adapter 回调、自动结果唤醒和重试都携带原 epoch；屏障后不再写入任务输出或派工。scoped MCP token 同时失效。
- Windows helper 用 CreateProcess(SUSPENDED) → AssignProcessToJobObject → ResumeThread，避免先启动后归组的竞争。KILL_ON_JOB_CLOSE 清理所有后代；另等待桥拥有者进程句柄，桥意外退出时也关闭整个 job。没有扫全机/按进程名杀进程。
- 目录所有权使用 canonical 路径的重叠锁，只约束桥调度的声明写范围；CLI 本身是授权执行者，不是恶意代码沙箱。复杂并行写任务应提供不同 git worktree 的 cwd。

## 流式、重放和存活

JSONL 追加成功并 fsync 后才发布。大内容进入 SHA-256 命名的 blobs，消息只保留摘要/引用。文本和高频 native 事件按 80ms、64KiB 或 128 个事件合并；stdout 使用管道自然背压，单行超过 8MiB 会报协议错误。订阅端按 128 个事件一页写入，遇到背压等待 drain；5 秒仍读不动则断开，由 cursor 补读。不存在无限的订阅端发送队列。

日志追加处理短写；写入或 fsync 失败后拒绝继续追加，避免在残缺尾部拼接新记录。重启恢复使用实际 UTF-8 字节偏移；完整但缺少换行的尾记录补充分隔符，语法完整而序号错误的记录报错保留证据。CLI 单行限制按 UTF-8 字节计，覆盖带换行、未带换行和多字节文本；协议错误不能被 JSONL adapter 当作成功。每轮独立重置硬超时标记、原生用量和命令缓存。

`GET /events?after=N` 使用 Authorization header，首次读历史后接实时尾流。连接失败不会阻塞 CLI 或丢盘上记录。可直接用命令行订阅，还可以把 events.jsonl 作为 UI 回放输入。bridge 重启重放事实；未结算任务改成 needs_work，不盲目重放文件操作。

任意 native 事件重置静默计时。无事件但进程尚存，默认 10 秒进入“思考中”（推断）；历史不足时 60 秒进入疑似卡死。只取 ≥quietMs 的真实静默间隔，至少积累 5 个样本后参考该 agent 的历史 P95，避免 token 毫秒间隔引发误报。只标记，不杀进程。独立的每 agent 硬上限才会触发进程树终止，并使用已知 session 自动恢复重试一次；无法验证身份则立即失败。首事件和间隔样本随日志持久化。

源码/构建目录使用相同逻辑文件名计算版本指纹。更新仅允许在没有 queued/running/retrying 任务时进行；服务先同步关闭派工入口，再销毁空闲连接，保留合作状态、epoch 和已验证 session id。新服务通过日志恢复，后续派工仍校验同一 session。运行中发现版本变化会明确拒绝更新，等待任务结算；不会自动取消合作来升级。

本地 shutdown 必须显式 preserve=true（空闲保留更新）或 cancel=true（明确关闭并取消）；未声明模式的旧 client 请求会被 SHUTDOWN_MODE_REQUIRED 拒绝。此服务端防护避免已加载旧 MCP 代码的客户端绕过新更新语义。旧客户端需要重新连接，不能靠磁盘源码更新假定其内存代码也已更新。

`config.json` 位于数据目录，可配置 `maxConcurrent`, `queueLimit`, `queueTimeoutMs`, `quietMs`, `hardMs: {codex,dsh,kimi,cursor}`；修改后需重启 bridge。硬上限默认 Codex/Kimi 15 分钟，DSH/Cursor 10 分钟。没有单一 max_wait_time。

## UI 生命周期与依赖

派工先落盘，再 ensure_ui_running。具名管道探测当前数据目录的 UI 单实例；detached + showInactive 启动，不恢复用户已最小化的窗口。主动关闭写 ui.closed，同一合作不再自动弹出；新合作可以拉起。停止、验收与文件打开使用 preload 白名单，renderer 没有 Node 或 token。

MCP 优先接收每合作的 scoped token。Cursor SDK 会过滤自定义继承环境变量，因而还支持桥内的 Windows 进程祖先绑定：实际 MCP 父进程必须属于当前 Job host、agent 与 epoch 一致，随后立即换成受限 token。已关闭 host 的记录作为屏障保留，不允许退回非托管权限。此机制由真实子进程离线测试覆盖，MCP 不负责 UI 拉起。

复用项目已有 Electron 42 / React 19 / esbuild；没有新增运行时 npm 依赖。Electron 负责原生窗口、置顶、缩放、多屏、任务栏和文件打开。C# helper 使用 Windows 自带 .NET 编译器，按源码 hash 构建，旧任务运行时不会覆盖锁定的 exe。数据采用 JSONL 和内容引用，避免引入数据库服务。

## 可观测范围与边界

只控制本桥启动的 CLI，会话与其他桌面窗口相互独立。CLI 不报告的命令 exit code、计费 tokens 或费用保持 null，不生成假值。DSH/Kimi ACP 当前只提供上下文占用，不提供完整计费结果；这些 agent 的精确 token/金额预算无法按真实账单硬性保证。预算触顶只冻结新请求，不终止已分配任务、不提升 epoch，仍允许交付、结果回传和验收。协调者可通过 `mesh_budget` 调高绝对上限，桥保留已用量并重放预算变更。已经入队的任务和结果回传仍可能消耗额外额度，受原有单任务硬上限约束。用户停止仍使用终态屏障。默认没有为未知单价估算费用。

排队超时只计算具备调度条件后的等待；同会话前序任务、全局运行槽及目录写锁占用期间暂停计时。结果先持久化再尝试回投，回投失败以 `result.notification_failed` 展示，不使原任务或文件交付失效、不阻塞成功工作的验收。明确报告限额/余额错误的接收方不会被后续自动回投唤醒；显式重试成功后解除此标记。真实工作任务失败仍需处理，不能因其他任务已交付而自动算整轮完成。

历史事件保留在 `events.jsonl`，由 `node:sqlite` 的 `events-index.sqlite` 提供磁盘检索与事件页；这是可从 JSONL 重建的派生库，包含事件内容，磁盘占用会增加。首次索引以 64KiB 块读取、500 条事件一个事务，不把源文件或全部事件放进 JS 数组；后续启动只校验索引尾部并补录新尾段。SQLite page cache 配为 2MiB、禁用 mmap。索引损坏时先保留损坏文件，再从原日志重建，不删除有效历史。

bridge 仅还原在途任务及中断的自动验收；其他合作按需还原，空闲合作状态缓存最多 16 个，正在运行/清理的合作不被逐出。工作状态、任务和交付引用属于控制状态，并非原始历史事件数组。幂等 ID 和历史 task 查询在磁盘中检索。

正常桌面界面先读一个合作的当前状态快照及一页消息，再订阅当前 cursor 之后的事件。合作目录每页 25 条，选中的合作可作为第 26 项保留；消息每页最多 100 条，翻页替换页面。命令按 task 分页，先取每条命令最新的已观察状态，避免旧 started 事件重复出现或覆盖完成状态。Electron 只保留当前页和最多 256 条实时事件；renderer 的消息/命令/事件缓存分别限制在 100/100/256 条。历史附件通过桥的磁盘事件 ID 查询并校验文件哈希，不依赖实时缓冲。

原始事件订阅 API 仍支持从任意 cursor 按页读盘；诊断用 `--replay` 文件模式保持独立。多年、数 GB 历史的完整长期压测仍需专门验证。多屏断开已有纯逻辑回归，本机只有当前连接屏幕的实测证据，不宣称所有硬件组合已验证。


## 模型与思考强度

合作发起者通过 `mesh_models` 或创建/追加任务表单读取 CLI 实际选项，设置各 agent 的 `execution`。Codex 使用 app-server `model/list` 与 `turn/start.model/effort`；DSH/Kimi 使用 `session/set_config_option`，先切模型，再核对新模型提供的强度选项并验证回读；Cursor 将模型族与强度映射到 `--list-models` 实际列出的 `--model` 变体，不再固定为某个 Grok 型号。目录缓存最多 32 项、有效期五分钟。查询不运行模型推理；所有原生子进程均受 Job Object 容器和超时约束。

模型/强度只在串行任务边界变更。配置失败保留原错误，不能静默选取另一个模型或强度。`execution.configured.verification` 区分 ACP 回读、Codex 原生参数与 Cursor CLI 参数；不依据模型自述认定云端实际路由。

SQLite API 参考：[Node.js 文档](https://nodejs.org/api/sqlite.html)。实际运行环境已验证支持所用的 `DatabaseSync` 接口，无新增 npm 运行时依赖。
