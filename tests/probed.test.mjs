import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliFingerprint, verifiedCapabilities } from "../src/bridge/probed.mjs";

test("CLI verification requires a local proof for the exact executable", (context) => {
  const home = mkdtempSync(join(tmpdir(), "ab-probed-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const spec = { command: join(home, "test-cli.exe"), args: [] };
  const directory = join(home, "cli-verifications");
  const file = join(directory, "codex.json");
  writeFileSync(spec.command, "demo CLI");
  assert.equal(verifiedCapabilities("codex", spec, home), null);
  mkdirSync(directory);
  writeFileSync(file, "{bad json");
  assert.equal(verifiedCapabilities("codex", spec, home), null);
  writeFileSync(file, JSON.stringify({ verified: true, fingerprint: null }));
  assert.equal(verifiedCapabilities("codex", { command: "" }, home), null);
  const proof = { verified: true, fingerprint: cliFingerprint(spec) };
  writeFileSync(file, JSON.stringify(proof));
  assert.deepEqual(verifiedCapabilities("codex", spec, home), proof);
  assert.equal(verifiedCapabilities("dsh", spec, home), null);
  writeFileSync(spec.command, "new CLI build");
  assert.equal(verifiedCapabilities("codex", spec, home), null);
});
