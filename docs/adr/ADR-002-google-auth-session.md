# ADR-002 — Google authentication and application session

**Status:** Proposed / freeze after SPIKE-003/004  
**Date:** 2026-08-31

## Context
Stable identity is needed for reconnect, profiles, progression/history and abuse friction.

## Decision
v1 requires Google OpenID Connect for player seats.

Google `sub` maps to internal `userId`.

Issue first-party app session:
- Secure
- HttpOnly
- suitable SameSite

Google tokens are not game protocol credentials and do not live in JS-readable storage.

## Invite-first flow
Invite enters room context first.

If no app session:
1. create opaque random one-time OAuth state;
2. store server-side context `state -> return room/path + expiry + browser/session binding`;
3. redirect Google;
4. callback validates/consumes state;
5. create app session;
6. return straight to room.

`state` is not the room code.

Returning app-session users skip Google.

## Security
Validate issuer/audience/expiry; use `sub`; reject state replay; no auth secrets in logs.

Google raises casual abuse cost but is not the only anti-bot measure.

## Reconnect
Application login outlives the 90-second room reconnect lease.

## Revisit
Google-only causes demonstrated unacceptable friction; guest need becomes real; provider flow/security review changes.
