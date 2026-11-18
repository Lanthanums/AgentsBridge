import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
const home = homedir();
const local = process.env.LOCALAPPDATA || join(home, "AppData/Local");
const npm = join(
  process.env.APPDATA || join(home, "AppData/Roaming"),
  "npm/node_modules",
);
function newest(dir, file) {
  if (!existsSync(dir)) return null;
  return (
    readdirSync(dir)
      .map((n) => join(dir, n, file))
      .filter(existsSync)
      .sort(
        (a, b) => statSync(dirname(b)).mtimeMs - statSync(dirname(a)).mtimeMs,
      )[0] || null
  );
}
function pathExe(names) {
  for (const dir of (process.env.PATH || "").split(";"))
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  return null;
}
export function discover() {
  const specs = {
    codex: {
      command:
        process.env.MESH_CODEX_EXE ||
        newest(join(local, "OpenAI/Codex/bin"), "codex.exe"),
      args: [],
    },
    dsh: {
      command: process.execPath,
      args: [
        process.env.MESH_DSH_BIN || join(npm, "@deepseek-ai/dsh/lib/bin.js"),
      ],
    },
    kimi: {
      command: process.execPath,
      args: [
        process.env.MESH_KIMI_MAIN ||
          join(npm, "@moonshot-ai/kimi-code/dist/main.mjs"),
      ],
    },
    cursor: {
      command:
        process.env.MESH_CURSOR_EXE ||
        newest(join(local, "cursor-agent/versions"), "node.exe"),
      args: [],
    },
    claude: {
      command: process.env.MESH_CLAUDE_EXE || pathExe(["claude.exe"]),
      args: [],
    },
    gemini: {
      command:
        process.env.MESH_GEMINI_EXE ||
        (existsSync(join(npm, "@google/gemini-cli/dist/index.js"))
          ? process.execPath
          : null),
      args: [join(npm, "@google/gemini-cli/dist/index.js")],
    },
  };
  // Cursor's official Windows distribution bundles Node and an entrypoint. Never drive its TUI.
  const cursorMain = newest(join(local, "cursor-agent/versions"), "index.js");
  if (cursorMain && !process.env.MESH_CURSOR_EXE) {
    specs.cursor.command = join(dirname(cursorMain), "node.exe");
    specs.cursor.args = [cursorMain];
  }
  return Object.fromEntries(
    Object.entries(specs).map(([k, s]) => [
      k,
      {
        ...s,
        available: Boolean(
          s.command &&
          existsSync(s.command) &&
          s.args.every((p) => existsSync(p)),
        ),
        resolvedAt: new Date().toISOString(),
      },
    ]),
  );
}
export const projectRoot = resolve(import.meta.dirname, "../..");
