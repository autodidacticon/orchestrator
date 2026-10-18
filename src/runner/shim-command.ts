/**
 * The MCP shim as every runner starts it: the entrypoint and the variables that
 * identify the launch to it. The shim reads its identity only from its own
 * environment (or an env file), never from the agent's, so each runner forwards
 * the same list. See specs/agent-protocol "Agent environment".
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Launch } from '../state/store.js';

/** The shim entrypoint: the built .js if present, else the .ts via tsx. */
export function shimCommand(): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.resolve(here, '../agent/mcp-shim.js');
  if (existsSync(js)) return { command: 'node', args: [js] };
  const ts = path.resolve(here, '../agent/mcp-shim.ts');
  const loader = path.resolve(here, '../../node_modules/tsx/dist/loader.mjs');
  return { command: 'node', args: ['--import', loader, ts] };
}

/**
 * The shim's variables for a launch: ORCH_API, ORCH_LAUNCH_ID, ORCH_TOKEN, ORCH_RETRY_WINDOW_MS,
 * ORCH_COMMIT_POLICY when the agent environment carries it, then `extra`.
 */
export function shimEnv(launch: Launch, env: Record<string, string>, retryWindowMs: number, extra?: Record<string, string>): Record<string, string> {
  return {
    ORCH_API: env['ORCH_API'] ?? '',
    ORCH_LAUNCH_ID: launch.launchId,
    ORCH_TOKEN: launch.token,
    ORCH_RETRY_WINDOW_MS: String(retryWindowMs),
    ...(env['ORCH_COMMIT_POLICY'] ? { ORCH_COMMIT_POLICY: env['ORCH_COMMIT_POLICY'] } : {}),
    ...extra,
  };
}

/** `KEY=VALUE` lines for the shim's `--orch-env-file`; a value with a line break is refused. */
export function formatEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v)) throw new Error(`${k}: a value for the shim env file must not contain a line break`);
      return `${k}=${v}\n`;
    })
    .join('');
}

/** The inverse of `formatEnvFile`: blank lines and `#` comments are skipped, the first `=` splits. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}
