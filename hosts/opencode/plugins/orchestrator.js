// OpenCode plugin: the session start notice for an OpenCode operator session. See
// specs/host-integration "OpenCode host" and "Session start hook".
//
// On session.created (root sessions only) it runs hooks/session-start.mjs, the Claude Code
// plugin's script copied byte for byte, once, and keeps its line. On that session's first
// chat.message it appends the line to the user's existing text part, so the notice is saved
// with the message and stays in context, and it shows the line as a TUI toast. A new part is
// never pushed: OpenCode refuses a part without ids ("invalid user part before save"). When
// the script prints nothing, the message is untouched.
//
// There is no session end event in OpenCode; the operator server ends its own attachment when
// its stdio closes (reason sessionEnded), so nothing runs hooks/session-end.mjs here.
//
// The hook script is found beside this file's real path (a symlinked install resolves to
// hosts/opencode/plugins/), or under ORCH_OPENCODE_HOST for a copied install. Only one
// function is exported: OpenCode calls every exported function as a plugin.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_TIMEOUT_MS = 10_000;

function startScript() {
  const host = process.env.ORCH_OPENCODE_HOST || path.dirname(path.dirname(realpathSync(fileURLToPath(import.meta.url))));
  return path.join(host, 'hooks', 'session-start.mjs');
}

/** Runs the start script with node and resolves to its trimmed stdout, or '' on any failure. */
function startLine() {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // `node` from PATH: inside OpenCode, process.execPath is the opencode binary.
      child = spawn('node', [startScript()],{ stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

export const OrchestratorPlugin = async ({ client }) => {
  // sessionID -> { line: Promise<string>, done: boolean }
  const sessions = new Map();
  return {
    event: async ({ event }) => {
      if (event?.type !== 'session.created') return;
      const info = event.properties?.info;
      if (!info?.id || info.parentID || sessions.has(info.id)) return;
      const entry = { line: startLine(), done: false };
      sessions.set(info.id, entry);
      const line = await entry.line;
      if (!line) return;
      try {
        await client?.tui?.showToast?.({ body: { title: 'orchestrator', message: line, variant: 'info' } });
      } catch {
        /* headless: no TUI */
      }
    },
    'chat.message': async (input, output) => {
      const id = input?.sessionID ?? output?.message?.sessionID;
      const entry = sessions.get(id);
      if (!entry || entry.done) return;
      entry.done = true;
      const line = await entry.line;
      if (!line) return;
      const part = output?.parts?.find((p) => p.type === 'text');
      if (part) part.text = `${part.text}\n\n${line}`;
    },
  };
};
