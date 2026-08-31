# ADR-001 — Cloudflare room runtime

**Status:** Proposed / freeze after SPIKE-001  
**Date:** 2026-08-31

## Context
Need authoritative realtime coordination for 3–10 players at ₹0 normal friend-group scale.

## Decision
Use:
```text
Cloudflare Worker
→ one SQLite-backed Durable Object per room/game
→ Hibernation WebSocket API
```

The DO owns live room authority. Finalized profile/game data goes to D1.

## Hibernation
Room must become hibernation-eligible during normal idle.

No gameplay:
- setTimeout
- setInterval
- JS keep-warm loop
- standard DO WebSocket API

Use persisted deadlines + Alarm API.

## Timers
Store all deadlines; schedule the one DO alarm to the earliest. Alarm resolves every due deadline, persists, reschedules, and is idempotent.

## Resource acceptance
Representative:
```text
10 players
Grand
~90 minutes
normal chat/trade/auction/reconnect
```

Desired <=10% daily quota. Hard fail >20%.

Current hard thresholds:
```text
DO requests >20,000
DO duration >2,600 GB-s
SQL reads >1,000,000
SQL writes >20,000
```

## Rejected v1 alternatives
Paid always-on VM, Redis, separate Socket.IO service, microservices.

## Revisit
Spike exceeds threshold; hibernation/timers conflict; provider semantics change; real concurrency grows materially.
