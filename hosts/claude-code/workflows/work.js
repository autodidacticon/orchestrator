export const meta = {
  name: 'orchestrator-work',
  description: 'Fan out N worker loops that claim prepared launches from the orchestrator daemon (a cheap claimer polls; the worker runs with the launch\'s model and effort), do the work in the prepared worktree, and report; stop when nothing is claimable.',
  whenToUse: 'When the work skill runs a pull-mode or mixed-mode orchestrator run inside this session. Args: workers, runTag, capacity (clamps workers), claimModel and claimEffort (the claimer; default claude-haiku-5-5 at low).',
  phases: [{ title: 'Claim' }, { title: 'Work' }],
}

// The claimer makes no decision (claim, wait, copy the digest fields): the script decides when a loop stops (stopRule), so the claimer runs on a fixed cheap model unless the user asks otherwise. See specs/host-integration "Work skill and workflow".
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const claimModel = String((args && args.claimModel) || 'claude-haiku-5-5')
const claimEffort = EFFORTS.includes(args && args.claimEffort) ? args.claimEffort : 'low'
const CLAIM_POLLS = 3
const CLAIM_WAIT_MS = 90000
const requested = Math.max(1, Math.min(16, Number((args && args.workers) || 2)))
const capacity = Number(args && args.capacity)
// A loop beyond the daemon's capacity would only poll for a slot that is never filled.
const workers = Number.isInteger(capacity) && capacity > 0 && capacity < requested ? capacity : requested
if (workers !== requested) log(`workers clamped from ${requested} to the run's capacity ${workers}`)
const runTag = String((args && args.runTag) || 'work')
const held = {}
const outcomes = []
let lastDigest = {}

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    claimed: { type: 'boolean' },
    launchId: { type: 'string' },
    taskId: { type: 'string' },
    token: { type: 'string' },
    worktree: { type: 'string' },
    briefPath: { type: 'string' },
    pendingSeq: { type: 'number' },
    pendingAnswer: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    leaseTtlMs: { type: 'number' },
    renewEveryMs: { type: 'number' },
    finished: { type: 'boolean' },
    stalled: { type: 'boolean' },
    claimable: { type: 'number' },
    preparing: { type: 'number' },
    verifying: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    awaitingReview: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
  required: ['claimed'],
}

const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    outcome: { type: 'string', enum: ['submitted', 'failed', 'question', 'fenced', 'released'] },
    summary: { type: 'string' },
  },
  required: ['taskId', 'outcome', 'summary'],
}

function claimPrompt(workerId) {
  return [
    `You are the claimer for orchestrator worker "${workerId}". Use the orchestrator operator MCP tools claim and wait (load them with ToolSearch if needed). You make no decisions: follow these steps exactly.`,
    // This workflow's workers are Claude Code subagents, so they only take launches prepared for claude-code. See specs/pull-runner "Claim".
    // brief: false leaves the parsed brief out of the answer; the worker reads the brief file itself. See specs/operator-mcp "Worker tools".
    `1. Call claim with workerId "${workerId}", access "local", and runner "claude-code", plus brief: false (the answer then leaves the brief out).`,
    '2. If it returns a launch (answer 200): return { claimed: true, launchId, taskId, token, worktree, briefPath, model, effort, leaseTtlMs: lease.ttlMs, renewEveryMs: lease.renewEveryMs, pendingSeq: pending.seq, pendingAnswer: pending.answer } (model, effort and the lease numbers exactly as the answer gives them; the pending fields only when the answer carries pending). Do not open or read the brief file.',
    `3. If it returns 404 (nothing claimable for claude-code, or paused): call wait with until "any" and timeoutMs ${CLAIM_WAIT_MS}. From the digest in its answer take finished, stalled, claimable as claimableByKind["claude-code"], preparing as preparingByKind["claude-code"] (0 when the digest has no preparingByKind), verifying (empty when absent), openQuestions and awaitingReview.`,
    `   If finished or stalled is true, return { claimed: false, finished, stalled, claimable, preparing, verifying, openQuestions, awaitingReview } at once. Otherwise, if you have done fewer than ${CLAIM_POLLS} polls (a poll is one claim followed by one wait), go back to step 1; after poll ${CLAIM_POLLS} return those fields with claimed false.`,
    '4. On any other error return { claimed: false, error: <the error text> }.',
    'Return only the structured output; do not do any task work.',
  ].join('\n')
}

// The loop's stop decision, made in code from the claimer's last digest fields; othersHold is whether another loop holds a launch. See specs/host-integration "Work workflow: claimer agent: stop rule in the script".
function stopRule(d, othersHold) {
  if (!d) return false
  if (d.finished === true || d.stalled === true) return true
  const verifying = Array.isArray(d.verifying) ? d.verifying : []
  const questions = Array.isArray(d.openQuestions) ? d.openQuestions : []
  const reviews = Array.isArray(d.awaitingReview) ? d.awaitingReview : []
  const idle = (Number(d.claimable) || 0) === 0 && (Number(d.preparing) || 0) === 0 && verifying.length === 0 && !othersHold
  return idle && (questions.length > 0 || reviews.some((id) => !verifying.includes(id)))
}

// The interval comes from the claim (lease.ttlMs and lease.renewEveryMs, a third of the TTL); nothing renews the lease between this agent's calls. See specs/host-integration "Work workflow heartbeat interval".
function leaseRule(c) {
  const ttl = Number(c.leaseTtlMs)
  const every = Number(c.renewEveryMs) > 0 ? Number(c.renewEveryMs) : ttl > 0 ? Math.max(1, Math.floor(ttl / 3)) : 0
  if (!(every > 0)) return '- launch_heartbeat with a short progress text after long steps: every call renews your lease, and a silent launch is expired.'
  return [
    `- Your lease lasts ${ttl > 0 ? `${ttl}ms` : '(see the claim)'} and only your own calls renew it. Call launch_heartbeat with a short progress text at least every ${every}ms (a third of the lease), and never let longer than that pass without a launch_* call.`,
    `  You cannot call a tool while a foreground command runs, so run any command expected to take longer than ${every}ms (a full test suite, an install, a build) in the background and call launch_heartbeat while it runs; then read its output.`,
  ].join('\n')
}

// A claim answer without briefPath falls back to the brief's place in the worktree. See specs/host-integration "Work workflow: worker tool instructions: brief path fallback".
function briefPathOf(c) {
  if (typeof c.briefPath === 'string' && c.briefPath) return c.briefPath
  return `${String(c.worktree || '').replace(/\/+$/, '')}/.orchestrator/brief.md`
}

function workerPrompt(c) {
  return [
    `You are an orchestrator worker holding launch ${c.launchId} for task ${c.taskId}. Work in the worktree ${c.worktree} with your ordinary tools (read, edit, run commands there). Commit on the launch branch as you go; never touch the integration branch.`,
    'Use the orchestrator operator MCP tools with launchId and token for every report (load them with ToolSearch if needed):',
    `- launch_report with kind "submit", seq 1, a summary, and acceptance evidence for every acceptance criterion in the brief, once your work is committed and the worktree is clean. A 409 with "dirtyWorktree" lists uncommitted files: commit them and call again with the same seq.`,
    '- launch_block with seq 2 to ask a human a question when you cannot proceed; while it returns pending, call it again with the same seq until it returns the answer, then continue.',
    leaseRule(c),
    '- launch_inbox to read notices (stuck, nudge, baseMoved, payloadChanged).',
    '- launch_report with kind "fail" if the task cannot be done, saying what would unblock it.',
    'Never write a fallback report file. If any tool returns 401 your launch has been revoked: stop immediately and return outcome "fenced".',
    c.pendingSeq !== undefined
      ? `A question was asked earlier with seq ${c.pendingSeq}${c.pendingAnswer !== undefined ? ` and the answer is: ${c.pendingAnswer}` : '; call launch_block with that seq to collect the answer before continuing'}.`
      : '',
    `Credentials: launchId ${c.launchId}, token ${c.token}.`,
    '',
    `The brief is the file ${briefPathOf(c)}. Read the whole file before doing anything else; it holds the task, its acceptance criteria and the definition of done.`,
    '',
    'When done, return { taskId, outcome, summary } where outcome is submitted, failed, question (you asked and nobody answered within the pending retries), fenced, or released.',
  ].join('\n')
}

async function loop(i) {
  const workerId = `${runTag}-${i + 1}`
  let silent = 0
  for (let cycle = 0; cycle < 200; cycle++) {
    const c = await agent(claimPrompt(workerId), { label: `claim ${workerId}`, phase: 'Claim', schema: CLAIM_SCHEMA, model: claimModel, effort: claimEffort })
    // A claimer that returns nothing is run once more; a held launch comes back to the same worker id with repeated: true. See specs/host-integration "Work workflow: claimer agent: a silent claimer".
    if (!c) {
      if (++silent >= 2) {
        log(`${workerId}: claimer returned nothing twice, loop ends`)
        break
      }
      log(`${workerId}: claimer returned nothing, retrying`)
      continue
    }
    silent = 0
    if (!c.claimed) {
      if (c.error) {
        log(`${workerId}: claimer error, loop ends: ${c.error}`)
        break
      }
      lastDigest = { finished: c.finished, stalled: c.stalled, openQuestions: c.openQuestions || [], awaitingReview: c.awaitingReview || [], claimable: c.claimable || 0, preparing: c.preparing || 0, verifying: c.verifying || [] }
      if (stopRule(c, Object.keys(held).some((k) => k !== workerId))) break
      continue
    }
    held[workerId] = c.taskId
    log(`${workerId}: working ${c.taskId}`)
    // The launch's model and effort were fixed when the daemon prepared it; the worker agent runs with them. See specs/model-selection.
    const r = await agent(workerPrompt(c), { label: `work ${workerId} ${c.taskId}`, phase: 'Work', schema: OUTCOME_SCHEMA, ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}) })
    delete held[workerId]
    const outcome = r || { taskId: c.taskId, outcome: 'failed', summary: 'worker agent returned nothing' }
    outcomes.push({ worker: workerId, ...outcome })
    log(`${workerId}: ${c.taskId} ${outcome.outcome}`)
  }
}

await parallel(Array.from({ length: workers }, (_, i) => () => loop(i)))
return { runTag, workers, claimModel, claimEffort, outcomes, digest: lastDigest }
