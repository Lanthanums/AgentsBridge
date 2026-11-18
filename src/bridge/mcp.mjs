import readline from "node:readline";
import { ensureBridge, endpoint } from "./client.mjs";
import { randomUUID } from "node:crypto";
import { budgetCeiling, budgetProfiles, complexities, workKinds } from "./planning.mjs";
const actor = process.env.AGENTSBRIDGE_AGENT || "codex";
let scoped = Boolean(
    process.env.AGENTSBRIDGE_URL && process.env.AGENTSBRIDGE_TOKEN,
  ),
  binding = null;
let ep;
if (scoped)
  ep = {
    url: process.env.AGENTSBRIDGE_URL,
    token: process.env.AGENTSBRIDGE_TOKEN,
  };
else {
  await ensureBridge();
  ep = endpoint();
  // Some SDKs intentionally strip custom inherited env. Resolve the actual CLI
  // ancestry through the owner's local API, then immediately discard owner authority.
  const response = await fetch(ep.url + "/rpc", {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.token}` },
    body: JSON.stringify({
      method: "scopeForProcess",
      params: { pid: process.ppid, agent: actor },
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  if (body.result) {
    binding = body.result;
    ep = { url: binding.url, token: binding.token };
    scoped = true;
  }
}
async function rpc(method, params = {}) {
  if (!scoped) {
    await ensureBridge();
    ep = endpoint();
  }
  const r = await fetch(ep.url + "/rpc", {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.token}` },
    body: JSON.stringify({ method, params }),
  });
  const b = await r.json();
  if (b.error) throw new Error(b.error);
  return b.result;
}
const schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string" },
  num = { type: "number" };
const common = { collab_id: str, epoch: { type: "integer" } };
const executionSchema = schema({ model: str, reasoning_effort: str });
const profileSchema = { enum: Object.keys(budgetProfiles) };
const budgetSchema = schema(Object.fromEntries(Object.entries(budgetCeiling).map(
  ([key, maximum]) => [key, key === "max_cost_usd"
    ? { type: "number", exclusiveMinimum: 0, maximum }
    : { type: "integer", minimum: 1, maximum }],
)));
const contract = [
  {
    name: "mesh_create",
    description:
      "Start a new Collaboration with a self-contained goal. New collaborations always create fresh CLI sessions. Optional upstream is a terminal collaboration handoff.",
    inputSchema: schema(
      {
        project_id: str,
        cwd: str,
        title: str,
        goal: str,
        participants: { type: "array", items: str },
        upstream: str,
        budget_profile: profileSchema,
        budget: budgetSchema,
        execution: schema(
          Object.fromEntries(
            ["codex", "dsh", "kimi", "cursor"].map((k) => [k, executionSchema]),
          ),
        ),
      },
      ["cwd", "goal"],
    ),
  },
  {
    name: "mesh_send",
    description:
      "Asynchronously deliver a request. Explicit to preserves manual choice; to=auto requires routing and selects a compatible worker using task kind, complexity and availability. For 3D, specify concrete acceptance criteria to opt into Kimi. Classify as bulk_low_risk only for large repetitive low-requirement batches. Auto cannot override execution. Returns task_id immediately; check/wait with short waits. Never delegate to yourself.",
    inputSchema: schema(
      {
        ...common,
        from: str,
        to: { enum: ["codex", "dsh", "kimi", "cursor", "auto"] },
        routing: schema({
          kind: { enum: workKinds },
          complexity: { enum: complexities },
          acceptance: str,
        }, ["kind", "complexity"]),
        body: str,
        id: str,
        write_scope: { type: "array", items: str },
        execution: executionSchema,
      },
      ["to", "body"],
    ),
  },
  {
    name: "mesh_budget",
    description:
      "Inspect collaboration budget, used request rounds and reported usage. Only the coordinator can raise limits with a profile or absolute budget caps and a reason. Plan from task complexity, fan-out and retries; raise only as needed. Does not reset usage, stop tasks, or change depth. Presets and hard ceilings are returned.",
    inputSchema: schema({ ...common, profile: profileSchema, budget: budgetSchema, reason: str }),
  },
  {
    name: "mesh_models",
    description:
      "Read actual CLI model and reasoning options without running a model turn. The collaboration coordinator selects execution options in mesh_create or mesh_send. Unsupported choices fail explicitly.",
    inputSchema: schema(
      {
        to: { enum: ["codex", "dsh", "kimi", "cursor"] },
        cwd: str,
        model: str,
      },
      ["to"],
    ),
  },
  {
    name: "mesh_check",
    description: "Check the status and result reference for one task.",
    inputSchema: schema({ task_id: str }, ["task_id"]),
  },
  {
    name: "mesh_wait",
    description:
      "Wait at most ten seconds for a task. Does not terminate or restart a working CLI.",
    inputSchema: schema({ task_id: str, ms: num }, ["task_id"]),
  },
  {
    name: "mesh_deliver",
    description:
      "Declare a workspace file; bridge computes hash and manifest. Content stays on disk.",
    inputSchema: schema(
      {
        ...common,
        task_id: str,
        path: str,
        summary: str,
        shared: { type: "boolean" },
      },
      ["task_id", "path"],
    ),
  },
  {
    name: "mesh_progress",
    description:
      "Optional self-reported progress; UI distinguishes it from observed CLI activity.",
    inputSchema: schema({ ...common, task_id: str, text: str }, ["text"]),
  },
  {
    name: "mesh_decision",
    description: "Record a key decision for the eventual handoff.",
    inputSchema: schema({ ...common, text: str }, ["text"]),
  },
  {
    name: "mesh_complete",
    description:
      "In a managed worker turn, report completion of your own task. The bridge confirms it when your CLI turn returns successfully. An unmanaged coordinator can submit the whole collaboration for review once all assigned work has succeeded. Files are optional and must already be delivered and hashed if referenced.",
    inputSchema: schema(
      {
        ...common,
        summary: str,
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: { path: str, sha256: str },
            required: ["path", "sha256"],
          },
        },
      },
      ["summary"],
    ),
  },
  {
    name: "mesh_review",
    description:
      "Only the designated reviewer agent may accept or reject submitted work after verifying it. User control uses the local API directly.",
    inputSchema: schema(
      { ...common, accept: { type: "boolean" }, feedback: str },
      ["accept"],
    ),
  },
  {
    name: "mesh_status",
    description: "Read bridge and local CLI availability. No model calls.",
    inputSchema: schema({}),
  },
];
const visible = scoped
  ? contract.filter((t) => t.name !== "mesh_create")
  : contract;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
async function handle(m) {
  if (m.id === undefined) return;
  try {
    if (m.method === "initialize")
      return send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agentsbridge-mesh", version: "1.0.0" },
        },
      });
    if (m.method === "ping")
      return send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.method === "tools/list")
      return send({ jsonrpc: "2.0", id: m.id, result: { tools: visible } });
    if (m.method !== "tools/call")
      return send({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32601, message: "Unknown method" },
      });
    const name = m.params.name;
    const p = { ...(m.params.arguments || {}) };
    if (!visible.some((t) => t.name === name)) throw new Error("Unknown tool");
    if (scoped) {
      p.collab_id = binding?.collab_id || process.env.AGENTSBRIDGE_COLLAB_ID;
      p.epoch = binding?.epoch ?? Number(process.env.AGENTSBRIDGE_EPOCH);
    }
    if (name === "mesh_send") {
      p.from = actor;
      p.type = undefined;
      p.retry_of = undefined;
      p.id ??= randomUUID();
      p.delegate_depth =
        (binding?.delegate_depth ?? Number(process.env.MESH_DEPTH || 0)) + 1;
      if (p.to === actor) throw new Error("SELF_DELEGATION");
    }
    if (name === "mesh_create") p.coordinator = actor;
    if (name === "mesh_budget") p.actor = actor;
    if (name === "mesh_progress") p.agent = actor;
    if (name === "mesh_review") p.reviewer = actor;
    const method = {
      mesh_create: "create",
      mesh_send: "send",
      mesh_check: "check",
      mesh_wait: "wait",
      mesh_deliver: "deliver",
      mesh_progress: "progress",
      mesh_decision: "decision",
      mesh_complete: "complete",
      mesh_review: "review",
      mesh_status: "capabilities",
      mesh_models: "modelOptions",
      mesh_budget: "planBudget",
    }[name];
    const result = await rpc(method, p);
    if (name === "mesh_status")
      result.mesh = {
        actor,
        binding: binding ? "process" : scoped ? "explicit" : "unmanaged",
        collab_id:
          binding?.collab_id || process.env.AGENTSBRIDGE_COLLAB_ID || null,
        epoch:
          binding?.epoch ??
          (process.env.AGENTSBRIDGE_EPOCH
            ? Number(process.env.AGENTSBRIDGE_EPOCH)
            : null),
        delegate_depth:
          binding?.delegate_depth ?? Number(process.env.MESH_DEPTH || 0),
      };
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        isError: true,
        content: [{ type: "text", text: error.message }],
      },
    });
  }
}
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
rl.on("line", (line) => {
  try {
    void handle(JSON.parse(line));
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON" },
    });
  }
});
