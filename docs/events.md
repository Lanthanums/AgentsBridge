# 结构化事件与订阅

所有事件使用 event-schema.json 的 v2 envelope：seq 全局递增；id 幂等；time 为 UTC；project_id/collab_id/task_id/agent 表明归属，epoch 表明代际。先 fsync 落盘，再发布。UI 根据此日志投影，不读取 adapter 状态。

| 事件 | data 与语义 |
|---|---|
| project.registered | id、canonical cwd、title |
| collaboration.started | 目标、cwd、预算、reviewer、完整 upstream handoff |
| participant.joined / participant.left | agent |
| task.queued / running / retrying / completed / failed / cancelled | 队列参数、时间、摘要、result_ref 或原始错误；每个 task_id 对应一次派工 |
| message.sent / message.delivered | from、to、type=request/result/review、body、reply_to；自动派工的 sent 记录 routing（首选、实选、类型、复杂度、可选验收条件）；大内容只传引用 |
| process.started / processes.terminated | 桥托管 host PID；清理结果 verified/errors。停止事件不冒充清理已完成 |
| process.cleanup_failed | 原始清理错误、可选 original_error；未确认退出的进程继续占用调度容量和写锁，不能靠模型完成报告解锁 |
| session.bound | session_id；恢复必须验证相同 id |
| collaboration.coordinator | agent；发起者可选择各 CLI 模型和思考强度 |
| execution.selected / execution.configured | 所选 model、reasoning_effort，或 requested/applied/verification；不以提示词或模型自述冒充配置成功 |
| agent.state | waiting/working/thinking/tool/suspected_stall/failed；推断标记、silent_since、历史 P95。UI 不显示假进度 |
| agent.progress / decision.recorded | 自述 text 与 self_reported，或 handoff 关键决策 |
| command.started / command.updated / command.completed | id、command、started_at、native_status、exit_code（未知 null）、summary、output_ref |
| output.batch / cli.event / cli.batch | 摘要或 native_type/count，以及完整输出 ref={path,sha256,bytes} |
| usage.recorded | 原生 tokens/cost_usd/duration_ms；缺失保持 null，source 标明来源 |
| budget.exhausted | reason；拒绝新增工作请求，已分配任务继续交付和回传结果，epoch 不变 |
| budget.updated | previous、budget、reason、可选 profile、更新后的 exhausted；可重放的协调者扩容记录，不重置用量 |
| agent.unavailable | 原始限额/余额错误 error；停止自动回投唤醒，显式执行成功后解除 |
| result.notification_failed / result.notification_delivered | error（失败时）、to、reply_to；原工作结果独立持久化，回投失败不阻塞验收 |
| metric.first_event / metric.samples / metric.silence | latency_ms、first_event_ms、gaps_ms 或单次静默间隔，供按 agent 的静默分布统计 |
| agent.hard_limit | hard_ms、retry；仅此独立硬上限触发一次恢复，不是静默阈值 |
| artifact.delivered | path、sha256、bytes、summary、shared；来源由 envelope task_id/agent 记录，另写 manifest.json |
| review.requested / review.dispatched / review.decision_pending / review.recorded | summary、artifacts、reviewer 或 accept/feedback。完成声明本身不等于 done |
| collaboration.state | awaiting_review / needs_work / done，与 stopped 严格分开 |
| collaboration.stopped | reason；使用作废后的新 epoch 建屏障。旧 epoch 的输出、回投和派工被丢弃 |
| handoff.generated | path、sha256、summary、status；新合作验证此文件与交付哈希 |
| handoff.failed | error；不阻止停止时杀进程，UI 可显式重试清理与交接 |
| ui.closed / ui.launch_failed | 用户关闭抑制或启动失败；消息仍在日志中 |

订阅使用 localhost HTTP NDJSON：GET /events?after=N 携带 Authorization: Bearer 当前用户 token。先按 seq 补读历史，再推送新事件。heartbeat 是传输心跳，不写入合作日志；断线只需保存最后 seq 并重连。token 不得放 URL 或分享。

命令行入口：node scripts/mesh.mjs subscribe '{"after":0}'。完整 stdout 可重定向到 JSONL；UI 使用 --replay 路径即可投影历史，回放有显著标识，不执行真实控制。

每合作 manifest 与 handoff 位于数据目录 collaborations/ID。完整命令输出与原生 JSON 位于内容寻址 blobs，消息只携带路径、哈希、摘要。UI 通过受限 readRef 读取这些引用。
