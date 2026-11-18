import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { home, node, bridgeScript, atomicWrite } from "../shared.mjs";
import { sourceVersion } from "../../src/bridge/version.mjs";
export function plan(file = join(home, ".codex/config.toml")) {
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const removed = new Set();
  let skip = false;
  const kept = [];
  for (const line of old.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      const m = header[1].match(
        /^mcp_servers\.((?:"[^"]+")|(?:'[^']+')|(?:[^.]+))(?:\.|$)/,
      );
      const name = m?.[1].replace(/^['"]|['"]$/g, "");
      skip = Boolean(name && (name === "mesh" || /grix/i.test(name)));
      if (skip) removed.add(name);
    }
    if (!skip) kept.push(line);
  }
  const block = `[mcp_servers.mesh]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(bridgeScript)}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\n\n[mcp_servers.mesh.env]\nAGENTSBRIDGE_AGENT = "codex"\nAGENTSBRIDGE_PROTOCOL_VERSION = "2"\nAGENTSBRIDGE_RUNTIME_BUILD = "${sourceVersion()}"\n`;
  const value = kept.join("\n").trimEnd() + "\n\n" + block;
  return {
    file,
    old,
    value,
    summary: {
      path: file,
      actor: "codex",
      removed_sections: [...removed],
      command: node,
      args: [bridgeScript],
      changed: old !== value,
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = plan();
  const install = process.argv.includes("--install");
  if (install && result.old !== result.value)
    result.summary.write = atomicWrite(result.file, result.value, "codex");
  console.log(JSON.stringify({ mode: install ? "install" : "dry-run", ...result.summary }, null, 2));
}
