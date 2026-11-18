import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/bridge/journal.mjs";
import { Engine } from "../src/bridge/engine.mjs";
import { launch, killTree } from "../src/bridge/process.mjs";
import { JsonlAdapter } from "../src/bridge/adapters/base.mjs";
import { startDaemon } from "../src/bridge/daemon.mjs";

const tick = () => new Promise((r) => setImmediate(r));
class Controlled extends EventEmitter {
  async start({ sessionId }) {
    this.sessionId = sessionId || "verified-session";
    this.emit("event", {
      type: "session",
      data: { session_id: this.sessionId },
    });
  }
  async send() {
    return new Promise((resolve, reject) => {
      this.finish = (usage = { tokens: 1 }) => resolve({ text: "ok", usage });
      this.reject = reject;
    });
  }
  async destroy() {
    this.reject?.(new Error("closed"));
  }
  async interrupt() {
    this.interrupts = (this.interrupts || 0) + 1;
    await this.destroy();
  }
}
function setup(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "ab-extreme-"));
  const journal = new Journal(home),
    adapters = [];
  const engine = new Engine(journal, {
    ui: async () => {},
    factory: () => {
      const a = new Controlled();
      adapters.push(a);
      return a;
    },
    ...options,
  });
  const c = engine.create({ cwd: home, goal: "Bounded fault injection" });
  return {
    home,
    journal,
    adapters,
    engine,
    c,
    async close() {
      await engine.destroy();
      journal.close();
    },
  };
}

test("a fresh task after a failed hard-limit recovery still has a working hard deadline", async () => {
  const s = setup({ hardMs: { kimi: 10 } });
  try {
    const first = s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "first",
    });
    await tick();
    let slot = s.engine.adapters.get(`${s.c.id}:kimi`);
    slot.started = Date.now() - 100;
    s.engine.monitor();
    await tick();
    slot.started = Date.now() - 100;
    s.engine.monitor();
    await tick();
    assert.equal(s.engine.check(first.task_id).state, "failed");
    assert.match(s.engine.check(first.task_id).error, /^HARD_LIMIT_EXCEEDED/);
    s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "fresh explicit request",
    });
    await tick();
    slot.started = Date.now() - 100;
    s.engine.monitor();
    await tick();
    assert.equal(s.adapters[2].interrupts, 1);
    assert.equal(s.adapters.length, 4);
  } finally {
    await s.close();
  }
});

test("unknown usage on a later turn never reuses the previous turn's tokens", async () => {
  const s = setup();
  try {
    const first = s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "first",
    });
    await tick();
    s.adapters[0].emit("event", { type: "usage", data: { tokens: 123 } });
    s.adapters[0].finish({ tokens: null });
    await s.engine.wait(first.task_id);
    await tick();
    const second = s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "second",
    });
    await tick();
    s.adapters[0].finish({ tokens: null });
    await s.engine.wait(second.task_id);
    const usages = s.journal.events(0, undefined, 5000).filter((e) => e.type === "usage.recorded");
    assert.equal(usages[0].data.tokens, 123);
    assert.equal(usages[1].data.tokens, null);
    assert.equal(s.c.usage.tokens, 123);
  } finally {
    await s.close();
  }
});

test("hard-limit recovery waits for the prior interrupt to settle before resuming the session", async () => {
  const s = setup({ hardMs: { kimi: 10 } });
  let release;
  try {
    s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "race with interrupt",
    });
    await tick();
    s.adapters[0].interrupt = () =>
      new Promise((resolve) => {
        release = resolve;
        s.adapters[0].reject(
          new Error("turn closed while termination pending"),
        );
      });
    const slot = s.engine.adapters.get(`${s.c.id}:kimi`);
    slot.started = Date.now() - 100;
    s.engine.monitor();
    await tick();
    assert.equal(s.adapters.length, 1);
    release();
    await tick();
    assert.equal(s.adapters.length, 2);
  } finally {
    release?.();
    await s.close();
  }
});

test("journal can append after a valid unterminated last record including UTF-8 text", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-journal-end-"));
  let j = new Journal(home);
  j.append("one", null, { text: "完整记录" });
  j.close();
  const file = join(home, "events.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").trimEnd());
  j = new Journal(home);
  j.append("two", null);
  j.close();
  j = new Journal(home);
  assert.equal(j.events(0, undefined, 5000).length, 2);
  j.close();
});

test("journal torn-tail recovery preserves blank-line byte offsets", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-journal-blank-"));
  let j = new Journal(home);
  j.append("one", null, { text: "中文" });
  j.close();
  const file = join(home, "events.jsonl");
  writeFileSync(file, "\n" + readFileSync(file, "utf8"));
  appendFileSync(file, '{"torn":');
  j = new Journal(home);
  j.append("two", null);
  j.close();
  j = new Journal(home);
  assert.equal(j.events(0, undefined, 5000).length, 2);
  j.close();
});

test("CLI output rejects oversized complete lines as well as unterminated ones", async () => {
  let acceptedBytes = 0,
    protocolError;
  const child = launch(
    { command: process.execPath, available: true },
    [
      "-e",
      "process.stdout.write('x'.repeat(8*1024*1024+1)+'\\n');setTimeout(()=>{},2000)",
    ],
    {
      cwd: tmpdir(),
      onLine: (line) => (acceptedBytes += Buffer.byteLength(line)),
    },
  );
  child.on("protocolError", (e) => {
    protocolError = e;
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    assert.equal(acceptedBytes, 0);
    assert.match(protocolError?.message || "", /exceeds/);
  } finally {
    await killTree(child);
  }
});

test("failure to write a stop handoff cannot prevent process termination", async () => {
  const s = setup();
  try {
    s.engine.send({ collab_id: s.c.id, to: "kimi", body: "working" });
    await tick();
    s.journal.writeJson = () => {
      throw new Error("ENOSPC injected handoff write failure");
    };
    const result = await s.engine.stop(s.c.id);
    await tick();
    assert.equal(s.adapters[0].interrupts, 1);
    assert.equal(s.c.processes.verified, true);
    assert.match(result.handoff_error, /ENOSPC/);
    assert.equal(s.c.state, "stopped");
  } finally {
    await s.close();
  }
});

test("unconfirmed process cleanup retains session, capacity and write ownership until stop succeeds", async () => {
  const s = setup({ maxConcurrent: 1 });
  let blocked = true;
  try {
    const first = s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "failure",
      write_scope: [s.home],
    });
    await tick();
    const adapter = s.adapters[0];
    adapter.destroy = async () => {
      if (blocked) throw new Error("PROCESS_TREE_TERMINATION_UNCONFIRMED");
    };
    adapter.interrupt = async () => adapter.destroy();
    adapter.reject(new Error("original CLI failure"));
    await s.engine.wait(first.task_id);
    await tick();
    assert.match(s.engine.check(first.task_id).error, /original CLI failure/);
    const other = s.engine.create({ cwd: s.home, goal: "other collaboration" });
    const next = s.engine.send({
      collab_id: other.id,
      to: "dsh",
      body: "must wait",
    });
    assert.equal(s.engine.check(next.task_id).state, "queued");
    assert.equal(s.engine.locks.get(s.home), first.task_id);
    assert.throws(() => s.engine.prepareShutdown(true), /ACTIVE|CLEANUP/);
    blocked = false;
    await s.engine.stop(s.c.id);
    await tick();
    assert.equal(s.engine.check(next.task_id).state, "running");
    assert.equal(s.engine.locks.size, 0);
    s.adapters[1].finish();
    await s.engine.wait(next.task_id);
  } finally {
    blocked = false;
    await s.close();
  }
});

test("a complete record with a bad sequence is rejected without truncating evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-sequence-"));
  const file = join(home, "events.jsonl"),
    body = JSON.stringify({ seq: 9, id: "corrupt" });
  writeFileSync(file, body);
  assert.throws(() => new Journal(home), /sequence gap/);
  assert.equal(readFileSync(file, "utf8"), body);
});

test("short filesystem writes still produce complete durable journal records", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-short-write-"));
  let j = new Journal(home, {
    write: (fd, bytes, offset, length) =>
      writeSync(fd, bytes, offset, Math.min(length, 7)),
  });
  j.append("one", null, { text: "逐字节写入也应完整" });
  j.append("two", null);
  j.close();
  j = new Journal(home);
  assert.equal(j.events(0, undefined, 5000).length, 2);
  j.close();
});

test("partial write failure poisons further appends until torn-tail recovery", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-partial-write-"));
  let writes = 0;
  let j = new Journal(home, {
    write: (fd, bytes, offset, length) => {
      writes++;
      if (writes === 2) return writeSync(fd, bytes, offset, 11);
      if (writes >= 3) throw new Error("ENOSPC after partial write");
      return writeSync(fd, bytes, offset, length);
    },
  });
  j.append("one", null);
  assert.throws(() => j.append("two", null), /ENOSPC/);
  assert.equal(j.events(0, undefined, 5000).length, 1);
  assert.throws(() => j.append("three", null), /JOURNAL_UNAVAILABLE/);
  j.close();
  j = new Journal(home);
  j.append("recovered", null);
  assert.equal(j.events(0, undefined, 5000).length, 2);
  j.close();
  j = new Journal(home);
  assert.equal(j.events(0, undefined, 5000)[1].type, "recovered");
  j.close();
});

test("stop still terminates workers when the event journal becomes unwritable", async () => {
  const s = setup();
  const append = s.journal.append.bind(s.journal);
  try {
    const task = s.engine.send({
      collab_id: s.c.id,
      to: "kimi",
      body: "stop on disk failure",
    });
    await tick();
    s.journal.append = () => {
      throw new Error("ENOSPC injected event write failure");
    };
    const result = await s.engine.stop(s.c.id);
    await tick();
    assert.match(result.persistence_error, /ENOSPC/);
    assert.equal(s.adapters[0].interrupts, 1);
    assert.equal(s.engine.check(task.task_id).state, "cancelled");
    assert.equal(s.c.processes.verified, true);
    assert.match(s.c.processes.persistence_error, /ENOSPC/);
  } finally {
    s.journal.append = append;
    await s.close();
  }
});

test("rejected hard-limit interrupt is observed and explicit stop can retry cleanup", async () => {
  const s = setup({ hardMs: { kimi: 10 } });
  try {
    s.engine.send({ collab_id: s.c.id, to: "kimi", body: "interrupt failure" });
    await tick();
    const adapter = s.adapters[0];
    adapter.interrupt = async () => {
      throw new Error("permission denied during termination");
    };
    const slot = s.engine.adapters.get(`${s.c.id}:kimi`);
    slot.started = Date.now() - 100;
    s.engine.monitor();
    await tick();
    assert.ok(
      s.journal.events(0, undefined, 5000).some((e) => e.type === "process.cleanup_failed"),
    );
    await s.engine.stop(s.c.id);
    await tick();
    assert.equal(s.c.processes.verified, false);
    adapter.interrupt = async () => adapter.destroy();
    const epoch = s.c.epoch;
    await s.engine.stop(s.c.id);
    await tick();
    assert.equal(s.c.processes.verified, true);
    assert.equal(s.c.epoch, epoch);
  } finally {
    await s.close();
  }
});

test("local stop API reports persistence failure after actually stopping the worker", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-stop-api-"));
  const d = await startDaemon({
    home,
    engineOptions: { factory: () => new Controlled(), ui: async () => {} },
  });
  const append = d.journal.append.bind(d.journal);
  try {
    const c = d.engine.create({
      cwd: home,
      goal: "API stop failure visibility",
    });
    const task = d.engine.send({ collab_id: c.id, to: "kimi", body: "work" });
    await tick();
    d.journal.append = () => {
      throw new Error("ENOSPC injected");
    };
    const response = await fetch(d.descriptor.url + "/rpc", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${d.descriptor.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "stop", params: { collab_id: c.id } }),
    });
    assert.equal(response.status, 400);
    assert.match(
      (await response.json()).error,
      /STOP_APPLIED_BUT_NOT_PERSISTED/,
    );
    assert.equal(d.engine.check(task.task_id).state, "cancelled");
    await tick();
    assert.equal(c.processes.verified, true);
  } finally {
    d.journal.append = append;
    await d.close();
  }
});

test("oversized UTF-8 output is limited by bytes and JSONL adapters cannot report success after protocol failure", async () => {
  class Oversized extends JsonlAdapter {
    args() {
      return ["-e", "process.stdout.write('界'.repeat(3*1024*1024)+'\\n')"];
    }
    parse() {
      return [{ type: "session", data: { session_id: "oversized" } }];
    }
  }
  const adapter = new Oversized("cursor", {
    command: process.execPath,
    available: true,
  });
  try {
    await adapter.start({ cwd: tmpdir() });
    await assert.rejects(adapter.send("bounded output"), /exceeds 8 MiB/);
  } finally {
    await adapter.destroy();
  }
});

test("stress: saturated queues, callbacks, quota errors, budget draining and stops preserve invariants", async (t) => {
  const s = setup({ maxConcurrent: 3, queueLimit: 12 });
  const cs = [s.c];
  const agents = ["codex", "dsh", "kimi", "cursor"];
  let rejected = 0;
  try {
    for (let i = 0; i < 5; i++)
      cs.push(
        s.engine.create({
          cwd: s.home,
          goal: `isolated stress collaboration ${i}`,
        }),
      );
    for (const c of cs) {
      c.budget.max_rounds = 32;
      for (const agent of agents) {
        s.engine.join(c, agent);
        s.engine.record(
          c,
          "session.bound",
          { session_id: `stress-${c.id}-${agent}` },
          { agent },
        );
      }
    }
    cs[2].budget.max_tokens = 4;
    for (let i = 0; i < 240; i++) {
      const c = cs[i % cs.length],
        to = agents[Math.floor(i / cs.length) % agents.length];
      try {
        s.engine.send({
          collab_id: c.id,
          from: i % 3 ? "user" : agents[(agents.indexOf(to) + 1) % 4],
          to,
          body: `bounded stress task ${i}`,
          write_scope: i % 4 === 0 ? [s.home] : [],
        });
      } catch (error) {
        assert.match(
          error.message,
          /QUEUE_FULL|BUDGET_EXCEEDED|COLLABORATION_BARRIER/,
        );
        rejected++;
      }
      if (i === 60 || i === 130) await s.engine.stop(cs[i === 60 ? 0 : 4].id);
      if (i % 3 === 0) {
        const slot = [...s.engine.adapters.values()].find(
          (x) => x.running && x.adapter?.finish,
        );
        if (slot) {
          if (i % 27 === 0)
            slot.adapter.reject(new Error("usage_limit_reached"));
          else slot.adapter.finish();
        }
      }
      await tick();
      assert.ok(s.engine.occupiedSlots() <= 3);
      assert.ok(s.engine.queue.length <= 15);
      assert.equal(
        [...s.engine.adapters.values()].filter((x) => x.running).length,
        s.engine.running,
      );
      for (const id of s.engine.queue)
        assert.equal(s.engine.check(id).state, "queued");
      for (const [scope, owner] of s.engine.locks) {
        assert.equal(scope, s.home);
        assert.equal(s.engine.check(owner).state, "running");
      }
    }
    for (
      let cycle = 0;
      cycle < 300 && (s.engine.running || s.engine.queue.length);
      cycle++
    ) {
      for (const slot of s.engine.adapters.values())
        if (slot.running) slot.adapter.finish();
      await tick();
    }
    assert.equal(s.engine.running, 0);
    assert.equal(s.engine.queue.length, 0);
    assert.equal(s.engine.locks.size, 0);
    for (const c of cs.filter((c) => c.state === "stopped")) {
      const barrier = s.journal.events(0, undefined, 5000).find(
        (e) => e.collab_id === c.id && e.type === "collaboration.stopped",
      ).seq;
      assert.ok(
        !s.journal.events(0, undefined, 5000).some(
          (e) =>
            e.collab_id === c.id &&
            e.seq > barrier &&
            ["task.running", "task.completed", "output.batch"].includes(e.type),
        ),
      );
    }
    assert.ok(rejected > 0);
    const notifications = [...s.engine.tasks.values()].filter(
      (t) => t.message_type === "result",
    ).length;
    assert.ok(notifications > 0);
    t.diagnostic(
      JSON.stringify({
        attempted: 240,
        admitted: s.engine.tasks.size,
        rejected,
        notifications,
        states: Object.fromEntries(
          ["completed", "failed", "cancelled"].map((state) => [
            state,
            [...s.engine.tasks.values()].filter((x) => x.state === state)
              .length,
          ]),
        ),
      }),
    );
  } finally {
    await s.close();
  }
});
