# AGENTS.md
## Canonical instructions for builders and reviewers

Before changing code read:
1. `ARCHITECTURE.md`
2. `PROJECT_RULES.md`
3. active task in `TASKS.md`
4. relevant `docs/adr/*.md`

`CLAUDE.md` points Claude Code here. Codex reviewers should treat this as repository-level policy.

# 1. Roles

## BUILDER

Default: Claude Code / Anthropic model unless assigned otherwise.

Builder:
- implements one task;
- makes the smallest coherent change;
- adds/updates tests;
- produces evidence;
- hands off for independent review;
- never self-approves.

## REVIEWER

May be a human, Codex Sol, Codex Terra, or ChatGPT web reviewer with the actual changed files/diff.

Reviewer:
- verifies rather than summarizes;
- tries to falsify behavior;
- checks scope/slop;
- requests bounded fixes;
- avoids rewriting an entire feature when a small patch is sufficient.

# 2. Builder procedure

## A. Establish scope

Read task ID and acceptance criteria. Inspect the smallest relevant set of files. Do not start with repository-wide cleanup.

## B. Identify affected invariants

Examples:
- money;
- ownership;
- turn ownership;
- gameVersion;
- idempotency;
- reconnect;
- board immutability;
- rematch;
- timer durability.

## C. Implement directly

Prefer readable direct code over framework layers. Follow dependency rules.

## D. Test

Run narrow tests first, then relevant repository checks.

Expected root scripts once bootstrapped:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When applicable:

```text
pnpm test:integration
pnpm test:e2e
```

Use actual package scripts; never invent passing commands.

## E. Self-review

Check diff for:
- unrelated edits;
- `any`;
- hidden fallbacks;
- TODO/FIXME;
- skipped tests;
- accidental client authority;
- stale state;
- secret logging;
- generic placeholder UI.

## F. Handoff

Mark task `READY_FOR_REVIEW`, not DONE.

Use:

```markdown
## Builder Handoff — TASK-ID

### What changed
- ...

### Why this implementation
- ...

### Files changed
- ...

### Invariants affected
- ...

### Tests run
- `command` -> PASS/FAIL

### Manual checks
- ...

### Evidence
- metrics / seed / screenshots / logs

### Known limitations
- none
or
- ...

### Architecture impact
- None.
or
- BLOCKED: proposed ADR change ...
```

# 3. Reviewer procedure

1. Read task and acceptance criteria.
2. Verify scope and unrelated edits.
3. Inspect actual behavior, not builder prose.
4. Check duplicate/stale/disconnect/restart paths for stateful work.
5. Verify tests would catch plausible defects.
6. Check anti-slop rules.
7. Return a structured verdict.

Reviewer format:

```markdown
## Review — TASK-ID

### Verdict
APPROVE | CHANGES_REQUESTED | ARCHITECTURE_BLOCKED

### Blocking findings
1. [B1] ...

### Non-blocking findings
1. [N1] ...

### Evidence checked
- ...

### Tests I ran / inspected
- ...

### Architecture/invariant check
- ...

### Required patch
- exact bounded changes

### Follow-ups
- only scope that is genuinely separate
```

# 4. Severity

## BLOCKER
Can cause state corruption, cheating/client authority, duplicate economic effects, lost commit, auth/session vulnerability, reconnect failure, architecture violation, or failure of acceptance criteria.

## MAJOR
Feature basically works but has meaningful edge-case, UX, test, resource or maintainability failure.

## MINOR
Small quality/clarity issue with no correctness impact.

Do not elevate personal preference to blocker.

# 5. Builder anti-slop checklist

Before handoff:
- [ ] only requested task implemented
- [ ] simplest correct design used
- [ ] no unnecessary dependency
- [ ] authoritative state remains server-side
- [ ] new state represented once
- [ ] retry/reconnect considered where relevant
- [ ] persistence failure considered where relevant
- [ ] rematch considered where relevant
- [ ] tests are behavior-based
- [ ] tests actually run
- [ ] no placeholder final UI
- [ ] UI is game-specific, not library-default
- [ ] no comments merely narrating obvious code
- [ ] dead/debug code removed

Any unexplained unchecked item belongs in handoff.

# 6. Reviewer anti-slop checklist

Look for:

### AI coding slop
- unnecessary Manager/Factory/Provider/Service layers;
- five files for a trivial rule;
- giant comments restating code;
- invented APIs;
- silent catch-and-continue;
- arbitrary retries/timeouts;
- hardcoded behavior that belongs in board/rules data;
- broad refactor hiding a small feature.

### Game-state slop
- client-authoritative values;
- mutation in render code;
- stale ownership/set indices;
- rematch object reuse;
- missing action idempotency;
- nondeterministic tests.

### UI slop
- default design-library look;
- card-on-card-on-card layout;
- glow/blur everywhere;
- no pending/error state;
- generic admin-table gameplay;
- inaccessible ownership colors.

### Test slop
- only snapshots;
- only happy path;
- mocking the system under test;
- skipped tests;
- implementation-detail assertions instead of outcomes.

# 7. Stop conditions

Builder stops and marks BLOCKED if:
- task conflicts with architecture;
- provider behavior differs from ADR;
- a task requires paid infrastructure unexpectedly;
- runtime board resize becomes necessary;
- client trust becomes necessary;
- a spike crosses its hard falsifier;
- immutable board/rules state would need mutation to make implementation work.

Do not improvise around these.

# 8. Reviewer independence

Assume builder explanation may be wrong. Review code and evidence.

Never approve solely because:
- Claude says tests passed;
- diff looks clean;
- screenshot looks good;
- behavior worked once.
