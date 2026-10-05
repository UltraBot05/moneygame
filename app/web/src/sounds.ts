import type { GameplayEvent, ProjectedGameState } from "@moneygame/game-core";

/**
 * Game sounds, synthesised with Web Audio (no audio files, nothing to license or download).
 * Sounds follow committed server events, so every player hears the same moments; they never
 * carry information a player could not already see.
 */
export type SoundName = "dice" | "coin" | "build" | "landmark" | "card" | "bid" | "turn" | "alert" | "holding" | "bankrupt" | "win" | "chat";

/** The sounds one committed event makes for this viewer, in order. */
export function soundsFor(event: GameplayEvent, game: ProjectedGameState, viewerUserId: string): SoundName[] {
  switch (event.type) {
    case "GAME_STARTED":
    case "TURN_ENDED":
      return event.activePlayerId === viewerUserId ? ["turn"] : [];
    case "DICE_ROLLED": {
      const sounds: SoundName[] = ["dice"];
      if (event.holding === "ENTERED" || (event.movement === null && event.holding === null)) sounds.push("holding");
      const landed = event.resolution === null ? undefined : game.assets.find((asset) => asset.tileIndex === event.resolution?.tileIndex);
      const owner = landed?.ownerUserId ?? null;
      const rent = owner !== null && owner !== event.playerId;
      if ((event.movement?.startAward ?? 0) > 0 || rent || event.resolution?.kind === "TAX") sounds.push("coin");
      return sounds;
    }
    case "PROPERTY_BOUGHT":
    case "ASSET_MORTGAGED":
    case "ASSET_UNMORTGAGED":
    case "DEVELOPMENT_SOLD":
    case "HOLDING_RELEASED":
      return ["coin"];
    case "DEVELOPMENT_BOUGHT":
      return [event.level === 4 ? "landmark" : "build"];
    case "CARD_RESOLVED":
      return ["card"];
    case "PROPERTY_DECLINED":
    case "AUCTION_UPDATED":
      return ["bid"];
    case "TRADE_UPDATED": {
      const { fact } = event;
      if (event.incident !== null || event.eliminations.length > 0) return ["alert"];
      if (fact.type === "ACCEPTED") return ["coin"];
      const toMe = (fact.type === "PROPOSED" || fact.type === "COUNTERED") && fact.actorUserId !== viewerUserId
        && (fact.recipientUserId === viewerUserId || fact.proposerUserId === viewerUserId);
      return toMe ? ["alert"] : [];
    }
    case "TURN_AUTO_PLAYED":
      return event.steps.flatMap((step) => soundsFor(step, game, viewerUserId));
    case "PLAYER_BANKRUPT":
      return event.outcome === null ? ["bankrupt"] : ["bankrupt", "win"];
    default:
      return [];
  }
}

const STORAGE_KEY = "mg.sound";
let muted = readMuted();
let context: AudioContext | null = null;

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "off" : "on");
  } catch {
    // Storage can be blocked; the choice still holds for this tab.
  }
}

function audio(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  context ??= new AudioContext();
  // Browsers start audio suspended until the first click or key press; this is a no-op after that.
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return context;
}

/** One enveloped oscillator note. */
function tone(ctx: AudioContext, out: AudioNode, at: number, freq: number, length: number, type: OscillatorType, level: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** A filtered noise burst: dice clacks and card swishes. */
function noise(ctx: AudioContext, out: AudioNode, at: number, length: number, from: number, to: number, level: number): void {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.Q.value = 1.4;
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(level, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  source.connect(filter).connect(gain).connect(out);
  source.start(at);
}

/** Notes [frequency, start offset] of one waveform; returns the recipe length. */
function notes(ctx: AudioContext, out: AudioNode, at: number, list: readonly (readonly [number, number])[], length: number, type: OscillatorType, level: number): number {
  for (const [freq, offset] of list) tone(ctx, out, at + offset, freq, length, type, level);
  return (list.at(-1)?.[1] ?? 0) + length;
}

const RECIPES: Readonly<Record<SoundName, (ctx: AudioContext, out: AudioNode, at: number) => number>> = {
  // Clacks timed to the 3D dice tumble, thickest as they land.
  dice: (ctx, out, at) => {
    [0.04, 0.13, 0.24, 0.38, 0.55, 0.66, 0.74].forEach((offset, index) => noise(ctx, out, at + offset, 0.035, 2600, 1800, 0.5 - index * 0.04));
    return 0.8;
  },
  coin: (ctx, out, at) => notes(ctx, out, at, [[1319, 0], [1760, 0.08]], 0.3, "triangle", 0.4),
  build: (ctx, out, at) => notes(ctx, out, at, [[196, 0], [262, 0.1]], 0.08, "square", 0.25),
  landmark: (ctx, out, at) => notes(ctx, out, at, [[523, 0], [659, 0.09], [784, 0.18], [1047, 0.27]], 0.35, "triangle", 0.35),
  card: (ctx, out, at) => {
    noise(ctx, out, at, 0.2, 700, 3200, 0.35);
    return 0.22;
  },
  bid: (ctx, out, at) => notes(ctx, out, at, [[1046, 0]], 0.06, "sine", 0.3),
  turn: (ctx, out, at) => notes(ctx, out, at, [[659, 0], [988, 0.13]], 0.3, "sine", 0.45),
  alert: (ctx, out, at) => notes(ctx, out, at, [[880, 0], [880, 0.16]], 0.18, "triangle", 0.4),
  holding: (ctx, out, at) => notes(ctx, out, at, [[392, 0], [262, 0.15]], 0.35, "sawtooth", 0.18),
  bankrupt: (ctx, out, at) => notes(ctx, out, at, [[392, 0], [330, 0.18], [262, 0.36]], 0.3, "triangle", 0.35),
  win: (ctx, out, at) => notes(ctx, out, at, [[523, 0], [659, 0.11], [784, 0.22], [1047, 0.33], [1319, 0.44]], 0.45, "triangle", 0.35),
  chat: (ctx, out, at) => notes(ctx, out, at, [[1175, 0]], 0.07, "sine", 0.2),
};

/** Creates and unlocks audio; call from a click or key press (browsers block audio before one). */
export function unlockAudio(): void {
  audio();
}

/** Plays sounds one after another. A burst (for example after a reconnect) is capped, not queued. */
export function play(names: readonly SoundName[]): void {
  if (muted || names.length === 0) return;
  const ctx = audio();
  if (ctx === null || ctx.state !== "running") return;
  const master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);
  let at = ctx.currentTime + 0.01;
  for (const name of names.slice(-4)) at += RECIPES[name](ctx, master, at);
}
