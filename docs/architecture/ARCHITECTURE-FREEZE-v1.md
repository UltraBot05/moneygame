# MONEY·GAME architecture and product freeze v1

**Date:** 2026-09-13
**Task:** FREEZE-001
**Status:** Frozen implementation baseline; independent task review pending

This document is the concise implementation baseline. It summarizes, but does not replace, `ARCHITECTURE.md`, accepted ADR-001 through ADR-004, canonical board data, or the ECON-001 reconciliation evidence. Historical spike reports remain evidence of the state tested at the time and are not rewritten by this freeze.

## 1. Decision classes

### Frozen

Future implementation must obey these decisions unless the change process in section 8 is completed:

- product scope, launch player ranges, board identities and board geometry;
- authoritative server/runtime, persistence, authentication, reconnect, rematch, deadline, and idempotency invariants;
- canonical money formulas, starting-cash rules, and the two-development-purchase turn rule;
- Grand core mode, with Turbo and Transit disabled;
- canonical and private-design source policies below.

### Provisional approved launch candidates

The Design-authored property prices, rents, and build costs plus the reconciled transit, utility, tax, Start, and Holding values are frozen as implementation inputs. They remain provisional as final launch balance until human alpha. New evidence may change them only through section 8.

The default $2,000 economy is the primary validated launch target. The $1,500 and $2,500 presets and integer custom values from $1,500 through $2,500 are supported candidates; not every intermediate custom value has been simulated.

### Deferred

The following are not frozen by implication:

- final Surprise and Treasure content (RULE-011/012);
- full Holding choices, attempts, and held release cards (RULE-013);
- human validation of two-development-per-turn snowball dynamics;
- Grand human playtesting and human comparison of optional pacing ideas;
- Collusion Guard backend detection, bailout, or enforcement rules;
- production Turbo or Transit modules and any other optional Grand pacing mechanic;
- production mechanics still assigned to future CORE, RULE, RT, UI, GRAND, META, or QA tasks.

### Non-blocking known risks

- Grand-10 at the $2,500 preset measured 55.5 median rounds against the 55-round band, 12.4% stalls, and rent/Start 5.166 against 5.0.
- Two development purchases are the dominant pacing lever. Simulation improved all nine default configurations, but human players may expose snowball or decision-quality effects.
- Grand has not had human alpha, and its six-pair/six-triple ordering affects landing and early-set exposure.
- Final cards and full Holding behavior can change cash flow and require the economy matrix to be rerun.

These risks do not block the implementation baseline. They may block launch or require a deliberate amendment when the relevant task produces evidence.

## 2. Product and board baseline

A normal match starts with 3–10 authenticated players. Standard is recommended for 3–6; Grand is recommended for 6–10. A running match may naturally continue below three players. Board size never changes during a match; there is no runtime size slider.

### Standard

- identity: `world-tour-standard@1`;
- 40 tiles, 22 properties, 8 sets;
- 4 transit, 2 utilities, 3 Surprise, 3 Treasure, 2 tax, 4 structural corners;
- set sizes: two pairs and six triples.

### Grand

- identity: `world-tour-grand@1`;
- 52 tiles, 30 properties, 12 sets, with three sets per side;
- set sizes: six pairs followed by six triples;
- 4 transit, 2 utilities, 4 Surprise, 3 Treasure, 2 tax;
- 3 neutral reserved Grand-special spaces and 4 structural corners.

Grand tile 31 is Surprise, not a third utility. Its reserved Auction Hub, Gift/Choice, and Transit Pass spaces have no core cash or movement effect. Grand corner positions are structural; final Grand-specific corner semantics remain deferred.

Property-to-set membership, exact tile ordering, and exact city retention are the tables in `boards/world-tour/standard.json` and `boards/world-tour/grand.json`. The mapping retains the Design-authored endpoints described in `PRE-FREEZE-ECONOMY-RECONCILIATION.md`; it must not be regenerated from old 24/36-property design placeholders.

## 3. Economy and development baseline

The board JSON `economyProfile` objects are the canonical per-board value source. `packages/game-core/src/economy.ts` is the canonical shared-rule source, and `packages/game-core/src/economy-candidates.ts` provides immutable typed loading for the current harness. The historical SPIKE-008 fixture is evidence, not a production source of truth.

Frozen shared values:

- reference salary `S = 200`;
- default starting cash $2,000;
- presets $1,500 / $2,000 / $2,500;
- custom starting cash is a safe integer from $1,500 through $2,500 inclusive;
- complete-set unimproved rent is 2× base rent;
- mortgage principal is 50% of purchase price;
- unmortgage cost is `ceil(principal × 110 / 100)` using integer arithmetic;
- development sell-back is 50% of its purchase cost;
- passing Start pays $200; exact landing pays $300 total;
- Holding release costs $50; Vacation and neutral Grand specials transfer no cash.

Development is limited to at most two paid purchases per eligible owner turn across all sets:

1. each purchase buys one level and is independently validated;
2. payment and even-build legality are checked for each purchase against the state produced by the prior purchase;
3. the landmark/highest development is level 4 and consumes one action;
4. unused actions do not carry over;
5. development is forbidden while the owner is in Holding;
6. development is forbidden while debt rules block the owner.

## 4. Authoritative runtime baseline

- The pure TypeScript game core computes transitions; it imports no UI, Cloudflare, auth, storage, or WebSocket APIs.
- Clients submit intents only. Authenticated server context supplies actor identity, time, rules, and injected RNG.
- One Cloudflare SQLite-backed Durable Object owns each room. SQLite is durable truth; resident memory is only a cache.
- Use the Hibernation WebSocket API. Gameplay `setTimeout`, `setInterval`, keep-warm loops, and non-hibernatable socket handling are forbidden.
- Authoritative state, idempotency metadata, and deadlines commit in one SQLite transaction before success is broadcast. A failed write fails closed; retrying a committed action returns its recorded result.
- Persist absolute deadlines, schedule the earliest pending deadline in the single DO alarm, resolve every due deadline idempotently, persist, then reschedule.
- Finalized profile/game records go to D1; D1 does not own live room state.

## 5. Identity, reconnect, and game isolation

- Google OIDC `sub` maps to internal `userId`. The first-party session is Secure, HttpOnly, and appropriately SameSite; Google tokens are not game credentials or JS-readable storage.
- Invite-first OAuth uses opaque, high-entropy, one-time, expiring state mapped server-side to the return path and browser/session binding. OAuth state is never the room code.
- A seat binds to internal `userId`, not IP, socket, tab, or payload identity.
- The reconnect lease is 90 seconds. A reconnect at 89 seconds and at the exact 90-second boundary is accepted; more than 90 seconds fails closed. Application login lifetime is separate.
- Every accepted new connection/takeover increments the persisted connection epoch. Old-epoch commands are rejected and the replaced socket receives `SESSION_REPLACED`.
- A genuine reconnect by the active turn owner may extend that turn by at most 20 seconds once. It never stacks and resets for a distinct turn.
- Every rematch creates a new `gameId` and fresh `GameState`; ended mutable state is never reset or reused. Board identity/version/tile count are recorded with the match.
- Every client-originated game mutation carries `gameId`; missing or stale game identity fails closed before writes. Game-scoped persistence and deadlines are keyed by `gameId`.
- The idempotency key is `(gameId, actionId)`. The same action ID deduplicates inside one game and may be reused independently in a new game. `gameVersion` is monotonic within a game.

## 6. Grand pacing decision

Grand uses A: the same core movement and two-development-purchase rule as Standard. Turbo (B) and Transit connection (C) exist only as isolated simulation concepts. Neither is enabled in canonical board data or shared production rules, and the neutral Transit Pass space does not enable C.

## 7. Design source policy

Canonical implementation data and rules win over visual prototypes:

1. accepted ADRs and this freeze amendment;
2. `ARCHITECTURE.md` and `PROJECT_RULES.md`;
3. canonical board JSON and shared economy source;
4. private Claude Design files as UX/provenance references only.

The private files `docs/WORK-REPORT.md`, `docs/index.html`, `docs/*.dc.html`, and `docs/screens/` are intentionally ignored. They may be inspected but must not be staged, committed, renamed, deleted, or modified. Their old 24/36-property counts, $1,500 default, one-development-action copy, mortgage/sell-back display math, card values, and Collusion Guard screens are not canonical production rules.

Historical spike reports remain unchanged historical evidence. Current canonical documents supersede prior candidate assumptions without rewriting history.

## 8. Post-freeze change and exit rule

FREEZE does not mean no decision can ever change. A future change to a frozen invariant requires all of:

1. an explicit scoped task;
2. a written rationale identifying the affected invariant and risk;
3. proportionate deterministic tests, simulation, provider measurement, or human evidence;
4. an ADR or this freeze document amended when the decision is load-bearing;
5. independent review before acceptance.

Builders stop and mark the task blocked if implementation would silently violate this baseline. Deferred work exits its own task only when its acceptance criteria and required reruns are satisfied; it does not become frozen merely because implementation has started.
