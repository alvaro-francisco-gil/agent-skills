# agent-skills

Shared, repo-agnostic [agent skills](https://code.claude.com/docs/en/skills) consumed by
multiple projects as a git submodule, so a single copy is the source of truth.

## Skills

- **managing-plans-lifecycle** — the `docs/plans/{ideas,ready,ongoing}/` → `docs/decisions/`
  lifecycle convention, priority labels, and how it composes with the `superpowers` skills.
  Per-repo policy (which plans live where) is deferred to each repo's `AGENTS.md`.

## How consuming repos wire it in

The submodule lives **outside** the skill-scan directory (so it doesn't show up as a bogus
skill), and each shared skill is symlinked into `.agents/skills/` at depth 1:

```
.agents/_shared/                            # this repo, as a submodule
   managing-plans-lifecycle/SKILL.md
.agents/skills/managing-plans-lifecycle  →  ../_shared/managing-plans-lifecycle   # symlink
.claude/skills                           →  ../.agents/skills                      # symlink
```

### Add to a new repo

```sh
git submodule add https://github.com/alvaro-francisco-gil/agent-skills.git .agents/_shared
ln -s ../_shared/managing-plans-lifecycle .agents/skills/managing-plans-lifecycle
git add .gitmodules .agents/_shared .agents/skills/managing-plans-lifecycle
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
