# ADR-003 — Authoritative game-state persistence

**Status:** Proposed / freeze after SPIKE-002/005  
**Date:** 2026-08-31

## Context
Economic realtime state cannot tolerate duplicate commands, half trades, lost purchases or stale rematches.

## Decision
SQLite-backed DO snapshot is authoritative durable commit.

```text
auth
→ epoch
→ schema
→ actionId
→ phase/version
→ pure game-core transition
→ SQLite transaction
→ broadcast
```

Persist:
- gameId
- gameVersion
- canonical GameState
- idempotency metadata
- deadline schedule

Write failure means command did not commit.

Retry after unknown response uses same actionId.

## Failure semantics
Before commit crash -> old state survives.  
After commit/before response -> new state survives and retry is idempotent.

## Rematch
New match = new `gameId` + new `GameState`. Never reset/reuse ended mutable match state.

## Tests
Failure injection and cross-board rematch torture are mandatory.

## Revisit
Write volume breaks resource threshold; snapshot size becomes problematic; failure injection disproves atomicity assumption.
