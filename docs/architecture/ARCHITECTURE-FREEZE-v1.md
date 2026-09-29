# MONEY·GAME architecture and product freeze v1

**Date:** 2026-09-13
**Task:** FREEZE-001
**Status:** Frozen implementation baseline (independently reviewed, approved, and merged — FREEZE-001 DONE)

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

- ~~final Surprise and Treasure content (RULE-011/012)~~ — v1 decks decided in section 10; values stay open for balance tuning;
- ~~full Holding choices, attempts, and held release cards (RULE-013)~~ — decided in section 9, pending RULE-013 review;
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

### Auction rule policy

- The first valid bid is at least $2. Every later bid is at least the current high bid plus $2. There is no reserve.
- Every non-bankrupt player is initially eligible, including the player who declined the purchase. Team-specific restrictions remain deferred to RULE-018.
- Auction turns rotate deterministically in seat order, beginning with the next eligible seat after the declining player and wrapping around. A pass is permanent for that auction.
- Bids are cash-only, may not exceed current canonical cash, and never create debt.
- With at least one valid bid, the auction settles when only the high bidder remains unpassed. Payment and canonical ownership transfer are atomic.
- Without a valid bid, the final unpassed player still receives an explicit turn to bid at least $2 or pass. A final pass closes the auction with the asset still unowned.
- Each current auction actor has a persisted absolute decision deadline. Disconnect does not itself withdraw a player; expiry deterministically auto-passes the current actor. Reconnect restores an unpassed participant but never reverses a pass or auto-pass.
- The pure game core validates and applies deadline expiry. The runtime owns alarm scheduling and supplies authoritative time and the next absolute deadline; it must not use gameplay timers.
- Persisted auction state and emitted facts remain neutral audit evidence only. Collusion classification and team semantics are outside RULE-005.

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

## 9. Amendment — D2 product decisions (2026-09-29)

Decided by the product owner during Section D Pass D2 (RULE-009, 010, 013, 014, 015). They follow the section 8 process and become accepted once those tasks pass independent review. Final card content (RULE-011/012) stays deferred.

### Holding (RULE-013)

- **Entry:** landing on GO TO HOLDING, a card effect, or a third consecutive double. The third double does not move the player. The player goes to the Holding tile with no Start salary, and any doubles continuation ends. Landing on the Holding tile by movement is only visiting.
- **Holding turn, before rolling:** the player may pay the $50 release fee or use a held release card. Either way they then roll and move normally.
- **Holding turn, rolling instead:** the roll is a release attempt.
  - Doubles release the player, who moves by that roll with no extra roll.
  - A failed attempt keeps the player held.
  - After the third failed attempt the player must pay $50 and then moves by that roll. If they can't cover the fee it becomes a bank obligation, and settling it releases them and moves them by the stored roll.
- **While held:** the player still collects rent and may trade, mortgage, and sell development. They may not develop.
- **Release cards:** a used release card is consumed once and returns to its own deck's discard pile.

### Card effects (RULE-010)

- Movement, draws, and Holding entry must be the last step of any effect sequence (validated at catalog load).
- Card movement resolves its destination exactly like a dice landing: buy decision or auction, rent (utility rent uses the turn's roll), tax, GO TO HOLDING, or an in-chain draw on a card tile. That draw shares the same 16-step budget.
- Only the current player may be charged by an effect, because obligations have a single debtor. Other players may only receive bank cash.

### Trade and debt (RULE-014, RULE-015)

- Trades exchange cash and ownable assets only; held cards are not tradable.
- **Blocked trades:**
  - any trade during an auction;
  - assets in a set with development;
  - the asset that is the source of the pending resolution.
- **Mortgaged assets** transfer still mortgaged, with no transfer fee.
- **Acceptance** always revalidates against current state.
- **Debt:** the CORE-011 obligation is the only debt truth. The runtime supplies an absolute deadline for every new obligation.
- **Liquidation while in debt:**
  - The debtor may only mortgage, sell development (even-sell, canonical 50% sell-back), or make liquidation trades created during that debt.
  - Open trades from before the debt that involve the debtor cannot be accepted while it is outstanding.
  - The obligation is paid automatically as soon as the debtor's cash covers it, and play resumes where it was interrupted (including a suspended card effect).
- **Deadline expiry** forces bankruptcy (section 10).

These rules change cash flow compared with the ECON-001 bot's Holding approximation. The economy matrix must be rerun before final balance approval (GRAND-003/QA-015).

## 10. Amendment — D3 and card-deck product decisions (2026-09-29)

Decided by the product owner for RULE-011, 012, 016, 017, 018, and 019, following the section 8 process.

### Card decks (RULE-011/012)

- Canonical v1 decks are data, not code: `boards/world-tour/standard.cards.json` and `grand.cards.json`, loaded and validated by `packages/game-core/src/catalog.ts` together with their player-facing copy.
- Each deck has 16 cards, and both boards carry the same cards. Only the Paris, Rome, and Heathrow destinations use board-specific tile indices.
- Every deck holds exactly one Holding-release card. A held card runs no effect, and every deck keeps at least one card that cannot be held.
- New effect primitives:
  - move to the nearest transit hub or utility, with standard, double, or ten-times-a-fresh-roll rent;
  - pay each other player, charged one creditor at a time in seat order;
  - a landmark rate for repairs;
  - a per-city payout.
- Card values are launch placeholders. The economy matrix must be rerun on the production rule path before final balance approval (QA-011/QA-015, GRAND-004).

### Bankruptcy (RULE-016/017)

- The debtor may declare bankruptcy at any time while in debt. Expiry of the persisted deadline forces it.
- **Owed to a player:** the creditor receives all the debtor's cash and every asset. Developments are first sold back at 50%, with the proceeds going to the creditor. Mortgaged assets stay mortgaged, with no fee.
- **Owed to the bank:** every asset returns unowned, unmortgaged, and undeveloped. There are no auctions.
- **In every case:**
  - held cards return to their decks' discard piles;
  - the debtor's open trades are voided;
  - a suspended card effect is dropped;
  - a neutral elimination fact records the creditor, the amount, the cash moved, and the assets moved.
- Bankrupt players own nothing, hold nothing, and have no cash.
- If the game continues, the next eligible seat starts a new turn.

### Teams (RULE-018)

- TEAMS matches have a fixed partition of every player into two or more teams, set before start and locked afterwards. FFA matches have no teams.
- Economics are identical to FFA: teammates pay each other rent, keep separate cash, and trade normally. Legitimate teammate cooperation is never treated as FFA collusion (INT-001/002).

### Win conditions (RULE-019)

- v1 ships LAST_STANDING only. The match ends inside the eliminating transition as soon as one player (FFA) or one team (TEAMS) remains.
- The immutable outcome lists:
  - the winners (every member of the winning team);
  - the winning team;
  - placements, with survivors in seat order and then eliminations newest first.
- Every later command is refused. Round and time limits and any tie-break are deferred.

## 11. Owner decisions after the freeze (2026-09-29)

- **Resign.** Any active player may leave a running match with `RESIGN`. With an outstanding debt it is
  exactly a declared bankruptcy (the creditor is paid); otherwise the player's cash and deeds return to
  the bank like a Collusion Guard removal, recorded as elimination reason `RESIGNED`. It is refused while
  an auction is live, and the match ends normally if one player or team remains. Reason: tables finish
  by players dropping out when they are done, because the rules have no length limit.
- **No length limit, by choice.** A table that never trades can play indefinitely; the owner accepts
  this (players resign when bored). A timed game mode is a possible later module (backlog POST-009).
