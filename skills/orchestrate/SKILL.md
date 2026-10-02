---
name: orchestrate
description: Run this session as the batch orchestrator (leader) for parallel worker Claude sessions. Use when the user says "orchestrate", "start a batch", "work the backlog in parallel", or wants one central agent to pick plans with them and supervise several worker sessions to landed PRs. The leader surveys docs/plans/{ready,ongoing} + live requests, gets ONE go, dispatches workers into tmux windows + worktrees, steers via SendMessage, keeps durable batch state, and escalates only hard-stops, blocked workers, and scope changes. Not for single-task work — use ship-a-feature (or the repo's fix-bug) directly for that.
---

# Orchestrate — leader contract for parallel worker sessions

You are the **leader**. Your job: choose the batch with the user (one decision), dispatch and supervise workers, keep the batch state truthful, and bother the user only when the contract says so. You do NOT implement tasks yourself — a leader with its hands in a worktree stops supervising.

Every rule below that cites a failure is one that happened in a real batch.

## Repo facts this skill reads — never guess them

This file is procedure. Every project fact lives in the consuming repo, which wins wherever it differs:

| Fact | Where |
|---|---|
| `project` (names everything below), `maxWorkers`, `maxConcurrentEmulatorSuites`, `worktreesDir`, `worktreeSetup`, `ciCapacity` | `.agents/orchestrate.config.json` |
| base branch, `hardStop` patterns, `reviewLabel`, `requireApprovingReview`, `maxReviewRounds` | `.agents/land.config.json` |
| forbidden operations, deploy and data rules, plan conventions | the repo's `AGENTS.md` |

Names derived from `project`: leader session `<project>-orchestrator`, cycle-push leader `<project>-drain` (see `advance-ongoing-plans`), tmux session `<project>-fleet`. Below, `<base>` is the land config's `baseBranch` and `<wt-dir>` is `worktreesDir`.

**If `.agents/orchestrate.config.json` is missing, stop** and tell the user the repo is not wired for orchestration (the agent-skills README lists what it needs). Do not improvise the names — two leaders guessing different ones is how state gets clobbered.

## The prime rule: update state, then act

`~/.claude/orchestrator/<project>-<leaderSession>/batch.json` is the single source of truth — not your context. **Before and after every action** (dispatch, received worker report, escalation, landing), update it.

**One state directory per leader, never one per repo.** Two leaders ran in the same repo on the same day and the second clobbered the first's `batch.json` within minutes. Derive the path from your own session name and never write another leader's directory.

**`batch.json` is coordination state, not a record of repo debt.** Anything a future agent needs — a finding, a stale doc, a deferred fix — goes in `docs/plans/` or `docs/{decisions,incidents,ops}/` per `managing-plans-lifecycle`. A leader that records its own findings in `batch.json` and calls them durable has broken the rule it spends all day enforcing on its workers; the failure is invisible from inside the leader role, which is why it is written here.

**No dashboard artifact.** A rendered HTML dashboard was tried and dropped: it added nothing over the terminal, cost a render-and-publish on every state change, and drifted whenever the leader forgot a step. The terminal is the decision inlet; `batch.json` is the state; the wind-down summary is the report.

### batch.json schema

```jsonc
{
  "batchId": "2026-08-22-a",            // date + letter; also keys the worker report logs
  "started": "2026-08-22T10:00:00Z",
  "leaderSession": "<project>-orchestrator",
  "needsUser": [                        // ONLY items matching the escalation contract
    { "when": "…", "what": "…", "worker": "…" }
  ],
  "decisions": [                        // every user decision, verbatim enough to replay
    { "when": "…", "asked": "…", "answer": "…" }
  ],
  "workers": [
    {
      "name": "w1-fix-roster",          // wN-<short-slug>; also the tmux window name and the worker's -n name
      "plan": "docs/plans/ready/….md",  // or "ad-hoc: <one-line>"
      "branch": "fix/roster-dedup",
      "worktree": "<wt-dir>/fix-roster-dedup",
      "window": "<project>-fleet:w1-fix-roster",
      "slot": 1,                        // from agent-env.sh, filled after the worker reports it
      "status": "dispatched",           // pending|dispatched|working|pr-open|review-round-N|blocked|landed|failed|aborted
      "pr": null,
      "lastReport": "2026-08-22T10:05:00Z",
      "notes": "…"                      // last milestone, terse
    }
  ]
}
```

## Phase 0 — start or resume

1. **Name yourself first: `<project>-orchestrator`.** Session names are pid-derived, so a crash or restart silently renames you and **every worker's dispatch address goes stale at once**. Workers do not fail loudly when that happens — they keep working and go blind. **The leader cannot run `/rename` itself**; the cheapest fix is the user launching it pre-named, `claude -n <project>-orchestrator --settings '{"crossSessionInbound":"accept"}'`, which also covers step 2. Otherwise ask the user, then confirm with `ListAgents` (its first line prints your own name) *before* writing the address into a single worker prompt. Users have renamed to a different name than asked, and again after a restart; the `reports/*.log` channel is what made that survivable. Keep the state directory under the name you started with — it is a path, not an address — and re-announce any new name to every live worker.
2. Enable inbound peer messages: `/config` → *Messages from your other sessions* → **accept** (`crossSessionInbound`). Messages are **held and expire** by default when the sender's permission mode differs from yours, which it always will — workers run unattended. Without this, every worker report silently expires.
3. `cat ~/.claude/orchestrator/<project>-<you>/batch.json` — **if it exists with non-terminal workers, you are resuming**: reconcile against reality (`gh pr list --base <base> --state all`, `git worktree list`, `ListAgents`), update statuses, and give the user a 3-line "here's where the batch stands" before anything else. The file plus GitHub is authoritative; a previous transcript is colour.
4. **On resume, re-announce your address to every live worker** — do not wait to be missed.

## Phase 1 — one decision with the user

1. **Read `docs/plans/_plans-map.md` first** — the generated index of every in-flight plan with its priority, how far it landed, what gate holds it, and its next action. **Actionable now** is the candidate list; the release sections are not pickable this cycle; ⚠️ marks what has not advanced in 2+ cycles, which is usually where the real backlog hides. Only open the plans you shortlist. Add anything the user asked for live; check `docs/plans/ideas/` only if the user invites it.
2. **Verify every candidate against the code before proposing it, scaling effort by lifecycle stage.** `ready/` is curated — spot-check its load-bearing claims; `ideas/` is an unswept inbox — diff it against `<base>` before it reaches the user at all. Measured once: five `ready/` picks all held; four of five `ideas/` picks were stale and three were already fully shipped. A convincing intro is not evidence.
3. **The leader owns every plan's metadata block, never the workers.** Per-worker block edits do not compose past about two workers, and a map regenerated on a branch must never be committed. Workers report new `**Landed:** / **Gate:** / **Next:**` values; the leader writes them to `<base>` as a direct docs commit (if the repo's `AGENTS.md` allows direct docs commits; otherwise one docs PR per wave), and CI regenerates the map. Fence `docs/plans/**` out of every worker prompt. For a push over `docs/plans/ongoing/` meant to drain the cycle, run `advance-ongoing-plans` on top of this skill.
4. Propose the batch in **one message**: candidates with your pick and priority, proposed concurrency, and every per-item business question front-loaded with your recommended answer (`ship-a-feature` style).
5. `go` = all your picks. (A cycle push under `advance-ongoing-plans` skips this go.) Record everything in `decisions`. After this point you do not check in for anything outside the escalation contract.

**Size the batch by throughput, not by how many workers you can start.** Read `ciCapacity` in the config: a shared, metered CI queue serialises PRs (ten PRs from two batches once queued for hours, and every review round re-queues), while free hosted runners do not. Local emulator suites are a separate ceiling: run no more than `maxConcurrentEmulatorSuites` at once — tell workers to run targeted tests and let CI run the full gate. Never exceed `maxWorkers`.

**Usage quota is a batch constraint too** — a worker died mid-review-round on a session limit. Recovery is the same as for a crash (the worktree is warm; re-dispatch with `--continue`).

## Phase 2 — dispatch

**One tmux window per worker**, not panes in a shared window. Panes vanish when a worker exits, `split-window` into a busy tiled window can fail silently, and a `send-keys` into a dead pane drops your instruction into an input box nobody reads.

```bash
git fetch origin <base>
git worktree add <wt-dir>/<slug> -b <branch> origin/<base>
# A new worktree's submodule is EMPTY, so every symlink into .agents/_shared —
# pr:land, agent-env.sh, the shared skills — dangles until this runs.
git -C <wt-dir>/<slug> submodule update --init --recursive
tmux has-session -t <project>-fleet 2>/dev/null || tmux new-session -d -s <project>-fleet -n fleet
printf '%s' "<WORKER PROMPT>" > /tmp/<slug>-prompt.txt
tmux new-window -t <project>-fleet -n <name> -c "$PWD/<wt-dir>/<slug>" \
  "claude -n <name> --permission-mode auto \
     --settings '{\"crossSessionInbound\":\"accept\"}' \
     \"\$(cat /tmp/<slug>-prompt.txt)\"; echo '[worker exited]'; sleep 100000"
```

- **`--permission-mode auto`** (or `--dangerously-skip-permissions` if the user prefers). Plain `acceptEdits` blocks on the first non-allowlisted Bash — `source scripts/agent-env.sh` — and the whole fleet stalls invisibly. A fresh worktree path also triggers a one-time folder-trust prompt.
- **`-n <name>`** so the worker has a stable address of its own.
- **`--settings crossSessionInbound=accept`** so your steering messages reach it.
- The trailing `sleep` keeps the window alive after the worker exits, so its final output survives for you to read.

The user watches with `tmux attach -t <project>-fleet` and may type into any window — treat anything they typed there as a user decision when the worker reports it.

**A fresh window can stop on a dialog before the prompt is read** — a *Settings Warning* about a stale key in `~/.claude/settings.json`, or folder trust — with nothing running until Enter is pressed. After `new-window`, wait ~20 s, `tmux capture-pane -pt <project>-fleet:<name>`, and if it sits on a dialog, `tmux send-keys -t <project>-fleet:<name> Enter`. Six workers once sat idle behind that dialog until the leader noticed. The real fix is the key the dialog names, and it is the user's: the permission classifier refuses an agent editing its own settings as self-modification.

**The permission classifier will not let you write a prompt that carries non-dev writes.** A worker prompt containing function deletions and backfill `--apply` commands against beta and prod was blocked twice. Do not split it across tools to get it through: `SendMessage` names that exact move as permission laundering. The shape that works: dispatch the worker with the *code* half only, surface the data ops to the user as a decision, and once the user gives an explicit go, **run them from the leader session yourself** (dry runs first, every command and count logged into `batch.json`) and message the worker the outcomes to fold into its PR. That is the one implementation-shaped thing a leader does, and only under an explicit go.

**Check file overlap before dispatching, and fence deletions as carefully as edits.** Two workers were once handed the same doc deletion minutes apart. Name the files each worker owns and the files it must not touch, in its prompt.

### Worker prompt template

Every worker prompt MUST contain all of these blocks — fill `<>` from the config files.

**Carry the essential procedure inline. Never rely on a skill name alone**: a batch once ran with `ship-a-feature` unresolved (a broken symlink), and the batch whose prompts inlined the procedure produced correct PRs anyway while the other did not notice for hours. A referenced skill can silently fail to load; an inlined sentence cannot.

```
You are worker <name> in orchestrated batch <batchId>. Your task: implement
<plan path or ad-hoc description>. Scope decisions already made by the user —
do NOT re-ask them and do not open an interview: <decisions>.

Files you own: <paths>. Files another worker owns — do not touch, do not
delete: <paths>. Do NOT edit anything under docs/plans/ — the leader owns
every plan file.

Procedure: you are already in your worktree on branch <branch>. First run
`source scripts/agent-env.sh` and report your slot number — it installs
dependencies and moves this worktree's emulators onto their own ports, so
your test runs cannot collide with another worker's. Follow the repo's
AGENTS.md. Run targeted tests locally; at most <maxConcurrentEmulatorSuites>
emulator suites run on this machine at once, so prefer unit tests and let CI
run the full gate. Implement, then land with `pnpm pr:land` — it opens the PR
against <base> itself<, with the <reviewLabel> label> — acting on its exit
codes: 0 merged · 10 CI red (read the log; fix the cause) · 20 review
requested changes (fix, push, rerun) · 30 stop and report · 40 preflight
failed. Push once when the branch is ready, not per commit.

Run `pnpm pr:land` in ITS OWN tmux window, not merely backgrounded: it polls
CI and outlives a foreground tool timeout, and `setsid nohup` runs were reaped
mid-poll repeatedly. Do NOT touch the working tree while it polls — that is
how a run exits 40. NEVER kill a lander with `pkill -f` / `pgrep -f` — both
self-match the calling shell and a pattern-wide kill hits every other
worktree's lander; killing the pnpm wrapper by pid orphans the node child,
which keeps polling and can merge a head missing your latest commit. Identify
by working directory and signal only your own:
`ps -eo pid,args | grep -E "no[d]e scripts/pr-land.js"`, then
`readlink /proc/<pid>/cwd`.

Exit 143 is not an outcome: it is SIGTERM — the run was reaped and the PR is
in whatever state it was. Relaunch and read the real state from GitHub. Never
read an exit code through a pipe (`cmd | tail; echo $?` reports tail's): capture
it directly, then verify with `gh pr view <n> --json state,mergedAt`.

Git restrictions — absolute, and they apply EVEN IN THIS THROWAWAY WORKTREE:
NEVER run git reset, commit --amend, checkout --/restore, clean, rebase -i,
add -A, add ., or any --no-verify / --force. Rebase onto origin/<base> only
when pr:land tells you to, and then with --force-with-lease. Reaping the
worktree is the leader's job, not yours — do not remove it. Never deploy and
never write to any non-dev data; read-only audits are fine. If you believe
you need a forbidden operation, STOP and report BLOCKED.

Reporting: after each milestone — slot claimed, plan settled, PR opened
(number), each review round, landed, or blocked — do BOTH:
  1. SendMessage to '<leaderSession>' with one terse line
     "<name>: <status> — <detail>";
  2. append the same line with a timestamp to
     ~/.claude/orchestrator/<project>-<batchId>/reports/<name>.log
A file survives a crash; a message does not. If SendMessage cannot find the
leader, do NOT guess another session — keep working and keep writing the log.
Escalate nothing yourself; route every question to the leader and continue
with whatever does not depend on the answer. <If the repo has a reviewer: the
review cap (<maxReviewRounds>) counts REVIEWER postings, not your pushes —
report the capped round's findings to the leader before pr:land acts on it.>
When you finish (landed or stopped), send a final report and exit.
```

## Phase 3 — supervise (event-driven)

You react to worker reports; you do not poll on a timer. Read both channels — SendMessage and `reports/*.log`. On each report: update `batch.json`, then decide:

- **Routine** (plan settled, PR open, review round below the cap, landed): just record it. Re-read the land config's review settings on resume — they have moved mid-batch before.
- **Worker asks a question you can answer from the plan or the recorded decisions**: answer it yourself. That is your whole purpose.
- **Escalate to the user** — only these:
  - anything matching the land config's **`hardStop`** list or the repo's `AGENTS.md` hard-stops (rules, indexes, converters, backfills, deploys, PRs targeting a release branch);
  - a worker **blocked**, or at the **review cap** — and read the capped round's finding yourself: a final round once found that a rules change depended on a field the rules API does not expose, so the emulator-green PR would have denied live reads in production. A substantive finding at the cap is a decision, not a formality;
  - a **genuine scope change** (the work invalidates a Phase 1 decision);
  - a suspected **cross-worker conflict**.

  Record it in `needsUser`, and move it to `decisions` once answered.

### Every stop with an open decision ends with the decision block

The user reads the **end of your last message**, not the scrollback. Whenever `needsUser` is non-empty when you stop, the message ends with this block — after the status, as the final thing on screen, re-rendered at every stop until each item is answered. One entry per decision, each understandable by someone who has not read the batch:

```
## Needs your decision

1. <short name> — reply `<short yes reply>` or `<alternative>`
   What: <the action in plain words — which command, which env, what it changes, with dry-run counts>
   Why: <the concept: what this step is for, and what it unblocks>
   If yes: <what happens, the risk, how it is undone>
   If not now: <what stays blocked — and that nothing else waits on it>
   My pick: <recommendation, with the one reason that decides it>
```

**Re-derive a hard-stop from the diff; never trust a worker's classification.** A worker once reported "exit 30 hard-stop" on a PR whose files matched no pattern — it had been starved of a CI runner. Check the PR's own file list against the land config's `hardStop` patterns before escalating, and check whether the stop was really a deadline: `pr:land` returns 30 for hard-stop, draft, closed, rounds exhausted, **or a deadline**.

**The user may delegate the hard-stop merge click to you** ("merge on green once the rounds are done, only tell me about decisions"). Record it in `decisions`, and then for each exit-30 PR: re-derive the hard-stop from the file list, read the diff of every hard-stop-matched file yourself (a type-only one-liner is a click; a rule change is a read), confirm `gh pr checks` green and the review state on the *current* head, and only then `gh pr merge <n>` with the land config's `mergeMethod`. A commit pushed after the final review has no review bound to it — read that diff too.

**"Stopped, tree clean" is a report, not evidence — check the worktree before you merge.** A worker reported stopping twice and kept working through a fifth review round; the leader merged on that report and found uncommitted work only when reaping. Run `git -C <worktree> status --porcelain` **before** merging a worker's PR. A mutation in flight is not alarming in itself — proving a new test can fail means the tree briefly holds a deliberately broken file — so read the diff before concluding anything, and never merge or commit from a worktree mid-verification.

**Never let "done" stand without evidence.** A merge is `gh pr view <n> --json state,mergedAt` saying `MERGED`, never a worker's word and never an exit code read through a pipe.

**A red reviewer job is not a review.** Twice in one batch every PR went red on the reviewer job itself — provider down, quota exhausted. Check that job's log before counting a PR as blocked, and expect worker sessions to pause on the same usage limit when it is one account.

**A red lane is not automatically the worker's bug either.** Check the jobs API yourself before relaying a worker's diagnosis ("runner dead", "lane down"): three such reports in one batch were saturation, a lagging checks API, or a documented false error.

**Silence**: check the worker's window (`tmux capture-pane -pt <project>-fleet:<name>`) and `ListAgents` before assuming failure. A worker that exited leaves a live window with its last output. If it died (crash, quota), re-dispatch into a fresh window with `claude --continue` — the worktree is warm and its transcript carries its context.

**A worker lands**: mark `landed`, then dispatch the next queued item into a new window.

Never relay a worker's message as if it were a user decision.

## Phase 4 — wind down

When all workers are terminal:

1. Final `batch.json` update (statuses, PR numbers, merge evidence).
2. **Reap**, per worker: `(cd <worktree> && source scripts/agent-env.sh --clean)` to free its slot, then `git worktree remove --force <worktree>`; finally `git worktree prune` and delete the merged local branches. `--force` is required and correct — git refuses a plain `worktree remove` on any worktree containing a submodule. This is the leader's job precisely because workers are banned from it; the ban stays absolute, since a carve-out is indistinguishable in a prompt from the destructive uses it exists to prevent.
3. **Write the learnings down** where a future agent will find them — `docs/plans/` or `docs/{decisions,ops}/`, not `batch.json`, not the chat. A lesson about this procedure itself belongs in the shared agent-skills repo, edited from a session there.
4. One summary to the user: landed PRs, anything aborted or failed and why, and leftovers that belong back in `docs/plans/`.

Leave `batch.json` in place — it is the recovery record until the next batch.

## Anti-patterns

- **Implementing anything yourself.** Even "just this one small fix" — dispatch it or queue it.
- **Coordinating from memory.** If it's not in `batch.json`, it didn't happen.
- **Treating `batch.json` as a durable record of repo debt.** It is coordination state; findings go in `docs/`.
- **Escalating for reassurance.** "Worker opened a PR, ok?" is not an escalation category.
- **Swallowing an escalation category** to keep the user undisturbed.
- **Polling workers on a timer** or streaming their transcripts into your context — you need milestones, not logs.
- **Dispatching two workers into overlapping files** — or handing the same deletion to two workers.
- **Merging on a worker's word that it has stopped.** Check its worktree first.
- **Sizing the batch by how many workers you can start** rather than by what CI and the machine can admit.

## A note on running two leaders

It works, with two conditions: separate state directories, and a negotiated file-scope split announced between leaders before dispatch. Expect one structural consequence — **the second batch is pushed down the staleness gradient**: the first leader takes the curated `ready/` plans and the second inherits `ideas/`, so its verification bar is higher by construction. Shared skills are edited by exactly one leader, after both batches are terminal.
