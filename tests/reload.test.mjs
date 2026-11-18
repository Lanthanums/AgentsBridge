import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { Engine } from "../src/bridge/engine.mjs";
import { Journal } from "../src/bridge/journal.mjs";

test("source and packaged bridge fingerprints match regardless of directory ordering", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-version-"));
  for (const dir of ["src/bridge", "dist/bridge"]) {
    mkdirSync(join(root, dir), { recursive: true });
    cpSync(resolve("src/bridge"), join(root, dir), { recursive: true });
  }
  mkdirSync(join(root, "native"), { recursive: true });
  mkdirSync(join(root, "dist/native"), { recursive: true });
  writeFileSync(
    join(root, "native/process-tree.mjs"),
    "export const test = 1;",
  );
  writeFileSync(join(root, "dist/native/current.json"), '{"test":1}');
  const a = await import(pathToFileURL(join(root, "src/bridge/version.mjs")));
  const b = await import(pathToFileURL(join(root, "dist/bridge/version.mjs")));
  assert.equal(a.sourceVersion(), b.sourceVersion());
});

test("idle reload preserves collaboration epoch and resume identity; admission freezes atomically", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-reload-"));
  const journal = new Journal(home);
  class Fake extends EventEmitter {
    async start({ sessionId }) {
      this.sessionId = sessionId || "persistent-session";
      this.emit("event", {
        type: "session",
        data: { session_id: this.sessionId },
      });
      return this.sessionId;
    }
    async send() {
      return { text: "ok", session_id: this.sessionId, usage: { tokens: 1 } };
    }
    async destroy() {
      this.destroyed = true;
    }
  }
  const engine = new Engine(journal, { factory: () => new Fake() });
  const c = engine.create({
    cwd: home,
    goal: "Preserve live collaboration across code reload",
  });
  const task = engine.send({ collab_id: c.id, to: "dsh", body: "one" });
  assert.throws(() => engine.prepareShutdown(true), /BRIDGE_HAS_ACTIVE_TASKS/);
  assert.equal(engine.closed, false);
  while (["queued", "running"].includes(engine.check(task.task_id).state))
    await engine.wait(task.task_id, 100);
  const before = c.participants.dsh.session_id;
  engine.prepareShutdown(true);
  assert.throws(
    () => engine.send({ collab_id: c.id, to: "dsh", body: "race" }),
    /BRIDGE_RELOADING/,
  );
  await engine.destroy({ preserve: true });
  journal.close();
  const restoredLog = new Journal(home);
  const restored = new Engine(restoredLog, { factory: () => new Fake() });
  try {
    const actual = restored.get(c.id);
    assert.equal(actual.state, "active");
    assert.equal(actual.epoch, c.epoch);
    assert.equal(actual.participants.dsh.session_id, before);
    const next = restored.send({ collab_id: c.id, to: "dsh", body: "two" });
    while (["queued", "running"].includes(restored.check(next.task_id).state))
      await restored.wait(next.task_id, 100);
    assert.equal(actual.participants.dsh.session_id, before);
    assert.ok(
      !restoredLog.events(0, undefined, 5000).some((e) => e.type === "collaboration.stopped"),
    );
  } finally {
    await restored.destroy();
    restoredLog.close();
  }
});
