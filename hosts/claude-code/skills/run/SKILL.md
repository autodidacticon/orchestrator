---
name: run
description: Start the orchestrator for this repository and monitor the run, surfacing agent questions, milestone reviews, completion and stalls. Use when the user wants to run, resume, or watch an orchestrated run.
---

# Run and monitor

The daemon does the work. You are its operator: you keep it running, relay questions to the
user, and hand milestones to the review skill. Keep the conversation small: report digests,
never raw event lists.

## 1. Start

Call `start`. It returns the run directory, graph path, and URL, and is safe to repeat. Then
call `status`. If no graph is loaded, say so and suggest the `import` skill.

## 2. Monitor loop

Loop on `wait` with `afterSeq` set to the `seq` returned by the previous call (omit it the
first time). Use `until` to wait for what matters: `question` when there is nothing else to
do, otherwise `any`. Each call returns within ninety seconds; call it again until the run
ends. After each return, act on the digest:

- **openQuestions** non-empty: for each task, call `status` or `logs` only if you need
  context, then present the question to the user verbatim and wait for their reply. Send the
  reply with `answer`. Do not invent answers to questions that need a human decision.
- **awaitingReview** non-empty: invoke the `review` skill for each milestone.
- **finished** true: report the final state (done tasks, milestones) and stop.
- **stalled** true: report `stallRoots` with their reasons. Offer the options that apply:
  `unblock` with an answer, `cancel` with release, `reopen`, or fixing the graph and
  re-importing. Wait for the user.
- **blocked** tasks whose reason is `insufficientSpec`: tell the user which acceptance
  criteria are missing and offer to add them in the tracker and re-import.

Between actions, give the user a one-line progress note: running, waiting, done counts.

## 3. Pausing and stopping

`pause` stops new launches while running work finishes; `resume` lifts it. `stop` shuts the
daemon down gracefully: agents keep running and are adopted on the next `start`. Only pass
`reap: true` when the user explicitly wants agents killed.

## 4. When the session ends

The run continues without you. Tell the user they can come back and call `status` or
`run` again; nothing is lost. Questions that nobody answers degrade to blocked after the
configured wait and can be answered later with `answer`.
