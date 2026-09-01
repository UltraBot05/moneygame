# Spike Result — SPIKE-003 (Google OIDC invite-first)

**Date:** 2026-09-02
**Builder:** Claude Code
**Reviewer:** _pending independent review_
**Commit:** _pending — one logical commit on `task/spike-003` (see Builder Handoff)_
**Deployment:** `moneygame-worker` version `d104819b-3abc-4e2b-bfb5-416c5dfa1279` — `https://moneygame-worker.moneygame-worker.workers.dev` (Workers Free, SQLite DOs, workers.dev; no R2/paid)

## Hypothesis

A browser entering `/r/:roomCode` can authenticate through Google OpenID
Connect without losing room context, without exposing Google token material to
JS-readable storage, and without allowing OAuth `state` replay, substitution,
open redirects, or identity spoofing. After success the app issues its **own**
first-party session, and a later visit with a valid app session skips Google.

## Falsifier

Any of: `state` is/embeds the room code or return URL; invite context lost;
state replay/expiry/missing/wrong-browser succeeds; concurrent double-consume
both succeed; open redirect injectable; Google identity trusted without ID-token
validation (sig/iss/aud/exp/nonce); email used as identity instead of `sub`;
Google tokens used as the game session or placed in JS-readable storage; session
cookie JS-readable; valid session still forced through Google; tests that cannot
fail on the real security condition.

## Setup

- Worker modules (server-authoritative; `packages/game-core` untouched):
  - `app/worker/src/oidc.ts` — PKCE S256, `verifyIdToken` (RS256 via WebCrypto),
    Google discovery/JWKS/token-exchange provider, `buildAuthUrl`.
  - `app/worker/src/session.ts` — HMAC-SHA256 first-party session + hardened
    cookie serialize/parse.
  - `app/worker/src/auth-store.ts` — `TransactionStore` over a `SqlExec` seam;
    atomic one-time consume + expiry + binding.
  - `app/worker/src/auth-flow.ts` — `startAuth` / `handleCallback` + room-code
    sanitizer.
  - `app/worker/src/auth-do.ts` — SQLite Durable Object wrapping the store.
  - `app/worker/src/index.ts` — routes `/r/:roomCode`, `/auth/callback`.
- Tests: `oidc.test.ts`, `session.test.ts`, `auth-store.test.ts`,
  `auth-flow.test.ts` (51 assertions total across the suite), backed by a real
  RS256 signer and real in-memory SQLite (`node:sqlite`) — see
  `oidc.testkit.ts`.
- No new dependency: JWT verification uses the platform `crypto.subtle`
  (RSASSA-PKCS1-v1_5 / SHA-256). Only the JWT/JWKS envelope parse + OIDC claim
  checks are our code; the signature primitive is WebCrypto.
- Secrets: `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` are Cloudflare Worker secrets
  (`wrangler secret put`) — the source used for the real-provider test; no
  `.dev.vars` file was created. `GOOGLE_CLIENT_ID` is a public `[vars]` value.
  Nothing secret is committed (`.dev.vars` is gitignored if ever used locally).

## Procedure

1. `pnpm test` (51 tests) — flow + primitives against real crypto + real SQLite.
2. `pnpm typecheck`, `pnpm lint`, `pnpm build` (worker `--dry-run`).
3. Verify no `console.*` token logging in auth modules; no secret files tracked.
4. Attempt real-provider proof — check for Google OAuth configuration.

## Observations

| Property | Method | Observed | Result |
|---|---|---|---:|
| Invite `/r/:roomCode` survives auth | automated flow | callback 302 → `/r/ABCD` (server-stored, sanitized) | PASS |
| `state` opaque and ≠ room code | automated | 43-char random b64url; `state !== "abcd"/"ABCD"` | PASS |
| One-time consume | automated (real SQL) | 1st claim ok, replay → `ALREADY_CONSUMED` | PASS |
| Concurrent double-consume | automated (real SQL) | exactly 1 of 2 succeeds | PASS |
| Expired state rejected | automated (real SQL) | `EXPIRED` | PASS |
| Missing / unknown state rejected | automated | 400 / `NOT_FOUND` | PASS |
| Wrong browser binding rejected | automated | 401 `BINDING_MISMATCH`, row not burned | PASS |
| Unsafe room / open redirect rejected | automated | `../evil`, `https://evil.com` → 400, no Google call | PASS |
| PKCE verifier ↔ challenge | automated | `S256(sent verifier) === auth-url code_challenge` | PASS |
| ID token: bad sig / aud / multi-aud / azp / iss / exp / nonce / no-sub / kid / alg | automated (real RS256) | each rejected with distinct `OidcError` code | PASS |
| Identity from `sub`, not email | automated | `userId = google:${sub}`; email never read | PASS |
| Valid app session skips Google | automated | 200, no new discovery call | PASS |
| Session tamper / wrong-secret / expiry rejected | automated | `BAD_SIGNATURE` / `EXPIRED` | PASS |
| Cookie HttpOnly+Secure+SameSite=Lax+Path=/ , no Domain | automated | asserted on serialized cookie | PASS |
| No Google token in response body/cookies | automated | body empty; only `mg_session` (HttpOnly) + cleared `mg_txn`; id_token absent | PASS |

Verification: `pnpm test` 51/51 PASS · `pnpm typecheck` PASS · `pnpm lint` clean
· `pnpm build` PASS (bindings: `SPIKE_ROOM`, `AUTH_STORE`, `GOOGLE_CLIENT_ID`).

## Security negative cases

Every negative below is proven by a test that returns non-success on the real
condition (not a stub returning `true`):

- OAuth state: missing → 400; unknown → `NOT_FOUND` 400; expired → `EXPIRED`
  400; replayed → `ALREADY_CONSUMED` 400; wrong browser binding → 401; concurrent
  double-consume → one winner.
- Return context: `../evil`, `https://evil.com`, whitespace, too short/long all
  rejected before any transaction is created; callback only ever redirects to
  `/r/<server-stored sanitized code>` (relative), so no open redirect.
- ID token: tampered payload → `BAD_SIGNATURE`; wrong `aud` → `WRONG_AUDIENCE`;
  wrong `iss` → `WRONG_ISSUER`; expired → `TOKEN_EXPIRED`; wrong `nonce` →
  `WRONG_NONCE`; empty `sub` → `MISSING_SUB`; unknown `kid` → `UNKNOWN_KID`;
  non-RS256 → `UNSUPPORTED_ALG`.
- Session: wrong-secret / tampered payload → `BAD_SIGNATURE`; past expiry →
  `EXPIRED`.
- Token exposure: callback response body is empty; the only `Set-Cookie`s are
  the HttpOnly app session and the cleared binding cookie; the Google id_token
  value appears in neither.

## Provider evidence

Google OAuth is now configured (Web-application client; `GOOGLE_CLIENT_ID` var;
`GOOGLE_CLIENT_SECRET` + `SESSION_SECRET` as Worker secrets; scope `openid
email`; External/Testing with a test user). Evidence classes:

- **Automated proof (real crypto + real SQLite):** the entire Observations and
  Security-negative-cases tables. ID-token checks run against a genuine RS256
  signature + JWKS; store checks run against real SQL with the exact production
  statements.
- **Stub-provider proof:** the end-to-end flow tests stub only Google's network
  boundary (`config`/`exchange`); all app validation (state consume, binding,
  PKCE passthrough, ID-token verification, session issuance, redirect, cookie
  flags, no-leak) is the real code path.
- **REAL Google-provider proof (deployed `d104819b`), verified this run:**
  1. Unauthenticated `GET /r/SPIKE003TEST` → `302` to the live
     `https://accounts.google.com/o/oauth2/v2/auth` (endpoint obtained from
     Google's live discovery document fetched at the edge).
  2. Authorization request uses **Authorization Code + PKCE S256**
     (`response_type=code`, `code_challenge` present, `code_challenge_method=S256`).
  3. `state` is opaque (43-char random) and is **not** the room code; the room
     code does **not** appear anywhere in the authorization URL.
  4. `scope=openid email`; `redirect_uri` exactly
     `https://moneygame-worker.moneygame-worker.workers.dev/auth/callback`;
     `nonce` present.
  5. **Google accepts the client**: following the authorization URL returns
     `302` into Google's sign-in flow (no `redirect_uri_mismatch` /
     `invalid_client` error), confirming client id + redirect URI + scope are
     valid at the provider.
  6. Real deployed callback negatives: unknown `state` (+binding cookie) →
     `400`; missing binding cookie → `401`; missing `state` → `400`; missing
     `code` → `400`; unsafe room `/r/aa` → `400`; health `/` → `200`.
  7. Real deployed pre-auth cookie: `mg_txn=…; HttpOnly; Secure; SameSite=Lax;
     Path=/; Max-Age=600`.
- **Documentation-inferred:** Google `iss` values and claim semantics; the code
  fetches the live discovery document at runtime rather than hard-coding it
  (item 1 above confirms the fetch succeeds against the real provider).

### REAL PROVIDER — human-observed (test user, real browser, 2026-09-02)

The interactive post-consent half was completed by the human test user against
the deployed worker and Cloudflare-stored secrets (no `.dev.vars` file was
created; deployed Worker secrets are the source used). Trusted human-observed
evidence:

- Real Google sign-in **succeeded**; a Google-minted ID token was accepted by
  the deployed `verifyIdToken` (sig/iss/aud/exp/nonce/sub).
- Callback returned to **`/r/SPIKE003TEST`** after consent (original room
  context preserved through the full round-trip).
- Second visit to the same room **skipped Google** (valid `mg_session` → served
  directly, no re-auth redirect).
- `mg_session` cookie observed in the browser: **HttpOnly ✓, Secure ✓,
  SameSite=Lax ✓, Path=/ ✓**.
- **No Google tokens** in `localStorage` or `sessionStorage`.
- Final browser URL contained **no** `code` / `state` / `id_token` /
  `access_token` (or similar) parameters.

Identity is the Google `sub` (never email), as verified in both automated tests
and the deployed authorization request.

## Reproduction

```text
pnpm test        # 51 tests: oidc / session / auth-store / auth-flow
pnpm typecheck
pnpm lint
pnpm build
```

## Limitations

- App session is a stateless signed token — no server-side revocation list
  (acceptable for the spike; not a frozen production decision).
- Single global `AuthStore` DO; no expired-transaction GC (rows are inert after
  expiry). Both noted as later scaling/cleanup work, not required here.
- The `/r/:roomCode` success page is a spike placeholder, not real room UI.
- `SameSite=Lax` is required (not Strict) so cookies survive Google's top-level
  redirect back; documented as intentional.
- The `aud` single-client + `azp` hardening was added after the review and is
  proven by automated real-RS256 tests; deployed `d104819b` predates it. A
  redeploy is a trivial follow-up and does not affect the human-observed login,
  which used a single-audience token that passes the stricter rule.

## Decision

`PASS` — every acceptance criterion is met:

- Automated: 51/51 tests on real RS256 + real SQLite (state one-time consume,
  concurrent double-consume single-winner, expiry, browser binding, open-redirect
  rejection, PKCE, ID-token sig/iss/aud(single-only)/azp/exp/nonce/sub, `sub`-not-email identity,
  session tamper/expiry, hardened cookie, no token leakage).
- Real deployed provider: Google accepts the client; authorization request is
  Auth Code + PKCE S256 with opaque `state` ≠ room, `nonce`, exact redirect URI,
  `openid email`; deployed callback negatives (unknown/missing state, missing
  binding, missing code, unsafe room) reject correctly; `mg_txn` cookie hardened.
- Real human-observed provider: real Google login → return to `/r/SPIKE003TEST`
  → session-skip on revisit; `mg_session` HttpOnly+Secure+SameSite=Lax+Path=/;
  no Google tokens in web storage or the final URL.

No falsifier condition was hit.

## Architecture impact

- None. Implementation matches ADR-002 and ARCHITECTURE.md §11 (opaque one-time
  state ≠ room code; server-side state→context map; `sub`→internal userId;
  first-party Secure+HttpOnly session; no Google token in JS-readable storage).
  No ADR amendment required.
