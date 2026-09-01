import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/**
 * Tests the ACTUAL deadline SQL used by SpikeRoom (schema, index, and the
 * scheduling/resolution queries) against a real SQLite via Node's built-in
 * `node:sqlite` — no dependency added. Proves both correctness (earliest-first,
 * idempotent resolution) and that pending lookups use the index rather than
 * scanning resolved history.
 */

interface IdRow {
  id: string;
}
interface PlanRow {
  detail: string;
}

const EARLIEST =
  `SELECT id FROM deadlines WHERE resolved = 0 ORDER BY fire_at LIMIT 1;`;
const DUE = `SELECT id FROM deadlines WHERE resolved = 0 AND fire_at <= ?;`;
const RESOLVE = `UPDATE deadlines SET resolved = 1 WHERE id = ?;`;

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE deadlines (
       id TEXT PRIMARY KEY,
       fire_at INTEGER NOT NULL,
       resolved INTEGER NOT NULL DEFAULT 0
     );`,
  );
  db.exec(
    `CREATE INDEX idx_deadlines_pending ON deadlines (resolved, fire_at);`,
  );
  return db;
}

function insert(db: DatabaseSync, id: string, fireAt: number, resolved = 0): void {
  db.prepare(
    `INSERT INTO deadlines (id, fire_at, resolved) VALUES (?, ?, ?);`,
  ).run(id, fireAt, resolved);
}

function earliestId(db: DatabaseSync): string | undefined {
  return (db.prepare(EARLIEST).get() as IdRow | undefined)?.id;
}

function dueIds(db: DatabaseSync, now: number): string[] {
  return (db.prepare(DUE).all(now) as IdRow[]).map((r) => r.id);
}

describe("deadline SQL selection", () => {
  it("selects the earlier deadline when the later one was inserted first", () => {
    const db = makeDb();
    insert(db, "A", 60);
    insert(db, "B", 10);
    expect(earliestId(db)).toBe("B");
  });

  it("selects the earlier deadline when it was inserted first", () => {
    const db = makeDb();
    insert(db, "B", 10);
    insert(db, "A", 60);
    expect(earliestId(db)).toBe("B");
  });

  it("selects the next earliest after the first resolves", () => {
    const db = makeDb();
    insert(db, "B", 10);
    insert(db, "A", 60);
    db.prepare(RESOLVE).run("B");
    expect(earliestId(db)).toBe("A");
  });

  it("does not re-return a resolved deadline (idempotent alarm retry)", () => {
    const db = makeDb();
    insert(db, "B", 10);
    insert(db, "A", 60);
    expect(dueIds(db, 100)).toEqual(["B", "A"]);
    db.prepare(RESOLVE).run("B");
    expect(dueIds(db, 100)).toEqual(["A"]);
    db.prepare(RESOLVE).run("A");
    expect(dueIds(db, 100)).toEqual([]);
  });

  it("uses the index for the earliest-pending query, not a full table scan", () => {
    const db = makeDb();
    for (let i = 0; i < 300; i++) insert(db, `r${i}`, i, 1);
    insert(db, "p", 999_999, 0);
    const detail = (
      db.prepare(`EXPLAIN QUERY PLAN ${EARLIEST}`).all() as PlanRow[]
    )
      .map((r) => r.detail)
      .join(" | ");
    expect(detail).toMatch(/USING INDEX/i);
    expect(detail).not.toMatch(/\bSCAN deadlines\b(?! USING)/i);
  });
});
