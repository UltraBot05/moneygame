import {
  CANDIDATE_RULES,
  canonicalBoard,
  type AssetState,
  type AuctionFact,
  type CardCopy,
  type GameplayEvent,
  type ProjectedGameState,
  type PropertyEconomy,
} from "@moneygame/game-core";
import type { RoomView } from "@moneygame/shared";

/**
 * UI view model: pure functions from the authoritative projected state to what the screens show.
 * Nothing here decides an outcome; it only mirrors server rules so the UI can offer legal actions.
 * The server still validates every command (ARCHITECTURE §5, UI-014).
 */

export type Pattern = "solid" | "stripe" | "dot" | "hatch" | "chevron";

/** The twelve Design set identities: colour plus a pattern, so sets never rely on colour alone. */
const SET_STYLES: readonly (readonly [string, Pattern])[] = [
  ["#C0442B", "solid"], ["#D98324", "stripe"], ["#8E9430", "dot"], ["#4E8B3F", "hatch"],
  ["#2C8C7A", "chevron"], ["#2E77A6", "solid"], ["#40559B", "stripe"], ["#7A4E9E", "dot"],
  ["#A83C74", "hatch"], ["#8A5A3A", "chevron"], ["#5A6B7A", "solid"], ["#B3272D", "stripe"],
];

export const PLAYER_COLORS: readonly string[] = [
  "#C0442B", "#2E77A6", "#4E8B3F", "#E08A1E", "#7A4E9E",
  "#18A0A0", "#D6407F", "#6B4A2F", "#8FB015", "#3B4FC4",
];

export const PATTERN_CSS: Readonly<Record<Pattern, Readonly<{ backgroundImage?: string; backgroundSize?: string }>>> = {
  solid: {},
  stripe: { backgroundImage: "repeating-linear-gradient(45deg, #00000026 0 3px, transparent 3px 7px)" },
  dot: { backgroundImage: "radial-gradient(#00000033 1.2px, transparent 1.5px)", backgroundSize: "6px 6px" },
  hatch: {
    backgroundImage: "repeating-linear-gradient(0deg, #00000022 0 2px, transparent 2px 6px), "
      + "repeating-linear-gradient(90deg, #00000022 0 2px, transparent 2px 6px)",
  },
  chevron: { backgroundImage: "repeating-linear-gradient(135deg, #00000026 0 3px, transparent 3px 8px)" },
};

export interface SetModel {
  readonly setId: string;
  readonly country: string;
  readonly code: string;
  readonly color: string;
  readonly pattern: Pattern;
  readonly tileIndexes: readonly number[];
}

export type CornerKind = "START" | "HOLDING" | "VACATION" | "GO_TO_HOLDING";

export interface TileModel {
  readonly index: number;
  readonly kind: "corner" | "property" | "transit" | "utility" | "tax" | "card" | "special";
  readonly name: string;
  readonly price: number | null;
  readonly set: SetModel | null;
  readonly property: PropertyEconomy | null;
  readonly corner: CornerKind | null;
  readonly deck: "surprise" | "treasure" | null;
  readonly taxAmount: number | null;
}

export interface BoardModel {
  readonly ref: string;
  readonly label: string;
  readonly tiles: readonly TileModel[];
  readonly sets: readonly SetModel[];
  readonly cardCopy: Readonly<Record<string, CardCopy>>;
  readonly transit: Readonly<{ price: number; rents: readonly number[]; mortgageValue: number; unmortgageCost: number }>;
  readonly utility: Readonly<{ price: number; rentMultipliers: readonly number[]; mortgageValue: number; unmortgageCost: number }>;
  readonly startSalary: number;
}

const CORNERS: Readonly<Record<string, CornerKind>> = {
  START: "START", HOLDING: "HOLDING", VACATION: "VACATION", "GO TO HOLDING": "GO_TO_HOLDING",
};

const boardCache = new Map<string, BoardModel>();

/** Static board model for a canonical board ref, cached because boards never change at runtime. */
export function boardModel(ref: string): BoardModel {
  const cached = boardCache.get(ref);
  if (cached !== undefined) return cached;
  const canonical = canonicalBoard(ref);
  const economy = canonical.board.economyProfile;
  const sets = economy.sets.map((set, index): SetModel => {
    const style = SET_STYLES[index % SET_STYLES.length] as readonly [string, Pattern];
    const propertyIds = new Set(set.properties.map((property) => property.id));
    return {
      setId: set.id,
      country: set.country,
      code: set.country.length <= 9 ? set.country.toUpperCase() : set.id,
      color: style[0],
      pattern: style[1],
      tileIndexes: economy.tiles.filter((tile) => tile.type === "property" && propertyIds.has(tile.propertyId))
        .map((tile) => tile.index),
    };
  });
  const tiles = economy.tiles.map((tile): TileModel => {
    const base = { index: tile.index, set: null, property: null, corner: null, deck: null, taxAmount: null, price: null };
    switch (tile.type) {
      case "property": {
        const set = economy.sets.find((candidate) => candidate.properties.some((property) => property.id === tile.propertyId));
        const property = set?.properties.find((candidate) => candidate.id === tile.propertyId) ?? null;
        return {
          ...base, kind: "property", name: property?.name ?? tile.propertyId, price: property?.price ?? null, property,
          set: sets.find((candidate) => candidate.setId === set?.id) ?? null,
        };
      }
      case "corner":
        return { ...base, kind: "corner", name: tile.name, corner: CORNERS[tile.name] ?? null };
      case "transit":
        return { ...base, kind: "transit", name: tile.name, price: economy.transit.price };
      case "utility":
        return { ...base, kind: "utility", name: tile.name, price: economy.utility.price };
      case "tax":
        return { ...base, kind: "tax", name: tile.name, taxAmount: tile.amount };
      case "card":
        return { ...base, kind: "card", name: tile.deck === "surprise" ? "Surprise" : "Treasure", deck: tile.deck };
      case "grand-special":
        return { ...base, kind: "special", name: tile.name.replace("/", " / ") };
    }
  });
  const model: BoardModel = {
    ref,
    label: economy.kind === "grand" ? "World Tour Grand" : "World Tour Standard",
    tiles,
    sets,
    cardCopy: canonical.cardCopy,
    transit: economy.transit,
    utility: economy.utility,
    startSalary: economy.startSalary,
  };
  boardCache.set(ref, model);
  return model;
}

const AIRPORTS = new Set(["Heathrow", "Changi"]);

/** Colour band and code per tile, from the Design TYPE_META (icons live in icons.tsx). */
export function tileBand(tile: TileModel): Readonly<{ color: string; code: string; pattern: Pattern }> | null {
  switch (tile.kind) {
    case "property":
      return tile.set === null ? null : { color: tile.set.color, code: tile.set.code, pattern: tile.set.pattern };
    case "transit":
      return AIRPORTS.has(tile.name)
        ? { color: "#2C3540", code: "AIRPORT", pattern: "solid" }
        : { color: "#2C3540", code: "RAILWAY", pattern: "solid" };
    case "utility":
      return tile.name.includes("Water")
        ? { color: "#55616E", code: "WATER", pattern: "solid" }
        : { color: "#55616E", code: "POWER", pattern: "solid" };
    case "tax":
      return { color: "#B3271A", code: "CUSTOMS", pattern: "solid" };
    case "card":
      return tile.deck === "treasure"
        ? { color: "#2E7D5B", code: "TREASURE", pattern: "solid" }
        : { color: "#C08A2E", code: "SURPRISE", pattern: "solid" };
    case "special":
      return { color: "#7A4E9E", code: "EXCHANGE", pattern: "solid" };
    case "corner":
      return null;
  }
}

/** Hand-picked break points for the boards' long words (the tile set is fixed canonical data). */
const BREAKS: Readonly<Record<string, readonly [string, string]>> = {
  Johannesburg: ["Johannes", "burg"], Guadalajara: ["Guadala", "jara"], Casablanca: ["Casa", "blanca"],
  Marrakesh: ["Marra", "kesh"], Melbourne: ["Mel", "bourne"], Barcelona: ["Barce", "lona"], Vancouver: ["Van", "couver"],
  Heathrow: ["Heath", "row"], Brasilia: ["Bra", "silia"], Montreal: ["Mont", "real"],
};

/**
 * Tile name text and a font scale so no word breaks mid-letter: long words get a soft hyphen at
 * a real syllable, and anything still wider than `capacity` characters is scaled down.
 */
export function fitName(name: string, capacity: number): Readonly<{ text: string; fit: number }> {
  let widest = 1;
  const text = name.split(/\s+/).map((word) => {
    const parts = BREAKS[word];
    if (parts === undefined || word.length <= capacity) {
      widest = Math.max(widest, word.length);
      return word;
    }
    widest = Math.max(widest, parts[0].length + 1, parts[1].length);
    return parts[0] + "\u00AD" + parts[1];
  }).join(" ");
  return { text, fit: Math.min(1, capacity / widest) };
}

export function money(amount: number): string {
  return (amount < 0 ? "-$" : "$") + Math.abs(amount).toLocaleString("en-US");
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== "");
  const letters = words.length > 1 ? (words[0]?.[0] ?? "") + (words[1]?.[0] ?? "") : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Initials colour with AA contrast on a token colour: ink on light tokens, white otherwise. */
export function textOn(hex: string): string {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.25 ? "#1B2129" : "#FFFFFF";
}

export function playerColor(seatIndex: number): string {
  return PLAYER_COLORS[seatIndex % PLAYER_COLORS.length] as string;
}

export interface PlayerModel {
  readonly userId: string;
  readonly name: string;
  readonly initials: string;
  readonly color: string;
  readonly seatIndex: number;
  readonly cash: number;
  readonly netWorth: number;
  readonly deeds: number;
  readonly active: boolean;
  readonly bankrupt: boolean;
  readonly inHolding: boolean;
  readonly connected: boolean;
  readonly away: boolean;
  readonly teamId: string | null;
  /** Cosmetic token ring colour (looks only). */
  readonly ring: string | null;
}

export function nameOf(room: RoomView, userId: string): string {
  return room.members.find((member) => member.userId === userId)?.displayName ?? "Player";
}

function assetValue(board: BoardModel, asset: AssetState): number {
  const tile = board.tiles[asset.tileIndex];
  if (tile === undefined) return 0;
  const property = tile.property;
  const mortgage = property?.mortgageValue ?? (asset.kind === "TRANSIT" ? board.transit.mortgageValue : board.utility.mortgageValue);
  const build = asset.kind === "PROPERTY" && property !== null ? asset.developmentLevel * property.buildingSellBack : 0;
  return (asset.mortgaged ? 0 : mortgage) + build;
}

/** Players in seat order with the figures the HUD shows. Net worth counts liquidation value. */
export function playerModels(game: ProjectedGameState, room: RoomView, board: BoardModel): readonly PlayerModel[] {
  return [...game.players].sort((a, b) => a.seatIndex - b.seatIndex).map((player) => {
    const member = room.members.find((candidate) => candidate.userId === player.userId);
    const owned = game.assets.filter((asset) => asset.ownerUserId === player.userId);
    const name = member?.displayName ?? "Player";
    return {
      userId: player.userId,
      name,
      initials: initials(name),
      color: playerColor(player.seatIndex),
      seatIndex: player.seatIndex,
      cash: player.cash,
      netWorth: player.cash + owned.reduce((sum, asset) => sum + assetValue(board, asset), 0),
      deeds: owned.length,
      active: game.turn?.activePlayerId === player.userId && game.phase === "ACTIVE_TURN",
      bankrupt: player.status === "BANKRUPT",
      inHolding: player.inHolding,
      connected: member?.connected ?? false,
      away: member?.away ?? false,
      teamId: game.settings.teams.find((team) => team.memberUserIds.includes(player.userId))?.teamId ?? null,
      ring: member?.ring ?? null,
    };
  });
}

export interface CommandIntent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ActionButton {
  readonly label: string;
  readonly intent: CommandIntent;
  readonly disabledReason?: string;
}

export interface TurnModel {
  readonly kicker: string;
  readonly requirement: string;
  readonly primary: ActionButton | null;
  readonly secondary: readonly ActionButton[];
  readonly isMine: boolean;
}

function tileName(board: BoardModel, index: number): string {
  return board.tiles[index]?.name ?? "tile " + index;
}

/** The turn panel for this viewer: what is being waited on and the legal next steps. */
export function turnModel(game: ProjectedGameState, room: RoomView, board: BoardModel, viewerUserId: string): TurnModel {
  const turn = game.turn;
  if (game.phase !== "ACTIVE_TURN" || turn === null) {
    return { kicker: "Match", requirement: game.phase === "GAME_OVER" ? "The match is over." : "Starting.", primary: null, secondary: [], isMine: false };
  }
  const activeName = nameOf(room, turn.activePlayerId);
  const isMine = turn.activePlayerId === viewerUserId;
  const me = game.players.find((player) => player.userId === viewerUserId);
  const pending = game.pendingResolution;
  const waiting = (requirement: string): TurnModel => ({ kicker: activeName + "'s turn", requirement, primary: null, secondary: [], isMine });
  if (room.paused) return waiting("The host paused the match. Clocks are frozen.");
  if (game.auction !== null) {
    return waiting("Auction for " + assetName(game, board, game.auction.assetId) + " in progress.");
  }
  if (pending !== null && pending.obligation !== null) {
    const debtor = nameOf(room, pending.obligation.debtorUserId);
    return waiting(pending.obligation.debtorUserId === viewerUserId
      ? "Raise " + money(pending.obligation.amount - (me?.cash ?? 0)) + " more to cover " + money(pending.obligation.amount) + ", or declare bankruptcy."
      : debtor + " owes " + money(pending.obligation.amount) + " and is raising cash.");
  }
  if (!isMine || me === undefined) {
    if (pending?.kind === "BUY_DECISION") return waiting(activeName + " is deciding on " + tileName(board, pending.source.type === "TILE" ? pending.source.tileIndex : 0) + ".");
    return waiting(turn.hasRolled && !turn.rollAgain ? activeName + " is managing deeds or ending the turn." : activeName + " is about to roll.");
  }
  const mine = (requirement: string, primary: ActionButton | null, secondary: readonly ActionButton[] = []): TurnModel => ({
    kicker: "Your turn", requirement, primary, secondary, isMine: true,
  });
  if (pending?.kind === "BUY_DECISION" && pending.source.type === "TILE") {
    const tile = board.tiles[pending.source.tileIndex];
    const price = tile?.price ?? 0;
    return mine(
      (tile?.name ?? "This deed") + " is unowned. Buy it, or decline and it goes to auction.",
      {
        label: "Buy for " + money(price),
        intent: { type: "BUY_PROPERTY", payload: { resolutionId: pending.resolutionId } },
        ...(me.cash < price ? { disabledReason: "Not enough cash" } : {}),
      },
      [{ label: "Decline, auction it", intent: { type: "DECLINE_PROPERTY", payload: { resolutionId: pending.resolutionId } } }],
    );
  }
  if (pending?.kind === "CARD") {
    const deck = pending.source.type === "TILE" ? board.tiles[pending.source.tileIndex]?.deck : null;
    return mine("You landed on a card tile. Draw to resolve it.", {
      label: "Draw " + (deck === "treasure" ? "Treasure" : "Surprise"),
      intent: { type: "DRAW_CARD", payload: { resolutionId: pending.resolutionId } },
    });
  }
  if (pending !== null) return mine("Resolving " + pending.kind.toLowerCase().replace("_", " ") + ".", null);
  if (me.inHolding && !turn.hasRolled) {
    const fee = CANDIDATE_RULES.holdingReleaseFee;
    const card = game.ruleState.heldCards.find((held) => held.ownerUserId === viewerUserId && held.capability === "DETENTION_RELEASE");
    const secondary: ActionButton[] = [{
      label: "Pay " + money(fee),
      intent: { type: "PAY_HOLDING_FEE", payload: {} },
      ...(me.cash < fee ? { disabledReason: "Not enough cash" } : {}),
    }];
    if (card !== undefined) secondary.push({ label: "Use release card", intent: { type: "USE_RELEASE_CARD", payload: { cardId: card.cardId } } });
    return mine(
      "You are in Holding. Roll doubles to leave free (attempt " + (me.holdingAttempts + 1) + " of 3), or pay " + money(fee) + ".",
      { label: "Roll for doubles", intent: { type: "ROLL_DICE", payload: {} } },
      secondary,
    );
  }
  if (!turn.hasRolled || turn.rollAgain) {
    return mine(turn.rollAgain ? "Doubles. Roll again." : "Roll to move. You can manage deeds or trade before rolling.", {
      label: turn.rollAgain ? "Roll again" : "Roll dice", intent: { type: "ROLL_DICE", payload: {} },
    });
  }
  return mine("Build, mortgage or trade, then end your turn.", { label: "End turn", intent: { type: "END_TURN", payload: {} } });
}

export interface DeedModel {
  readonly tile: TileModel;
  readonly asset: AssetState | null;
  readonly ownerUserId: string | null;
  readonly rentRows: readonly (readonly [string, string, boolean])[];
  readonly costRows: readonly (readonly [string, string])[];
  readonly actions: readonly ActionButton[];
}

function setAssets(game: ProjectedGameState, board: BoardModel, tile: TileModel): readonly AssetState[] {
  const indexes = new Set(tile.set?.tileIndexes ?? []);
  return game.assets.filter((asset) => indexes.has(asset.tileIndex));
}

function level(asset: AssetState): number {
  return asset.kind === "PROPERTY" ? asset.developmentLevel : 0;
}

/** Deed panel data and the owner's legal management actions for one tile. */
export function deedModel(game: ProjectedGameState, board: BoardModel, tileIndex: number, viewerUserId: string | null): DeedModel | null {
  const tile = board.tiles[tileIndex];
  if (tile === undefined || !["property", "transit", "utility"].includes(tile.kind)) return null;
  const asset = game.assets.find((candidate) => candidate.tileIndex === tileIndex) ?? null;
  const owner = asset?.ownerUserId ?? null;
  const rentRows: [string, string, boolean][] = [];
  const costRows: [string, string][] = [];
  if (tile.property !== null) {
    const property = tile.property;
    const lvl = asset === null ? 0 : level(asset);
    const complete = asset !== null && owner !== null && setAssets(game, board, tile).every((candidate) => candidate.ownerUserId === owner);
    rentRows.push(["Rent", money(property.baseRent), lvl === 0 && !complete]);
    rentRows.push(["Complete set", money(property.completeSetRent), lvl === 0 && complete]);
    property.developmentRents.forEach((rent, index) => {
      rentRows.push([index === 3 ? "Landmark" : "Building " + (index + 1), money(rent), lvl === index + 1]);
    });
    costRows.push(["Price", money(property.price)], ["Build", money(property.buildingCost)],
      ["Mortgage", money(property.mortgageValue)], ["Unmortgage", money(property.unmortgageCost)]);
  } else if (tile.kind === "transit") {
    const count = owner === null ? 0 : game.assets.filter((candidate) => candidate.kind === "TRANSIT" && candidate.ownerUserId === owner && !candidate.mortgaged).length;
    board.transit.rents.forEach((rent, index) => rentRows.push([(index + 1) + " owned", money(rent), count === index + 1]));
    costRows.push(["Price", money(board.transit.price)], ["Mortgage", money(board.transit.mortgageValue)], ["Unmortgage", money(board.transit.unmortgageCost)]);
  } else {
    const count = owner === null ? 0 : game.assets.filter((candidate) => candidate.kind === "UTILITY" && candidate.ownerUserId === owner && !candidate.mortgaged).length;
    board.utility.rentMultipliers.forEach((multiplier, index) => rentRows.push([(index + 1) + " owned", multiplier + "x dice", count === index + 1]));
    costRows.push(["Price", money(board.utility.price)], ["Mortgage", money(board.utility.mortgageValue)], ["Unmortgage", money(board.utility.unmortgageCost)]);
  }
  return { tile, asset, ownerUserId: owner, rentRows, costRows, actions: asset === null ? [] : deedActions(game, board, tile, asset, viewerUserId) };
}

function deedActions(game: ProjectedGameState, board: BoardModel, tile: TileModel, asset: AssetState, viewerUserId: string | null): ActionButton[] {
  const turn = game.turn;
  const me = game.players.find((player) => player.userId === viewerUserId);
  if (me === undefined || asset.ownerUserId !== me.userId || turn?.activePlayerId !== me.userId || game.phase !== "ACTIVE_TURN") return [];
  const pending = game.pendingResolution;
  const inDebt = pending?.obligation?.debtorUserId === me.userId;
  const free = pending === null && game.auction === null;
  const liquidation = free || inDebt;
  const payload = { assetId: asset.assetId };
  const actions: ActionButton[] = [];
  const setMembers = setAssets(game, board, tile);
  const levels = setMembers.map(level);
  if (asset.kind === "PROPERTY" && tile.property !== null) {
    const property = tile.property;
    if (free && asset.developmentLevel < 4) {
      const reason = me.inHolding ? "Not while in Holding"
        : !setMembers.every((candidate) => candidate.ownerUserId === me.userId) ? "Own the full set first"
        : setMembers.some((candidate) => candidate.mortgaged) ? "Unmortgage the set first"
        : asset.developmentLevel !== Math.min(...levels) ? "Build evenly across the set"
        : turn.developmentActionsUsed >= 2 ? "Two builds per turn"
        : me.cash < property.buildingCost ? "Not enough cash"
        : null;
      actions.push({
        label: (asset.developmentLevel === 3 ? "Build landmark " : "Build ") + money(property.buildingCost),
        intent: { type: "BUILD", payload },
        ...(reason === null ? {} : { disabledReason: reason }),
      });
    }
    if (liquidation && asset.developmentLevel > 0) {
      actions.push({
        label: "Sell building +" + money(property.buildingSellBack),
        intent: { type: "SELL_DEVELOPMENT", payload },
        ...(asset.developmentLevel !== Math.max(...levels) ? { disabledReason: "Sell evenly across the set" } : {}),
      });
    }
  }
  const mortgageValue = tile.property?.mortgageValue ?? (asset.kind === "TRANSIT" ? board.transit.mortgageValue : board.utility.mortgageValue);
  const unmortgageCost = tile.property?.unmortgageCost ?? (asset.kind === "TRANSIT" ? board.transit.unmortgageCost : board.utility.unmortgageCost);
  if (liquidation && !asset.mortgaged) {
    actions.push({
      label: "Mortgage +" + money(mortgageValue),
      intent: { type: "MORTGAGE", payload },
      ...(asset.kind === "PROPERTY" && levels.some((value) => value > 0) ? { disabledReason: "Sell the set's buildings first" } : {}),
    });
  }
  if (free && asset.mortgaged) {
    actions.push({
      label: "Unmortgage " + money(unmortgageCost),
      intent: { type: "UNMORTGAGE", payload },
      ...(me.cash < unmortgageCost ? { disabledReason: "Not enough cash" } : {}),
    });
  }
  return actions;
}

/** Whether an asset can go into a trade (no buildings anywhere in its set, not being resolved). */
export function tradeable(game: ProjectedGameState, board: BoardModel, asset: AssetState): boolean {
  const tile = board.tiles[asset.tileIndex];
  if (tile === undefined) return false;
  const pending = game.pendingResolution;
  if (pending?.source.type === "TILE" && pending.source.tileIndex === asset.tileIndex) return false;
  return tile.set === null || setAssets(game, board, tile).every((candidate) => level(candidate) === 0);
}

/** Face value used for the trade deal tray: the deed's price. */
export function assetFaceValue(board: BoardModel, asset: AssetState): number {
  return board.tiles[asset.tileIndex]?.price ?? 0;
}

type Names = (userId: string) => string;

function assetName(game: ProjectedGameState, board: BoardModel, assetId: string): string {
  const asset = game.assets.find((candidate) => candidate.assetId === assetId);
  return asset === undefined ? assetId : tileName(board, asset.tileIndex);
}

function auctionLines(game: ProjectedGameState, board: BoardModel, names: Names, facts: readonly AuctionFact[]): string[] {
  return facts.flatMap((fact): string[] => {
    const lot = assetName(game, board, fact.assetId);
    const who = fact.actorUserId === null ? "" : names(fact.actorUserId);
    switch (fact.type) {
      case "STARTED": return ["Auction opened for " + lot + "."];
      case "BID": return [who + " bid " + money(fact.amount ?? 0) + "."];
      case "PASS": return [who + " is not interested."];
      case "WINNER": return [who + " won " + lot + " for " + money(fact.amount ?? 0) + "."];
      case "NO_BID": return ["No bids. " + lot + " stays with the bank."];
    }
  });
}

/** Human log lines for one committed event (UI-015 game log). */
export function describeEvent(event: GameplayEvent, game: ProjectedGameState, board: BoardModel, names: Names): string[] {
  switch (event.type) {
    case "GAME_STARTED":
      return ["The match started. " + names(event.activePlayerId) + " rolls first."];
    case "MATCH_CONFIGURED":
      return [];
    case "DICE_ROLLED": {
      const who = names(event.playerId);
      const dice = event.roll.dice[0] + " and " + event.roll.dice[1];
      if (event.holding === "ATTEMPT_FAILED") return [who + " rolled " + dice + ". No doubles, still in Holding."];
      if (event.holding === "FEE_DUE") return [who + " rolled " + dice + " on the last attempt and owes the Holding fee."];
      if (event.movement === null) return [who + " rolled a third double and went to Holding."];
      const lines = [who + " rolled " + dice + " and moved to " + tileName(board, event.movement.to) + "."];
      if (event.movement.startAward > 0) lines.push(who + " collected " + money(event.movement.startAward) + " at Start.");
      if (event.holding === "ENTERED") lines.push(who + " was sent to Holding.");
      if (event.resolution?.kind === "TAX") lines.push(who + " was charged " + money(event.resolution.amount) + " at " + tileName(board, event.resolution.tileIndex) + ".");
      return lines;
    }
    case "TURN_ENDED":
      return [names(event.activePlayerId) + "'s turn."];
    case "PROPERTY_BOUGHT":
      return [names(event.playerId) + " bought " + assetName(game, board, event.assetId) + " for " + money(event.price) + "."];
    case "PROPERTY_DECLINED":
      return [names(event.playerId) + " declined " + assetName(game, board, event.assetId) + ".", ...auctionLines(game, board, names, event.facts)];
    case "AUCTION_UPDATED":
      return auctionLines(game, board, names, event.facts);
    case "DEVELOPMENT_BOUGHT":
      return [names(event.playerId) + (event.level === 4 ? " raised a landmark on " : " built on ") + assetName(game, board, event.assetId) + " for " + money(event.price) + "."];
    case "DEVELOPMENT_SOLD":
      return [names(event.playerId) + " sold a building on " + assetName(game, board, event.assetId) + " for " + money(event.amount) + "."];
    case "ASSET_MORTGAGED":
      return [names(event.playerId) + " mortgaged " + assetName(game, board, event.assetId) + " for " + money(event.amount) + "."];
    case "ASSET_UNMORTGAGED":
      return [names(event.playerId) + " paid " + money(event.amount) + " to unmortgage " + assetName(game, board, event.assetId) + "."];
    case "CARD_RESOLVED": {
      const lines = event.drawnCardIds.map((cardId) => names(event.playerId) + " drew " + (board.cardCopy[cardId]?.title ?? "a card") + ".");
      if (event.startAward > 0) lines.push(names(event.playerId) + " collected " + money(event.startAward) + " at Start.");
      return lines;
    }
    case "HOLDING_RELEASED":
      return [names(event.playerId) + (event.method === "FEE" ? " paid " + money(CANDIDATE_RULES.holdingReleaseFee) + " to leave Holding." : " used a release card to leave Holding.")];
    case "TRADE_UPDATED": {
      const fact = event.fact;
      const verb = { PROPOSED: " proposed a trade to ", COUNTERED: " countered a trade from ", ACCEPTED: " accepted a trade with ", REJECTED: " rejected a trade from ", CANCELLED: " withdrew a trade to ", VOIDED: " had a trade voided with " }[fact.type];
      const other = fact.actorUserId === fact.proposerUserId ? fact.recipientUserId : fact.proposerUserId;
      const lines = [names(fact.actorUserId) + verb + names(other) + "."];
      if (event.incident !== null) lines.push(incidentLine(event.incident.consequence, names(event.incident.giverUserId), names(event.incident.receiverUserId)));
      for (const removal of event.eliminations) lines.push(names(removal.userId) + " was removed by the Collusion Guard.");
      return lines;
    }
    case "CLOCKS_RESUMED":
      return ["The match resumed."];
    case "TURN_AUTO_PLAYED":
      return [names(event.playerId) + "'s time ran out. The turn was auto-played.", ...event.steps.flatMap((step) => describeEvent(step, game, board, names))];
    case "PLAYER_BANKRUPT": {
      const how = { REMOVED: " was removed by the Collusion Guard.", RESIGNED: " resigned.", DECLARED: " went bankrupt.", DEADLINE: " went bankrupt." }[event.fact.reason];
      const lines = [names(event.fact.userId) + how];
      for (const incident of event.incidents) lines.push(incidentLine(incident.consequence, names(incident.giverUserId), names(incident.receiverUserId)));
      for (const removal of event.removals) lines.push(names(removal.userId) + " was removed by the Collusion Guard.");
      if (event.outcome !== null) lines.push(event.outcome.winnerUserIds.map(names).join(" and ") + (event.outcome.winnerUserIds.length > 1 ? " win the match." : " wins the match."));
      return lines;
    }
  }
}

function incidentLine(consequence: "WARNING" | "REMOVAL", giver: string, receiver: string): string {
  return consequence === "WARNING"
    ? "Fair-play warning: a lopsided trade from " + giver + " to " + receiver + "."
    : "Fair-play removal: repeated lopsided trades between " + giver + " and " + receiver + ".";
}

/** Final standings, best first, from the authoritative outcome. */
export function standings(game: ProjectedGameState, players: readonly PlayerModel[]): readonly PlayerModel[] {
  const order = game.ruleState.outcome?.placements ?? players.map((player) => player.userId);
  return order.map((userId) => players.find((player) => player.userId === userId)).filter((player): player is PlayerModel => player !== undefined);
}
