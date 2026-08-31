# ADR-004 — World Tour boards and economy

**Status:** Proposed / freeze after renderer/economy gates  
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

Initial hypothesis: six pairs + six triples. Grand corner semantics remain open.

## No slider
Tile count is part of boardId/version. Different size = different new-game board.

## Economy
Independent authored Standard/Grand price/rent tables.

Initial calibration:
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
Compare core vs Turbo candidate vs Transit candidate using simulation and humans. "None" is valid.

Other Mega-inspired modules stay post-launch.

## Revisit
Board structure/economy fails simulation or alpha; 6-player crossover changes; pacing test falsifies assumptions.
