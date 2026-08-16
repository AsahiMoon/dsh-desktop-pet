/**
 * dsh-desktop-pet — DSH bundle Node half.
 *
 * Runs inside the DSH web process. Responsibilities:
 * 1. Listen to agent / session events and push signals to the Electron pet
 *    window over a local HTTP POST (127.0.0.1:43991/signal) — celebrate on
 *    task completion, error on failures / request errors, think/wait while a
 *    turn runs or waits for approval, idle when a turn closes, welcome on a
 *    new session.
 * 2. Register the experience-layer config namespace with the DSH settings
 *    service (schemastery schema, hot-applied via scope.watch) and push
 *    { type: 'config' } signals so the pet re-applies size/opacity/character/
 *    behavior without a restart.
 * 3. Spawn the Electron pet window on boot (the pet's own single-instance
 *    lock keeps a manually started window from being duplicated).
 * 4. Chat bridge over the pet's single 43991 port: this half long-polls
 *    /poll for user prompts (the pet window never exposes a port), submits
 *    them to the active agent via agent.followup() and forwards the agent's
 *    streamed reply back over /signal as chat signals. One port total — the
 *    pet's — so the plugin opens no listener of its own.
 *
 * The pet window also works standalone without this plugin (local autonomous
 * behavior, config from its own config.json); the plugin adds the agent-state
 * sync channel and the settings-backed hot config.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DEFAULTS, NAMESPACE, buildSchema, validateConfig } from "./config.mjs";

export const name = "dsh-desktop-pet";
export const inject = ["jobs", "sessions", "agents", "settings"];

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// The single local channel port, owned by the pet window: /signal pushes
// state to the pet, /poll drains queued user prompts (long-polled here).
const PORT = 43991;
const HOST = "127.0.0.1";

/** Resolve an executable that can run main.js: the electron package when it is
 *  installed anywhere up the node_modules tree (dev setups, local installs),
 *  or the standalone installed app when electron is absent (npm-published
 *  installs — electron is a devDependency, so a plain `npm install` of this
 *  bundle does not ship it). Returns null when neither exists. */
let electronPath = null;
try {
  const mod = await import("electron");
  electronPath = typeof mod.default === "string" ? mod.default : null;
} catch {
  /* not resolvable from this tree */
}
if (!electronPath) {
  try {
    const req = createRequire(import.meta.url);
    const mod = req("electron");
    electronPath = typeof mod === "string" ? mod : null;
  } catch {
    /* electron not installed anywhere up the tree */
  }
}

/** Find the user-installed standalone pet executable (electron-builder NSIS
 *  default per-user install dir, or anywhere under Program Files). */
function findInstalledPetExe() {
  if (process.platform !== "win32") return null;
  const roots = [
    path.join(process.env.LOCALAPPDATA ?? "", "Programs"),
    process.env.PROGRAMFILES ?? "C:\\Program Files",
    process.env.LOCALAPPDATA ?? "",
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/dsh[ -]desktop[ -]pet/i.test(e.name)) continue;
      const dir = path.join(root, e.name);
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const exe = files.find((f) => /\.exe$/i.test(f) && !/setup|uninstall/i.test(f));
      if (exe) return path.join(dir, exe);
    }
  }
  return null;
}

/** Fire one signal toward the pet window (local HTTP POST). Best-effort. */
async function sendSignal(signal) {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...signal, ts: Date.now() }),
    });
    await res.arrayBuffer(); // drain the response
  } catch {
    /* pet offline — signal dropped */
  }
}

/** Construct one identified user message the agent loop accepts.
 *  Plain JSON on purpose: this bundle cannot resolve @deepseek-ai/dsh-llm
 *  from its link-installed location, and the inbox/session layers only
 *  require a JSON-serializable message with a unique id. */
function createChatUserMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/** Extract the visible text of an assistant message's content blocks. */
function textOfBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

// Crash recovery: a spawned pet that dies unexpectedly (non-zero exit) is
// restarted with a small backoff, capped so a hard-failing install does not
// respawn forever. A zero exit is a deliberate quit (tray -> 退出) and never
// resurrects the pet.
let petRespawnTimer = null;
let petRespawnAttempts = 0;
let petRespawnResetTimer = null;

/** Spawn the pet window if a runnable electron / installed exe exists. */
function ensurePet() {
  const exe = electronPath ?? findInstalledPetExe();
  if (!exe) return;
  clearTimeout(petRespawnTimer);
  try {
    const child = spawn(exe, [path.join(ROOT, "main.js")], {
      stdio: "ignore",
      detached: false,
      windowsHide: true,
    });
    child.on("error", () => {});
    child.on("exit", (code) => {
      if (code !== 0 && petRespawnAttempts < 5) {
        petRespawnAttempts++;
        const delay = Math.min(60_000, 10_000 * petRespawnAttempts);
        petRespawnTimer = setTimeout(ensurePet, delay);
      }
    });
    child.unref();
    // a pet that stays alive long enough is healthy — reset the crash counter
    // so a later one-off crash still gets a fresh restart budget
    clearTimeout(petRespawnResetTimer);
    petRespawnResetTimer = setTimeout(() => {
      petRespawnAttempts = 0;
    }, 60_000);
    petRespawnResetTimer.unref?.();
  } catch {
    /* spawn failed — pet stays off, sync messages go nowhere */
  }
}

/**
 * Cordis plugin apply.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ensurePet();

  // ---- chat bridge: collect commands from the pet window, forward replies ----
  // The pet window never exposes a port: this half LONG-POLLS the pet's own
  // 43991 /poll endpoint for queued commands ({ cmd: 'prompt'|'list-sessions'
  // |'select-session' }), routes prompts to the chosen agent (or resumes the
  // latest persisted session when none is live yet) via agent.followup();
  // the agent's streamed reply comes back through session/event and is pushed
  // over the same 43991 /signal channel as chat signals. One port total — the
  // pet's — and this half opens no listener of its own.
  let chatTargetAgent = null;
  let chatStreaming = false;
  let chatStreamText = "";
  /** Text of one message's content blocks (text blocks only). */
  const messageText = (content) => textOfBlocks(content);
  /** Extract user/assistant transcript rows from a session's events.
   *  @returns [{ role: 'user'|'assistant', text, ts }] in log order. */
  const transcriptOf = (events) => {
    if (!Array.isArray(events)) return [];
    const rows = [];
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const data = event.data;
      if (event.type === "user/message" && data?.content) {
        const text = messageText(data.content);
        if (text) rows.push({ role: "user", text, ts: event.time });
      } else if (event.type === "assistant/message" && data?.message?.content) {
        const text = messageText(data.message.content);
        if (text) rows.push({ role: "assistant", text, ts: event.time });
      }
    }
    return rows;
  };
  /** Latest session/title event text, or undefined. */
  const titleOf = (events) => {
    if (!Array.isArray(events)) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === "session/title" && typeof event?.data?.title === "string"
        && event.data.title.trim()) return event.data.title.trim();
    }
    return undefined;
  };
  /** List persisted sessions with their titles and a message preview. */
  const listSessions = async () => {
    try {
      const persistence = ctx.get("sessionPersistence");
      if (!persistence || typeof persistence.list !== "function") return [];
      const headers = await persistence.list();
      if (!Array.isArray(headers)) return [];
      const rows = [];
      for (const header of [...headers].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)) {
        let title;
        let preview = "";
        try {
          if (typeof persistence.inspect === "function") {
            const inspection = await persistence.inspect(header.id);
            title = titleOf(inspection?.events);
            const transcript = transcriptOf(inspection?.events);
            const last = transcript.at(-1);
            preview = last ? last.text.slice(0, 80) : "";
          }
        } catch { /* keep header-only row */ }
        rows.push({
          id: header.id,
          title: title ?? `会话 ${header.createdAt ? new Date(header.createdAt).toLocaleString("zh-CN") : ""}`,
          preview,
          createdAt: header.createdAt,
        });
      }
      return rows;
    } catch (err) {
      console.error("[dsh-desktop-pet] listSessions failed:", err?.message ?? err);
      return [];
    }
  };
  /** Pick the agent the pet chat should talk to (live agents only). */
  const pickLiveChatAgent = () => {
    const agentsSvc = ctx.get("agents");
    if (!agentsSvc || typeof agentsSvc.list !== "function") return undefined;
    const live = agentsSvc.list();
    if (live.length === 0) return undefined;
    const roots = agentsSvc.roots?.() ?? [];
    // Prefer the agent currently driving the pet (most recent activity),
    // then the first root agent (web sessions are roots).
    return live.find((a) => a.id === activeSessionId)
      ?? (roots[0] ?? live[0]);
  };
  /** Resume the most recent persisted session as a live agent (best-effort). */
  const resumeRecentAgent = async () => {
    try {
      const agentsSvc = ctx.get("agents");
      const persistence = ctx.get("sessionPersistence");
      if (!agentsSvc || typeof agentsSvc.resume !== "function") return undefined;
      if (!persistence || typeof persistence.list !== "function") return undefined;
      const headers = await persistence.list();
      if (!Array.isArray(headers) || headers.length === 0) return undefined;
      // Most recent first (headers carry createdAt).
      const latest = [...headers].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )[0];
      const handle = await agentsSvc.resume({ resumeSessionId: latest.id });
      if (!handle?.agent) return undefined;
      // Resume can only build a fresh agent once; keep the handle's dispose
      // out of our own teardown (the loop owns it structurally).
      return handle.agent;
    } catch (err) {
      console.error("[dsh-desktop-pet] resume failed:", err?.message ?? err);
      return undefined;
    }
  };
  /** Resume one EXACT persisted session id as a live agent (best-effort). */
  const resumeSessionAgent = async (sessionId) => {
    try {
      const agentsSvc = ctx.get("agents");
      if (!agentsSvc || typeof agentsSvc.resume !== "function") return undefined;
      if (typeof sessionId !== "string" || !sessionId) return undefined;
      const handle = await agentsSvc.resume({ resumeSessionId: sessionId });
      if (!handle?.agent) return undefined;
      return handle.agent;
    } catch (err) {
      console.error("[dsh-desktop-pet] resume failed:", err?.message ?? err);
      return undefined;
    }
  };
  /** Resolve the chat target: live agent first, else resume the latest session. */
  const resolveChatAgent = async () => {
    const live = pickLiveChatAgent();
    if (live) return live;
    return resumeRecentAgent();
  };
  /** Load the transcript of one session (live agent's session or persisted). */
  const loadHistory = async (sessionId) => {
    // Live agent first (its session has deriveMessages).
    const agentsSvc = ctx.get("agents");
    const liveAgent = agentsSvc?.get?.(sessionId);
    if (liveAgent?.session && typeof liveAgent.session.deriveMessages === "function") {
      return liveAgent.session.deriveMessages().map((msg) => ({
        role: msg?.role === "user" ? "user" : "assistant",
        text: messageText(msg?.content),
      })).filter((row) => row.text);
    }
    try {
      const persistence = ctx.get("sessionPersistence");
      if (!persistence || typeof persistence.inspect !== "function") return [];
      const inspection = await persistence.inspect(sessionId);
      return transcriptOf(inspection?.events);
    } catch (err) {
      console.error("[dsh-desktop-pet] loadHistory failed:", err?.message ?? err);
      return [];
    }
  };
  /** Submit one prompt from the pet window to the chosen agent. */
  const submitChatPrompt = async (text) => {
    const agent = await resolveChatAgent();
    if (!agent || typeof agent.followup !== "function") {
      sendSignal({ type: "chat", kind: "error", text: "没有可对话的 Agent（请先在网页里打开一个会话）" });
      return false;
    }
    chatTargetAgent = agent;
    chatStreaming = false;
    chatStreamText = "";
    try {
      agent.followup(createChatUserMessage(text));
      return true;
    } catch (err) {
      console.error("[dsh-desktop-pet] followup failed:", err?.message ?? err);
      sendSignal({ type: "chat", kind: "error", text: `提交失败：${err?.message ?? err}` });
      return false;
    }
  };
  /** Handle one command drained from the pet window's /poll queue. */
  const handleChatCommand = async (cmd) => {
    if (!cmd || typeof cmd !== "object") return;
    if (cmd.cmd === "prompt" && typeof cmd.text === "string" && cmd.text.trim()) {
      await submitChatPrompt(cmd.text.trim());
    } else if (cmd.cmd === "list-sessions") {
      const rows = await listSessions();
      sendSignal({ type: "chat", kind: "sessions", list: rows });
    } else if (cmd.cmd === "select-session" && typeof cmd.sessionId === "string") {
      // Resume the exact session (if not live) and make it the chat target.
      const live = ctx.get("agents")?.get?.(cmd.sessionId);
      const agent = live ?? await resumeSessionAgent(cmd.sessionId);
      if (agent && typeof agent.followup === "function") {
        chatTargetAgent = agent;
        chatStreaming = false;
        chatStreamText = "";
      }
      const history = await loadHistory(cmd.sessionId);
      sendSignal({ type: "chat", kind: "history", sessionId: cmd.sessionId, rows: history });
    }
  };
  /** Is this event from the agent the pet chat is talking to? */
  const isChatSession = (sessionId) => (
    chatTargetAgent !== null && sessionId != null && sessionId === chatTargetAgent.id
  );
  /** Stream one assistant text delta to the pet chat window. */
  const chatDelta = (text) => {
    if (!text) return;
    chatStreaming = true;
    chatStreamText += text;
    sendSignal({ type: "chat", kind: "delta", text });
  };
  /** Close the current assistant stream (full accumulated text + done). */
  const chatStreamEnd = () => {
    if (!chatStreaming) return;
    chatStreaming = false;
    sendSignal({ type: "chat", kind: "assistant", text: chatStreamText });
    chatStreamText = "";
  };

  // Long-poll loop: one in-flight /poll at a time, backoff on failure so a
  // pet that is starting (or offline) does not spin. The pet answers with a
  // command ({ cmd: 'prompt'|'list-sessions'|'select-session', ... }) or
  // { empty: true } after its hold window.
  let pollTimer = null;
  let polling = false;
  const pollDelay = (attempt) => Math.min(10_000, 200 * attempt);
  const pollOnce = async (attempt) => {
    if (polling) return;
    polling = true;
    try {
      const res = await fetch(`http://${HOST}:${PORT}/poll`, { method: "POST" });
      if (res.ok) {
        const payload = await res.json().catch(() => ({}));
        if (payload && typeof payload === "object" && payload.cmd) {
          await handleChatCommand(payload);
        }
      }
    } catch {
      /* pet offline — retry after backoff */
    } finally {
      polling = false;
    }
    pollTimer = setTimeout(() => pollOnce(attempt + 1), pollDelay(attempt));
  };
  pollOnce(1);

  // ---- config: register with DSH settings, hot-push on change ----
  const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
  let config = { ...DEFAULTS };
  if (settings !== undefined && typeof settings.register === "function") {
    try {
      const scope = settings.register(NAMESPACE, buildSchema(), {
        applies: "live",
        validate: validateConfig,
      });
      config = { ...DEFAULTS, ...(scope.get() ?? {}) };
      scope.watch((next) => {
        config = { ...DEFAULTS, ...(next ?? {}) };
        sendSignal({ type: "config", config });
      });
    } catch (err) {
      console.error("[dsh-desktop-pet] settings register failed:", err?.message ?? err);
    }
  }

  // ---- live state tracking (think/wait/exec) + heartbeat sync ----
  // Signals are fire-and-forget; a pet that starts mid-turn (or reconnects)
  // would miss them. A 5s heartbeat carries the current state so the pet
  // stays aligned even when it missed the edges.
  let thinking = false;
  let waiting = false;
  let activeTools = 0;
  let lastTodo = [];
  // tool arguments arrive as STREAMING chunks (argumentsDelta fragments keyed by
  // callId) — accumulate them so the pet can show the tool's actual target
  const toolArgs = new Map();

  // When several sessions exist (multiple agents in the web UI), concurrent
  // sessions would fight over the pet's one state box. Only the MOST RECENTLY
  // ACTIVE session drives the pet; after it stays quiet for SESSION_STALE_MS,
  // a different session may take over. (jobs/onJobDone stays unfiltered: a
  // completed job celebrating is welcome from any session.)
  const SESSION_STALE_MS = 30_000;
  let activeSessionId = null;
  let activeSessionAt = 0;
  const isCurrentSession = (sid) => {
    const now = Date.now();
    if (sid == null) return true; // unknown identity — don't drop events
    if (activeSessionId === null || sid === activeSessionId) {
      activeSessionId = sid;
      activeSessionAt = now;
      return true;
    }
    if (now - activeSessionAt > SESSION_STALE_MS) {
      activeSessionId = sid;
      activeSessionAt = now;
      return true;
    }
    return false; // another session is currently driving the pet
  };

  const heartbeat = setInterval(() => {
    sendSignal({
      type: "sync",
      think: thinking,
      wait: waiting,
      exec: activeTools > 0,
      todos: lastTodo,
    });
  }, 5000);

  /** Friendly labels for the tool calls shown on the pet. */
  const TOOL_LABELS = {
    read: "📖 读文件",
    write: "✏️ 写文件",
    edit: "🔧 编辑代码",
    glob: "🔍 查找文件",
    grep: "🔎 搜索内容",
    pwsh: "⚡ 执行命令",
    job_output: "📄 读取任务输出",
    job_list: "📋 查看任务",
    job_kill: "🛑 停止任务",
    web_search: "🌐 网络搜索",
    subagent: "🤖 派发子任务",
    subagent_fork: "🤖 子代理接力",
    todo_write: "📝 更新计划",
    skill: "📚 加载技能",
    ask_user_question: "❓ 向你提问",
    read_image: "🖼️ 查看图片",
    create_goal: "🎯 创建目标",
    update_goal: "🎯 更新目标",
    exit_plan_mode: "📐 提交方案",
    workflow: "🚀 运行工作流",
    ralph: "🔄 Ralph 迭代",
  };
  const toolLabel = (name) => TOOL_LABELS[name] ?? `🛠️ ${name}`;

  /** Short human-readable target of a tool call (file path / query / command…)
   *  for the pet's detailed caption. Null when the tool has nothing useful. */
  const toolDetailOf = (name, args) => {
    if (!args || typeof args !== "object") return null;
    const KEY = {
      read: "file_path", write: "file_path", edit: "file_path", read_image: "file_path",
      glob: "pattern", grep: "pattern", pwsh: "command", web_search: "query",
      skill: "name", subagent: "description", subagent_fork: "description",
      job_output: "job_id", workflow: "name",
    };
    const key = KEY[name];
    const picked = key && typeof args[key] === "string" && args[key].trim() ? args[key].trim() : null;
    if (picked) return picked.length > 60 ? picked.slice(0, 60) : picked;
    // generic fallback: first non-empty string argument value
    for (const val of Object.values(args)) {
      if (typeof val === "string" && val.trim()) {
        const s = val.trim();
        return s.length > 60 ? s.slice(0, 60) : s;
      }
    }
    return null;
  };

  const disposers = [
    // Task terminal states: completed -> celebrate, failed -> error.
    ctx.jobs.onJobDone((snapshot) => {
      if (!snapshot) return;
      if (snapshot.status === "completed") {
        sendSignal({ type: "celebrate", label: snapshot.label ?? "任务完成" });
      } else if (snapshot.status === "failed") {
        sendSignal({ type: "error", label: snapshot.label ?? "任务失败" });
      }
    }),

    // LLM request errors (may retry later) -> startled.
    ctx.on("agent/request-error", () => {
      sendSignal({ type: "error", label: "请求出错" });
    }),

    // New session -> welcome.
    ctx.on("agent/session-start", (payload) => {
      if (payload?.source === "startup") sendSignal({ type: "welcome" });
    }),

    // Session log edges drive think / exec / todo / wait / celebrate.
    // Event shape (dsh-session SessionEventMap): { type, seq, time, data }.
    ctx.on("session/event", (session, event) => {
      // Chat reply forwarding first: this session's assistant stream feeds the
      // pet chat window (user/message echo + text-delta stream + assembled reply).
      if (isChatSession(session?.id)) {
        const type = event?.type;
        if (type === "user/message") {
          const text = textOfBlocks(event?.data?.content);
          if (text) sendSignal({ type: "chat", kind: "user", text });
        } else if (type === "assistant/chunk") {
          const chunk = event?.data?.chunk;
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
            chatDelta(chunk.text);
          }
        } else if (type === "assistant/message") {
          chatStreamEnd();
          const text = textOfBlocks(event?.data?.message?.content);
          if (text) sendSignal({ type: "chat", kind: "assistant", text });
        } else if (type === "turn/end") {
          chatStreamEnd();
          sendSignal({ type: "chat", kind: "done" });
        }
      }

      if (!isCurrentSession(session?.id)) return;
      const type = event?.type;
      if (type === "turn/start") {
        thinking = true;
        waiting = false;
        sendSignal({ type: "think" });
      } else if (type === "turn/end") {
        thinking = false;
        activeTools = 0;
        const reason = event?.data?.reason;
        if (reason?.kind === "blocked") {
          waiting = true;
          sendSignal({ type: "wait" });
        } else {
          waiting = false;
          sendSignal({ type: "celebrate", label: "回合完成" });
        }
      } else if (type === "tool/call") {
        // the model asked for a tool — show what it is doing (codex-pet style).
        // tool/call events are STREAMING chunks: { chunk: { id, name?, argumentsDelta } },
        // so accumulate the argument fragments and attach the parsed target.
        activeTools++;
        const chunk = event?.data?.chunk ?? {};
        const name = event?.data?.name ?? chunk.name;
        const callId = event?.data?.callId ?? chunk.id;
        if (chunk.argumentsDelta && callId) {
          toolArgs.set(callId, (toolArgs.get(callId) ?? "") + chunk.argumentsDelta);
          if (toolArgs.size > 64) toolArgs.clear(); // guard against leaked calls
        }
        let detail = null;
        if (name && callId && toolArgs.has(callId)) {
          try {
            detail = toolDetailOf(name, JSON.parse(toolArgs.get(callId)));
          } catch {
            /* partial JSON mid-stream — keep the previous detail */
          }
        }
        sendSignal({ type: "exec", tool: name, label: toolLabel(name), detail });
      } else if (type === "tool/result") {
        activeTools = Math.max(0, activeTools - 1);
        const callId = event?.data?.message?.source?.callId ?? event?.data?.callId;
        if (callId) toolArgs.delete(callId);
        if (activeTools === 0) sendSignal({ type: "tool-done" });
      } else if (type === "todo/write") {
        // progress snapshot: [{ content, status }]
        lastTodo = Array.isArray(event?.data?.todos) ? event.data.todos : [];
        sendSignal({ type: "todo", todos: lastTodo });
      }
    }),
  ];

  // Push the resolved config to the pet shortly after boot (the pet may still
  // be starting; it also re-requests config on boot when the plugin is live).
  setTimeout(() => {
    sendSignal({ type: "config", config });
  }, 1500);

  ctx.effect(() => () => {
    clearInterval(heartbeat);
    clearTimeout(petRespawnTimer);
    clearTimeout(petRespawnResetTimer);
    clearTimeout(pollTimer);
    // note: the spawned pet is NOT killed here — the user may want it to keep
    // running when the plugin unloads (e.g. dsh web restarts)
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  }, "dsh-desktop-pet: agent-state sync + config");
}
