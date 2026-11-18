import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon } from "../src/bridge/daemon.mjs";
import { AcpAdapter } from "../src/bridge/adapters/base.mjs";
process.env.AGENTSBRIDGE_NO_UI = "1";
test("a real MCP child with SDK-filtered env is process-bound and cannot become an unmanaged owner", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-bind-e2e-")),
    result = join(home, "binding.json");
  const d = await startDaemon({
    home,
    engineOptions: {
      ui: async () => {},
      factory: () => {
        const a = new AcpAdapter("dsh", {
          command: process.execPath,
          args: [resolve("tests/fixtures/fake-cli.mjs")],
          available: true,
        });
        const original = a.start.bind(a);
        a.start = (options) =>
          original({
            ...options,
            env: {
              ...options.env,
              FAKE_MODE: "mcp_bind",
              FAKE_BIND_HOME: home,
              FAKE_BIND_RESULT: result,
              FAKE_BRIDGE_SCRIPT: resolve("src/bridge/mcp.mjs"),
            },
          });
        return a;
      },
    },
  });
  try {
    const c = d.engine.create({
      cwd: home,
      goal: "SDK env filtering scope test",
    });
    const task = d.engine.send({ collab_id: c.id, to: "dsh", body: "bind" });
    let status;
    for (let i = 0; i < 10; i++) {
      status = await d.engine.wait(task.task_id, 4000);
      if (["completed", "failed"].includes(status.state)) break;
    }
    assert.equal(status.state, "completed", status.error);
    const b = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(b.mesh.binding, "process");
    assert.equal(b.mesh.collab_id, c.id);
    assert.equal(b.mesh.epoch, 1);
    assert.equal(b.create_exposed, false);
    assert.equal(b.routing_exposed, true);
    assert.equal(b.budget.collab_id, c.id);
    assert.equal(b.budget.budget.max_rounds, 49);
    assert.equal(b.budget.request_rounds, 1);
    assert.ok(
      d.journal.events(0, undefined, 5000).some(
        (e) =>
          e.type === "agent.progress" &&
          e.collab_id === c.id &&
          e.agent === "dsh" &&
          e.data.text === "FILTERED_ENV_BOUND",
      ),
    );
  } finally {
    await d.close();
  }
});
