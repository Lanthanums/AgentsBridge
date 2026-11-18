import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { endpointFile, dataHome } from "./paths.mjs";
import { projectRoot } from "./discover.mjs";
import { sourceVersion } from "./version.mjs";
export function endpoint() {
  return JSON.parse(readFileSync(endpointFile, "utf8"));
}
export async function call(method, params = {}, { signal } = {}) {
  const ep = endpoint();
  const r = await fetch(ep.url + "/rpc", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params }),
    signal,
  });
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.error || `HTTP ${r.status}`);
  return body.result;
}
export async function ensureBridge() {
  let status;
  try {
    status = await call("ping", {}, { signal: AbortSignal.timeout(1000) });
  } catch {}
  if (status) {
    if (status.build_id === sourceVersion()) return;
    const snapshot = await call("snapshot");
    const active = snapshot.collaborations.filter((c) =>
      Object.values(c.tasks || {}).some((t) =>
        ["queued", "running", "retrying"].includes(t.state),
      ),
    );
    if (active.length)
      throw new Error(
        `BRIDGE_CODE_CHANGED_WITH_ACTIVE_TASKS: ${active.map((c) => c.id).join(",")}; wait for tasks before restarting`,
      );
    await call("shutdown", { preserve: true });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        await call("ping", {}, { signal: AbortSignal.timeout(200) });
      } catch {
        break;
      }
    }
  }
  const child = spawn(
    process.env.AGENTSBRIDGE_NODE || process.execPath,
    [join(projectRoot, "src/bridge/daemon.mjs")],
    {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, AGENTSBRIDGE_HOME: dataHome },
    },
  );
  child.unref();
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      await call("ping", {}, { signal: AbortSignal.timeout(500) });
      return;
    } catch {}
  }
  throw new Error("Bridge did not start; inspect bridge.log");
}
export async function subscribe(after, onEvent, { signal, collab_id } = {}) {
  const ep = endpoint();
  const r = await fetch(
    `${ep.url}/events?after=${after}${collab_id ? `&collab_id=${encodeURIComponent(collab_id)}` : ""}`,
    { headers: { Authorization: `Bearer ${ep.token}` }, signal },
  );
  if (!r.ok) throw new Error(`Event subscription HTTP ${r.status}`);
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    pending += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      if (line.trim()) {
        const e = JSON.parse(line);
        if (e.type !== "heartbeat") await onEvent(e);
      }
    }
  }
}
