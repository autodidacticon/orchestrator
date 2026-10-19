import { appendFileSync } from 'node:fs';
const log = (l) => appendFileSync('<scratch>/inject.log', l + '\n');
export const Inject = async ({ client }) => {
  log('plugin loaded');
  return {
    'experimental.chat.system.transform': async (input, output) => { log('hook system.transform; system entries=' + (output.system?.length ?? 'n/a')); output.system.push('orchestrator notice: ORCH-SYSTEM-9137 (two runs need attention).'); },
    'chat.message': async (input, output) => { const p = output.parts.find((x) => x.type === 'text'); log('hook chat.message; text part found=' + Boolean(p)); if (p) p.text += '\n\norchestrator notice: ORCH-MESSAGE-4421.'; },
    event: async ({ event }) => { if (event.type === 'session.created') log('event session.created'); },
  };
};
