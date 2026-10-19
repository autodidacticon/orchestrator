#!/usr/bin/env node
// SessionEnd hook: tell every alive daemon this session's process ancestry so
// the attachments of its operator server end and their claimed launches are
// handed back with keep. Best effort, within the SessionEnd budget; no package
// code. See specs/host-integration "Session end hook".
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const home = process.env.ORCH_HOME || path.join(homedir(), '.orchestrator');

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** The hook's own pid and its ancestors, up to six levels, within 300 ms. */
function ancestry() {
  const chain = [process.pid];
  const deadline = Date.now() + 300;
  let current = process.ppid;
  for (let i = 0; i < 6 && current > 1 && Date.now() < deadline; i++) {
    if (chain.includes(current)) break;
    chain.push(current);
    try {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(current)], { timeout: Math.max(10, deadline - Date.now()), encoding: 'utf8' });
      current = Number(out.trim());
      if (!Number.isInteger(current) || current <= 0) break;
    } catch {
      break;
    }
  }
  return chain;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

async function main() {
  const stdin = process.stdin.isTTY ? {} : await Promise.race([readStdin(), new Promise((r) => setTimeout(() => r({}), 200))]);
  const reason = typeof stdin.reason === 'string' ? stdin.reason : 'sessionEnded';
  let dirs = [];
  try {
    dirs = readdirSync(path.join(home, 'runs'));
  } catch {
    return;
  }
  const targets = [];
  for (const d of dirs) {
    const runDir = path.join(home, 'runs', d);
    const pid = Number((read(path.join(runDir, 'daemon.pid')) || '').trim());
    let info;
    try {
      info = JSON.parse(read(path.join(runDir, 'daemon.json')) || 'null');
    } catch {
      info = undefined;
    }
    if (info && info.url && Number.isInteger(pid) && pid > 0 && info.pid === pid && alive(pid)) targets.push(info.url);
  }
  if (!targets.length) return;
  const pids = ancestry();
  await Promise.allSettled(
    targets.map((url) =>
      fetch(`${url}/v1/attachments/ended`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pids, reason }),
        signal: AbortSignal.timeout(400),
      }),
    ),
  );
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
