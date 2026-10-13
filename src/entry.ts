/**
 * Entrypoint detection for the package's executables. `import.meta.url` is the
 * module's real path, while `process.argv[1]` is whatever was invoked, which under
 * `npm link` or a global install is a symlink in a bin directory; compare through
 * the symlink. See specs/host-integration "Package entrypoints".
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  let real = argv1;
  try {
    real = realpathSync(argv1);
  } catch {
    // Not on disk (for example a loader alias): compare the given path as is.
  }
  return pathToFileURL(real).href === moduleUrl;
}
