import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
export function sourceVersion() {
  const root = import.meta.dirname;
  const paths = [];
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs") || e.name === "model-profiles.json")
        paths.push({ path: p, name: relative(root, p).replaceAll("\\", "/") });
    }
  }
  walk(root);
  for (const [name, p] of [
    ["@native/process-tree.mjs", join(root, "../../native/process-tree.mjs")],
    ["@native/current.json", join(root, "../../dist/native/current.json")],
  ])
    if (existsSync(p)) paths.push({ path: p, name });
  const hash = createHash("sha256");
  for (const p of paths.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    hash.update(p.name);
    hash.update(readFileSync(p.path));
  }
  return hash.digest("hex").slice(0, 16);
}
