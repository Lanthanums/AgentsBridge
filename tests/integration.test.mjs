import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../integration/codex/install.mjs";
import { jsonMcpPlan } from "../integration/shared.mjs";
test("Codex migration removes only mesh/Grix tables and preserves other settings; repeated plan converges", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-toml-")),
    file = join(dir, "config.toml");
  writeFileSync(
    file,
    'model="same"\n[mcp_servers.other]\ncommand="keep"\n[mcp_servers.mesh]\ncommand="old"\n[mcp_servers.mesh.env]\nOLD="remove"\n[mcp_servers.grix-old]\nurl="remove"\n[mcp_servers.grix-old.env]\nSECRET="remove"\n[features]\nkeep=true\n',
  );
  const p = plan(file);
  assert.match(p.value, /model="same"/);
  assert.match(p.value, /command="keep"/);
  assert.match(p.value, /keep=true/);
  assert.doesNotMatch(p.value, /OLD=|SECRET=|grix-old/);
  writeFileSync(file, p.value);
  assert.equal(plan(file).summary.changed, false);
});
test("JSON harness merge preserves unrelated nested fields and removes old dependencies without writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-json-")),
    file = join(dir, "mcp.json");
  const original = {
    setting: { keep: 1 },
    mcpServers: {
      other: { env: { KEEP: "unchanged" } },
      grix: { command: "old" },
      mesh: { args: ["old"] },
    },
  };
  writeFileSync(file, JSON.stringify(original));
  const p = jsonMcpPlan(file, "kimi");
  assert.equal(p.value.setting.keep, 1);
  assert.deepEqual(p.value.mcpServers.other, original.mcpServers.other);
  assert.ok(!p.value.mcpServers.grix);
  assert.equal(p.value.mcpServers.mesh.env.AGENTSBRIDGE_AGENT, "kimi");
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(original));
});
