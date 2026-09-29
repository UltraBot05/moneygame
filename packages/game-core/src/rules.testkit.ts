import { expect } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { parseCardCatalog, type CardCatalogDefinition } from "./cards";
import {
  applyGameplayCommand,
  type GameplayCommandContext,
  type GameplayCommandResult,
} from "./gameplay";
import { createSeededRandom } from "./random";
import {
  createInitialGameState,
  parseGameState,
  type GameState,
  type MatchMode,
  type TeamDefinition,
  type TurnIdentity,
} from "./state";

/** Shared fixtures for the Section D rule suites; every helper drives the real command pipeline. */
export const board = parseBoardDefinition(standardFixture);
export const alice = "google:alice";
export const bob = "google:bob";
export const carol = "google:carol";
export const EG1 = "property:EG-1";
export const EG2 = "property:EG-2";
export const MA1 = "property:MA-1";
export const MA2 = "property:MA-2";
export const MA3 = "property:MA-3";
export const FR2 = "property:FR-2";
export const POWER_GRID = "utility:4";

export interface CardSpec {
  readonly cardId: string;
  readonly effectId: string;
  readonly held?: boolean;
}

export const PLUS_FIVE = { cardId: "treasure:plus-five", effectId: "plus-five" };

export function catalog(
  surprise: readonly CardSpec[],
  effects: readonly Record<string, unknown>[] = [],
  treasure: readonly CardSpec[] = [PLUS_FIVE],
): CardCatalogDefinition {
  const card = (deckId: string) => (spec: CardSpec) => ({
    cardId: spec.cardId,
    deckId,
    effectId: spec.held === true ? null : spec.effectId,
    heldCapability: spec.held === true ? "DETENTION_RELEASE" : null,
  });
  return parseCardCatalog({
    decks: [
      { deckId: "surprise", cardIds: surprise.map((spec) => spec.cardId) },
      { deckId: "treasure", cardIds: treasure.map((spec) => spec.cardId) },
    ],
    cards: [...surprise.map(card("surprise")), ...treasure.map(card("treasure"))],
    effects: [
      { effectId: "plus-one", type: "ADJUST_CASH", target: "CURRENT_PLAYER", amount: 1 },
      { effectId: "plus-five", type: "ADJUST_CASH", target: "CURRENT_PLAYER", amount: 5 },
      { effectId: "plus-ten", type: "ADJUST_CASH", target: "CURRENT_PLAYER", amount: 10 },
      ...effects,
    ],
  }, board);
}

/** A one-card Surprise deck whose card runs `effectId`. */
export function oneCard(effectId: string, effects: readonly Record<string, unknown>[] = []) {
  return catalog([{ cardId: "surprise:only", effectId }], effects);
}

export interface RunOptions {
  readonly cards?: CardCatalogDefinition | undefined;
  readonly dice?: readonly number[];
  readonly extra?: Partial<GameplayCommandContext>;
  readonly actionId?: string;
}

let actionCounter = 0;

export function run(
  state: GameState,
  type: string,
  actorUserId: string,
  payload: unknown = {},
  options: RunOptions = {},
): GameplayCommandResult {
  const faces = (options.dice ?? []).map((face) => (face - 1) / 6 + 0.001);
  const seeded = createSeededRandom(7);
  let index = 0;
  actionCounter += 1;
  return applyGameplayCommand(
    state,
    {
      type,
      gameId: state.gameId,
      actionId: options.actionId ?? "action-" + actionCounter,
      expectedGameVersion: state.gameVersion,
      payload,
    },
    {
      actorUserId,
      board,
      rng: () => index < faces.length ? faces[index++] as number : seeded(),
      currentTime: 1000,
      auctionDecisionDeadlineAt: 2000,
      debtDeadlineAt: 3000,
      ...(options.cards === undefined ? {} : { cardCatalog: options.cards }),
      ...options.extra,
    },
  );
}

export function ok(result: GameplayCommandResult): GameState {
  if (result.kind !== "ACCEPTED") throw new Error("expected ACCEPTED, got " + JSON.stringify(result));
  return result.state;
}

export function refused(result: GameplayCommandResult, reason: string, before: GameState): void {
  expect(result).toMatchObject({ kind: "REJECTED", reason });
  expect(result.state).toEqual(before);
  expect(result.state.gameVersion).toBe(before.gameVersion);
}

export function roundTrip(state: GameState, cards?: CardCatalogDefinition): GameState {
  const restored = parseGameState(JSON.parse(JSON.stringify(state)), board, cards);
  expect(restored).toEqual(state);
  return restored;
}

export const RED_BLUE: readonly TeamDefinition[] = [
  { teamId: "red", memberUserIds: ["google:alice", "google:carol"] },
  { teamId: "blue", memberUserIds: ["google:bob"] },
];

export function started(matchMode: MatchMode = "FFA", teams: readonly TeamDefinition[] = RED_BLUE): GameState {
  const initial = createInitialGameState({
    gameId: "d2-game",
    board,
    playerIds: [alice, bob, carol],
    matchMode,
    ...(matchMode === "TEAMS"
      ? { teams }
      : {}),
  });
  return ok(run(initial, "START_GAME", alice));
}

export interface Setup {
  readonly cash?: Readonly<Record<string, number>>;
  readonly positions?: Readonly<Record<string, number>>;
  readonly holding?: number;
  readonly owners?: Readonly<Record<string, string>>;
  readonly mortgaged?: readonly string[];
  readonly development?: Readonly<Record<string, number>>;
  readonly turn?: Partial<TurnIdentity>;
  readonly ruleState?: object;
}

/** Alice owns the opening turn; `holding` puts her in Holding with that many failed attempts. */
export function setup(input: Setup = {}, cards?: CardCatalogDefinition, base: GameState = started()): GameState {
  return parseGameState({
    ...base,
    turn: { ...base.turn, ...input.turn },
    players: base.players.map((player) => ({
      ...player,
      cash: input.cash?.[player.userId] ?? player.cash,
      position: input.positions?.[player.userId] ?? player.position,
      ...(player.userId === alice && input.holding !== undefined
        ? { position: 10, inHolding: true, holdingAttempts: input.holding }
        : {}),
    })),
    assets: base.assets.map((asset) => ({
      ...asset,
      ownerUserId: input.owners?.[asset.assetId] ?? asset.ownerUserId,
      mortgaged: input.mortgaged?.includes(asset.assetId) ?? asset.mortgaged,
      ...(asset.kind === "PROPERTY"
        ? { developmentLevel: input.development?.[asset.assetId] ?? asset.developmentLevel }
        : {}),
    })),
    ruleState: { ...base.ruleState, ...input.ruleState },
  }, board, cards);
}

export function player(state: GameState, userId: string) {
  const found = state.players.find((candidate) => candidate.userId === userId);
  if (found === undefined) throw new Error("missing player " + userId);
  return found;
}

export function asset(state: GameState, assetId: string) {
  const found = state.assets.find((candidate) => candidate.assetId === assetId);
  if (found === undefined) throw new Error("missing asset " + assetId);
  return found;
}

/** Alice rolls 1+2 from `tile - 3` onto `tile`. */
export function landOn(tile: number, input: Setup = {}, cards?: CardCatalogDefinition): GameState {
  const state = setup({ ...input, positions: { ...input.positions, [alice]: tile - 3 } }, cards);
  return ok(run(state, "ROLL_DICE", alice, {}, { cards, dice: [1, 2] }));
}

export function drawFrom(state: GameState, cards?: CardCatalogDefinition, options: RunOptions = {}) {
  return run(state, "DRAW_CARD", alice, { resolutionId: state.pendingResolution?.resolutionId }, {
    ...options,
    ...(cards === undefined ? {} : { cards }),
  });
}

export function bundle(cash: number, assetIds: readonly string[] = []) {
  return { cash, assetIds };
}

export function propose(
  state: GameState,
  from: string,
  to: string,
  offered: ReturnType<typeof bundle>,
  requested: ReturnType<typeof bundle>,
) {
  return run(state, "PROPOSE_TRADE", from, { recipientUserId: to, offered, requested });
}

export function openTradeId(state: GameState): string {
  const trade = state.ruleState.trades.at(-1);
  if (trade === undefined) throw new Error("expected an open trade");
  return trade.tradeId;
}

