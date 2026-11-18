import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function loadConfig(home) {
  const path = join(home, "config.json");
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const out = {};
  const fields = {
    maxConcurrent: [1, 16],
    queueLimit: [1, 1024],
    queueTimeoutMs: [1000, 3600000],
    quietMs: [100, 3600000],
  };
  for (const [key, [min, max]] of Object.entries(fields))
    if (raw[key] != null) {
      if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max)
        throw new Error(`Invalid config: ${key}`);
      out[key] = raw[key];
    }
  if (raw.hardMs) {
    out.hardMs = { codex: 900000, dsh: 600000, kimi: 900000, cursor: 600000 };
    for (const [k, v] of Object.entries(raw.hardMs)) {
      if (
        !Object.hasOwn(out.hardMs, k) ||
        !Number.isSafeInteger(v) ||
        v < 1000 ||
        v > 86400000
      )
        throw new Error(`Invalid hardMs.${k}`);
      out.hardMs[k] = v;
    }
  }
  return out;
}
