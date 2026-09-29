# Final codebase audit

Date: 2026-09-29, after Sections D to I were implemented. Requested by the project owner as a
last pass over the whole codebase.

## Scope and method

- **Static sweep** of every production source file (about 17k lines): no `Math.random` in game
  logic, no TODO/FIXME, no stray logging outside the CLI tools, no `innerHTML`, one safe cast
  (the browser WebSocket adapter).
- **Targeted reads** of the risk paths: landing and rent, charges and the single-obligation debt
  model, settlement and effect resumption, Holding attempts and the fee debt, auctions (bid caps,
  settlement, turn order), trade acceptance and the Collusion Guard, elimination (bankruptcy and
  removal share one path), turn-timeout auto-play, the room runtime's clocks and deadlines,
  sessions and the Worker's trust boundaries, and the web client's connection handling.
- **Dynamic evidence** already gathered: 250-seed production-path simulations (9/9 in bands),
  900-game production fuzz (0 invariant failures over 3.0M commands), 1,000-rematch soak,
  injected storage faults, the Collusion Guard adversarial suite, live multi-browser runs
  (including five unplanned Worker restarts mid-match), and cross-browser smoke in CI.

## Findings fixed during the audit

| # | Area | Finding | Fix |
| --- | --- | --- | --- |
| 1 | Web client | A frame arriving on an already-replaced socket (for example a late `SESSION_REPLACED` after a slow close, or React StrictMode's double mount) could stop the new connection | frames from any socket that is not the current one are ignored; test added |
| 2 | Web client | Chat and lobby actions sent while reconnecting were dropped silently | the composer and lobby buttons are disabled until the connection is back |
| 3 | Worker | `POST /auth/logout` lacked the same-origin check the other POSTs have | added |
| 4 | Worker/web | No security headers on the site | CSP and hardening headers via `_headers`; `nosniff` on Worker JSON (QA-009) |
| 5 | Web | Several AA contrast failures and dialogs not taking focus | fixed (QA-007) |
| 6 | Docs | No README describing the stack, hosting and how to run | `README.md` |
| 7 | Tooling | The SPIKE-001 client targets the retired SpikeRoom without saying so | marked historical |
| 8 | Test driver | The live full-match driver never built or traded, so a full match could not end | the driver builds and makes set-completion trades before ending a turn |
| 9 | Web UI | Found by the 10-browser run: with a long deed list (typical on Grand) the trade dialog grew past the viewport and "Send offer" could not be reached | the dialog's height now applies (flex-centred overlay), deed lists scroll inside their columns; smoke regression test added |

## Accepted, recommended follow-ups (not bugs)

| Area | Note |
| --- | --- |
| Pacing | An away player's turns wait the full turn clock (90 s default) before auto-play, as RUNTIME-E1 specifies. A shorter clock for away seats would speed rooms with a missing player; it is a product decision. |
| Auth | Sessions cannot be revoked before their 7-day expiry (see QA-009). |
| Abuse | Room-code probing is not rate-limited in code; use a Cloudflare rate-limiting rule at deploy (QA-009). |
| Structure | The production `SqlDb` seam still lives in `app/worker/src/transition.ts`, beside SPIKE-002/005 harness code. Moving it to its own module is a pure refactor with no behaviour change. |
| Performance | Every command re-parses and fully revalidates the state (by design, for safety), and `propertyForAsset` re-parses the board per call. The fuzz run averaged about 0.6 ms per command locally (3.0M commands in 1,895 s, including the fuzzer's own checks, on a busy machine); QA-006 should confirm Durable Object duration on the deployed build. |
| Accessibility | Dialog focus is not trapped; the board is 40 or 52 tab stops; timers are not announced (QA-007). |
| Browsers | Safari is covered through WebKit in CI; a real-device Safari check remains manual. |
| Historical code | `packages/game-core/src/game.ts` (SPIKE-005) and `spike-008/` are retained as evidence; the production simulator reuses SPIKE-008's summary and bands on purpose. |

## Remaining human gates

Deployment and rollback rehearsal (QA-014), deployed quota rerun (QA-006), public-release IP
review (QA-010), final balance sign-off (QA-015) and the Grand human alpha (GRAND-005). All are
prepared in `RELEASE-GATES.md`; none is claimed as passed.
