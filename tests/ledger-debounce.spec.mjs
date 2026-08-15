import { describe, it, expect } from "vitest";
import C from "../renderer/core.js";

describe("growth ledger", () => {
  it("levelFor follows the expected curve (Lv.2 @50, Lv.3 @150)", () => {
    expect(C.levelFor(0)).toBe(1);
    expect(C.levelFor(49)).toBe(1);
    expect(C.levelFor(50)).toBe(2);
    expect(C.levelFor(149)).toBe(2);
    expect(C.levelFor(150)).toBe(3);
  });

  it("addXp reports level-ups and mutates xp", () => {
    const ledger = { ...C.DEFAULT_LEDGER, xp: 20 };
    expect(C.addXp(ledger, 5)).toBe(false); // 25 -> still Lv.1
    const ledger2 = { ...C.DEFAULT_LEDGER, xp: 45 };
    expect(C.addXp(ledger2, 5)).toBe(true); // 50 -> Lv.2
    expect(C.addXp(ledger2, 5)).toBe(false); // 55 -> still Lv.2
  });

  it("unlocks titles by thresholds and returns their names once", () => {
    const ledger = { ...C.DEFAULT_LEDGER, feeds: 1 };
    expect(C.checkTitles(ledger)).toEqual(["初次投喂"]);
    expect(C.checkTitles(ledger)).toEqual([]); // already unlocked
    ledger.feeds = 20;
    expect(C.checkTitles(ledger)).toEqual(["常客"]);
    ledger.plays = 30;
    expect(C.checkTitles(ledger)).toEqual(["玩伴"]);
  });

  it("activeMs unlocks the loyalty title", () => {
    const ledger = { ...C.DEFAULT_LEDGER, activeMs: 6 * 3_600_000 };
    expect(C.checkTitles(ledger)).toContain("常驻伙伴");
  });
});

describe("debounceTransition (min-hold)", () => {
  const now = 1_000_000;
  it("passes transitions after the hold window", () => {
    expect(C.debounceTransition("idle", "think", now - 500, now, 300)).toBe("idle");
    expect(C.debounceTransition(null, "think", now - 500, now)).toBeNull();
  });

  it("suppresses flips that arrive too soon after the current state began", () => {
    expect(C.debounceTransition("think", "idle", now - 50, now, 300)).toBeNull();
  });

  it("never suppresses same-state or null transitions", () => {
    expect(C.debounceTransition("idle", "idle", now - 1, now, 300)).toBe("idle");
    expect(C.debounceTransition(null, "idle", now - 1, now)).toBeNull();
  });
});
