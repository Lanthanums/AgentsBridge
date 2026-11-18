import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "../src/bridge/journal.mjs";
import { Engine } from "../src/bridge/engine.mjs";
import { startDaemon } from "../src/bridge/daemon.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
class Stub extends EventEmitter {
  async start() {
    this.emit("event", {
      type: "session",
      data: { session_id: "session-test" },
    });
  }
  async send() {
    return new Promise((resolve, reject) => {
      this.finish = () => resolve({ text: "verified", usage: { tokens: 1 } });
      this.reject = reject;
    });
  }
  async destroy() {
    this.reject?.(new Error("closed"));
  }
  async interrupt() {
    await this.destroy();
  }
}
test("designated reviewer acceptance settles after its own turn; workers cannot approve themselves", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-review-"));
  const log = new Journal(home),
    adapters = [];
  const e = new Engine(log, {
    factory: () => {
      const a = new Stub();
      adapters.push(a);
      return a;
    },
  });
  try {
    const c = e.create({
      cwd: home,
      goal: "Review real facts",
      reviewer: "kimi",
    });
    const t = e.send({ collab_id: c.id, to: "dsh", body: "work" });
    await delay(5);
    adapters[0].finish();
    await e.wait(t.task_id);
    e.complete({ collab_id: c.id, summary: "submit" });
    await delay(5);
    assert.equal(adapters.length, 2);
    await assert.rejects(
      e.review({ collab_id: c.id, reviewer: "dsh", accept: true }),
      /REVIEWER_MISMATCH/,
    );
    const r = await e.review({
      collab_id: c.id,
      reviewer: "kimi",
      accept: true,
    });
    assert.equal(r.settling, true);
    assert.equal(c.state, "awaiting_review");
    adapters[1].finish();
    await delay(30);
    assert.equal(c.state, "done");
    assert.ok(c.handoff);
    assert.equal(
      Object.values(c.tasks).every((t) => t.state === "completed"),
      true,
    );
  } finally {
    await e.destroy();
    log.close();
  }
});
test("scoped capabilities cannot call user control and are invalid immediately after stop", async () => {
  process.env.AGENTSBRIDGE_NO_UI = "1";
  const home = mkdtempSync(join(tmpdir(), "ab-scope-"));
  const d = await startDaemon({
    home,
    engineOptions: { factory: () => new Stub(), ui: async () => {} },
  });
  try {
    const c = d.engine.create({ cwd: home, goal: "Scope barrier", coordinator: "codex" });
    const servers = d.engine.mcpServers(c, {
      to: "dsh",
      hop: 0,
      epoch: c.epoch,
    });
    const env = Object.fromEntries(
      servers[0].env.map((x) => [x.name, x.value]),
    );
    const request = async (method, params = {}) => {
      const r = await fetch(d.descriptor.url + "/rpc", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.AGENTSBRIDGE_TOKEN}` },
        body: JSON.stringify({ method, params }),
      });
      return { status: r.status, ...(r.status === 403 ? {} : await r.json()) };
    };
    assert.match((await request("stop")).error, /CONTROL_REQUIRES_USER_TOKEN/);
    assert.equal((await request("planBudget")).result.collab_id, c.id);
    assert.match(
      (await request("planBudget", { actor: "user", profile: "complex", reason: "Attempt to bypass" })).error,
      /BUDGET_UPDATE_REQUIRES_COORDINATOR/,
    );
    await d.engine.stop(c.id);
    assert.equal(
      (await request("send", { to: "kimi", body: "late" })).status,
      403,
    );
    assert.equal(d.engine.queue.length, 0);
    assert.equal((await request("planBudget", { profile: "complex", reason: "Late write" })).status, 403);
  } finally {
    await d.close();
  }
});
test("handoff tampering cannot become new collaboration context", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-hash-"));
  const j = new Journal(home),
    e = new Engine(j);
  try {
    const c = e.create({ cwd: home, goal: "source" });
    await e.stop(c.id);
    writeFileSync(c.handoff.path, "{}");
    assert.throws(
      () => e.create({ cwd: home, goal: "next", upstream: c.id }),
      /HANDOFF_HASH_MISMATCH/,
    );
  } finally {
    await e.destroy();
    j.close();
  }
});
test("NDJSON disconnect replay resumes strictly after cursor without lost events", async () => {
  process.env.AGENTSBRIDGE_NO_UI = "1";
  const home = mkdtempSync(join(tmpdir(), "ab-stream-"));
  const d = await startDaemon({ home, engineOptions: { ui: async () => {} } });
  try {
    const c = d.engine.create({ cwd: home, goal: "stream" });
    const read = async (after) => {
      const controller = new AbortController();
      const r = await fetch(d.descriptor.url + `/events?after=${after}`, {
        headers: { Authorization: `Bearer ${d.descriptor.token}` },
        signal: controller.signal,
      });
      const reader = r.body.getReader();
      const first = await reader.read();
      const events = new TextDecoder()
        .decode(first.value)
        .trim()
        .split("\n")
        .map(JSON.parse);
      controller.abort();
      return events;
    };
    const initial = await read(0);
    const cursor = initial.at(-1).seq;
    d.engine.record(c, "decision.recorded", { text: "after disconnect" });
    const replay = await read(cursor);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].seq, cursor + 1);
    assert.equal(replay[0].data.text, "after disconnect");
  } finally {
    await d.close();
  }
});
