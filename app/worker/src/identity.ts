/**
 * AUTH-001 / DATA-001 identity: Google `sub` -> stable internal `userId` in D1.
 * The internal id is a random UUID minted on first login, so no Google identifier ever
 * appears in game state, sessions, or other players' views.
 */

export interface UserRecord {
  readonly userId: string;
  readonly displayName: string;
}

export interface IdentityStore {
  /** Finds or creates the user for a verified Google `sub`, refreshing name and login time. */
  loginWithGoogle(sub: string, displayName: string, now: number): Promise<UserRecord>;
  get(userId: string): Promise<UserRecord | null>;
}

const MAX_NAME_LENGTH = 32;

/** Trimmed, control-free, single-spaced, at most 32 characters; never empty. */
export function sanitizeDisplayName(raw: string | undefined): string {
  const printable = Array.from(raw ?? "").filter((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point >= 0x20 && point !== 0x7f;
  }).join("");
  const cleaned = printable.replace(/\s+/g, " ").trim();
  const clipped = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("").trim();
  return clipped === "" ? "Player" : clipped;
}

interface UserRow extends Record<string, unknown> {
  user_id: string;
  display_name: string;
}

export function d1Identity(db: D1Database, newId: () => string = () => crypto.randomUUID()): IdentityStore {
  return {
    async loginWithGoogle(sub, displayName, now) {
      const name = sanitizeDisplayName(displayName);
      // Insert-or-ignore then update keeps first-login creation atomic under concurrent callbacks.
      await db.batch([
        db.prepare(
          `INSERT INTO users (user_id, google_sub, display_name, created_at, last_login_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (google_sub) DO NOTHING`,
        ).bind(newId(), sub, name, now, now),
        db.prepare(`UPDATE users SET display_name = ?, last_login_at = ? WHERE google_sub = ?`)
          .bind(name, now, sub),
      ]);
      const row = await db.prepare(`SELECT user_id, display_name FROM users WHERE google_sub = ?`)
        .bind(sub).first<UserRow>();
      if (row === null) throw new Error("user row missing after login");
      return { userId: row.user_id, displayName: row.display_name };
    },
    async get(userId) {
      const row = await db.prepare(`SELECT user_id, display_name FROM users WHERE user_id = ?`)
        .bind(userId).first<UserRow>();
      return row === null ? null : { userId: row.user_id, displayName: row.display_name };
    },
  };
}
