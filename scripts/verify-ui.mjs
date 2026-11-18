import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cpus } from "node:os";
import { projectRoot } from "../src/bridge/discover.mjs";
const installed = process.argv.includes("--installed");
const executablePath = installed
  ? join(process.env.LOCALAPPDATA, "Programs/AgentsBridge/AgentsBridge.exe")
  : undefined;
const launchArgs = installed
  ? ["--replay", "--qa"]
  : [projectRoot, "--replay", "--qa"];
const output = join(
  projectRoot,
  installed ? "outputs/installed-ui-qa" : "outputs/ui-qa",
);
mkdirSync(output, { recursive: true });
const checks = [];
let animationMetrics, dragMetrics, contrast;
async function assertIconsCentered(page) {
  const offsets = await page.locator(".node-disc").evaluateAll((nodes) =>
    nodes.map((node) => {
      const frame = node.getBoundingClientRect();
      const icon = node.querySelector(".agent-icon").getBoundingClientRect();
      return {
        agent: node.getAttribute("aria-label"),
        x: icon.x + icon.width / 2 - (frame.x + frame.width / 2),
        y: icon.y + icon.height / 2 - (frame.y + frame.height / 2),
      };
    }),
  );
  const misaligned = offsets.filter(
    (offset) => Math.abs(offset.x) > 0.2 || Math.abs(offset.y) > 0.2,
  );
  if (misaligned.length)
    throw new Error(`Misaligned agent icons: ${JSON.stringify(misaligned)}`);
}
async function moveSystemPointer(app, x, y, button = 0, absolute = false) {
  const point = absolute
    ? { x, y }
    : await app.evaluate(
        ({ BrowserWindow, screen }, point) => {
          const bounds = BrowserWindow.getAllWindows()[0].getBounds();
          return screen.dipToScreenPoint({
            x: Math.round(bounds.x + point.x),
            y: Math.round(bounds.y + point.y),
          });
        },
        { x, y },
      );
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class PointerQA { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra); }'; [PointerQA]::SetProcessDPIAware() | Out-Null; [PointerQA]::SetCursorPos(${point.x},${point.y}) | Out-Null; [PointerQA]::mouse_event(${button},0,0,0,[UIntPtr]::Zero)`,
    ],
    { windowsHide: true },
  );
}
async function settled(page) {
  for (let n = 0; n < 80; n++) {
    await page.waitForTimeout(30);
    const moving = await page.evaluate(async () => {
      const state = await window.bridge.snapshot();
      return (
        state.transitioning ||
        document.body.classList.contains("window-transitioning")
      );
    });
    if (!moving) return;
  }
  throw new Error("Window transition did not settle");
}
async function checkWheel(page, nativeApp) {
  const area = page.locator(".workspace-body");
  const range = await area.evaluate((el) => {
    el.scrollTop = 0;
    return el.scrollHeight - el.clientHeight;
  });
  if (range < 8) return;
  const stage = await page.locator(".graph-stage").boundingBox();
  const point = { x: stage.x + 12, y: stage.y + 12 };
  if (nativeApp) {
    const physical = await nativeApp.evaluate(
      ({ BrowserWindow, screen }, p) => {
        const b = BrowserWindow.getAllWindows()[0].getBounds();
        return screen.dipToScreenPoint({
          x: Math.round(b.x + p.x),
          y: Math.round(b.y + p.y),
        });
      },
      point,
    );
    for (const delta of [-120, 120]) {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          join(projectRoot, "scripts/native-input-qa.ps1"),
          "-Action",
          "Wheel",
          "-X",
          String(physical.x),
          "-Y",
          String(physical.y),
          "-DeltaY",
          String(delta),
        ],
        { windowsHide: true },
      );
      await page.waitForTimeout(90);
      const top = await area.evaluate((el) => el.scrollTop);
      if (delta < 0 && top < 2)
        throw new Error("Native wheel failed after native resize");
      if (delta > 0 && top > 2)
        throw new Error("Native upward wheel failed after native resize");
    }
  } else {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(80);
    if ((await area.evaluate((el) => el.scrollTop)) < 2)
      throw new Error("Wheel failed after resize");
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(80);
    if ((await area.evaluate((el) => el.scrollTop)) > 2)
      throw new Error("Upward wheel failed after resize");
  }
}
const env = {
  ...process.env,
  AGENTSBRIDGE_HOME: mkdtempSync(join(tmpdir(), "ab-ui-")),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  args: launchArgs,
  env,
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "AgentsBridge" }).waitFor();
  await page
    .getByRole("button", { name: /查看 .* 动态/ })
    .nth(1)
    .waitFor();
  if ((await page.getByRole("button", { name: /查看 .* 动态/ }).count()) !== 2)
    throw new Error("Expected two participants");
  checks.push("two participants");
  await page
    .locator(".heading .eyebrow")
    .filter({ hasText: "本地多智能体协作" })
    .waitFor();
  await page
    .locator(".collaboration-title")
    .filter({ hasText: "Parser 并发审查" })
    .waitFor();
  checks.push("compact brand heading and secondary collaboration title");
  await assertIconsCentered(page);
  checks.push("agent icons are geometrically centered");
  const initial = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    workArea: screen.getPrimaryDisplay().workArea,
  }));
  if (
    Math.abs(initial.bounds.width - 520) > 4 ||
    Math.abs(initial.bounds.height - 500) > 4 ||
    Math.abs(
      initial.bounds.x +
        initial.bounds.width -
        (initial.workArea.x + initial.workArea.width - 20),
    ) > 4 ||
    Math.abs(initial.bounds.y - initial.workArea.y - 20) > 4
  )
    throw new Error(
      `Unexpected default note bounds: ${JSON.stringify(initial)}`,
    );
  checks.push("sticky-note size anchored to top-right");
  if (
    (await page.locator(".titlebar .window-controls .icon-button").count()) !==
      3 ||
    (await page.locator(".titlebar").getByLabel("停止合作").count()) !== 0
  )
    throw new Error("Titlebar must contain only three unified window controls");
  checks.push("three unified titlebar controls");
  await page.waitForFunction(() => {
    const brand = document.querySelector(".brand-image");
    return (
      brand?.complete &&
      brand.naturalWidth >= 512 &&
      document.querySelectorAll(".canvas .avatar-art [data-part='body']")
        .length === 2
    );
  });
  checks.push("high-resolution brand mark and layered SVG agent icons");
  await page.screenshot({ path: join(output, "01-two-agents.png") });
  await page.getByRole("button", { name: "Codex 到 DSH 请求" }).click();
  await page.getByRole("button", { name: "查看消息详情" }).click();
  await page.getByLabel("固定详情面板").waitFor();
  await page
    .getByText("node --test tests/mesh.test.mjs", { exact: true })
    .waitFor();
  checks.push("fixed message/command details");
  await page.screenshot({ path: join(output, "02-details.png") });
  await page.getByLabel("关闭详情").click();
  await page.evaluate(() => window.bridge.request("replayNext", { count: 1 }));
  await page.getByRole("button", { name: "查看 Kimi 动态" }).waitFor();
  checks.push("third participant joins");
  await page.evaluate(() => window.bridge.request("replayNext", { count: 5 }));
  await page.getByText("审查说明.md", { exact: true }).first().waitFor();
  await page.screenshot({ path: join(output, "03-three-agents.png") });
  await app.evaluate(() => {
    const all = globalThis.replayAll;
    for (const event of all) if (event.seq >= 15) event.seq += 3;
    const base = {
      schema_version: 2,
      time: "2026-11-04T07:33:43.924Z",
      project_id: "replay-project",
      collab_id: "replay-parser",
      epoch: 1,
      task_id: null,
      agent: null,
    };
    all.push(
      {
        ...base,
        seq: 15,
        id: "replay-cursor-joined",
        type: "participant.joined",
        data: { agent: "cursor" },
      },
      {
        ...base,
        seq: 16,
        id: "replay-cursor-state",
        agent: "cursor",
        type: "agent.state",
        data: { state: "working", progress: "检查四人布局边界" },
      },
      {
        ...base,
        seq: 17,
        id: "replay-cursor-message",
        task_id: "replay-task-cursor",
        type: "message.sent",
        data: {
          from: "cursor",
          to: "codex",
          type: "request",
          body: "请确认四人布局没有出界。",
        },
      },
    );
    all.sort((a, b) => a.seq - b.seq);
  });
  await page.evaluate(() => window.bridge.request("replayNext", { count: 3 }));
  await page.getByRole("button", { name: "查看 Cursor 动态" }).waitFor();
  await assertIconsCentered(page);
  checks.push("all four agent icons remain centered in compact grid");
  const layout = await page.evaluate(() => {
    const canvas = document.querySelector(".canvas").getBoundingClientRect();
    const items = [
      ...document.querySelectorAll(".agent-node,.message-chip"),
    ].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        name: element.getAttribute("aria-label") || element.textContent,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    });
    const outside = items.filter(
      (rect) =>
        rect.left < canvas.left - 1 ||
        rect.top < canvas.top - 1 ||
        rect.right > canvas.right + 1 ||
        rect.bottom > canvas.bottom + 1,
    );
    const nodes = items.filter((_, index) =>
      document
        .querySelectorAll(".agent-node,.message-chip")
        [index].classList.contains("agent-node"),
    );
    const overlaps = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        if (
          Math.min(nodes[i].right, nodes[j].right) -
            Math.max(nodes[i].left, nodes[j].left) >
            1 &&
          Math.min(nodes[i].bottom, nodes[j].bottom) -
            Math.max(nodes[i].top, nodes[j].top) >
            1
        )
          overlaps.push([nodes[i].name, nodes[j].name]);
    return { outside, overlaps };
  });
  if (layout.outside.length || layout.overlaps.length)
    throw new Error(`Four-agent layout overflow: ${JSON.stringify(layout)}`);
  checks.push(
    "four-agent grid and messages stay inside canvas without overlap",
  );
  await page.screenshot({ path: join(output, "04-four-agents.png") });
  const resizeCases = [
    [420, 480],
    [460, 480],
    [520, 500],
    [619, 480],
    [621, 480],
    [719, 480],
    [721, 480],
    [900, 480],
    [900, 700],
    [1100, 800],
    [420, 800],
    [1100, 480],
  ];
  for (const [width, height] of resizeCases) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 20, ...size }),
      { width, height },
    );
    await page.waitForTimeout(60);
    const geometry = await page.evaluate(() => {
      const stage = document
        .querySelector(".graph-stage")
        .getBoundingClientRect();
      const caption = document
        .querySelector(".canvas-caption")
        .getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".agent-node")].map((el) =>
        el.getBoundingClientRect(),
      );
      const bad = [];
      const protectedAreas = [
        ...document.querySelectorAll(".node-disc,.agent-status"),
      ].map((el) => el.getBoundingClientRect());
      for (const chip of document.querySelectorAll(".message-chip")) {
        const box = chip.getBoundingClientRect();
        if (
          protectedAreas.some(
            (r) =>
              box.left < r.right &&
              box.right > r.left &&
              box.top < r.bottom &&
              box.bottom > r.top,
          )
        )
          bad.push("message chip overlaps an agent icon or status");
      }
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (
          n.top < caption.bottom + 12 ||
          n.left < stage.left ||
          n.right > stage.right ||
          n.bottom > stage.bottom
        )
          bad.push("node/caption/edge " + i);
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j];
          const horizontal = Math.max(n.left - m.right, m.left - n.right);
          const vertical = Math.max(n.top - m.bottom, m.top - n.bottom);
          if (Math.max(horizontal, vertical) < 12)
            bad.push("node spacing " + i + ":" + j);
        }
      }
      const footer = document
        .querySelector(".note footer")
        .getBoundingClientRect();
      const actions = document
        .querySelector(".reviewbar")
        .getBoundingClientRect();
      if (
        actions.bottom > footer.top + 1 ||
        actions.top < 0 ||
        actions.right > innerWidth
      )
        bad.push("fixed actions overflow");
      const eyebrow = document
        .querySelector(".heading .eyebrow")
        .getBoundingClientRect();
      const heading = document
        .querySelector(".heading h1")
        .getBoundingClientRect();
      if (heading.top - eyebrow.bottom > 3) bad.push("brand line gap");
      if (
        document.querySelector(".note").scrollWidth >
        document.querySelector(".note").clientWidth
      )
        bad.push("horizontal overflow");
      return bad;
    });
    if (geometry.length)
      throw new Error(`Resize ${width}x${height}: ${geometry.join(", ")}`);
    await assertIconsCentered(page);
    await checkWheel(page);
    if (width === 420 || width === 900)
      await page.screenshot({
        path: join(output, `resize-${width}x${height}.png`),
      });
  }
  checks.push(
    "twelve resize sizes preserve node spacing, caption clearance, fixed actions, header line gap and horizontal bounds",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({
      x: 20,
      y: 20,
      width: 700,
      height: 650,
    }),
  );
  const nativeBefore = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  const hwnd = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .getNativeWindowHandle()
      .readBigUInt64LE()
      .toString(),
  );
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      join(projectRoot, "scripts/native-input-qa.ps1"),
      "-Action",
      "Resize",
      "-WindowHandle",
      hwnd,
    ],
    { windowsHide: true },
  );
  const nativeAfter = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  if (Math.abs(nativeBefore.width - nativeAfter.width) < 30)
    throw new Error("Native sizing API did not resize window");
  await checkWheel(page, app);
  checks.push(
    "wheel scrolls both ways after twelve programmatic resizes and native Windows sizing messages without changing mode",
  );
  await app.evaluate(
    ({ BrowserWindow }, bounds) =>
      BrowserWindow.getAllWindows()[0].setBounds(bounds),
    initial.bounds,
  );
  await page.emulateMedia({
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  await page.waitForFunction(
    () =>
      matchMedia("(prefers-color-scheme: dark)").matches &&
      getComputedStyle(document.querySelector(".note")).backgroundColor ===
        "rgb(23, 24, 29)" &&
      getComputedStyle(document.querySelector(".titlebar .window-controls"))
        .backgroundColor === "rgb(16, 17, 22)" &&
      getComputedStyle(document.querySelector(".message-chip"))
        .backgroundColor === "rgb(32, 33, 39)" &&
      getComputedStyle(document.querySelector(".agent-node.codex .node-disc"))
        .getPropertyValue("--identity")
        .trim() === "#b2a2fb",
  );
  contrast = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = (token) => {
      const channels = style
        .getPropertyValue(token)
        .trim()
        .slice(1)
        .match(/../g)
        .map((hex) => parseInt(hex, 16) / 255)
        .map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const cta = [
      "--cta-start",
      "--cta-end",
      "--cta-hover-start",
      "--cta-hover-end",
    ];
    return {
      cta: Math.min(...cta.map((token) => ratio(1, luminance(token)))),
      agents: Object.fromEntries(
        ["codex", "dsh", "kimi", "cursor"].map((agent) => [
          agent,
          ratio(luminance(`--agent-${agent}`), luminance("--surface-3")),
        ]),
      ),
    };
  });
  if (
    contrast.cta < 4.5 ||
    Object.values(contrast.agents).some((value) => value < 4.5)
  )
    throw new Error(`Dark contrast regression: ${JSON.stringify(contrast)}`);
  checks.push("CTA gradient stops and all four dark agent colors exceed 4.5:1");
  await page.screenshot({ path: join(output, "04-four-agents-dark.png") });
  if (
    (await page
      .locator(".agent-codex .avatar-art")
      .first()
      .evaluate((el) => getComputedStyle(el).filter)) !== "none"
  )
    throw new Error("Dark Codex icon changed color through a filter");
  checks.push("dark Codex icon uses its SVG palette without a filter");
  checks.push(
    "graphite note, message icons and agent identity follow live system dark mode",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].minimize(),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".note").dataset.motion === "still" &&
      !document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" &&
            animation.effect.getTiming().iterations === Infinity,
        ),
    null,
    { polling: 50, timeout: 5000 },
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].restore(),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".note").dataset.motion === "live" &&
      document
        .getAnimations()
        .some(
          (animation) => animation.effect.getTiming().iterations === Infinity,
        ),
  );
  checks.push(
    "minimizing a running note pauses its looping renderer animations",
  );
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    globalThis.nativeMotionCalls = { bounds: 0, shape: 0 };
    for (const [method, key] of [
      ["setBounds", "bounds"],
      ["setShape", "shape"],
    ]) {
      const original = w[method].bind(w);
      w[method] = (...args) => {
        globalThis.nativeMotionCalls[key]++;
        return original(...args);
      };
    }
  });
  await page.evaluate(() => {
    window.__frameIntervals = [];
    const began = performance.now();
    let last = began;
    function frame(now) {
      window.__frameIntervals.push(now - last);
      last = now;
      if (now - began < 650) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page.getByLabel("收起为悬浮条").click();
  await page.getByLabel("回到便签视图").waitFor();
  await settled(page);
  await page.waitForFunction(
    () =>
      document
        .querySelector(".floater")
        ?.getAnimations()
        .some((a) =>
          a.effect.getKeyframes().some((f) => f.transform && f.opacity),
        ),
    null,
    { timeout: 3000 },
  );
  if (
    !(await page
      .locator(".floater-avatar .agent-icon")
      .evaluate((element) =>
        element
          .getAnimations()
          .some((animation) =>
            animation.effect.getKeyframes().some((frame) => frame.transform),
          ),
      ))
  )
    throw new Error("The shared agent avatar did not animate between views");
  const calls = await app.evaluate(() => globalThis.nativeMotionCalls);
  if (calls.bounds > 2 || calls.shape > 2)
    throw new Error(
      `Repeated native animation calls: ${JSON.stringify(calls)}`,
    );
  await page.waitForTimeout(650);
  const frames = await page.evaluate(() =>
    window.__frameIntervals.slice(1).sort((a, b) => a - b),
  );
  animationMetrics = {
    nativeCalls: calls,
    frameCount: frames.length,
    p95ms: frames[Math.floor(frames.length * 0.95)],
    maxMs: Math.max(...frames),
  };
  checks.push(
    "mode switch animates compositor opacity/transform with one native geometry commit",
  );
  const floatingBounds = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    workArea: screen.getPrimaryDisplay().workArea,
  }));
  if (
    Math.abs(floatingBounds.bounds.width - 320) > 4 ||
    Math.abs(floatingBounds.bounds.height - 64) > 4 ||
    Math.abs(
      floatingBounds.bounds.x +
        floatingBounds.bounds.width -
        (floatingBounds.workArea.x + floatingBounds.workArea.width - 20),
    ) > 4 ||
    Math.abs(floatingBounds.bounds.y - floatingBounds.workArea.y - 20) > 4
  )
    throw new Error(
      `Unexpected default floater bounds: ${JSON.stringify(floatingBounds)}`,
    );
  checks.push("narrow floater anchored to top-right in dark mode");
  await page.screenshot({ path: join(output, "04-floater-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".floater")).backgroundColor ===
      "rgb(255, 255, 255)",
  );
  await page.screenshot({ path: join(output, "04-floater.png") });
  const handleValue = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .getNativeWindowHandle()
      .readBigUInt64LE()
      .toString(),
  );
  const nativeRegion = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        join(projectRoot, "scripts/inspect-compact-window.ps1"),
        "-WindowHandle",
        handleValue,
        "-ScreenshotPath",
        join(output, "floater-native.png"),
      ],
      { windowsHide: true, encoding: "utf8" },
    ),
  );
  if (
    nativeRegion.regionType !== 3 ||
    nativeRegion.cornerDrawn ||
    !nativeRegion.centerDrawn
  )
    throw new Error(`Invalid native clipping: ${JSON.stringify(nativeRegion)}`);
  checks.push(
    "native rounded region excludes rectangular corner pixels; desktop capture verified",
  );

  await page.getByLabel("收起为悬浮球").click();
  await page.locator(".dock-ball-shell.active").waitFor();
  await settled(page);
  await page.mouse.move(11, 22);
  await page.locator(".dock-ball-shell.preview").waitFor();
  await settled(page);
  await page.screenshot({ path: join(output, "09-dock-preview.png") });
  await page.mouse.move(-250, 120);
  await page.locator(".dock-ball-shell:not(.preview)").waitFor();
  await settled(page);
  await page.screenshot({ path: join(output, "08-dock-active.png") });
  // Click opens the note directly; no intermediate mode or second click.
  await page.getByLabel("打开协作便签").click({ position: { x: 12, y: 22 } });
  await page.getByRole("heading", { name: "AgentsBridge" }).waitFor();
  checks.push(
    "ball hover reveals status, leaving collapses, single click opens note",
  );
  await page.getByLabel("收起为悬浮条").click();
  await page.getByLabel("回到便签视图").waitFor();
  await settled(page);
  if (await page.locator(".drag-handle").count())
    throw new Error("Floater still has a grip handle");
  if (
    (await page
      .locator(".floater strong")
      .evaluate((el) => getComputedStyle(el).userSelect)) !== "none"
  )
    throw new Error("Floater text can be selected");
  checks.push(
    "Floater entire surface is draggable, text is unselectable and buttons retain their actions",
  );
  const handle = page.getByLabel("拖动悬浮条");
  const box = await handle.boundingBox();
  const beforeDrag = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  await moveSystemPointer(
    app,
    box.x + box.width / 2,
    box.y + box.height / 2,
    2,
  );
  await page.waitForTimeout(1800);
  const held = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { bounds: w.getBounds(), resizable: w.isResizable() };
  });
  if (
    held.resizable ||
    Math.abs(held.bounds.width - beforeDrag.width) > 1 ||
    Math.abs(held.bounds.height - beforeDrag.height) > 1
  )
    throw new Error(
      `Long press resized Floater: ${JSON.stringify({ beforeDrag, held })}`,
    );
  checks.push(
    "Floater long hold keeps fixed dimensions and disables native resize border",
  );
  const nativeStart = await app.evaluate(
    () => globalThis.nativeMotionCalls.bounds,
  );
  const sweepPoint = await app.evaluate(
    ({ BrowserWindow, screen }, p) => {
      const b = BrowserWindow.getAllWindows()[0].getBounds();
      return screen.dipToScreenPoint({
        x: Math.round(b.x + p.x),
        y: Math.round(b.y + p.y),
      });
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      join(projectRoot, "scripts/native-input-qa.ps1"),
      "-Action",
      "Sweep",
      "-X",
      String(sweepPoint.x),
      "-Y",
      String(sweepPoint.y),
      "-DeltaX",
      "-135",
      "-DeltaY",
      "120",
    ],
    { windowsHide: true },
  );
  if (
    (await app.evaluate(() => globalThis.nativeMotionCalls.bounds)) !==
    nativeStart
  )
    throw new Error("Native drag still resizes through Electron");
  const movedSize = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  await page.waitForTimeout(1200);
  const restingSize = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  if (
    Math.abs(movedSize.width - restingSize.width) > 1 ||
    Math.abs(movedSize.height - restingSize.height) > 1
  )
    throw new Error("Size drifts while holding after movement");
  const movedGrip = await handle.boundingBox();
  await moveSystemPointer(app, movedGrip.x + 10, movedGrip.y + 15, 4);
  await page.waitForTimeout(120);
  const afterDrag = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  if (afterDrag.x >= beforeDrag.x - 40 || afterDrag.y <= beforeDrag.y + 40)
    throw new Error(
      `Drag did not move window: ${JSON.stringify({ beforeDrag, afterDrag })}`,
    );
  if (
    Math.abs(afterDrag.width - beforeDrag.width) > 1 ||
    Math.abs(afterDrag.height - beforeDrag.height) > 1
  )
    throw new Error(
      `Drag size drift: ${JSON.stringify({ beforeDrag, afterDrag })}`,
    );
  const moveStats = await app.evaluate(() =>
    globalThis.dragTrace.filter((e) => e.type === "native-stats").at(-1),
  );
  if (!moveStats || Number(moveStats.sample.split(" ")[1]) < 40)
    throw new Error(
      `Native sweep did not follow enough positions: ${JSON.stringify(moveStats)}`,
    );
  dragMetrics = {
    nativeSamples: Number(moveStats.sample.split(" ")[1]),
    electronBoundsDuringDrag: 0,
  };
  checks.push(
    "continuous native drag follows over forty pointer samples with zero Electron resize calls",
  );
  checks.push("real pointer drag moves the floater without opening the note");
  // Exercise release-only snapping through the same pointer gesture used by the UI.
  const grip = await handle.boundingBox();
  const distance = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0],
      b = w.getBounds();
    return (
      screen.getDisplayMatching(b).workArea.x +
      screen.getDisplayMatching(b).workArea.width -
      b.x -
      b.width
    );
  });
  await moveSystemPointer(app, grip.x + 10, grip.y + 15, 2);
  await moveSystemPointer(app, grip.x + 10 + distance + 5, grip.y + 15);
  if (await page.locator(".dock-ball-shell").count())
    throw new Error("Docked before release");
  const releaseGrip = await handle.boundingBox();
  await moveSystemPointer(app, releaseGrip.x + 10, releaseGrip.y + 15, 4);
  await page.locator(".dock-ball-shell").waitFor();
  checks.push("edge snap commits only after pointer release");
  await settled(page);
  await moveSystemPointer(app, 10, 22);
  await page.locator(".dock-ball-shell.preview").waitFor();
  await settled(page);
  await moveSystemPointer(app, 20, 22, 2);
  await moveSystemPointer(app, -70, 22);
  await page.locator(".dock-ball-shell.dragging").waitFor();
  if (await page.locator(".floater").count())
    throw new Error("Detached ball expanded before release");
  await page.screenshot({ path: join(output, "ball-transition.png") });
  const edge = await app.evaluate(({ screen }) => {
    const p = screen.getCursorScreenPoint(),
      a = screen.getDisplayNearestPoint(p).workArea;
    return screen.dipToScreenPoint({ x: a.x + a.width - 20, y: p.y });
  });
  await moveSystemPointer(app, edge.x, edge.y, 0, true);
  await moveSystemPointer(app, edge.x, edge.y, 4, true);
  await page.locator(".dock-ball-shell:not(.dragging)").waitFor();
  checks.push(
    "ball remains transitional outside zone while held and reattaches after returning inside zone",
  );
  await moveSystemPointer(app, 10, 22);
  await page.locator(".dock-ball-shell.preview").waitFor();
  await moveSystemPointer(app, 20, 22, 2);
  await page.waitForTimeout(1100);
  await moveSystemPointer(app, -100, 80);
  await page.waitForTimeout(700);
  if (await page.locator(".floater").count())
    throw new Error("Ball drag ended before native mouse release");
  await moveSystemPointer(app, 20, 22, 4);
  await page.locator(".floater").waitFor({ timeout: 3000 });
  const dragTrace = await app.evaluate(() => globalThis.dragTrace);
  writeFileSync(
    join(output, "drag-trace.json"),
    JSON.stringify(dragTrace, null, 2),
  );
  const gesture = dragTrace.slice(
    dragTrace.findLastIndex((e) => e.type === "start"),
  );
  if (
    !gesture.some((e) => e.type === "native-held") ||
    !gesture.some(
      (e) =>
        e.type === "end" &&
        ["native-release", "pointer-up"].includes(e.reason) &&
        e.moved,
    )
  )
    throw new Error("Ball drag did not complete after native button release");
  checks.push(
    "native docked-ball long press and held drag complete without freeze, followed by a working second interaction",
  );
  await settled(page);
  const dockButton = await page.getByLabel("收起为悬浮球").boundingBox();
  await moveSystemPointer(
    app,
    dockButton.x + dockButton.width / 2,
    dockButton.y + dockButton.height / 2,
    2,
  );
  await moveSystemPointer(
    app,
    dockButton.x + dockButton.width / 2,
    dockButton.y + dockButton.height / 2,
    4,
  );
  await page.locator(".dock-ball-shell").waitFor();
  await settled(page);

  await page.getByLabel("打开协作便签").click({ position: { x: 12, y: 22 } });
  await page.getByLabel("收起为悬浮条").click();
  await page.getByLabel("回到便签视图").click();
  await page.getByRole("heading", { name: "AgentsBridge" }).waitFor();
  checks.push("note/floater round trip and live light mode");
  await page.getByLabel("停止合作", { exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByLabel("停止合作", { exact: true }).click();
  await page.getByRole("button", { name: "确认停止", exact: true }).click();
  await page.locator(".state").filter({ hasText: "已停止" }).waitFor();
  checks.push("stop requires confirmation and is terminal");
  await page.screenshot({ path: join(output, "05-stopped.png") });
  await page.getByLabel("收起为悬浮条").click();
  await page.getByLabel("回到便签视图").waitFor();
  await page.getByLabel("收起为悬浮球").click();
  await page.locator(".dock-ball-shell.idle").waitFor();
  await settled(page);
  if (
    await page
      .locator(".dock-ball-shell")
      .evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some(
            (animation) => animation.effect.getTiming().iterations === Infinity,
          ),
      )
  )
    throw new Error("Stopped ball has a looping animation");
  const persisted = JSON.parse(
    readFileSync(join(env.AGENTSBRIDGE_HOME, "window.json"), "utf8"),
  );
  if (!persisted.floating || !persisted.docked)
    throw new Error(
      `Dock state was not persisted: ${JSON.stringify(persisted)}`,
    );
  checks.push(
    "inactive collaboration has neutral status and persists dock state",
  );
  await page.screenshot({ path: join(output, "10-dock-idle.png") });
  const content = await page.locator("body").innerText();
  if (content.includes("暂停")) throw new Error("Forbidden pause UI");
  checks.push("no pause UI");
  if (errors.length) throw new Error(errors.join("\n"));
} catch (error) {
  const diagnostics = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0]?.getBounds(),
    pointer: screen.getCursorScreenPoint(),
    drag: globalThis.dragTrace?.slice(-16),
  }));
  console.error(JSON.stringify(diagnostics));
  throw error;
} finally {
  await app.close();
}
const restoredSession = await electron.launch({
  executablePath,
  args: launchArgs.filter((arg) => arg !== "--qa"),
  env,
});
try {
  const page = await restoredSession.firstWindow();
  await page.locator(".dock-ball-shell.idle").waitFor();
  checks.push("docked ball restores directly after application restart");
} finally {
  await restoredSession.close();
}
const env2 = {
  ...env,
  AGENTSBRIDGE_HOME: mkdtempSync(join(tmpdir(), "ab-ui-handoff-")),
};
const second = await electron.launch({
  executablePath,
  args: launchArgs,
  env: env2,
});
try {
  const page = await second.firstWindow();
  await page.getByRole("heading", { name: "AgentsBridge" }).waitFor();
  await page.evaluate(() => window.bridge.request("replayNext", { count: 99 }));
  await page.getByRole("button", { name: "发起下一轮合作" }).waitFor();
  await page.getByRole("button", { name: "查看交接" }).click();
  await page.getByText("合作交接", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "06-handoff.png") });
  const handoffBody = page.locator(".detail-body.detail-handoff");
  const scrollable = await handoffBody.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  );
  if (!scrollable)
    throw new Error("Handoff detail must use its outer scroll container");
  await handoffBody.hover();
  await page.mouse.wheel(0, 320);
  await page.waitForFunction(
    () => document.querySelector(".detail-body.detail-handoff").scrollTop > 0,
  );
  const copyOverlaps = await handoffBody.evaluate((element) => {
    const copy = element.querySelector(".handoff-copy").getBoundingClientRect();
    const content = element.querySelector("pre").getBoundingClientRect();
    return copy.bottom > content.top + 1;
  });
  if (copyOverlaps)
    throw new Error("Handoff copy action overlaps scrolled content");
  checks.push("handoff detail scrolls with mouse wheel without overlap");
  await page.screenshot({ path: join(output, "06-handoff-scrolled.png") });
  await page.getByLabel("关闭详情").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "消息记录" }).click();
  const timeline = page.locator(".detail-timeline");
  await timeline.waitFor();
  const excerpt = timeline.locator(".timeline-excerpt").first();
  if (
    (await excerpt.evaluate(
      (element) => getComputedStyle(element).webkitLineClamp,
    )) !== "2"
  )
    throw new Error("Timeline preview is missing its two-line clamp");
  const firstRound = timeline.locator(".timeline-round > summary").first();
  await firstRound.click();
  await timeline
    .locator(".timeline-entry > summary")
    .first()
    .waitFor({ state: "hidden" });
  await firstRound.click();
  const firstMessage = timeline.locator(".timeline-entry > summary").first();
  await firstMessage.click();
  await timeline.locator(".timeline-content pre").first().waitFor();
  await page.screenshot({
    path: join(output, "11-timeline-dark.png"),
    animations: "disabled",
  });
  await page.getByLabel("关闭详情").click();
  await timeline.waitFor({ state: "hidden" });
  checks.push(
    "timeline round collapses, excerpts clamp, and a row opens full text inline",
  );
  await page.getByRole("button", { name: "发起下一轮合作" }).click();
  await page.getByRole("heading", { name: "发起下一轮合作" }).waitFor();
  await page.getByText("从上一轮交接继续").waitFor();
  await page.getByRole("button", { name: "将 DSH 设为首位" }).click();
  await page.locator(".agent-option.agent-dsh .first-badge").waitFor();
  if (
    !(await page.getByRole("button", { name: "创建并发送目标" }).isDisabled())
  )
    throw new Error("Empty goal submits");
  await page.screenshot({
    path: join(output, "07-create-form.png"),
    animations: "disabled",
  });
  checks.push(
    "handoff opens the form, the first recipient is selectable, and an empty goal disables submit",
  );
  const result = await second.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      alwaysOnTop: w.isAlwaysOnTop(),
      frame: w.getNativeWindowHandle().length > 0,
      bounds: w.getBounds(),
    };
  });
  if (!result.alwaysOnTop) throw new Error("Window must remain on top");
  await second.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false),
  );
  await page.waitForTimeout(100);
  if (
    !(await second.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isAlwaysOnTop(),
    ))
  )
    throw new Error("Topmost state was not repaired");
  await second.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.minimize();
    w.restore();
  });
  if (
    !(await second.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isAlwaysOnTop(),
    ))
  )
    throw new Error("Topmost state lost after restore");
  checks.push("topmost repairs external changes and survives minimize/restore");
  checks.push("native always-on-top window");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置" }).click();
  if (await page.getByRole("checkbox", { name: "幽灵模式" }).count())
    throw new Error("Removed ghost mode is still exposed");
  await page.evaluate(() => localStorage.setItem("ab.ghost", "on"));
  if (await page.locator("[data-ghost]").count())
    throw new Error("Legacy ghost preference still affects the note");
  checks.push("ghost mode removed; legacy preference has no effect");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.activeElement?.blur());
  // Electron's native metric includes main, renderer, GPU and utility processes.
  await page.waitForTimeout(1000);
  const before = await second.evaluate(({ app }) => app.getAppMetrics());
  const idleStarted = performance.now();
  await page.waitForTimeout(5000);
  const after = await second.evaluate(({ app }) => app.getAppMetrics());
  const baseline = new Map(
    before.map((m) => [m.pid, m.cpu.cumulativeCPUUsage || 0]),
  );
  const seconds = after.reduce(
    (sum, m) =>
      sum +
      Math.max(0, (m.cpu.cumulativeCPUUsage || 0) - (baseline.get(m.pid) || 0)),
    0,
  );
  const idle = {
    sample_ms: Math.round(performance.now() - idleStarted),
    cpu_seconds: seconds,
  };
  idle.one_core_percent = +((seconds / (idle.sample_ms / 1000)) * 100).toFixed(
    3,
  );
  idle.machine_percent = +(idle.one_core_percent / cpus().length).toFixed(3);
  const historyTitle =
    "AgentsBridge 2.0 · 工程验收 · 这是用于检查历史记录选择栏中文长标题与状态文字溢出的协作记录";
  await second.evaluate(
    ({ BrowserWindow }, title) =>
      BrowserWindow.getAllWindows()[0].webContents.send("bridge:update", {
        type: "events",
        events: [
          {
            seq: 999,
            id: "qa-long-history",
            type: "collaboration.started",
            collab_id: "qa-long-history",
            epoch: 1,
            data: { title, goal: title },
          },
        ],
      }),
    historyTitle,
  );
  const picker = page.getByLabel("选择合作");
  await picker.waitFor();
  await picker.selectOption("qa-long-history");
  for (const width of [420, 520, 900]) {
    await second.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setBounds({ width, height: 500 }),
      width,
    );
    const overflow = await page.locator(".history-picker").evaluate((el) => {
      const select = el.querySelector("select"),
        arrow = el.querySelector(".picker-arrow");
      return (
        parseFloat(getComputedStyle(select).paddingRight) < 28 ||
        arrow.getBoundingClientRect().right >
          el.getBoundingClientRect().right ||
        el.getBoundingClientRect().right >
          document.querySelector(".new-button").getBoundingClientRect().left
      );
    });
    if (overflow) throw new Error("History picker text/arrow bounds overlap");
    await page
      .locator(".contextbar")
      .screenshot({ path: join(output, `history-${width}.png`) });
  }
  await picker.selectOption("replay-parser");
  checks.push(
    "long Chinese history titles truncate with dedicated arrow space at three widths and selection still works",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByLabel("收起为悬浮条").click();
  await page.locator(".floater").waitFor();
  await settled(page);
  if (
    (await page
      .locator(".floater")
      .evaluate((el) => getComputedStyle(el).animationName)) !== "none"
  )
    throw new Error("Reduced motion did not disable entrance animation");
  checks.push(
    "reduced-motion preference disables entrance effects and preserves final mode",
  );
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(
      {
        ok: true,
        checks,
        window: result,
        idle,
        contrast,
        animationMetrics,
        dragMetrics,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await second.close();
}
