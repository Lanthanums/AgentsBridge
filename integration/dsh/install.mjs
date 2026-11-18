#!/usr/bin/env node
// AgentsBridge v2 harness installer for DeepSeek Harness (agent: dsh).
//
// Writes exactly one loader patch row per existing DSH profile:
//   - insert:
//       - id: mcp-mesh
//         name: '@deepseek-ai/dsh-mcp-client'
//         config: { serverName: mesh, transport: stdio, command, args, env }
//
// Default is a dry run. Pass --install to write (atomic write + backup).
// Other YAML entries, comments and formatting are preserved by editing the
// parsed YAML document in place instead of re-stringifying a plain object.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  atomicWrite,
  backupRoot,
  bridgeScript,
  meshConfig,
} from '../shared.mjs';

const ACTOR = 'dsh';
const MESH_ID = 'mcp-mesh';
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';
const NODE_COMMAND = process.execPath;

const HELP = `AgentsBridge v2 harness installer for DSH (dsh)

Usage:
  node install.mjs                 Dry run (default): print the plan only.
  node install.mjs --install       Apply the plan (atomic write + backup).
  node install.mjs --profile acp   Limit to one profile (repeatable/comma list).
  node install.mjs --profiles-dir <path>
  node install.mjs --help

Targets every existing profile directory under <DSH_HOME>/profiles that has a
cordis.patch.yml. Only the mcp-mesh row is added or replaced; old mesh
pointers and Grix-related MCP entries are removed, every other entry is kept.
`;

function parseArgs(argv) {
  const options = {
    install: false,
    help: false,
    profiles: [],
    profilesDir: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install') options.install = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--profile') {
      const value = argv[++i];
      if (!value) throw new UsageError('--profile requires a profile name');
      options.profiles.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith('--profile=')) {
      options.profiles.push(...arg.slice('--profile='.length).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--profiles-dir') {
      const value = argv[++i];
      if (!value) throw new UsageError('--profiles-dir requires a path');
      options.profilesDir = resolve(value);
    } else if (arg.startsWith('--profiles-dir=')) {
      options.profilesDir = resolve(arg.slice('--profiles-dir='.length));
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.install && options.dryRun) {
    throw new UsageError('--install and --dry-run cannot be combined');
  }
  return options;
}

class UsageError extends Error {}

function loadYaml(dshHome) {
  const candidates = [
    join(dshHome, 'profiles', 'noop.cjs'),
    join(dshHome, 'noop.cjs'),
  ];
  const errors = [];
  for (const anchor of candidates) {
    const modules = join(dirname(anchor), 'node_modules');
    if (!existsSync(modules)) continue;
    try {
      return createRequire(anchor)('yaml');
    } catch (error) {
      errors.push(`${modules}: ${error.message}`);
    }
  }
  throw new Error(
    `DSH bundled "yaml" dependency was not found under ${dshHome}; refusing to add a repository dependency. ${errors.join(' | ')}`,
  );
}

function scalarValue(node) {
  return node && typeof node === 'object' && 'value' in node && typeof node.value === 'string'
    ? node.value
    : undefined;
}

function field(map, key) {
  if (!map || !Array.isArray(map.items)) return undefined;
  const pair = map.items.find((item) => scalarValue(item.key) === key);
  return pair ? pair.value : undefined;
}

function jsonOf(node) {
  try {
    return JSON.stringify(node.toJSON() ?? null);
  } catch {
    return '';
  }
}

function hasInsert(map) {
  return field(map, 'insert') !== undefined;
}

function isMcpLike(map, YAML) {
  if (!YAML.isMap(map) || hasInsert(map)) return false;
  const id = scalarValue(field(map, 'id')) || '';
  const name = scalarValue(field(map, 'name')) || '';
  if (/mcp/i.test(id) || /mcp/i.test(name)) return true;
  const config = field(map, 'config');
  if (YAML.isMap(config)) {
    for (const key of ['transport', 'serverName', 'command', 'url', 'headers']) {
      if (field(config, key) !== undefined) return true;
    }
  }
  return false;
}

function isGrixMcp(map, YAML) {
  if (!YAML.isMap(map) || hasInsert(map)) return false;
  if (!/grix/i.test(jsonOf(map))) return false;
  return isMcpLike(map, YAML);
}

function isMeshEntry(map, YAML) {
  if (!YAML.isMap(map) || hasInsert(map)) return false;
  if (scalarValue(field(map, 'id')) === MESH_ID) return true;
  const config = field(map, 'config');
  if (YAML.isMap(config) && scalarValue(field(config, 'serverName')) === 'mesh') return true;
  return /mesh-mcp\.mjs|codex-bridge[\\/][^"']*mesh/i.test(jsonOf(map));
}

function desiredMesh() {
  const shared = meshConfig(ACTOR);
  return {
    id: MESH_ID,
    name: MCP_CLIENT_NAME,
    config: {
      serverName: 'mesh',
      transport: 'stdio',
      command: NODE_COMMAND,
      args: [...shared.args],
      env: { ...shared.env },
    },
  };
}

// Rewrites the YAML document in place. Returns counters describing the plan.
function rewrite(doc, desired, YAML) {
  const root = doc.contents;
  const stats = {
    added: 0,
    replaced: 0,
    removedGrix: 0,
    removedMesh: 0,
    unchanged: 0,
  };
  const makeItem = () => doc.createNode(desired);
  const makeInsert = () => doc.createNode({ insert: [desired] });
  let found = false;
  const keptTop = [];

  for (const entry of root.items) {
    if (!YAML.isMap(entry)) {
      keptTop.push(entry);
      continue;
    }
    if (!hasInsert(entry)) {
      if (isGrixMcp(entry, YAML)) {
        stats.removedGrix += 1;
        continue;
      }
      if (isMeshEntry(entry, YAML)) {
        stats.removedMesh += 1;
        if (!found) {
          keptTop.push(makeInsert());
          found = true;
          stats.replaced += 1;
        }
        continue;
      }
      keptTop.push(entry);
      continue;
    }

    const insert = field(entry, 'insert');
    if (!YAML.isSeq(insert)) {
      keptTop.push(entry);
      continue;
    }
    const keptItems = [];
    let touched = false;
    for (const item of insert.items) {
      if (YAML.isMap(item)) {
        if (isGrixMcp(item, YAML)) {
          stats.removedGrix += 1;
          touched = true;
          continue;
        }
        if (isMeshEntry(item, YAML)) {
          stats.removedMesh += 1;
          touched = true;
          if (!found) {
            if (isDeepStrictEqual(item.toJSON(), desired)) {
              keptItems.push(item);
              stats.unchanged += 1;
            } else {
              keptItems.push(makeItem());
              stats.replaced += 1;
            }
            found = true;
          }
          continue;
        }
      }
      keptItems.push(item);
    }
    if (keptItems.length === 0 && touched) continue;
    insert.items = keptItems;
    keptTop.push(entry);
  }

  if (!found) {
    const wrapper = keptTop.find(
      (entry) => YAML.isMap(entry) && YAML.isSeq(field(entry, 'insert')),
    );
    if (wrapper) {
      field(wrapper, 'insert').items.push(makeItem());
    } else {
      keptTop.push(makeInsert());
    }
    stats.added += 1;
  }

  root.items = keptTop;
  // An originally empty `[]` document keeps YAML flow style; adding the first
  // entry to it would emit one unreadable line, so switch it to block style.
  if (root.flow && root.items.length > 0) root.flow = false;
  return stats;
}

function collectMeshEntries(doc, YAML) {
  const root = doc.contents;
  const found = [];
  for (const entry of root.items) {
    if (!YAML.isMap(entry)) continue;
    const insert = field(entry, 'insert');
    if (YAML.isSeq(insert)) {
      for (const item of insert.items) {
        if (isMeshEntry(item, YAML)) found.push(item);
      }
    } else if (isMeshEntry(entry, YAML)) {
      found.push(entry);
    }
  }
  return found;
}

function collectGrixEntries(doc, YAML) {
  const root = doc.contents;
  const found = [];
  for (const entry of root.items) {
    if (!YAML.isMap(entry)) continue;
    const insert = field(entry, 'insert');
    if (YAML.isSeq(insert)) {
      for (const item of insert.items) {
        if (isGrixMcp(item, YAML)) found.push(item);
      }
    } else if (isGrixMcp(entry, YAML)) {
      found.push(entry);
    }
  }
  return found;
}

function planProfile(patchPath, yaml, desired) {
  const raw = readFileSync(patchPath, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const crlf = text.includes('\r\n');
  const doc = yaml.parseDocument(text, { logLevel: 'silent' });
  if (doc.errors.length > 0) {
    throw new Error(`YAML parse error: ${doc.errors[0].message}`);
  }
  if (doc.contents == null) doc.contents = doc.createNode([]);
  if (!yaml.isSeq(doc.contents)) {
    throw new Error('top-level YAML value is not an array of loader patch entries');
  }

  const stats = rewrite(doc, desired, yaml);
  const meshEntries = collectMeshEntries(doc, yaml);
  const grixLeft = collectGrixEntries(doc, yaml);
  if (meshEntries.length !== 1) {
    throw new Error(`internal check failed: expected one mcp-mesh entry, found ${meshEntries.length}`);
  }
  if (!isDeepStrictEqual(meshEntries[0].toJSON(), desired)) {
    throw new Error('internal check failed: mcp-mesh entry does not match the desired config');
  }
  if (grixLeft.length !== 0) {
    throw new Error(`internal check failed: ${grixLeft.length} Grix MCP entry/entries remain`);
  }

  let next = doc.toString({ lineWidth: 0 });
  if (!next.endsWith('\n')) next += '\n';
  if (crlf) next = next.replace(/\n/g, '\r\n');
  if (bom) next = `\ufeff${next}`;

  const changed = next !== raw;
  return { patchPath, next, changed, stats, meshEntries: meshEntries.length };
}

function describeAction(plan) {
  const { stats, changed } = plan;
  if (!changed) return 'unchanged';
  const parts = [];
  if (stats.added) parts.push('add mcp-mesh');
  if (stats.replaced) parts.push('replace old mesh pointer');
  if (stats.removedMesh > 1) parts.push(`dedupe ${stats.removedMesh - 1} extra mesh row(s)`);
  if (stats.removedGrix) parts.push(`remove ${stats.removedGrix} Grix MCP row(s)`);
  return parts.join('; ') || 'no-op';
}

function discoverProfiles(profilesDir, only) {
  if (!existsSync(profilesDir)) {
    throw new Error(`DSH profiles directory does not exist: ${profilesDir}`);
  }
  const all = readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => {
      const patch = join(profilesDir, name, 'cordis.patch.yml');
      return existsSync(patch) && statSync(patch).isFile();
    })
    .sort();
  if (only.length === 0) return all;
  const wanted = [...new Set(only)];
  const missing = wanted.filter((name) => !all.includes(name));
  if (missing.length > 0) {
    throw new Error(`profile(s) without cordis.patch.yml: ${missing.join(', ')} (found: ${all.join(', ')})`);
  }
  return all.filter((name) => wanted.includes(name));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n\n${HELP}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const dshHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
  const profilesDir = options.profilesDir || join(dshHome, 'profiles');
  const yaml = loadYaml(dshHome);
  const desired = desiredMesh();
  if (!existsSync(bridgeScript)) {
    throw new Error(`AgentsBridge MCP server not found: ${bridgeScript}`);
  }
  if (!existsSync(NODE_COMMAND)) {
    throw new Error(`pinned Node executable not found: ${NODE_COMMAND}`);
  }

  const names = discoverProfiles(profilesDir, options.profiles);
  const mode = options.install ? 'INSTALL' : 'DRY-RUN';
  process.stdout.write('AgentsBridge DSH MCP harness installer (agent: dsh)\n');
  process.stdout.write(`Mode: ${mode}${options.install ? '' : ' — no files will be written'}\n`);
  process.stdout.write(`DSH home: ${dshHome}\n`);
  process.stdout.write(`Profiles: ${names.length}${names.length ? ` (${names.join(', ')})` : ''}\n`);
  process.stdout.write(`MCP server: ${bridgeScript}\n`);
  process.stdout.write(`Command: ${NODE_COMMAND} argv=[mcp script] env.AGENTSBRIDGE_AGENT=${ACTOR}\n`);
  process.stdout.write(`Backup root: ${backupRoot}\n\n`);

  let failed = false;
  let changedProfiles = 0;
  for (const name of names) {
    const patchPath = join(profilesDir, name, 'cordis.patch.yml');
    try {
      const plan = planProfile(patchPath, yaml, desired);
      if (!plan.changed) {
        process.stdout.write(`  ${name.padEnd(10)} unchanged  ${patchPath}\n`);
        continue;
      }
      changedProfiles += 1;
      if (!options.install) {
        process.stdout.write(`  ${name.padEnd(10)} would ${describeAction(plan)}  ${patchPath}\n`);
        continue;
      }
      const result = atomicWrite(patchPath, plan.next, ACTOR);
      // Re-read from disk: the verification must not trust the in-memory plan.
      const verified = planProfile(result.path, yaml, desired);
      if (verified.changed) {
        throw new Error('post-write verification failed: file still differs from the desired plan');
      }
      process.stdout.write(`  ${name.padEnd(10)} installed (${describeAction(plan)})  ${result.path}\n`);
      process.stdout.write(`  ${' '.repeat(10)} backup: ${result.backup ?? '(new file, no previous content)'}\n`);
    } catch (error) {
      failed = true;
      process.stderr.write(`  ${name.padEnd(10)} ERROR: ${error.message}\n`);
    }
  }

  process.stdout.write('\n');
  if (failed) {
    process.stderr.write('Result: FAILED — see errors above. Per-profile writes already made are backed up.\n');
    process.exitCode = 1;
    return;
  }
  if (options.install) {
    process.stdout.write(`Result: installed/updated ${changedProfiles} profile(s). Restart the affected DSH sessions to load mcp-mesh.\n`);
  } else {
    process.stdout.write(`Result: dry run complete; ${changedProfiles} profile(s) would change. Re-run with --install to apply.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
