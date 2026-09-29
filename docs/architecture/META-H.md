# META-H: profiles and progression (Section H)

Status: implemented 2026-09-29 with the recommended options below (no separate canon existed).

## Source of truth

Progression is a **read model over finalized history**. `finished_game_players` rows are written
only by room finalization (RT-012) and are unique by `(game_id, user_id)`, so a retried or
duplicated delivery can never double-award. XP, level, coins earned and achievements are derived
on every read (`app/worker/src/profile.ts`, `deriveProgress`); nothing about them is stored or
client-authored. There is no sandbox or test path into history: the dev preview never finalizes.

The only stored progression is cosmetic ownership (`migrations/0003_meta.sql`):
`cosmetic_purchases` (one row per owned item) and `cosmetic_equipped` (one item per kind).

## Rules

| Item | Rule |
| --- | --- |
| Counted match | every finalized match, except one where the Collusion Guard removed this player (`REMOVED` elimination fact): that match earns nothing |
| XP per match | 100 + 20 per player finishing below you + 100 for a win |
| Level | level L starts at 250 x (L-1)^2 XP (250, 1000, 2250, ...) |
| Coins per match | 10 + 5 per player finishing below you + 20 for a win |
| Coin balance | coins earned minus the price of every owned cosmetic |
| Achievements | first match, first win, five wins, 25 matches, a Grand match, a ten-player match, a Teams win |
| Cosmetics | token rings and profile titles (`COSMETICS` in `packages/shared/src/profile.ts`); looks only, no gameplay effect |

A purchase's balance check and insert are one SQL statement, so concurrent purchases cannot
overspend; buying an owned item again is a no-op. Equipping requires ownership.

## API

- `GET /api/profile`: the signed-in user's `ProfileView` (level, XP, coins, stats, achievements,
  last 20 matches, inventory, equipped items).
- `POST /api/profile/purchase` `{ itemId }` and `POST /api/profile/equip` `{ kind, itemId | null }`:
  same-origin only, strict 1 KiB JSON bodies; `409` with `NOT_ENOUGH_COINS`, `NOT_OWNED` or
  `UNKNOWN_ITEM` on refusal.

## Rooms

The Worker reads the user's equipped ring from D1 when opening a room socket and passes it to
the room in a trusted header (always overwritten, never taken from the client). The room checks
it against the catalog and shows it on `MemberView.ring` (protocol v4), so other players see it
around that player's token. Titles show on the profile only.

## UI

`/me` (META-007) shows loading, error-with-retry and empty-history states; buy and equip buttons
only ask the server, and the page re-renders from the server's answer.
