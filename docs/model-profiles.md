# 模型画像维护 / Maintaining Model Profiles

[`model-profiles.json`](../src/bridge/model-profiles.json) 是调度提示的画像来源。`reviewed_on` 是最近一次实际核验的日期，不是文件生成日期。画像来自维护者对具体工作负载的定性观察；“低/中/高成本”仅表示相对判断，不是定价或基准分数。

- 每 30 天复核一次；模型、CLI 或默认推理设置变化时提前复核。仓库的定期检查只提示画像过期，不发起模型调用或篡改核验日期。
- 用相同的合成任务复测小型常规、复杂后端、前端、发散探索、3D 和批量重复任务。记录测试条件、验收通过率、延迟、重试、能取得的缓存与用量数据；缺失数据标为未知。
- 经核验后更新画像和 `reviewed_on`，只提交匿名化的汇总证据。如果结论改变适用任务，配套更新 `planning.mjs` 与路由测试；执行 `npm test`。
- `assets/cli-capabilities.json` 描述适配器的协议能力，不表示任意版本已验证。用 `npm run verify:adapters -- <agent>` 独立复测；不要提交本机证明、对话或日志。

The same JSON file supplies the coordinator's worker guidance. Review it every 30 days and whenever a provider model, CLI, or default reasoning setting materially changes. Use comparable synthetic workloads across routine work, backend, frontend, divergent exploration, 3D, and repetitive batches. Record acceptance, latency, retries, and cache or usage signals where available; mark missing evidence as unknown. Update the profile and `reviewed_on` only after an actual review. Commit anonymized aggregates only; update and test routing rules if recommendations change. The scheduled check never calls models or updates the date. Adapter verification is separate and stays local.
