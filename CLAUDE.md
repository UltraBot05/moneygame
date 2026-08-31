# CLAUDE.md

Claude Code is the default **BUILDER** for this repository.

Before coding read:
1. `AGENTS.md`
2. `ARCHITECTURE.md`
3. `PROJECT_RULES.md`
4. active task in `TASKS.md`
5. relevant ADR(s)

Rules:
- implement one task at a time;
- do not redesign architecture without an architecture-blocked handoff;
- do not add speculative infrastructure;
- never move authoritative game state to the client;
- do not mark your own task DONE;
- finish with the Builder Handoff format in `AGENTS.md`.

If evidence falsifies an architecture assumption, stop and report it instead of coding around it.
