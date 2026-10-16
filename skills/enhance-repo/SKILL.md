---
name: enhance-repo
description: Autonomous enhancement pass over one repo that files plans, never code. Measures the repo and its git history, finds the enhancements worth having (architecture, reliability, product, record), dedups against the backlog, decides each design without asking, and files up to N `docs/plans/ideas/` plans under the repo's own rules — pre-approved only where its `## Approval` frees them. Ends with one report. Use when the user says "enhance this repo", "find improvements", "architecture pass", "find refactor opportunities", "what should this repo do next", or when the approved pool is running dry.
---

# Enhance one repo

A pass that turns evidence into plans. It **writes plans, never code**, and runs start to
finish without asking; the user's only touchpoint is the final report and a yes on the
plans that need one. Its output plugs into the plan lifecycle where the other skills expect
it: everything lands in `docs/plans/ideas/`; `review-ideas` and the user move ideas to
`ready/`; `advance-plans` builds `ready/` and the pre-approved ideas.

## Repo facts this skill reads — never guess them

| Fact | Where |
|---|---|
| branch rules for a docs-only commit, hard stops, commit conventions, plan language | the repo's `AGENTS.md` |
| what agents may start without asking | `AGENTS.md` `## Approval` (absent → nothing is pre-approved) |
| source dirs, languages, test harness, domain invariants | `AGENTS.md`, README, any sub-directory `AGENTS.md` and domain skills it names |
| base branch | `.agents/land.config.json` `baseBranch`, else `AGENTS.md`, else `origin/HEAD` |
| commit subject format (conventional or `<scope>: …`), PR labels, review loops a PR must pass | `AGENTS.md`, `.agents/land.config.json` |
| where worktrees live | the caller's scratch path if it gives one — this beats an in-repo location in `AGENTS.md` — else `AGENTS.md`, else a scratch dir outside the repo |
| plan validator | `scripts/plans-map.js --validate` if present; in a record repo, also its own health check (e.g. `record-check.py`) |
| plans that live outside the repo but cover it | the workspace's cross-repo plans and any upstream convention repo `AGENTS.md` names |
| trailers the repo's plan skills query (`Reviewed-Idea:`, `Pre-Approved:`) | used only if `review-ideas`/`advance-plans` are wired, or `AGENTS.md` names them |

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| a path, domain or named area | **scoped**: run only there; the user already said it hurts, so low churn is no reason to drop it | whole repo |
| `--n <k>` | at most `k` plans | 3 (scoped: 2) |
| `--lens <name>[,…]` | only these lenses (§1) | every lens the repo's kind allows |
| `--dry-run [<out>]` | write the plans straight to `<out>/<repo>/` (default: a scratch dir, named in the report), no worktree, commit nothing, still return the report | off |

`N` is a ceiling, never a quota. Zero plans with a good reason is a correct result; filler
is not.

## 0. Set up

- Read `AGENTS.md` before anything else; it wins over this file wherever they differ. Of
  what it points to, read now only what shapes planning — code maps, architecture docs,
  domain invariants. Build-time procedure (delivery, release, guardrail skills) is read
  only when a candidate touches its domain.
- `git fetch origin` and measure `origin/<base>`, not the local branch: the worktree and
  the builder both start from origin.
- Decide the repo's **kind**: **code** (source, usually tests/CI), **record** (a
  system-of-record: sources and renderings, a declared perimeter, no app code), or
  **mixed** (both). The kind picks the lenses. A record repo with support scripts and
  tests is **record**, plus the reliability lens over those scripts. An app with content
directories (manuscripts, a design kit) that declare no perimeter is **code**.
- No `## Approval` section → every plan will be **needs a yes**; skip the pre-approval
  analysis in §5 and spend the effort on evidence instead.
- Read-only git in the main checkout (`fetch`, `status`, `log`, `show`, `diff`). All writes happen
  in a detached worktree of `origin/<base>` (location: the facts table), removed once
  pushed. A dry run needs no worktree. Never write in a main checkout another session may be using.
- **Budget.** Aim to finish in well under an hour of agent time. Never block on a slow
  scout: write the plans the evidence already justifies, and list what was not finished as
  `PENDING` in the report. A partial pass that files two good plans beats a complete one
  that files none.
- **Subagent restrictions** (for every scout or designer you dispatch, even in a throwaway
  worktree): read-only git only; no `reset`, `commit --amend`, `checkout --`/`restore`/
  `clean`, `rebase`, `add -A`/`add .`, no hook-bypass flags, no `worktree remove`; report
  BLOCKED instead of attempting a destructive op.

## 1. Measure — evidence, not taste

Always: README, `AGENTS.md`, and the last ~90 days of `git log` (widen to a year if the
repo was quiet). For the backlog — `docs/plans/`, `docs/decisions/`, `docs/incidents/`
— read titles and metadata blocks first (`head -8` each), and read a file in full only
when a candidate touches it; a repo with 50+ docs makes "read everything" the whole budget.
Incidents are prime reliability evidence: "what still bites" lives there.

**Fix commits.** Match the repo's commit style, not conventional commits alone: grep the
subject for `fix|revert|hotfix|crash|broke|regress` (`git log -i -E --grep=…`). On config
files the count is noisy (tuning commits say "fix" too): read the subjects before trusting
it.

Then per lens:

**architecture** (code). Rank files by churn × size, boosted by fix density and by
co-change partners in a *different* module (a seam that leaks). "Code" includes config
that behaves like code — playbooks, compose files, Dockerfiles, CI workflows, SQL —
so in an infra repo rank YAML too (default: `yml|yaml|py|sh|j2|Dockerfile|Makefile`);
exclude lockfiles, generated files and prose docs. For a very large file, or a repo laid
out by module (`services/<svc>`), compute co-change per module rather than per file.
Shared resource files every feature touches (locale strings, lockfiles, barrel exports)
are not co-change evidence. Renames split a file's history: fold the old path's counts
into the new one and drop paths that no longer exist on `origin/<base>`.

```bash
git log --since=90.days --format= --name-only -- <src dirs> | grep -E '\.(<exts>)$' \
  | grep -v -E '<test patterns>' | sort | uniq -c | sort -rn | head -40          # churn
git log --since=90.days --format= --name-only -i -E --grep='<fix pattern>' -- <src dirs> \
  | grep -E '\.(<exts>)$' | sort | uniq -c | sort -rn | head -25                   # fix density
git log --since=90.days --format='%H' -- <file> | xargs -I{} git show --format= --name-only {} \
  | grep -v -x '<file>' | sort | uniq -c | sort -rn | head -15                      # co-change
```

For each top file: is it tested at its public interface, or only through mocks? Keep the
top ~8 **clusters** (a hot file plus its co-change partners — a concept, not a file).
Look for shallow modules (interface nearly as complex as the implementation), concepts
spread over many tiny files, the same rule/threshold/status string in several places, and
pure helpers extracted for testability while the bugs live in how they are called.

**reliability** (code). What breaks, and how anyone would find out: hot paths without
tests, flaky or skipped tests (`gh run list -L 50`: failure rate per workflow, reruns
of the same SHA), CI that doesn't run what matters, unhandled failure modes
at I/O boundaries, secrets or config hazards, deploy or release steps done by hand,
dependencies far behind. Evidence: fix commits, CI history (`gh run list` when there is a
remote), the files themselves.

**product** (code or record). What would make the repo markedly better at what it is
*for* — for an infra repo, what its operator can do. Read its stated purpose, its plans
and decisions, open issues (`gh issue list --state open`), and what the recent commits
keep circling; propose the capabilities that follow and that nobody has planned.
Be bold here — "interesting" beats "safe" — but every idea is anchored in something the
repo already does, wants or struggles with, and cited.

**record** (record). Run the repo's own health check first (`record-check.py --list`
or whatever `AGENTS.md` names) — it is the cheapest evidence. Then: **dated obligations
the record knows about that no plan tracks** (filings, renewals, deadlines — the most
valuable finding a record pass can make); the same fact restated in several files and
disagreeing; churn by directory rather than by file; gaps against the declared perimeter, facts without evidence, stale or
missing renderings, capture that is still manual and could be automated, sources that
should be linked, structure that makes the record hard for an agent to query.

## 2. Dedup — the backlog is already there

For every candidate, grep `docs/plans/` and `docs/decisions/` for its concepts (and the
out-of-repo plans in the facts table), and list open PRs (`gh pr list --state open --json number,title,files`) when there is a remote.

- Already planned → drop it. If that plan's facts are wrong, fix them in passing when the
  repo's rules allow it, in the same commit (in `--dry-run`, write the corrected copy to
  `<out>/<repo>/_fixed/`).
- An open PR that is stale or superseded → report it as `NOTE`; never close it.
- An open PR that *adds a plan* or redesign covering the candidate → treat it as already
  planned; drop it.
- The code is scheduled to leave the repo (a ready/ongoing plan moves it elsewhere) →
  drop it here, and `NOTE` it for the destination repo.
- A stale fact outside the plans (an `AGENTS.md` list, a README) → report it as `STALE`;
  this pass files plans and does not edit other docs.
- A decision record forbids the shape → drop it, or address the decision in the plan.
- An open PR touches the same files → keep it, gated `blocked:PR #<n> (<why>)`.

## 3. Explore and design — in parallel

With three candidates or fewer, or when you cannot dispatch subagents, work inline and
keep the A/B/C sketches to a paragraph each — scouts cost more than they save there. When
the repo already prescribes the shape (an existing pattern the design should follow), say
so and skip the alternatives. A mechanical refactor whose shapes barely differ gets one
line on the alternatives, not three designs. Write each scout's findings to a file in your
scratch directory as they arrive, so a pass that is cut short can resume. Above
that, if you can dispatch subagents, do each phase in **one message** for all candidates at
once, **in the foreground** (`run_in_background: false`), so their reports come back to
you. A backgrounded scout reports to whoever is at the top of the session, not to you:
end your turn while one runs and its findings are lost to this pass. If you can't
dispatch subagents, do it inline, candidate by candidate.

- **Explore** (read-only scouts, one per surviving candidate): why it is coupled or
  fragile or missing, concrete evidence (path + symbol, the fix commits), dependency
  category (table below), test impact.
- **Design.** Architecture candidates get three designers, each with one constraint:
  **A** minimal interface (1–3 entry points); **B** the most common caller trivial;
  **C** ports & adapters if the cluster crosses a runtime or network boundary, else most
  extensible. Other lenses get the chosen approach plus its strongest alternative.

**You decide** without asking: pick one design or a clearly better hybrid, one line on why
each loser lost. No design clearly better than today → drop the candidate and report it.

## 4. Select

Drop: cosmetic friction (a long file that rarely changes and never breaks — not in scoped
mode); anything that contradicts a domain invariant you cannot resolve; anything whose
honest benefit is "nicer". Rank the rest — architecture/reliability by cost saved or risk
removed (churn × modules a change must touch × fix density), product/record by how far
they move the repo's purpose. When two candidates are one change seen twice, split along
refactor vs behaviour lines and say in each plan's Design which builds first (a sequencing
note, not a gate). Keep at most `N`; prefer a mix of lenses when scores are
close.

## 5. Classify — this decides the gate and the trailer

| The plan… | Class |
|---|---|
| is freed by a clause in `## Approval` (typically: changes nothing observable; a migration that follows from an architectural benefit; consolidating copies that agree) | **pre-approved** — quote the clause |
| changes what a user sees or can do, a product rule, a permission, a contract, stored data shape beyond a following migration, running cost; or the repo has no `## Approval`; or you are unsure | **needs a yes** — `**Gate:** decision:<the single question>` |
| mixes both | split it if the pre-approved half is useful alone; otherwise the whole plan needs a yes |

A needs-yes idea always carries its `decision:` gate, even where the repo's own docs
mention `Gate` only for `ongoing/` — the standard allows it on any plan, and the builders
bucket on it. A wrong pre-approval gets built without anyone asking; a wrong `decision:` costs one
message. Product plans almost always need a yes. A plan whose Paths hit the repo's
hard-stop list (`.agents/land.config.json` `hardStop`, or the list in `AGENTS.md`) says so
in its Approval section: its PR will never self-merge. A pre-approved plan has no open
questions. Add `blocked:` gates where §2 or the repo's own rules (e.g. a visual change that
must run against the user's device) call for one.

## 6. Write the plan

`docs/plans/ideas/<slug>.md`, bare kebab-case, no date, in the language the repo's plans
bodies use, and with the block lines formatted the way its existing plans format them. The block
under the title follows agent-plans v2: `Priority` (required: `high` = hot
path or repeat fixes, `medium` = known pain, `low` = cleanup), `Gate` only if §2/§5 set
one; never `Stage`, `Status`, `Updated`, `Next`, `Landed` on an idea.

```markdown
# <Title>

**Priority:** high | medium | low — <one-line rationale from the evidence>
**Gate:** <only if set>

**Goal:** <one sentence: what changes, and what it stops costing or starts enabling>

## Context
The evidence, as of `<short sha of origin/base>` (<date>): numbers with their window; short SHA + subject of the commits that
hit it; path + symbol, never bare line numbers.

## Design
The chosen shape by responsibility, an illustrative signature or example (say it is
illustrative), how callers or users migrate.
**Alternatives considered:** one line each, and why they lost.
**Testing strategy:** (code) the tests at the new boundary, and the shallow tests they make
redundant — replace, don't layer.

## Paths
Every file it would touch, as of <date>; mark files that don't exist yet `(new)`, and a
directory is fine where the files aren't knowable yet. Builders check these against open
PRs and worktrees.

## Approval
Pre-approved — "<quoted clause>". | **Needs your yes** — the `Gate` question; recommended
answer: <answer>, because <one line>.

## Out of scope
What it deliberately does not do.
```

Approve early, plan late: record the decision and the evidence; the File Structure and
Tasks are written by whoever moves it to `ongoing/`, against that day's code.

## 7. Land

In `--dry-run`, the plans are already in `<out>/<repo>/`; skip to §8.

Otherwise: run the plan validator if there is one (none → say so in the report) (`node scripts/plans-map.js --validate;
V=$?; [ $V -eq 0 ] || exit $V` — never through a pipe). **One** commit, staged by explicit
path, never `add -A`, its subject in the repo's own format (conventional `docs(plans): …`,
or `<scope>: …` where `AGENTS.md` says so):

```
<subject in the repo's format>: enhancement pass — <n> ideas (<k> pre-approved, <m> need a yes)

<one line per plan: slug · lens · class>

Reviewed-Idea: <slug>          (only where the repo uses these trailers)
Pre-Approved: <slug>           (only for pre-approved plans, after rereading each in full)
Co-Authored-By: <the session's attribution line>
```

Trailers go in the final paragraph — git reads them from nowhere else. Push the way
`AGENTS.md` allows a docs-only change: straight to `<base>` when it allows direct
commits there (for docs, or for everything in the repo's current phase), otherwise a PR
that follows the repo's whole PR procedure — every label it asks for, and any review loop
it requires (e.g. a review bot run until it approves) — which you never merge. Never commit a generated plans map.
Remove the worktree.

## 8. Report

```
REPO <repo>   KIND <code|record|mixed>   LENSES <…>
URGENT <what> | <date> | <why it is at risk now>   (first, always: a deadline or live breakage found in passing)
FILED <slug> | <lens> | <priority> | pre-approved|needs-yes | <one line>
QUESTION <slug> | <the question> | recommended: <answer>
DROPPED <candidate> | <reason>
FIXED <plan> | <stale fact corrected>
STALE <file[:line]> | <stale fact outside the plans, not edited>
NOTE <what> | <why the user should know> (a stale PR, a plan whose premise changed, a lead from a prior run that proved wrong)
PENDING <candidate> | <what was still unchecked when the pass stopped>
LANDED <sha on base> | PR <url> | DRY-RUN <dir> | NOTHING
BLOCKED <step> | <why>        (only if something stopped you)
```

An `URGENT` finding is reported, not acted on: the pass files ideas only, and the person
(or the repo's own rules) decides whether it becomes an `ongoing/` plan today.

Talking to a person instead of a parent agent: the same content as prose — the questions
first, each answerable with a yes, then buildable-now, dropped, fixed.

## Dependency categories

| Category | Description | Deepening recipe |
|---|---|---|
| **In-process** | Pure computation, in-memory, no I/O | Merge the modules, test directly. |
| **Local-substitutable** | Has a local stand-in (emulator, in-memory DB, test container) | Deepen with the stand-in in the harness; real semantics, not mocks. |
| **Remote but owned** | Your own code across a runtime boundary (API, job, other service) | A port at the boundary; real adapter in prod, in-memory adapter in tests. |
| **True external** | Third-party APIs you don't control | Mock at the boundary; inject the port. |

Watch for an owned store treated as "external" and over-mocked when a local stand-in exists.

## Common mistakes

| Mistake | Instead |
|---|---|
| Filing N because N was the number | N is a ceiling; zero is fine |
| Ideas from intuition alone | Start from §1's evidence and cite it |
| Filing what the backlog already has | §2 first; fix the old plan's stale facts instead |
| Asking the user to pick a candidate or design | Decide; record the losers in the plan |
| `Pre-Approved` with no `## Approval` clause, or with an open question | `decision:` gate; unsure means needs a yes |
| Filing into `ready/` | `ideas/`; `ready/` records a yes |
| File-by-file tasks or final signatures | The decision and the evidence |
| Bundling a refactor with a behaviour change | Two plans |
| Writing code, opening a code PR | Plans only |
