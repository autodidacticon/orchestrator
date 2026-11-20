/**
 * The verifier loop's heartbeat for one verify job: `POST /v1/verify/<jobId>/heartbeat` with the job token, every
 * `everyMs`, each scheduled after the answer to the one before, so two never overlap. A 401 means the lease is lost:
 * `onLost` is called and no heartbeat follows. Any other answer, or none within the retry window, is written to
 * stderr and the job is kept. Modelled on the worker loop's `startLoopHeartbeat`, with no fingerprint.
 * See specs/verifier-pool "Verifier heartbeat".
 */
import type { ApiCall } from '../worker/http.js';
import type { Schedule } from '../worker/loop.js';

export interface VerifyHeartbeat {
  /** Cancel the next heartbeat and wait for one in flight; none is sent after this resolves. */
  stop(): Promise<void>;
  /** Heartbeats sent so far. */
  sent(): number;
  /** Whether a heartbeat was answered 401. */
  lost(): boolean;
}

const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function startVerifyHeartbeat(o: { call: ApiCall; jobId: string; token: string; everyMs: number; schedule?: Schedule; err?: (text: string) => void; onLost: () => void }): VerifyHeartbeat {
  const schedule = o.schedule ?? realSchedule;
  let stopped = false;
  let lost = false;
  let sent = 0;
  let cancel: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  const beat = async () => {
    if (stopped) return;
    sent++;
    try {
      const r = await o.call('POST', `/v1/verify/${o.jobId}/heartbeat`, {}, o.token);
      if (r.status === 401) {
        lost = true;
        if (!stopped) o.onLost();
      } else if (r.status !== 200) o.err?.(`heartbeat ${o.jobId}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}\n`);
    } catch (e) {
      o.err?.(`heartbeat ${o.jobId}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  const arm = () => {
    if (stopped || lost) return;
    cancel = schedule(() => {
      cancel = undefined;
      inFlight = beat().finally(() => {
        inFlight = undefined;
        arm();
      });
    }, o.everyMs);
  };
  arm();
  return {
    stop: async () => {
      stopped = true;
      cancel?.();
      cancel = undefined;
      await inFlight;
    },
    sent: () => sent,
    lost: () => lost,
  };
}
