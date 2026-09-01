import { DurableObject } from "cloudflare:workers";
import {
  createSqlTxnStore,
  type ConsumeResult,
  type OAuthTransaction,
  type SqlExec,
  type TransactionStore,
} from "./auth-store";

/**
 * SPIKE-003 auth-transaction store, backed by a SQLite Durable Object so the
 * one-time consume is strongly consistent (the DO serializes calls; the atomic
 * UPDATE in auth-store.ts is the belt-and-suspenders guard). This is a
 * spike-only adapter: the eventual production auth datastore is not frozen here.
 *
 * ponytail: single global auth DO. If pending-login throughput ever matters,
 * shard by a `state` prefix across several DOs.
 */

/** Adapts the DO's synchronous `SqlStorage` to the store's `SqlExec` seam. */
function sqlExec(sql: SqlStorage): SqlExec {
  return {
    run(query: string, ...params: (string | number)[]): number {
      const cursor = sql.exec(query, ...params);
      cursor.toArray();
      return cursor.rowsWritten;
    },
    all<T>(query: string, ...params: (string | number)[]): T[] {
      return sql.exec(query, ...params).toArray() as T[];
    },
  };
}

export class AuthStore extends DurableObject<Env> {
  private readonly store: TransactionStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // createSqlTxnStore runs the (idempotent) schema, safe on every wake.
    this.store = createSqlTxnStore(sqlExec(ctx.storage.sql));
  }

  createTxn(txn: OAuthTransaction): Promise<void> {
    return this.store.create(txn);
  }

  consumeTxn(
    state: string,
    bindingHash: string,
    now: number,
  ): Promise<ConsumeResult> {
    return this.store.consume(state, bindingHash, now);
  }
}
