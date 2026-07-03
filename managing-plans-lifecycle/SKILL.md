---
name: managing-plans-lifecycle
description: Use when creating a new design/plan, promoting a plan between stages (ideas → ready → ongoing → retired), starting or resuming an `ongoing` plan, retiring a finished plan to `docs/decisions/`, or surveying what plans are in flight. ALSO invoke this whenever `superpowers:brainstorming` or `superpowers:writing-plans` runs — those skills hardcode `docs/superpowers/specs|plans/` with date-prefixed filenames, which this repo does NOT use; this skill redirects their output to `docs/plans/ideas/` with the date prefix stripped. Defines the `docs/plans/{ideas,ready,ongoing}/` lifecycle convention; per-repo policy on what plans live where is encoded in `AGENTS.md`.
---

# Managing the plans lifecycle

This repo curates design/implementation plans through a four-stage lifecycle. Each stage has its own folder under `docs/plans/`; the file moves between folders as the work matures. Every live plan carries a mandatory priority label: `low`, `medium`, or `high`. After implementation, durable rationale is distilled into `docs/decisions/` and the plan file is deleted. **Code is the source of truth — finished plans are not kept.**

This skill does **not** replace `superpowers:brainstorming` or `superpowers:writing-plans`. Those still own the *content* (design questions, task breakdowns). This skill owns the *lifecycle* — where files live, when they move, and what the `ongoing` status header looks like.

## Folder layout

```
docs/
├── plans/
│   ├── ideas/        # Proposals. May or may not happen. No tasks required.
│   ├── ready/        # Decided to implement. Plan/tasks written. Not started.
│   └── ongoing/      # Being implemented. Status header at top is required.
└── decisions/        # Durable rationale, written when a plan retires. Not in plans/.
```

One file per topic. **Same filename throughout the lifecycle** — only the directory changes.

## Priority label (mandatory)

Every file under `docs/plans/{ideas,ready,ongoing}/` must declare exactly one priority label: `low`, `medium`, or `high`.

Use this metadata line near the top of `ideas/` and `ready/` plans, immediately after the title unless the file already has a compact metadata block:

```markdown
**Priority:** medium
```

For `ongoing/` plans, include the same label in the required Status section:

```markdown
- **Priority:** medium
```

Priority means:
- **high:** security, data integrity, release blocker, live-user breakage, or work that materially reduces operational risk.
- **medium:** decided product/platform work with clear value, important maintainability, or a known pain point that is not urgent.
- **low:** speculative, parked, future-facing, cleanup-only, or work that should wait for a stronger trigger.

When creating or promoting a plan, set the priority deliberately. When surveying plans, call out missing or stale priorities before discussing order. Do not leave `TBD` or omit the field.

### File naming — no date prefixes, ever

Names are bare kebab-case: `app-check-rollout.md`, `image-cropper-ui.md`, `deploy-integrity-guards.md`. **No date prefix in any subfolder.** Not in `ideas/`, not in `ready/`, not in `ongoing/`.

This is a **conscious deviation from the superpowers default**, which writes specs as `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. In this repo, when `superpowers:brainstorming` or `superpowers:writing-plans` produces a dated filename, **strip the date prefix when landing the file in `docs/plans/ideas/`**.

Why no dates:
- The filename is stable across the lifecycle (idea → ready → ongoing). A date that was meaningful when the proposal was drafted becomes misleading by the time implementation starts.
- Git log + the `ongoing` Status header carry every timing question worth answering: when it was proposed, when it was promoted, when it was last touched.
- The folder is the meaningful coordinate, not the date.

If a file lands in `docs/plans/` with a date prefix, rename it on the spot — don't leave it for later. Same applies to file imports from other repos: drop the date during the move.

### Which plans live in this repo

This skill describes *how* plans move through the lifecycle. It does **not** decide *which* repo a given plan belongs in — that's per-repo policy and lives in `AGENTS.md`. As a general principle: single-repo plans live with the code they describe; cross-repo plans live in whichever repo `AGENTS.md` designates as canonical for cross-cutting work. When in doubt, check `AGENTS.md` before creating a plan.

### There is no `docs/superpowers/`, `docs/archive/`, or `docs/plans/{queued,blocked}/`

These namespaces are **retired**:
- **No `docs/superpowers/`.** Brainstorming/PRD output lands directly in `docs/plans/ideas/` (per the `AGENTS.md` override). Do not create files under `docs/superpowers/`.
- **No `docs/archive/`.** Shipped plans are deleted, not archived — an archived plan is a stale snapshot that lies to a future reader as soon as the code drifts. Git history (`git log -- docs/plans/<slug>.md`, `git show <sha>`) recovers any deleted plan.
- **No `queued/` or `blocked/`.** "Decided, ready to start" is `ready/`. "Waiting on a trigger/decision" is `ideas/` if undecided, or `ready/` with the gate stated inline if decided. "Maybe never" is `ideas/`.

## When to invoke this skill

- About to brainstorm or plan something → use it to know where the output should land
- About to promote a plan between stages → use it for the file move + content edits
- Starting or resuming work on an `ongoing/` plan → read the status header **first**
- A plan's implementation is merged → use it to distill into `docs/decisions/` and delete the plan
- The user asks "what plans are in flight" or "what's the status of X" → start from `docs/plans/ongoing/`

## Transitions

### Creating a new plan → `ideas/`

When `superpowers:brainstorming` writes a spec, the override in `AGENTS.md` directs the output to `docs/plans/ideas/<topic>.md` directly. No separate spec/plan file split — one file evolves through the stages. If the brainstorming skill produces a doc under `docs/superpowers/specs/` despite the override, move it to `docs/plans/ideas/` and remove the date prefix.

A new `ideas/` doc should contain at minimum:
- **Priority:** `low`, `medium`, or `high`
- **Goal:** one sentence
- **Context:** why this is being proposed
- **Design / approach:** the actual proposal
- **Open questions:** what's still undecided

No checkboxes required at this stage. The file might sit here for months or get deleted unimplemented — both are fine.

### `ideas/` → `ready/`

The decision has been made to implement. Before moving:

1. Resolve or accept the open questions inline (delete the section once empty, or rename to "Out of scope" with the rejections).
2. Set or re-check the mandatory **Priority** label.
3. Add a **File Structure** section listing files to create/modify/delete.
4. Add **Tasks** with `- [ ]` checkboxes, grouped into stages. Use `superpowers:writing-plans` for the breakdown if the plan is non-trivial.

Then `git mv docs/plans/ideas/<topic>.md docs/plans/ready/<topic>.md`.

### `ready/` → `ongoing/`

Implementation is starting. Before moving:

1. Insert the **Status** section as the first `##` in the file, above any existing content (after the title and Goal line).
2. Fill in the initial values.

Then `git mv docs/plans/ready/<topic>.md docs/plans/ongoing/<topic>.md`.

#### The Status section (required in `ongoing/`)

```markdown
## Status

- **Updated:** YYYY-MM-DD
- **Priority:** low | medium | high
- **Stage:** which task/section is currently in progress
- **Branch:** repo `branch-name` (or "n/a — multi-repo" with a list)
- **Done:** what's verifiably complete (one bullet per chunk, terse)
- **Next:** the immediate next action
- **Blockers:** any open questions or external dependencies
- **Handoff:** non-obvious context another agent needs to resume — env state, regen steps, "rerun X before pushing", anything not visible from the diff
```

Update the Status section:
- At the **start** of every work session (set `Updated`, refresh `Next` and `Blockers`)
- At the **end** of every work session (move items from `Next` to `Done`, refresh `Handoff`)
- Whenever a blocker resolves or a new one appears

The Status section is the contract with the next agent (or future you). If a field doesn't apply, write `none` — don't omit it.

#### Rollout / phase table (keep it when the plan has one)

Some repos ship code on dev → beta → prod at different times and run per-env backfills. A prose Status section alone can't tell "Phase 1 shipped" from "Phase 1 shipped on dev only, beta pending." When an `ongoing/` plan has env-specific or multi-phase state, **keep a verifiable progress table below the Status section** (an env-rollout matrix or a phase table). The Status section is the human summary; the table is the verifiable state — a plan that lacks one can stall silently.

```markdown
## Rollout status

| Step | Dev | Beta | Prod |
|---|---|---|---|
| Code deployed | ✅ | ✅ | ⬜ |
| Backfill executed | ✅ | ⬜ | ⬜ |

Legend: ⬜ pending · ⏳ in progress · ✅ done · ⚠️ blocked (note inline)
```

### `ongoing/` → retired (code merged, plan deleted)

When the implementation is merged:

1. Open the plan and identify what durable rationale is worth keeping. Use this rubric:
   - **Keep** (move to `docs/decisions/<topic>.md`): non-obvious design choices, rejected alternatives with reasons, invariants the code enforces but doesn't explain, dependencies on external systems / contracts, postmortems with surprising failure modes.
   - **Delete**: task lists, file-by-file checklists, "how we did it" prose, status headers, rollout tables, anything visible by reading the code or `git log`.
   - **Delete**: outdated assumptions, open questions that got answered by reality.

2. If anything was kept, write `docs/decisions/<topic>.md` using the repo's ADR-lite shape — **Context / Decision / Rejected alternative / What this binds / Revisit-when** (match existing files in `docs/decisions/`). Keep it short — one decision per file, focused on *why* not *what*. Operational step-by-step procedures belong in a skill, not in `decisions/`.

3. **Delete** the plan file: `git rm docs/plans/ongoing/<topic>.md`. Do not move it to a `done/` folder. Do not keep it "for reference." Code is the reference.

Commit message: `docs: retire <topic> plan; extract decision` (or just `docs: retire <topic> plan` if no decision was extracted).

## How this composes with superpowers

- `superpowers:brainstorming` writes specs → output lands in `docs/plans/ideas/` (per `AGENTS.md` override).
- `superpowers:writing-plans` writes task breakdowns → append to the same file when promoting `ideas/` → `ready/`.
- `superpowers:executing-plans` / `superpowers:subagent-driven-development` consume plans from `docs/plans/ongoing/`.

Do not create files under `docs/superpowers/`. That namespace is retired in this repo.

## Surveying in-flight work

When asked "what's in flight" or "what plans do we have":

1. `ls docs/plans/ongoing/` — what's actively being worked on. Read each file's Status section.
2. `ls docs/plans/ready/` — what's queued.
3. `ls docs/plans/ideas/` — what's been proposed.
4. `ls docs/decisions/` — what's already been decided and shipped (durable record).

Don't grep for completion via checkboxes. Folder location is authoritative.

## Anti-patterns

- **Adding a `done/`, `completed/`, `archive/`, `queued/`, or `blocked/` folder.** Done plans are deleted, not archived. The history is in git + decisions. Decided-not-started is `ready/`; gated/speculative is `ideas/`.
- **Keeping the date prefix.** Dates rot as the plan evolves; the filename should be stable across the lifecycle.
- **Skipping the Status header on `ongoing/`.** A plan without a Status header is unusable for handoff — fix it before doing any other work.
- **Moving a plan into `ongoing/` without a rollout/phase table when it has per-env or multi-phase state.** The Status line alone hides which envs shipped.
- **Writing a decision doc that restates the implementation.** If a future reader could learn it by reading the code, it doesn't belong in `docs/decisions/`.
- **Promoting `ideas/` → `ready/` without resolving open questions.** Move the questions to "Out of scope" or answer them. `ready/` means decided.
- **Re-creating `docs/superpowers/`.** Drafts land directly in `docs/plans/ideas/`.
