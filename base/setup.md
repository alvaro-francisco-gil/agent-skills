`AGENTS.md` is the shared instruction entry point. Project skills live in
`.agents/skills/`; `.claude/skills` points to that directory. See
[`.agents/README.md`](.agents/README.md) for discovery requirements and dependencies.

Text between `<!-- base:… -->` markers in this file is a copy of a section of
[agent-skills `base/`](https://github.com/ghostaff-ai/agent-skills/tree/main/base).
Change it there, never here: the next sync overwrites a local edit.
