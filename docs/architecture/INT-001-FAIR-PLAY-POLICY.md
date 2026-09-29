# INT-001 — FFA fair-play (Collusion Guard) policy v1

**Date:** 2026-09-29
**Status:** Frozen policy for INT-002 / RT-017 / UI-016 / QA-013. Decided under the product owner's standing instruction to adopt the recommended option for each open question.
**Scope:** Free-for-all matches only. In TEAMS matches nothing in this document is evaluated, and teammate cooperation is always legitimate.

The Collusion Guard protects FFA matches from two players teaming up. It is deterministic and explainable. It reads only authoritative gameplay facts the server already produces, and it never infers motive.

## 1. Evidence inputs

Only these neutral facts, already persisted in canonical `GameState`, are evaluated:

- accepted trade facts (`ruleState.tradeFacts` with type `ACCEPTED`): both parties, both bundles, and the liquidation marker;
- elimination facts (`ruleState.eliminations`), including the debt resolution they ended;
- the canonical board economy, used to value assets.

Nothing else is used.

## 2. Valuation

- Cash counts at face value.
- An unmortgaged asset counts at its canonical purchase price.
- A mortgaged asset counts at its mortgage value, which is what it is worth to the receiver before redemption.
- A side's value is its cash plus the value of its assets.

Development cannot be traded (RULE-014), so it never needs a value.

## 3. Lopsided trade

An accepted trade is **lopsided** when the larger side's value exceeds the smaller side's value by at least **$300** *and* the smaller side is worth at most **25%** of the larger side. The player who gave the larger side is the **giver**; the other is the **receiver**.

Examples at the thresholds:

- A $350 property for $50 is lopsided: $300 net, and $50 is 14% of $350.
- $400 cash for a $200 property is not: $200 net, below the $300 floor.
- $500 cash for a $150 property is not: $150 is 30% of $500, above 25%.

## 4. Incidents

Incidents are counted per unordered **pair** of players.

1. **Pattern.** A single lopsided trade is only recorded; the policy never acts on one act of generosity. Every further lopsided trade between the same pair, in either direction, is a `PATTERN` incident.
2. **Dump.** When a player goes bankrupt, every lopsided liquidation trade they made as giver under that same debt (`liquidationFor` equals the eliminated resolution) is a `DUMP` incident with that trade's receiver. This is the "empty your holdings, then declare" case, and it applies even to a single trade.

Each triggering trade creates at most one incident, and incidents are recorded exactly once, inside the transition that creates them.

## 5. Consequences

- **First incident for a pair: `WARNING`.** Both players are told privately that they have been warned for teaming up. Play continues unchanged.
- **Any later incident for the same pair: `REMOVAL`.** Every still-active member of the pair is removed from the match in the same transition.
  - Removal is an elimination with reason `REMOVED`, and it settles like a bankruptcy to the bank: cash goes to the bank, and assets return unowned, unmortgaged, and undeveloped (freeze §10).
  - If the removed player owned the turn, the next eligible seat starts a new turn.
  - If one player remains, the match ends normally (LAST_STANDING).
- A `DUMP` incident whose giver is already eliminated still counts toward the pair, so it warns (or removes) the receiver.

### Visibility

- A warning is visible only to the two players in the pair.
- A removal is public, as a room notice naming both players ("X and Y were removed for teaming up").
- The evidence (trade ids, values, and the rule that fired) is shown to the affected players, so every decision explains itself.

## 6. Resolved Design ambiguities

- **Rent waived vs refunded:** not applicable. Rent is never waived, and allies in TEAMS still pay rent.
- **Rescue / bailout:** v1 has no rescue mechanic. A cash gift to a debtor is an ordinary liquidation trade, and it is evaluated like any other trade.
- **Turn windows:** replaced by the explicit debt link (`liquidationFor`). No counting of turns.
- **Clawback:** no clawback in v1. Reversing trades after assets have been mortgaged, developed, or re-traded cannot be made exact. Removal is the enforcement instead.
- **Public naming:** only for removals (see Visibility above).
- **Bailout toggle:** there is no toggle. The guard is always on in FFA and always off in TEAMS.
- **Reports:** no player reports in v1. There is no human review path to route them to.

## 7. Explicitly not detected

- auction behaviour (passing, bidding low);
- rent, chat, or timing;
- anything about devices, IPs, accounts, or other matches;
- any machine-learned or hidden score.

Legitimate competitive trades are not flagged, however lopsided they are, until a second lopsided trade happens within the same pair.

## 8. Change control

The thresholds ($300 net, 25% return) are launch values. Changing them, adding a signal, or adding clawback or reports needs a new policy revision and QA-013 false-positive evidence.
