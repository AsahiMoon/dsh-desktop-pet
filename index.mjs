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

// History delivery limits: the pet chat panel only shows the RECENT TAIL of a
// transcript, so a long conversation is never fully decompressed, serialized
// and rendered (which used to freeze the window). 20 rows is enough context to
// continue a conversation without scrolling, and the panel does not load
// earlier rows on scroll-up (by design — the same lightweight choice the pet
// makes everywhere to stay responsive).
const MAX_HISTORY_ROWS = 20; // recent conversations: keep last 20 rows
const MAX_OLD_HISTORY_ROWS = 20; // older conversations: keep last 20 too
const OLD_CONVERSATION_MS = 14 * 24 * 60 * 60 * 1000; // idle for >14 days
// How fresh a cached session list may be before the picker re-scans storage.
const SESSIONS_CACHE_TTL_MS = 8_000;
const SESSIONS_POOL_LIMIT = 5; // concurrent log reads when listing sessions
// How long one persisted-session inspect may run before the history load
// ABORTS it (via the AbortSignal passed to persistence.inspect) and reports
// `failed`, after which the pet offers a retry. The pet's renderer watchdog
// is 30s, so this must sit comfortably below it to leave headroom for the
// transcript parse + serialization + HTTP hop that follow the read.
const HISTORY_INSPECT_TIMEOUT_MS = 20_000;

/**
 * Inspect one persisted session with a REAL abort bound. DSH's persistence
 * `inspect(id, signal)` re-reads the stored log in a `for(;;)` loop that is
 * only interruptible through its AbortSignal parameter; calling it without a
 * signal leaves a slow/corrupt log to hang forever. This wrapper passes an
 * AbortController that fires after `HISTORY_INSPECT_TIMEOUT_MS`, so the read
 * is genuinely cancelled (not merely ignored) and the caller can report
 * `failed` and offer a retry.
 * @param {object} persistence the sessionPersistence service
 * @param {string} sessionId
 * @returns {Promise<object|undefined>} the inspection, or undefined on abort
 */
async function inspectWithTimeout(persistence, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HISTORY_INSPECT_TIMEOUT_MS);
  try {
    return await persistence.inspect(sessionId, controller.signal);
  } catch (err) {
    // Abort just means "too slow to fetch now" — surface it as undefined and
    // let callers fall back / report failed rather than throwing.
    if (controller.signal.aborted) return undefined;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
  /** The session whose transcript the pet chat panel is currently showing.
   *  When it changes (web-side activity in a different session), the panel
   *  first receives the new session's full transcript, then the live events. */
  let chatFollowSessionId = null;
  /** Per-turn token accounting for the stats line under the chat input —
   *  reset on turn/start, accumulated from each step's assistant/message
   *  usage, mirroring the web UI's 轮次 / token / 缓存命中 readout. */
  let chatStats = { turn: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const resetChatStats = (turn) => {
    chatStats = { turn: turn ?? 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  };
  /** Text of one message's content blocks (text blocks only). */
  const messageText = (content) => textOfBlocks(content);
  /** A lone period / whitespace is not a real title or message — filter it so
   *  empty streams never surface as a "." conversation or bubble. */
  const isTrivialText = (s) => {
    if (typeof s !== "string") return true;
    const t = s.trim();
    return t.length === 0 || /^[.。…·•*\-—_~ ]+$/.test(t);
  };
  /** Extract user/assistant transcript rows from a session's events.
   *  Rows carry the message id so callers can tell them apart (e.g. drop the
   *  triggering message from a follow-switch history instead of showing it
   *  twice — once in the transcript, once as the live echo).
   *  @returns [{ role: 'user'|'assistant'|'tool', text?, ts?, id?, tool?, ... }]
   *           in log order. Tool rows carry the tool card payload and pair
   *           with their result via callId, so the renderer can rebuild the
   *           web-style tool cards when a session is reopened. */
  const transcriptOf = (events) => {
    if (!Array.isArray(events)) return [];
    const rows = [];
    const toolByCall = new Map();
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const data = event.data;
      if (event.type === "user/message" && data?.content) {
        const text = messageText(data.content);
        if (!isTrivialText(text)) rows.push({ role: "user", text, ts: event.time, id: data?.id });
      } else if (event.type === "assistant/message" && data?.message?.content) {
        const text = messageText(data.message.content);
        if (!isTrivialText(text)) rows.push({ role: "assistant", text, ts: event.time, id: data?.message?.id });
      } else if (event.type === "tool/call") {
        // a tool call row — the renderer draws it as a frosted tool card;
        // the matching tool/result below marks it done and adds the output
        const callId = data?.callId;
        let summary = null;
        let argsText = null;
        try {
          const args = JSON.parse(data?.arguments ?? "{}");
          summary = toolDetailOf(data?.name, args);
          const json = JSON.stringify(args);
          if (json && json !== "{}") argsText = json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
        } catch {
          /* arguments not parseable — keep header-only card */
        }
        const row = {
          role: "tool",
          callId,
          tool: data?.name,
          label: toolLabel(data?.name),
          summary,
          argsText,
          done: false,
        };
        if (callId) toolByCall.set(callId, row);
        rows.push(row);
      } else if (event.type === "tool/result") {
        const callId = data?.message?.source?.callId;
        const block = data?.message?.content?.[0];
        const isError = !!(block && block.isError);
        let output = null;
        const strings = [];
        const collect = (v) => {
          if (typeof v === "string") strings.push(v);
          else if (Array.isArray(v)) v.forEach(collect);
          else if (v && typeof v === "object" && "content" in v) collect(v.content);
        };
        collect(data?.message?.content);
        const joined = strings.join("\n").trim();
        if (joined) output = joined.length > 1500 ? `${joined.slice(0, 1500)}…` : joined;
        const row = callId ? toolByCall.get(callId) : null;
        if (row) {
          row.done = true;
          row.output = output;
          row.isError = isError;
        } else if (output) {
          // result without a visible call row (edge case) — still show it
          rows.push({ role: "tool", callId, tool: null, label: "工具结果", summary: null, argsText: null, done: true, output, isError });
        }
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
  /** The title of one session — persisted log first, live session fallback
   *  (a just-created session may not have a log file yet). */
  const sessionTitle = async (sessionId) => {
    try {
      const persistence = ctx.get("sessionPersistence");
      if (persistence && typeof persistence.inspect === "function") {
        const inspection = await inspectWithTimeout(persistence, sessionId);
        if (inspection !== undefined) {
          const t = titleOf(inspection?.events);
          if (t) return t;
        }
      }
    } catch {
      /* not materialized yet — fall through to the live session */
    }
    const live = ctx.get("sessions")?.get?.(sessionId);
    return live ? titleOf(live.events) : undefined;
  };
  /** Cheap preview text: the LAST user/assistant message in a log, found by
   *  walking from the END and stopping at the first message — building the
   *  full transcript of every listed session was what made the picker slow. */
  const lastMessagePreview = (events) => {
    if (!Array.isArray(events)) return "";
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const data = ev?.data;
      let text = null;
      if (ev?.type === "user/message" && data?.content) text = messageText(data.content);
      else if (ev?.type === "assistant/message" && data?.message?.content) text = messageText(data.message.content);
      if (!isTrivialText(text)) return text.slice(0, 80);
    }
    return "";
  };
  /** Timestamp of the newest event in a log (for conversation-age checks). */
  const lastEventTs = (events) => {
    if (!Array.isArray(events)) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      if (typeof events[i]?.time === "number") return events[i].time;
    }
    return undefined;
  };
  /** Run async work over items with a bounded concurrency pool. */
  const mapPool = async (items, limit, fn) => {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }));
    return out;
  };
  /** Short-lived cache so re-opening the picker (panel open + 🗂️ clicks)
   *  does not re-decompress every session log each time. */
  let sessionsCache = { at: 0, rows: [] };
  /** List sessions with their titles and a message preview — PERSISTED ones
   *  plus LIVE (in-memory) ones, so the pet picker matches what the web
   *  sidebar shows: the web also lists sessions that were just created but
   *  not yet flushed to disk (lazy materialization — a fresh "新会话" with no
   *  message has no log file yet, so persistence.list() alone would miss it). */
  const listSessions = async () => {
    try {
      const persistence = ctx.get("sessionPersistence");
      const store = ctx.get("sessions");
      // The web sidebar hides ARCHIVED sessions (workspace registry's
      // archivedSessionIds) as well as subagent children and non-current-cwd
      // conversations. The pet picker must mirror that, or it lists sessions
      // the web no longer shows. Best-effort: no workspaceRegistry -> no
      // archive filtering (older harness / standalone).
      let archivedIds = null;
      const workspaceRegistry = ctx.get("workspaceRegistry");
      if (workspaceRegistry && Array.isArray(workspaceRegistry.archivedSessionIds)) {
        archivedIds = new Set(workspaceRegistry.archivedSessionIds);
      }
      // merge both sources by session id (live wins for title/preview).
      // IMPORTANT: live sessions MUST be merged FIRST so their `live` reference
      // survives — a session that is both live AND persisted keeps its live
      // entry, so the list reads title/preview from memory (fast + accurate,
      // same as the web UI) instead of cold-reading its log. The previous order
      // (persistence first, `if (!byId.has(s.id))` for live) silently dropped
      // the live reference of every persisted live session, so those sessions
      // were cold-inspected — slow, and for an actively-writing session the
      // inspect re-read loop could time out and drop the session from the list.
      const byId = new Map();
      if (store && typeof store.list === "function") {
        for (const s of store.list()) {
          byId.set(s.id, {
            id: s.id,
            createdAt: s.header?.createdAt ?? Date.now(),
            origin: s.header?.origin,
            delegationDepth: s.header?.delegationDepth,
            live: s,
          });
        }
      }
      if (persistence && typeof persistence.list === "function") {
        const headers = await persistence.list();
        if (Array.isArray(headers)) {
          for (const h of headers) {
            if (!byId.has(h.id)) {
              byId.set(h.id, { id: h.id, createdAt: h.createdAt, origin: h.origin, delegationDepth: h.delegationDepth });
            }
          }
        }
      }
      const sorted = [...byId.values()]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, 50)
        // the pet chat lists top-level conversations only — match the web
        // sidebar by dropping subagent child sessions AND archived sessions
        // (a user-archived conversation stays on disk but is hidden everywhere).
        .filter((entry) => entry.origin !== "subagent" && (entry.delegationDepth ?? 0) <= 0)
        .filter((entry) => !(archivedIds?.has(entry.id) ?? false));
      // persisted entries need a log read for their title/preview — run those
      // reads CONCURRENTLY (bounded pool) instead of one after another
      const persisted = sorted.filter((entry) => !entry.live && persistence && typeof persistence.inspect === "function");
      const meta = await mapPool(persisted, SESSIONS_POOL_LIMIT, async (entry) => {
        try {
          const inspection = await inspectWithTimeout(persistence, entry.id);
          return {
            id: entry.id,
            title: inspection === undefined ? undefined : titleOf(inspection?.events),
            preview: inspection === undefined ? "" : lastMessagePreview(inspection?.events),
          };
        } catch {
          return { id: entry.id, title: undefined, preview: "" };
        }
      });
      const metaById = new Map(meta.map((m) => [m.id, m]));
      const rows = [];
      for (const entry of sorted) {
        let title;
        let preview = "";
        try {
          if (entry.live) {
            // live session: title from its event log, preview from the
            // derived messages (works before the first flush)
            title = titleOf(entry.live.events);
            const msgs = typeof entry.live.deriveMessages === "function" ? entry.live.deriveMessages() : [];
            const last = msgs.filter((m) => m?.role === "user" || m?.role === "assistant").at(-1);
            preview = last ? messageText(last.content).slice(0, 80) : "";
          } else {
            const m = metaById.get(entry.id);
            title = m?.title;
            preview = m?.preview ?? "";
          }
        } catch { /* keep header-only row */ }
        // the web hides blank sessions (no title, no message) — a stray "."
        // from a degenerate auto-title, or an empty pet-created session, is
        // clutter, not a conversation. Skip it.
        if (isTrivialText(title) && isTrivialText(preview)) continue;
        rows.push({
          id: entry.id,
          // no "会话" prefix — the date lives in the row's meta already, and
          // this fallback also shows in the chat title bar; a lone "." from a
          // degenerate auto-title is never a real title
          title: isTrivialText(title) ? "未命名" : title,
          preview: isTrivialText(preview) ? "" : preview,
          createdAt: entry.createdAt,
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
  /** Resolve the chat target: the session the user selected in the pet chat
   *  (when it is still live) FIRST, then any live agent, else resume the
   *  latest persisted session. Previously the live-agent scan ran first, so
   *  picking an old session and sending a message could route the prompt to a
   *  DIFFERENT (more recently active) conversation. */
  const resolveChatAgent = async () => {
    const agentsSvc = ctx.get("agents");
    if (chatTargetAgent && agentsSvc?.get?.(chatTargetAgent.id)) return chatTargetAgent;
    const live = pickLiveChatAgent();
    if (live) return live;
    return resumeRecentAgent();
  };
  /** Load one session's transcript + title in ONE pass. Priority — the same
   *  as the web UI's history read:
   *  1. the LIVE SessionStore session's in-memory event log (the web reads
   *     `ctx.sessions.get(id)` FIRST — zero disk IO, instant; a session can
   *     live in the store without a registered Agent, so the agent registry
   *     alone would miss this fast path);
   *  2. the live Agent's session (when the store lookup missed);
   *  3. one persistence.inspect (rows and title share the same read, so a
   *     big log is decompressed once, not twice) — like the web, this read
   *     is allowed to take however long it needs (the coordinator caches the
   *     prepared session, so repeat reads are fast);
   *  4. the live agent's derived messages as a last-resort fallback.
   *
   *  Only the RECENT tail of the transcript is returned: long conversations
   *  are capped (older ones even harder), so loading a far-away conversation
   *  never decompresses + serializes + renders its whole history.
   *  @returns Promise<{ rows, title, truncated, failed }> — truncated =
   *  { skipped, shown } when rows were cut; failed = the persisted read
   *  threw, so the panel can offer a retry instead of an empty view. */
  const loadTranscript = async (sessionId) => {
    const agentsSvc = ctx.get("agents");
    const store = ctx.get("sessions");
    // the store FIRST — exactly the web's historySourceFor() ordering
    const storeSession = store?.get?.(sessionId);
    const liveAgent = agentsSvc?.get?.(sessionId);
    const liveEvents = storeSession?.events ?? liveAgent?.session?.events;
    const hasLive = Array.isArray(liveEvents) && liveEvents.length > 0;
    let rows = null;
    let title;
    let usedEvents = null;
    let failed = false;
    if (hasLive) {
      rows = transcriptOf(liveEvents);
      title = titleOf(liveEvents);
      usedEvents = liveEvents;
    } else {
      try {
        const persistence = ctx.get("sessionPersistence");
        if (persistence && typeof persistence.inspect === "function") {
          // The web waits for this read with no timeout, but HERE it runs on
          // the pet's single command path. A slow / corrupt persisted log can
          // make `inspect(id)` never settle: DSH's coordinator `inspect` is a
          // `for(;;)` re-read loop that is ONLY interruptible through its
          // AbortSignal parameter. inspectWithTimeout passes one, so the read
          // is genuinely cancelled (not just ignored), the handler reports
          // `failed`, and the pet offers a retry.
          const inspection = await inspectWithTimeout(persistence, sessionId);
          if (inspection === undefined) {
            // aborted (too slow) — distinct from a missing session
            failed = true;
          } else {
            usedEvents = inspection?.events;
            rows = transcriptOf(usedEvents);
            title = titleOf(usedEvents);
          }
        }
      } catch (err) {
        failed = true;
        console.error("[dsh-desktop-pet] loadTranscript(persistence) failed:", err?.message ?? err);
      }
      if (rows === null && liveAgent?.session && typeof liveAgent.session.deriveMessages === "function") {
        rows = liveAgent.session.deriveMessages().map((msg) => ({
          role: msg?.role === "user" ? "user" : "assistant",
          text: messageText(msg?.content),
          id: msg?.id,
        })).filter((row) => row.text);
      }
    }
    if (!Array.isArray(rows)) rows = [];
    // age-aware cap: conversations idle for a long time show even less
    const lastTs = lastEventTs(usedEvents);
    const isOld = typeof lastTs === "number" && Date.now() - lastTs > OLD_CONVERSATION_MS;
    const cap = isOld ? MAX_OLD_HISTORY_ROWS : MAX_HISTORY_ROWS;
    let truncated = null;
    if (rows.length > cap) {
      const skipped = rows.length - cap;
      rows = rows.slice(rows.length - cap);
      truncated = { skipped, shown: rows.length };
    }
    // a degenerate auto-title (".") should read as "untitled", not a lone dot
    if (isTrivialText(title)) title = undefined;
    return { rows, title, truncated, failed };
  };
  /** Submit one prompt from the pet window to the chosen agent. */
  const submitChatPrompt = async (text) => {
    const agent = await resolveChatAgent();
    if (!agent || typeof agent.followup !== "function") {
      sendSignal({ type: "chat", kind: "error", text: "没有可对话的 Agent（请先在网页里打开一个会话）" });
      return false;
    }
    chatTargetAgent = agent;
    chatFollowSessionId = agent.id; // the panel is (and stays) on this session
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
      // NON-BLOCKING: populating the picker must never stall the chat bridge —
      // the queue would otherwise delay the transcript the user just asked for
      // behind a slow storage scan. The TTL cache keeps repeat opens instant.
      const now = Date.now();
      if (now - sessionsCache.at <= SESSIONS_CACHE_TTL_MS && sessionsCache.rows) {
        sendSignal({ type: "chat", kind: "sessions", list: sessionsCache.rows });
      } else {
        listSessions().then((rows) => {
          sessionsCache = { at: Date.now(), rows };
          sendSignal({ type: "chat", kind: "sessions", list: rows });
        });
      }
    } else if (cmd.cmd === "select-session" && typeof cmd.sessionId === "string") {
      // Point the chat at exactly this session. The transcript comes from the
      // persisted log (or the live session) and does NOT need the agent, so a
      // not-live session is resumed in the BACKGROUND — the user sees the
      // history immediately instead of waiting for the agent to boot.
      const live = ctx.get("agents")?.get?.(cmd.sessionId);
      if (live && typeof live.followup === "function") {
        chatTargetAgent = live;
        chatStreaming = false;
        chatStreamText = "";
      } else {
        resumeSessionAgent(cmd.sessionId).then((agent) => {
          if (agent && typeof agent.followup === "function") {
            chatTargetAgent = agent;
            chatStreaming = false;
            chatStreamText = "";
          }
        });
      }
      chatFollowSessionId = cmd.sessionId; // panel shows exactly this session
      const { rows: history, title, truncated, failed } = await loadTranscript(cmd.sessionId);
      sendSignal({ type: "chat", kind: "history", sessionId: cmd.sessionId, rows: history, title, truncated, failed });
    } else if (cmd.cmd === "current-session") {
      // The panel opened (or reopened): mirror whatever conversation is live —
      // the pinned chat target, else the web's most recently active session.
      const agentsSvc = ctx.get("agents");
      let targetId = null;
      let follow = false;
      if (chatTargetAgent !== null && agentsSvc?.get?.(chatTargetAgent.id)) {
        targetId = chatTargetAgent.id; // pinned target — normal transcript view
      } else {
        const live = agentsSvc?.list?.() ?? [];
        targetId = activeSessionId ?? live[0]?.id ?? null;
        follow = targetId !== null; // web-driven — the panel follows it
      }
      chatFollowSessionId = targetId;
      if (!targetId) {
        sendSignal({ type: "chat", kind: "history", sessionId: null, rows: [] });
        return;
      }
      const { rows: history, title, truncated, failed } = await loadTranscript(targetId);
      sendSignal({ type: "chat", kind: "history", sessionId: targetId, rows: history, title, follow, truncated, failed });
    } else if (cmd.cmd === "reset-chat-target") {
      // The panel closed: drop the pinned target so the next open follows the
      // web's active conversation again.
      chatTargetAgent = null;
      chatFollowSessionId = null;
      chatStreaming = false;
      chatStreamText = "";
    } else if (cmd.cmd === "new-session") {
      await startNewChat();
    }
  };
  /** Create a brand-new agent session and point the pet chat at it — the
   *  desktop equivalent of the web UI's "new chat". The fresh agent becomes
   *  the pinned chat target, so the next message sent from the pet continues
   *  the new conversation (and it is a real, persistable DSH session). */
  const startNewChat = async () => {
    try {
      const agentsSvc = ctx.get("agents");
      if (!agentsSvc || typeof agentsSvc.create !== "function") {
        sendSignal({ type: "chat", kind: "error", text: "无法开启新对话（Agent 服务不可用）" });
        return;
      }
      const handle = await agentsSvc.create({
        sessionId: `pet-chat-${crypto.randomUUID()}`,
      });
      if (!handle?.agent || typeof handle.agent.followup !== "function") {
        sendSignal({ type: "chat", kind: "error", text: "无法开启新对话" });
        return;
      }
      chatTargetAgent = handle.agent;
      chatFollowSessionId = handle.agent.id;
      chatStreaming = false;
      chatStreamText = "";
      sessionsCache = { at: 0, rows: [] }; // the picker must see the new session
      sendSignal({ type: "chat", kind: "new-session", sessionId: handle.agent.id });
    } catch (err) {
      console.error("[dsh-desktop-pet] new-session failed:", err?.message ?? err);
      sendSignal({ type: "chat", kind: "error", text: `开启新对话失败：${err?.message ?? err}` });
    }
  };
  /** Is this session's conversation shown in the pet chat panel? The EXPLICIT
   *  chat target (picked in the pet or resumed by a pet prompt) wins while it
   *  is still live; otherwise the panel MIRRORS the web's currently active
   *  session — so typing a message in the web UI shows up in the pet dialog. */
  const isChatSession = (sessionId) => {
    if (sessionId == null) return false;
    const agentsSvc = ctx.get("agents");
    // The panel only mirrors a conversation after the user EXPLICITLY picks
    // one (history session or new session). On a BLANK first open no chat
    // target is pinned, so live web activity must NOT stream into the empty
    // panel — otherwise the blank state would fill with an unrequested
    // conversation's deltas. chatTargetAgent is set by select-session /
    // new-session / a pet-side prompt; until then, nothing forwards.
    if (chatTargetAgent !== null && agentsSvc?.get?.(chatTargetAgent.id)) {
      return sessionId === chatTargetAgent.id;
    }
    return false;
  };
  /** Stream one assistant text delta to the pet chat window. */
  const chatDelta = (text, sid) => {
    if (!text) return;
    chatStreaming = true;
    chatStreamText += text;
    sendSignal({ type: "chat", kind: "delta", text, sessionId: sid });
  };
  /** Close an unfinished assistant stream (partial reply — e.g. interrupted). */
  const chatStreamEnd = (sid) => {
    if (!chatStreaming) return;
    chatStreaming = false;
    if (!isTrivialText(chatStreamText)) {
      sendSignal({ type: "chat", kind: "assistant", text: chatStreamText, sessionId: sid });
    }
    chatStreamText = "";
  };

  // Long-poll loop: one in-flight /poll at a time, backoff on failure so a
  // pet that is starting (or offline) does not spin. The pet answers with a
  // command ({ cmd: 'prompt'|'list-sessions'|'select-session', ... }) or
  // { empty: true } after its hold window.
  let pollTimer = null;
  let polling = false;
  let pollDisposed = false; // set when this plugin context is torn down
  let pollAbort = null; // the in-flight poll's controller (aborted on dispose)
  const pollDelay = (attempt) => Math.min(10_000, 200 * attempt);
  const pollOnce = async (attempt) => {
    if (polling || pollDisposed) return;
    polling = true;
    // hard bound on one long-poll round trip: the pet parks a poll for
    // POLL_HOLD_MS then answers { empty: true } — but if that response is
    // ever lost (or a second poll stranded ours), an unbounded fetch would
    // wedge `polling` forever and kill the whole chat bridge. Abort instead.
    const controller = new AbortController();
    pollAbort = controller;
    const pollTimerForRound = setTimeout(() => controller.abort(), 25_000);
    let hadCommand = false;
    try {
      const res = await fetch(`http://${HOST}:${PORT}/poll`, { method: "POST", signal: controller.signal });
      if (res.ok) {
        const payload = await res.json().catch(() => ({}));
        if (payload && typeof payload === "object" && payload.cmd) {
          hadCommand = true;
          // Do NOT await the handler here: some commands (select-session /
          // current-session) read the persisted session log, which can take
          // many seconds (or hang) on a large/corrupt transcript. Awaiting it
          // would park the long-poll loop on that read, so queued commands —
          // including the user's RETRY — would never be drained, and every
          // history load would time out in the pet. Fire-and-forget instead:
          // the handler sends its own reply signal, and the loop immediately
          // re-polls (hadCommand === true resets the backoff), so the next
          // command is picked up right away regardless of the slow one.
          handleChatCommand(payload).catch((err) => {
            console.error("[dsh-desktop-pet] chat command failed:", payload?.cmd, err?.message ?? err);
          });
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        // expected when the pet window is starting / offline: the round-trip
        // hits its hard bound and we simply re-poll after backoff. Not an
        // error worth printing on every cycle.
      }
      /* pet offline — retry after backoff */
    } finally {
      clearTimeout(pollTimerForRound);
      polling = false;
    }
    if (pollDisposed) return; // context torn down — never schedule again
    // after a command, poll again quickly (backoff resets) so the next
    // command is picked up immediately
    const nextAttempt = hadCommand ? 1 : attempt + 1;
    pollTimer = setTimeout(() => pollOnce(nextAttempt), pollDelay(nextAttempt));
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
      // Chat reply forwarding: the pet chat panel mirrors the followed
      // session (web-side input + streamed reply). When the followed session
      // CHANGES, the panel first receives the new session's transcript so the
      // mirror doesn't start mid-conversation. Every signal carries the
      // sessionId so the renderer can switch its view cleanly.
      if (isChatSession(session?.id)) {
        const type = event?.type;
        const sid = session?.id;
        if (type === "user/message") {
          const text = textOfBlocks(event?.data?.content);
          if (!isTrivialText(text)) {
            if (chatFollowSessionId !== sid) {
              // a different conversation became active (e.g. the user typed in
              // another web session): load its transcript FIRST (awaited so it
              // arrives before the echo), then forward the new message. The
              // live session logs the triggering message SYNCHRONOUSLY, so the
              // transcript would already contain it — drop that exact row by
              // message id, otherwise the panel shows the message twice (once
              // from the history, once from the echo).
              chatFollowSessionId = sid;
              const msgId = event?.data?.id;
              loadTranscript(sid).then(async ({ rows, title, truncated, failed }) => {
                const rowsWithout = msgId
                  ? rows.filter((r) => !(r.role === "user" && r.id === msgId))
                  : rows;
                await sendSignal({ type: "chat", kind: "history", sessionId: sid, rows: rowsWithout, title, follow: true, truncated, failed });
                await sendSignal({ type: "chat", kind: "user", text, sessionId: sid });
              });
            } else {
              sendSignal({ type: "chat", kind: "user", text, sessionId: sid });
            }
          }
        } else if (type === "assistant/chunk") {
          const chunk = event?.data?.chunk;
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
            chatDelta(chunk.text, sid);
          }
        } else if (type === "assistant/message") {
          // ONE authoritative assistant signal per message: the delta stream
          // already finalized its bubble, so only send the assembled text (the
          // renderer replaces the streaming bubble with it — no duplicate row).
          chatStreaming = false;
          chatStreamText = "";
          const text = textOfBlocks(event?.data?.message?.content);
          if (!isTrivialText(text)) sendSignal({ type: "chat", kind: "assistant", text, sessionId: sid });
          // accumulate this step's usage into the turn stats readout
          const usage = event?.data?.usage;
          if (usage) {
            chatStats.inputTokens += usage.inputTokens ?? 0;
            chatStats.outputTokens += usage.outputTokens ?? 0;
            chatStats.cacheReadTokens += usage.cacheReadTokens ?? 0;
            chatStats.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
            sendSignal({ type: "chat", kind: "stats", ...chatStats, sessionId: sid });
          }
        } else if (type === "turn/start") {
          // a new turn begins — reset the token stats and report the turn no.
          resetChatStats(event?.data?.turn);
          sendSignal({ type: "chat", kind: "stats", ...chatStats, sessionId: sid });
        } else if (type === "tool/call") {
          // frosted tool card like the web UI: icon + name + target summary,
          // an io-style 参数 (arguments) section, swept with a running
          // highlight until the matching tool/result
          const name = event?.data?.name;
          const callId = event?.data?.callId;
          let summary = null;
          let argsText = null;
          try {
            const args = JSON.parse(event?.data?.arguments ?? "{}");
            summary = toolDetailOf(name, args);
            const json = JSON.stringify(args);
            if (json && json !== "{}") argsText = json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
          } catch {
            /* arguments not (yet) parseable — keep header-only card */
          }
          sendSignal({ type: "chat", kind: "tool", callId, tool: name, label: toolLabel(name), summary, argsText, sessionId: sid });
        } else if (type === "tool/result") {
          const callId = event?.data?.message?.source?.callId ?? event?.data?.callId;
          // the tool-result block wraps the raw result strings in
          // { type: "tool-result", content: [...] } — walk INTO it
          const block = event?.data?.message?.content?.[0];
          const isError = !!(block && block.isError);
          let output = null;
          const strings = [];
          const collect = (v) => {
            if (typeof v === "string") strings.push(v);
            else if (Array.isArray(v)) v.forEach(collect);
            else if (v && typeof v === "object" && "content" in v) collect(v.content);
          };
          collect(event?.data?.message?.content);
          const joined = strings.join("\n").trim();
          if (joined) output = joined.length > 1500 ? `${joined.slice(0, 1500)}…` : joined;
          sendSignal({ type: "chat", kind: "tool-done", callId, output, isError, sessionId: sid });
        } else if (type === "turn/end") {
          chatStreamEnd(sid); // sends a partial reply only if the stream is open
          sendSignal({ type: "chat", kind: "done", sessionId: sid });
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
    // stop the long-poll loop completely: abort any in-flight /poll so a
    // reloaded plugin never keeps polling (and never strands the pet's poll
    // slot against the fresh instance)
    pollDisposed = true;
    try { pollAbort?.abort(); } catch { /* best-effort */ }
    // note: the spawned pet is NOT killed here — the user may want it to keep
    // running when the plugin unloads (e.g. dsh web restarts)
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  }, "dsh-desktop-pet: agent-state sync + config");
}
