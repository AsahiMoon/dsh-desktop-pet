import { describe, it, expect } from "vitest";
import C from "../renderer/core.js";

const fresh = () => ({ phase: "idle", tool: null, label: null, todos: [] });

describe("applyTaskSignal", () => {
  it("tracks exec (phase/tool/label) and records the tool run", () => {
    const ts = fresh();
    const runs = [];
    C.applyTaskSignal(ts, { type: "exec", tool: "pwsh", label: "跑测试" }, [], runs);
    expect(ts.phase).toBe("exec");
    expect(ts.tool).toBe("pwsh");
    expect(runs).toEqual(["pwsh"]);
  });

  it("stores the tool's detail (file path / command) and clears it on idle", () => {
    const ts = fresh();
    C.applyTaskSignal(ts, { type: "exec", tool: "read", label: "📖 读文件", detail: "F:\\a\\b.js" }, [], []);
    expect(ts.detail).toBe("F:\\a\\b.js");
    // sync heartbeat with no activity relaxes to idle and drops the detail
    C.applyTaskSignal(ts, { type: "sync", exec: false, think: false, wait: false, todos: [] }, [], []);
    expect(ts.phase).toBe("idle");
    expect(ts.detail).toBeNull();
  });

  it("drops generic round-complete labels from the completed history", () => {
    const hist = [];
    C.applyTaskSignal(fresh(), { type: "celebrate", label: "回合完成" }, hist, []);
    C.applyTaskSignal(fresh(), { type: "celebrate", label: "回合完成" }, hist, []);
    expect(hist).toEqual([]); // both filtered
    C.applyTaskSignal(fresh(), { type: "celebrate", label: "修复打包" }, hist, []);
    expect(hist).toEqual(["修复打包"]);
  });

  it("records only newly-completed todos (no duplicates)", () => {
    const hist = [];
    const ts = fresh();
    C.applyTaskSignal(ts, { type: "todo", todos: [{ content: "调研", status: "in_progress" }] }, hist, []);
    C.applyTaskSignal(ts, { type: "todo", todos: [{ content: "调研", status: "completed" }] }, hist, []);
    C.applyTaskSignal(ts, { type: "todo", todos: [{ content: "调研", status: "completed" }] }, hist, []);
    expect(hist).toEqual(["调研"]);
    expect(ts.todos[0].status).toBe("completed");
  });

  it("dedupes consecutive tool runs", () => {
    const runs = [];
    C.applyTaskSignal(fresh(), { type: "exec", tool: "read_file" }, [], runs);
    C.applyTaskSignal(fresh(), { type: "exec", tool: "read_file" }, [], runs);
    C.applyTaskSignal(fresh(), { type: "exec", tool: "node" }, [], runs);
    expect(runs).toEqual(["read_file", "node"]);
  });

  it("sync folds phase by priority exec > think > wait > idle", () => {
    const ts = fresh();
    C.applyTaskSignal(ts, { type: "sync", exec: true, think: true, wait: true, todos: [] });
    expect(ts.phase).toBe("exec");
    C.applyTaskSignal(ts, { type: "sync", exec: false, think: true, wait: false, todos: [] });
    expect(ts.phase).toBe("think");
    C.applyTaskSignal(ts, { type: "sync", exec: false, think: false, wait: true, todos: [] });
    expect(ts.phase).toBe("wait");
    C.applyTaskSignal(ts, { type: "sync", exec: false, think: false, wait: false, todos: [] });
    expect(ts.phase).toBe("idle");
  });
});
