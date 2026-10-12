/**
 * Named crash points for the crash-injection suite.
 *
 * When the environment variable ORCH_CRASH_AT equals `name`, the process exits
 * immediately with code 137 (as if killed). Otherwise this is a no-op. Every
 * boundary between a durable record and an external effect calls this.
 */
export const CRASH_POINTS = [
  'launch.afterRow',
  'launch.afterWorktree',
  'launch.afterSpawn',
  'launch.afterPid',
  'api.afterEventCommit',
  'verify.afterQueued',
  'verify.afterRebase',
  'verify.afterCheck',
  'verify.afterSquash',
  'verify.afterPublish',
  'milestone.afterTag',
  'tick.afterPhase1',
  'tick.afterPhase2',
  'tick.afterPhase3',
  'tick.afterPhase4',
  'tick.afterPhase5',
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

export const CRASH_EXIT_CODE = 137;

let hook: ((name: string) => void) | undefined;

/** Test hook: replace process.exit with a callback (in-process tests). */
export function setCrashHook(fn: ((name: string) => void) | undefined): void {
  hook = fn;
}

export function crashPoint(name: CrashPoint): void {
  const target = process.env['ORCH_CRASH_AT'];
  if (!target || target !== name) return;
  if (hook) {
    hook(name);
    return;
  }
  // Write synchronously so the crash suite can see where we died.
  try {
    process.stderr.write(`[crashPoint] exiting at ${name}\n`);
  } catch {
    /* ignore */
  }
  process.exit(CRASH_EXIT_CODE);
}
