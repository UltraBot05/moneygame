/**
 * SPIKE-007 — seeded, deterministic fuzz / property harness for the SPIKE-002/004/005
 * authoritative transition + seat logic.
 *
 * It drives the SAME functions the Durable Object (`room.ts`) calls —
 * `checkGameScoped`, `handleIncrement`, `startGame`, `resolveDueAlarm`,
 * `setActiveTurn`, `connectSeat`, `disconnectSeat` — over real `node:sqlite`
 * (the `SqlDb` seam), with NO React and NO Cloudflare runtime. A seeded PRNG
 * generates a mix of legal and intentionally-invalid commands; after every step a
 * registry of named invariants is checked. A failure reports the seed, step, and
 * command so it can be reproduced exactly.
 *
 * This is a test utility, not production code. It reaches only through the real
 * exported APIs, so it cannot pass by mirroring implementation internals.
 */

import { DatabaseSync } from "node:sqlite";
import { nodeDb } from "./sqlite.testkit";
import {
  applyIncrement,
  checkGameScoped,
  currentGameId,
  ensureSchema,
  handleIncrement,
  readState,
  resolveDueAlarm,
  setActiveTurn,
  startGame,
  type GameState,
  type NewGame,
  type SqlDb,
} from "./transition";
import {
  connectSeat,
  disconnectSeat,
  ensureSeatSchema,
  seatStatus,
} from "./seats";

/** Deterministic PRNG (mulberry32). Local to the harness so game behaviour never
 *  reaches for Math.random. (game-core carries an equivalent private PRNG;
 *  ponytail: consolidate into one shared util if a third caller appears.) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Canonical board identities (immutable). Frozen so any accidental mutation by
// the code under test would throw — an invariant in itself.
const BOARDS = {
  standard: Object.freeze({ boardId: "world-tour-standard", boardVersion: 1, tileCount: 40 }),
  grand: Object.freeze({ boardId: "world-tour-grand", boardVersion: 1, tileCount: 52 }),
} as const;

const USERS = ["google:alice", "google:bob", "google:carol"] as const;
const ACTION_POOL = ["x0", "x1", "x2", "x3", "x4"] as const; // small pool → forces collisions

export type FuzzCommand =
  | { kind: "INCREMENT"; gameId: string | undefined; actionId: string }
  | { kind: "REMATCH"; gameId: string | undefined; board: "standard" | "grand" }
  | { kind: "SET_DEADLINE"; gameId: string | undefined; id: string; ms: number }
  | { kind: "SET_TURN"; gameId: string | undefined; turnId: string; ownerIdx: number; ms: number }
  | { kind: "ALARM" }
  | { kind: "CONNECT"; userIdx: number }
  | { kind: "DISCONNECT"; userIdx: number };

/** What actually happened when a command was applied (drives the mutation check). */
type StepTag =
  | "committed" // a fresh increment / alarm advance
  | "duplicate" // idempotent no-op
  | "rejected" // failed checkGameScoped (missing/stale) — no write
  | "rematch" // installed a fresh current game
  | "noop"; // e.g. alarm with nothing due, seat op

interface StepResult {
  tag: StepTag;
  /** The game whose canonical state the command targeted, if any. */
  actedGameId: string | null;
  before: GameState | null;
  after: GameState | null;
}

export interface FuzzWorld {
  db: SqlDb;
  clock: number;
  gameSeq: number;
  currentGameId: string;
  knownGameIds: string[];
  /** Canonical state of each game at the moment it stopped being current. */
  retired: Map<string, GameState>;
  /** Highest gameVersion ever observed per game (monotonicity check). */
  maxVersion: Map<string, number>;
  /** Highest connection epoch observed per user (monotonicity check). */
  maxEpoch: Map<string, number>;
}

function newGame(world: FuzzWorld, board: "standard" | "grand"): NewGame {
  const b = BOARDS[board];
  return {
    gameId: `g${world.gameSeq++}`, // deterministic, not crypto.randomUUID
    boardId: b.boardId,
    boardVersion: b.boardVersion,
    tileCount: b.tileCount,
  };
}

export function initWorld(): FuzzWorld {
  const db = nodeDb(new DatabaseSync(":memory:"));
  ensureSchema(db);
  ensureSeatSchema(db);
  const world: FuzzWorld = {
    db,
    clock: 1_000_000,
    gameSeq: 0,
    currentGameId: "",
    knownGameIds: [],
    retired: new Map(),
    maxVersion: new Map(),
    maxEpoch: new Map(),
  };
  const g = newGame(world, "standard");
  startGame(db, g, world.clock);
  world.currentGameId = g.gameId;
  world.knownGameIds.push(g.gameId);
  return world;
}

/** Picks a gameId argument: usually current, sometimes a stale known game, rarely missing. */
function pickGameId(world: FuzzWorld, rng: () => number): string | undefined {
  const r = rng();
  if (r < 0.65) return world.currentGameId;
  if (r < 0.9) {
    const g = world.knownGameIds[Math.floor(rng() * world.knownGameIds.length)];
    return g ?? world.currentGameId; // may be the current or a retired (stale) one
  }
  return undefined; // missing gameId
}

function genCommand(world: FuzzWorld, rng: () => number): FuzzCommand {
  const r = rng();
  if (r < 0.4) {
    const actionId = ACTION_POOL[Math.floor(rng() * ACTION_POOL.length)] as string;
    return { kind: "INCREMENT", gameId: pickGameId(world, rng), actionId };
  }
  if (r < 0.5) {
    return { kind: "REMATCH", gameId: pickGameId(world, rng), board: rng() < 0.5 ? "standard" : "grand" };
  }
  if (r < 0.62) {
    return {
      kind: "SET_DEADLINE",
      gameId: pickGameId(world, rng),
      id: `d${Math.floor(rng() * 1000)}`,
      ms: Math.floor(rng() * 4000),
    };
  }
  if (r < 0.74) {
    return {
      kind: "SET_TURN",
      gameId: pickGameId(world, rng),
      turnId: `t${Math.floor(rng() * 6)}`,
      ownerIdx: Math.floor(rng() * USERS.length),
      ms: 1000 + Math.floor(rng() * 4000),
    };
  }
  if (r < 0.86) return { kind: "ALARM" };
  if (r < 0.93) return { kind: "CONNECT", userIdx: Math.floor(rng() * USERS.length) };
  return { kind: "DISCONNECT", userIdx: Math.floor(rng() * USERS.length) };
}

/**
 * Applies a command through the REAL room-mirroring logic. `opts.injectDefect`
 * deliberately BYPASSES the stale-game guard so a negative-control run mutates a
 * retired game — proving the invariant registry can actually catch a violation.
 */
export function applyCommand(
  world: FuzzWorld,
  cmd: FuzzCommand,
  opts: { injectDefect?: boolean } = {},
): StepResult {
  const { db } = world;
  switch (cmd.kind) {
    case "INCREMENT": {
      const check = checkGameScoped(db, cmd.gameId);
      if (!check.ok) {
        if (opts.injectDefect === true && cmd.gameId !== undefined) {
          // DEFECT: mutate the (stale) game anyway, skipping the guard.
          const before = safeState(db, cmd.gameId);
          applyIncrement(db, cmd.gameId, cmd.actionId);
          return { tag: "committed", actedGameId: cmd.gameId, before, after: safeState(db, cmd.gameId) };
        }
        return { tag: "rejected", actedGameId: null, before: null, after: null };
      }
      const before = readState(db, check.gameId);
      const outcome = handleIncrement(db, check.gameId, cmd.actionId);
      const after = readState(db, check.gameId);
      return {
        tag: outcome.duplicate ? "duplicate" : "committed",
        actedGameId: check.gameId,
        before,
        after,
      };
    }
    case "REMATCH": {
      const check = checkGameScoped(db, cmd.gameId);
      if (!check.ok) return { tag: "rejected", actedGameId: null, before: null, after: null };
      // Snapshot the outgoing game so its immutability can be checked forever after.
      world.retired.set(world.currentGameId, readState(db, world.currentGameId));
      const g = newGame(world, cmd.board);
      startGame(db, g, world.clock);
      world.currentGameId = g.gameId;
      world.knownGameIds.push(g.gameId);
      return { tag: "rematch", actedGameId: g.gameId, before: null, after: readState(db, g.gameId) };
    }
    case "SET_DEADLINE": {
      const check = checkGameScoped(db, cmd.gameId);
      if (!check.ok) return { tag: "rejected", actedGameId: null, before: null, after: null };
      db.run(
        `INSERT OR REPLACE INTO deadlines (game_id, id, fire_at, resolved) VALUES (?, ?, ?, 0);`,
        check.gameId,
        cmd.id,
        world.clock + cmd.ms,
      );
      return { tag: "noop", actedGameId: check.gameId, before: null, after: null };
    }
    case "SET_TURN": {
      const check = checkGameScoped(db, cmd.gameId);
      if (!check.ok) return { tag: "rejected", actedGameId: null, before: null, after: null };
      setActiveTurn(db, check.gameId, cmd.turnId, USERS[cmd.ownerIdx] as string, world.clock + cmd.ms);
      return { tag: "noop", actedGameId: check.gameId, before: null, after: null };
    }
    case "ALARM": {
      const g = world.currentGameId;
      const before = readState(db, g);
      const outcome = resolveDueAlarm(db, world.clock);
      const after = readState(db, g);
      return {
        tag: outcome.broadcast !== null ? "committed" : "noop",
        actedGameId: g,
        before,
        after,
      };
    }
    case "CONNECT": {
      connectSeat(db, USERS[cmd.userIdx] as string, world.clock);
      return { tag: "noop", actedGameId: null, before: null, after: null };
    }
    case "DISCONNECT": {
      const user = USERS[cmd.userIdx] as string;
      const st = seatStatus(db, user);
      if (st !== undefined && st.connected) disconnectSeat(db, user, st.epoch, world.clock);
      return { tag: "noop", actedGameId: null, before: null, after: null };
    }
  }
}

// --- invariant registry ------------------------------------------------------

interface Invariant {
  name: string;
  check: (world: FuzzWorld) => void;
}

function fail(msg: string): never {
  throw new Error(msg);
}

function safeState(db: SqlDb, gameId: string): GameState | null {
  try {
    return readState(db, gameId);
  } catch {
    return null;
  }
}

/** World-only invariants, checked after every step and by the negative control. */
const INVARIANTS: Invariant[] = [
  {
    name: "value-equals-gameVersion", // atomicity: mutate() advances both together
    check: (w) => {
      for (const g of w.knownGameIds) {
        const s = readState(w.db, g);
        if (s.value !== s.gameVersion) fail(`${g}: value ${s.value} != gameVersion ${s.gameVersion}`);
      }
    },
  },
  {
    name: "gameVersion-monotonic",
    check: (w) => {
      for (const g of w.knownGameIds) {
        const v = readState(w.db, g).gameVersion;
        const prev = w.maxVersion.get(g) ?? 0;
        if (v < prev) fail(`${g}: gameVersion regressed ${prev} -> ${v}`);
        w.maxVersion.set(g, Math.max(prev, v));
      }
    },
  },
  {
    name: "retired-game-frozen", // an ended game can never change after a rematch
    check: (w) => {
      for (const [g, snap] of w.retired) {
        const now = readState(w.db, g);
        if (now.gameVersion !== snap.gameVersion || now.value !== snap.value) {
          fail(`retired ${g} changed ${JSON.stringify(snap)} -> ${JSON.stringify(now)}`);
        }
      }
    },
  },
  {
    name: "current-game-coherent",
    check: (w) => {
      if (currentGameId(w.db) !== w.currentGameId) fail(`current pointer drift`);
      if (safeState(w.db, w.currentGameId) === null) {
        fail(`current game ${w.currentGameId} has no state row`);
      }
    },
  },
  {
    name: "unique-game-ids",
    check: (w) => {
      if (new Set(w.knownGameIds).size !== w.knownGameIds.length) fail(`duplicate gameId`);
    },
  },
  {
    name: "board-immutable",
    check: () => {
      if (BOARDS.standard.tileCount !== 40 || BOARDS.grand.tileCount !== 52) {
        fail(`canonical board tile count mutated`);
      }
    },
  },
  {
    name: "epoch-monotonic",
    check: (w) => {
      for (const u of USERS) {
        const st = seatStatus(w.db, u);
        if (st === undefined) continue;
        const prev = w.maxEpoch.get(u) ?? 0;
        if (st.epoch < prev) fail(`${u}: epoch regressed ${prev} -> ${st.epoch}`);
        w.maxEpoch.set(u, Math.max(prev, st.epoch));
      }
    },
  },
];

/** Runs the whole registry; throws the first violation's Error. */
export function checkInvariants(world: FuzzWorld): void {
  for (const inv of INVARIANTS) {
    try {
      inv.check(world);
    } catch (e) {
      throw new Error(`[${inv.name}] ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
}

/** The per-step mutation check: the state change must match what the tag claims. */
function checkMutationMatchesTag(step: StepResult): void {
  if (step.before === null || step.after === null) return;
  const delta = step.after.gameVersion - step.before.gameVersion;
  if ((step.tag === "rejected" || step.tag === "duplicate" || step.tag === "noop") && delta !== 0) {
    fail(`tag=${step.tag} but gameVersion moved by ${delta}`);
  }
  if (step.tag === "committed" && delta !== 1) {
    fail(`tag=committed but gameVersion moved by ${delta} (expected 1)`);
  }
}

export class FuzzViolation extends Error {
  constructor(
    readonly seed: number,
    readonly step: number,
    readonly command: FuzzCommand,
    readonly invariant: string,
    readonly detail: string,
  ) {
    super(
      `FUZZ_SEED=${seed} step=${step} invariant=${invariant}\n` +
        `command=${JSON.stringify(command)}\ndetail=${detail}`,
    );
    this.name = "FuzzViolation";
  }
}

export interface FuzzOptions {
  injectDefect?: boolean;
}

/** A stable hash of the whole world's canonical state (for determinism checks). */
function worldHash(world: FuzzWorld): string {
  const games = world.knownGameIds
    .map((g) => `${g}:${JSON.stringify(readState(world.db, g))}`)
    .join("|");
  const seats = USERS.map((u) => `${u}:${JSON.stringify(seatStatus(world.db, u) ?? null)}`).join("|");
  return `cur=${world.currentGameId};${games};${seats}`;
}

export interface FuzzRun {
  hash: string;
  log: FuzzCommand[];
}

/**
 * Runs `steps` seeded commands, checking every invariant after each. Throws a
 * {@link FuzzViolation} (carrying the seed, step, command and full log) on the
 * first violation. Returns the final world hash + command log for replay/equality.
 */
export function runFuzz(seed: number, steps: number, opts: FuzzOptions = {}): FuzzRun {
  const rng = mulberry32(seed);
  const world = initWorld();
  const log: FuzzCommand[] = [];
  for (let step = 0; step < steps; step++) {
    world.clock += Math.floor(rng() * 3000); // advance time so deadlines can fire
    const command = genCommand(world, rng);
    log.push(command);
    const result = applyCommand(world, command, opts);
    const runOne = (name: string, fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        throw new FuzzViolation(seed, step, command, name, e instanceof Error ? e.message : String(e));
      }
    };
    runOne("mutation-matches-tag", () => checkMutationMatchesTag(result));
    for (const inv of INVARIANTS) runOne(inv.name, () => inv.check(world));
  }
  return { hash: worldHash(world), log };
}
