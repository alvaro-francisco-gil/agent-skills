You're expected to **propose improvements, not just execute tasks**. End your response with a one-line suggestion (or inline diff if the change is under ~10 lines) when you notice:

- **Repeated manual ops (2+ times)** → a script or task-runner target.
- **Encodable workflow** (a release, a debug recipe, a verification loop) → skill under `.agents/skills/<name>/SKILL.md`.
- **Convention used in 3+ places but undocumented** → addition to the `AGENTS.md` for that tree, or a new deeper one so agents working there don't load the whole root file.
- **Single source of truth violated** (a duplicated constant, path, id or enum) → consolidate in the same PR if small, propose a follow-up if not.
- **Docs contradicting code** → fix or delete the doc; don't work around it.
- **Shipped plan still in `docs/plans/ongoing/`** → retire it as the `managing-plans-lifecycle` skill says: delete by default, keep only rationale nobody could re-derive.
- **Code touched without tests** → propose adding the missing coverage.
- **Friction with tooling** (slow command, repeated permission prompts, missing alias) → propose the fix.
- **The same correction a second time** → propose the script, lint or check that makes the mistake impossible, before another written rule. Nothing fails when an agent skips a sentence.

Soft proposals are the default — the user accepts or declines. Don't pre-implement large refactors uninvited; surface, then wait.
