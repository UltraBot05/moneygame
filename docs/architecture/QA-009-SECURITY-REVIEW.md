# QA-009 auth and security review

Date: 2026-09-29. Scope: Worker routes, Google OIDC sign-in, sessions, room sockets, the room
runtime, profile API, and the web client. Method: code review against the trust boundaries in
RUNTIME-E1 plus the automated tampering tests listed below. Result: **no blocker**; the fixes
below were made in this pass and the residual risks are recorded for the release owner.

## Trust boundaries

| Boundary | Control |
| --- | --- |
| Browser → Worker (HTTP) | Session is an HMAC-signed, `HttpOnly; Secure; SameSite=Lax` cookie (7 days). Every state-changing route (`POST /api/rooms`, `/api/profile/*`, `/auth/logout`) and the room socket also require a same-origin `Origin` header. |
| Google → Worker (OIDC) | Authorization code + PKCE, `state` bound to a binding cookie (hashed), nonce, ID-token signature/audience/expiry checks against Google JWKS. Google `sub` is only a lookup key; the internal id is a random UUID. Email is never requested or stored. |
| Worker → GameRoom DO | Identity, display name and cosmetic ring travel in `x-mg-*` headers that the Worker **always overwrites** from the verified session and D1 (a client-supplied value can never pass through). DOs are not publicly routable. |
| Client frames → room | `parseClientMessage`: 16 KiB cap, strict keys, no identity/role/authority fields, then game-core's strict command parser. System commands (timeouts, clock resume) are refused from clients. Spectators cannot act. 20 commands and 5 chats per 10 s per player. |
| Room → client | Per-viewer projection: deck order and the Collusion Guard ledger never leave the room; fair-play warnings reach only the pair. |
| Profile API | Reads are server-derived; purchases and equips are validated against the catalog and ownership; 1 KiB strict JSON bodies. |

## Fixes made in this pass

1. **Security headers** for the site (`app/web/public/_headers`): CSP (`default-src 'self'`,
   no inline scripts, fonts from Google Fonts only, `frame-ancestors 'none'`, `base-uri 'none'`,
   `form-action 'self'`), `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and a
   restrictive permissions policy. Worker JSON responses now send `nosniff` and `no-store`.
2. **Logout** now requires a same-origin `Origin` like the other POST routes.
3. **Cosmetic ring** reaching rooms is validated against the catalog inside the room as well as
   in the Worker (test: a forged header value is dropped).
4. **E2E test sign-in** (`/auth/test-login`) is double-gated: it exists only when the
   `E2E_TEST_LOGIN` var is `1` *and* the request host is `localhost`/`127.0.0.1`/`[::1]`.
   `wrangler.toml` never sets the var, and a deployed zone never serves a localhost host.
   Release check: `wrangler deploy` output must not list `E2E_TEST_LOGIN`.

## Tampering coverage (automated)

- Wire: identity/role/authority fields, unknown room actions, extra settings keys, non-object and
  oversized frames are all refused (`packages/shared/src/protocol.test.ts`).
- Room: non-host configure/start/pause/rematch, non-member and spectator actions, client-sent
  system commands, stale versions and foreign game ids, rate limits
  (`room-runtime.test.ts`, `room-lifecycle.test.ts`).
- Rules: seeded fuzzing sends random, stale, duplicate and malformed commands from random
  actors; every refusal leaves state unchanged (`production-fuzz.ts`).
- Integrity: retried acceptances cannot double-count incidents; warnings stay private
  (`collusion-guard.test.ts`).
- Profile: unknown items, wrong kinds, equipping unowned items, overspending, forged rings
  (`profile.test.ts`).
- Auth: OIDC state/binding/nonce/signature cases (`auth-flow.test.ts`, `oidc.test.ts`,
  `session.test.ts`).

## Residual risks (accepted for v1, owner to confirm)

| Risk | Severity | Note |
| --- | --- | --- |
| Sessions cannot be revoked server-side before expiry (logout clears the cookie only). | Low | A stolen cookie works until its 7-day expiry. Mitigation later: a session version per user in D1. |
| Room-code probing: an authenticated user can try codes (6 characters, 32^6 ≈ 1.07e9). | Low | Each miss costs a Durable Object wake. Recommend a Cloudflare rate-limiting rule on `/api/rooms/*/ws` at deploy. |
| Anyone holding a room code can join while it is in the lobby. | By design | Codes are invites. The host sees every member before starting. |
| `style-src 'unsafe-inline'` in the CSP. | Low | Needed for React style attributes; scripts stay `'self'` only. |
| Display names come from Google profiles. | Low | Sanitized (printable, 32 chars) and rendered as text by React; never HTML. |

Human sign-off on this review and on the deployed headers is part of QA-014.
