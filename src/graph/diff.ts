/**
 * Reload compatibility classification. See specs/task-graph "Reload compatibility".
 */
import { entryOf, isStarted, type Overlay } from '../state/status.js';
import type { Graph, Id } from './model.js';

export interface ReloadReason {
  id: Id;
  code: 'removedStarted' | 'depsChangedStarted' | 'kindChangedStarted';
  message: string;
}

export type ReloadClassification =
  | { compatible: true; added: Id[]; removed: Id[]; changed: Id[] }
  | { compatible: false; reasons: ReloadReason[] };

function sameSet(a: readonly Id[], b: readonly Id[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

export function classifyReload(prev: Graph, next: Graph, overlay: Overlay): ReloadClassification {
  const reasons: ReloadReason[] = [];
  const added: Id[] = [];
  const removed: Id[] = [];
  const changed: Id[] = [];

  for (const id of next.nodes.keys()) {
    if (!prev.nodes.has(id)) added.push(id);
  }
  for (const [id, old] of prev.nodes) {
    const started = isStarted(entryOf(overlay, id).status);
    const nu = next.nodes.get(id);
    if (!nu) {
      removed.push(id);
      if (started) {
        reasons.push({ id, code: 'removedStarted', message: `node ${id} removed while started; cancel it first` });
      }
      continue;
    }
    const depsChanged = !sameSet(old.deps, nu.deps);
    const kindChanged = old.kind !== nu.kind;
    const otherChanged = old.gated !== nu.gated || old.done !== nu.done || JSON.stringify(old.payload) !== JSON.stringify(nu.payload);
    if (depsChanged || kindChanged || otherChanged) changed.push(id);
    if (started && depsChanged) {
      reasons.push({ id, code: 'depsChangedStarted', message: `deps of ${id} changed while started` });
    }
    if (started && kindChanged) {
      reasons.push({ id, code: 'kindChangedStarted', message: `kind of ${id} changed while started` });
    }
  }

  if (reasons.length) return { compatible: false, reasons };
  return { compatible: true, added, removed, changed };
}
