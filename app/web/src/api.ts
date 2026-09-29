import type { CosmeticKind, ProfileActionResult, ProfileView } from "@moneygame/shared";

/** Thin same-origin HTTP calls. Identity always comes from the server session cookie. */

export interface Me {
  readonly userId: string;
  readonly displayName: string;
}

export async function getMe(): Promise<Me | null> {
  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    return response.ok ? (await response.json()) as Me : null;
  } catch {
    return null;
  }
}

export type CreateRoomResult = { readonly roomCode: string } | { readonly error: string };

export async function createRoom(): Promise<CreateRoomResult> {
  try {
    const response = await fetch("/api/rooms", { method: "POST", credentials: "same-origin" });
    const body = (await response.json()) as { roomCode?: string; error?: string };
    return body.roomCode !== undefined ? { roomCode: body.roomCode } : { error: body.error ?? "UNAVAILABLE" };
  } catch {
    return { error: "UNAVAILABLE" };
  }
}

export function loginUrl(roomCode: string | null): string {
  return "/auth/login" + (roomCode === null ? "" : "?room=" + encodeURIComponent(roomCode));
}

/** Room codes as the worker accepts them (letters and digits), upper-cased. */
export function cleanRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null;
}

export async function getProfile(): Promise<ProfileView | null> {
  try {
    const response = await fetch("/api/profile", { credentials: "same-origin" });
    return response.ok ? (await response.json()) as ProfileView : null;
  } catch {
    return null;
  }
}

async function profileAction(path: string, body: unknown): Promise<ProfileActionResult | null> {
  try {
    const response = await fetch(path, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return response.status === 200 || response.status === 409 ? (await response.json()) as ProfileActionResult : null;
  } catch {
    return null;
  }
}

export const purchaseCosmetic = (itemId: string) => profileAction("/api/profile/purchase", { itemId });
export const equipCosmetic = (kind: CosmeticKind, itemId: string | null) => profileAction("/api/profile/equip", { kind, itemId });
