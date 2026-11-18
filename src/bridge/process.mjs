import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const nativeDir = join(import.meta.dirname, "../../dist/native");
const jobHost = join(
  nativeDir,
  existsSync(join(nativeDir, "current.json"))
    ? JSON.parse(readFileSync(join(nativeDir, "current.json"), "utf8")).file
    : "jobhost.exe",
);
export async function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  const closed = once(child, "close").catch(() => {});
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    const code = await new Promise((resolve) => {
      killer.once("close", resolve);
      killer.once("error", () => resolve(-1));
    });
    if (code !== 0 && child.exitCode === null) child.kill("SIGKILL");
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  if (child.exitCode !== null || child.signalCode) return;
  let timer;
  await Promise.race([
    closed,
    new Promise((r) => {
      timer = setTimeout(r, 3000);
    }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && !child.signalCode)
    throw new Error(`PROCESS_TREE_TERMINATION_UNCONFIRMED: ${child.pid}`);
}
export function launch(
  spec,
  args,
  { cwd, env = {}, onLine = () => {}, onErrorLine = () => {} } = {},
) {
  if (!spec?.available && !spec?.command)
    throw new Error("CLI unavailable; run npm run probe");
  const childEnv = {
    ...process.env,
    ...env,
    AGENTSBRIDGE_PARENT_PID: String(process.pid),
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const wrapped = process.platform === "win32" && existsSync(jobHost);
  if (process.platform === "win32" && !wrapped)
    throw new Error("NATIVE_PROCESS_CONTAINER_MISSING: npm run build");
  const child = spawn(
    wrapped ? jobHost : spec.command,
    [...(wrapped ? [spec.command] : []), ...(spec.args || []), ...args],
    {
      cwd,
      env: childEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  for (const [stream, receive] of [
    [child.stdout, onLine],
    [child.stderr, onErrorLine],
  ]) {
    let pending = "";
    let invalid = false;
    const maxLineBytes = 8 * 1024 * 1024;
    const acceptLine = (line) => {
      if (invalid) return;
      if (Buffer.byteLength(line) > maxLineBytes) {
        invalid = true;
        pending = "";
        child.emit("protocolError", new Error("JSONL line exceeds 8 MiB"));
        return;
      }
      receive(line.replace(/\r$/, ""));
    };
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk) => {
      if (invalid) return;
      pending += decoder.write(chunk);
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        acceptLine(pending.slice(0, i));
        if (invalid) return;
        pending = pending.slice(i + 1);
      }
      if (Buffer.byteLength(pending) > maxLineBytes) acceptLine(pending);
    });
    stream.on("end", () => {
      pending += decoder.end();
      if (pending) acceptLine(pending);
    });
  }
  return child;
}
export class Rpc extends EventEmitter {
  constructor(spec, args, options = {}) {
    super();
    this.next = 0;
    this.pending = new Map();
    this.stderr = [];
    this.child = launch(spec, args, {
      ...options,
      onLine: (line) => {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        this.emit("raw", m);
        if (m.id !== undefined && !m.method) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            m.error
              ? p.reject(new Error(JSON.stringify(m.error)))
              : p.resolve(m.result);
          }
        } else this.emit("message", m);
      },
      onErrorLine: (l) => {
        this.stderr.push(l);
        if (this.stderr.length > 100) this.stderr.shift();
      },
    });
    const fail = (error) => {
      if (this.dead) return;
      this.dead = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.emit("dead", error);
    };
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.on("protocolError", fail);
    this.child.on("close", (code) =>
      fail(
        new Error(`CLI exited ${code}: ${this.stderr.slice(-4).join("\n")}`),
      ),
    );
  }
  async write(m) {
    if (this.dead) throw new Error("CLI closed");
    if (!this.child.stdin.write(JSON.stringify(m) + "\n"))
      await once(this.child.stdin, "drain");
  }
  request(method, params = {}, timeoutMs = 30000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  notify(method, params = {}) {
    return this.write({ jsonrpc: "2.0", method, params });
  }
  reply(id, result) {
    return this.write({ jsonrpc: "2.0", id, result });
  }
  async destroy() {
    await killTree(this.child);
  }
}
