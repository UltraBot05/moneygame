# Release gates (QA-006, QA-010, QA-014, QA-015, GRAND-005)

These gates need a human, a Cloudflare account with write access, or a legal decision. They are
prepared here and **not** claimed as passed. Everything automatable already runs in CI.

## Billing safety (owner requirement: the game must never bill)

The deployment uses only Cloudflare's **Workers Free** plan, which has no meter: when a daily limit
is reached, further requests fail until the next day (UTC); nothing is charged. Keep it that way:

- Do **not** subscribe the account to Workers Paid or add a payment method for this project.
- Use only free-plan features: Workers with static assets, **SQLite-backed** Durable Objects (every
  migration uses `new_sqlite_classes`; key-value Durable Objects need a paid plan), and D1.
- Do not add R2, Queues, Logpush, paid Workers Logs, Analytics Engine, Browser Rendering, Workers AI,
  Hyperdrive or Smart Placement: each needs a paid plan or a payment method.
- Free-plan limits at the time of writing (check Cloudflare's pricing pages): about 100,000 Worker
  requests per day (static assets are free and unmetered), Durable Object requests and duration per
  day, and D1 at 5 GB storage, 5 million rows read and 100,000 rows written per day. Abuse or a big
  spike can therefore cause a temporary outage, never a bill.
- Google sign-in uses a free OAuth client; no Google Cloud billing account or paid API is needed.
- Domains: only free ones (`workers.dev`, or a free `eu.org` name pointed at Cloudflare's free DNS).

## QA-014 deploy and rollback

Prerequisite: `npx wrangler login` with an account that can create D1 databases and deploy
Workers (the token used during development lacked D1 and Workers write scopes).

1. Create the database and record its id:
   ```bash
   cd app/worker && npx wrangler d1 create moneygame
   ```
   Put the printed `database_id` into `app/worker/wrangler.toml` (replacing the placeholder).
   Done on 2026-10-06: `moneygame`, region APAC, id `19e66656-9be2-4fc0-ae34-50bff45efce2`; the
   Worker is named `landmark`.
2. Apply migrations to the remote database:
   ```bash
   npx wrangler d1 migrations apply moneygame --remote
   ```
3. Set secrets (never commit them):
   ```bash
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   `SESSION_SECRET`: at least 32 random bytes. Do **not** set `E2E_TEST_LOGIN` anywhere.
4. In Google Cloud Console, add `https://<deployed-origin>/auth/callback` as an authorized
   redirect URI for the OAuth client in `wrangler.toml` (`GOOGLE_CLIENT_ID`).
5. Build and deploy from the repo root:
   ```bash
   pnpm build && pnpm --filter @moneygame/worker exec wrangler deploy
   ```
   Check the printed bindings: `GAME_ROOM`, `AUTH_STORE`, `DB`, `ASSETS`, `GOOGLE_CLIENT_ID`;
   no `E2E_TEST_LOGIN`.
6. Smoke on the deployed origin:
   - `GET /api/health` returns `{"ok":true,"protocolVersion":4}`.
   - `GET /` carries the CSP and `X-Frame-Options: DENY` headers.
   - `GET /auth/test-login` does **not** sign in (it falls through to the app).
   - Sign in with Google, create a room, join from a second account, start, roll, chat, pause and
     resume, finish a short match (or bankrupt out), check `/me` history and XP.
7. Rollback: `npx wrangler rollback` restores the previous Worker version. D1 can be restored
   with `npx wrangler d1 time-travel restore moneygame --timestamp=<before-deploy>`. Durable
   Object storage is per room and is not rolled back; rooms from a newer protocol simply reload
   under the old code, and new rooms are unaffected. Record the result of a rehearsed rollback.

## QA-006 deployed quota rerun

After deploy, play one 4-player and one 10-player match and read Workers analytics: Durable
Object requests and duration per match, D1 rows read and written per finalized match, Worker
requests. Compare against the plan's included limits and project a day of expected play.
Target from TASKS: at most 10% of quota for the expected load is desired; above 20% fails.

## QA-010 public-release IP review (legal decision)

Checklist for the reviewer:
- Name and branding: "LANDMARK" (renamed from the working title MONEY·GAME on 2026-10-06), original two-tone wordmark in Archivo; no third-party marks.
- Board vocabulary: START, HOLDING, VACATION, GO TO HOLDING, Surprise, Treasure, Customs;
  real city and transit hub names are used as places only.
- Card text is original (`boards/world-tour/*.cards.json`).
- Visual design is original (Claude Design system); no copied board art, tokens or money art.
- Fonts: Archivo and Space Mono are SIL Open Font License, served by Google Fonts.
- Game mechanics are generic property-trading mechanics; the decision on trade-dress distance
  belongs to the human/legal reviewer. Record the decision here with a date and name.

## QA-015 final balance gate (human)

Automated evidence with the final mechanics: `GRAND-G.md` (production-path simulation, 250
seeds per configuration, 9/9 inside the SPIKE-008 bands) and `PRODUCTION-FUZZ.json`. Open
caveats for the human decision:
- Snowball: the round-10 net-worth leader wins 36 to 44% of Standard matches and 53 to 60% of
  Grand matches (bots). Humans trade and bid differently.
- Stalls: 1 to 11% of bot matches reach the round cap without a winner; watch for long human
  matches, especially Grand 6.
- Card values are the approved v1 decks; the sign-off covers them.
- No trading, no ending: a live 10-player Standard match driven by bots that bought and built
  but never traded reached turn 2018 (about 200 rounds) with nobody bankrupt, because almost no
  one completes a set without trades. The rules have no length cap (freeze: last standing only),
  so a table that refuses to trade can run indefinitely. Decide whether that is acceptable or
  whether a later module (for example a round limit with net-worth tiebreak) is wanted.
  **Owner decision (2026-09-29): accepted.** Players resign when they are done (new `RESIGN`);
  a timed game mode may come later (POST-009).
Record the human decision (approve, or the specific retune to try) here.

## GRAND-005 human alpha

Protocol in `GRAND-G.md`: at least three Grand sessions (6, 8 and 10 players) on the deployed
build, recording match length, first bankruptcy, stalls, and free-text feedback.
