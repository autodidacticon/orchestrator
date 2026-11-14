/**
 * Attempt context that names a branch or commit the clone no longer holds. Launch branches live only in the clone, so
 * after a start on a fresh clone a kept release's branch, a conflicting branch, or a revision's prior branch may be gone.
 * The brief never names them. See specs/crash-recovery "Context naming lost work".
 */
import type { AttemptContext } from '../state/status.js';

/** What a scrub removed, for the `recovery.workLost` event. */
export type LostPart =
  | { field: 'interrupted'; priorLaunchId: string; priorBranch: string; headSha: string; wipCommit?: string; reason: string }
  | { field: 'conflict'; previousBranch: string }
  | { field: 'revision'; priorLaunchId: string; priorBranch?: string; priorPublishedSha?: string };

/**
 * The carry without any lost ref: an `interrupted` context whose branch or commits are lost becomes `lostWork`; a lost
 * conflicting branch or revision branch is dropped, and so is a revision's lost published commit. Pure; `lost` is
 * undefined when nothing changed.
 */
export function scrubCarry(carry: AttemptContext | undefined, isLost: (ref: string) => boolean): { carry: AttemptContext | undefined; lost?: LostPart[] } {
  if (!carry) return { carry };
  const lost: LostPart[] = [];
  let next: AttemptContext = carry;
  const k = carry.interrupted;
  if (k && (isLost(k.priorBranch) || isLost(k.headSha) || (k.wipCommit !== undefined && isLost(k.wipCommit)))) {
    const { interrupted: _dropped, ...rest } = next;
    next = { ...rest, lostWork: { priorLaunchId: k.priorLaunchId, reason: k.reason } };
    lost.push({ field: 'interrupted', priorLaunchId: k.priorLaunchId, priorBranch: k.priorBranch, headSha: k.headSha, ...(k.wipCommit ? { wipCommit: k.wipCommit } : {}), reason: k.reason });
  }
  const c = next.conflict;
  if (c?.previousBranch && isLost(c.previousBranch)) {
    const { previousBranch, ...conflict } = c;
    next = { ...next, conflict };
    lost.push({ field: 'conflict', previousBranch });
  }
  const r = next.revision;
  if (r) {
    const branchLost = r.priorBranch !== undefined && isLost(r.priorBranch);
    const shaLost = r.priorPublishedSha !== undefined && isLost(r.priorPublishedSha);
    if (branchLost || shaLost) {
      const { priorBranch, priorPublishedSha, ...revision } = r;
      next = { ...next, revision: { ...revision, ...(branchLost || priorBranch === undefined ? {} : { priorBranch }), ...(shaLost || priorPublishedSha === undefined ? {} : { priorPublishedSha }) } };
      lost.push({ field: 'revision', priorLaunchId: r.priorLaunchId, ...(branchLost ? { priorBranch } : {}), ...(shaLost ? { priorPublishedSha } : {}) });
    }
  }
  return lost.length ? { carry: next, lost } : { carry };
}
