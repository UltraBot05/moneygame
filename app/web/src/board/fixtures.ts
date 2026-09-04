/**
 * SPIKE-006 — SYNTHETIC demo fixtures for the renderer proof ONLY.
 *
 * None of this is canonical product content. Names, prices, sets, owners and
 * tokens are placeholder data generated from a board's tile count purely to
 * exercise the visual system (both sizes, 12 set identities, ownership/mortgage/
 * building states, token crowding, long labels, huge balances). Authored board
 * content (GOV-003 / CORE-001) will replace all of it and lives under `boards/`,
 * never here. Deterministic (no RNG) so the demo is stable across reloads.
 */

export type TileType =
  | "corner"
  | "property"
  | "transit"
  | "utility"
  | "tax"
  | "surprise"
  | "chest";

/** A set identity carries THREE distinguishing channels (never colour alone):
 *  a colour token, a 2-letter code, and a fill pattern. */
export interface SetIdentity {
  code: string;
  colorVar: string; // CSS var name
  pattern: "solid" | "stripe" | "dot" | "hatch" | "chevron";
}

export const SETS: SetIdentity[] = [
  { code: "AM", colorVar: "--set-1", pattern: "solid" },
  { code: "BR", colorVar: "--set-2", pattern: "stripe" },
  { code: "CO", colorVar: "--set-3", pattern: "dot" },
  { code: "DE", colorVar: "--set-4", pattern: "hatch" },
  { code: "EL", colorVar: "--set-5", pattern: "chevron" },
  { code: "FJ", colorVar: "--set-6", pattern: "solid" },
  { code: "GA", colorVar: "--set-7", pattern: "stripe" },
  { code: "HI", colorVar: "--set-8", pattern: "dot" },
  { code: "IN", colorVar: "--set-9", pattern: "hatch" },
  { code: "JO", colorVar: "--set-10", pattern: "chevron" },
  { code: "KE", colorVar: "--set-11", pattern: "solid" },
  { code: "LU", colorVar: "--set-12", pattern: "stripe" },
];

export interface DemoPlayer {
  id: string;
  name: string;
  initials: string;
  /** distinct token shape so players are told apart without colour alone. */
  shape: "disc" | "ring" | "square" | "diamond" | "triangle";
  colorVar: string;
  balance: number;
  connection: "online" | "reconnecting" | "away";
}

export interface DemoTile {
  index: number;
  type: TileType;
  name: string;
  setIndex?: number | undefined;
  price?: number | undefined;
  ownerId?: string | undefined;
  buildings?: number | undefined; // 0..5
  mortgaged?: boolean | undefined;
  tokens: string[]; // player ids currently on the tile
}

export interface DemoBoard {
  players: DemoPlayer[];
  tiles: DemoTile[];
}

export const DEMO_SCENES = [
  "turn",
  "property",
  "auction",
  "event",
  "trade",
  "debt",
  "results",
] as const;

export type DemoScene = (typeof DEMO_SCENES)[number];

export const DEMO_SCENE_LABELS: Record<DemoScene, string> = {
  turn: "Current turn",
  property: "Selected property",
  auction: "Auction",
  event: "Event reveal",
  trade: "Trade",
  debt: "Debt resolution",
  results: "Final results",
};

const CORNER_NAMES = ["Departure", "Layover", "Customs", "Detention"];
const PLAYER_COLORS = ["--set-1", "--set-4", "--set-6", "--set-9", "--set-11"];
const SHAPES: DemoPlayer["shape"][] = ["disc", "ring", "square", "diamond", "triangle"];

function makePlayers(count: number): DemoPlayer[] {
  const names = [
    "Ava Rao",
    "Ben Okafor",
    "Cy Park",
    "Dot Silva",
    "Eze Mensah",
    "Fin Morgan",
    "Gus Laurent",
    "Hana Kim",
    "Ivo Petrov",
    "Jo Fernández-Rodríguez",
  ];
  return Array.from({ length: count }, (_, i) => ({
    id: "p" + i,
    name: names[i] ?? "Player " + (i + 1),
    initials: (names[i] ?? "P" + i)
      .split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase(),
    shape: SHAPES[i % SHAPES.length] as DemoPlayer["shape"],
    colorVar: PLAYER_COLORS[i % PLAYER_COLORS.length] as string,
    // A deliberately wide range incl. a "huge balance" to stress the mono HUD.
    balance: i === 0 ? 1_284_500 : 500 + i * 740,
    connection: i === 7 ? "reconnecting" : i === 9 ? "away" : "online",
  }));
}

// Fixed non-property roles by position within a side (keeps structural variety
// without inventing canonical placement).
function roleFor(index: number, corners: Set<number>, perSide: number): TileType {
  if (corners.has(index)) return "corner";
  const m = index % Math.max(4, Math.floor(perSide / 2));
  if (m === 1) return "transit";
  if (m === 2 && index % 7 === 2) return "utility";
  if (m === 3 && index % 5 === 3) return "surprise";
  if (m === 3 && index % 5 === 1) return "chest";
  if (index % 11 === 6) return "tax";
  return "property";
}

export interface DemoOptions {
  /** Load the pathological stress fixture (long names, 10 tokens, huge values). */
  stress?: boolean;
}

/** Builds a deterministic synthetic board view-model for `tileCount` tiles. */
export function demoBoard(tileCount: number, opts: DemoOptions = {}): DemoBoard {
  const perSide = (tileCount - 4) / 4;
  const corners = new Set([0, perSide + 1, 2 * perSide + 2, 3 * perSide + 3]);
  const playerCount = opts.stress === true ? 10 : 5;
  const players = makePlayers(playerCount);

  let cornerN = 0;
  let propN = 0;
  const tiles: DemoTile[] = [];
  for (let index = 0; index < tileCount; index++) {
    const type = roleFor(index, corners, perSide);
    if (type === "corner") {
      tiles.push({ index, type, name: CORNER_NAMES[cornerN++] ?? "Corner", tokens: [] });
      continue;
    }
    if (type === "property") {
      // Standard demonstrates eight identities; Grand deliberately exercises all
      // twelve. Cycling is synthetic and avoids implying canonical set ordering.
      const setIndex = propN % (tileCount === 52 ? 12 : 8);
      const owned = propN % 3 !== 0;
      const name =
        opts.stress === true && propN === 4
          ? "The Extraordinarily Long Territory Name That Must Not Break Layout"
          : `Territory ${String(index).padStart(2, "0")}`;
      tiles.push({
        index,
        type,
        name,
        setIndex,
        price: 60 + propN * 12,
        ownerId: owned ? players[propN % players.length]?.id : undefined,
        buildings: owned && propN % 4 === 0 ? (propN % 5) + 1 : 0,
        mortgaged: owned && propN % 9 === 1,
        tokens: [],
      });
      propN++;
      continue;
    }
    const labels: Record<Exclude<TileType, "corner" | "property">, string> = {
      transit: "Transit Hub",
      utility: "Utility Grid",
      tax: "Levy",
      surprise: "Surprise",
      chest: "Reserve",
    };
    tiles.push({ index, type, name: labels[type], price: type === "transit" ? 200 : undefined, tokens: [] });
  }

  // Place tokens. Normal: scatter. Stress: pile all 10 on one PROPERTY tile so
  // the crowding + "+N" overflow is visible in a tile body (corners are cramped).
  if (opts.stress === true) {
    const crowded = tiles.find((t) => t.type === "property") ?? tiles[1];
    if (crowded) crowded.tokens = players.map((p) => p.id);
  } else {
    players.forEach((p, i) => {
      const t = tiles[(i * 7 + 3) % tileCount];
      if (t) t.tokens.push(p.id);
    });
  }
  return { players, tiles };
}
