import net from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { uiPipeFor } from "./paths.mjs";
import { projectRoot } from "./discover.mjs";
export function uiLauncher(log) {
  const dataHome = log.home,
    uiPipe = uiPipeFor(dataHome);
  let pending = null;
  const closed = new Set();
  async function ping() {
    return await new Promise((resolve) => {
      const s = net.createConnection(uiPipe);
      const timer = setTimeout(() => {
        s.destroy();
        resolve(false);
      }, 500);
      s.once("connect", () => s.write("ping\n"));
      s.once("data", () => {
        clearTimeout(timer);
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }
  const ensure = async (c) => {
    if (
      process.env.AGENTSBRIDGE_NO_UI === "1" ||
      closed.has(c.id) ||
      log.index.uiClosed(c.id)
    )
      return;
    if (pending) return pending;
    pending = (async () => {
      if (await ping()) return;
      let runtime = {};
      try {
        runtime = JSON.parse(
          readFileSync(join(projectRoot, "dist/runtime.json"), "utf8"),
        );
      } catch {}
      const electron =
        runtime.electron ||
        join(projectRoot, "node_modules/electron/dist/electron.exe");
      if (
        !existsSync(electron) ||
        !existsSync(join(projectRoot, "dist/desktop/main.mjs"))
      )
        throw new Error("UI build missing; events retained");
      const env = { ...process.env, AGENTSBRIDGE_HOME: dataHome };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = [projectRoot, "--collaboration", c.id];
      if (process.env.AGENTSBRIDGE_UI_DEBUG_PORT)
        args.push(
          `--remote-debugging-port=${Number(process.env.AGENTSBRIDGE_UI_DEBUG_PORT)}`,
        );
      const child = spawn(electron, args, {
        cwd: projectRoot,
        env,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.unref();
      await new Promise((res, rej) => {
        child.once("error", rej);
        setTimeout(res, 1500);
      });
    })();
    try {
      await pending;
    } finally {
      pending = null;
    }
  };
  ensure.closed = (c) => closed.add(c);
  return ensure;
}
