/**
 * What the tick phases and the launch sequence need from the orchestrator.
 */
import type { Config } from '../config.js';
import type { Graph, GraphNode, Id } from '../graph/model.js';
import type { AgentRunner } from '../runner/runner.js';
import type { CommitPolicy, RunnerKind, Selection } from '../runner/selection.js';
import type { Entry, StatusKind } from '../state/status.js';
import type { Launch, RunnerMode, Store } from '../state/store.js';
import type { Actor } from '../state/transitions.js';
import type { VerifierBackend } from '../verify/job.js';
import type { BriefInput, Workspace } from '../workspace/workspace.js';
import type { BriefValidator, Remediator } from '../brief/validate.js';
import type { Policy } from './schedule.js';

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface OrchestratorCore {
  readonly store: Store;
  readonly config: Config;
  readonly runner: AgentRunner;
  readonly workspace: Workspace;
  readonly verifier: VerifierBackend;
  readonly policy: Policy;
  readonly briefValidator: BriefValidator;
  readonly remediator: Remediator;
  readonly log: Logger;
  now(): number;
  /** The runner mode in force: the durable override, else the configured mode. */
  effectiveMode(): RunnerMode;
  graph(): Graph;
  graphRev(): string;
  requireNode(id: Id): GraphNode;
  entry(id: Id): Entry;
  /** Append the transition event and derive tracker effects in the caller's transaction; returns the event seq. */
  recordTransition(id: Id, from: StatusKind, to: StatusKind, actor: Actor, trigger: string, extra?: Record<string, unknown>): number;
  briefInput(launch: Launch): BriefInput;
  agentEnv(launch: Launch): Record<string, string>;
  /** The runner kind, worker model, and effort for a task: the kind in force now and its payload selectors over that kind's defaults. See specs/model-selection. */
  selectionFor(taskId: Id): Selection;
  /** The commit policy in force now for a kind: its `runner.<kind>.commit`. See specs/worker-runners "Sandbox and commit policy". */
  commitPolicyFor(kind: RunnerKind): CommitPolicy;
}
