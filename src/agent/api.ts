/**
 * Agent API schemas. The contract is the operations and their semantics; the
 * transport is loopback HTTP (server.ts) with an MCP façade (mcp-shim.ts).
 */
import { z } from 'zod';

export { failBodySchema, questionSchema, submitBodySchema } from '../loop/orchestrator.js';

export const AGENT_OPS = ['heartbeat', 'report', 'block', 'inbox', 'log'] as const;

export const fallbackFileSchema = z.object({
  launchId: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(['submit', 'fail', 'block']),
  body: z.record(z.unknown()),
});

export type FallbackFile = z.infer<typeof fallbackFileSchema>;
