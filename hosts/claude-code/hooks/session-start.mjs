#!/usr/bin/env node
// SessionStart hook: one line naming the runs under ORCH_HOME that need a
// session or a human, read from files and a liveness probe; no package code.
// See specs/host-integration "Session start hook".
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

async function probe(url) {
  try {
    const res = await fetch(`${url}/v1/status?probe=1`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

function count(x) {
  return Array.isArray(x) ? x.length : typeof x === 'number' ? x : 0;
}

function plural(n, word) {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word}${word.endsWith('ch') ? 'es' : 's'}`;
}

function age(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

async function describe(runDir) {
  const repo = (read(path.join(runDir, 'repo')) || '').trim() || runDir;
  const pid = Number((read(path.join(runDir, 'daemon.pid')) || '').trim());
  let info;
  try {
    info = JSON.parse(read(path.join(runDir, 'daemon.json')) || 'null');
  } catch {
    info = undefined;
  }
  if (!info) return undefined;
  if (Number.isInteger(pid) && pid > 0 && alive(pid) && info.pid === pid && info.url) {
    const s = await probe(info.url);
    if (!s) return `${repo} (daemon alive, not answering)`;
    const parts = [];
    const running = s.byStatus && Array.isArray(s.byStatus.running) ? s.byStatus.running : [];
    const waiting = s.byStatus && Array.isArray(s.byStatus.waiting) ? s.byStatus.waiting : [];
    if (running.length) parts.push(`running ${running.join(', ')}`);
    if (waiting.length) parts.push(`waiting ${waiting.join(', ')}`);
    if (count(s.claimable)) parts.push(`${plural(count(s.claimable), 'launch')} parked`);
    if (count(s.attachments)) parts.push(`${plural(count(s.attachments), 'session')} attached`);
    if (count(s.awaitingReview)) parts.push(`${s.awaitingReview.join(', ')} awaiting review`);
    if (count(s.openQuestions)) parts.push(`${plural(count(s.openQuestions), 'open question')}`);
    if (s.finished) parts.push('finished');
    return `${repo} (daemon alive${parts.length ? `, ${parts.join(', ')}` : ''})`;
  }
  const exit = info.exit;
  if (!exit) return `${repo} (daemon not stopped cleanly; the next tool call recovers it)`;
  const d = exit.digest || {};
  const parts = [];
  if (count(d.claimable)) parts.push(`${plural(count(d.claimable), 'launch')} parked`);
  if (count(d.openQuestions)) parts.push(`${plural(count(d.openQuestions), 'open question')}`);
  if (count(d.awaitingReview)) parts.push(`${d.awaitingReview.join(', ')} awaiting review`);
  if (d.stalled) parts.push('stalled');
  if (!parts.length) return undefined;
  return `${repo} (daemon exited ${exit.reason} ${age(Date.now() - exit.at)}: ${parts.join(', ')})`;
}

async function main() {
  let dirs = [];
  try {
    dirs = readdirSync(path.join(home, 'runs'));
  } catch {
    return;
  }
  const lines = [];
  for (const d of dirs.sort()) {
    try {
      const line = await describe(path.join(home, 'runs', d));
      if (line) lines.push(line);
    } catch {
      /* skip a run we cannot read */
    }
  }
  if (!lines.length) return;
  const shown = home.startsWith(homedir()) ? `~${home.slice(homedir().length)}` : home;
  process.stdout.write(`orchestrator: ${plural(lines.length, 'run')} under ${shown} need attention: ${lines.join('; ')}. Use the run skill in that repository to continue.\n`);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
