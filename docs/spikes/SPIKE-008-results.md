# Spike Result - SPIKE-008 (economy harness)

**Date:** 2026-09-04
**Builder:** Codex
**Branch / baseline:** `main` @ `e8e44c6fd83b93e30da416722626ddd075f12964`
**Status:** MODIFY - READY_FOR_REVIEW

## Decision

**MODIFY.** The extracted Claude Design candidate values were tested unchanged.
Standard 3-4 and Grand 6-7 pass the SPIKE evaluation bands. Standard 5-6 and
Grand 8-10 fail the match-pacing band; Grand 8-10 also exceed the 20% stalled
game ceiling. There is no immediate-insolvency failure in the baseline.

No candidate economy number was changed. A bounded +10%/+20% development-rent
sensitivity reduces stalls but does not make Standard 6 or Grand 8-10 pass.
Aggressive and cautious purchase-reserve policies do not remove the same
high-count pacing failure. Promoting either tested rent uplift would therefore
be an unsupported partial fix.

Grand B (Turbo) and C (Transit) were not simulated. The canonical sources name
them but do not define their movement, eligibility, timing, or numeric effects.
Inventing those mechanics would make the comparison meaningless. Grand A is the
only valid candidate in this run, and it does not pass at 8-10 players.

## Candidate economy source and governance reconciliation

The private, gitignored reference files were read directly:

- `docs/WORK-REPORT.md`
- `docs/Gameplay Shell.dc.html`
- `docs/Card Decks.dc.html`
- the remaining `docs/*.dc.html`, `docs/index.html`, and `docs/screens/`

The approved gameplay design supplies city names, set order, property prices,
derived deed formulas, $200 transits, $150 utilities, the two 16-card decks, and
the visual board construction. It is reference input only; the simulator does
not read or ship a private Design artifact at runtime.

Two parts of that source conflict with ADR-004 / `ARCHITECTURE.md` and were not
treated as authoritative:

1. The design generator creates 24 Standard properties and 36 Grand properties,
   all in triples. Architecture fixes Standard at 22 properties / 8 sets and
   Grand at 30 properties / 12 sets, with Grand specifically six pairs plus six
   triples.
2. The design lobby defaults to $1,500 and offers $1,000/$1,500/$2,500. The
   canonical default is $2,000 and canonical presets are
   $1,500/$2,000/$2,500.

The simulation-only reconciliation preserves exact authored price points:

- Standard keeps the middle six triples; Egypt and France use their low/high
  candidate cities as pairs. This yields 22 properties.
- Grand uses the first six tiers as low/high pairs and the final six as authored
  triples. This yields the fixed six-pair/six-triple structure and 30 properties.
- This selection and the explicit tile order below are **SPIKE assumptions**,
  not the future production board source. CORE-001 / GRAND-001 must obtain a
  human-approved authored ordering before freeze.

### Standard candidate inventory

| Set | Cities and purchase prices |
|---|---|
| Egypt | Cairo $60; Giza $90 |
| Morocco | Casablanca $100; Marrakesh $110; Rabat $130 |
| South Africa | Cape Town $140; Johannesburg $150; Durban $170 |
| India | Mumbai $180; Delhi $190; Jaipur $210 |
| Japan | Tokyo $220; Osaka $230; Kyoto $250 |
| Australia | Sydney $260; Melbourne $270; Perth $290 |
| Italy | Rome $300; Milan $320; Venice $340 |
| France | Paris $350; Lyon $400 |

Numbered simulation layout:

```text
0 START
1 Cairo, 2 Giza, 3 Surprise, 4 Power Grid, 5 Heathrow,
6 Casablanca, 7 Marrakesh, 8 Rabat, 9 Treasure
10 HOLDING
11 Cape Town, 12 Johannesburg, 13 Durban, 14 Customs, 15 Gare du Nord,
16 Mumbai, 17 Delhi, 18 Jaipur, 19 Surprise
20 VACATION
21 Tokyo, 22 Osaka, 23 Kyoto, 24 Treasure, 25 Changi,
26 Sydney, 27 Melbourne, 28 Perth, 29 Water Works
30 GO TO HOLDING
31 Rome, 32 Milan, 33 Venice, 34 Surprise, 35 Grand Central,
36 Paris, 37 Lyon, 38 Treasure, 39 Customs
```

### Grand candidate inventory

| Set | Cities and purchase prices |
|---|---|
| Egypt | Cairo $60; Giza $90 |
| Morocco | Casablanca $100; Rabat $130 |
| South Africa | Cape Town $140; Durban $170 |
| India | Mumbai $180; Jaipur $210 |
| Japan | Tokyo $220; Kyoto $250 |
| Australia | Sydney $260; Perth $290 |
| Italy | Rome $300; Milan $310; Venice $330 |
| France | Paris $340; Nice $350; Lyon $370 |
| Spain | Madrid $380; Barcelona $390; Seville $410 |
| Brazil | Rio de Janeiro $420; Sao Paulo $430; Brasilia $450 |
| Mexico | Mexico City $460; Cancun $470; Guadalajara $490 |
| Canada | Toronto $500; Vancouver $520; Montreal $550 |

Numbered simulation layout:

```text
0 START
1 Cairo, 2 Giza, 3 Surprise, 4 Casablanca, 5 Rabat, 6 Heathrow,
7 Power Grid, 8 Treasure, 9 Cape Town, 10 Durban, 11 Auction Hub, 12 Customs
13 HOLDING
14 Mumbai, 15 Jaipur, 16 Surprise, 17 Tokyo, 18 Kyoto, 19 Gare du Nord,
20 Water Works, 21 Treasure, 22 Sydney, 23 Perth, 24 Gift/Choice, 25 Transit Pass
26 VACATION
27 Rome, 28 Milan, 29 Venice, 30 Surprise, 31 Third Utility, 32 Changi,
33 Paris, 34 Nice, 35 Lyon, 36 Madrid, 37 Barcelona, 38 Seville
39 GO TO HOLDING
40 Rio de Janeiro, 41 Sao Paulo, 42 Brasilia, 43 Treasure, 44 Customs,
45 Grand Central, 46 Mexico City, 47 Cancun, 48 Guadalajara,
49 Toronto, 50 Vancouver, 51 Montreal
```

### Authored formulas and immutable rules

For property purchase price `P`, the design authors:

- base rent = nearest even value to `P / 10`, minimum $2;
- complete-set unimproved rent = `2 x base` (also immutable);
- development rents = rounded-to-$10
  `[0.5P, 1.5P, 3.6P, 5.2P]`;
- building cost = rounded-to-$10 `0.6P`.

Canonical rules override conflicting design display math:

- reference salary `S = $200`;
- default starting cash `$2,000 = 10S`;
- mortgage value `0.5P`;
- unmortgage = principal + 10%; half-dollar results round up once to preserve
  integer money;
- building sell-back = 50% of building cost. The design's 30%-of-purchase display
  is not used.

### Values absent from the design

The smallest labeled assumptions needed to run the spike are:

- Customs tax: fixed $100 (`0.5S`);
- transit rent for 1-4 owned $200 hubs: $20/$40/$60/$80 (linear
  10%-of-price steps);
- utility ordinary rent: 4x/10x dice for the two authored utilities; Grand's
  architecture-required third utility is named `Third Utility`, costs the
  authored $150, and adds a 15x step;
- Auction Hub, Gift/Choice, and Transit Pass are neutral structural tiles because
  their mechanics are not defined;
- the ambiguous Visa denied and Reroute cards are neutral; all unambiguous
  fixed, per-property, per-building, per-developed-property, per-player, Start,
  nearest-ownable, back-three, Holding, and rent-holiday effects are modeled.

These assumptions are not production rules and must be resolved before the
corresponding CORE/RULE/GRAND tasks.

## Simulation architecture

The permanent, pure TypeScript harness lives under
`packages/game-core/src/spike-008/`. It has no React, DOM, Worker, storage, or
private-design dependency.

Each game uses an injected Mulberry32 stream. The seed is:

```text
configurationSeed(board, players, caseIndex, 0x5eed0008)
```

The board, player count, case index, seed base, and policy therefore reproduce a
game and its summary exactly. The fixed regression suite runs Grand-10 from seed
base `0x00800001` twice and requires identical summaries.

Baseline policy is deliberately simple and explainable:

- buy an unowned ownable when at least $200 remains;
- otherwise auction at 75% of list price to the liquid player with the most
  cash, with deterministic seat-order tie breaking;
- once per round, allow one 125%-of-list trade only when it closes a set and
  neither side violates the cash reserve;
- make one even-build development action per owner turn when $300 remains;
- sell developments evenly and mortgage assets only to settle a charge;
- clear one affordable mortgage per turn;
- collect automatic rent; transfer remaining assets to a creditor on
  bankruptcy or return them to the bank for a bank debt;
- roll again on doubles, capped at three rolls because the future repeated-
  doubles detention rule is not authored.

Movement, salary, purchase/auction, property/transit/utility rent, complete-set
doubling, development, tax, cards, liquidity, mortgage, bankruptcy, and
elimination are all applied in the same deterministic loop. Metrics include
turns/rounds, laps, Start income, acquisition milestones, saturation, first
set/build/bankruptcy, auction/list ratio, rent concentration, mortgages,
liquidation, tax/card bank flow, cash/net-worth distribution at rounds
5/10/20/40, stalled games, early leader conversion, and winner correlations.

## SPIKE evaluation criteria

`TASKS.md` names metrics but supplies no pass bands. These conservative bands
are SPIKE criteria, not immutable production rules:

| Signal | Pass band |
|---|---|
| Median duration floor | at least 8 rounds |
| Median duration ceiling | Standard-3 <=70 rounds; Standard 4-6 <=60; Grand 6-7 <=65; Grand 8-10 <=55 |
| Stalled games | <=20%; stalled means more than 90 Standard or 80 Grand rounds |
| Bankruptcy in first five normalized rounds | <=15% |
| Final property ownership saturation | median >=72% |
| At least one complete set | >=75% of games |
| Rent / Start income | median 0.15-5.0 |
| Round-10 net-worth leader becomes winner | <=75% |

The per-board/per-player duration ceilings avoid treating a Standard 3-player
round (three turns) as equivalent to a Grand 10-player round (ten turns). They
also reject hundreds of nominally short turns as healthy merely because a
turn-count average hides waiting time.

## Baseline - exact candidate values

**250 seeds per configuration; 2,250 baseline games.** Values are
median unless labeled P90 or rate.

### Pacing and solvency

| Config | Turns med / P90 | Rounds med | Stalled | Early bankrupt | Bankruptcies med | Decision |
|---|---:|---:|---:|---:|---:|---|
| Standard 3 | 150.5 / 219 | 55.0 | 7.2% | 0% | 2 | PASS |
| Standard 4 | 194 / 265 | 58.0 | 9.6% | 0% | 3 | PASS |
| Standard 5 | 234.5 / 321 | 62.4 | 12.4% | 0% | 4 | FAIL: median rounds |
| Standard 6 | 276 / 349 | 66.0 | 15.6% | 0% | 5 | FAIL: median rounds |
| Grand 6 | 244 / 313 | 58.2 | 16.4% | 0% | 5 | PASS |
| Grand 7 | 270 / 342 | 58.6 | 18.8% | 0% | 6 | PASS |
| Grand 8 | 303.5 / 375 | 62.3 | 25.2% | 0% | 7 | FAIL: median rounds + stalls |
| Grand 9 | 333 / 402 | 66.2 | 24.0% | 0% | 8 | FAIL: median rounds + stalls |
| Grand 10 | 368 / 434 | 69.2 | 28.0% | 0% | 9 | FAIL: median rounds + stalls |

This is not an acquisition problem: median final ownership saturation is 100%
for every configuration. Nor is it an immediate-solvency problem: no baseline
game bankrupts a player in the first five normalized rounds. The failure is the
tail after assets have concentrated.

### Acquisition and rent pressure

| Config | 75% acquired turn | First set | First build | First bankruptcy | Rent / Start income | Top rent share | Mortgages / liquidity |
|---|---:|---:|---:|---:|---:|---:|---:|
| Standard 3 | 45.5 | 24 | 27 | 120 | 1.47 | 0.76 | 17 / 34 |
| Standard 4 | 44 | 28 | 32.5 | 130 | 1.89 | 0.71 | 19 / 39 |
| Standard 5 | 45.5 | 34.5 | 36 | 144 | 2.21 | 0.70 | 20 / 41 |
| Standard 6 | 45 | 36 | 38 | 152 | 2.60 | 0.68 | 20 / 43 |
| Grand 6 | 62 | 12 | 13 | 132 | 2.77 | 0.65 | 31 / 58.5 |
| Grand 7 | 64 | 10.5 | 15 | 140 | 3.30 | 0.61 | 33 / 65 |
| Grand 8 | 63.5 | 8 | 12 | 152.5 | 3.61 | 0.59 | 34 / 71 |
| Grand 9 | 63 | 9 | 12 | 159 | 4.02 | 0.56 | 35 / 75 |
| Grand 10 | 64 | 10 | 13 | 171 | 4.39 | 0.56 | 35 / 75 |

Grand forms sets very early because the required first six sets are pairs in the
simulation reconciliation. That result must not be generalized to a future
board order until the pair assignment is human approved.

### Cash, concentration, auctions, and winner signals

| Config | Cash R10 / R20 | Net-worth Gini R20 | Auction/list | R10 leader wins | R10 net-worth/winner corr. |
|---|---:|---:|---:|---:|---:|
| Standard 3 | $1,116 / $511 | 0.07 | 9.8% | 43% | 0.20 |
| Standard 4 | $1,270 / $864 | 0.10 | 4.2% | 36% | 0.18 |
| Standard 5 | $1,405 / $1,233 | 0.13 | 2.2% | 30% | 0.18 |
| Standard 6 | $1,498 / $1,381 | 0.19 | 1.5% | 31% | 0.20 |
| Grand 6 | $722 / $406 | 0.28 | 15.2% | 49% | 0.39 |
| Grand 7 | $828 / $474 | 0.37 | 11.4% | 43% | 0.39 |
| Grand 8 | $934 / $538 | 0.40 | 8.5% | 44% | 0.40 |
| Grand 9 | $1,036 / $628 | 0.44 | 7.5% | 47% | 0.43 |
| Grand 10 | $1,138 / $745 | 0.49 | 5.8% | 50% | 0.44 |

Early leaders are not deterministic winners: round-10 leader conversion is
30-50%, below the 75% runaway ceiling. Wealth concentration grows faster on
Grand as player count rises, but the larger problem is still time-to-last-player.

### Bank flow and movement

| Config | Laps/player | Start income/player | Tax paid/player | Card bank net/player | Unmortgages | Auction sale rate |
|---|---:|---:|---:|---:|---:|---:|
| Standard 3 | 9.00 | $1,866.7 | $266.7 | +$246.7 | 8 | 97.5% |
| Standard 4 | 8.75 | $1,800.0 | $250.0 | +$260.0 | 12 | 100% |
| Standard 5 | 8.40 | $1,740.0 | $265.6 | +$225.5 | 14 | 100% |
| Standard 6 | 8.17 | $1,666.7 | $233.3 | +$220.4 | 14 | 100% |
| Grand 6 | 5.67 | $1,166.7 | $166.7 | +$180.0 | 20 | 99.5% |
| Grand 7 | 5.29 | $1,085.7 | $157.1 | +$177.1 | 22 | 99.9% |
| Grand 8 | 5.25 | $1,075.0 | $155.2 | +$163.4 | 24 | 100% |
| Grand 9 | 5.11 | $1,055.6 | $155.6 | +$159.4 | 25 | 100% |
| Grand 10 | 5.10 | $1,050.0 | $150.0 | +$168.0 | 26 | 100% |

The card deck is a modest net cash injector, while Customs drains a comparable
amount. Salary remains the larger bank inflow. Auctions are uncommon under the
baseline $200 reserve but almost always sell when opened.

## Bounded sensitivity

Only baseline failures were tested. Each sensitivity cell uses 100 deterministic
seeds per configuration.

### Development-rent scale

The single formula variable was scaled; property prices, base rent, set
doubling, building cost, salary, cards, and taxes stayed unchanged.

| Scale | Config | Median rounds | Stalled | Result |
|---:|---|---:|---:|---|
| 1.10x | Standard 5 | 57.7 | 6% | PASS |
| 1.10x | Standard 6 | 64.7 | 9% | FAIL: duration |
| 1.10x | Grand 8 | 57.4 | 15% | FAIL: duration |
| 1.10x | Grand 9 | 59.3 | 13% | FAIL: duration |
| 1.10x | Grand 10 | 66.4 | 19% | FAIL: duration |
| 1.20x | Standard 5 | 55.2 | 10% | PASS |
| 1.20x | Standard 6 | 60.3 | 7% | FAIL: duration |
| 1.20x | Grand 8 | 55.3 | 9% | FAIL: duration |
| 1.20x | Grand 9 | 59.4 | 14% | FAIL: duration |
| 1.20x | Grand 10 | 67.2 | 19% | FAIL: duration |

Original design multipliers are `[0.5P, 1.5P, 3.6P, 5.2P]`. The tested
20% proposal would become `[0.6P, 1.8P, 4.32P, 6.24P]` before the existing
$10 rounding. It improves Standard 5 and stall rates but does not fix the full
matrix, and it slightly worsens Grand-10 median rounds in this bounded sample.
**Rejected; candidate values remain unchanged.**

### Purchase/development liquidity policy

| Policy | Reserve (buy/dev) | Standard 5 | Standard 6 | Grand 8 | Grand 9 | Grand 10 |
|---|---:|---|---|---|---|---|
| Aggressive | $100 / $200 | PASS, 59.3r | FAIL, 70.3r | FAIL, 60.6r | FAIL, 67.6r | FAIL, 69.5r |
| Cautious | $400 / $500 | FAIL, 65.8r | FAIL, 67.8r | FAIL, 63.1r | FAIL, 67.9r | FAIL, 71.0r |

The aggressive policy clears Standard 5 only; the cautious policy is uniformly
slower. High-count failure is therefore not explained by the baseline reserve
alone.

## Negative proof

A 100-game Standard-4 control multiplies all rent by 25 while leaving every
other input unchanged. It finishes in a median 18.4 rounds with median
rent/Start income 6.69, and the evaluator returns **FAIL** on the non-tautological
5.0 rent-pressure ceiling. The same evaluator passes healthy baseline
configurations, proving it can distinguish both directions rather than merely
requiring completion.

## Runtime and reproducibility

Final CLI run:

```text
pnpm simulate:economy -- --games=250
baseline:      9 x 250 = 2,250 games
rent tests:    5 x 2 x 100 = 1,000 games
policy tests:  5 x 2 x 100 = 1,000 games
negative:      100 games
total:         4,350 games
runtime:       12.897 s
```

An additional metric-extraction replay of the same matrix completed in 13.641 s
and reproduced the same summaries. Runtime is wall-clock evidence only and is
not part of deterministic state.

## Tests and adversarial audit

The suite asserts:

- coherent 0-based board numbering and exact 40/52 tile counts;
- exact 22/30 property and 8/12 set counts;
- Grand's six pairs plus six triples;
- every property referenced exactly once and every reference valid;
- monotonic, positive, integer rent ladders;
- canonical set doubling, mortgage, unmortgage, and sell-back formulas;
- Standard/Grand object isolation and distinct top prices;
- identical game replay by seed/configuration;
- identical fixed-seed Grand-10 summaries;
- all nine player-count configurations execute;
- the absurd-rent control fails.

Verification from repository root:

```text
pnpm lint                                           PASS
pnpm typecheck                                      PASS
pnpm test                                           PASS (153 tests)
pnpm build                                          PASS
git diff --check                                    PASS
pnpm exec vitest run packages/game-core/src/
  spike-008/economy.test.ts                         PASS (9 tests, 291 ms body)
```

The full suite includes SPIKE-007's nine seeded fuzz tests; no regression was
observed. Lint initially found one unused type-only import; it was removed and
the complete lint command passed on rerun.

Adversarial review also checked the two count reconciliations, early Grand pair
completion, integer interest rounding, high-count cash, mortgage restoration,
rent concentration, stalls, seed-only randomness, private file inclusion,
Standard/Grand separation, and the fact that A/B/C cannot be compared without
defined B/C mechanics.

## Limitations and remaining risks

- The board ordering and which candidate cities become pair sets are explicit
  reconciliation assumptions. They can materially affect landing exposure.
- Transit fares, ordinary utility scaling, third-utility values, and Customs are
  labeled assumptions because the design does not author them.
- Trading is a bounded set-closing heuristic, not negotiation or optimal play.
  Auctions use a deterministic liquidity policy rather than strategic bidding.
- Holding skips one turn; bailouts, teams, timed wins, finite buildings, and
  post-launch modules are out of scope.
- Two ambiguous movement cards are neutral. The other cash-impact and
  unambiguous movement effects are modeled.
- A simulation round is not a measured human turn duration. Human alpha remains
  required by the architecture before an economy can be frozen.
- The fixture is simulation-only. It must not silently become the production
  authored board without resolving the structural and missing-value decisions.

## Required next decision

Do not change the approved candidate numbers based on this spike alone. Before
FREEZE-001, a product owner should approve:

1. the exact 22/30-property set membership and tile numbering;
2. transit/utility/tax values and the third Grand utility;
3. defined Turbo and Transit candidate mechanics if B/C comparison remains a
   freeze requirement;
4. whether high-count pacing should be addressed by a bounded economy change,
   a defined Grand pacing module, or revised human-tested duration criteria.

SPIKE-008 is ready for independent review with a **MODIFY** decision. It is not
marked DONE, and FREEZE-001 has not started.

## Independent review (2026-09-04, Claude Code)

**Verdict: APPROVE.** A MODIFY simulation outcome with trustworthy, reproducible
evidence satisfies the spike; SPIKE-008 → DONE. Verified independently:

- **Design extraction is faithful.** The gitignored `docs/Gameplay Shell.dc.html`
  price ladders (`PRICES_40`/`PRICES_52`) were read directly and compared cell by
  cell to `economy-data.ts`: every retained price is an exact design value. The
  22/30 reconciliation drops the **middle** city of each demoted triple and keeps
  low+high (Standard: Egypt drops Alexandria 70, France drops Nice 380; Grand:
  first six sets drop their middle city). No price invented or rescaled. The main
  side-effect (early Grand set formation from pair sets) is quantified and flagged
  non-generalizable. Governance conflicts are explicit and canonical wins:
  starting cash $2,000 (not design $1,500), building sell-back 50%-of-cost (not
  design 30%-of-purchase), Grand third utility, and labeled transit/utility/tax
  assumptions the design does not author.
- **Simulator is deterministic and honest.** Seeded Mulberry32, no `Math.random`,
  no private-design/runtime import, not re-exported from `game-core/index.ts`. No
  mechanic is invented to force convergence; the one accelerant (set-closing
  trade) only shortens games, which makes the "too slow at high counts"
  conclusion *more* conservative.
- **Thresholds are defensible and the conclusion survives them.** Ceilings are in
  rounds (normalized by player count) and tightened as counts rise. Grand 8–10
  fail the **uniform** 20% stall criterion (25.2/24.0/28.0%) independently of the
  rounds ceiling, so MODIFY does not hinge on threshold tuning.
- **Reproduced the full matrix** via `pnpm simulate:economy -- --games=250`:
  baseline decisions, median rounds, stall rates, and the negative proof
  (rent/Start 6.69 → FAIL on the 5.0 ceiling) match this document exactly.
- **Checks:** lint PASS, typecheck PASS, test PASS (153 incl. SPIKE-007's 9 fuzz
  tests — no regression), build PASS, `git diff --check` clean. No dependency
  added (only a `simulate:economy` script); `allowImportingTsExtensions` is
  required for the `node --experimental-strip-types` `.ts` imports and is safe
  (game-core emits nothing).

FREEZE-001 remains TODO and was not started.

## Architecture impact

No production architecture or canonical board JSON changed. The spike adds a
simulation-only dataset/harness and records evidence that ADR-004's economy and
Grand-pacing gates are not yet ready to freeze at the high player counts.
