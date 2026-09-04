# Spike Result — SPIKE-006 (dual-board renderer)

**Date:** 2026-09-03 (independent review 2026-09-04)  
**Original builder:** Claude Code  
**Integration:** Codex  
**Reviewer:** Claude Code (independent-integrator pass) — **APPROVE**  
**Working tree:** `main` at `af6cdff`; all spike work remains unstaged

## Decision

`APPROVE — DONE`. (Was `PASS — READY_FOR_REVIEW`; see independent review below.)

## Independent review (2026-09-04)

Re-ran the full repo gate on the working tree: **lint PASS, typecheck PASS,
144 tests PASS (13 files), build PASS, `git diff --check` clean**. Focused
SPIKE-006 tests (`layout.test.ts` 15 + `fixtures.test.ts` 3) pass. Source audit
found no secrets, no `Math.random` in web code (one comment only), no new
dependency, no `package.json` change, no `boards/` change, and no fuzz↔UI import
coupling. The CSS was statically verified to back the no-document-scroll,
internal-overflow, reduced-motion, focus-visible, and colour-independent-identity
claims.

**Two small fixes were applied this pass** (minimal, aligning the implementation
with the now-present approved design — no redesign):

1. Currency glyph `§` → `$` across `Board.tsx`, `Cards.tsx`, `Panels.tsx`, per the
   Claude Design decision ("$ — was a non-standard glyph") and explicit user
   instruction. Synthetic demo strings only.
2. `docs/**` added to `eslint.config.js` ignores. The design deliverables include
   a generated browser bundle (`docs/support.js`) that otherwise made `pnpm lint`
   fail with 98 `no-undef` errors; design artifacts are not app source.

**Design artifacts are present and are design-only proof.** See the
Claude-Design section below — the 9 `.dc.html` mockups + 24 screenshots are the
approved product UX; the React app implements the *gameplay-shell/board/rail*
architecture of that design (shared visual tokens), not the full product.

**Verification limitation:** live browser re-verification could not be performed
this session — the Chrome automation extension was not connected — so the browser
table below is the prior integration's headless-Chrome run, not independently
reproduced now, and the "200%-zoom" row is an equivalent CSS viewport, **not**
actual browser zoom. The renderer uses relative units (`dvh`/`vw`/`%`/`clamp`)
and reflows, but a true 200%-browser-zoom pass remains the one piece of evidence
not independently confirmed. Not treated as blocking for a renderer/UX spike.

One semantic DOM/CSS renderer lays out Standard 40 and Grand 52 from the same
tile-count-derived perimeter math. The destructive fixture now proves 10 players,
a long property name, a seven-digit balance, all 12 Grand set identities,
ownership, modular development, mortgage, selection, chat/log, and contextual
gameplay states without touching canonical `boards/` data.

## Reconciliation of the two implementation phases

### Original technical renderer proof

Claude Code established the reusable geometry in `layout.ts`:
`perSide = (tileCount - 4) / 4`, producing 9 non-corner tiles per side for
Standard and 12 for Grand. It also established the original navy, brass, and
warm-paper component language, semantic button tiles, synthetic fixtures, set
codes/patterns, owner shapes, mortgage overlay, modular development blocks, and
keyboard focus treatment.

### Claude Design product UX (design-only, now in `docs/`)

A subsequent Claude Design pass delivered the full product UI/UX as **design
artifacts** — nine `.dc.html` canvas mockups + a 24-image screenshot gallery,
indexed by [docs/index.html](../index.html) and narrated in
[docs/WORK-REPORT.md](../WORK-REPORT.md). This is the **approved visual source of
truth**. It is design-only proof: none of it is wired into the React app, and it
is intended to be `.gitignore`d (design deliverables, not app source). The design
pass deliberately *recreated the existing renderer as its baseline* and built on
its tokens, so the two share the same surfaces (slate table, warm-paper board,
brass edges) — the design **extends** the implemented visual language rather than
replacing it. Divergences the design introduced over the baseline: `$` currency
(now applied to the app), authored real cities/economy (`$60–$400` Standard /
`$60–$550` Grand — **placeholder, not canonical**; stays in `boards/`+CORE tasks),
plain flat-colour pawns, a thin-red-edge mortgage treatment, and additional
product surfaces (lobby, holding tile, trade popup, card decks, collusion guard).

### Final integrated gameplay-shell proof (React app)

The React app implements the **gameplay-shell / board / rail architecture** of the
approved design (shared visual tokens), not the full product. Its palette,
typography, board treatment, components, and visual identity match the design's
gameplay shell, with these surfaces present in-app:

- compact top-bar board controls and a development-only state dropdown;
- left/right keyboard cycling through deterministic demo states;
- persistent current-turn status;
- context/action rail;
- internally scrolling 10-player list;
- separate Chat and Game log tabs with a functional local plain-text chat demo;
- active board-centre turn, auction, event, and trade stages;
- two-party trade layout with a shared middle Deal tray;
- smart inward-anchored property deed plus narrow-screen rail fallback;
- rail-level debt resolution that leaves the board usable;
- final-results card over a dimmed final board.

No backend gameplay, chat socket, or client-authoritative economic mutation was
introduced.

## Renderer and fixture evidence

- `layout.test.ts`: 15 tests prove both boards have four correct corners,
  correct per-edge counts, unique outer-ring cells, clockwise indexing, and no
  Standard-only geometry.
- `fixtures.test.ts`: 3 tests prove deterministic demo output, eight Standard
  identities, all twelve Grand identities, ten players, long content, a
  seven-digit balance, ten tokens on one tile, mortgage, and development.
- Standard renders 40 buttons in an 11×11 perimeter grid.
- Grand renders 52 buttons in a 14×14 perimeter grid using the same component and
  layout function. Its tile CSS deliberately tightens padding and secondary type
  rather than scaling the whole Standard board down.
- The mortgage fixture previously could never occur because its predicate
  required mutually exclusive conditions. The synthetic predicate was corrected
  and is now protected by a behavior test.
- Grand exposes 12 distinct two-letter set codes in the rendered board. Every set
  also has a color and repeatable pattern; ownership adds initials and token shape.

## Browser evidence

Verified against a live Vite build in headless Chrome with no console exceptions:

| Case | Measured result |
|---|---|
| Standard, 1440×900, 10 players | document 1440×900; board 788×788; rail 360×788; 40 tiles |
| Grand property, 1440×900 | document 1440×900; board 788×788; rail 360×788; 52 tiles |
| Grand trade, 1920×1080 | document 1920×1080; board 968×968; rail 360×968; 52 tiles |
| Desktop no-scroll | `documentElement.scrollHeight === innerHeight` at both desktop sizes |
| 200%-zoom *equivalent* (720×450 CSS viewport — not actual browser zoom) | responsive single-column layout; board remains a legible panning surface; rail follows below |
| Mobile, 375×812 | controls stack; 640px board pans inside its frame instead of becoming microscopic; full rail follows below |
| 10-player rail | player area 273px and internally scrolls; chat/log area remains 347px |
| Anchored deed | measured bounds left 500, top 571, right 820, bottom 801 at 1440×900; fully inside viewport |

All seven demo states were selected through the live control and asserted present:
turn, selected property, auction, event, trade, debt, and results. Left/right
keyboard cycling moved from turn to property. Chat and Game log tabs switched
correctly, a typed plain-text message was added locally, and the run produced no
runtime exception.

## Accessibility and motion

- Board children expose grid/gridcell semantics and native button interaction.
- A focused tile measured a visible 3px outline.
- Set and ownership identity never depend on color alone.
- Mortgage and development states have text/semantic labels.
- The selected deed flips inward by board edge; narrow screens use the persistent
  rail summary instead of a clipped popover.
- `prefers-reduced-motion: reduce` measured the dice animation at 0.01ms.
- Controls have labels, disabled states, focus-visible styling, themed selection,
  form caret/input treatment, and internal scrollbars.

## Content and architecture discipline

Every displayed name, price, rent, balance, event, bid, and trade is deterministic
synthetic renderer data. No final property/economy content was invented.
Canonical `boards/world-tour/*.json` files are unchanged. No dependency was
added, no game-core/UI coupling was introduced, and authoritative state remains
server-side by design.

## Verification

- focused SPIKE-006 tests: 18 passing;
- web TypeScript check: passing;
- browser sizes/states above: passing;
- mechanical UI detector: one false-positive warning on the CSS triangle player
  marker's `border-bottom`; this is the intentional geometric token shape, not
  a thick card accent.

Repository-wide lint, typecheck, test, build, and `git diff --check` are recorded
in the final builder handoff.

## Implementing the approved UI (follow-up path — reviewer cross-check)

The approved Claude Design UI is **not** implemented in the app today, and that is
correct for SPIKE-006 (a "rough renderer" acceptance, met). Building the full
product UI now would be out of order: most surfaces need backend behaviour that
does not exist yet (you cannot build the real trade popup before `RULE-014` trade,
or the auction UI before `RULE-005`). The implementation path is **already planned
in `TASKS.md`** as the F. Standard UI series (gated behind `FREEZE-001` + the RULE
/RT backend), not a new spike. A reviewer cross-checks each UI task against the
specific design artifact it must match:

| Design artifact (`docs/`) | Screenshot(s) | Implementing task | Reviewer checks the built UI against… |
|---|---|---|---|
| Design System Sheet | `dsys-01` | **UI-001** design tokens | colour roles, type scale, spacing, states match the sheet |
| Lobby Flow | `lobby-01..05` | **UI-002** lobby shell (+ `RT-001`, ADR-002 Google OIDC, no guest seats) | landing / create / join / signed-out / room-settings 3-section layout |
| Gameplay Shell + Component Kit | `shell-01..08`, `kit-01` | **UI-003** Standard board, **UI-004** 3–6 HUD, **UI-005** turn/dice tray | board anatomy, rail, turn panel, dice, centre stage |
| Gameplay Shell (deed/build/mortgage) | `shell-02-unowned` | **UI-006** property/build/mortgage | deed panel anchoring, red-edge mortgage, modular blocks |
| Gameplay Shell (auction) | `shell-03-auction` | **UI-007** auction UI | countdown, quick bids, 10-bidder usability |
| Gameplay Shell (trade popup) | `shell-04-trade` | **UI-008** trade UI | 3-step popup, live net, developed-tile lockout |
| Card Decks + Holding | `cards-01/02`, `shell-05-holding` | **UI-009** card/tax/detention UI | Surprise/Treasure cards (placeholder values), concentric holding tile |
| Gameplay Shell (debt) | `shell-06-debt` | **UI-010** debt/bankruptcy UI | rail-urgent panel, board stays interactive |
| Gameplay Shell (endgame) | `shell-07-end` | **UI-012** game end/rematch | standings over dimmed board |
| Mobile and Tablet | `mobile-01` | **UI-013** mobile/reduced-motion | pan/zoom board, action sheet, tab bar |
| Gameplay Shell (Grand 52) | `shell-08-grand-1440` | **GRAND-002** 6–10 HUD/renderer | denser 12/side tiles, 10-player cases |

**One tracking gap to add (not created here):** the **Collusion Guard** surface
(`Collusion Guard.dc.html`, `collusion-01..05`) — private warning → room notice →
removal → bailout-blocked → bankruptcy-dump — has **no dedicated UI or rules task**
in `TASKS.md`. Its detection/governance belongs near `RULE-018` (teams) and the
bankruptcy rules; its screens are a fair-play UI task. Recommend adding an explicit
`RULE-`/`UI-` pair for it so the approved design is not silently dropped. Left for
the user to slot in (a new task is beyond this review's mandate).

Card Decks and the authored economy in the mockups are **placeholder / balancing
content** (the Card Decks sheet says so on its face); they must land as canonical
board data through `CORE-001`/`RULE-011`/`RULE-012`/`GOV`-series tasks, never
copied from the design files as-is.

## Limitations

- This remains a renderer/demo spike with synthetic presentation state; server
  commands and live chat arrive in later tasks.
- Narrow and 200%-zoom layouts intentionally pan the board rather than shrinking
  Grand into illegibility.
- Final authored board content, production icons, and game-rule wiring remain
  owned by later CORE-, RULE-, RT-, and UI-series tasks.

## Architecture impact

None. The spike preserves immutable board identity, proves the shared DOM/CSS
renderer, and introduces no ADR change.
