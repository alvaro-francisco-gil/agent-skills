# agent-skills

Shared, repo-agnostic [agent skills](https://code.claude.com/docs/en/skills) consumed by
multiple projects as a git submodule, so a single copy is the source of truth.

## What's here

**Skills**

- **managing-plans-lifecycle** — the `docs/plans/{ideas,ready,ongoing[,/soak]}/` →
  `docs/{decisions,incidents,ops}/` lifecycle, and how it composes with `superpowers`.
- **ship-a-feature** — the autonomous delivery contract: front-load every question into ONE
  message, take `go` as "all your picks", then implement and land unattended. Supersedes
  `superpowers:brainstorming`'s one-question-per-message rule and
  `finishing-a-development-branch`'s stop-and-ask merge menu in adopting repos.

**Scripts**

- **scripts/pr-land.js** — the landing state machine behind `pnpm pr:land`. Shared verbatim;
  every repo-specific value is data in that repo's `.agents/land.config.json`.

## The layering rule

These files define *procedure*. Every project fact — which paths are Direct, what the
hard-stop list is, the base branch, whether an approving review is required — lives in the
consuming repo's `AGENTS.md` and `.agents/land.config.json`, **which win wherever they
differ.** If you are about to edit a file here to make one repo happy, that value belongs in
that repo's config instead.

## How consuming repos wire it in

The submodule lives **outside** the skill-scan directory (so it doesn't show up as a bogus
skill), and each shared skill is symlinked into `.agents/skills/` at depth 1:

```
.agents/_shared/                            # this repo, as a submodule
   skills/managing-plans-lifecycle/SKILL.md
   skills/ship-a-feature/SKILL.md
   scripts/pr-land.js
.agents/skills/managing-plans-lifecycle  →  ../_shared/skills/managing-plans-lifecycle
.agents/skills/ship-a-feature            →  ../_shared/skills/ship-a-feature
.claude/skills                           →  ../.agents/skills
scripts/pr-land.js                       →  ../.agents/_shared/scripts/pr-land.js
```

The `skills/` directory is required by the Claude Code plugin layout (see
**Two channels** below); submodule consumers just point one level deeper.

### Add to a new repo

```sh
git submodule add https://github.com/alvaro-francisco-gil/agent-skills.git .agents/_shared
ln -s ../_shared/skills/managing-plans-lifecycle .agents/skills/managing-plans-lifecycle
ln -s ../_shared/skills/ship-a-feature           .agents/skills/ship-a-feature
ln -s ../.agents/_shared/scripts/pr-land.js scripts/pr-land.js
git add .gitmodules .agents/_shared .agents/skills scripts/pr-land.js
```

Then add `"pr:land": "node scripts/pr-land.js"` to `package.json`, and write
`.agents/land.config.json` (see below).

### `.agents/land.config.json`

Required in every consuming repo. Defaults **fail closed** — an absent config means an empty
hard-stop list *and* `requireApprovingReview: true`, so an unconfigured repo stalls at the
review gate rather than silently auto-merging something it never declared.

```json
{
  "baseBranch": "develop",
  "reviewLabel": "ai-review",
  "requireApprovingReview": true,
  "ciPaths": ["src/", "functions/", "package.json", "pnpm-lock.yaml"],
  "sharedBlastRadius": ["packages/shared/", "pnpm-lock.yaml"],
  "hardStop": [
    { "pattern": "^firestore\\.rules$", "why": "security rules" },
    { "pattern": "^scripts/backfills/", "why": "data backfill" }
  ]
}
```

- `ciPaths` **must mirror the repo's CI path filter.** If they drift, the vacuous-green guard
  either blocks needlessly or — worse — reads "no run dispatched" as "tests passed".
- `hardStop[].pattern` is a regex *source string*, not `/slashes/`; add `"flags": "i"` if needed.
- `requireApprovingReview: false` is a **weaker** bar, not an equivalent one. Set it only where
  no automated reviewer exists, and expect `ship-a-feature` to say so out loud.

### Verify the wiring

```sh
node --test .agents/_shared/scripts/__tests__/pr-land.test.mjs   # shared predicates
pnpm pr:land --dry-run                                          # from a feature branch
```

### Clone / CI

Submodule contents are not fetched by a plain `git clone`. Use:

```sh
git clone --recurse-submodules <repo>
# or, in an existing checkout:
git submodule update --init
```

### Update to the latest shared version

```sh
git submodule update --remote .agents/_shared
git add .agents/_shared && git commit -m "chore: bump agent-skills"
```

## Two channels — pick one per repo, never both

This repo is both a **git submodule** and a **Claude Code plugin marketplace**. They deliver
the same skills by different routes, and a repo that uses both loads every skill twice.

| | Submodule (primary) | Marketplace plugin |
|---|---|---|
| Wiring | `git submodule add` + symlinks | `/plugin marketplace add alvaro-francisco-gil/agent-skills` |
| Version | **pinned** per repo, visible in `git log` as a gitlink SHA | whatever is installed |
| Sees `scripts/pr-land.js` | yes, as a repo file `pnpm pr:land` can run | no |
| Visible to CI | yes, with `submodules: true` on checkout | no |
| Visible to Codex | yes — it reads `.agents/skills/` | no |
| Cloud / mobile sessions | yes, the files are in the repo | only via `enabledPlugins` in `.claude/settings.json` |

**Use the submodule** for any repo with an `AGENTS.md`, a CI pipeline, or Codex wiring — that
is where pinning, `pr:land`, and cross-tool visibility matter.

**Use the plugin** for small repos that have none of that and just want the intake protocol:

```jsonc
// .claude/settings.json — makes the skills reach cloud and mobile sessions too
{
  "extraKnownMarketplaces": {
    "alvaro-agent-skills": {
      "source": { "source": "github", "repo": "alvaro-francisco-gil/agent-skills" }
    }
  },
  "enabledPlugins": ["agent-workflow@alvaro-agent-skills"]
}
```

Note that a project-declared plugin from an external source still needs one
`claude plugin install` per machine before it loads.
