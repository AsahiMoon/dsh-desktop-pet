import { describe, it, expect } from "vitest";
import C from "../renderer/core.js";

const NOW = new Date(2026, 7, 15, 23, 45).getTime(); // 23:45

const base = {
  taskState: { phase: "idle", tool: null, label: null, todos: [] },
  currentTodos: [],
  taskHistory: [],
  runHistory: [],
  state: "idle",
  now: NOW,
};

describe("fmtTime", () => {
  it("formats [HH:MM] zero-padded", () => {
    expect(C.fmtTime(new Date(2026, 0, 1, 9, 5).getTime())).toBe("09:05");
    expect(C.fmtTime(NOW)).toBe("23:45");
  });
});

describe("hoverText (brief)", () => {
  it("shows time + status, no growth stats", () => {
    const ctx = {
      ...base,
      taskState: { phase: "exec", tool: "pwsh", label: "测试", todos: [] },
      currentTodos: [
        { content: "甲", status: "completed" },
        { content: "乙", status: "in_progress" },
      ],
    };
    const text = C.hoverText(ctx);
    expect(text).toBe("[23:45] 🛠️ 执行中 pwsh\n📋 1/2 · 乙");
    expect(text).not.toMatch(/Lv\.|投喂|玩耍|陪伴/);
  });

  it("idle shows 空闲中, sleep shows 💤", () => {
    expect(C.hoverText(base)).toBe("[23:45] 空闲中");
    expect(C.hoverText({ ...base, state: "sleep" })).toBe("[23:45] 💤 睡觉中");
  });
});

describe("detailedText", () => {
  it("shows current tool + progress + completed steps", () => {
    const text = C.detailedText({
      ...base,
      taskState: { phase: "exec", tool: "pwsh", label: "运行", todos: [] },
      currentTodos: [
        { content: "调研方案", status: "completed" },
        { content: "编写代码", status: "completed" },
        { content: "验收", status: "in_progress" },
      ],
    });
    expect(text).toContain("[23:45] 🛠️ 执行中 · pwsh");
    expect(text).toContain("📋 2/3 正在验收");
    expect(text).toContain("✅");
  });

  it("shows the tool's actual target (file path) in the detailed view", () => {
    const text = C.detailedText({
      ...base,
      taskState: { phase: "exec", tool: "read", label: "📖 读文件", detail: "F:\\AI_workspace\\src\\main.js", todos: [] },
    });
    expect(text).toContain("[23:45] 🛠️ 执行中 · read");
    expect(text).toContain("📎 F:\\AI_workspace\\src\\main.js");
  });

  it("brief view appends the target to the tool note", () => {
    const text = C.hoverText({
      ...base,
      taskState: { phase: "exec", tool: "pwsh", label: "", detail: "npm test", todos: [] },
    });
    expect(text).toBe("[23:45] 🛠️ 执行中 pwsh · npm test");
  });

  it("stale detail is not shown outside the exec phase", () => {
    const text = C.detailedText({
      ...base,
      taskState: { phase: "think", tool: "read", label: "", detail: "F:\\old\\path.js", todos: [] },
    });
    expect(text).not.toContain("📎");
    expect(text).not.toContain("old\\path");
  });

  it("idle shows the executed tools, fallback to completed tasks", () => {
    expect(C.detailedText({ ...base, runHistory: ["pwsh", "read_file"] })).toBe(
      "[23:45] 空闲中\n🛠️ 已执行：read_file · pwsh",
    );
    expect(C.detailedText({ ...base, taskHistory: ["修复打包"] })).toBe(
      "[23:45] 空闲中\n✅ 已完成：修复打包",
    );
  });

  it("sleep note", () => {
    expect(C.detailedText({ ...base, state: "sleep" })).toBe("[23:45] 💤 睡觉中");
  });
});

describe("persistText", () => {
  it("brief delegates to hover; detailed delegates to detailed", () => {
    const ctx = { ...base, taskState: { phase: "exec", tool: "pwsh", label: "", todos: [] } };
    expect(C.persistText({ ...ctx, detailed: false })).toBe(C.hoverText(ctx));
    expect(C.persistText({ ...ctx, detailed: true })).toBe(C.detailedText(ctx));
  });
});
