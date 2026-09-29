import type { TradeBundle, TradeState } from "./advanced-rules";
import type { BoardDefinition } from "./board";
import { mortgageValue, purchasePrice } from "./rules";
import type { AssetState } from "./state";

/** INT-001 §3 launch thresholds. */
export const LOPSIDED_MINIMUM_NET = 300;
export const LOPSIDED_MAXIMUM_RETURN_PERCENT = 25;

/** A lopsided accepted trade, valued once at acceptance (INT-001 §2–3). */
export interface LopsidedTrade {
  readonly tradeId: string;
  readonly giverUserId: string;
  readonly receiverUserId: string;
  readonly givenValue: number;
  readonly returnedValue: number;
  readonly liquidationFor: string | null;
  readonly gameVersion: number;
}

export interface FairPlayIncident {
  readonly kind: "PATTERN" | "DUMP";
  readonly tradeId: string;
  readonly giverUserId: string;
  readonly receiverUserId: string;
  readonly givenValue: number;
  readonly returnedValue: number;
  readonly consequence: "WARNING" | "REMOVAL";
  readonly gameVersion: number;
  readonly actionId: string;
}

export interface FairPlayState {
  readonly lopsidedTrades: readonly LopsidedTrade[];
  readonly incidents: readonly FairPlayIncident[];
}

export const EMPTY_FAIR_PLAY: FairPlayState = Object.freeze({
  lopsidedTrades: Object.freeze([]),
  incidents: Object.freeze([]),
});

function bundleValue(board: BoardDefinition, assets: readonly AssetState[], bundle: TradeBundle): number {
  return bundle.assetIds.reduce((total, assetId) => {
    const asset = assets.find((candidate) => candidate.assetId === assetId);
    if (asset === undefined) throw new RangeError("traded asset is not canonical");
    return total + (asset.mortgaged ? mortgageValue(board, asset) : purchasePrice(board, asset));
  }, bundle.cash);
}

/** Values a trade against the assets as they stood when it was accepted. */
export function lopsidedTrade(
  board: BoardDefinition,
  assetsAtAcceptance: readonly AssetState[],
  trade: TradeState,
  gameVersion: number,
): LopsidedTrade | null {
  const offered = bundleValue(board, assetsAtAcceptance, trade.offered);
  const requested = bundleValue(board, assetsAtAcceptance, trade.requested);
  const proposerGives = offered >= requested;
  const givenValue = proposerGives ? offered : requested;
  const returnedValue = proposerGives ? requested : offered;
  if (givenValue - returnedValue < LOPSIDED_MINIMUM_NET) return null;
  if (returnedValue * 100 > givenValue * LOPSIDED_MAXIMUM_RETURN_PERCENT) return null;
  return {
    tradeId: trade.tradeId,
    giverUserId: proposerGives ? trade.proposerUserId : trade.recipientUserId,
    receiverUserId: proposerGives ? trade.recipientUserId : trade.proposerUserId,
    givenValue,
    returnedValue,
    liquidationFor: trade.liquidationFor,
    gameVersion,
  };
}

function samePair(left: { giverUserId: string; receiverUserId: string }, a: string, b: string): boolean {
  return (left.giverUserId === a && left.receiverUserId === b) || (left.giverUserId === b && left.receiverUserId === a);
}

function incidentFor(
  fairPlay: FairPlayState,
  kind: FairPlayIncident["kind"],
  trade: LopsidedTrade,
  gameVersion: number,
  actionId: string,
): FairPlayIncident {
  const prior = fairPlay.incidents.some((incident) =>
    samePair(incident, trade.giverUserId, trade.receiverUserId)
  );
  return {
    kind,
    tradeId: trade.tradeId,
    giverUserId: trade.giverUserId,
    receiverUserId: trade.receiverUserId,
    givenValue: trade.givenValue,
    returnedValue: trade.returnedValue,
    consequence: prior ? "REMOVAL" : "WARNING",
    gameVersion,
    actionId,
  };
}

/** INT-001 §4.1: records a lopsided trade and returns an incident from the pair's second onwards. */
export function recordLopsidedTrade(
  fairPlay: FairPlayState,
  trade: LopsidedTrade,
  actionId: string,
): Readonly<{ fairPlay: FairPlayState; incident: FairPlayIncident | null }> {
  const repeated = fairPlay.lopsidedTrades.some((earlier) =>
    samePair(earlier, trade.giverUserId, trade.receiverUserId)
  );
  const incident = repeated ? incidentFor(fairPlay, "PATTERN", trade, trade.gameVersion, actionId) : null;
  return {
    incident,
    fairPlay: {
      lopsidedTrades: [...fairPlay.lopsidedTrades, trade],
      incidents: incident === null ? fairPlay.incidents : [...fairPlay.incidents, incident],
    },
  };
}

/** INT-001 §4.2: every lopsided liquidation trade the bankrupt debtor gave under that debt. */
export function recordDumps(
  fairPlay: FairPlayState,
  debtorUserId: string,
  resolutionId: string,
  gameVersion: number,
  actionId: string,
): Readonly<{ fairPlay: FairPlayState; incidents: readonly FairPlayIncident[] }> {
  let current = fairPlay;
  const incidents: FairPlayIncident[] = [];
  for (const trade of fairPlay.lopsidedTrades) {
    if (trade.giverUserId !== debtorUserId || trade.liquidationFor !== resolutionId) continue;
    // INT-001 section 4: a trade that already produced an incident never produces a second one.
    if (current.incidents.some((incident) => incident.tradeId === trade.tradeId)) continue;
    const incident = incidentFor(current, "DUMP", trade, gameVersion, actionId);
    incidents.push(incident);
    current = { ...current, incidents: [...current.incidents, incident] };
  }
  return { fairPlay: current, incidents };
}
