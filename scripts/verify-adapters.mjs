import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createAdapter } from "../src/bridge/adapters/index.mjs";
import { discover } from "../src/bridge/discover.mjs";
import { dataHome } from "../src/bridge/paths.mjs";
import { cliFingerprint } from "../src/bridge/probed.mjs";

const supported = ["codex", "dsh", "kimi", "cursor"];
const requested = process.argv.slice(2);
if (!requested.length || requested.some((kind) => !supported.includes(kind))) {
  console.error(`Usage: npm run verify:adapters -- ${supported.join(" ")} (select one or more; makes live model calls)`);
  process.exit(2);
}

async function bounded(operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), 120000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const specs = discover();
for (const kind of new Set(requested)) {
  const workspace = mkdtempSync(join(tmpdir(), `agentsbridge-probe-${kind}-`));
  const marker = randomBytes(6).toString("hex");
  let adapter;
  try {
    const fingerprint = cliFingerprint(specs[kind]);
    if (!specs[kind].available || !fingerprint) throw new Error("CLI_NOT_INSTALLED");
    adapter = createAdapter(kind, { specs, probe: true });
    await bounded(() => adapter.start({ cwd: workspace }), "START");
    const first = await bounded(() => adapter.send(
      `AgentsBridge transport check. Do not use tools, change files or delegate. Remember ${marker} and reply only with that code.`,
    ), "FIRST_TURN");
    if (!first.session_id || !first.text.includes(marker)) throw new Error("FIRST_TURN_UNVERIFIED");
    await adapter.destroy();
    adapter = createAdapter(kind, { specs, probe: true });
    await bounded(() => adapter.start({ cwd: workspace, sessionId: first.session_id }), "RESUME");
    const second = await bounded(() => adapter.send(
      "Do not use tools or delegate. Reply only with the exact code you were asked to remember in the previous turn.",
    ), "RESUMED_TURN");
    if (second.session_id !== first.session_id || !second.text.includes(marker))
      throw new Error("RESUME_UNVERIFIED");
    await adapter.destroy();
    adapter = undefined;
    if (cliFingerprint(specs[kind]) !== fingerprint) throw new Error("CLI_CHANGED_DURING_PROBE");
    const directory = join(dataHome, "cli-verifications");
    mkdirSync(directory, { recursive: true });
    const staged = join(directory, `${kind}-${process.pid}-${marker}.tmp`);
    writeFileSync(staged, JSON.stringify({ verified: true, fingerprint, probed_at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(staged, join(directory, `${kind}.json`));
    console.log(`${kind}: verified fresh and resumed sessions`);
  } catch (error) {
    console.error(`${kind}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (adapter) {
      try {
        await adapter.destroy();
      } catch (error) {
        console.error(`${kind}: cleanup failed: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
}
