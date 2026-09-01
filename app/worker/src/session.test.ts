import { describe, expect, it } from "vitest";
import {
  clearCookie,
  issueSession,
  parseCookies,
  serializeCookie,
  verifySession,
  SESSION_COOKIE,
} from "./session";

const SECRET = "unit-test-session-secret";
const NOW = 1_700_000_000_000;

describe("app session", () => {
  it("round-trips an issued session", async () => {
    const token = await issueSession("google:123", SECRET, 3600, NOW);
    const session = await verifySession(token, SECRET, NOW);
    expect(session.sub).toBe("google:123");
  });

  it("rejects a tampered payload", async () => {
    const token = await issueSession("google:123", SECRET, 3600, NOW);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "google:attacker", iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");
    await expect(
      verifySession(`${forged}.${sig}`, SECRET, NOW),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    expect(payload).not.toBe(forged);
  });

  it("rejects a wrong-secret signature", async () => {
    const token = await issueSession("google:123", SECRET, 3600, NOW);
    await expect(
      verifySession(token, "different-secret", NOW),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("rejects an expired session", async () => {
    const token = await issueSession("google:123", SECRET, 100, NOW);
    await expect(
      verifySession(token, SECRET, NOW + 200_000),
    ).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("rejects a malformed token", async () => {
    await expect(verifySession("no-dot", SECRET, NOW)).rejects.toMatchObject({
      code: "MALFORMED",
    });
  });
});

describe("cookies", () => {
  it("hardens the session cookie and never scopes a Domain", () => {
    const c = serializeCookie(SESSION_COOKIE, "abc", { maxAgeSec: 604800 });
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=604800");
    expect(c).not.toContain("Domain=");
  });

  it("clears a cookie with Max-Age=0", () => {
    expect(clearCookie(SESSION_COOKIE)).toContain("Max-Age=0");
  });

  it("parses a cookie header", () => {
    const jar = parseCookies("mg_session=v1; mg_txn=v2");
    expect(jar["mg_session"]).toBe("v1");
    expect(jar["mg_txn"]).toBe("v2");
  });
});
