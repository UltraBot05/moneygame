import type { AdvancedRuleState } from "./advanced-rules";
import type { FairPlayIncident } from "./integrity";
import type { GameState } from "./state";

export interface PublicDeck {
  readonly deckId: "surprise" | "treasure";
  /** Draw-pile order is secret; only its size is public. */
  readonly drawCount: number;
  /** Discards were revealed when drawn, so their order is public. */
  readonly discardPile: readonly string[];
}

export type PublicRuleState = Omit<AdvancedRuleState, "decks" | "fairPlay"> & {
  readonly decks: readonly PublicDeck[];
  readonly fairPlay: Readonly<{ incidents: readonly FairPlayIncident[] }>;
};

/** Everything a viewer may see of the canonical state. */
export type ProjectedGameState = Omit<GameState, "ruleState"> & { readonly ruleState: PublicRuleState };

/**
 * The only shape in which game state leaves the room (RUNTIME-E1 section 4). Hidden: deck order
 * and the guard's internal lopsided-trade ledger. Fair-play warnings are shown only to the two
 * players involved (INT-001 section 5); removals are public. `viewerUserId` is null for spectators.
 */
export function projectGameState(state: GameState, viewerUserId: string | null): ProjectedGameState {
  const { ruleState, ...rest } = state;
  return {
    ...rest,
    ruleState: {
      ...ruleState,
      decks: ruleState.decks.map((deck) => ({
        deckId: deck.deckId,
        drawCount: deck.drawPile.length,
        discardPile: deck.discardPile,
      })),
      fairPlay: {
        incidents: ruleState.fairPlay.incidents.filter((incident) =>
          incident.consequence === "REMOVAL"
          || incident.giverUserId === viewerUserId
          || incident.receiverUserId === viewerUserId
        ),
      },
    },
  };
}
