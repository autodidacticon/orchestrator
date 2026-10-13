export const meta = {
  name: 'orchestrator-work',
  description: 'Fan out N worker loops that claim prepared launches from the orchestrator daemon, do the work in the prepared worktree, and report; stop when nothing is claimable.',
  whenToUse: 'When the work skill runs a pull-mode or mixed-mode orchestrator run inside this session.',
  phases: [{ title: 'Claim' }, { title: 'Work' }],
}

const workers = Math.max(1, Math.min(16, Number((args && args.workers) || 2)))
const runTag = String((args && args.runTag) || 'work')
const held = {}
const outcomes = []
let lastDigest = {}

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    claimed: { type: 'boolean' },
    stop: { type: 'boolean' },
    launchId: { type: 'string' },
    taskId: { type: 'string' },
    token: { type: 'string' },
    worktree: { type: 'string' },
    briefPath: { type: 'string' },
    briefMarkdown: { type: 'string' },
    pendingSeq: { type: 'number' },
    pendingAnswer: { type: 'string' },
    finished: { type: 'boolean' },
    stalled: { type: 'boolean' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    awaitingReview: { type: 'array', items: { type: 'string' } },
    claimable: { type: 'number' },
  },
  required: ['claimed', 'stop'],
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

function claimPrompt(workerId, heldCount) {
  return [
    `You are the claimer for orchestrator worker "${workerId}". Use the orchestrator operator MCP tools (names end in claim, wait, status; load them with ToolSearch if needed).`,
    `1. Call claim with workerId "${workerId}" and access "local".`,
    '2. If it returns a launch (status 200): read the markdown brief at briefPath and return { claimed: true, launchId, taskId, token, worktree, briefPath, briefMarkdown: <the full brief file>, pendingSeq, pendingAnswer } (pending fields only when the response carries pending).',
    '3. If it returns 404 (nothing claimable or paused): call wait with until "any" and timeoutMs 30000, then call status. Return { claimed: false, stop, finished, stalled, openQuestions, awaitingReview, claimable } from status.',
    `   stop is true when finished is true, or stalled is true, or (claimable is 0 and ${heldCount} launches are held by other loops is false and (openQuestions is non-empty or awaitingReview is non-empty)). Otherwise stop is false.`,
    '4. On any other error return { claimed: false, stop: true }.',
    'Return only the structured output; do not do any task work.',
  ].join('\n')
}

function workerPrompt(c) {
  return [
    `You are an orchestrator worker holding launch ${c.launchId} for task ${c.taskId}. Work in the worktree ${c.worktree} with your ordinary tools (read, edit, run commands there). Commit on the launch branch as you go; never touch the integration branch.`,
    'Use the orchestrator operator MCP tools with launchId and token for every report (load them with ToolSearch if needed):',
    `- launch_report with kind "submit", seq 1, a summary, and acceptance evidence for every acceptance criterion in the brief, once your work is committed and the worktree is clean. A 409 with "dirtyWorktree" lists uncommitted files: commit them and call again with the same seq.`,
    '- launch_block with seq 2 to ask a human a question when you cannot proceed; while it returns pending, call it again with the same seq until it returns the answer, then continue.',
    `- launch_heartbeat with a short progress text after long steps; launch_inbox to read notices (stuck, nudge, baseMoved, payloadChanged).`,
    '- launch_report with kind "fail" if the task cannot be done, saying what would unblock it.',
    'Never write a fallback report file. If any tool returns 401 your launch has been revoked: stop immediately and return outcome "fenced".',
    c.pendingSeq !== undefined
      ? `A question was asked earlier with seq ${c.pendingSeq}${c.pendingAnswer !== undefined ? ` and the answer is: ${c.pendingAnswer}` : '; call launch_block with that seq to collect the answer before continuing'}.`
      : '',
    `Credentials: launchId ${c.launchId}, token ${c.token}.`,
    '',
    'The brief:',
    c.briefMarkdown || `(read ${c.briefPath})`,
    '',
    'When done, return { taskId, outcome, summary } where outcome is submitted, failed, question (you asked and nobody answered within the pending retries), fenced, or released.',
  ].join('\n')
}

async function loop(i) {
  const workerId = `${runTag}-${i + 1}`
  for (let cycle = 0; cycle < 200; cycle++) {
    const heldCount = Object.keys(held).filter((k) => k !== workerId).length
    const c = await agent(claimPrompt(workerId, heldCount), { label: `claim:${workerId}`, phase: 'Claim', schema: CLAIM_SCHEMA, effort: 'low' })
    if (!c) break
    if (!c.claimed) {
      lastDigest = { finished: c.finished, stalled: c.stalled, openQuestions: c.openQuestions || [], awaitingReview: c.awaitingReview || [], claimable: c.claimable || 0 }
      if (c.stop) break
      continue
    }
    held[workerId] = c.taskId
    log(`${workerId}: working ${c.taskId}`)
    const r = await agent(workerPrompt(c), { label: `work:${c.taskId}`, phase: 'Work', schema: OUTCOME_SCHEMA })
    delete held[workerId]
    const outcome = r || { taskId: c.taskId, outcome: 'failed', summary: 'worker agent returned nothing' }
    outcomes.push({ worker: workerId, ...outcome })
    log(`${workerId}: ${c.taskId} ${outcome.outcome}`)
  }
}

await parallel(Array.from({ length: workers }, (_, i) => () => loop(i)))
return { runTag, workers, outcomes, digest: lastDigest }
