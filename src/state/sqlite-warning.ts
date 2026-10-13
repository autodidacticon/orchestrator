/**
 * One-shot filter for the `node:sqlite` ExperimentalWarning. Importing this
 * module before `node:sqlite` replaces the process's `warning` listeners with
 * one that forwards every warning except that one; the first time it swallows
 * the warning, or on the first `setImmediate` armed by `releaseSqliteWarningFilter`
 * if the warning never arrives, the original listeners are put back in their
 * original order, so the side effect lasts at most one turn of the event loop.
 * See specs/host-integration "Quiet SQLite binding".
 */
type WarningListener = (warning: Error) => void;

const originals = process.listeners('warning') as WarningListener[];
let restored = false;

function restore(): void {
  if (restored) return;
  restored = true;
  process.removeListener('warning', filter);
  // Re-add the originals ahead of anything installed meanwhile, in their original order.
  for (const listener of [...originals].reverse()) process.prependListener('warning', listener);
}

function filter(warning: Error): void {
  if (warning.name === 'ExperimentalWarning' && /SQLite/.test(warning.message)) {
    restore();
    return;
  }
  for (const listener of originals) listener(warning);
}

for (const listener of originals) process.removeListener('warning', listener);
process.on('warning', filter);

/** Arm the fallback restore; call it after `node:sqlite` has evaluated so the queued warning is seen first. */
export function releaseSqliteWarningFilter(): void {
  if (restored) return;
  const timer = setImmediate(restore);
  timer.unref();
}
