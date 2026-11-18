import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicWrite, bridgeScript, jsonMcpPlan, meshConfig } from '../shared.mjs';

const actor = 'kimi';
const requiredNode = process.execPath;
const install = process.argv.slice(2).includes('--install');
const unknownArgs = process.argv.slice(2).filter(arg => arg !== '--install');
const configRoot = process.env.KIMI_CODE_HOME
  ? resolve(process.env.KIMI_CODE_HOME)
  : join(homedir(), '.kimi-code');
const configPath = join(configRoot, 'mcp.json');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOriginal(path) {
  if (!existsSync(path)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Invalid JSON in ${configPath}; no changes made.`);
  }
  if (!isRecord(value) || (value.mcpServers !== undefined && !isRecord(value.mcpServers))) {
    throw new Error(`Expected an object with an object-valued mcpServers in ${configPath}; no changes made.`);
  }
  return value;
}

try {
  if (unknownArgs.length) throw new Error(`Unknown argument: ${unknownArgs[0]}; use --install or omit arguments for dry-run.`);
  if (!existsSync(requiredNode)) throw new Error(`Required Node executable not found: ${requiredNode}`);
  if (!existsSync(bridgeScript)) throw new Error(`AgentsBridge MCP entrypoint not found: ${bridgeScript}`);

  const original = readOriginal(configPath);
  const plan = jsonMcpPlan(configPath, actor);
  const mesh = meshConfig(actor);
  mesh.command = requiredNode;
  mesh.args = [bridgeScript];
  plan.value.mcpServers.mesh = mesh;

  const changed = JSON.stringify(original) !== JSON.stringify(plan.value);
  const summary = {
    mode: install ? 'install' : 'dry-run',
    result: changed ? (install ? 'installed' : 'would_install') : 'unchanged',
    config_path: configPath,
    owning_config_source: process.env.KIMI_CODE_HOME ? 'KIMI_CODE_HOME' : 'default_user_home',
    changed,
    mesh,
    removed_servers: plan.summary.removed_servers,
    preserved_servers: Object.keys(plan.value.mcpServers).filter(name => name !== 'mesh'),
    backup: null,
    would_backup: changed && existsSync(configPath),
  };

  if (install && changed) {
    summary.backup = atomicWrite(configPath, `${JSON.stringify(plan.value, null, 2)}\n`, actor).backup;
  }
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(`KIMI_MCP_INSTALL_FAILED: ${error.message}`);
  process.exitCode = 1;
}
