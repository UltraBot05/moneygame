import { describe, expect, it } from "vitest";
import { memoryD1 } from "./d1.testkit";
import { d1Identity, sanitizeDisplayName } from "./identity";

describe("DATA-001 identity store", () => {
  it("mints one stable internal id per Google sub and refreshes the name", async () => {
    let next = 0;
    const identity = d1Identity(memoryD1(), () => "user-" + (next += 1));
    const first = await identity.loginWithGoogle("sub-a", "Asha", 1);
    const again = await identity.loginWithGoogle("sub-a", "Asha K", 2);
    const other = await identity.loginWithGoogle("sub-b", "Ben", 3);
    expect(first).toEqual({ userId: "user-1", displayName: "Asha" });
    expect(again).toEqual({ userId: "user-1", displayName: "Asha K" });
    expect(other.userId).toBe("user-3");
    expect(await identity.get("user-1")).toEqual({ userId: "user-1", displayName: "Asha K" });
    expect(await identity.get("missing")).toBeNull();
  });

  it("stores no Google identifier outside the lookup column", async () => {
    const identity = d1Identity(memoryD1(), () => "internal");
    const user = await identity.loginWithGoogle("sub-private", "Cy", 1);
    expect(JSON.stringify(user)).not.toContain("sub-private");
  });

  it.each([
    ["  Asha   Kapoor ", "Asha Kapoor"],
    ["\u0007bell\u0000", "bell"],
    ["", "Player"],
    [undefined, "Player"],
    ["x".repeat(50), "x".repeat(32)],
  ])("sanitises display name %j", (raw, expected) => {
    expect(sanitizeDisplayName(raw)).toBe(expected);
  });
});
