import { describe, expect, it } from "vitest";
import { createSqlTxnStore, type OAuthTransaction } from "./auth-store";
import { memorySqlExec } from "./oidc.testkit";

const NOW = 1_700_000_000_000;

function txn(overrides: Partial<OAuthTransaction> = {}): OAuthTransaction {
  return {
    state: "opaque-state-abc",
    roomCode: "ABCD",
    nonce: "nonce-1",
    verifier: "verifier-1",
    bindingHash: "binding-hash-1",
    expiresAt: NOW + 600_000,
    ...overrides,
  };
}

function newStore() {
  return createSqlTxnStore(memorySqlExec());
}

describe("oauth transaction store", () => {
  it("consumes a valid transaction exactly once", async () => {
    const store = newStore();
    await store.create(txn());
    const first = await store.consume("opaque-state-abc", "binding-hash-1", NOW);
    expect(first).toEqual({ ok: true, txn: txn() });

    // Replay of the same state must fail — one-time consumption.
    const second = await store.consume(
      "opaque-state-abc",
      "binding-hash-1",
      NOW,
    );
    expect(second).toEqual({ ok: false, reason: "ALREADY_CONSUMED" });
  });

  it("cannot let a concurrent double-consume both succeed", async () => {
    const store = newStore();
    await store.create(txn());
    // The DO serializes calls; the atomic UPDATE is the underlying guarantee.
    const results = await Promise.all([
      store.consume("opaque-state-abc", "binding-hash-1", NOW),
      store.consume("opaque-state-abc", "binding-hash-1", NOW),
    ]);
    const successes = results.filter((r) => r.ok);
    expect(successes).toHaveLength(1);
  });

  it("rejects an unknown state", async () => {
    const store = newStore();
    const res = await store.consume("nope", "binding-hash-1", NOW);
    expect(res).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("rejects an expired transaction", async () => {
    const store = newStore();
    await store.create(txn({ expiresAt: NOW - 1 }));
    const res = await store.consume("opaque-state-abc", "binding-hash-1", NOW);
    expect(res).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("rejects a wrong browser binding without burning the transaction", async () => {
    const store = newStore();
    await store.create(txn());
    const wrong = await store.consume(
      "opaque-state-abc",
      "attacker-binding",
      NOW,
    );
    expect(wrong).toEqual({ ok: false, reason: "BINDING_MISMATCH" });

    // The legitimate browser can still complete: the failed attempt did not
    // consume the row.
    const ok = await store.consume("opaque-state-abc", "binding-hash-1", NOW);
    expect(ok.ok).toBe(true);
  });
});
