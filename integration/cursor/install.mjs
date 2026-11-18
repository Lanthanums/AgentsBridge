import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, bridgeScript, jsonMcpPlan, meshConfig, projectRoot } from '../shared.mjs';

export const actor = 'cursor';
export const requiredNode = process.execPath;

export function userConfigPath(home = homedir()) {
  return join(home, '.cursor', 'mcp.json');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readOriginal(path) {
  if (!existsSync(path)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Invalid JSON in ${path}; no changes made.`);
  }
  if (!isRecord(value) || (value.mcpServers !== undefined && !isRecord(value.mcpServers))) {
    throw new Error(`Expected an object with an object-valued mcpServers in ${path}; no changes made.`);
  }
  return value;
}

export function desiredMesh() {
  const mesh = meshConfig(actor);
  mesh.command = requiredNode;
  mesh.args = [bridgeScript];
  return mesh;
}

export function buildPlan(configPath) {
  const original = readOriginal(configPath);
  const plan = jsonMcpPlan(configPath, actor);
  const mesh = desiredMesh();
  plan.value.mcpServers.mesh = mesh;
  return {
    path: configPath,
    mesh,
    changed: JSON.stringify(original) !== JSON.stringify(plan.value),
    removed_servers: plan.summary.removed_servers,
    preserved_servers: Object.keys(plan.value.mcpServers).filter(name => name !== 'mesh'),
    value: plan.value,
    existed: existsSync(configPath),
  };
}

function cursorCliVersion() {
  try {
    const root = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'cursor-agent', 'versions');
    if (!existsSync(root)) return null;
    const found = readdirSync(root)
      .filter(name => existsSync(join(root, name, 'index.js')))
      .sort((a, b) => statSync(join(root, b, 'index.js')).mtimeMs - statSync(join(root, a, 'index.js')).mtimeMs);
    return found[0] ?? null;
  } catch {
    return null;
  }
}

function projectMcpSummary() {
  const path = join(projectRoot, '.cursor', 'mcp.json');
  const summary = {
    path,
    exists: existsSync(path),
    precedence: 'project_overrides_user_for_same_server_name',
  };
  if (!summary.exists) return summary;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const servers = isRecord(value) && isRecord(value.mcpServers) ? Object.keys(value.mcpServers) : [];
    summary.server_names = servers;
    summary.has_mesh = servers.includes('mesh');
    summary.grix_server_names = servers.filter(name => /grix/i.test(name));
  } catch {
    summary.json = 'invalid';
  }
  return summary;
}

function parseArgs(argv) {
  let install = false;
  let configPath = userConfigPath();
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--install') install = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--config') {
      const next = args[++i];
      if (!next) throw new Error('Missing path after --config.');
      configPath = resolve(next);
    } else if (arg.startsWith('--config=')) configPath = resolve(arg.slice('--config='.length));
    else throw new Error(`Unknown argument: ${arg}; use --install or omit arguments for dry-run.`);
  }
  return { help: false, install, configPath };
}

const HELP = `AgentsBridge MCP installer for Cursor

Usage:
  node install.mjs                 Dry-run the user config. Writes nothing.
  node install.mjs --install       Write the user config if it differs.
  node install.mjs --config <path> Plan or write a fixture file instead.

Default target: %USERPROFILE%\\.cursor\\mcp.json
`;

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log(HELP);
      return;
    }
    if (!existsSync(requiredNode)) throw new Error(`Required Node executable not found: ${requiredNode}`);
    if (!existsSync(bridgeScript)) throw new Error(`AgentsBridge MCP entrypoint not found: ${bridgeScript}`);

    const plan = buildPlan(args.configPath);
    const summary = {
      mode: args.install ? 'install' : 'dry-run',
      result: plan.changed ? (args.install ? 'installed' : 'would_install') : 'unchanged',
      config_path: plan.path,
      config_exists: plan.existed,
      changed: plan.changed,
      mesh: plan.mesh,
      removed_servers: plan.removed_servers,
      preserved_servers: plan.preserved_servers,
      backup: null,
      would_backup: plan.changed && plan.existed,
      cli_version: cursorCliVersion(),
      cursor_config_dir: process.env.CURSOR_CONFIG_DIR ? 'set' : 'unset',
      project_mcp: projectMcpSummary(),
    };
    if (args.install && plan.changed) {
      summary.backup = atomicWrite(plan.path, `${JSON.stringify(plan.value, null, 2)}\n`, actor).backup;
      summary.config_exists = true;
    }
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(`CURSOR_MCP_INSTALL_FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isDirectRun()) main();
