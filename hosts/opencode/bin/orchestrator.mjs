#!/usr/bin/env node
// OpenCode host launcher: a copy of hosts/claude-code/bin/orchestrator.mjs that runs an
// orchestrator executable from the first of three sources that applies, with nothing on
// PATH. See specs/host-integration "Plugin launcher" and "OpenCode host".
//   (a) a repository checkout: the host directory's grandparent is the package
//   (b) the host-local install: <host>/node_modules/<package>, placed there by
//       `npm install` in hosts/opencode
//   (c) the published package through npx, pinned to the version in <host>/package.json
// Dependency-free on purpose: it runs before any package code exists.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@autodidacticon/orchestrator';
const FLOOR_BEFORE_RESOLVE = '22.13.0';

const ENTRIES = {
  mcp: { file: 'src/operator/mcp', bin: 'orchestrator-mcp' },
  ctl: { file: 'src/operator/cli', bin: 'orchestrator-ctl' },
  daemon: { file: 'src/main', bin: 'orchestrator' },
  shim: { file: 'src/agent/mcp-shim', bin: 'orchestrator-mcp-shim' },
};

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** `engines.node` as a plain floor version ("22.13.0" from ">=22.13.0"). */
function floorOf(pkgJson) {
  const spec = pkgJson?.engines?.node;
  const m = typeof spec === 'string' ? /(\d+\.\d+\.\d+)/.exec(spec) : null;
  return m ? m[1] : FLOOR_BEFORE_RESOLVE;
}

/** The command to run for `entry`, and which source supplied it. */
export function resolve(entry) {
  const e = ENTRIES[entry];
  if (!e) throw new Error(`unknown entry ${entry}; expected one of ${Object.keys(ENTRIES).join(', ')}`);
  const node = process.execPath;
  // (a) a checkout: hosts/opencode sits two levels below the package root
  const checkout = path.resolve(pluginDir, '..', '..');
  const checkoutPkg = readJson(path.join(checkout, 'package.json'));
  if (checkoutPkg?.name === PACKAGE_NAME) {
    const js = path.join(checkout, 'dist', `${e.file}.js`);
    if (existsSync(js)) return { source: 'checkout', command: node, args: [js], floor: floorOf(checkoutPkg) };
    const loader = path.join(checkout, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const ts = path.join(checkout, `${e.file}.ts`);
    if (existsSync(loader) && existsSync(ts)) return { source: 'checkout', command: node, args: ['--import', loader, ts], floor: floorOf(checkoutPkg) };
  }
  // (b) the host-local install
  const local = path.join(pluginDir, 'node_modules', ...PACKAGE_NAME.split('/'));
  const localJs = path.join(local, 'dist', `${e.file}.js`);
  if (existsSync(localJs)) return { source: 'plugin', command: node, args: [localJs], floor: floorOf(readJson(path.join(local, 'package.json'))) };
  // (c) the published package through npx, pinned to the host package.json's dependency
  const version = readJson(path.join(pluginDir, 'package.json'))?.dependencies?.[PACKAGE_NAME] ?? 'latest';
  const npx = path.join(path.dirname(node), 'npx');
  return { source: 'npx', command: existsSync(npx) ? npx : 'npx', args: ['--yes', `--package=${PACKAGE_NAME}@${version}`, e.bin], floor: FLOOR_BEFORE_RESOLVE };
}

function main() {
  const [entry, ...rest] = process.argv.slice(2);
  if (!entry || !ENTRIES[entry]) {
    process.stderr.write(`usage: orchestrator.mjs <mcp|ctl|daemon|shim> [args...]\n`);
    process.exit(2);
  }
  const resolved = resolve(entry);
  const running = process.env.ORCH_LAUNCHER_NODE_VERSION || process.versions.node;
  if (compareVersions(running, resolved.floor) < 0) {
    process.stderr.write(`orchestrator: Node ${running} is older than the ${resolved.floor} this package needs (node:sqlite); upgrade Node or point the plugin at a newer one\n`);
    process.exit(1);
  }
  const args = [...resolved.args, ...rest];
  if (process.env.ORCH_LAUNCHER_DRY_RUN) {
    process.stdout.write(`${JSON.stringify({ source: resolved.source, command: resolved.command, args })}\n`);
    return;
  }
  const child = spawn(resolved.command, args, { stdio: 'inherit', env: process.env });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    });
  }
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    process.stderr.write(`orchestrator: could not start ${resolved.command}: ${err.message}\n`);
    process.exit(1);
  });
}

// Entry guard through any symlink or alias path (npm link bins, /var vs /private/var on macOS).
function isEntrypoint() {
  if (!process.argv[1]) return false;
  let given = path.resolve(process.argv[1]);
  try {
    given = realpathSync(given);
  } catch {
    /* keep as given */
  }
  let self = fileURLToPath(import.meta.url);
  try {
    self = realpathSync(self);
  } catch {
    /* keep as is */
  }
  return given === self;
}

if (isEntrypoint()) main();
