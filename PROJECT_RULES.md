# Project Rules
## Applies to humans and every coding/review agent

These rules exist to prevent a project that "works" but is brittle, generic-looking, hard to review, or quietly violates game invariants.

# 1. Authority order

When instructions conflict:

1. accepted ADRs in `docs/adr/`;
2. `ARCHITECTURE.md`;
3. `PROJECT_RULES.md`;
4. active `TASKS.md` item / issue;
5. implementation preferences.

A builder never rewrites architecture to make implementation easier.

# 2. One task, one coherent change

Do one task at a time. Do not use a task to:
- rename unrelated code;
- reformat the repository;
- change package manager/framework;
- introduce a new state framework;
- add unrelated features;
- perform speculative cleanup.

Create follow-up tasks for unrelated cleanup.

# 3. No speculative infrastructure

Do not add Redis, queues, microservices, brokers, event sourcing, CQRS, Kubernetes, extra DBs, Three.js, DI frameworks, or similar systems unless measured evidence proves the current simpler design inadequate and an ADR approves it.

"Future proofing" is not evidence.

# 4. Server authority

Never trust client-provided dice, money, ownership, movement result, rent, auction winner, trade result, bankruptcy result, turn order, timer expiry, or progression reward.

Client submits intent; server validates/commits.

# 5. Pure game core

`packages/game-core` remains independent of React, Cloudflare, D1, WebSockets, Google auth and UI libraries.

# 6. Canonical vs presentation state

Server-derived:
- game;
- money;
- properties;
- players;
- auction;
- debt;
- turn;
- board;
- authoritative deadlines.

Local presentation:
- modal open;
- hover;
- animation progress;
- selected tab;
- sound settings;
- temporary forms.

Do not duplicate canonical game state in UI-specific stores.

# 7. Rematch rule

Every match creates a new `gameId`. Never reset/reuse ended mutable GameState.

# 8. TypeScript quality

Use strict TypeScript.

Avoid:
- `any` escape hatches;
- unchecked assertions;
- duplicate protocol definitions;
- floating-point money;
- catch-all error swallowing;
- magic strings repeated across packages.

Validate untrusted boundary data.

# 9. Time rules

Authoritative deadlines use server absolute timestamps.

Inside a Durable Object:
- no gameplay `setInterval`;
- no gameplay `setTimeout`;
- use persisted deadlines + the DO Alarm API;
- alarm logic is idempotent;
- client countdown is visual only.

# 10. Randomness

No scattered `Math.random()` in game logic.

Inject RNG. Tests use deterministic seeded RNG.

# 11. Persistence

Authoritative write commits before authoritative success is broadcast.

Use `actionId` for retry safety.

A failed commit must fail closed:
- no half trade;
- no double charge;
- no partial ownership;
- no double progression reward.

# 12. Dependencies

Before adding a dependency, document:
1. problem it solves;
2. why current platform/deps are insufficient;
3. bundle/runtime/maintenance cost;
4. maintenance status;
5. why implementing without it is worse.

Do not add dependencies for trivial helpers.

# 13. UI anti-slop

The game must not look like an AI-generated admin dashboard.

Do not ship:
- default Material/Fluent demo styling;
- board made of generic dashboard cards;
- arbitrary glow/gradient overload;
- every surface as a rounded floating card;
- inconsistent spacing/radii;
- raw hex values scattered through features;
- emoji as final product iconography when designed icons are expected;
- giant decorative headers wasting game space;
- fake stats;
- lorem ipsum;
- placeholder buttons;
- animations that contradict server state.

Use design tokens.

Generic libraries are for generic controls; board/game components are custom.

# 14. UX completeness

For a user action, consider as applicable:
- default;
- focus/hover;
- pending;
- success;
- rejection/error;
- disabled;
- reconnecting;
- mobile;
- keyboard;
- reduced motion.

Do not invent impossible states, but do not omit obvious ones.

# 15. Accessibility

Required:
- visible keyboard focus;
- primary actions keyboard reachable;
- semantic labels;
- no ownership-by-color-only;
- adequate contrast;
- reduced motion;
- usable zoom/text scaling;
- no critical hover-only information.

# 16. Test quality

A feature is not complete merely because tests exist.

Avoid:
- mock-call-only tests;
- snapshot-only rule tests;
- copying implementation logic into expected-value logic;
- happy-path-only suites;
- overmocking game-core;
- skipped tests.

Prefer behavior, invariants, seeded simulation, failure injection, duplicate-command and multi-client convergence tests.

# 17. Evidence over claims

Do not hand off with "should work", "probably fixed", or "seems fine" when evidence can be produced.

Report:
- command;
- result;
- seed;
- metric;
- screenshot/video when relevant.

If something could not be run, say why.

# 18. No fake completion

Do not mark task review-ready if acceptance requires code that still contains necessary:
- TODO;
- FIXME;
- `test.skip`;
- disabled behavior;
- commented-out final implementation;
- test-only production shortcuts.

# 19. Error handling

Expected errors should be typed/actionable, e.g.:

```text
NOT_YOUR_TURN
STALE_GAME_VERSION
ACTION_ALREADY_APPLIED
PROPERTY_ALREADY_OWNED
INSUFFICIENT_FUNDS
ROOM_NOT_FOUND
ROOM_FULL
SESSION_REPLACED
ROOM_TEMPORARILY_UNAVAILABLE
```

Unexpected errors should log enough room/game/version/action context to reproduce without leaking secrets.

# 20. Logging/privacy

Never log Google tokens, session cookies, OAuth codes, auth headers, secrets or unnecessary personal data.

# 21. Performance

Measure before optimizing, but avoid obvious pathologies:
- full-state broadcast for tiny UI-only changes;
- needless DB scans;
- per-frame React state churn;
- chat rerendering whole board;
- animation state mixed into authoritative state.

# 22. Documentation

Do not change requirements merely so buggy code becomes "correct".

If implementation proves the spec wrong, stop and request architecture/task amendment.

# 23. Review ownership

Builder can mark `READY_FOR_REVIEW`, never `DONE`.

Reviewer decides:
- APPROVE;
- CHANGES_REQUESTED;
- ARCHITECTURE_BLOCKED.

A human override should record the reason.
