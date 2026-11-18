import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/bridge/journal.mjs";
import { Engine } from "../src/bridge/engine.mjs";
import { bulkGrokExecution } from "../src/bridge/adapters/cursor.mjs";
import {
  parseCursorModels,
  resolveCursorExecution,
} from "../src/bridge/execution-options.mjs";
import {
  budgetProfiles,
  normalizeRouting,
  resolveBudget,
  routeTask,
} from "../src/bridge/planning.mjs";

const kinds = ["codex", "dsh", "kimi", "cursor"];
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Worker extends EventEmitter {
  async configure() {}
  async start({ sessionId }) {
    this.sessionId = sessionId || "verified-fixture-session";
    this.emit("event", {
      type: "session",
      data: { session_id: this.sessionId },
    });
  }
  async send(prompt) {
    this.prompt = prompt;
    return new Promise((resolve, reject) => {
      this.finish = (tokens = 1, cost_usd = null) =>
        resolve({ text: "ok", usage: { tokens, cost_usd } });
      this.fail = reject;
    });
  }
  async destroy() {
    this.fail?.(new Error("fixture closed"));
  }
}

function setup(options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ab-planning-"));
  const journal = new Journal(cwd);
  const make = () =>
    new Engine(journal, {
      factory: () => new Worker(),
      workers: () => kinds,
      ...options,
    });
  const engine = make();
  return { cwd, journal, engine, make };
}

test("budget creation profiles, legacy overrides and invalid limits", () => {
  assert.deepEqual(resolveBudget(undefined, {}), budgetProfiles.standard);
  assert.deepEqual(resolveBudget("complex", { max_rounds: 1 }), {
    ...budgetProfiles.complex,
    max_rounds: 1,
  });
  for (const patch of [
    null,
    [],
    { max_rounds: 0 },
    { max_tokens: "1" },
    { max_tokens: Infinity },
    { max_rounds: 257 },
    { max_hops: 1.5 },
    { max_cost_usd: -5 },
    { max_cost_usd: 151 },
    { extra: 1 },
  ])
    assert.throws(() => resolveBudget(undefined, patch), /INVALID_BUDGET/);
  assert.throws(() => resolveBudget("unknown", {}), /INVALID_BUDGET_PROFILE/);
});

test("routing picks each specialist and preserves high-risk work and unavailable fallbacks", () => {
  for (const [kind, complexity, acceptance, eligible, selected] of [
    ["backend", "high", undefined, kinds, "codex"],
    ["routine", "low", undefined, kinds, "dsh"],
    ["frontend", "medium", undefined, kinds, "codex"],
    ["3d", "high", "Deliver glTF; closed mesh; unit box.", kinds, "kimi"],
    ["3d", "high", undefined, kinds, "codex"],
    ["3d", "medium", "Deliver glTF", ["codex", "cursor"], "codex"],
    ["bulk_low_risk", "low", undefined, kinds, "cursor"],
    ["bulk_low_risk", "high", undefined, kinds, "codex"],
    ["bulk_low_risk", "low", undefined, ["dsh", "kimi"], "dsh"],
    ["exploration", "medium", undefined, ["dsh", "kimi", "cursor"], "dsh"],
  ])
    assert.equal(
      routeTask(normalizeRouting({ kind, complexity, acceptance }), eligible)
        .selected,
      selected,
    );
  assert.throws(
    () =>
      routeTask({ kind: "backend", complexity: "high" }, [
        "dsh",
        "kimi",
        "cursor",
      ]),
    /NO_SUITABLE_AGENT/,
  );
  assert.throws(
    () => normalizeRouting({ kind: "3d", complexity: "high", acceptance: " " }),
    /INVALID_TASK_ROUTING/,
  );
});

test("bulk Cursor defaults to a non-fast low-effort Grok option in the native catalog", () => {
  const models = parseCursorModels(
    "auto - Auto\ngpt-low - GPT\ncursor-grok-4.5-low - Older Grok\ngrok-4.7-high - Grok\ngrok-4.7-low-fast - Grok Fast\ngrok-4.7-low - Grok Low",
  );
  assert.equal(
    resolveCursorExecution(models, bulkGrokExecution(models)),
    "grok-4.7-low",
  );
  assert.throws(
    () =>
      bulkGrokExecution(
        models.filter(
          (model) => !["grok-4.7", "cursor-grok-4.5"].includes(model.id),
        ),
      ),
    /CURSOR_LOW_EFFORT_GROK_UNAVAILABLE/,
  );
});

test("auto retries are idempotent across worker changes and budget freeze; manual execution and Kimi briefing survive", async () => {
  let workers = kinds;
  const { engine, journal, cwd } = setup({ workers: () => workers });
  try {
    const c = engine.create({
      cwd,
      goal: "Routing durability",
      coordinator: "codex",
      budget: { max_rounds: 2 },
      execution: { kimi: { model: "precise" } },
    });
    const params = {
      collab_id: c.id,
      from: "codex",
      to: "auto",
      id: "routed",
      body: "Model one cube",
      routing: {
        kind: "3d",
        complexity: "medium",
        acceptance: "  unit-edge cube  ",
      },
    };
    const first = engine.send(params);
    await tick();
    const slot = engine.adapters.get(`${c.id}:kimi`);
    assert.match(slot.adapter.prompt, /Acceptance criteria: unit-edge cube/);
    assert.equal(engine.check(first.task_id).execution.model, "precise");
    const manual = engine.send({
      collab_id: c.id,
      from: "codex",
      to: "cursor",
      body: "Explicit test",
    });
    assert.equal(engine.check(manual.task_id).to, "cursor");
    workers = ["dsh"];
    assert.deepEqual(engine.send(params), {
      task_id: first.task_id,
      duplicate: true,
      to: "kimi",
      routing: first.routing,
    });
    assert.throws(
      () =>
        engine.send({
          ...params,
          routing: { ...params.routing, acceptance: undefined },
        }),
      /IDEMPOTENCY_CONFLICT/,
    );
    assert.throws(
      () => engine.send({ ...params, id: "other" }),
      /BUDGET_EXCEEDED/,
    );
    assert.equal(engine.planBudget({ collab_id: c.id }).request_rounds, 2);
    slot.adapter.fail(new Error("fixture failure"));
    await engine.wait(first.task_id);
    engine.planBudget({
      collab_id: c.id,
      profile: "small",
      reason: "Room for one retry",
    });
    const retried = engine.retryTask({
      collab_id: c.id,
      task_id: first.task_id,
    });
    await tick();
    assert.equal(engine.check(retried.task_id).to, "kimi");
    assert.match(
      engine.adapters.get(`${c.id}:kimi`).adapter.prompt,
      /Acceptance criteria: unit-edge cube/,
    );
  } finally {
    await engine.destroy();
    journal.close();
  }
});

test("usage freeze drains a saturated queue and delivers callbacks with no epoch change; extension survives replay", async (t) => {
  const { engine, journal, cwd, make } = setup({
    maxConcurrent: 2,
    queueLimit: 40,
  });
  let replay;
  try {
    const c = engine.create({
      cwd,
      goal: "Saturated dynamic budget",
      budget: { max_rounds: 25, max_tokens: 5, max_cost_usd: 1 },
    });
    const root = engine.send({
      collab_id: c.id,
      to: "codex",
      body: "coordinate",
    });
    const childParams = {
      collab_id: c.id,
      from: "codex",
      to: "auto",
      body: "batch item",
      routing: { kind: "routine", complexity: "low" },
      hop: 1,
      delegate_depth: 1,
    };
    const children = Array.from({ length: 24 }, (_, index) =>
      engine.send({ ...childParams, id: `batch-${index}` }),
    );
    await tick();
    const adapter = (kind) => engine.adapters.get(`${c.id}:${kind}`).adapter;
    assert.match(adapter("codex").prompt, /inspect mesh_budget/);
    adapter("dsh").finish(5, 1);
    await engine.wait(children[0].task_id);
    await tick();
    assert.equal(c.budget_exhausted.reason, "usage_budget");
    assert.equal(
      Object.values(c.tasks).filter(
        (task) => task.message_type === "result" && task.state === "queued",
      ).length,
      1,
    );
    assert.throws(() => engine.send(childParams), /BUDGET_EXCEEDED/);
    assert.throws(
      () =>
        engine.planBudget({
          collab_id: c.id,
          actor: "dsh",
          profile: "complex",
          reason: "Denied",
        }),
      /BUDGET_UPDATE_REQUIRES_COORDINATOR/,
    );
    adapter("codex").finish(null);
    await engine.wait(root.task_id);
    for (const task of children.slice(1)) {
      await tick();
      adapter("dsh").finish(1);
      assert.equal((await engine.wait(task.task_id)).state, "completed");
    }
    const resultTasks = Object.values(c.tasks).filter(
      (task) => task.message_type === "result",
    );
    assert.equal(resultTasks.length, children.length);
    for (const task of resultTasks) {
      await tick();
      adapter("codex").finish(1);
      assert.equal((await engine.wait(task.id)).state, "completed");
    }
    assert.equal(c.epoch, 1);
    assert.equal(c.usage.tokens, 52);
    assert.equal(c.usage.unknown, true);
    const plan = {
      collab_id: c.id,
      actor: "codex",
      reason: "Allow the final validation stage",
    };
    assert.equal(
      engine.planBudget({
        ...plan,
        budget: { max_tokens: 60, max_cost_usd: 2 },
      }).exhausted.reason,
      "round_or_hop_budget",
    );
    const limits = { max_rounds: 26 };
    assert.equal(
      engine.planBudget({ ...plan, budget: limits }).exhausted,
      null,
    );
    engine.planBudget({ ...plan, budget: limits });
    assert.equal(
      journal
        .events(0, c.id, 10000)
        .filter((event) => event.type === "budget.updated").length,
      2,
    );
    await engine.destroy({ preserve: true });
    replay = make();
    const status = replay.planBudget({ collab_id: c.id });
    assert.equal(status.exhausted, null);
    assert.equal(status.usage.tokens, 52);
    assert.equal(status.budget.max_rounds, 26);
    assert.throws(
      () => replay.send({ ...childParams, hop: status.budget.max_hops }),
      /max_hops/,
    );
    assert.throws(
      () => replay.send({ ...childParams, delegate_depth: 3 }),
      /DELEGATION_DEPTH_EXCEEDED/,
    );
    const last = replay.send(childParams);
    await tick();
    await replay.stop(c.id);
    assert.equal(replay.check(last.task_id).state, "cancelled");
    assert.throws(
      () => replay.planBudget({ ...plan, profile: "complex" }),
      /COLLABORATION_BARRIER/,
    );
    t.diagnostic(
      `Drained ${children.length} admitted children and ${resultTasks.length} callbacks while budget was exhausted`,
    );
  } finally {
    await (replay || engine).destroy();
    journal.close();
  }
});
