# Pre-FREEZE economy reconciliation — ECON-001

**Date:** 2026-09-08
**Status:** READY_FOR_REVIEW — proposed, not frozen
**Builder:** Codex; **independent reviewer:** Claude
**Baseline:** main at e8e44c6fd83b93e30da416722626ddd075f12964, with existing uncommitted SPIKE-008 work preserved.

## Decision

Propose Standard 40/22/8 and Grand 52/30/12 with the existing low/high-city reconciliation, two utilities on each board, and two paid even-build purchases per owner turn. Preserve all authored property prices, rent ladders and build costs. Select Grand A (core). All nine default-$2000 configurations pass the unchanged SPIKE-008 bands at 250 deterministic seeds/configuration. No blanket rent increase or forced end-of-game cutoff was used to repair pacing.

This is ready for independent freeze-readiness review after Claude reviews ECON-001. It is not approval of FREEZE-001 or a claim of completed human balance validation. The $2500 Grand-10 preset has two small band misses, documented below. Card content and full Holding behavior remain separate implementation/playtest work. FREEZE-001 stays TODO.

## Source reconciliation

Read ARCHITECTURE.md, PROJECT_RULES.md, TASKS.md, ADR-004, the SPIKE-008 results and all four harness files; searched TASKS, ADRs, Markdown and private Design sources for Turbo/Transit definitions. No executable candidate rules were found. START_HERE.md identifies the v0.4 spec as the source baseline, but no separate v0.4 spec file is present: the implementation-facing canonical specification is ARCHITECTURE.md plus ADRs.

Private references inspected: docs/WORK-REPORT.md, docs/index.html, all nine docs/*.dc.html files, the docs/screens inventory and Grand gameplay screenshot. They remain private, unmodified and untracked. Gameplay Shell supplies the cities, tiered prices, rent/build formulas, $200 hubs, $150 utilities, $300 Start landing and $50 Holding release. WORK-REPORT explicitly records exactly two utilities and replacing freed utility spaces with cards. The live Gameplay Shell text says one development action; increasing that to two is an explicit candidate product change, not an asserted prior approval.

Canonical fixed counts and money rules override the Design generator’s 24/36 properties, its $1500 default and $1000 preset, adjustable Start salary, and rounded mortgage/sell-back displays. Card Decks explicitly calls every value a balancing placeholder; its effects stay in validation infrastructure and are not copied into production board data. The private ignored IMPLEMENTATION_PLAN still contains its historical three-utility plan; the proposed ADR amendment and ARCHITECTURE.md supersede that old plan.

## Production sources and mapping

Authoritative candidate values are the economyProfile objects in boards/world-tour/standard.json and grand.json. Their existing immutable board refs and metadata remain intact. packages/game-core/src/economy-candidates.ts loads and recursively freezes these tables; economy.ts defines shared candidate money/pacing rules. The historical SPIKE fixture remains independent for replay. CORE-001 still owns the complete untrusted-board validator; this pass adds typed loading and behavioral invariant tests for authored tables.

Keep the middle-city-drop mapping. It preserves every country tier, each tier’s price endpoints, country ordering, contiguous city runs, mid-side hubs and three sets per Grand side. Dropping an endpoint instead would discard an authored tier anchor. Alternating pairs/triples would require rearranging three high-tier triples around the mid-side hubs. Neither offers an evidenced benefit worth changing this mapping.

| Board | Set (in board order) | Cities / purchase prices |
|---|---|---|
| standard | Egypt | Cairo $60; Giza $90 |
| standard | Morocco | Casablanca $100; Marrakesh $110; Rabat $130 |
| standard | South Africa | Cape Town $140; Johannesburg $150; Durban $170 |
| standard | India | Mumbai $180; Delhi $190; Jaipur $210 |
| standard | Japan | Tokyo $220; Osaka $230; Kyoto $250 |
| standard | Australia | Sydney $260; Melbourne $270; Perth $290 |
| standard | Italy | Rome $300; Milan $320; Venice $340 |
| standard | France | Paris $350; Lyon $400 |
| grand | Egypt | Cairo $60; Giza $90 |
| grand | Morocco | Casablanca $100; Rabat $130 |
| grand | South Africa | Cape Town $140; Durban $170 |
| grand | India | Mumbai $180; Jaipur $210 |
| grand | Japan | Tokyo $220; Kyoto $250 |
| grand | Australia | Sydney $260; Perth $290 |
| grand | Italy | Rome $300; Milan $310; Venice $330 |
| grand | France | Paris $340; Nice $350; Lyon $370 |
| grand | Spain | Madrid $380; Barcelona $390; Seville $410 |
| grand | Brazil | Rio de Janeiro $420; Sao Paulo $430; Brasilia $450 |
| grand | Mexico | Mexico City $460; Cancun $470; Guadalajara $490 |
| grand | Canada | Toronto $500; Vancouver $520; Montreal $550 |

Standard omits Alexandria and Nice. Grand omits Alexandria, Marrakesh, Johannesburg, Delhi, Osaka and Melbourne. Standard retains six middle triples and Egypt/France pairs; Grand retains six low-tier pairs and six high-tier triples.

### Exact tile ordering

**standard**

0: START; 1: Cairo; 2: Giza; 3: surprise; 4: Power Grid; 5: Heathrow; 6: Casablanca; 7: Marrakesh; 8: Rabat; 9: treasure.
10: HOLDING; 11: Cape Town; 12: Johannesburg; 13: Durban; 14: Customs; 15: Gare du Nord; 16: Mumbai; 17: Delhi; 18: Jaipur; 19: surprise.
20: VACATION; 21: Tokyo; 22: Osaka; 23: Kyoto; 24: treasure; 25: Changi; 26: Sydney; 27: Melbourne; 28: Perth; 29: Water Works.
30: GO TO HOLDING; 31: Rome; 32: Milan; 33: Venice; 34: surprise; 35: Grand Central; 36: Paris; 37: Lyon; 38: treasure; 39: Customs.

**grand**

0: START; 1: Cairo; 2: Giza; 3: surprise; 4: Casablanca; 5: Rabat; 6: Heathrow; 7: Power Grid; 8: treasure; 9: Cape Town; 10: Durban; 11: Auction Hub; 12: Customs.
13: HOLDING; 14: Mumbai; 15: Jaipur; 16: surprise; 17: Tokyo; 18: Kyoto; 19: Gare du Nord; 20: Water Works; 21: treasure; 22: Sydney; 23: Perth; 24: Gift/Choice; 25: Transit Pass.
26: VACATION; 27: Rome; 28: Milan; 29: Venice; 30: surprise; 31: surprise; 32: Changi; 33: Paris; 34: Nice; 35: Lyon; 36: Madrid; 37: Barcelona; 38: Seville.
39: GO TO HOLDING; 40: Rio de Janeiro; 41: Sao Paulo; 42: Brasilia; 43: treasure; 44: Customs; 45: Grand Central; 46: Mexico City; 47: Cancun; 48: Guadalajara; 49: Toronto; 50: Vancouver; 51: Montreal.

### Utility count and board arithmetic

Standard: 22 properties + 4 hubs + 2 utilities + 3 Surprise + 3 Treasure + 2 taxes + 4 corners = 40. Grand: 30 properties + 4 hubs + 2 utilities + 4 Surprise + 3 Treasure + 2 taxes + 3 reserved specials + 4 corners = 52. Grand index 31 becomes Surprise instead of the unnamed Third Utility; the 15× third-utility rent tier disappears. This adopts the later two-utility Design intent without increasing properties or resizing either board.

## Exact economy rules

- Property price P: base rent = max(2, round(P/20) × 2). Complete-set unimproved rent = 2× base. Development levels 1/2/3/landmark = round-to-$10 of 0.5P / 1.5P / 3.6P / 5.2P; half-way cases round upward. Each paid level costs round-to-$10(0.6P). All evaluated numbers are explicit in the JSON tables.
- Mortgage principal = P/2. Redemption = ceil(principal × 110 / 100), rounded upward once. Building sell-back = build cost/2. Do not compute redemption via floating-point principal × 1.1: e.g. $100 must redeem for $110, not $111; a $50 principal redeems for $55, not $56.
- Transit: all four cost $200; fares $20/$40/$60/$80 for 1/2/3/4 unmortgaged hubs owned; mortgage $100, redemption $110. Utility: both cost $150; ordinary rents 4×/10× authoritative dice for 1/2 unmortgaged utilities; mortgage $75, redemption $83. These ordinary scaling tables were absent from Design: retain the explicit SPIKE candidate tables, rather than invent a new retune.
- Customs: $100 fixed on each of two tax spaces. This was absent from Design; adopt the existing 0.5S candidate assumption for both boards.
- S=200; starting cash default $2000; presets $1500/$2000/$2500. Custom is an integer $1500–$2500 inclusive. The new narrow bound stays within the tested preset envelope; every intermediate amount has not been separately simulated.
- Start passing salary $200. Exact landing totals $300 ($200 salary plus $100 bonus, not $500). The existing advance-to-Start card awards its single $300 total. A move to Holding pays no Start salary.
- Holding release $50. The validation bot uses a documented approximation: skip one turn, pay $50 on that skipped turn, move normally on the next. Full three-attempt/doubles/held-release-card choices belong to RULE-013 and require balance reruns.
- Vacation: $0. Grand A’s Auction Hub, Gift/Choice and Transit Pass are explicitly neutral reserved spaces: no cash, no forced auction, gift or stored pass in core. Their names do not implicitly enable modules. Any later activation changes rules and needs new simulation/UI review.
- Two development actions per owner turn, across all sets, no carryover. Each action buys one level on a complete, unmortgaged set; validate money and even-build separately after each purchase. A landmark is the fourth level, not a fifth level. No actions while in Holding or debt. The candidate bot also postpones mortgage restoration after being sent to Holding. The bot retains the $300 development reserve and deterministic set/position priority.

## Bounded adjustments and attribution

| Adjustment | Original → candidate | Reason and trade-off | Evidence |
|---|---|---|---|
| Development budget | 1 → 2 levels/owner turn | Removes the development bottleneck without rent inflation. Faster access to high tiers increases tactical risk and early development advantage. | reconciledOneAction versus candidate isolates this change across all nine configurations. |
| Grand utility/card count | 3 utilities/3 Surprise → 2 utilities/4 Surprise; index 31 utility → Surprise | Matches later Design and keeps 52 spaces. Less utility acquisition, more provisional card exposure. | thirdUtility ablation. |
| Exact Start landing | $200 → $300 total | Restores deliberate Design landing premium; adds bank income and can lengthen matches. S stays $200. | noLandingBonus ablation. |
| Holding fee | simulation $0 → $50 | Matches Design release price under the stated bot policy; increases cash drain. | noHoldingFee ablation. |
| Redemption | ceil(principal×1.1) → ceil(principal×110/100) | Fixes accidental $1 overcharges; not a balance lever. | historicalRedemption ablation; exact regression examples above. |
| Utility card interpretation | 10× ordinary rent using movement roll → 10× fresh seeded dice | Corrects an existing effect, without adding cards or approving placeholder values. Lower special utility charges; changes RNG consumption. | historicalUtilityCard ablation. |
| Management after entering Holding | historical build/restore allowed → deferred until release | Enforces the stated candidate turn rule; can slow development. Fixed during the single adversarial review and all final matrices rerun. | Seed 42: 5 historical builds in Holding → 0 candidate; final raw report. |
| Custom cash bounds | unspecified → integer $1500–$2500 | Makes the canonical bounded option concrete, with less host flexibility. | Full preset matrices below; intermediate values remain a sensitivity risk. |

Exploratory 100-seed probes tested 2/4/12 development actions on Standard 3/6 and Grand 6/10 using the historical board. Two already passed all four; four actions failed Grand-10 rent/Start at 5.011751, so larger budgets were not adopted. These probes are not the final evidence. Final 250-seed comparisons below use the production tables, the unchanged seed policy and unchanged evaluation bands. Cash-value reconciliations are source/correctness decisions, not claimed independent pacing improvements.

### Exact baseline versus selected candidate

250 seeds per configuration, configurationSeed(board, players, caseIndex, 0x5eed0008). No seed selection. Raw floating-point outputs and all criteria/distributions are in ECON-001-simulation.json; displayed rounds below are rounded to three decimals. Stalled means no natural winner by 90 Standard / 80 Grand rounds. This is the existing hard cap; capped runs remain stalls and are never counted as pacing successes.

| Config | Before turns med/P90 | After turns med/P90 | Before rounds | After rounds | Before stalls | After stalls | Before → after |
|---|---:|---:|---:|---:|---:|---:|---|
| Standard 3 | 150.5/219 | 130/185 | 55 | 47.833 | 7.2% | 2.0% | PASS → PASS |
| Standard 4 | 194/265 | 167/236 | 58 | 50.25 | 9.6% | 5.2% | PASS → PASS |
| Standard 5 | 234.5/321 | 199.5/274 | 62.4 | 50.7 | 12.4% | 4.8% | FAIL → PASS |
| Standard 6 | 276/349 | 226/342 | 66 | 52.167 | 15.6% | 6.8% | FAIL → PASS |
| Grand 6 | 244/313 | 208.5/282 | 58.167 | 47.833 | 16.4% | 8.8% | PASS → PASS |
| Grand 7 | 270/342 | 227.5/306 | 58.643 | 46.286 | 18.8% | 14.0% | PASS → PASS |
| Grand 8 | 303.5/375 | 247.5/319 | 62.313 | 47.5 | 25.2% | 9.2% | FAIL → PASS |
| Grand 9 | 333/402 | 270/341 | 66.222 | 50.222 | 24.0% | 10.0% | FAIL → PASS |
| Grand 10 | 368/434 | 292/361 | 69.2 | 50.4 | 28.0% | 8.0% | FAIL → PASS |

Final candidate early-bankruptcy rate is 0% in every default configuration. All unchanged health bands pass; full acquisition milestones, first set/build/bankruptcy, ownership, auction ratios, rent concentration, laps, Start income and winner correlations are in the raw report. The old SPIKE-008-results.md is untouched and its full baseline summary reproduces exactly.

### Isolated two-action comparison

| Config | Reconciled one-action rounds/stalls | Selected two-action rounds/stalls |
|---|---:|---:|
| Standard 3 | 56.833 / 3.2% | 47.833 / 2.0% |
| Standard 4 | 61.75 / 12.8% | 50.25 / 5.2% |
| Standard 5 | 64.1 / 13.2% | 50.7 / 4.8% |
| Standard 6 | 68.333 / 16.8% | 52.167 / 6.8% |
| Grand 6 | 59.833 / 17.2% | 47.833 / 8.8% |
| Grand 7 | 64.929 / 23.2% | 46.286 / 14.0% |
| Grand 8 | 62.438 / 17.6% | 47.5 / 9.2% |
| Grand 9 | 66.556 / 19.6% | 50.222 / 10.0% |
| Grand 10 | 71.45 / 34.4% | 50.4 / 8.0% |

### One-change-at-a-time sensitivity

Each row reverses only the named reconciliation from the final candidate. Compare with the selected matrix above; no claim that every source correction improves every metric. All rows use 250 seeds. Full metrics are saved under ablations in the JSON report.

| Reversed change | Config | Median rounds | Stalls | Decision |
|---|---|---:|---:|---|
| noLandingBonus | Standard 3 | 47.167 | 3.2% | PASS |
| noLandingBonus | Standard 4 | 50.625 | 4.8% | PASS |
| noLandingBonus | Standard 5 | 50.2 | 6.0% | PASS |
| noLandingBonus | Standard 6 | 50.25 | 6.8% | PASS |
| noLandingBonus | Grand 6 | 47.833 | 11.2% | PASS |
| noLandingBonus | Grand 7 | 45.714 | 10.8% | PASS |
| noLandingBonus | Grand 8 | 46.313 | 8.8% | PASS |
| noLandingBonus | Grand 9 | 48.389 | 8.8% | PASS |
| noLandingBonus | Grand 10 | 48.2 | 8.0% | PASS |
| noHoldingFee | Standard 3 | 48.333 | 1.6% | PASS |
| noHoldingFee | Standard 4 | 51.25 | 7.2% | PASS |
| noHoldingFee | Standard 5 | 52.4 | 6.4% | PASS |
| noHoldingFee | Standard 6 | 53.333 | 4.0% | PASS |
| noHoldingFee | Grand 6 | 46.833 | 11.2% | PASS |
| noHoldingFee | Grand 7 | 48.429 | 11.2% | PASS |
| noHoldingFee | Grand 8 | 47.5 | 8.4% | PASS |
| noHoldingFee | Grand 9 | 50.722 | 8.8% | PASS |
| noHoldingFee | Grand 10 | 50.1 | 6.8% | PASS |
| historicalUtilityCard | Standard 3 | 48 | 2.8% | PASS |
| historicalUtilityCard | Standard 4 | 49.625 | 4.4% | PASS |
| historicalUtilityCard | Standard 5 | 50.3 | 6.0% | PASS |
| historicalUtilityCard | Standard 6 | 49.75 | 5.6% | PASS |
| historicalUtilityCard | Grand 6 | 47.083 | 7.6% | PASS |
| historicalUtilityCard | Grand 7 | 48.643 | 8.8% | PASS |
| historicalUtilityCard | Grand 8 | 48.438 | 5.2% | PASS |
| historicalUtilityCard | Grand 9 | 47.778 | 6.0% | PASS |
| historicalUtilityCard | Grand 10 | 50.8 | 10.0% | PASS |
| historicalRedemption | Standard 3 | 47.833 | 2.0% | PASS |
| historicalRedemption | Standard 4 | 50.25 | 4.4% | PASS |
| historicalRedemption | Standard 5 | 50.7 | 4.8% | PASS |
| historicalRedemption | Standard 6 | 52.167 | 6.8% | PASS |
| historicalRedemption | Grand 6 | 47.833 | 8.4% | PASS |
| historicalRedemption | Grand 7 | 46.286 | 13.6% | PASS |
| historicalRedemption | Grand 8 | 47.5 | 9.2% | PASS |
| historicalRedemption | Grand 9 | 50.5 | 10.0% | PASS |
| historicalRedemption | Grand 10 | 50.4 | 7.6% | PASS |
| thirdUtility | Standard 3 | 47.833 | 2.0% | PASS |
| thirdUtility | Standard 4 | 50.25 | 5.2% | PASS |
| thirdUtility | Standard 5 | 50.7 | 4.8% | PASS |
| thirdUtility | Standard 6 | 52.167 | 6.8% | PASS |
| thirdUtility | Grand 6 | 48.75 | 12.0% | PASS |
| thirdUtility | Grand 7 | 46.786 | 10.4% | PASS |
| thirdUtility | Grand 8 | 47.5 | 11.2% | PASS |
| thirdUtility | Grand 9 | 50.111 | 8.8% | PASS |
| thirdUtility | Grand 10 | 51.55 | 10.0% | PASS |

## Grand A/B/C

A is the shared two-action core above. B/C are minimal pre-FREEZE candidates defined here because only their names existed in canonical/Design sources. They are not enabled together or in production.

- B (Turbo): add one injected d6 to distance on every ordinary two-dice roll. Original two dice alone determine doubles; utility ordinary rent still uses those two dice. Resolve only the destination; normal Start crossing salary applies. No extra rent multiplier, extra development budget or post-roll choice.
- C (Transit connection): after resolving a hub reached in an ordinary dice-roll resolution (including a card redirect), automatically move forward to the next hub once and resolve its normal purchase/rent. Crossing Start pays the normal $200. No second connection on arrival, no recursive loop, no stored inventory or choice policy. This minimal automatic-connection candidate intentionally avoids adding a persistent pass subsystem; the named Transit Pass board space remains neutral.
- Both retain A’s development, cash and rent rules. Compare matched seeds, but paths consume RNG differently. Passing the simulator is not human approval of these candidate mechanics.

| Config | Module | Turns med/P90 | Rounds | Stalls | Laps/player | Start income/player | Rent/Start | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Grand 6 | A | 208.5/282 | 47.833 | 8.8% | 4.833 | 1075 | 2.621 | PASS |
| Grand 7 | A | 227.5/306 | 46.286 | 14.0% | 4.571 | 1000 | 3.095 | PASS |
| Grand 8 | A | 247.5/319 | 47.5 | 9.2% | 4.25 | 931.25 | 3.444 | PASS |
| Grand 9 | A | 270/341 | 50.222 | 10.0% | 4.111 | 911.111 | 3.945 | PASS |
| Grand 10 | A | 292/361 | 50.4 | 8.0% | 4 | 890 | 4.208 | PASS |
| Grand 6 | B | 219/295 | 51.75 | 14.0% | 7.917 | 1691.667 | 2.084 | PASS |
| Grand 7 | B | 243.5/319 | 52.286 | 12.4% | 7.5 | 1600 | 2.436 | PASS |
| Grand 8 | B | 262/342 | 52.438 | 8.4% | 7 | 1487.5 | 2.69 | PASS |
| Grand 9 | B | 284/366 | 52.278 | 8.4% | 6.667 | 1433.333 | 2.965 | PASS |
| Grand 10 | B | 310/386 | 52.85 | 14.8% | 6.7 | 1425 | 3.267 | PASS |
| Grand 6 | C | 203.5/275 | 47.667 | 6.4% | 5.5 | 1200 | 2.534 | PASS |
| Grand 7 | C | 220/290 | 46.5 | 6.8% | 5.143 | 1107.143 | 2.988 | PASS |
| Grand 8 | C | 244.5/333 | 48.688 | 11.6% | 5 | 1087.5 | 3.266 | PASS |
| Grand 9 | C | 269.5/342 | 49.056 | 14.0% | 4.889 | 1066.667 | 3.6 | PASS |
| Grand 10 | C | 294/361 | 50.45 | 9.2% | 4.8 | 1045 | 3.937 | PASS |

Choose A: B adds movement/dice complexity without a consistent pacing benefit. C is quicker at some lower counts but does not improve the high-count problem consistently; its small Grand-10 stall difference is not evidence worth a new rule. Acquisition and rent-exposure distributions remain available for independent review, and GRAND-005/008 retain human comparison work.

## Starting-cash sensitivity

| Config | Cash | Turns med/P90 | Rounds | Stalls | Decision / misses |
|---|---:|---:|---:|---:|---|
| Standard 3 | 1500 | 151/203 | 53.667 | 2.8% | PASS |
| Standard 4 | 1500 | 177.5/253 | 51.5 | 5.6% | PASS |
| Standard 5 | 1500 | 206.5/296 | 51.4 | 7.2% | PASS |
| Standard 6 | 1500 | 237/333 | 51.167 | 5.2% | PASS |
| Grand 6 | 1500 | 224/308 | 51.5 | 16.4% | PASS |
| Grand 7 | 1500 | 239/319 | 50.929 | 14.8% | PASS |
| Grand 8 | 1500 | 238/325 | 45.063 | 10.0% | PASS |
| Grand 9 | 1500 | 261.5/339 | 46.944 | 9.2% | PASS |
| Grand 10 | 1500 | 279/355 | 49.3 | 8.4% | PASS |
| Standard 3 | 2500 | 125/184 | 45.333 | 2.0% | PASS |
| Standard 4 | 2500 | 161.5/234 | 48.25 | 6.0% | PASS |
| Standard 5 | 2500 | 196.5/276 | 51 | 6.8% | PASS |
| Standard 6 | 2500 | 228/339 | 53.583 | 8.0% | PASS |
| Grand 6 | 2500 | 207/274 | 48.583 | 6.8% | PASS |
| Grand 7 | 2500 | 231/299 | 49.786 | 10.4% | PASS |
| Grand 8 | 2500 | 255/318 | 50.375 | 8.8% | PASS |
| Grand 9 | 2500 | 276/349 | 50.556 | 9.2% | PASS |
| Grand 10 | 2500 | 307/391 | 55.5 | 12.4% | FAIL: median-rounds-max 55.5 vs 55; rent-vs-start-income-max 5.166 vs 5 |

Grand-10 at $2500 reaches median 55.5 rounds against 55 and rent/Start 5.166231553398058 against 5, with 12.4% stalls. Do not hide this as PASS. The default launch matrix passes and the previously unhealthy 24–28% stalls are eliminated; the high-cash preset has a small residual review/playtest risk. Retain the mandated preset, disclose its result, and do not silently widen the evaluation bands or retune all rents to erase a marginal miss.

## Remaining assumptions and review boundaries

- No human alpha took place. Trading is a one-set-closing-trade-per-round heuristic; auctions use 75% list to the most liquid eligible bot; purchase/development reserves remain $200/$300. Results characterize these policies, not optimal negotiation or real-time match duration.
- Card placeholder effects are retained solely to compare the existing simulator/product effects. The candidate fixes the explicit utility-card interpretation; the two ambiguous cards and release-card inventory remain modeled as no economic effect. RULE-011/012 must finalize decks and rerun the matrix. Card contents are not freeze-approved here.
- Holding uses the stated pay policy, and repeated doubles retain the historical three-roll cap. The historical simulator uses a shallow card-chain approximation; production retains the canonical 16-step resolver requirement. Full production rule implementations must be validated again before launch.
- Grand specials have an explicit neutral core decision, not hidden cash placeholders. Activating their named features is a separate rules/UI change. Claude should challenge this candidate choice during freeze-readiness review.
- CORE-001/RULE/RT work is not implemented. No live ownership, server authority, persistence, idempotency or rematch architecture is changed. No Collusion Guard backend, bailout rule, UI change, dependency or infrastructure is added.

## Builder Handoff — ECON-001

### What changed
- Published full authored candidate economy tables, shared rules, immutable loader and regression tests; extended the existing simulator with isolated optional candidate behavior and a reproducible comparison CLI. Updated architecture/ADR/task decisions.

### Why this implementation
- Two actions are the smallest tested structural pacing change that repairs the default supported matrix without changing approved property rents/prices. All governance conflicts and newly bounded assumptions are explicit.

### Files changed
- ARCHITECTURE.md; TASKS.md; docs/adr/ADR-004-world-tour-board-economy.md.
- boards/world-tour/standard.json; boards/world-tour/grand.json.
- packages/game-core/src/economy.ts; economy-candidates.ts; economy.test.ts.
- packages/game-core/src/spike-008/economy-data.ts (shared types only); economy-simulator.ts (optional candidate paths); reconciliation-cli.ts (new).
- package.json (reconciliation script); docs/architecture/PRE-FREEZE-ECONOMY-RECONCILIATION.md; ECON-001-simulation.json.
- Existing unstaged SPIKE-008 CLI/tests/results, package script and packages/game-core/tsconfig.json predate this pass and remain part of the working tree. No pre-existing work was discarded or staged.

### Invariants affected
- Fixed board counts/set membership, authored integer money and ratios, per-turn development budget, source immutability and cross-board/new-game isolation. Server authority/persistence/timers remain untouched.

### Tests run
- pnpm lint -> PASS.
- pnpm typecheck -> PASS.
- pnpm test -> PASS: 163 tests / 15 files, including SPIKE-007/008.
- pnpm build -> PASS (Vite build and Worker dry run; no deployment).
- git diff --check -> PASS.
- pnpm --silent simulate:economy --games=250 -> PASS execution; historical MODIFY outcome remains reproduced, not relabeled.
- pnpm --silent simulate:reconciliation --games=250 -> PASS execution: 25,000 deterministic games across baseline, reconciliation, A/B/C, five ablations and cash presets. Default selected matrix 9/9 PASS; preset caveat above.

### Manual checks
- Read Design sources and Grand screenshot; checked source formulas, both board arithmetic totals and country run ordering. No UI/browser behavior was changed or claimed as tested.

### Evidence
- ECON-001-simulation.json contains 250 seeds/configuration, full distributions and individual criteria. Historical SPIKE-008-results.md remains unchanged.

### Known limitations
- Human review, card finalization, Holding approximation, neutral Grand specials and the $2500 Grand-10 sensitivity remain explicit above.

### Architecture impact
- User-authorized proposed amendment to ADR-004 and ARCHITECTURE.md: two utilities/four Grand Surprise spaces, two-action development, concrete cash/board-space candidates. No frozen runtime architecture changes. FREEZE-001 remains TODO.

### Adversarial self-review
- One final self-review checked actual tables and optional simulator paths, exact historical replay, all per-config outcomes, private-file tracking, unrelated edits, new dependencies, Math.random, skipped tests and unchecked placeholders. It caught building immediately after being sent to Holding; candidate management now waits until release. Regression seed 42 demonstrates five historical development actions in Holding versus zero in the candidate. Reran all checks and all 25,000 comparison games after the fix. Historical baseline summary equality verified against the original CLI report. No private Design files are tracked; no UI/dependency diff; no new Math.random, TODO/FIXME or skipped tests. No self-approval; Claude decides the verdict.

### Exact Git handoff (read-only; leave all changes unstaged)

```powershell
git status --short --branch
git diff --check
git diff -- ARCHITECTURE.md TASKS.md docs/adr/ADR-004-world-tour-board-economy.md boards/world-tour/standard.json boards/world-tour/grand.json package.json packages/game-core/tsconfig.json
git ls-files --others --exclude-standard
git diff --no-index -- /dev/null packages/game-core/src/economy.ts
git diff --no-index -- /dev/null packages/game-core/src/economy-candidates.ts
git diff --no-index -- /dev/null packages/game-core/src/economy.test.ts
git diff --no-index -- /dev/null packages/game-core/src/spike-008/economy-simulator.ts
git diff --no-index -- /dev/null packages/game-core/src/spike-008/reconciliation-cli.ts
```

For Git for Windows, /dev/null is the empty side of each untracked-file diff; exit 1 means differences were displayed. The untracked-file inventory also includes historical SPIKE work: review those files and the reconciliation document/report directly. Do not use git add -A: private sources stay excluded and the user requested an unstaged handoff.
