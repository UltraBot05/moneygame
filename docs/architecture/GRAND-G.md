# GRAND-G: Grand parity and production-path economy (Section G)

Status: GRAND-001..004 implemented and evidenced 2026-09-29. GRAND-005 (human alpha) is a human
gate and is prepared, not claimed. GRAND-006..009 (optional Turbo/Transit candidates) are not
implemented: the frozen decision is Grand A (core), and they only proceed if human and simulation
evidence beats it.

## GRAND-001 production parity

The frozen `world-tour-grand@1` definition (52 tiles, 12 sets, 30 cities) runs on the shared
production rule path without reauthoring: the same `applyGameplayCommand` pipeline, the same
card engine with the Grand catalog, and the same room runtime (lobby board choice, 10 seats).
`packages/game-core/src/grand-parity.test.ts` pins the structure (Holding 13, Go To Holding 39,
Surprise on 31, specials on 11/24/25) and shows the three reserved specials are neutral landings.

## GRAND-002 HUD and renderer

Delivered with Section F: the board is size-agnostic (`computeLayout`), tile names fit without
mid-word breaks, and the rail and centre stage were checked with 10 players on Grand at
1920x1080 and 1440x900 (Playwright smoke asserts 52 tiles, 10 player rows, no page scroll).

## GRAND-003/004 production-path economy

`packages/game-core/src/simulation/production-simulator.ts` plays whole matches with
deterministic bots **through the production rule path** (the same function the room runs),
with every final mechanic in force: English auctions, full Holding flow (doubles, fee, release
card, third-attempt fee), two even builds per turn, the approved card decks, CORE-011 debt with
liquidation, classic bankruptcy, and set-completion trades (which the Collusion Guard evaluates).
The bot follows the SPIKE-008 policy ($200 purchase reserve, $300 development reserve, 75%
auction cap, 125% set-completion trades once per round). Results are summarized with the
unchanged SPIKE-008 metrics, seed schedule and health bands, so they compare directly with the
frozen ECON-001 candidate.

Run: `pnpm simulate:production` (default 250 seeds per configuration). Raw output:
`docs/architecture/PRODUCTION-SIMULATION.json`.

| Config | ECON-001 rounds med/P90 | Production rounds med/P90 | ECON-001 stalls | Production stalls | ECON-001 rent/Start | Production rent/Start | Round-10 leader wins | Bands |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Standard 3 | 47.8 / 71.0 | 46.2 / 69.0 | 2.0% | 2.4% | 1.38 | 1.39 | 0.44 | PASS |
| Standard 4 | 50.3 / 77.3 | 48.1 / 72.5 | 5.2% | 4.8% | 1.85 | 1.81 | 0.37 | PASS |
| Standard 5 | 50.7 / 75.0 | 48.4 / 69.2 | 4.8% | 4.4% | 2.15 | 2.19 | 0.37 | PASS |
| Standard 6 | 52.2 / 83.8 | 49.3 / 67.8 | 6.8% | 1.2% | 2.40 | 2.47 | 0.36 | PASS |
| Grand 6 | 47.8 / 77.3 | 47.2 / 80.0 | 8.8% | 11.2% | 2.62 | 2.60 | 0.53 | PASS |
| Grand 7 | 46.3 / 80.0 | 46.6 / 73.9 | 14.0% | 8.0% | 3.09 | 3.08 | 0.56 | PASS |
| Grand 8 | 47.5 / 76.5 | 48.4 / 75.3 | 9.2% | 7.6% | 3.44 | 3.36 | 0.58 | PASS |
| Grand 9 | 50.2 / 79.2 | 47.7 / 74.2 | 10.0% | 8.0% | 3.95 | 3.86 | 0.60 | PASS |
| Grand 10 | 50.4 / 77.3 | 50.3 / 76.2 | 8.0% | 8.8% | 4.21 | 4.15 | 0.56 | PASS |

Early-bankruptcy rate is 0% and ownership saturation and set formation are 100% in every
configuration. The production path reproduces the frozen A/core economy within a few rounds
without any rebalance: no silent drift from implementing the final Holding, card and debt rules.

### Measurement notes

- Rent is income a single other player receives in a non-trade, non-auction step; card payouts
  to several players at once are excluded, as in SPIKE-008. Start income includes Start salary
  from card movement, which `CARD_RESOLVED.startAward` now reports.
- Rounds count seat steps (a bankrupt seat still costs a step), as in SPIKE-008; stalls are runs
  with no natural winner by 90 (Standard) or 80 (Grand) rounds.
- Bots are one deterministic policy. Human play (negotiation, auction bluffing, timeouts) is the
  open question GRAND-005 and QA-015 exist for.

## GRAND-005 human alpha (prepared)

Suggested protocol for the human gate: at least three Grand sessions at 6, 8 and 10 players on
the deployed build, 90-second turns, recording match length, first bankruptcy, stalls, and
free-text feedback on readability of the dense board and the auction/trade flows. Compare
lengths with the table above.
