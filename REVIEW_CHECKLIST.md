# Review Checklist
## For humans, Codex Sol/Terra and ChatGPT review sessions

# 1. Task/scope

- What task ID is this?
- What are exact acceptance criteria?
- Did unrelated code change?
- New dependency?
- Architecture change?
- Diff still reasonably understandable?

# 2. Game rule

For each mutation ask:
- who may issue it?
- what phase permits it?
- what state changes?
- duplicate request?
- stale gameVersion?
- reconnect?
- debt/auction interaction?
- eliminated actor?
- seeded reproduction?

Core invariants:
```text
one owner/property
one active turn owner
integer money
valid tiles
legal buildings
held card not also in deck
monotonic gameVersion
no eliminated normal turn
```

# 3. Persistence

- Where is commit?
- Is actionId committed with/equivalent to state?
- Crash after commit before response: retry safe?
- Storage failure: does client see success?
- Wake: mutable state reconstructed?
- Any important state only in memory?

# 4. Realtime/concurrency

Try:
```text
simultaneous bids
duplicate trade accept
stale buy
host disconnect
current-player disconnect
second-tab takeover
old-socket late command
hibernate/wake
alarm retry
```

"JavaScript is single-threaded" is not sufficient reasoning.

# 5. Timers

- absolute server deadline?
- any gameplay setTimeout/setInterval in DO? blocker unless approved
- one alarm set to earliest pending deadline?
- alarm idempotent?
- reconnect extension bounded once?
- client timer visual only?

# 6. Auth/session

- Google `sub` stable identity?
- HttpOnly/Secure app session?
- Google tokens absent from JS storage?
- opaque one-time OAuth state?
- replay rejected?
- room return context server-side?
- seat from authenticated userId?
- IP not identity?

# 7. Rematch/board

- new gameId?
- right board/version?
- no stale ownership/buildings/mortgages?
- no old trades/auction/debt/deadlines?
- fresh decks?
- Standard -> Grand -> Standard safe?

# 8. Resource

Representative 10-player Grand ~90-minute game.

Desired:
```text
<=10% of each relevant daily free quota
```

Hard block:
```text
DO requests      >20,000
DO duration      >2,600 GB-s
DO SQL reads     >1,000,000
DO SQL writes    >20,000
```

10–20% requires optimization/retest before freeze.

# 9. UI

Board:
- ownership readable without color alone
- current turn obvious
- 10-player overlap works
- long names/large values fit
- Standard/Grand readable

Interaction:
- pending feedback immediate
- authoritative animation after server commit
- disabled reason clear
- reconnect understandable

Anti-slop:
- not generic SaaS/admin
- no rounded-card overload
- no random glow/gradient
- no inconsistent spacing
- no library-default final style
- no emoji final icons
- no fake content
- no excessive animation

Ask: **does this feel designed for the game, or assembled from a component demo?**

# 10. Accessibility

- keyboard path
- visible focus
- labels
- no color-only ownership
- reduced motion
- 200% zoom
- mobile
- no required hover-only data

# 11. Test quality

For each major test ask: **what bug would make this test fail?**

Prefer behavior, invariant, fuzz, failure injection, convergence and duplicate-command tests.

Be skeptical of snapshot-only/mock-call-only/overmocked/skipped tests.

# 12. Architecture falsification evidence

Before freeze:
- [ ] DO hibernation deployed 10-client test
- [ ] resource target or at least below 20% hard threshold
- [ ] persistence fault injection
- [ ] idempotent retry
- [ ] OAuth-state attacks
- [ ] 89s reconnect
- [ ] >90s expiry
- [ ] epoch takeover
- [ ] bounded current-turn extension
- [ ] cross-board rematch torture
- [ ] pathological dual-board renderer
- [ ] seeded fuzz harness
- [ ] Standard 3/4/5/6 economy
- [ ] Grand 6/7/8/9/10 economy
- [ ] Grand pacing A/B/C simulation + humans

# 13. Verdict

```markdown
## Review — TASK-ID

**Verdict:** APPROVE / CHANGES_REQUESTED / ARCHITECTURE_BLOCKED

### Blockers
- B1 ...

### Major
- M1 ...

### Minor
- N1 ...

### Evidence
- inspected:
- ran:
- seeds:
- metrics:
- screenshots:

### Invariants
- server authority:
- idempotency:
- persistence:
- reconnect:
- board/rematch:
- timers:

### Required fixes
1. ...

### Follow-ups
- genuinely separate scope only
```
