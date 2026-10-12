import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseGraph } from '../../src/graph/load.js';
import type { Graph, Id } from '../../src/graph/model.js';
import { defaultEntry, type Entry, type Status } from '../../src/state/status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixturesDir = path.resolve(here, '../fixtures/graphs');

export function fixtureText(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

export function loadFixture(name: string): Graph {
  return parseGraph(fixtureText(name));
}

export function overlayWith(statuses: Record<Id, Status | Status['kind']>): Map<Id, Entry> {
  const m = new Map<Id, Entry>();
  for (const [id, s] of Object.entries(statuses)) {
    const status: Status = typeof s === 'string' ? (asStatus(s) as Status) : s;
    m.set(id, { ...defaultEntry(), status });
  }
  return m;
}

export function asStatus(kind: Status['kind']): Status {
  switch (kind) {
    case 'unstarted':
    case 'running':
    case 'submitted':
    case 'done':
      return { kind };
    case 'waiting':
      return { kind, question: { kind: 'needsDecision', message: 'q' }, askedAt: 0, seq: 1 };
    case 'failed':
      return { kind, reason: { kind: 'agentFail' } };
    case 'blocked':
      return { kind, reason: { kind: 'impossible', message: 'x' } };
    case 'cancelled':
      return { kind, reason: 'test', releasesDependents: false };
  }
}
