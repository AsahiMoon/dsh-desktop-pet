/** Dev-only probe: drive the chat panel's REAL renderer logic over the IPC
 *  pipeline (pet:chat-panel + pet:signal) and assert the new behaviors:
 *   1. consecutive tool calls collapse into ONE group (latest preview, count);
 *   2. clicking the group head expands/collapses it;
 *   3. history re-render groups consecutive tools, single tools stay bare;
 *   4. a stale `history` for a different session is dropped while a load is
 *      pending (loading placeholder survives), then the awaited one applies.
 *  Run: npx electron scripts/probe-chat.cjs */
const { app, BrowserWindow } = require("electron");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 660, show: false, frame: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "..", "preload.js"),
    },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: { chat: "1" } });
  await sleep(400);

  const evaljs = (expr) => win.webContents.executeJavaScript(expr, true);
  const sig = (kind, extra = {}) =>
    win.webContents.send("pet:signal", { type: "chat", kind, sessionId: "s1", ...extra });

  // open the panel — this registers the chat-signal handler in the renderer
  win.webContents.send("pet:chat-panel", { open: true, side: "right", shiftY: 0 });
  await sleep(120);

  // ---- 1) LIVE: three consecutive tools -> ONE collapsed group ----
  sig("tool", { callId: "a", tool: "pwsh", label: "⚡ 执行命令", summary: "git clone ..." });
  await sleep(20);
  sig("tool", { callId: "b", tool: "grep", label: "🔎 搜索内容", summary: "pattern: x" });
  await sleep(20);
  sig("tool", { callId: "c", tool: "read", label: "📖 读文件", summary: "renderer/pet.js", argsText: '{"file_path":"renderer/pet.js"}' });
  await sleep(40);
  const live = JSON.parse(await evaljs(`JSON.stringify({
    groups: document.querySelectorAll(".chat-tool-group").length,
    collapsed: !!document.querySelector(".chat-tool-group.collapsed"),
    count: document.querySelector(".chat-tool-group-count")?.textContent ?? "",
    preview: document.querySelector(".chat-tool-group-preview")?.textContent ?? "",
    bodyCards: document.querySelectorAll(".chat-tool-group-body > .chat-tool").length,
    bare: [...document.querySelectorAll(".chat-messages > .chat-tool")].length,
  })`));
  check("3 tools -> 1 group", live.groups === 1 && live.bare === 0, JSON.stringify(live));
  check("group collapsed by default", live.collapsed === true);
  check("head shows count", live.count === "🛠️ 工具调用 × 3", live.count);
  check("head previews LATEST tool", live.preview === "📖 读文件 · renderer/pet.js", live.preview);
  check("group body holds all 3 cards", live.bodyCards === 3, String(live.bodyCards));

  // assistant text seals the run; a NEW tool afterwards starts a bare card
  sig("assistant", { text: "好的，我检查一下。" });
  await sleep(20);
  sig("tool", { callId: "d", tool: "glob", label: "🔍 查找文件", summary: "**/*.css" });
  await sleep(40);
  const afterSeal = JSON.parse(await evaljs(`JSON.stringify({
    groups: document.querySelectorAll(".chat-tool-group").length,
    bare: [...document.querySelectorAll(".chat-messages > .chat-tool")].length,
  })`));
  check("assistant seals run; new tool is a bare card",
    afterSeal.groups === 1 && afterSeal.bare === 1, JSON.stringify(afterSeal));

  // ---- 2) EXPAND / COLLAPSE toggle ----
  await evaljs(`document.querySelector(".chat-tool-group-head").click(); true`);
  await sleep(30);
  const expanded = JSON.parse(await evaljs(`JSON.stringify({
    collapsed: !!document.querySelector(".chat-tool-group.collapsed"),
    chevron: document.querySelector(".chat-tool-group-chevron")?.textContent ?? "",
    bodyDisplay: getComputedStyle(document.querySelector(".chat-tool-group-body")).display,
  })`));
  check("click expands (body visible, chevron ▾)",
    !expanded.collapsed && expanded.bodyDisplay !== "none" && expanded.chevron === "▾",
    JSON.stringify(expanded));
  await evaljs(`document.querySelector(".chat-tool-group-head").click(); true`);
  await sleep(30);
  const recollapsed = JSON.parse(await evaljs(`JSON.stringify({
    collapsed: !!document.querySelector(".chat-tool-group.collapsed"),
    bodyDisplay: getComputedStyle(document.querySelector(".chat-tool-group-body")).display,
  })`));
  check("click again collapses (body hidden)",
    recollapsed.collapsed && recollapsed.bodyDisplay === "none", JSON.stringify(recollapsed));

  // ---- 3) HISTORY: consecutive tools grouped, single tool bare ----
  sig("history", {
    sessionId: "s2",
    rows: [
      { role: "user", text: "你好" },
      { role: "tool", callId: "h1", tool: "pwsh", label: "⚡ 执行命令", summary: "cmd 1", done: true },
      { role: "tool", callId: "h2", tool: "grep", label: "🔎 搜索内容", summary: "pat 2", done: true, output: "ok" },
      { role: "assistant", text: "结果如上" },
      { role: "tool", callId: "h3", tool: "read", label: "📖 读文件", summary: "file 3", done: true },
    ],
  });
  await sleep(60);
  const hist = JSON.parse(await evaljs(`JSON.stringify({
    groups: document.querySelectorAll(".chat-tool-group").length,
    count: document.querySelector(".chat-tool-group-count")?.textContent ?? "",
    collapsed: !!document.querySelector(".chat-tool-group.collapsed"),
    bare: [...document.querySelectorAll(".chat-messages > .chat-tool")].length,
    totalTools: document.querySelectorAll(".chat-tool").length,
  })`));
  check("history groups the 2-tool run, keeps the single tool bare",
    hist.groups === 1 && hist.bare === 1 && hist.totalTools === 3,
    JSON.stringify(hist));
  check("history group collapsed, count × 2", hist.collapsed && hist.count === "🛠️ 工具调用 × 2", hist.count);

  // ---- 4) STALENESS: pending load drops a history for another session ----
  sig("sessions", { list: [
    { id: "sa", title: "会话A", createdAt: 1 },
    { id: "sb", title: "会话B", createdAt: 2 },
  ] });
  await sleep(50);
  await evaljs(`document.getElementById("chat-session-picker").click(); true`);
  await sleep(30);
  await evaljs(`[...document.querySelectorAll(".chat-session-row")].find(r => r.textContent.includes("会话B")).click(); true`);
  await sleep(40);
  const loading = await evaljs(`document.querySelector(".chat-messages .chat-session-empty")?.textContent ?? ""`);
  check("picker click shows loading placeholder", loading.includes("正在加载"), loading);
  sig("history", { sessionId: "sa", rows: [{ role: "user", text: "旧会话A内容" }] });
  await sleep(60);
  const afterStale = await evaljs(`document.querySelector(".chat-messages .chat-session-empty")?.textContent ?? "NONE"`);
  check("stale history for another session is DROPPED (loading stays)",
    afterStale.includes("正在加载"), afterStale);
  sig("history", { sessionId: "sb", rows: [{ role: "user", text: "会话B内容" }] });
  await sleep(60);
  const afterB = await evaljs(`document.querySelector(".chat-messages .chat-row .chat-bubble")?.textContent ?? "NONE"`);
  check("awaited session history applies", afterB === "会话B内容", afterB);

  // ---- 5) TRUNCATION NOTE: a capped (old/long) history shows the note ----
  sig("history", {
    sessionId: "s3",
    truncated: { skipped: 480, shown: 120 },
    rows: Array.from({ length: 120 }, (_, i) => ({ role: "assistant", text: `历史消息 ${i}` })),
  });
  await sleep(60);
  const trunc = JSON.parse(await evaljs(`JSON.stringify({
    note: document.querySelector(".chat-truncated-note")?.textContent ?? "",
    rows: document.querySelectorAll(".chat-messages > .chat-row").length,
  })`));
  check("truncated history shows the recent-tail note",
    trunc.note.includes("仅显示最近 120 条") && trunc.note.includes("480"), trunc.note);
  check("truncated history rendered only the sent tail",
    trunc.rows === 120, String(trunc.rows));

  // ---- 6) FAILED load: plugin couldn't read the log -> retry UI, not empty ----
  sig("history", { sessionId: "s4", failed: true, rows: [] });
  await sleep(60);
  const failed = JSON.parse(await evaljs(`JSON.stringify({
    retry: !!document.querySelector(".chat-retry-btn"),
    text: document.querySelector(".chat-messages .chat-session-empty")?.textContent ?? "",
    empty: (document.querySelector(".chat-messages .chat-session-empty")?.textContent ?? "").includes("暂无消息记录"),
  })`));
  check("failed history shows retry (not 'empty session')",
    failed.retry === true && failed.empty === false, failed.text);
  await evaljs(`document.querySelector(".chat-retry-btn").click(); true`);
  await sleep(50);
  const afterRetry = await evaljs(`document.querySelector(".chat-messages .chat-session-empty")?.textContent ?? ""`);
  check("retry click re-shows the loading placeholder", afterRetry.includes("正在加载"), afterRetry);

  // ---- 7) MARKDOWN: assistant bubbles render markdown, not raw text ----
  sig("assistant", { text: "# 标题\n\n这是**加粗**、`code` 和 [链接](https://example.com)\n\n```js\nconst x = 1 < 2;\n```" });
  await sleep(60);
  const md = JSON.parse(await evaljs(`JSON.stringify({
    h1: !!document.querySelector(".chat-assistant .chat-bubble h1"),
    strong: !!document.querySelector(".chat-assistant .chat-bubble strong"),
    code: !!document.querySelector(".chat-assistant .chat-bubble code"),
    a: document.querySelector(".chat-assistant .chat-bubble a")?.getAttribute("href") ?? "",
    pre: !!document.querySelector(".chat-assistant .chat-bubble pre code"),
    rawStars: document.querySelector(".chat-assistant .chat-bubble")?.textContent.includes("**"),
  })`));
  check("markdown heading rendered", md.h1 === true);
  check("markdown bold rendered", md.strong === true);
  check("markdown inline code rendered", md.code === true);
  check("markdown link rendered", md.a === "https://example.com", md.a);
  check("markdown fenced code block rendered", md.pre === true);
  check("no raw markdown markers leak", md.rawStars === false);

  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
  console.error("PROBE ERR:", e);
  app.exit(1);
});
