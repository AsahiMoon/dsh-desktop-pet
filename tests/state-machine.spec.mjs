import { describe, it, expect } from "vitest";
import C from "../renderer/core.cjs";

describe("syncNextState (heartbeat transitions)", () => {
  it("exec wakes from ANY sleep (natural nap or post-work rest)", () => {
    expect(C.syncNextState("sleep", true, { exec: true })).toBe("working");
    expect(C.syncNextState("sleep", false, { exec: true })).toBe("working");
  });

  it("exec moves idle -> working, skips a busy walk", () => {
    expect(C.syncNextState("idle", false, { exec: true })).toBe("working");
    expect(C.syncNextState("walk", true, { exec: true })).toBeNull();
    expect(C.syncNextState("idle", true, { exec: true })).toBeNull();
  });

  it("working degrades through think to idle once exec clears", () => {
    expect(C.syncNextState("working", false, { exec: false })).toBe("idle");
    expect(C.syncNextState("working", true, { exec: false })).toBe("idle");
    // with a think flag the machine lands on think instead
    expect(C.syncNextState("working", false, { exec: false, think: true })).toBe("think");
  });

  it("think wakes from sleep; wait requires think; idle clears the busy chain", () => {
    expect(C.syncNextState("sleep", false, { think: true })).toBe("think");
    expect(C.syncNextState("idle", false, { think: true })).toBe("think");
    expect(C.syncNextState("walk", true, { think: true })).toBeNull(); // busy walk
    expect(C.syncNextState("think", false, { wait: true })).toBe("wait");
    expect(C.syncNextState("idle", false, { wait: true })).toBeNull();
    expect(C.syncNextState("think", true, { wait: true })).toBeNull(); // busy
    expect(C.syncNextState("working", false, {})).toBe("idle");
    expect(C.syncNextState("wait", false, {})).toBe("idle");
    expect(C.syncNextState("idle", false, {})).toBeNull(); // stay idle
  });

  it("leaves unrelated states alone", () => {
    expect(C.syncNextState("sleep", false, {})).toBeNull();
    expect(C.syncNextState("celebrate", false, {})).toBeNull();
    expect(C.syncNextState("drag", false, { exec: true })).toBeNull();
  });
});
