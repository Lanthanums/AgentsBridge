import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Journal } from "../src/bridge/journal.mjs";
import { Engine } from "../src/bridge/engine.mjs";
import { startDaemon } from "../src/bridge/daemon.mjs";
import {
  configureAcp,
  CatalogGate,
  parseCursorModels,
  resolveCursorExecution,
} from "../src/bridge/execution-options.mjs";
import { CodexAdapter } from "../src/bridge/adapters/codex.mjs";
import {
  hydrateSnapshot,
  boundedModel,
  project,
  mergeTaskEvents,
} from "../src/ui/model.mjs";
const home = () => mkdtempSync(join(tmpdir(), "ab-pages-"));
const budget = {
  max_rounds: 20,
  max_hops: 40,
  max_tokens: 300000,
  max_cost_usd: 10,
};
test("model discovery limits concurrent CLI probes and rejects a saturated waiting queue", async () => {
  const gate = new CatalogGate(2, 1, 1000),
    a = await gate.acquire(),
    b = await gate.acquire();
  const pending = gate.acquire();
  await assert.rejects(gate.acquire(), /BUSY/);
  assert.equal(gate.active, 2);
  a();
  const c = await pending;
  assert.equal(gate.active, 2);
  b();
  c();
  assert.equal(gate.active, 0);
  assert.equal(gate.queue.length, 0);
});
function fixture(root, count = 250, rounds = 1) {
  let seq = 0,
    batch = [];
  const file = join(root, "events.jsonl");
  writeFileSync(file, "");
  const put = (
    collab_id,
    type,
    data = {},
    task_id = null,
    agent = null,
    epoch = 1,
  ) => {
    batch.push(
      JSON.stringify({
        schema_version: 2,
        seq: ++seq,
        id: `event-${seq}`,
        time: new Date().toISOString(),
        project_id: "p",
        collab_id,
        type,
        data,
        task_id,
        agent,
        epoch,
      }) + "\n",
    );
    if (batch.length >= 100) {
      appendFileSync(file, batch.join(""));
      batch = [];
    }
  };
  for (let c = 0; c < rounds; c++) {
    const id = `c-${c}`;
    put(id, "collaboration.started", {
      cwd: root,
      title: `Round ${c}`,
      goal: "segmented history",
      budget,
      reviewer: "user",
    });
    put(id, "participant.joined", { agent: "kimi" });
    put(
      id,
      "task.queued",
      {
        collab_id: id,
        to: "kimi",
        from: "user",
        message_type: "request",
        body: "work",
        write_scope: [],
      },
      `task-${c}`,
    );
    put(id, "task.completed", { summary: "done" }, `task-${c}`, "kimi");
    for (let i = 0; i < count; i++) {
      put(
        id,
        "message.sent",
        { from: "user", to: "kimi", type: "request", body: `message ${i}` },
        `task-${c}`,
      );
      put(id, "cli.batch", { summary: "noise" });
    }
    put(id, "collaboration.state", { state: "done" });
  }
  if (batch.length) appendFileSync(file, batch.join(""));
  return {
    put,
    flush: () => {
      if (batch.length) appendFileSync(file, batch.join(""));
      batch = [];
    },
    seq,
  };
}
test("legacy log imports in chunks; history pages are complete, isolated and have no resident raw log arrays", () => {
  const root = home();
  fixture(root, 250, 2);
  const j = new Journal(root);
  try {
    assert.equal(j.records, undefined);
    assert.equal(j.ids, undefined);
    const seen = [];
    let before;
    do {
      const page = j.history({ collab_id: "c-0", before, limit: 37 });
      assert.ok(page.events.length <= 37);
      assert.ok(
        page.events.every(
          (e) => e.collab_id === "c-0" && e.type === "message.sent",
        ),
      );
      seen.unshift(...page.events.map((e) => e.seq));
      before = page.has_older ? page.oldest : null;
    } while (before);
    assert.equal(seen.length, 250);
    assert.equal(new Set(seen).size, 250);
    assert.deepEqual(
      seen,
      [...seen].sort((a, b) => a - b),
    );
    assert.equal(j.index.collaborations({ limit: 1 }).has_more, true);
  } finally {
    j.close();
  }
});
test("durable source record missing from the disk index is recovered once after restart", () => {
  const root = home();
  let j = new Journal(root);
  j.append("one", null, {}, { id: "one" });
  const record = j.index.record.bind(j.index);
  j.index.record = () => {
    throw new Error("injected index failure");
  };
  assert.throws(
    () => j.append("two", null, {}, { id: "two" }),
    /index failure/,
  );
  j.index.record = record;
  j.close();
  j = new Journal(root);
  try {
    assert.equal(j.lastSeq, 2);
    assert.equal(j.append("two", null, {}, { id: "two" }).seq, 2);
    assert.equal(j.lastSeq, 2);
  } finally {
    j.close();
  }
});
test("a corrupt derived disk index is preserved and rebuilt without changing the source log", () => {
  const root = home();
  let j = new Journal(root);
  j.append("one", null);
  j.close();
  const source = readFileSync(join(root, "events.jsonl"), "utf8");
  writeFileSync(join(root, "events-index.sqlite"), "corrupt derived index");
  j = new Journal(root);
  try {
    assert.equal(j.indexRecovered, true);
    assert.equal(j.lastSeq, 1);
    assert.equal(readFileSync(join(root, "events.jsonl"), "utf8"), source);
    assert.ok(
      readdirSync(root).some((name) =>
        name.startsWith("events-index.sqlite.corrupt-"),
      ),
    );
  } finally {
    j.close();
  }
});
test("cold historical collaborations and task states hydrate lazily with a bounded cache", async () => {
  const root = home();
  fixture(root, 2, 40);
  const j = new Journal(root),
    e = new Engine(j, { ui: async () => {} });
  try {
    assert.equal(e.collabs.size, 0);
    for (let i = 0; i < 40; i++) {
      assert.equal(e.get(`c-${i}`).state, "done");
      assert.ok(e.collabs.size <= 16);
    }
    assert.equal(e.check("task-0").state, "completed");
    assert.ok(e.tasks.size <= 16);
  } finally {
    await e.destroy({ preserve: true });
    j.close();
  }
});
test("legacy collaborations infer the coordinator from their first real request without rewriting history", async () => {
  const root = home();
  fixture(root, 1, 1);
  const j = new Journal(root),
    seq = j.lastSeq,
    e = new Engine(j, { ui: async () => {} });
  try {
    const c = e.get("c-0");
    assert.equal(c.coordinator, "kimi");
    assert.equal(j.lastSeq, seq);
    assert.throws(
      () =>
        e.send({
          collab_id: c.id,
          from: "dsh",
          to: "codex",
          body: "change",
          execution: { model: "A" },
        }),
      /BARRIER|REQUIRES_COORDINATOR/,
    );
  } finally {
    await e.destroy({ preserve: true });
    j.close();
  }
});
test("restart after a durable stop but before task cancellation cannot leave phantom pending work", async () => {
  const root = home(),
    j = new Journal(root);
  const c = { id: "stopped", project_id: "p", epoch: 1 };
  j.append("collaboration.started", c, {
    cwd: root,
    goal: "barrier",
    budget,
    reviewer: "user",
  });
  j.append("participant.joined", c, { agent: "kimi" });
  j.append(
    "task.queued",
    c,
    {
      collab_id: c.id,
      to: "kimi",
      from: "user",
      body: "never restart",
      message_type: "request",
      write_scope: [],
    },
    { task_id: "pending" },
  );
  c.epoch = 2;
  j.append("collaboration.stopped", c, { reason: "user" });
  const e = new Engine(j, {
    factory: () => {
      throw Error("must not spawn");
    },
  });
  try {
    assert.equal(e.check("pending").state, "cancelled");
    assert.equal(e.get(c.id).epoch, 2);
    e.prepareShutdown(true);
  } finally {
    await e.destroy({ preserve: true });
    j.close();
  }
});

test("completed reviewer turn interrupted before settlement is invalidated on restart without spawning a model", async () => {
  const root = home(),
    j = new Journal(root),
    c = { id: "review", project_id: "p", epoch: 1 };
  j.append("collaboration.started", c, {
    cwd: root,
    goal: "review recovery",
    budget,
    reviewer: "kimi",
  });
  j.append("review.requested", c, { reviewer: "kimi", summary: "verify" });
  const e = new Engine(j, {
    factory: () => {
      throw Error("must not spawn");
    },
  });
  try {
    assert.equal(e.get(c.id).state, "needs_work");
  } finally {
    await e.destroy({ preserve: true });
    j.close();
  }
});

test("command pages select the latest state of each command and never duplicate older starts across pages", () => {
  const root = home(),
    j = new Journal(root),
    c = { id: "c", project_id: "p", epoch: 1 };
  const db = j.index.db;
  db.exec("PRAGMA synchronous=OFF");
  try {
    for (let i = 0; i < 105; i++) {
      j.append(
        "command.started",
        c,
        { id: `cmd-${i}`, command: "work" },
        { task_id: "task" },
      );
      j.append(
        "command.completed",
        c,
        { id: `cmd-${i}`, command: "work", summary: "done" },
        { task_id: "task" },
      );
    }
    const a = j.index.commandHistory({ task_id: "task" }),
      b = j.index.commandHistory({ task_id: "task", before: a.oldest });
    assert.equal(a.events.length, 100);
    assert.equal(b.events.length, 5);
    assert.ok(
      [...a.events, ...b.events].every((e) => e.type === "command.completed"),
    );
    assert.equal(
      new Set([...a.events, ...b.events].map((e) => e.data.id)).size,
      105,
    );
  } finally {
    j.close();
  }
});
test("coordinator selects per-agent execution, serial follow-ups apply it, and other workers cannot change it", async () => {
  const root = home(),
    j = new Journal(root),
    adapters = [];
  class Capture extends EventEmitter {
    async start() {
      this.emit("event", { type: "session", data: { session_id: "session" } });
    }
    async configure(v) {
      (this.choices ??= []).push(v);
    }
    async send() {
      return { text: "ok", usage: { tokens: 1 } };
    }
    async destroy() {}
    async interrupt() {}
  }
  const e = new Engine(j, {
    factory: () => {
      const a = new Capture();
      adapters.push(a);
      return a;
    },
    ui: async () => {},
  });
  try {
    const c = e.create({
      cwd: root,
      goal: "choices",
      coordinator: "codex",
      execution: { dsh: { model: "A", reasoning_effort: "low" } },
    });
    const first = e.send({
      collab_id: c.id,
      from: "codex",
      to: "dsh",
      body: "one",
    });
    await e.wait(first.task_id);
    await new Promise((r) => setImmediate(r));
    const next = e.send({
      collab_id: c.id,
      from: "codex",
      to: "dsh",
      body: "two",
      execution: { model: "B", reasoning_effort: "high" },
    });
    await e.wait(next.task_id);
    assert.equal(adapters.length, 1);
    assert.deepEqual(adapters[0].choices, [
      { model: "A", reasoning_effort: "low" },
      { model: "B", reasoning_effort: "high" },
    ]);
    assert.throws(
      () =>
        e.send({
          collab_id: c.id,
          from: "dsh",
          to: "kimi",
          body: "unauthorized",
          execution: { model: "C" },
        }),
      /REQUIRES_COORDINATOR/,
    );
    assert.equal(c.execution.dsh.model, "B");
  } finally {
    await e.destroy();
    j.close();
  }
});
test("an explicit owner retry can correct model selection while retaining the task and supersession semantics", async () => {
  const root = home(),
    j = new Journal(root);
  class Selected extends EventEmitter {
    async start() {}
    async configure(v) {
      if (v.model === "invalid") throw Error("UNSUPPORTED_MODEL");
      this.value = v;
    }
    async send() {
      return { text: "ok", usage: { tokens: 1 } };
    }
    async destroy() {}
    async interrupt() {}
  }
  const e = new Engine(j, {
    factory: () => new Selected(),
    ui: async () => {},
  });
  try {
    const c = e.create({
      cwd: root,
      goal: "correct choices",
      coordinator: "codex",
    });
    const first = e.send({
      collab_id: c.id,
      to: "kimi",
      body: "same goal",
      execution: { model: "invalid", reasoning_effort: "low" },
    });
    await e.wait(first.task_id);
    const next = e.retryTask({
      collab_id: c.id,
      task_id: first.task_id,
      execution: { model: "valid" },
    });
    await e.wait(next.task_id);
    assert.equal(e.check(next.task_id).state, "completed");
    assert.equal(e.check(next.task_id).body, "same goal");
    assert.equal(e.check(next.task_id).retry_of, first.task_id);
    assert.equal(c.execution.kimi.model, "valid");
    assert.equal(
      e.complete({ collab_id: c.id, summary: "corrected" }).state,
      "awaiting_review",
    );
  } finally {
    await e.destroy();
    j.close();
  }
});
test("ACP applies the model first and validates effort against the returned model-specific options", async () => {
  let config = [
    {
      id: "model",
      category: "model",
      currentValue: "A",
      options: [
        { group: "provider", options: [{ value: "A" }, { value: "B" }] },
      ],
    },
    {
      id: "thinking",
      category: "thought_level",
      currentValue: "low",
      options: [{ value: "low" }, { value: "high" }],
    },
  ];
  const calls = [];
  const rpc = {
    async request(method, p) {
      calls.push(p);
      config = config.map((o) => ({
        ...o,
        currentValue: o.id === p.configId ? p.value : o.currentValue,
        options:
          o.id === "thinking"
            ? [{ value: "low" }, { value: "max" }]
            : o.options,
      }));
      return { configOptions: config };
    },
  };
  await assert.rejects(
    configureAcp(rpc, "id", config, { model: "B", reasoning_effort: "high" }),
    /UNSUPPORTED/,
  );
  assert.equal(calls.length, 1);
  const result = await configureAcp(rpc, "id", config, {
    model: "B",
    reasoning_effort: "max",
  });
  assert.equal(result[1].currentValue, "max");
  await assert.rejects(
    configureAcp(
      { request: async () => ({ configOptions: config }) },
      "id",
      config,
      { reasoning_effort: "low" },
    ),
    /MISMATCH/,
  );
});
test("Cursor model and effort resolve to actual listed variants without a hardcoded model default", () => {
  const models = parseCursorModels(
    "auto - Auto (default)\ngrok-4.7-low - Grok Low\ngrok-4.7-high - Grok High\ngrok-4.7-high-fast - Grok High Fast\ncomposer-2.5 - Composer\n",
  );
  assert.equal(
    resolveCursorExecution(models, {
      model: "grok-4.7",
      reasoning_effort: "low",
    }),
    "grok-4.7-low",
  );
  assert.equal(
    resolveCursorExecution(models, {
      model: "grok-4.7-fast",
      reasoning_effort: "high",
    }),
    "grok-4.7-high-fast",
  );
  assert.throws(
    () =>
      resolveCursorExecution(models, {
        model: "composer-2.5",
        reasoning_effort: "high",
      }),
    /UNSUPPORTED/,
  );
  assert.throws(
    () => resolveCursorExecution(models, { model: "grok-4.7" }),
    /REQUIRED/,
  );
});
test("Codex sends selected model and effort as protocol fields, not prompt text", async () => {
  const a = new CodexAdapter({});
  let turn;
  a.sessionId = "session";
  a.rpc = {
    async request(method, p) {
      if (method === "model/list")
        return {
          data: [
            {
              model: "model-A",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            },
          ],
        };
      turn = p;
      queueMicrotask(() =>
        a.turnDone({
          status: "completed",
          items: [{ type: "agentMessage", text: "ok" }],
        }),
      );
      return { turn: { id: "turn" } };
    },
  };
  await a.configure({ model: "model-A", reasoning_effort: "low" });
  await a.send("task");
  assert.equal(turn.model, "model-A");
  assert.equal(turn.effort, "low");
  assert.equal(turn.input[0].text, "task");
  await assert.rejects(
    a.configure({ model: "model-A", reasoning_effort: "max" }),
    /UNSUPPORTED/,
  );
});
test("history API returns only one bounded page and authoritative current state", async () => {
  const root = home();
  fixture(root, 260, 2);
  const d = await startDaemon({
    home: root,
    engineOptions: { ui: async () => {} },
  });
  try {
    const r = await fetch(d.descriptor.url + "/rpc", {
      method: "POST",
      headers: { Authorization: `Bearer ${d.descriptor.token}` },
      body: JSON.stringify({ method: "history", params: { collab_id: "c-0" } }),
    });
    const { result } = await r.json();
    assert.equal(result.history.events.length, 100);
    assert.equal(result.collaboration.tasks["task-0"].state, "completed");
    assert.equal(result.history.has_older, true);
    assert.ok(result.collaborations.items.length <= 25);
  } finally {
    await d.close();
  }
});
test("UI paging preserves current state and bounds live records; older commands cannot overwrite newer ones", () => {
  const c = {
    id: "c",
    state: "done",
    participants: {},
    tasks: { t: { state: "completed" } },
    artifacts: [],
    usage: { tokens: 1 },
  };
  let m = hydrateSnapshot({
    collaboration: c,
    collaborations: { items: [c] },
    cursor: 1000,
    history: {
      events: [
        {
          seq: 1,
          id: "m",
          type: "message.sent",
          collab_id: "c",
          data: { type: "request", body: "old", from: "user", to: "kimi" },
        },
      ],
    },
  });
  assert.equal(m.collaborations.c.tasks.t.state, "completed");
  assert.equal(m.cursor, 1000);
  assert.deepEqual(m.collaborations.c.artifact_reviews, {});
  for (let i = 1001; i < 1500; i++)
    m = boundedModel(
      project(m, [
        {
          seq: i,
          id: `e${i}`,
          collab_id: "c",
          type: "message.sent",
          data: { body: "live", from: "user", to: "kimi" },
        },
      ]),
    );
  assert.equal(m.messages.length, 100);
  assert.equal(Object.keys(m.events).length, 256);
  m = mergeTaskEvents(m, [
    {
      seq: 19,
      id: "done",
      collab_id: "c",
      task_id: "t",
      type: "command.completed",
      data: { id: "cmd", summary: "new" },
    },
  ]);
  m = mergeTaskEvents(m, [
    {
      seq: 9,
      id: "start",
      collab_id: "c",
      task_id: "t",
      type: "command.started",
      data: { id: "cmd", summary: "old" },
    },
  ]);
  assert.equal(m.commands["c:t:cmd"].summary, "new");
  assert.equal(m.cursor, 1499);
});
