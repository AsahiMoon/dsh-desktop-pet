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
 *
 * The pet window also works standalone without this plugin (local autonomous
 * behavior, config from its own config.json); the plugin adds the agent-state
 * sync channel and the settings-backed hot config.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, NAMESPACE, buildSchema, validateConfig } from "./config.mjs";

export const name = "dsh-desktop-pet";
export const inject = ["jobs", "sessions", "agents", "settings"];

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 43991;
const HOST = "127.0.0.1";

/** Resolve the electron executable shipped with this package (dependency). */
let electronPath = null;
try {
  const mod = await import("electron");
  electronPath = typeof mod.default === "string" ? mod.default : null;
} catch {
  /* electron not installed here — the pet cannot be spawned, sync still works */
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

/** Spawn the pet window if electron is available. */
function ensurePet() {
  if (!electronPath) return;
  try {
    const child = spawn(electronPath, [path.join(ROOT, "main.js")], {
      stdio: "ignore",
      detached: false,
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
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
    ctx.on("session/event", (_session, event) => {
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
        // the model asked for a tool — show what it is doing (codex-pet style)
        activeTools++;
        const name = event?.data?.name;
        sendSignal({ type: "exec", tool: name, label: toolLabel(name) });
      } else if (type === "tool/result") {
        activeTools = Math.max(0, activeTools - 1);
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
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  }, "dsh-desktop-pet: agent-state sync + config");
}
