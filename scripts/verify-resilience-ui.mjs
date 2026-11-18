import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "../src/bridge/discover.mjs";

const installed = process.argv.includes("--installed");
const home = mkdtempSync(join(tmpdir(), "ab-resilience-ui-"));
const output = join(
  projectRoot,
  "outputs",
  installed ? "resilience-ui-installed" : "resilience-ui",
);
mkdirSync(output, { recursive: true });
const records = [];
function event(type, data, task_id = null, agent = null) {
  records.push({
    schema_version: 2,
    seq: records.length + 1,
    id: `resilience-${records.length + 1}`,
    time: new Date().toISOString(),
    project_id: "qa",
    collab_id: "resilience",
    epoch: 1,
    task_id,
    agent,
    type,
    data,
  });
}
event("collaboration.started", {
  title: "限额与交付验证",
  goal: "保留结果并允许用户验收",
  reviewer: "user",
  cwd: projectRoot,
});
for (const agent of ["codex", "kimi"]) event("participant.joined", { agent });
for (const agent of ["codex", "kimi"]) {
  event(
    "task.queued",
    { to: agent, from: "user", message_type: "request" },
    agent,
  );
  event("task.completed", { summary: "工作结果已记录" }, agent, agent);
}
event(
  "task.queued",
  { to: "codex", from: "kimi", message_type: "result", reply_to: "kimi" },
  "notification",
);
event("task.failed", { error: "usage_limit_reached" }, "notification", "codex");
event(
  "result.notification_failed",
  { error: "usage_limit_reached", reply_to: "kimi", to: "codex" },
  "notification",
  "codex",
);
event("budget.exhausted", { reason: "usage_budget" });
const fixture = join(home, "events.jsonl");
writeFileSync(fixture, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
const env = { ...process.env, AGENTSBRIDGE_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: installed
    ? join(process.env.LOCALAPPDATA, "Programs/AgentsBridge/AgentsBridge.exe")
    : undefined,
  args: [...(installed ? [] : [projectRoot]), "--replay", fixture, "--qa"],
  env,
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "AgentsBridge" }).waitFor();
  await page.evaluate(() => localStorage.setItem("ab.ghost", "on"));
  await page.reload();
  await page.getByRole("heading", { name: "AgentsBridge" }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("region", { name: "显示设置" }).waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: "幽灵模式" }).count(),
    0,
  );
  assert.equal(await page.getByText("思考较久阈值（秒）").count(), 1);
  await page.screenshot({ path: join(output, "settings.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.bridge.request("replayNext", { count: 100 }),
  );
  await page.getByText(/本轮预算已耗尽/).waitFor();
  await page
    .getByText(/结果已记录，回投未送达（usage_limit_reached）/)
    .waitFor();
  await page.getByRole("button", { name: "提交整轮验收" }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].blur(),
  );
  await page.mouse.move(1, 1);
  assert.equal(await page.locator("[data-ghost]").count(), 0);
  assert.equal(
    await page.locator(".note").evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, "budget-and-review.png") });
  const report = {
    ok: true,
    installed,
    checks: [
      "ghost setting removed",
      "legacy ghost preference ignored after reload and blur",
      "remaining settings usable",
      "budget warning visible",
      "failed result notification permits user review",
      "no renderer errors",
    ],
  };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
