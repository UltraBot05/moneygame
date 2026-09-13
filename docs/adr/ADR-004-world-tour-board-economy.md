# ADR-004 — World Tour boards and economy

**Status:** Accepted by FREEZE-001
**Date:** 2026-08-31

## Context
One 40-tile board crowds large groups; one 52-tile board is too large for small groups. Runtime tile sliders create reset/cache/balance complexity.

## Decision
Launch two immutable definitions.

### Standard
```text
world-tour-standard@1
40 tiles
3–6 recommended
22 countries
8 sets
```

Standard stays familiar/teachable. Familiar mechanical corner roles may remain initially with original product identity/art.

### Grand
```text
world-tour-grand@1
52 tiles
6–10 recommended
30 countries
12 sets
3 sets/side
```

Frozen mapping: six pairs + six triples. Grand has four fixed structural corner positions; their final product semantics remain deferred.

## No slider
Tile count is part of boardId/version. Different size = different new-game board.

## Economy
Independent authored Standard/Grand price/rent tables.

Frozen shared calibration:
```text
Start salary 200
default cash 2000
base complete-set rent 2x
mortgage 50%
unmortgage +10%
building sell-back 50%
```

Balance:
```text
Standard: 3,4,5,6
Grand: 6,7,8,9,10
```

## Grand pacing
Grand launches with core movement. Turbo and Transit remain disabled isolated concepts; later human evidence may revisit them only through the freeze amendment rule.

Other Mega-inspired modules stay post-launch.

## Revisit
Board structure/economy fails simulation or alpha; 6-player crossover changes; pacing test falsifies assumptions.

## ECON-001 reconciliation amendment (accepted by FREEZE-001, 2026-09-13)

The user authorized the ECON-001 reconciliation before freeze. FREEZE-001 accepts its board structure, shared rules, and Grand A decision as the implementation baseline. Canonical board tables live in `boards/world-tour/{standard,grand}.json`, with shared rules in `packages/game-core/src/economy.ts`.

- Standard retains 40/22/8, with Egypt/France low-high pairs and six middle triples.
- Grand retains 52/30/12, three sets per side, six low-tier pairs plus six high-tier triples.
- Grand uses two utilities (Power Grid, Water Works); index 31 becomes a fourth Surprise space. Counts sum to 52. This explicitly supersedes the earlier three-utility candidate.
- Preserve authored prices/rent/build ladders and canonical money ratios; round redemption upward using integer percentages.
- Two development purchases per owner turn, one level/action, with payment and even-build validation on each action. No price/rent uplift.
- Grand uses A; isolated B/C rules are defined for comparison and are not enabled.
- Cash custom bound is integer 1500–2500 inclusive. Default remains 2000.
- Start landing totals 300; passing pays 200; Holding release 50. Core reserved Grand specials and Vacation have zero cash effect. Card content remains provisional and is not promoted from visual placeholders.

See `docs/architecture/PRE-FREEZE-ECONOMY-RECONCILIATION.md` for exact values, matrix, trade-offs and limitations. ECON-001 independent review is complete. Human balance validation and card finalization remain deferred and may amend this decision through the post-freeze change rule.
