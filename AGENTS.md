# AGENTS.md — agent-skills

The autonomous delivery contract (`skills/ship-a-feature/SKILL.md`) and the landing state
machine behind it (`scripts/pr-land.js`, with its decision table in `scripts/decide.js`).
`README.md` explains the wiring and every `.agents/land.config.json` field.

## Edits propagate to consumers

Other projects consume this repo as a git submodule at `.agents/_shared/`, symlinking
`skills/ship-a-feature` and `scripts/pr-land.js` into place; some vendor a copy of
`pr-land.js` and `decide.js` instead. A change here reaches every consumer on its next
submodule bump, so treat each one as a change to all of them.

## Rules

- **Procedure only.** Every project fact (Direct paths, hard-stop list, base branch,
  whether an approving review is required) belongs in the consuming repo's `AGENTS.md`
  and `.agents/land.config.json`, which win where they differ. If an edit here would only
  make one repo happy, put that value in that repo's config instead.
- Defaults fail closed: an absent config means an empty hard-stop list and
  `requireApprovingReview: true`. Keep it that way.
- The scripts use Node built-ins only; there is no `package.json`.
- `managing-plans-lifecycle` moved to agent-plans. Don't re-add it here.

## Layout

- `skills/ship-a-feature/SKILL.md`: the only skill.
- `scripts/pr-land.js`, `scripts/decide.js`: the landing loop (run as `pnpm pr:land` in consumers).
- `scripts/__tests__/*.test.mjs`: tests.
- `.claude-plugin/plugin.json`: plugin manifest, though this repo is no longer a plugin
  marketplace and its description still mentions the plans lifecycle.

## Tests

    node --test scripts/__tests__/*.test.mjs

## Plans

None here: the workspace exempts this repo from the plans rule, and its work is planned
in the projects that consume it.
