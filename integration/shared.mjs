import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
export const projectRoot = resolve(import.meta.dirname, "..");
export const bridgeScript = join(projectRoot, "src/bridge/mcp.mjs");
export const node = process.execPath;
export const home = homedir();
export const backupRoot = join(
  process.env.LOCALAPPDATA || home,
  "AgentsBridge/mesh-v2/config-backups",
);
export function backup(path, agent) {
  mkdirSync(backupRoot, { recursive: true });
  if (!existsSync(path)) return null;
  const target = join(
    backupRoot,
    `${agent}-${Date.now()}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}.bak`,
  );
  copyFileSync(path, target);
  return target;
}
export function atomicWrite(path, content, agent) {
  mkdirSync(dirname(path), { recursive: true });
  const previous = backup(path, agent);
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, content);
  renameSync(temp, path);
  return { path, backup: previous };
}
export function meshConfig(actor) {
  return {
    command: node,
    args: [bridgeScript],
    env: { AGENTSBRIDGE_AGENT: actor },
  };
}
export function jsonMcpPlan(path, actor) {
  const original = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const value = structuredClone(original);
  value.mcpServers ??= {};
  const removed = [];
  for (const [k, v] of Object.entries(value.mcpServers)) {
    if (/grix/i.test(k) || /grix/i.test(JSON.stringify(v))) {
      delete value.mcpServers[k];
      removed.push(k);
    }
  }
  value.mcpServers.mesh = meshConfig(actor);
  return {
    path,
    value,
    summary: {
      path,
      actor,
      removed_servers: removed,
      mesh: meshConfig(actor),
      preserved_servers: Object.keys(value.mcpServers).filter(
        (k) => k !== "mesh",
      ),
    },
  };
}
