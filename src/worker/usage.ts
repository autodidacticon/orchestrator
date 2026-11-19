/**
 * The usage of a remote launch: the worker loop keeps the tail of the command agent's standard output, parses the
 * Claude Code result object at its end (`parseUsage`, the parser of spawned launches' logs), and posts the tokens and
 * cost to `POST /v1/launches/:id/usage` as the last step of the launch. Both helpers here are pure.
 * See specs/worker-pool "Usage post".
 */
import { parseUsage } from '../runner/claude-code.js';
import type { TokenUsage } from '../runner/runner.js';

/** How much of the agent's standard output the loop keeps: what `parseUsage` reads. */
export const USAGE_TAIL_BYTES = 256 * 1024;

/** The last `limit` bytes of a stream, kept as chunks and decoded once, so a multi-byte character is never split mid-stream. */
export class TailKeeper {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number = USAGE_TAIL_BYTES) {}

  push(chunk: Buffer | string): void {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (b.length === 0) return;
    this.chunks.push(b);
    this.size += b.length;
    // Drop whole chunks from the front while the rest still covers the limit.
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) this.size -= this.chunks.shift()!.length;
  }

  /** The kept text: at most `limit` bytes, the end of the stream. */
  text(): string {
    const all = Buffer.concat(this.chunks, this.size);
    return (all.length > this.limit ? all.subarray(all.length - this.limit) : all).toString('utf8');
  }
}

/** The body of `POST /v1/launches/:id/usage`. See specs/pull-runner "Worker usage". */
export interface UsagePostBody {
  workerId: string;
  usage: { tokens: TokenUsage; model?: string; costUsd?: number };
}

/**
 * The usage post for a launch from the agent's kept output: nothing without a result object at the end or without
 * token counts in it. `model` is the claim's model when it has one; `costUsd` is `total_cost_usd` when above zero.
 * Turns and duration are not posted.
 */
export function usagePostBody(text: string, o: { workerId: string; model?: string }): UsagePostBody | undefined {
  const u = parseUsage(text);
  if (!u?.tokens) return undefined;
  return {
    workerId: o.workerId,
    usage: {
      tokens: u.tokens,
      ...(o.model ? { model: o.model } : {}),
      ...(u.costUsd !== undefined && u.costUsd > 0 ? { costUsd: u.costUsd } : {}),
    },
  };
}
