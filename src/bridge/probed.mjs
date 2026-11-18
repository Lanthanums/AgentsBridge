import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, dirname, parse } from "node:path";
import { createHash } from "node:crypto";
import { dataHome } from "./paths.mjs";
const cache = new Map();
export function cliFingerprint(spec) {
  const entry = spec.args?.[0] || spec.command;
  if (!entry || !existsSync(entry)) return null;
  let dir = dirname(entry),
    pkg = null;
  for (let i = 0; i < 4 && dir !== parse(dir).root; i++, dir = dirname(dir)) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      pkg = p;
      break;
    }
  }
  const parts = [entry, ...(pkg ? [pkg] : [])];
  const signature = parts
    .map((p) => `${p}:${statSync(p).size}:${statSync(p).mtimeMs}`)
    .join("|");
  if (cache.has(signature)) return cache.get(signature);
  const h = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const p of parts) {
    const fd = openSync(p, "r");
    try {
      let n;
      while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0)
        h.update(buffer.subarray(0, n));
    } finally {
      closeSync(fd);
    }
  }
  const value = h.digest("hex");
  cache.set(signature, value);
  return value;
}
export function verifiedCapabilities(kind, spec, home = dataHome) {
  try {
    const item = JSON.parse(readFileSync(join(home, "cli-verifications", `${kind}.json`), "utf8"));
    const fingerprint = cliFingerprint(spec);
    return item.verified === true && fingerprint && item.fingerprint === fingerprint
      ? item
      : null;
  } catch {
    return null;
  }
}
