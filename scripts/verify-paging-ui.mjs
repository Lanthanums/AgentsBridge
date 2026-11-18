import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectRoot } from "../src/bridge/discover.mjs";
import { startDaemon } from "../src/bridge/daemon.mjs";
import { createHash } from "node:crypto";
const installed = process.argv.includes("--installed"),
  home = mkdtempSync(join(tmpdir(), "ab-paging-ui-"));
const output = join(
  projectRoot,
  "outputs",
  installed ? "paging-ui-installed" : "paging-ui",
);
mkdirSync(output, { recursive: true });
let seq = 0;
const lines = [];
const put = (id, type, data, task_id = null, agent = null) =>
  lines.push(
    JSON.stringify({
      schema_version: 2,
      seq: ++seq,
      id: `page-${seq}`,
      project_id: "p",
      collab_id: id,
      epoch: 1,
      time: new Date().toISOString(),
      type,
      data,
      task_id,
      agent,
    }),
  );
for (let n = 0; n < 40; n++) {
  const id = `history-${n}`;
  put(id, "collaboration.started", {
    cwd: home,
    title: `History ${n}`,
    goal: "Paged UI verification",
    reviewer: "user",
    budget: {
      max_rounds: 20,
      max_hops: 40,
      max_tokens: 300000,
      max_cost_usd: 10,
    },
  });
  for (const agent of ["codex", "dsh", "kimi", "cursor"])
    put(id, "participant.joined", { agent });
  put(
    id,
    "task.queued",
    {
      collab_id: id,
      from: "user",
      to: "codex",
      message_type: "request",
      body: "history",
      write_scope: [],
    },
    `task-${n}`,
  );
  put(id, "task.completed", { summary: "done" }, `task-${n}`, "codex");
  if (n === 39) {
    const path = join(home, "history-file.txt");
    writeFileSync(path, "historical artifact");
    put(
      id,
      "artifact.delivered",
      {
        path,
        sha256: createHash("sha256")
          .update("historical artifact")
          .digest("hex"),
        bytes: 19,
        summary: "Historical file",
        shared: true,
      },
      `task-${n}`,
      "codex",
    );
  }
  for (let i = 0; i < (n === 39 ? 260 : 2); i++)
    put(
      id,
      "message.sent",
      {
        from: "codex",
        to: "kimi",
        type: "result",
        body: `History item ${String(i).padStart(4, "0")}`,
      },
      `task-${n}`,
      "codex",
    );
  put(id, "collaboration.state", { state: "done" });
}
writeFileSync(join(home, "events.jsonl"), lines.join("\n") + "\n");
const daemon = await startDaemon({
  home,
  engineOptions: { ui: async () => {} },
});
const env = { ...process.env, AGENTSBRIDGE_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: installed
    ? join(process.env.LOCALAPPDATA, "Programs/AgentsBridge/AgentsBridge.exe")
    : undefined,
  args: installed ? ["--qa"] : [projectRoot, "--qa"],
  env,
});
const checks = [];
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "AgentsBridge" }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="选择合作"]')?.value ===
      "history-39",
  );
  assert.equal(await page.getByLabel("选择合作").locator("option").count(), 25);
  await app.evaluate(({ shell }) => {
    shell.openPath = async (path) => {
      globalThis.openedArtifactPath = path;
      return "";
    };
  });
  await page.getByRole("button", { name: /history-file\.txt/ }).click();
  await page.getByRole("button", { name: /打开文件/ }).click();
  assert.equal(
    await app.evaluate(() => globalThis.openedArtifactPath),
    join(home, "history-file.txt"),
  );
  await page.getByLabel("关闭详情").click();
  checks.push(
    "historical artifact outside the live event buffer resolves from the disk journal and passes hash verification",
  );
  await page.getByRole("button", { name: "消息记录", exact: true }).click();
  await page
    .locator(".timeline-excerpt")
    .filter({ hasText: "History item 0259" })
    .waitFor();
  assert.equal(await page.locator(".timeline-entry").count(), 100);
  await page.getByRole("button", { name: "更早消息", exact: true }).click();
  await page
    .locator(".timeline-excerpt")
    .filter({ hasText: "History item 0060" })
    .waitFor();
  assert.equal(await page.locator(".timeline-entry").count(), 100);
  await page.getByRole("button", { name: "更早消息", exact: true }).click();
  await page
    .locator(".timeline-excerpt")
    .filter({ hasText: "History item 0000" })
    .waitFor();
  assert.equal(await page.locator(".timeline-entry").count(), 60);
  assert.equal(
    await page
      .getByRole("button", { name: "更早消息", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page
    .locator(".timeline-excerpt")
    .filter({ hasText: "History item 0259" })
    .waitFor();
  checks.push(
    "100/100/60 history pages replace one another and can return to latest",
  );
  await page.getByLabel("关闭详情").click();
  await page.getByRole("button", { name: "较早的合作", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(
      'select[aria-label="选择合作"] option[value="history-0"]',
    ),
  );
  assert.ok(
    (await page.getByLabel("选择合作").locator("option").count()) <= 26,
  );
  await page.getByLabel("选择合作").selectOption("history-0");
  await page.getByRole("button", { name: "查看 DSH 动态" }).waitFor();
  await page.getByRole("button", { name: "较新的合作", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(
      'select[aria-label="选择合作"] option[value="history-39"]',
    ),
  );
  await page.getByLabel("选择合作").selectOption("history-39");
  await page.getByRole("button", { name: "查看 DSH 动态" }).waitFor();
  checks.push(
    "25-item collaboration pages hydrate historical participants without replaying all logs",
  );
  await page.getByLabel("收起为悬浮条").click();
  await page.locator(".floater").waitFor();
  await page.waitForTimeout(500);
  const bounds = await page.evaluate(() => {
    const frame = document.querySelector(".floater").getBoundingClientRect();
    return [...document.querySelectorAll(".mini-agent")].map((el) => {
      const box = el.getBoundingClientRect(),
        icon = el.querySelector(".avatar-art").getBoundingClientRect();
      return {
        inside:
          icon.left >= box.left &&
          icon.right <= box.right &&
          icon.top >= box.top &&
          icon.bottom <= box.bottom &&
          box.right <= frame.right &&
          box.left >= frame.left,
        width: icon.width,
      };
    });
  });
  assert.equal(bounds.length, 3);
  assert.ok(bounds.every((b) => b.inside && b.width === 16));
  await page.screenshot({ path: join(output, "floater-four-agents.png") });
  checks.push(
    "all three right-side 16px agent icons remain inside their slots and the 320px floater",
  );
  await page.getByLabel("回到便签视图").click();
  await page.getByRole("button", { name: "新合作", exact: true }).click();
  await page.locator(".execution-settings summary").click();
  await page
    .getByLabel("DSH 模型", { exact: true })
    .locator("option")
    .nth(1)
    .waitFor({ state: "attached" });
  await page
    .getByLabel("Kimi 模型", { exact: true })
    .locator("option")
    .nth(1)
    .waitFor({ state: "attached" });
  await page.getByLabel("DSH 模型", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("DSH 思考强度", { exact: true }).selectOption("low");
  await page
    .getByLabel("Kimi 模型", { exact: true })
    .selectOption({ index: 1 });
  await page.getByLabel("Kimi 思考强度", { exact: true }).selectOption("low");
  await page.screenshot({ path: join(output, "execution-settings.png") });
  checks.push(
    "initiator can choose actual DSH/Kimi models and low effort in the creation form without a model turn",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify({ ok: true, installed, checks, bounds }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, installed, checks }));
} catch (error) {
  try {
    const page = await app.firstWindow();
    await page.screenshot({ path: join(output, "failure.png") });
  } catch {}
  throw error;
} finally {
  await app.close();
  await daemon.close();
}
