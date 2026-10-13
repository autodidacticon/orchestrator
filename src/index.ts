/**
 * Core library entrypoint. Hosts that embed the orchestrator import from here;
 * the daemon, operator MCP server, and agent shim are separate entrypoints.
 */
export { configSchema, defaultConfig, loadConfig, type Config } from './config.js';
export { crashPoint, CRASH_POINTS, type CrashPoint } from './crash.js';
export * from './graph/model.js';
export { parseGraph, loadGraphFile, GraphValidationError, revOf } from './graph/load.js';
export * as graphQuery from './graph/query.js';
export { classifyReload, type ReloadClassification, type ReloadReason } from './graph/diff.js';
export { StaticGraphSource, FileGraphSource, type GraphSource } from './graph/source.js';
export * from './state/status.js';
export { TRANSITIONS, applyTransition, findTransition, isAllowed, TransitionError, type Actor, type TransitionRow } from './state/transitions.js';
export type * from './state/store.js';
export { SqliteStore } from './state/sqlite.js';
export { Orchestrator, type OrchestratorDeps, type StatusReport, type ApiResponse, type AgentOp } from './loop/orchestrator.js';
export { fifoPolicy, admit, type Policy, type ScheduleContext } from './loop/schedule.js';
export type { AgentRunner, SpawnResult } from './runner/runner.js';
export { SubprocessRunner, substitute, pidAlive, killTree } from './runner/subprocess.js';
export { ClaudeCodeRunner, DEFAULT_CLAUDE_COMMAND } from './runner/claude-code.js';
export { InprocRunner } from './runner/inproc.js';
export type { Workspace, SealResult, FallbackReport, BriefInput } from './workspace/workspace.js';
export { GitWorkspace } from './workspace/git-workspace.js';
export { FakeWorkspace } from './workspace/fake.js';
export type { VerifierBackend, VerifierOutcome, VerifierContext } from './verify/job.js';
export { GitVerifierBackend, TRAILER_LAUNCH, TRAILER_TASK } from './verify/verifier.js';
export { FakeVerifierBackend } from './verify/fake.js';
export { composeBrief, acceptanceCriteriaOf, type BriefJson } from './brief/compose.js';
export { SlotValidator, defaultSlots, slotValue, type SlotTemplate } from './brief/template.js';
export { alwaysValid, type BriefValidator, type ValidationResult } from './brief/validate.js';
export { noRemediation, StaticRemediator, type Remediator, type RemediationContext } from './brief/remediate.js';
export { ApiServer } from './agent/server.js';
export { registerOperatorRoutes } from './operator/routes.js';
