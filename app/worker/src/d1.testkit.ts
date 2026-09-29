import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * The subset of the D1 API the worker uses (prepare/bind/first/run/all/batch) over real
 * `node:sqlite`, with every migration in `app/worker/migrations` applied in order. Test-only.
 */
export function memoryD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const migrations = join(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrations, file), "utf8"));
  }
  const statement = (sql: string, params: readonly SQLInputValue[] = []) => ({
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
    execute: () => db.prepare(sql).run(...params),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      db.exec("BEGIN");
      try {
        for (const item of statements) item.execute();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  } as unknown as D1Database;
}
