import type { DatabaseSync } from "node:sqlite";
import type { SqlDb } from "./transition";

/**
 * A {@link SqlDb} over a real `node:sqlite` connection with real
 * BEGIN/COMMIT/ROLLBACK — the same statements the Durable Object runs over
 * `SqlStorage`. `transaction` rolls back on throw. Test-only.
 */
export function nodeDb(db: DatabaseSync): SqlDb {
  return {
    run: (query: string, ...params: (string | number)[]): number =>
      Number(db.prepare(query).run(...params).changes),
    get: <T extends Record<string, string | number | null>>(
      query: string,
      ...params: (string | number)[]
    ): T | undefined => db.prepare(query).get(...params) as T | undefined,
    transaction: <T>(fn: () => T): T => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
