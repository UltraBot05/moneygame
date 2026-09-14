# Architecture audit reconciliation — ARCH-001 through ARCH-004

**Date:** 2026-09-13
**Builder:** Claude Code (Opus)
**Task IDs:** ARCH-001, ARCH-002, ARCH-003, ARCH-004
**Status:** READY_FOR_REVIEW

This document closes the A/B audit gaps identified after FREEZE-001. It reconciles spike evidence with the frozen baseline, maps production ownership, defines the fuzz/economy production transition, and disposes of quota evidence. Historical spike reports are preserved unchanged.

---

## ARCH-001 — Spike/freeze evidence reconciliation

### Current freeze status

FREEZE-001 was independently reviewed, corrected, approved, and merged as PR #8 (commit `4b9ba9d`). The implementation baseline in `docs/architecture/ARCHITECTURE-FREEZE-v1.md` is the governing frozen document. Its status line has been updated from "independent task review pending" to reflect the completed review.

CORE-001 through CORE-009 have been implemented on top of the frozen baseline (PR #9, PR #10).

### Spike evidence status

Historical spike result files remain unchanged. The "pending independent review" header text in SPIKE-001 through SPIKE-005 is historical — it records the state at builder handoff time, not the current review status.

| Spike | Builder Decision | Independent Review | Current Status |
|---|---|---|---|
| SPIKE-001 | PASS | Accepted through FREEZE-001 review gate | Evidence frozen; follow-up (fresh GB-s) deferred to QA-006 |
| SPIKE-002 | PASS | Accepted through FREEZE-001 review gate | Evidence frozen |
| SPIKE-003 | PASS | Accepted through FREEZE-001 review gate | Evidence frozen; human-observed real provider evidence present |
| SPIKE-004 | PASS | Accepted through FREEZE-001 review gate | Evidence frozen |
| SPIKE-005 | PASS | Accepted through FREEZE-001 review gate | Evidence frozen |
| SPIKE-006 | APPROVE — DONE | Independent review 2026-09-04 (Claude Code) | Evidence frozen |
| SPIKE-007 | APPROVE — DONE | Independent review 2026-09-04 (Claude Code) | Evidence frozen; harness active in CI |
| SPIKE-008 | MODIFY | Independent review 2026-09-04 (Claude Code) APPROVE | Evidence frozen; MODIFY outcome accepted; ECON-001 resolved pacing |
| ECON-001 | READY_FOR_REVIEW | Independent review 2026-09-08 (Claude Code) APPROVE | Evidence frozen; provisional launch candidates |
| FREEZE-001 | READY_FOR_REVIEW | Reviewed, approved, merged (PR #8) | DONE — implementation baseline |

### Builder handoff text reconciliation

The FREEZE-001 builder handoff in TASKS.md reads "independent FREEZE-001 review is pending." This was accurate at handoff time (before the review). The review subsequently completed and FREEZE-001 was marked DONE. The handoff text is preserved as historical evidence; the actual status is DONE.

Similarly, SPIKE-001 through SPIKE-005 result files contain "pending independent review" in their headers. These spikes were accepted as evidence through the FREEZE-001 review process rather than receiving individual independent reviews. Their evidence is frozen and valid. The header text is historical and is not rewritten.

### Deferred production requirements with owners

| Deferred Item | Source | Future Owner | Gate |
|---|---|---|---|
| Final Surprise deck content | FREEZE-001 §1 | RULE-011 | Card content finalized; economy rerun (QA-015) |
| Final Treasure Chest content | FREEZE-001 §1 | RULE-012 | Card content finalized; economy rerun (QA-015) |
| Full Holding choices/attempts/held-card | FREEZE-001 §1 | RULE-013 | Replaces economy bot approximation; economy rerun |
| Human validation: two-dev snowball | FREEZE-001 §1 | QA-015 + human gate | Production rules + human playtesting |
| Grand human playtesting | FREEZE-001 §1 | GRAND-005 | Playable Grand with production rules |
| Collusion Guard rules | FREEZE-001 §1 | INT-001 (policy) → INT-002 (engine) | Design ambiguities resolved |
| Production Turbo module | FREEZE-001 §1 | GRAND-006 (optional, not v1-required) | Evidence beats frozen A/core |
| Production Transit module | FREEZE-001 §1 | GRAND-007 (optional, not v1-required) | Evidence beats frozen A/core |
| Grand-10 $2500 pacing risk | FREEZE-001 §1 non-blocking | QA-015 | Human gate; may amend economy |
| Fresh deployed GB-s measurement | SPIKE-001 follow-up | QA-006 | Deployed quota rerun during release hardening |
| Production auth session revocation | SPIKE-003 limitation | AUTH-001 | Stateless token → production decision |
| Expired-transaction GC | SPIKE-003 limitation | RT-016 | Retention/cleanup |
| Applied-actions pruning | SPIKE-002 limitation | RT-016 | Retention/cleanup |
| Grand structural corner semantics | FREEZE-001 §2 | GRAND-001 | Deferred; structural positions frozen |
| Card placeholder values | ECON-001 limitation | RULE-011/012 | Not production content |
| IP-based abuse controls | ARCHITECTURE §12 | RT-015 | Boundary abuse controls |

### Limitations resolved by their own spikes (no longer open)

| Item | Resolution |
|---|---|
| SPIKE-001 earliest-deadline O(history) scan | Fixed in SPIKE-001 itself (indexed query, stress-tested) |
| SPIKE-002 non-game-namespaced persistence | Fixed in SPIKE-005 (game_id namespace) |
| SPIKE-004 B1 expired reconnect fail-open | Fixed in SPIKE-004 itself (fail-closed) |
| SPIKE-004 B2 turn-deadline retirement on advance | Fixed in SPIKE-004 itself (atomic retirement) |
| SPIKE-008 MODIFY high-count pacing | Resolved by ECON-001 two-action development |

---

## ARCH-002 — Production spike-to-runtime ownership map

For every production-relevant outcome from SPIKE-001 through SPIKE-008, the table below identifies its current state and production owner. No production requirement remains owned only by a spike report.

### Legend

- **PROVEN BY SPIKE**: The spike demonstrated feasibility and recorded evidence. The spike code is not production code.
- **PRODUCTION IMPLEMENTED**: The capability exists in the production codebase and is tested.
- **FUTURE TASK OWNER**: The subsystem task that must implement production-quality behavior.

### Hibernation and runtime (SPIKE-001)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| Hibernation/wake/reconstruct | PROVEN BY SPIKE | RT-006 | RT |
| SQLite snapshot persistence | PROVEN BY SPIKE | RT-005 | RT |
| Earliest-deadline alarm scheduling | PROVEN BY SPIKE | RT-007 | RT |
| 10-client WS convergence | PROVEN BY SPIKE | RT-014, QA-001 | RT, QA |
| Quota budget feasibility | PROVEN BY SPIKE (estimated) | QA-006, QA-014 | QA |

### Atomic persistence (SPIKE-002)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| Fault-injected atomic commit | PROVEN BY SPIKE | RT-005 | RT |
| ActionId idempotency metadata | PROVEN BY SPIKE | RT-004, RT-005 | RT |
| Alarm resolution atomicity | PROVEN BY SPIKE | RT-007 | RT |

### Auth (SPIKE-003)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| Google OIDC invite-first flow | PROVEN BY SPIKE | AUTH-001 | AUTH |
| Opaque one-time OAuth state | PROVEN BY SPIKE | AUTH-001 | AUTH |
| PKCE S256 | PROVEN BY SPIKE | AUTH-001 | AUTH |
| First-party session (HttpOnly/Secure) | PROVEN BY SPIKE | AUTH-001 | AUTH |
| sub-based identity → internal userId | PROVEN BY SPIKE | AUTH-001, DATA-001 | AUTH |

### Reconnect/epoch (SPIKE-004)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| 90s reconnect lease | PROVEN BY SPIKE | RT-008 | RT |
| Connection epoch / SESSION_REPLACED | PROVEN BY SPIKE | RT-008 | RT |
| 20s active-turn extension (once, non-stacking) | PROVEN BY SPIKE | RT-008 | RT |
| Reconnect-expiry fail-closed | PROVEN BY SPIKE | RT-008 | RT |
| Turn-deadline retirement on advance | PROVEN BY SPIKE | RT-007 | RT |

### Rematch isolation (SPIKE-005)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| Rematch isolation behavior (new gameId, fresh state, cross-board) | PROVEN BY SPIKE | RT-013, QA-004 | RT, QA |
| Game-scoped persistence namespace | PROVEN BY SPIKE | RT-005 | RT |
| Mandatory gameId on mutations | PROVEN BY SPIKE | RT-004 | RT |

The spike's `createGame` helper and isolation test harness are spike/test infrastructure, not production implementation. Production rematch lifecycle is owned by RT-013; cross-board contamination regression is owned by QA-004.

### Dual-board UI (SPIKE-006)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| Dual-board DOM/CSS renderer (40/52) | PROVEN BY SPIKE (React shell) | UI-003, GRAND-002 | UI |
| Responsive/mobile/zoom layout | PROVEN BY SPIKE | UI-013 | UI |
| 12-set identity distinguishable (Grand) | PROVEN BY SPIKE | GRAND-002 | UI |
| Reduced motion | PROVEN BY SPIKE | UI-013 | UI |

### Fuzzing (SPIKE-007)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| Deterministic seeded fuzz methodology | PROVEN BY SPIKE | QA-011 (production rules adaptation), QA-005 | QA |
| Counter/toy invariant harness (CI-active) | PROVEN BY SPIKE (test infrastructure) | QA-011 replaces with production commands | QA |
| Invariant registry pattern (8 invariants) | PROVEN BY SPIKE (test infrastructure) | Extended by each CORE/RULE task | QA |
| Deterministic seed replay | PROVEN BY SPIKE | Preserved through all future work | CORE |
| Negative fuzz control (defect detection) | PROVEN BY SPIKE | QA-005, QA-011 | QA |

The spike's counter-based fuzz harness and toy invariants are test infrastructure that proved the methodology. Production gameplay fuzzing against real `applyCommand` transitions is not yet implemented; it is owned by QA-011 and QA-005.

### Economy simulation (SPIKE-008 + ECON-001)

| Capability | State | Production Owner | Subsystem |
|---|---|---|---|
| Economy candidate evidence (simulation) | PROVEN BY SPIKE | QA-011 (production adaptation), QA-015 (final rerun) | QA |
| 250-seed economy matrix (9 configs) | PROVEN BY SPIKE (historical evidence) | QA-015 (final rerun with production rules) | QA |
| Grand A/B/C comparison methodology | PROVEN BY SPIKE | GRAND-004 (A parity), GRAND-008 (optional B/C) | GRAND |
| Board/economy reconciliation tables | PROVEN BY SPIKE (approved launch candidates) | Frozen; QA-015 gates launch | CORE, QA |

The spike/ECON-001 simulation harness proved economy candidates through independent simulation using a simplified bot policy. Production rule-engine parity (running simulations through the real `applyCommand` path) is not yet implemented; it is owned by GRAND-003, GRAND-004, QA-011, and QA-015.

### Subsystem summary

| Subsystem | Key Production Tasks | Spike Evidence Available |
|---|---|---|
| CORE | CORE-010..014 | Rematch isolation, board schemas, seed replay |
| AUTH | AUTH-001 | Full OIDC flow, session, sub-identity |
| RT | RT-001..018 | Hibernation, persistence, idempotency, reconnect, deadlines, epochs |
| UI | UI-001..016 | Dual board, responsive, reduced motion, set identities |
| QA | QA-005, QA-006, QA-011, QA-015 | Fuzz harness, economy harness, quota estimates |
| INT | INT-001, INT-002 | No direct spike evidence (Collusion Guard is deferred) |
| META | META-001..007 | No direct spike evidence (profile/progression is deferred) |
| GRAND | GRAND-001..009 | A/B/C comparison, economy tables, renderer proof |

---

## ARCH-003 — Production fuzz/economy parity plan

### Current state

SPIKE-007's fuzz harness tests the toy counter transition (value/gameVersion), seat lifecycle, deadlines, and rematch isolation. It runs five fixed CI seeds (400 steps each) in ~1.5s. Eight registered invariants cover mutation consistency, version monotonicity, retired-game freezing, game coherence, unique game IDs, board immutability, and epoch monotonicity.

SPIKE-008's economy simulator tests 250 deterministic seeds per configuration against authored economy tables and evaluation bands. ECON-001 extended it with reconciliation, A/B/C comparison, sensitivity ablations, and cash preset matrices.

Both are CI-active and pass on current `main`.

### Gap: spike counters are not production rules

The fuzz harness exercises `handleIncrement` (a counter), not production game commands (ROLL_DICE, BUY_PROPERTY, BUILD, etc.). The economy simulator uses a simplified bot policy, not the production rule engine. Neither tests production state transitions.

This gap is expected and intentional — production rules (Section D) are TODO. The transition plan:

### Phase 1 — CORE/RULE tasks extend the fuzz invariant registry

As each CORE and RULE task lands, it adds invariants to the existing SPIKE-007 registry:

| Task | Expected Invariants |
|---|---|
| CORE-010 (asset state) | Ownership uniqueness; mortgage/building consistency |
| CORE-011 (pending resolution) | Pending actor/kind valid; no orphaned pendings |
| CORE-012 (doubles/continuation) | No duplicate-roll bypass; deterministic extra rolls |
| CORE-013 (card/effect schema) | Deck conservation; card refs valid; no executable code |
| CORE-014 (cross-state invariants) | Canonical invariant set (the registry's natural completion) |

The harness already supports adding invariants without structural change. The command generator expands as production commands exist.

### Phase 2 — QA-011: production rule fuzz/simulation adaptation

**Owner:** QA-011 (already defined in TASKS.md)
**Depends:** RULE-019 (all rules complete), CORE-013 (card schema), CORE-014 (canonical cross-state invariants)

QA-011 adapts the SPIKE-007/008 infrastructure to exercise real production transitions:

- Legal command generator produces production commands against the real `applyCommand` interface
- Invariant registry covers: money conservation, ownership integrity, card deck conservation, phase legality, building even-build, mortgage/unmortgage consistency, pending resolution determinism
- Economy simulation runs through the production rule engine, not the simplified bot
- Deterministic seed replay remains supported (frozen requirement from SPIKE-007)
- Failing seeds reproducible with the same `FUZZ_SEED` mechanism

### Phase 3 — QA-005: large production seeded fuzz run

**Owner:** QA-005 (already defined in TASKS.md)
**Depends:** QA-011

Scales the production fuzz to a larger seed corpus. All invariant breaks must produce a reproducible failing seed.

### Phase 4 — QA-015: final economy rerun and human gate

**Owner:** QA-015 (already defined in TASKS.md)
**Depends:** RULE-019, GRAND-005, QA-011

The final economy rerun happens only after:

1. All production rules are implemented (RULE-001 through RULE-019)
2. Final card content is authored (RULE-011/012)
3. Full Holding behavior replaces the bot approximation (RULE-013)
4. Production rule engine drives the simulation (QA-011)

ECON-001's 250-seed matrices remain historical evidence and the comparison baseline. They are not rewritten. The final rerun produces new evidence from the production rule path and compares against the frozen evaluation bands.

If the final rerun fails a frozen threshold, the post-freeze change rule (ARCHITECTURE-FREEZE-v1.md §8) applies: explicit task, rationale, proportionate evidence, ADR amendment if needed, independent review.

### Deterministic seed replay: preserved throughout

The frozen architectural requirements for randomness are:

- randomness is injectable;
- deterministic seeds/replay are supported;
- same seed + same canonical inputs reproduce the same outcome;
- production verification can replay recorded failing seeds.

Existing implementations may continue to use their current helpers (e.g. `mulberry32`, `configurationSeed`), but those specific algorithm names and function signatures are private implementation details, not architectural invariants. They may be changed without a freeze amendment provided the four requirements above are preserved.

Every future CORE/RULE/QA task that touches the command generator or simulation must preserve seed determinism. A change that breaks seed replay requires explicit justification and revalidation of regression seeds.

### Human gate

Simulation evidence is necessary but not sufficient for launch balance. QA-015 requires human playtesting (GRAND-005 for Grand, analogous for Standard) before closing the final balance gate. This is an explicit ARCHITECTURE.md requirement, not an afterthought.

---

## ARCH-004 — Hibernation/quota evidence refresh plan

### Historical SPIKE-001 measurements (preserved)

SPIKE-001 measured on deployment `b8c1b1f5` (2026-09-01):

| Dimension | Estimate | Desired ≤ | FAIL > | SPIKE-001 Verdict |
|---|---|---|---|---|
| Billed DO requests | ≈ 525 | 10,000 | 20,000 | Within desired |
| SQL reads | ≈ 12,560 | 500,000 | 1,000,000 | Within desired (large margin) |
| SQL writes | ≈ 7,100 | 10,000 | 20,000 | Within desired (tightest) |
| Duration (extrapolated) | ≈ 0.76 GB-s | 1,300 | 2,600 | Within desired |

These are estimates based on measured per-operation costs scaled by assumed representative game activity (SPIKE-001 §9–11). They are not deployed representative game measurements.

### Known limitation: no fresh dashboard GB-s

SPIKE-001 noted this explicitly: "Read a fresh dashboard GB-s for `b8c1b1f5` from a longer, representative session before the architecture freeze (FREEZE-001) to replace the §11 extrapolation." This was not obtained before FREEZE-001 and remains an open item.

### Disposition: assigned to QA-006

**Owner:** QA-006 (deployed quota rerun)
**Depends:** QA-014 (production deploy/rollback smoke)

QA-006's existing acceptance criteria require: "<=10% desired; >20% fail" against the frozen quota thresholds (ARCHITECTURE.md §19, ADR-001). The representative deployed rerun happens during release hardening, after the mandatory production runtime is deployed (gated by QA-014) and a real representative game can be played. QA-006 depends on the concrete deployment smoke gate (QA-014), not every numerically earlier RT task. Conditional features such as Collusion Guard (RT-017) are included in quota testing only if enabled for the release; if deferred, they must not block the normal quota rerun. Production UI must not claim active Collusion Guard protection when deferred.

### No re-freeze required now

SPIKE-001's estimates show large margins (requests at ~5% of desired, SQL reads at ~2.5%, duration at ~0.06%). The production runtime will add complexity, but the architectural approach (hibernation + alarm + indexed deadline queries) is validated.

A re-freeze is required only if QA-006's deployed measurement exceeds the >20% hard fail threshold. The 10–20% MODIFY range triggers optimization, not redesign.

### No invented current Cloudflare usage evidence

The Cloudflare dashboard analytics were not programmatically accessible during SPIKE-001 (no `analytics:read` scope). This document does not invent or extrapolate current provider usage data. QA-006 will produce the actual deployed measurement.

### Summary

| Evidence | Source | Status | Future Owner |
|---|---|---|---|
| Per-operation SQL costs | SPIKE-001 §8 (measured) | Frozen, valid | — |
| Representative game estimates | SPIKE-001 §9–10 (derived) | Frozen, valid as estimates | QA-006 replaces with deployed measurement |
| Duration extrapolation | SPIKE-001 §11 (rough) | Frozen, known rough | QA-006 replaces with deployed measurement |
| Deployed representative game | Not obtained | Missing | QA-006 |
| Production runtime quota impact | N/A | Does not exist yet | QA-006 + QA-014 |
