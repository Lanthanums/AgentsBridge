import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  clipboard,
  powerMonitor,
  shell,
} from "electron";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { call, ensureBridge, subscribe } from "../bridge/client.mjs";
import { dataHome, uiPipe } from "../bridge/paths.mjs";
import { projectRoot } from "../bridge/discover.mjs";
import {
  clampBounds,
  dockBounds,
  rightEdgeGap,
  shouldDock,
  inDockZone,
  roundedWindowShape,
} from "./window.mjs";
const replay = process.argv.includes("--replay");
const qa = process.argv.includes("--qa");
const selectedArg = process.argv.indexOf("--collaboration");
const launchedCollaboration =
  selectedArg >= 0 ? process.argv[selectedArg + 1] : null;
let selected = launchedCollaboration;
let pageCache = {},
  pageTicket = 0,
  historyStack = [],
  indexOffset = 0,
  indexTimer;
let followNewCollaborations = !launchedCollaboration;
const stateFile = join(dataHome, "window.json");
mkdirSync(dataHome, { recursive: true });
let win,
  server,
  aborted = false,
  abortController,
  events = [],
  icons = {},
  saved = {},
  floating = false,
  docked = false,
  dockPreview = false,
  dockHint = false,
  dockTransitioning = false,
  dockHoverTimer,
  dockLeaveAt = 0,
  normalBounds,
  connected = false,
  cursor = 0,
  batch = [],
  batchSelection,
  batchTimer,
  dragSession,
  dragTimer,
  topTimer,
  appliedShapeKey = "rect",
  saveTimer,
  inputMonitor,
  monitorState = "off",
  pendingDragCancel,
  lastDragResult;
try {
  saved = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {}
if (saved.layoutVersion !== 4)
  saved = {
    ...saved,
    floater: saved.floater
      ? { ...saved.floater, width: 320, height: 64 }
      : null,
    layoutVersion: 4,
  };
try {
  const runtime = JSON.parse(
    readFileSync(join(projectRoot, "dist/runtime.json"), "utf8"),
  );
  process.env.AGENTSBRIDGE_NODE = runtime.node;
} catch {}
for (const k of ["codex", "dsh", "kimi", "cursor"]) {
  const p = join(projectRoot, "assets/icons", k + ".png");
  if (existsSync(p))
    icons[k] = "data:image/png;base64," + readFileSync(p).toString("base64");
}
const brandPath = join(projectRoot, "assets/app-icon.png");
if (existsSync(brandPath))
  icons.brand =
    "data:image/png;base64," + readFileSync(brandPath).toString("base64");
app.setName("AgentsBridge · 协作便签");
app.setPath("userData", join(dataHome, "gui"));
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {});
function push(payload) {
  if (win && !win.isDestroyed()) win.webContents.send("bridge:update", payload);
}
function snapshot() {
  return {
    type: "bootstrap",
    ...pageCache,
    events: replay ? events : pageCache.history?.events || [],
    icons,
    connected,
    replay,
    selected,
    floating,
    docked,
    dockPreview,
    dockHint,
    transitioning: dockTransitioning,
    dragging: Boolean(dragSession?.moved),
  };
}
function pushDock() {
  push({ type: "dock", docked, dockPreview, dockHint });
}
async function loadPage(id = selected, before) {
  const ticket = ++pageTicket;
  selected = id;
  const result = await call("history", {
    collab_id: id || undefined,
    before,
    index_offset: indexOffset,
  });
  if (ticket !== pageTicket || aborted) return;
  selected = result.collaboration?.id || null;
  if (selected === launchedCollaboration) followNewCollaborations = true;
  pageCache = {
    ...result,
    history: { ...result.history, can_newer: historyStack.length > 0 },
    index_offset: indexOffset,
  };
  cursor = Math.max(cursor, result.cursor);
  batch = batch.filter(
    (e) => e.seq > result.cursor && e.collab_id === selected,
  );
  events = [];
  push(snapshot());
  return snapshot();
}
async function refreshIndex() {
  const index = await call("collaborations", {
    offset: indexOffset,
    limit: 25,
  });
  pageCache = {
    ...pageCache,
    collaborations: index,
    index_offset: indexOffset,
  };
  push({ type: "history-index", index, index_offset: indexOffset });
  return index;
}
function accept(e) {
  if (e.seq <= cursor) return;
  cursor = e.seq;
  if (
    !replay &&
    e.type === "collaboration.started" &&
    followNewCollaborations
  ) {
    historyStack = [];
    void loadPage(e.collab_id).catch((error) =>
      push({ type: "connection", connected: false, error: error.message }),
    );
  }
  if (
    !replay &&
    [
      "collaboration.started",
      "collaboration.state",
      "collaboration.stopped",
      "review.requested",
    ].includes(e.type)
  ) {
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => void refreshIndex().catch(() => {}), 150);
  }
  if (!replay && e.collab_id !== selected) return;
  events.push(e);
  if (!replay && events.length > 256) events.splice(0, events.length - 256);
  batch.push(e);
  if (!batchTimer)
    batchTimer = setTimeout(() => {
      batchTimer = null;
      push({ type: "events", events: batch, selected, collab_id: selected });
      batch = [];
    }, 70);
}
async function connect() {
  while (!aborted) {
    try {
      await ensureBridge();
      // Read one current collaboration and one disk page; never replay the global log into Electron.
      await loadPage(selected, pageCache.history?.before || undefined);
      if (aborted) return;
      connected = true;
      push({ type: "connection", connected });
      abortController = new AbortController();
      await subscribe(cursor, accept, { signal: abortController.signal });
    } catch (error) {
      if (aborted) return;
      connected = false;
      push({ type: "connection", connected, error: error.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function save() {
  if (!win || win.isDestroyed() || dockTransitioning || dragSession) return;
  const bounds = win.getBounds();
  const state = {
    ...saved,
    ...(floating
      ? docked
        ? { dockY: bounds.y }
        : { floater: bounds }
      : { normal: bounds }),
    floating,
    docked,
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  saved = state;
}
// Window geometry is committed once per interaction. Hover never changes mode.
function keepOnTop() {
  if (
    !win ||
    win.isDestroyed() ||
    win.isMinimized() ||
    dragSession ||
    dockTransitioning
  )
    return;
  win.setAlwaysOnTop(true, "screen-saver");
  win.moveTop(); // Reassert z-order without stealing keyboard focus.
}
function stopDockHoverWatcher() {
  clearInterval(dockHoverTimer);
  dockHoverTimer = null;
  dockLeaveAt = 0;
}
function currentDockArea() {
  return screen.getDisplayMatching(win.getBounds()).workArea;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 160);
}
function clipCompactWindow() {
  if (process.platform !== "win32" || dragSession) return;
  const b = win.getBounds();
  const key = floating
    ? `${b.width}:${b.height}:${docked ? 23 : 16}:${screen.getDisplayMatching(b).scaleFactor}`
    : "rect";
  if (key === appliedShapeKey) return;
  win.setShape(
    floating ? roundedWindowShape(b.width, b.height, docked ? 23 : 16) : [],
  );
  appliedShapeKey = key;
}
async function commitGeometry(target) {
  dockTransitioning = true;
  push({ type: "transition", transitioning: true });
  win.setResizable(false);
  win.setMinimumSize(40, 40);
  win.setMaximumSize(4000, 3000);
  // Commit the native geometry once. Opacity/transform animation runs in Chromium's compositor.
  if (!floating) clipCompactWindow();
  win.setBounds(target);
  win.setMinimumSize(floating ? 40 : 420, floating ? 40 : 480);
  win.setMaximumSize(floating ? 520 : 4000, floating ? 100 : 3000);
  win.setResizable(!floating);
  clipCompactWindow();
  dockTransitioning = false;
  push({ type: "transition", transitioning: false });
  save();
}
async function placeDock(preview = false) {
  await commitGeometry(dockBounds(win.getBounds(), currentDockArea(), preview));
}
async function dockToEdge() {
  if (dockTransitioning || !floating || docked) return;
  save();
  docked = true;
  dockHint = dockPreview = false;
  pushDock();
  await placeDock();
  startDockHoverWatcher();
  keepOnTop();
  save();
}
function startDockHoverWatcher() {
  if (dockHoverTimer) return;
  dockHoverTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !docked) return stopDockHoverWatcher();
    if (dragSession || dockTransitioning) return;
    const p = screen.getCursorScreenPoint(),
      b = win.getBounds();
    const inside =
      p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    if (inside) {
      dockLeaveAt = 0;
      if (!dockPreview) void setDockPreview(true);
    } else if (dockPreview) {
      if (!dockLeaveAt) dockLeaveAt = Date.now();
      if (Date.now() - dockLeaveAt >= 320) void setDockPreview(false);
    }
  }, 80);
}
async function setDockPreview(value) {
  if (dockTransitioning || !docked || dragSession || dockPreview === value)
    return;
  dockPreview = value;
  dockLeaveAt = 0;
  pushDock();
  await placeDock(value);
  startDockHoverWatcher();
}
function undockFloater() {
  if (!docked) return;
  setFloater(true);
}
async function setFloater(value) {
  if (dockTransitioning || dragSession) return;
  if (value === floating && !docked) return;
  stopDockHoverWatcher();
  save();
  if (!floating) normalBounds = win.getBounds();
  const anchor = win.getBounds();
  const wasFloating = floating;
  docked = dockPreview = dockHint = false;
  floating = value;
  const desired = value
    ? { ...saved.floater, width: 320, height: 64, y: anchor.y }
    : normalBounds || saved.normal || { width: 520, height: 500 };
  // Keep the right edge and vertical anchor when opening from the ball.
  if (wasFloating && !value) {
    desired.x = anchor.x + anchor.width - desired.width;
    desired.y = anchor.y;
  }
  push({ type: "window", floating, docked, dockPreview, dockHint });
  await commitGeometry(
    clampBounds(
      desired,
      screen.getAllDisplays().map((d) => d.workArea),
      currentDockArea(),
      value,
    ),
  );
  keepOnTop();
  save();
}
function legal() {
  if (!win || win.isDestroyed()) return;
  if (docked) placeDock(dockPreview);
  else
    win.setBounds(
      clampBounds(
        floating
          ? { ...win.getBounds(), width: 320, height: 64 }
          : win.getBounds(),
        screen.getAllDisplays().map((d) => d.workArea),
        screen.getPrimaryDisplay().workArea,
        floating,
      ),
    );
  clipCompactWindow();
  keepOnTop();
  save();
}
function handleMove() {
  if (!dockTransitioning && !dragSession) scheduleSave();
}
function stopInputMonitor() {
  const process = inputMonitor;
  inputMonitor = null;
  monitorState = "off";
  pendingDragCancel = null;
  process?.kill();
}
function watchNativeRelease() {
  if (process.platform !== "win32") return;
  try {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, "dist/native/window-input.json"), "utf8"),
    );
    const point = screen.dipToScreenPoint(dragSession.point);
    const threshold = Math.round(
      6 * screen.getDisplayNearestPoint(dragSession.point).scaleFactor,
    );
    const monitor = spawn(
      join(projectRoot, "dist/native", manifest.file),
      [
        win.getNativeWindowHandle().readBigUInt64LE().toString(),
        String(point.x),
        String(point.y),
        String(threshold),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    inputMonitor = monitor;
    monitorState = "pending";
    let buffer = "";
    monitor.stdout.on("data", (chunk) => {
      if (inputMonitor !== monitor) return;
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n"),
          state = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (state === "held") {
          monitorState = "held";
          if (dragSession) dragSession.native = true;
          traceDrag({ type: "native-held" });
        } else if (state === "moved") {
          if (dragSession) {
            dragSession.moved = true;
            push({ type: "drag", dragging: true });
          }
        } else if (state.startsWith("stats ")) {
          traceDrag({ type: "native-stats", sample: state });
        } else if (state === "released") {
          stopInputMonitor();
          void endDrag("native-release");
        } else if (state === "not-held") {
          const cancel = pendingDragCancel;
          stopInputMonitor();
          if (cancel) void endDrag(cancel);
        }
      }
    });
    const unavailable = () => {
      if (inputMonitor !== monitor) return;
      const cancel = pendingDragCancel;
      stopInputMonitor();
      if (cancel) void endDrag(cancel);
    };
    monitor.on("error", unavailable);
    monitor.on("exit", unavailable);
  } catch (error) {
    traceDrag({ type: "native-monitor-unavailable", error: error.message });
    console.warn("Native drag release monitor unavailable:", error.message);
    monitorState = "off";
  }
}
function traceDrag(data) {
  if (qa) (globalThis.dragTrace ||= []).push({ at: Date.now(), ...data });
}
function beginDrag() {
  if (dockTransitioning || !floating || dragSession) return;
  stopDockHoverWatcher();
  lastDragResult = null;
  dragSession = {
    point: screen.getCursorScreenPoint(),
    bounds: {
      ...win.getBounds(),
      width: docked ? (dockPreview ? 224 : 45) : 320,
      height: docked ? 45 : 64,
    },
    moved: false,
    fromDock: docked,
    native: false,
    lastX: 0,
    lastY: 0,
  };
  traceDrag({
    type: "start",
    point: dragSession.point,
    bounds: dragSession.bounds,
    docked,
    dockPreview,
  });
  watchNativeRelease();
  dragTimer = setInterval(updateDrag, 16);
  return { started: true };
}
function updateDrag() {
  if (!dragSession || !win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint(),
    d = dragSession;
  // The native worker starts from the original window bounds; do not move it twice during startup.
  if (monitorState === "pending") return;
  if (d.native) {
    const area = screen.getDisplayNearestPoint(p).workArea;
    const hint = d.fromDock
      ? inDockZone(p, area)
      : rightEdgeGap(win.getBounds(), area) <= 12;
    if (hint !== dockHint) {
      dockHint = hint;
      pushDock();
    }
    return;
  }
  const dx = p.x - d.point.x,
    dy = p.y - d.point.y;
  if (!d.moved && Math.hypot(dx, dy) < 6) return;
  if (dx === d.lastX && dy === d.lastY) return;
  d.moved = true;
  d.lastX = dx;
  d.lastY = dy;
  // Keep the captured button mounted throughout the gesture, including ball drags.
  win.setBounds({ ...d.bounds, x: d.bounds.x + dx, y: d.bounds.y + dy });
  const hint = rightEdgeGap(win.getBounds(), currentDockArea()) <= 12;
  if (hint !== dockHint) {
    dockHint = hint;
    pushDock();
  }
}
async function endDrag(reason = "pointer-up") {
  if (!dragSession) {
    if (
      reason === "pointer-up" &&
      lastDragResult &&
      Date.now() - lastDragResult.at < 300
    ) {
      const result = lastDragResult;
      lastDragResult = null;
      return result;
    }
    return { moved: false, started: false };
  }
  if (
    ["pointer-cancel", "lost-capture", "native-blur", "renderer-blur"].includes(
      reason,
    ) &&
    inputMonitor &&
    monitorState !== "off"
  ) {
    pendingDragCancel = reason;
    return { moved: true, started: true, deferred: true };
  }
  stopInputMonitor();
  updateDrag(); // Include the final movement even if released between timer ticks.
  clearInterval(dragTimer);
  dragTimer = null;
  const moved = Boolean(dragSession?.moved);
  const fromDock = dragSession.fromDock;
  traceDrag({ type: "end", reason, moved, bounds: win.getBounds() });
  dragSession = null;
  push({ type: "drag", dragging: false });
  if (moved && fromDock) {
    const b = win.getBounds(),
      point = screen.getCursorScreenPoint(),
      area = screen.getDisplayNearestPoint(point).workArea;
    if (inDockZone(point, area)) {
      await placeDock(false);
      dockPreview = false;
    } else {
      // Dragging the ball away reveals a strip while preserving the pointer anchor.
      docked = dockPreview = false;
      push({ type: "window", floating, docked, dockPreview, dockHint });
      await commitGeometry(
        clampBounds(
          { x: b.x, y: b.y, width: 320, height: 64 },
          screen.getAllDisplays().map((d) => d.workArea),
          area,
          true,
        ),
      );
    }
  } else if (moved) {
    if (shouldDock(win.getBounds(), currentDockArea(), moved))
      await dockToEdge();
    else legal();
  } else if (docked && dockPreview) {
    // A cancelled press must not leave the hover watcher stopped.
    setTimeout(() => {
      if (docked && !dragSession && !dockTransitioning) {
        dockPreview = false;
        void setDockPreview(true);
      }
    }, 250);
  }
  dockHint = false;
  pushDock();
  clipCompactWindow();
  if (docked) startDockHoverWatcher();
  save();
  lastDragResult = { moved, started: true, at: Date.now() };
  return lastDragResult;
}
app.whenReady().then(async () => {
  const bounds = clampBounds(
    saved.normal || { width: 520, height: 500 },
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
    false,
  );
  win = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 480,
    icon: join(projectRoot, "assets/app-icon.png"),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    show: false,
    skipTaskbar: false,
    roundedCorners: false,
    hasShadow: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  keepOnTop();
  // Transparent Windows surfaces do not always propagate native visibility to Chromium.
  const syncPresentationVisibility = () => {
    if (win.isDestroyed()) return;
    const hidden = !win.isVisible() || win.isMinimized();
    void win.webContents
      .executeJavaScript(
        `document.documentElement.toggleAttribute("data-native-hidden", ${hidden});
       window.dispatchEvent(new Event("agentsbridge-visibilitychange"));`,
      )
      .catch(() => {});
  };
  for (const event of ["show", "hide", "minimize", "restore"])
    win.on(event, syncPresentationVisibility);
  // Windows can reorder topmost windows on restore, shell changes or resume.
  for (const event of ["show", "restore", "leave-full-screen"])
    win.on(event, keepOnTop);
  win.on("always-on-top-changed", (_event, onTop) => {
    if (!onTop) setImmediate(keepOnTop);
  });
  powerMonitor.on("resume", keepOnTop);
  powerMonitor.on("unlock-screen", keepOnTop);
  topTimer = setInterval(keepOnTop, 5000);
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("move", handleMove);
  win.on("resize", () => {
    // Never replace a window region during native resize or pointer capture.
    if (!dockTransitioning && !dragSession) scheduleSave();
  });
  win.on("blur", () => {
    if (dragSession) void endDrag("native-blur");
  });
  win.on("close", (event) => {
    save();
    if (!replay && selected && !aborted) {
      event.preventDefault();
      aborted = true;
      void call(
        "uiClosed",
        { collab_id: selected },
        { signal: AbortSignal.timeout(1500) },
      )
        .catch(() => {})
        .finally(() => {
          win.destroy();
          app.quit();
        });
    }
  });
  server = net.createServer((s) => {
    s.once("data", () => s.end("ok\n"));
  });
  server.on("error", () => {});
  server.listen(uiPipe);
  screen.on("display-removed", legal);
  screen.on("display-metrics-changed", legal);
  if (replay) {
    const p = process.argv[process.argv.indexOf("--replay") + 1];
    const path =
      p && !p.startsWith("--")
        ? p
        : join(projectRoot, "fixtures/ui-replay.jsonl");
    events = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    if (qa) {
      globalThis.replayAll = events;
      events = events.slice(0, 8);
    }
    cursor = events.at(-1)?.seq || 0;
    connected = false;
  } else void connect();
  if (saved.floating && saved.docked && !qa) {
    floating = true;
    docked = true;
    win.setResizable(false);
    win.setMinimumSize(40, 40);
    win.setMaximumSize(520, 100);
    win.setBounds(
      dockBounds({ y: saved.dockY ?? 20 }, screen.getPrimaryDisplay().workArea),
    );
  }
  clipCompactWindow();
  await win.loadFile(join(projectRoot, "dist/ui/index.html"));
  win.showInactive();
  if (docked) startDockHoverWatcher();
  keepOnTop();
  if (saved.floating && !qa && !docked) setFloater(true);
});
ipcMain.handle("bridge:snapshot", () =>
  replay || !pageCache.history
    ? snapshot()
    : loadPage(selected, pageCache.history?.before || undefined),
);
ipcMain.handle("bridge:request", async (_event, method, params = {}) => {
  if (method === "selected") {
    if (replay) {
      selected = params.id;
      return { ok: true };
    }
    if (selected === params.id && pageCache.collaboration?.id === params.id)
      return { ok: true };
    historyStack = [];
    await loadPage(params.id);
    return { ok: true };
  }
  if (!replay && method === "historyPage") {
    if (params.direction === "older" && pageCache.history?.has_older) {
      historyStack.push(pageCache.history.before);
      await loadPage(selected, pageCache.history.oldest);
    } else if (params.direction === "newer" && historyStack.length)
      await loadPage(selected, historyStack.pop() || undefined);
    else if (params.direction === "latest") {
      historyStack = [];
      await loadPage(selected);
    }
    return { ok: true };
  }
  if (!replay && method === "historyIndex") {
    indexOffset = Math.max(
      0,
      indexOffset + (params.direction === "older" ? 25 : -25),
    );
    return refreshIndex();
  }
  if (replay) {
    if (method === "replayNext" && qa) {
      const next = globalThis.replayAll
        .filter((e) => e.seq > cursor)
        .slice(0, params.count || 1);
      next.forEach(accept);
      return { count: next.length };
    }
    if (method === "stop") {
      const e = {
        schema_version: 2,
        seq: ++cursor,
        id: `replay-stop-${cursor}`,
        time: new Date().toISOString(),
        type: "collaboration.stopped",
        collab_id: params.collab_id,
        epoch: params.epoch + 1,
        data: { reason: "replay_user" },
      };
      events.push(e);
      push({ type: "events", events: [e] });
      return { state: "stopped" };
    }
    if (method === "readRef") {
      try {
        return readFileSync(params.path, "utf8");
      } catch {
        return "回放记录没有附带完整输出。";
      }
    }
    throw new Error("事件回放模式不执行真实协作控制");
  }
  if (
    ![
      "create",
      "send",
      "stop",
      "review",
      "reviewArtifact",
      "retryTask",
      "complete",
      "readRef",
      "capabilities",
      "deliver",
      "modelOptions",
      "taskEvents",
    ].includes(method)
  )
    throw new Error("Unsupported UI action");
  return call(method, params);
});
ipcMain.on("bridge:window", async (_event, action) => {
  if (["dock", "floater", "expand", "undock"].includes(action)) {
    while (dockTransitioning && !aborted)
      await new Promise((resolve) => setTimeout(resolve, 16));
    if (aborted || !win || win.isDestroyed()) return;
  }
  if (action === "dock") dockToEdge();
  if (action === "minimize") win.minimize();
  if (action === "floater") setFloater(true);
  if (action === "expand") setFloater(false);
  if (action === "undock") void undockFloater();
  if (action === "close") win.close();
});
ipcMain.handle("bridge:drag-start", () => beginDrag());
ipcMain.handle("bridge:drag-end", (_event, reason) => endDrag(reason));
ipcMain.handle("bridge:dock-preview", (_event, value = true) =>
  setDockPreview(value),
);
ipcMain.handle("bridge:copy", (_event, text) => {
  clipboard.writeText(String(text));
  return true;
});
ipcMain.handle("bridge:artifact", async (_event, eventId, folder) => {
  const e = replay ? events.find(
    (e) => e.id === eventId && e.type === "artifact.delivered",
  ) : await call("artifact",{event_id:eventId,collab_id:selected});
  if (!e) throw new Error("Unknown artifact");
  const path = e.data.path;
  if (
    createHash("sha256").update(readFileSync(path)).digest("hex") !==
    e.data.sha256
  )
    throw new Error("文件内容已变化，哈希不匹配");
  if (folder) shell.showItemInFolder(path);
  else {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  }
  return true;
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  aborted = true;
  clearTimeout(saveTimer);
  stopInputMonitor();
  clearInterval(topTimer);
  clearInterval(dragTimer);
  stopDockHoverWatcher();
  abortController?.abort();
  server?.close();
  clearTimeout(batchTimer);
});
