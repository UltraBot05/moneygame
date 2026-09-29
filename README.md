# MONEY·GAME

A free, browser-based, real-time property-trading board game for 3 to 10 players. Players buy
world cities, complete country sets, build up to landmarks, trade, and bankrupt each other until
one player (or team) is left. Every rule runs on the server; browsers only send intents and
render the authoritative state.

## Status

Built and verified: the rules engine (Standard 40-tile and Grand 52-tile boards, auctions,
Holding, cards, debt and bankruptcy, trades, the Collusion Guard fair-play policy, teams), the
real-time room runtime, Google sign-in, the production web UI, profiles and progression, and the
automated QA suites. **Not yet done** and deliberately left to people: the first deployment, the
human balance and alpha playtests, and the public-release IP review. See
[`docs/architecture/RELEASE-GATES.md`](docs/architecture/RELEASE-GATES.md).

## Tech stack and hosting

| Layer | Technology |
| --- | --- |
| Language | TypeScript (strict), one pnpm workspace |
| Rules engine | `packages/game-core`: pure, deterministic TypeScript (no framework, no I/O), seeded randomness only |
| Wire protocol | `packages/shared`: one typed, strictly validated client/server contract (protocol v4) |
| Server | Cloudflare Workers; one SQLite-backed Durable Object (`GameRoom`) per room with WebSocket Hibernation and a single alarm for all deadlines; an `AuthStore` Durable Object for OAuth transactions |
| Database | Cloudflare D1: users, finalized match history, cosmetics |
| Web app | React 19 + Vite 6, custom CSS design tokens from the Claude Design system (no component library) |
| Auth | Google OpenID Connect (code + PKCE, state, nonce); HMAC-signed session cookie; email never stored |
| Hosting | One origin on Cloudflare: the Worker serves the built web app as static assets and handles `/api/*` and `/auth/*` |
| Tests | Vitest (unit, integration, simulation, fuzz), Playwright (smoke on Chromium/Firefox/WebKit, live multi-browser against `wrangler dev`), ESLint, a layer-boundary checker |
| CI | GitHub Actions: lint, typecheck, tests, boundaries, build, e2e |

## Repository layout

```text
packages/game-core   rules engine, boards, cards, integrity policy, projection, simulators
packages/shared      wire protocol and profile contract
app/worker           Worker entry, GameRoom/AuthStore Durable Objects, room runtime, auth, D1 access
app/worker/migrations D1 schema
app/web              React client (landing, lobby, game, profile)
boards/world-tour    canonical board and card data (Standard, Grand)
e2e                  Playwright smoke; e2e/live is the multi-browser suite
docs/architecture    decisions, policies, reviews and evidence
scripts              boundary checker, long simulation and fuzz runners
```

## Running locally

Requirements: Node 22, pnpm 9.

```bash
pnpm install
```

UI only, no server: start the web app and open `http://localhost:5173/dev/preview`, a dev-only
hot-seat preview that runs the real rules in the browser (`?board=grand&players=10`,
`&scene=start|mid|debt|lobby`).

```bash
pnpm --filter @moneygame/web dev
```

Full stack: put `SESSION_SECRET` and `GOOGLE_CLIENT_SECRET` in `app/worker/.dev.vars` (never
committed), apply the local D1 schema, then run the Worker and the web app. Vite proxies `/api`
and `/auth` (including the room WebSocket) to the Worker on port 8787.

```bash
pnpm --filter @moneygame/worker exec wrangler d1 migrations apply moneygame --local
```

```bash
pnpm --filter @moneygame/worker exec wrangler dev
```

### Signing in locally

Google only returns a sign-in to redirect addresses registered on the OAuth client
(`GOOGLE_CLIENT_ID` in `app/worker/wrangler.toml`). For local Google sign-in, add
`http://localhost:5173/auth/callback` (and `http://localhost:8787/auth/callback` if you open the
Worker directly) under Authorized redirect URIs in Google Cloud Console, and put the real
`GOOGLE_CLIENT_SECRET` in `app/worker/.dev.vars`. Otherwise Google shows
`Error 400: redirect_uri_mismatch`.

To play locally without Google, start the Worker with the test sign-in enabled (localhost only,
never in deployment) and open `http://127.0.0.1:8787/auth/test-login?name=YourName`; use other
browser profiles with other names for more players. Build the web app first
(`pnpm --filter @moneygame/web build`), since this Worker serves `app/web/dist`.

```bash
pnpm --filter @moneygame/worker exec wrangler dev --ip 127.0.0.1 --var E2E_TEST_LOGIN:1 --var SESSION_SECRET:local-dev-secret-0123456789
```

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` / `pnpm typecheck:tests` | static checks |
| `pnpm test` | unit tests (rules, runtime, profile, client, soak and fault suites) |
| `pnpm test:integration` | integration tests |
| `pnpm check:boundaries` | enforces that the rules engine and protocol never import app code |
| `pnpm build` | builds the web app and dry-runs the Worker deploy |
| `pnpm test:e2e` | Playwright smoke (set `CROSS_BROWSER=1` for Firefox and WebKit) |
| `pnpm test:e2e:live` | several real browsers play one match against `wrangler dev` (`LIVE_PLAYERS`, `LIVE_FULL=1`) |
| `pnpm simulate:production` | whole bot matches through the production rules, 250 seeds per configuration |
| `pnpm fuzz:production` | seeded fuzzing of the production rules with invariant checks |

## Documentation map

- Game rules and frozen decisions: `ARCHITECTURE.md`, `docs/architecture/ARCHITECTURE-FREEZE-v1.md`
- Fair play: `docs/architecture/INT-001-FAIR-PLAY-POLICY.md`
- Runtime: `docs/architecture/RUNTIME-E1.md`, `RUNTIME-E2.md`
- Web client: `docs/architecture/UI-F.md`
- Grand and economy evidence: `docs/architecture/GRAND-G.md`, `PRODUCTION-SIMULATION.json`
- Profiles and progression: `docs/architecture/META-H.md`
- Reviews: `docs/architecture/QA-007-ACCESSIBILITY-REVIEW.md`, `QA-009-SECURITY-REVIEW.md`
- Deploy, rollback and human gates: `docs/architecture/RELEASE-GATES.md`
- Task status: `TASKS.md`; working rules: `AGENTS.md`, `PROJECT_RULES.md`
