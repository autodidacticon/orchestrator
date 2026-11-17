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
  field: 'closure.acceptance' | 'closure.summary' | 'diffStat' | 'previous.diffStat';
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

/** One closure task as a submitted transition event records it. */
export interface ClosureSha {
  taskId: Id;
  publishedSha?: string;
}

/**
 * What the answer needs to name the previous review version. Gathered by `gatherPrevious`; see specs/operator-control
 * "Review answer names the previous version".
 */
export interface PreviousFacts {
  /** The milestone's review version now (n). */
  version: number;
  milestone: Id;
  /** The sha version n-1 was pinned at (kv `tagged:<id>:<n-1>`); undefined when none is on record. */
  sha?: string;
  integrationSha: string;
  closure: ClosureSha[];
  /** The closure of version n-1; undefined when it cannot be read. */
  previousClosure?: ClosureSha[];
  /** `git diff --stat <sha>..<integrationSha>`; undefined when the shas are equal or no sha is on record. */
  stat?: string;
}

export interface PreviousTask {
  taskId: Id;
  change: 'added' | 'republished';
}

/**
 * The `previous` block, or undefined at version 1. With `statLines` the stat is cut as the index cuts `diffStat`, and a
 * cut gives an `omitted` element; without it the stat is whole. Pure: makes no git call.
 */
export function previousOf(f: PreviousFacts, statLines?: number): { previous: Record<string, unknown>; omitted: OmittedField[] } | undefined {
  if (f.version <= 1) return undefined;
  const version = f.version - 1;
  if (!f.sha) {
    return {
      previous: { version, unavailable: `No sha is on record for version ${version} of ${f.milestone} (kv tagged:${f.milestone}:${version} is absent), so nothing can be compared with it.` },
      omitted: [],
    };
  }
  const previous: Record<string, unknown> = { version, sha: f.sha, tag: `milestone/${f.milestone}/v${version}` };
  const sameCommit = f.sha === f.integrationSha;
  if (sameCommit) previous['sameCommit'] = true;
  if (f.previousClosure) {
    const before = new Map(f.previousClosure.map((c) => [c.taskId, c.publishedSha]));
    const since: PreviousTask[] = [];
    for (const c of f.closure) {
      if (!before.has(c.taskId)) since.push({ taskId: c.taskId, change: 'added' });
      else if (before.get(c.taskId) !== c.publishedSha) since.push({ taskId: c.taskId, change: 'republished' });
    }
    previous['tasksSince'] = since;
  } else {
    previous['tasksSinceUnavailable'] = true;
  }
  const omitted: OmittedField[] = [];
  const whole = sameCommit ? '' : (f.stat ?? '');
  if (statLines === undefined) {
    previous['diffStat'] = whole;
  } else {
    const cut = cutStat(whole, statLines);
    previous['diffStat'] = cut.text;
    if (cut.omitted > 0) omitted.push({ field: 'previous.diffStat', count: cut.omitted, fetch: `git diff --stat ${f.sha}..${f.integrationSha}` });
  }
  if (!sameCommit && whole.trim() === '') {
    previous['diffStatNote'] = `git printed nothing: either no file differs between ${f.sha} and ${f.integrationSha}, or commit ${f.sha} is not in the daemon's clone.`;
  }
  return { previous, omitted };
}

/** The index built from the full bundle, with `previous` when facts for it are given. Pure. */
export function indexOf(bundle: ReviewBundle, extras: ReadonlyMap<Id, TaskExtras>, cuts: ReviewCuts, facts?: PreviousFacts): Record<string, unknown> {
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
  const prev = facts ? previousOf(facts, cuts.statLines) : undefined;
  if (prev) omitted.push(...prev.omitted);
  return {
    view: 'index',
    milestone: bundle.milestone,
    integrationSha: bundle.integrationSha,
    reviewVersion: bundle.reviewVersion,
    tag: bundle.tag,
    baseline: bundle.baseline,
    omitted,
    ...(prev ? { previous: prev.previous } : {}),
    diffStat: stat.text,
    closure,
    acceptanceCriteria: bundle.acceptanceCriteria,
  };
}

/** The full answer: the bundle unchanged, with `view` and `omitted` first, then `previous` when facts for it are given. Pure. */
export function fullOf(bundle: ReviewBundle, facts?: PreviousFacts): Record<string, unknown> {
  const prev = facts ? previousOf(facts) : undefined;
  return { view: 'full', omitted: [], ...(prev ? { previous: prev.previous } : {}), ...bundle };
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

type ReviewSource = Pick<Orchestrator, 'store' | 'config' | 'graph' | 'entry' | 'payloadOf' | 'acceptanceCriteria' | 'reviewBundle' | 'workspace'>;

function closureShas(v: unknown): ClosureSha[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ClosureSha[] = [];
  for (const c of v) {
    const entry = c as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || typeof entry['taskId'] !== 'string') return undefined;
    const sha = entry['publishedSha'];
    out.push({ taskId: entry['taskId'], ...(typeof sha === 'string' ? { publishedSha: sha } : {}) });
  }
  return out;
}

/**
 * The facts for `previous`, or undefined at version 1. The sha comes from kv `tagged:<id>:<n-1>`. The closure of version
 * n-1 comes from the milestone's second to last submitted transition (the last is the current version's), and is used
 * only when that event's `integrationSha` equals the kv sha. One git call, only when the two shas differ; a throw is an
 * empty stat.
 */
export async function gatherPrevious(orch: Pick<ReviewSource, 'store' | 'workspace'>, bundle: ReviewBundle): Promise<PreviousFacts | undefined> {
  const n = bundle.reviewVersion;
  if (!(n > 1)) return undefined;
  const id = bundle.milestone;
  const closure: ClosureSha[] = bundle.closure.map((c) => ({ taskId: c.taskId, ...(c.publishedSha ? { publishedSha: c.publishedSha } : {}) }));
  const facts: PreviousFacts = { version: n, milestone: id, integrationSha: bundle.integrationSha, closure };
  const sha = orch.store.getKv(`tagged:${id}:${n - 1}`);
  if (!sha) return facts;
  facts.sha = sha;
  // No limit: every transition of the milestone, in seq order.
  const submitted = orch.store.listEvents({ kind: 'transition', taskId: id }).filter((e) => e.payload?.['to'] === 'submitted');
  const before = submitted.at(-2)?.payload;
  if (before && before['integrationSha'] === sha) {
    const prev = closureShas(before['closure']);
    if (prev) facts.previousClosure = prev;
  }
  if (sha !== bundle.integrationSha) {
    try {
      facts.stat = await orch.workspace.diffStat(sha, bundle.integrationSha);
    } catch {
      facts.stat = '';
    }
  }
  return facts;
}

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
  const facts = await gatherPrevious(orch, bundle);
  if (params.full) return { status: 200, body: fullOf(bundle, facts) };
  const extras = new Map<Id, TaskExtras>();
  for (const c of bundle.closure) {
    const changed = orch.store.listJobs({ taskId: c.taskId, status: 'published' }).at(-1)?.changedFiles;
    extras.set(c.taskId, { title: titleOf(orch, c.taskId), ...(changed ? { changedFileCount: changed.length } : {}) });
  }
  const cuts: ReviewCuts = {
    statLines: params.statLines ?? orch.config.review.statLines,
    summaryChars: params.summaryChars ?? orch.config.review.summaryChars,
  };
  return { status: 200, body: indexOf(bundle, extras, cuts, facts) };
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

/** A stored event as the events route serves it. */
export interface CutEvent {
  kind: string;
  taskId?: Id;
  payload?: Record<string, unknown>;
}

/**
 * A milestone's submitted transition with the cuts of the index: `diffStat` cut by `cutStat`, each closure entry's
 * `summary` cut by `cutSummary` with `summaryLength` beside it, and an `omitted` list. Any other event is returned as
 * given, whatever its size. Never mutates `event`. See specs/operator-control "Cut submitted events on request".
 */
export function cutSubmittedEvent<E extends CutEvent>(event: E, cuts: ReviewCuts): E {
  const p = event.payload;
  if (event.kind !== 'transition' || !p || p['to'] !== 'submitted') return event;
  const hasStat = typeof p['diffStat'] === 'string';
  const hasClosure = Array.isArray(p['closure']);
  if (!hasStat && !hasClosure) return event;
  const milestone = event.taskId ?? '';
  const payload: Record<string, unknown> = { ...p };
  const omitted: OmittedField[] = [];
  if (hasClosure) {
    let summariesCut = 0;
    payload['closure'] = (p['closure'] as unknown[]).map((c) => {
      const entry = c as Record<string, unknown> | null;
      if (!entry || typeof entry !== 'object' || typeof entry['summary'] !== 'string') return c;
      const whole = entry['summary'];
      const summary = cutSummary(whole, cuts.summaryChars);
      if (summary.length < whole.length) summariesCut++;
      return { ...entry, summary, summaryLength: whole.length };
    });
    if (summariesCut > 0) {
      omitted.push({
        field: 'closure.summary',
        count: summariesCut,
        fetch: `call review with milestone=${milestone} and task=<taskId> (HTTP: GET ${reviewPath(milestone)}?task=<taskId>)`,
      });
    }
  }
  if (hasStat) {
    const stat = cutStat(p['diffStat'] as string, cuts.statLines);
    payload['diffStat'] = stat.text;
    if (stat.omitted > 0) {
      omitted.push({
        field: 'diffStat',
        count: stat.omitted,
        fetch: `call review with milestone=${milestone} and full=true (HTTP: GET ${reviewPath(milestone)}?full=true)`,
      });
    }
  }
  payload['omitted'] = omitted;
  return { ...event, payload };
}

/** The `cutSubmitted` parameter of the events route; query values are strings. Absent or `false` serves events whole. */
export function parseCutSubmitted(query: Record<string, unknown>): { ok: true; cut: boolean } | { ok: false; reason: string; parameter: string } {
  const v = query['cutSubmitted'];
  if (v === undefined || v === 'false') return { ok: true, cut: false };
  if (v === 'true') return { ok: true, cut: true };
  return bad('cutSubmitted', `cutSubmitted must be true or false, not ${JSON.stringify(String(v))}`);
}
