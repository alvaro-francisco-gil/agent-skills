# base: the guidelines every repo shares

Each file here is one section of agent guidance that several repos' `AGENTS.md` carry
word for word. A repo opts into a section by putting a marker pair in its `AGENTS.md`,
under a heading of its own:

    ## Be proactive

    <!-- base:proactive -->
    <!-- /base:proactive -->

The owner's sync script copies `proactive.md` between the markers and reports any repo
whose copy has drifted. The copy is committed, so a clone of the repo alone carries the
full text.

- **Edit the section here, never between the markers.** The next sync overwrites a local
  edit.
- **Procedure only**, like the rest of this repo. A rule that names one repo's paths,
  commands or people stays in that repo's `AGENTS.md`, outside the markers.
- **Only what is already repeated.** A section earns a file here once two repos carry the
  same text. A rule only one repo needs is not base.
- **Prose is the weakest enforcement.** Nothing fails when an agent skips a sentence. A
  rule that a script, a lint or a permission can enforce belongs there, and its sentence
  here goes away.

| Section | For | What it says |
|---|---|---|
| `health` | every repo | each change leaves the repo cheaper to change next time |
| `dont` | every repo | no hook bypass, no half-finished states |
| `dont-code` | repos with code | no restating comments, no dead code |
| `proactive` | repos with code | propose improvements, and when |
| `autonomy` | repos that adopt `ship-a-feature` | the user decides once, the agent lands |
| `superpowers` | repos that adopt `ship-a-feature` | which superpowers flows it replaces |
| `setup` | every repo | where instructions and skills live |
