# START HERE

This pack converts the v0.4 product/spec work into an executable software-engineering workflow.

## Reading order

### Builder / Claude Code
1. `CLAUDE.md`
2. `AGENTS.md`
3. `ARCHITECTURE.md`
4. `PROJECT_RULES.md`
5. `TASKS.md`
6. relevant ADR

### Reviewer / Codex / human
1. `AGENTS.md`
2. active task in `TASKS.md`
3. relevant ADR + `ARCHITECTURE.md`
4. actual diff
5. `REVIEW_CHECKLIST.md`

## First task

Start at:

```text
GOV-001
```

Then complete the architecture spikes in order before broad game implementation.

## Important workflow rule

Claude Code builds.

Independent Codex/human review closes tasks.

Builder never marks its own task DONE.

## Architecture falsification

The main runtime belief is now testable:

- <=10% of a daily free-tier resource for the representative 10-player Grand game: desired;
- 10–20%: optimize and rerun;
- >20%: architecture/runtime assumption fails.

Do not debate around a failed measurement.

## Source spec

The user's v0.4 architecture/spec remains the product source baseline. `ARCHITECTURE.md` is the hardened implementation-facing freeze candidate and records the agreed corrections needed before coding.
