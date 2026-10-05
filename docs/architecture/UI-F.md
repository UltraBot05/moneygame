# UI-F: production web client (Section F)

Status: implemented 2026-09-29. Visual source of truth: the private Claude Design files
(Design System Sheet, Gameplay Shell, Lobby Flow, Mobile and Tablet). The SPIKE-006 demo shell
is retired; only its size-agnostic layout math (`app/web/src/board/layout.ts`) remains.

## Structure (`app/web/src`)

| File | Role |
| --- | --- |
| `styles.css` | Design tokens as CSS variables, components, reduced-motion and mobile rules |
| `room-client.ts` | UI-014 live client: one WebSocket, the server's last `STATE` is the only game truth |
| `view-model.ts` | Pure functions from the projected state to screen models (board, turn, deed, log) |
| `Game.tsx` | Board, centre stage (idle, card reveal, auction), deed panel, rail |
| `Dialogs.tsx` | Trade, confirm, paused and final-standings dialogs |
| `Landing.tsx` | Landing, lobby (settings, ready, teams), message pages |
| `App.tsx` | Two routes (`/`, `/r/CODE`) on the History API; auth gate via `/api/me` |
| `dev-preview.tsx` | DEV ONLY hot-seat preview at `/dev/preview` (see below) |

## Decisions

1. **No client authority.** Commands are sent, never applied locally. The UI only mirrors rules
   to decide which buttons to offer; every command is validated by the room.
2. **Retry safety.** A command keeps its `actionId` until the server answers. After a reconnect
   the client resends unanswered commands with the same id when the game version has not moved,
   and drops them when it has (the server either committed them or would refuse them as stale).
   A protocol `ERROR` (no actionId) releases all pending commands.
3. **Ordering.** A `STATE` for an older version of the same game is ignored.
4. **Clocks.** Countdowns use server deadlines plus the offset `serverTime - Date.now()` from the
   latest `STATE`; the server's alarms stay authoritative.
5. **Unreachable rooms.** A refused upgrade (unknown room, full room) cannot be read by browser
   WebSocket code, so four failed first connects show "Can't open room" with a retry.
6. **Only supported settings** appear in the lobby: board, starting cash (presets or custom
   $1,500 to $2,500), match mode with team assignment, and turn timer 45 or 90 seconds. Design-only
   settings (bots, player caps, private toggle, board map) are not shown.
7. **Tile names** never break mid-letter: the boards' long words have hand-picked soft-hyphen
   points (`fitName`), and anything still too wide is scaled down.
8. **Game log** lists committed events this tab received; the server keeps authoritative history.
9. **Collusion Guard UX** is server-driven only: warnings are shown to the two players involved
   (as projected) and removals are public log lines. The client never judges a trade.
10. **Pawns** are large ringed discs centred on their tile; the active player's pawn glows and bobs
   and their tile is outlined. Pawns step tile by tile toward the authoritative position for display
   only (long or backward moves and reduced motion jump).
11. **One Roll button**: on the board beside the dice on desktop, in the rail on phones (where the
   board scrolls). The centre stage sizes with the board (container units) so nothing overlaps.
12. **Resign** sits under the turn panel's Trade and Manage deeds buttons, behind a confirmation.
13. **One dark game surface** (owner request, after comparing with Richup): the board, centre and
   rail share the dark slate palette so pawns and owner colours carry the board; paper stays for
   cards, deeds and dialogs. A tile reads inner edge to outer edge: set band (buildings sit on it
   in place of the set code), the name, a pawn zone (special tiles show their icon there), and a
   strip with the price that turns into the owner's colour and initials once bought (hatched when
   mortgaged). Pawns stay in their zone so they never cover a name; five or more on one tile split
   into two rows. The centre shows the latest log lines under the dice. New text colours on dark
   all meet WCAG AA (lowest 5.3:1).
14. **Player spotlight**: hovering or keyboard-focusing a player in the list keeps that player's
   deeds and pawn tile in full colour, outlined in their colour, and dims the rest of the board.
15. **3D dice** are CSS cubes (no library): six faces, opposite faces summing to 7, tilted so three
   faces show. A roll tumbles in from extra turns and lands on the server's result; reduced-motion
   users see the result without the tumble.
16. **Game sounds** are synthesised with Web Audio (no audio files): dice, coin (buy, rent, Start,
   tax, mortgage), building, landmark, card, auction bid, "your turn", trade offer or fair-play
   alert, Holding, bankruptcy, win and chat. They follow committed events only (never history
   present when the screen opened), so every player hears the same moments and nothing hidden is
   revealed. A Sound on/off toggle in the top bar is remembered per browser.

## Dev preview

`/dev/preview` runs game-core in the browser and always acts as whoever the rules are waiting on,
so every screen can be exercised without Google sign-in or a Worker. Query options:
`board=grand`, `players=3..10`, `scene=start|mid|debt|lobby`. It is behind `import.meta.env.DEV`
and absent from production bundles (verified by build). Playwright smoke tests use it for layout
checks at 1920x1080 and 1440x900; client-server browser E2E remains QA-012.

## Local development

Run the Worker with `wrangler dev` (port 8787) and the web app with `pnpm --filter @moneygame/web dev`;
Vite proxies `/api` (including the room WebSocket) and `/auth` to the Worker.
