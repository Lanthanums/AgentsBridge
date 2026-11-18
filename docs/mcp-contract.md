# AgentsBridge MCP contract v2

All harnesses use `src/bridge/mcp.mjs`; do not fork tool names or invent transport formats.
The bridge is the authority; MCP is an optional producer of richer events. JSONL CLI
observation, UI launch, control, journaling and replay work without MCP.

## Local setup

Build the project and verify the selected CLI from the repository root with
`npm run build` and `npm run verify:adapters -- <agent>`. Register a local
stdio server named `mesh` in the coordinator's MCP configuration:

```json
{
  "command": "C:/path/to/node.exe",
  "args": ["C:/path/to/AgentsBridge/src/bridge/mcp.mjs"],
  "env": { "AGENTSBRIDGE_AGENT": "codex" }
}
```

Use the real absolute paths and coordinator identity. If you override
`AGENTSBRIDGE_HOME`, use the same value for the probe, desktop, and MCP server.
Run `mesh_status` to confirm the connection, then give `mesh_create` an
absolute workspace path, a self-contained goal, and the intended participants.
Use `mesh_check` or `mesh_wait` with the task ID from `mesh_send`.

## Tools

| Tool                   | Parameters (required in bold)                                    | Authoritative event            |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------ |
| mesh_create            | **cwd, goal**, project_id, title, participants[], upstream, budget_profile, budget, execution{agent:{model,reasoning_effort}} | collaboration.started |
| mesh_send              | **to, body**, collab_id, epoch, id, write_scope[], routing{kind,complexity,acceptance}, execution{model,reasoning_effort} | message.sent, task.queued |
| mesh_models            | **to**, cwd, model                                               | actual CLI catalog; no model turn |
| mesh_budget            | collab_id, epoch; for updates: profile and/or budget, **reason** | read only or budget.updated |
| mesh_check / mesh_wait | **task_id**, ms ≤10000 for wait                                  | read only                      |
| mesh_deliver           | **task_id, path**, collab_id, epoch, summary, shared             | artifact.delivered + manifest  |
| mesh_progress          | **text**, task_id, collab_id, epoch                              | agent.progress (self_reported) |
| mesh_decision          | **text**, collab_id, epoch                                       | decision.recorded              |
| mesh_complete          | **summary**, collab_id, epoch, artifacts[{path,sha256}]          | agent.completion_reported / review.requested |
| mesh_review            | **accept**, feedback, collab_id, epoch; designated reviewer only | review.recorded                |
| mesh_status            | none                                                             | read only                      |

Managed CLI sessions receive a collaboration/epoch/agent scoped capability token.
Scope is enforced by the bridge, not by model instructions. User stop/review control
is deliberately absent. The UI calls the owner's local control API directly.
Unmanaged harnesses use the current-user endpoint token and must provide collab_id.
When an SDK filters inherited environment variables, the bridge binds the real
MCP process ancestry to a live managed CLI Job host before issuing a scoped token.
`mesh_status.mesh` reports actor, binding (`explicit`, `process`, `unmanaged`),
collab_id, epoch and delegate_depth. Managed sessions hide mesh_create; requests
derive delegation depth from the active task and cannot exceed A→B→C (depth 2).
send returns task_id immediately. Repeated ids with differing bodies are errors.
Messages are limited to 32 KiB; tool output and file contents are disk references.
Stopping invalidates all scoped tokens and the epoch before process termination.

The creator's MCP actor is the collaboration coordinator. In the desktop UI the
first recipient is the coordinator. Only that coordinator or the local owner may
select execution overrides; other workers may dispatch within their depth/scope
but cannot override model/effort. `mesh_create.execution` sets per-agent defaults;
`mesh_send.execution` changes the selected receiver's configuration for this and
subsequent work. Omitted fields inherit the collaboration's selection, initially
the native CLI defaults. A queued task captures its execution options so later
selection changes cannot alter an already queued request. Native configuration is
applied only at a serialized turn boundary, without changing global CLI settings.

Call `mesh_models` for exact option IDs and supported strengths. DSH/Kimi use ACP
configuration values (including provider-qualified IDs); Codex uses native
model/effort fields; Cursor resolves a listed model family and strength to a real
CLI variant. Unsupported combinations fail explicitly before a model turn.
`execution.selected` records the choice, and `execution.configured` records the
adapter's confirmation source. Parameter acceptance is not a claim about cloud
provider routing beyond what the CLI reports. The desktop owner can use “调整模型后重试”
to correct a failed task while preserving its retry/supersession relationship.

Existing MCP clients must reconnect to refresh their tool schemas. Old requests
with a named recipient remain valid and do not use automatic routing.

### Task routing

Use `to: "auto"` and `routing: { "kind": "routine", "complexity": "low" }`
for a typical small task. Kinds are `routine`, `backend`, `frontend`,
`exploration`, `3d`, `bulk_low_risk`, and `general`; complexity is `low`,
`medium`, or `high`. The coordinator classifies the actual task rather than
relying on keyword matching. Small/familiar work prefers DSH; precision-heavy
backend and other high-complexity work prefer Codex. There is no assumed design
or divergent-ideation specialist. Kimi is used for 3D only when concrete
`acceptance` criteria are supplied and passed to the worker. Only a **large,
repetitive, low-requirement** batch classified as low complexity may auto-route
to Cursor. Without an explicit collaboration model, Cursor uses a non-fast
Grok option with visibly low reasoning effort from the native catalog; if none
exists, the task fails explicitly rather than silently switching providers.

Automatic selection considers locally installed, capability-verified workers,
excluding the sender and workers already marked unavailable or left. A route
can select a worker not listed in `participants` (as with explicit sends).
The response and journal show both preferred and chosen recipients. If no
suitable worker exists, send fails without creating a task; keep the work local
or choose manually. A repeat with the same id returns the originally selected
worker, even if availability changes. For per-task execution overrides, use a
named recipient; auto inherits collaboration settings for the chosen worker.

In a managed turn, `mesh_complete` optionally records the current worker's own
report. The successful CLI turn supplies the completion signal even for text-only
tasks. The coordinator submits the collaboration with `mesh_complete` after all
assigned work has succeeded and result notifications have settled. Failed result
notifications remain visible as warnings and do not invalidate recorded work or
block user review. An exhausted recipient is not automatically awakened again;
retry requires an explicit request. Agents selected
but never assigned work stay on standby. Failed tasks require a successful retry.
The owner can accept a file version independently in the UI. Final acceptance
checks the latest delivered hashes. A new task or file delivery invalidates a
pending collaboration review.

### Budget planning

| Profile | Request rounds | Max hop per request | Reported tokens | Reported USD |
| ------- | -------------: | ------------------: | --------------: | -----------: |
| `small` | 24 | 48 | 600,000 | 15 |
| `standard` (default) | 48 | 96 | 1,500,000 | 30 |
| `complex` | 96 | 128 | 4,500,000 | 65 |
| Hard limit | 256 | 256 | 12,000,000 | 150 |

At creation, `budget_profile` sets the base, and explicit `budget` fields
(`max_rounds`, `max_hops`, `max_tokens`, `max_cost_usd`) override it. Existing
collaborations keep recorded limits. During a collaboration, read `mesh_budget`
before a large fan-out; the coordinator or local owner can raise absolute caps
without resetting consumed rounds/usage. For example:
`mesh_budget({"profile":"complex","reason":"Parallel modules and integration checks"})`.
Profile upgrades never lower an existing limit. An update is journaled along
with its reason and reopens admission only if all exhausted limits are now
above current usage. The collaboration's epoch and delegation depth limit of
two do not change; a single over-hop request is rejected without blocking others.

Budget exhaustion rejects only new work requests. Admitted work, file delivery,
result notification turns, and review still proceed. A notification is bounded
to one per admitted request and remains subject to provider quota and per-task
hard limits. Already admitted work can spend beyond the threshold. The budget
tracks only usage reported by adapters, not a provider bill or prepaid balance.
Explicit user stop retains the terminal barrier.
Queue timeouts measure dispatchable scheduler wait; time waiting for a busy CLI
session, global capacity, or overlapping write ownership does not count.

Fallback: MCP connection failure must be visible in CLI diagnostics. Task replies,
commands and native usage still arrive via the adapter. Users can declare artifacts
and submit/accept review via the local application/API. No failed MCP request is
silently retried or reinterpreted as successful delivery.
