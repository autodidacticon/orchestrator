/**
 * The review answer: an index by default, one task's whole report on request, or the whole bundle.
 * See specs/operator-control "Review bundle".
 */
import * as q from '../graph/query.js';
import type { Id } from '../graph/model.js';
import type { Orchestrator } from '../loop/orchestrator.js';

export type ReviewView = 'index' | 'task' | 'full';

export interface ReviewCuts {
  statLines: number;
  summaryChars: number;
}

export interface ReviewParams {
  task?: string;
  full: boolean;
  statLines?: number;
  summaryChars?: number;
}

/** One closure entry of the bundle `Orchestrator.reviewBundle` returns. */
export interface BundleClosureEntry {
  taskId: Id;
  status: string;
  publishedSha?: string;
  summary?: string;
  acceptance?: unknown;
}

/** The bundle `Orchestrator.reviewBundle` returns. */
export interface ReviewBundle {
  milestone: Id;
  integrationSha: string;
  reviewVersion: number;
  tag: string;
  baseline: string;
  diffStat: string;
  closure: BundleClosureEntry[];
  acceptanceCriteria: string[];
}

/** Per-task facts the bundle does not carry. */
export interface TaskExtras {
  title: string;
  /** Length of the published job's `changedFiles`; absent when the job has none. */
  changedFileCount?: number;
}

export interface OmittedField {
  field: 'closure.acceptance' | 'closure.summary' | 'diffStat';
  count: number;
  fetch: string;
}

export interface IndexEntry {
  taskId: Id;
  title: string;
  status: string;
  publishedSha?: string;
  summary: string;
  summaryLength: number;
  acceptanceCount: number;
  changedFileCount?: number;
}

export type ReviewAnswer = { status: number; body: Record<string, unknown> };

/**
 * The first `lines` file lines of a `git diff --stat` output as printed, then ` ... <k> more files` when k were left
 * out, then the totals line, which is always kept. An empty stat stays empty; a one-line stat is returned whole.
 */
export function cutStat(stat: string, lines: number): { text: string; omitted: number } {
  const all = stat.split('\n');
  while (all.length && all[all.length - 1] === '') all.pop();
  if (all.length <= 1) return { text: all.join('\n'), omitted: 0 };
  const totals = all[all.length - 1] as string;
  const files = all.slice(0, -1);
  if (files.length <= lines) return { text: all.join('\n'), omitted: 0 };
  const omitted = files.length - lines;
  return { text: [...files.slice(0, lines), ` ... ${omitted} more files`, totals].join('\n'), omitted };
}

/** The first `chars` UTF-16 units of `summary`, one fewer when the cut would split a surrogate pair. */
export function cutSummary(summary: string, chars: number): string {
  if (summary.length <= chars) return summary;
  let end = chars;
  if (end > 0) {
    const high = summary.charCodeAt(end - 1);
    const low = summary.charCodeAt(end);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1;
  }
  return summary.slice(0, end);
}

const reviewPath = (milestone: Id) => `/v1/milestones/${encodeURIComponent(milestone)}/review`;

/** The index built from the full bundle. Pure. */
export function indexOf(bundle: ReviewBundle, extras: ReadonlyMap<Id, TaskExtras>, cuts: ReviewCuts): Record<string, unknown> {
  let withEvidence = 0;
  let summariesCut = 0;
  const closure: IndexEntry[] = bundle.closure.map((c) => {
    const whole = c.summary ?? '';
    const summary = cutSummary(whole, cuts.summaryChars);
    if (summary.length < whole.length) summariesCut++;
    const acceptanceCount = Array.isArray(c.acceptance) ? c.acceptance.length : 0;
    if (acceptanceCount > 0) withEvidence++;
    const extra = extras.get(c.taskId);
    return {
      taskId: c.taskId,
      title: extra?.title ?? c.taskId,
      status: c.status,
      publishedSha: c.publishedSha,
      summary,
      summaryLength: whole.length,
      acceptanceCount,
      ...(extra?.changedFileCount !== undefined ? { changedFileCount: extra.changedFileCount } : {}),
    };
  });
  const stat = cutStat(bundle.diffStat, cuts.statLines);
  const perTask = `call review with task=<taskId> (HTTP: GET ${reviewPath(bundle.milestone)}?task=<taskId>), or full=true for the whole bundle`;
  const omitted: OmittedField[] = [];
  if (withEvidence > 0) omitted.push({ field: 'closure.acceptance', count: withEvidence, fetch: perTask });
  if (summariesCut > 0) omitted.push({ field: 'closure.summary', count: summariesCut, fetch: perTask });
  if (stat.omitted > 0) omitted.push({ field: 'diffStat', count: stat.omitted, fetch: `git diff --stat ${bundle.baseline}..${bundle.integrationSha}` });
  return {
    view: 'index',
    milestone: bundle.milestone,
    integrationSha: bundle.integrationSha,
    reviewVersion: bundle.reviewVersion,
    tag: bundle.tag,
    baseline: bundle.baseline,
    omitted,
    diffStat: stat.text,
    closure,
    acceptanceCriteria: bundle.acceptanceCriteria,
  };
}

/** The full answer: the bundle unchanged, with `view` and `omitted` first. Pure. */
export function fullOf(bundle: ReviewBundle): Record<string, unknown> {
  return { view: 'full', omitted: [], ...bundle };
}

const bad = (parameter: string, reason: string) => ({ ok: false as const, parameter, reason });

/** The request parameters of the review route; query values are strings. */
export function parseReviewQuery(query: Record<string, unknown>): { ok: true; params: ReviewParams } | { ok: false; reason: string; parameter: string } {
  const raw = (k: string) => (query[k] === undefined ? undefined : String(query[k]));
  const fullRaw = raw('full');
  if (fullRaw !== undefined && fullRaw !== 'true' && fullRaw !== 'false') return bad('full', `full must be true or false, not ${JSON.stringify(fullRaw)}`);
  const full = fullRaw === 'true';
  const task = raw('task');
  if (task === '') return bad('task', 'task must name a task id');
  const params: ReviewParams = { full, ...(task !== undefined ? { task } : {}) };
  for (const k of ['statLines', 'summaryChars'] as const) {
    const v = raw(k);
    if (v === undefined) continue;
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n)) return bad(k, `${k} must be an integer of 0 or more, not ${JSON.stringify(v)}`);
    params[k] = n;
  }
  if (task !== undefined && full) return bad('full', 'full=true and task are exclusive: ask for one task or the whole bundle');
  return { ok: true, params };
}

type ReviewSource = Pick<Orchestrator, 'store' | 'config' | 'graph' | 'entry' | 'payloadOf' | 'acceptanceCriteria' | 'reviewBundle'>;

function titleOf(orch: ReviewSource, id: Id): string {
  const node = orch.graph().nodes.get(id);
  const title = node ? orch.payloadOf(node)['title'] : undefined;
  return typeof title === 'string' && title ? title : id;
}

const REPORT_FIELDS = ['summary', 'acceptance', 'interfaces', 'decisions', 'deviations', 'followUps', 'tests', 'noChanges'] as const;

/**
 * The review answer for `milestoneId`. The index and the full view build on `Orchestrator.reviewBundle`; the one-task
 * view reads that task's latest submit report and its published job, and makes no git call.
 */
export async function reviewAnswer(orch: ReviewSource, milestoneId: Id, params: ReviewParams): Promise<ReviewAnswer> {
  if (params.task !== undefined) return taskAnswer(orch, milestoneId, params.task);
  const r = await orch.reviewBundle(milestoneId);
  if (!r.ok) return { status: 409, body: { ok: false, reason: r.reason } };
  const bundle = r.bundle as unknown as ReviewBundle;
  if (params.full) return { status: 200, body: fullOf(bundle) };
  const extras = new Map<Id, TaskExtras>();
  for (const c of bundle.closure) {
    const changed = orch.store.listJobs({ taskId: c.taskId, status: 'published' }).at(-1)?.changedFiles;
    extras.set(c.taskId, { title: titleOf(orch, c.taskId), ...(changed ? { changedFileCount: changed.length } : {}) });
  }
  const cuts: ReviewCuts = {
    statLines: params.statLines ?? orch.config.review.statLines,
    summaryChars: params.summaryChars ?? orch.config.review.summaryChars,
  };
  return { status: 200, body: indexOf(bundle, extras, cuts) };
}

function taskAnswer(orch: ReviewSource, milestoneId: Id, taskId: Id): ReviewAnswer {
  // The same two refusals as Orchestrator.reviewBundle, in the same order.
  const g = orch.graph();
  const node = g.nodes.get(milestoneId);
  if (!node || node.kind !== 'milestone') return { status: 409, body: { ok: false, reason: `${milestoneId} is not a milestone` } };
  const m = orch.entry(milestoneId);
  if (m.status.kind !== 'submitted' || !m.integrationSha) return { status: 409, body: { ok: false, reason: `${milestoneId} is ${m.status.kind}, not submitted` } };
  const closure = [...q.closure(g, milestoneId)].filter((t) => g.nodes.get(t)?.kind === 'task');
  const taskNode = g.nodes.get(taskId);
  if (!taskNode || !closure.includes(taskId)) {
    return { status: 404, body: { ok: false, reason: `${taskId} is not a task in the closure of ${milestoneId}`, closure } };
  }
  const published = orch.store.listJobs({ taskId, status: 'published' }).at(-1);
  const report = orch.store.getCompletionReport(taskId);
  const entry: Record<string, unknown> = {
    taskId,
    title: titleOf(orch, taskId),
    status: orch.entry(taskId).status.kind,
    ...(published?.publishedSha ? { publishedSha: published.publishedSha } : {}),
    acceptanceCriteria: orch.acceptanceCriteria(taskNode),
    ...(published?.changedFiles ? { changedFiles: published.changedFiles } : {}),
  };
  const body = report?.body;
  if (body) for (const k of REPORT_FIELDS) if (body[k] !== undefined) entry[k] = body[k];
  return {
    status: 200,
    body: {
      view: 'task',
      milestone: milestoneId,
      integrationSha: m.integrationSha,
      reviewVersion: m.reviewVersion,
      tag: `milestone/${milestoneId}/v${m.reviewVersion}`,
      omitted: [],
      closure: [entry],
    },
  };
}
