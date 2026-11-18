import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Journal } from "../src/bridge/journal.mjs";
import { Engine } from "../src/bridge/engine.mjs";
import { AcpAdapter } from "../src/bridge/adapters/base.mjs";
import { CodexAdapter } from "../src/bridge/adapters/codex.mjs";
import { launch, killTree } from "../src/bridge/process.mjs";
import { startDaemon } from "../src/bridge/daemon.mjs";
import { spawn } from "node:child_process";
process.env.AGENTSBRIDGE_NO_UI = "1";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = resolve("tests/fixtures/fake-cli.mjs");
class Fake extends EventEmitter {
  async start({ sessionId }) {
    this.sessionId = sessionId || `s-${Math.random()}`;
    this.emit("event", {
      type: "session",
      data: { session_id: this.sessionId },
    });
    return this.sessionId;
  }
  async send(text) {
    this.text = text;
    return new Promise((resolve, reject) => {
      this.finish = () =>
        resolve({
          text: "result",
          session_id: this.sessionId,
          usage: { tokens: 10, cost_usd: 0.01 },
        });
      this.reject = reject;
    });
  }
  async destroy() {
    this.destroyed = true;
    this.reject?.(new Error("terminated"));
  }
  async interrupt() {
    await this.destroy();
  }
}
function setup(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "ab-test-"));
  const log = new Journal(home);
  const adapters = [];
  const engine = new Engine(log, {
    factory: () => {
      const a = new Fake();
      adapters.push(a);
      return a;
    },
    ui: async () => {},
    ...options,
  });
  const c = engine.create({
    cwd: home,
    goal: "Test meaningful lifecycle",
    participants: ["dsh", "kimi"],
  });
  return {
    home,
    log,
    engine,
    c,
    adapters,
    async close() {
      await engine.destroy();
      log.close();
    },
  };
}
test("send returns task id immediately; idempotency and context-bearing result are durable", async () => {
  const s = setup();
  try {
    const r = s.engine.send({
      collab_id: s.c.id,
      to: "dsh",
      body: "review",
      id: "one",
    });
    assert.equal(s.engine.check(r.task_id).state, "running");
    const again = s.engine.send({
      collab_id: s.c.id,
      to: "dsh",
      body: "review",
      id: "one",
    });
    assert.equal(r.task_id, again.task_id);
    assert.throws(
      () =>
        s.engine.send({
          collab_id: s.c.id,
          to: "dsh",
          body: "different",
          id: "one",
        }),
      /CONFLICT/,
    );
    await delay(10);
    s.adapters[0].finish();
    assert.equal((await s.engine.wait(r.task_id, 1000)).state, "completed");
    assert.equal(s.c.state, "active");
    assert.match(s.adapters[0].text, /Test meaningful lifecycle/);
    assert.ok(
      s.log.events(0, undefined, 5000).some(
        (e) => e.type === "message.delivered" && e.data.type === "result",
      ),
    );
  } finally {
    await s.close();
  }
});
test("stop establishes durable epoch barrier before interrupt; queued and late effects cannot awaken agents", async () => {
  const s = setup({ maxConcurrent: 1 });
  try {
    const a = s.engine.send({ collab_id: s.c.id, to: "dsh", body: "work" });
    s.engine.send({ collab_id: s.c.id, to: "kimi", body: "queued" });
    await delay(5);
    const old = s.c.epoch;
    const stop = await s.engine.stop(s.c.id, "user", old);
    assert.equal(stop.state, "stopped");
    assert.equal(s.c.epoch, old + 1);
    assert.throws(
      () =>
        s.engine.send({
          collab_id: s.c.id,
          to: "kimi",
          body: "late",
          epoch: old,
        }),
      /BARRIER/,
    );
    s.adapters[0].emit("event", { type: "text", data: { text: "late" } });
    await delay(20);
    assert.equal(s.adapters.length, 1);
    assert.equal(s.engine.check(a.task_id).state, "cancelled");
    assert.ok(!s.log.events(0, undefined, 5000).some((e) => e.type === "output.batch"));
    assert.ok(readFileSync(s.c.handoff.path, "utf8").includes("stopped"));
  } finally {
    await s.close();
  }
});
test("complete requires review, rejected work continues, accepted handoff creates fresh sessions", async () => {
  const s = setup();
  try {
    const r = s.engine.send({ collab_id: s.c.id, to: "dsh", body: "do" });
    await delay(5);
    s.adapters[0].finish();
    await s.engine.wait(r.task_id);
    s.engine.complete({ collab_id: s.c.id, summary: "ready" });
    assert.equal(s.c.state, "awaiting_review");
    await s.engine.review({
      collab_id: s.c.id,
      accept: false,
      feedback: "fix",
    });
    assert.equal(s.c.state, "needs_work");
    s.engine.complete({ collab_id: s.c.id, summary: "fixed" });
    await s.engine.review({ collab_id: s.c.id, accept: true });
    assert.equal(s.c.state, "done");
    const n = s.engine.create({
      cwd: s.home,
      goal: "Next goal",
      upstream: s.c.id,
    });
    const next = s.engine.send({ collab_id: n.id, to: "dsh", body: "new" });
    await delay(5);
    assert.notEqual(s.adapters[0].sessionId, s.adapters[1].sessionId);
    assert.match(s.adapters[1].text, /Upstream handoff/);
    assert.match(s.adapters[1].text, /Next goal/);
    s.adapters[1].finish();
    await s.engine.wait(next.task_id);
  } finally {
    await s.close();
  }
});
test("file acceptance stays independent; all assigned work must succeed and review binds to current work", async () => {
  const s = setup();
  const collab_id = s.c.id;
  const send = (to, body) => s.engine.send({ collab_id, to, body });
  const submit = () =>
    s.engine.complete({ collab_id, summary: "Review current work" });
  try {
    const first = send("dsh", "Create a file");
    const second = send("kimi", "Return findings as text");
    const path = join(s.home, "result.txt");
    writeFileSync(path, "version 1");
    const v1 = s.engine.deliver({ collab_id, task_id: first.task_id, path });
    s.engine.reportCompletion({
      collab_id,
      task_id: first.task_id,
      summary: "File ready",
    });
    assert.equal(
      s.engine.reviewArtifact({ collab_id, artifact_id: v1.event_id }).state,
      "active",
    );
    assert.throws(submit, /TASKS_STILL_RUNNING/);
    await delay(5);
    s.adapters[0].finish();
    await s.engine.wait(first.task_id);
    assert.equal(s.engine.check(second.task_id).state, "running");
    assert.equal(s.adapters[1].destroyed, undefined);
    s.adapters[1].reject(new Error("first attempt failed"));
    await s.engine.wait(second.task_id);
    assert.throws(submit, /FAILED_TASKS_NEED_RETRY/);
    const retry = s.engine.retryTask({ collab_id, task_id: second.task_id });
    assert.equal(
      s.engine.retryTask({ collab_id, task_id: second.task_id }).task_id,
      retry.task_id,
    );
    await delay(5);
    assert.match(s.adapters[2].text, /Retry of/);
    s.adapters[2].finish();
    await s.engine.wait(retry.task_id);
    const oldReview = submit();
    const followUp = send("dsh", "Check the result again");
    assert.equal(s.c.state, "active");
    await assert.rejects(
      s.engine.review({
        collab_id,
        review_id: oldReview.review_id,
        accept: true,
      }),
      /STALE_REVIEW/,
    );
    await delay(5);
    s.adapters[0].finish();
    await s.engine.wait(followUp.task_id);
    const review = submit();
    writeFileSync(path, "version 2");
    await assert.rejects(
      s.engine.review({ collab_id, review_id: review.review_id, accept: true }),
      /ARTIFACT_CHANGED/,
    );
    const v2 = s.engine.deliver({ collab_id, task_id: followUp.task_id, path });
    assert.throws(
      () => s.engine.reviewArtifact({ collab_id, artifact_id: v1.event_id }),
      /ARTIFACT_VERSION_STALE/,
    );
    assert.equal(s.c.artifact_reviews[v2.event_id], undefined);
    const finalReview = submit();
    assert.equal(
      (
        await s.engine.review({
          collab_id,
          review_id: finalReview.review_id,
          accept: true,
        })
      ).state,
      "done",
    );
  } finally {
    await s.close();
  }
});
test("artifact manifest hashes bytes, rejects out-of-workspace references", async () => {
  const s = setup();
  try {
    const r = s.engine.send({ collab_id: s.c.id, to: "dsh", body: "file" });
    const path = join(s.home, "result.txt");
    writeFileSync(path, "abc");
    const a = s.engine.deliver({
      collab_id: s.c.id,
      task_id: r.task_id,
      path,
      summary: "test",
    });
    assert.equal(
      a.sha256,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.ok(
      existsSync(join(s.home, "collaborations", s.c.id, "manifest.json")),
    );
    assert.throws(
      () =>
        s.engine.deliver({
          collab_id: s.c.id,
          task_id: r.task_id,
          path: fixture,
        }),
      /outside/,
    );
  } finally {
    await s.close();
  }
});
test("bounded queue preserves serialized work beyond queue timeout; stop still cancels it", async () => {
  const s = setup({ maxConcurrent: 1, queueLimit: 1, queueTimeoutMs: 10 });
  try {
    s.engine.send({ collab_id: s.c.id, to: "dsh", body: "one" });
    const q = s.engine.send({ collab_id: s.c.id, to: "dsh", body: "two" });
    assert.throws(
      () => s.engine.send({ collab_id: s.c.id, to: "kimi", body: "three" }),
      /QUEUE_FULL/,
    );
    await delay(20);
    s.engine.monitor();
    assert.equal(s.engine.check(q.task_id).state, "queued");
    assert.equal((await s.engine.stop(s.c.id)).state, "stopped");
  } finally {
    await s.close();
  }
});
test("queue timeout still reports an eligible task that the scheduler never dispatches", async () => {
  const s = setup({ queueTimeoutMs: 10 });
  try {
    s.engine.pump = () => {};
    const q = s.engine.send({ collab_id: s.c.id, to: "kimi", body: "work" });
    s.engine.monitor();
    s.engine.check(q.task_id).queue_ready_since = Date.now() - 20;
    s.engine.monitor();
    assert.equal(s.engine.check(q.task_id).error, "QUEUE_TIMEOUT");
  } finally {
    await s.close();
  }
});

for (const blocker of ["session", "capacity", "ownership"]) {
  test(`queue timeout excludes ${blocker} wait and dispatches after release`, async () => {
    const s = setup({
      queueTimeoutMs: 10,
      maxConcurrent: blocker === "capacity" ? 1 : 4,
    });
    try {
      const collab_id = s.c.id;
      const write_scope = blocker === "ownership" ? [s.home] : [];
      const first = s.engine.send({
        collab_id,
        to: "kimi",
        body: "long task",
        write_scope,
      });
      const next = s.engine.send({
        collab_id,
        to: blocker === "session" ? "kimi" : "dsh",
        body: "follow up",
        write_scope,
      });
      await delay(20);
      s.engine.monitor();
      assert.equal(s.engine.check(next.task_id).state, "queued");
      s.adapters[0].finish();
      await s.engine.wait(first.task_id);
      await delay(5);
      assert.equal(s.engine.check(next.task_id).state, "running");
      assert.equal(s.adapters.length, blocker === "session" ? 1 : 2);
      s.adapters.at(-1).finish();
      assert.equal((await s.engine.wait(next.task_id)).state, "completed");
    } finally {
      await s.close();
    }
  });
}

test("coordinator quota failure preserves worker delivery and does not awaken the exhausted agent", async () => {
  const s = setup();
  try {
    const collab_id = s.c.id;
    const lead = s.engine.send({ collab_id, to: "codex", body: "coordinate" });
    const child = s.engine.send({
      collab_id,
      from: "codex",
      to: "kimi",
      body: "deliver work",
    });
    await delay(5);
    s.adapters[0].reject(new Error("Codex failed: usage_limit_reached"));
    await s.engine.wait(lead.task_id);
    const path = join(s.home, "worker.txt");
    writeFileSync(path, "durable worker result");
    const artifact = s.engine.deliver({
      collab_id,
      task_id: child.task_id,
      path,
    });
    s.adapters[1].finish();
    await s.engine.wait(child.task_id);
    await delay(5);
    assert.equal(s.engine.check(child.task_id).state, "completed");
    assert.equal(s.c.state, "active");
    assert.equal(s.c.epoch, 1);
    assert.equal(s.adapters.length, 2);
    assert.ok(
      s.log.events(0, undefined, 5000).some(
        (e) =>
          e.type === "result.notification_failed" &&
          /usage_limit/.test(e.data.error),
      ),
    );
    assert.equal(
      s.engine.reviewArtifact({ collab_id, artifact_id: artifact.event_id })
        .accepted,
      true,
    );
    assert.throws(
      () => s.engine.complete({ collab_id, summary: "review" }),
      /FAILED_TASKS_NEED_RETRY/,
    );
  } finally {
    await s.close();
  }
});

test("failed result notification is visible without blocking successful work from user review", async () => {
  const s = setup();
  try {
    const collab_id = s.c.id;
    const lead = s.engine.send({ collab_id, to: "codex", body: "coordinate" });
    await delay(5);
    s.adapters[0].finish();
    await s.engine.wait(lead.task_id);
    await delay(5);
    const child = s.engine.send({
      collab_id,
      from: "codex",
      to: "kimi",
      body: "return findings",
    });
    await delay(5);
    s.adapters[1].finish();
    await s.engine.wait(child.task_id);
    await delay(5);
    const notification = Object.values(s.c.tasks).find(
      (t) => t.message_type === "result",
    );
    assert.equal(notification.state, "running");
    assert.throws(
      () => s.engine.complete({ collab_id, summary: "review" }),
      /TASKS_STILL_RUNNING/,
    );
    s.adapters[0].reject(new Error("usage limit reached"));
    await s.engine.wait(notification.id);
    assert.equal(notification.state, "failed");
    assert.ok(
      s.log.events(0, undefined, 5000).some(
        (e) =>
          e.type === "result.notification_failed" &&
          e.task_id === notification.id,
      ),
    );
    const review = s.engine.complete({
      collab_id,
      summary: "review retained findings",
    });
    assert.equal(
      (
        await s.engine.review({
          collab_id,
          review_id: review.review_id,
          accept: true,
        })
      ).state,
      "done",
    );
  } finally {
    await s.close();
  }
});

test("usage budget drains admitted work, preserves manifests and still permits user review", async () => {
  const s = setup({ maxConcurrent: 1 });
  try {
    const collab_id = s.c.id;
    s.c.budget.max_tokens = 10;
    const first = s.engine.send({ collab_id, to: "kimi", body: "first" });
    const next = s.engine.send({
      collab_id,
      to: "dsh",
      body: "already admitted",
    });
    await delay(5);
    s.adapters[0].finish();
    await s.engine.wait(first.task_id);
    await delay(5);
    assert.equal(s.c.budget_exhausted.reason, "usage_budget");
    assert.equal(s.c.epoch, 1);
    assert.equal(s.engine.check(next.task_id).state, "running");
    assert.throws(
      () => s.engine.send({ collab_id, to: "codex", body: "new work" }),
      /BUDGET_EXCEEDED/,
    );
    const path = join(s.home, "after-budget.txt");
    writeFileSync(path, "completed after budget exhausted");
    const artifact = s.engine.deliver({
      collab_id,
      task_id: next.task_id,
      path,
    });
    assert.ok(
      readFileSync(
        join(s.home, "collaborations", collab_id, "manifest.json"),
        "utf8",
      ).includes(artifact.sha256),
    );
    s.adapters[1].finish();
    await s.engine.wait(next.task_id);
    const review = s.engine.complete({ collab_id, summary: "drained work" });
    assert.equal(
      (
        await s.engine.review({
          collab_id,
          review_id: review.review_id,
          accept: true,
        })
      ).state,
      "done",
    );
  } finally {
    await s.close();
  }
});

test("silence is inferred without killing; hard limit retries exact session only once", async () => {
  const s = setup({ quietMs: 5, hardMs: { dsh: 45 } });
  try {
    const r = s.engine.send({ collab_id: s.c.id, to: "dsh", body: "silent" });
    await delay(12);
    s.engine.monitor();
    assert.equal(s.c.participants.dsh.state, "thinking");
    assert.ok(!s.adapters[0].destroyed);
    await delay(40);
    s.engine.monitor();
    await delay(10);
    assert.equal(s.adapters.length, 2);
    assert.equal(s.adapters[1].sessionId, s.adapters[0].sessionId);
    await delay(50);
    s.engine.monitor();
    await delay(10);
    assert.equal(s.engine.check(r.task_id).state, "failed");
    assert.equal(s.adapters.length, 2);
  } finally {
    await s.close();
  }
});
test("directory ownership serializes overlapping writes across agents", async () => {
  const s = setup();
  try {
    s.engine.send({
      collab_id: s.c.id,
      to: "dsh",
      body: "one",
      write_scope: [s.home],
    });
    s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "two",
      write_scope: [s.home],
    });
    await delay(5);
    assert.equal(s.adapters.length, 1);
    s.adapters[0].finish();
    await delay(10);
    assert.equal(s.adapters.length, 2);
    s.adapters[1].finish();
  } finally {
    await s.close();
  }
});
test("round budget freezes admission while preserving epoch and delivery", async () => {
  const s = setup();
  try {
    s.c.budget.max_rounds = 0;
    assert.throws(
      () => s.engine.send({ collab_id: s.c.id, to: "dsh", body: "no" }),
      /BUDGET/,
    );
    assert.equal(s.c.state, "active");
    assert.equal(s.c.epoch, 1);
    assert.equal(s.c.budget_exhausted.reason, "round_or_hop_budget");
  } finally {
    await s.close();
  }
});
test("journal replays sequence, deduplicates ids and recovers torn final append", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-journal-"));
  let j = new Journal(home);
  const c = { id: "c", epoch: 1 };
  j.append("example", c, { x: 1 }, { id: "id" });
  j.append("example", c, { x: 2 }, { id: "id" });
  j.close();
  appendFileSync(join(home, "events.jsonl"), '{"partial":');
  j = new Journal(home);
  assert.equal(j.events(0, undefined, 5000).length, 1);
  j.append("next", c);
  assert.equal(j.events(0, undefined, 5000).at(-1).seq, 2);
  j.close();
});
test("restart never blindly replays effects or spawns agents", async () => {
  const s = setup();
  s.engine.send({ collab_id: s.c.id, to: "dsh", body: "unfinished" });
  await delay(5);
  clearInterval(s.engine.timer);
  s.engine.closed = true;
  s.c.epoch++;
  s.log.close();
  let calls = 0;
  const log = new Journal(s.home);
  const engine = new Engine(log, {
    factory: () => {
      calls++;
      return new Fake();
    },
  });
  assert.equal(calls, 0);
  assert.equal(engine.get(s.c.id).state, "needs_work");
  await engine.destroy();
  log.close();
  await s.adapters[0].destroy();
});
test("ACP adapter validates resume identity before prompt and surfaces tool lifecycle", async () => {
  const spec = { command: process.execPath, args: [fixture], available: true };
  const a = new AcpAdapter("dsh", spec);
  let events = [];
  a.on("event", (e) => events.push(e));
  try {
    await a.start({ cwd: tmpdir() });
    assert.equal((await a.send("probe")).text, "FAKE_RESULT");
    assert.ok(events.some((e) => e.type === "tool"));
    await a.destroy();
    const b = new AcpAdapter("dsh", spec);
    try {
      await b.start({ cwd: tmpdir(), sessionId: "fake-session-001" });
      assert.equal(b.sessionId, "fake-session-001");
    } finally {
      await b.destroy();
    }
  } finally {
    await a.destroy();
  }
});
test("Codex resume silent-new-session is rejected", async () => {
  const a = new CodexAdapter({
    command: process.execPath,
    args: [fixture],
    available: true,
  });
  try {
    await assert.rejects(
      a.start({
        cwd: tmpdir(),
        sessionId: "expected",
        env: { FAKE_MODE: "mismatch" },
      }),
      /RESUME_ID_MISMATCH/,
    );
  } finally {
    await a.destroy();
  }
});
test("real CLI process abnormal exit and frozen output are reclaimable offline", async () => {
  for (const mode of ["exit", "freeze", "approval_block"]) {
    const a = new AcpAdapter("dsh", {
      command: process.execPath,
      args: [fixture],
      available: true,
    });
    try {
      await a.start({ cwd: tmpdir(), env: { FAKE_MODE: mode } });
      const p = a.send("probe");
      p.catch(() => {});
      if (mode !== "exit") {
        await delay(50);
        await a.interrupt();
      }
      await assert.rejects(p, /exited|closed|CLI/);
    } finally {
      await a.destroy();
    }
  }
});
test("Windows Job Object removes detached descendants when adapter is killed", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-tree-"));
  const pidFile = join(home, "pid");
  const child = launch({ command: process.execPath, args: [fixture] }, [], {
    env: { FAKE_MODE: "tree", FAKE_PID_FILE: pidFile },
  });
  try {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(10);
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    process.kill(pid, 0);
    await killTree(child);
    await delay(80);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    await killTree(child);
  }
});
test("bridge owner crash closes the CLI job and leaves no detached descendants", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-crash-"));
  const pidFile = join(home, "pid");
  const parent = spawn(
    process.execPath,
    [resolve("tests/fixtures/fake-parent.mjs")],
    {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, FAKE_PID_FILE: pidFile },
    },
  );
  try {
    for (let i = 0; i < 150 && !existsSync(pidFile); i++) await delay(10);
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    parent.kill();
    await once(parent, "close");
    await delay(200);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    parent.kill();
  }
});
test("local API uses auth and controls independently of full task queue; cursor replay works", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-api-"));
  const adapters = [];
  const d = await startDaemon({
    home,
    engineOptions: {
      factory: () => {
        const a = new Fake();
        adapters.push(a);
        return a;
      },
      maxConcurrent: 1,
      queueLimit: 1,
    },
  });
  const ep = d.descriptor;
  const rpc = async (method, params = {}) => {
    const r = await fetch(ep.url + "/rpc", {
      method: "POST",
      headers: { Authorization: `Bearer ${ep.token}` },
      body: JSON.stringify({ method, params }),
    });
    return r.json();
  };
  try {
    assert.equal(
      (await fetch(ep.url + "/rpc", { method: "POST", body: "{}" })).status,
      403,
    );
    const c = (await rpc("create", { cwd: home, goal: "API stop" })).result;
    await rpc("send", { collab_id: c.id, to: "dsh", body: "run" });
    await rpc("send", { collab_id: c.id, to: "kimi", body: "queue" });
    assert.match((await rpc("shutdown")).error, /SHUTDOWN_MODE_REQUIRED/);
    assert.equal(d.engine.get(c.id).state, "active");
    assert.match(
      (await rpc("shutdown", { preserve: true })).error,
      /BRIDGE_HAS_ACTIVE_TASKS/,
    );
    assert.equal(d.engine.closed, false);
    const start = performance.now();
    assert.equal(
      (await rpc("stop", { collab_id: c.id })).result.state,
      "stopped",
    );
    assert.ok(performance.now() - start < 500);
    const first = (await rpc("events", { after: 0, limit: 2 })).result;
    const later = (await rpc("events", { after: first.at(-1).seq })).result;
    assert.ok(later[0].seq > first.at(-1).seq);
  } finally {
    await d.close();
  }
});
