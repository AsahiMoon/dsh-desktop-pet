/**
 * dsh-desktop-pet — renderer core logic (pure, DOM-free).
 *
 * Loaded two ways:
 *  - the browser as a classic <script> (attaches to window.PetCore), and
 *  - by vitest via CommonJS interop, so the task-signal tracking, state
 *    transitions and caption text formatting can be unit-tested without a DOM.
 */
"use strict";

/** Generic round-complete labels carry no information ("回合完成" fires on
 *  EVERY turn/end) and would flood the history — filtered out. */
const GENERIC_TASK_LABELS = new Set(["回合完成", "任务完成", "任务失败", "请求出错"]);

/** Phase display names for the caption box. */
const TASK_PHASE_TEXT = {
  idle: "😴 空闲中",
  think: "💭 思考中…",
  exec: "🛠️ 执行中",
  wait: "🕐 等待中…",
  done: "🎉 已完成",
  error: "😱 出错了",
  welcome: "👋 就绪",
};

/** [HH:MM] — same timestamp style as the original whale-girl's memory notes. */
function fmtTime(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Record a completed task into `history` (generic labels + consecutive
 *  duplicates dropped). Returns true when an entry was added. */
function noteCompleted(history, text) {
  if (!text) return false;
  const t = String(text).slice(0, 18);
  if (GENERIC_TASK_LABELS.has(t)) return false;
  if (history[history.length - 1] === t) return false;
  history.push(t);
  if (history.length > 6) history.shift();
  return true;
}

/** Record an executed tool into `history` (consecutive duplicates dropped). */
function noteRun(history, tool, label) {
  const t = (tool ?? label ?? "").toString().slice(0, 12);
  if (!t) return false;
  if (history[history.length - 1] === t) return false;
  history.push(t);
  if (history.length > 8) history.shift();
  return true;
}

/**
 * Fold one DSH signal into the task snapshot (mutates `taskState`), recording
 * completed tasks / executed tools into the supplied histories.
 */
function applyTaskSignal(taskState, signal, taskHistory, runHistory) {
  if (!signal || typeof signal.type !== "string") return;
  switch (signal.type) {
    case "exec":
      taskState.phase = "exec";
      taskState.tool = signal.tool ?? null;
      taskState.label = signal.label ?? null;
      noteRun(runHistory, signal.tool, signal.label);
      break;
    case "todo": {
      if (Array.isArray(signal.todos)) {
        const prev = new Map((taskState.todos ?? []).map((t) => [t.content, t.status]));
        taskState.todos = signal.todos;
        for (const t of signal.todos) {
          if (t.status === "completed" && prev.get(t.content) !== "completed") {
            noteCompleted(taskHistory, t.content);
          }
        }
      }
      break;
    }
    case "celebrate":
      taskState.phase = "done";
      taskState.label = signal.label ?? null;
      noteCompleted(taskHistory, signal.label);
      break;
    case "error":
      taskState.phase = "error";
      taskState.label = signal.label ?? null;
      break;
    case "think":
      if (taskState.phase !== "exec") taskState.phase = "think";
      break;
    case "working":
      taskState.phase = "exec";
      if (signal.label) taskState.label = signal.label;
      break;
    case "wait":
      if (taskState.phase !== "exec") taskState.phase = "wait";
      break;
    case "idle":
      if (taskState.phase !== "exec") taskState.phase = "idle";
      break;
    case "welcome":
      taskState.phase = "welcome";
      break;
    case "sync": {
      if (Array.isArray(signal.todos)) taskState.todos = signal.todos;
      if (signal.exec) taskState.phase = "exec";
      else if (signal.think) taskState.phase = "think";
      else if (signal.wait) taskState.phase = "wait";
      else if (taskState.phase === "exec" || taskState.phase === "think" || taskState.phase === "wait") {
        taskState.phase = "idle";
      }
      break;
    }
  }
}

/**
 * Heartbeat (sync) transition decision for the pet's agent state machine.
 * Returns the next state name, or null to keep the current one. Mirrors the
 * renderer's sync branch exactly, including its TWO sequential decision steps
 * (exec/working first, then think/wait/idle re-evaluated against the updated
 * state) — which is why `working` with no flags resolves all the way to
 * `idle` in one heartbeat.
 */
function syncNextState(state, busy, flags) {
  const exec = !!flags?.exec;
  const think = !!flags?.think;
  const wait = !!flags?.wait;
  let next = null;
  // step 1: exec wakes from ANY sleep (natural nap or post-work rest);
  // working degrades to think once exec clears
  if (exec) {
    if (state === "sleep" || (!busy && state === "idle")) next = "working";
  } else if (state === "working") {
    next = "think";
  }
  const s1 = next ?? state;
  // step 2: think / wait / idle-clear, re-evaluated after step 1
  if (think) {
    if (s1 === "sleep" || (!busy && (s1 === "idle" || s1 === "walk"))) next = "think";
  } else if (wait && !busy && s1 === "think") {
    next = "wait";
  } else if (!think && !wait && !exec && (s1 === "think" || s1 === "working" || s1 === "wait")) {
    next = "idle";
  }
  return next;
}

// ---------------------------------------------------------------------------
// caption text (the black info box below the pet)
// ---------------------------------------------------------------------------

/** Short status note for the current task (phase + tool, or 空闲中 / 💤). */
function taskNote(taskState, state) {
  if (state === "sleep") return "💤 睡觉中";
  if (taskState.phase !== "idle" && taskState.phase !== "welcome") {
    const phase = TASK_PHASE_TEXT[taskState.phase];
    const tool = taskState.tool
      ? String(taskState.tool).slice(0, 10)
      : taskState.label
        ? String(taskState.label).slice(0, 10)
        : "";
    return [phase ? phase.replace(/\s+$/, "") : null, tool].filter(Boolean).join(" ") || "工作中";
  }
  return "空闲中";
}

/** Hover summary — abbreviated (like the original whale-girl status card). */
function hoverText(ctx) {
  const { taskState, currentTodos, state, now } = ctx;
  const lines = [`[${fmtTime(now ?? Date.now())}] ${taskNote(taskState, state)}`];
  const done = (currentTodos ?? []).filter((t) => t.status === "completed").length;
  if (currentTodos?.length) {
    const active = currentTodos.find((t) => t.status === "in_progress");
    lines.push(`📋 ${done}/${currentTodos.length}${active ? " · " + String(active.content).slice(0, 10) : ""}`);
  }
  return lines.join("\n");
}

/** Persistent caption: brief (same as hover) or detailed. */
function persistText(ctx) {
  if (ctx.detailed) return detailedText(ctx);
  return hoverText(ctx);
}

/** Detailed view — what is actually running: time + phase/tool, todo progress
 *  with the active + completed steps, or the executed tools when idle. */
function detailedText(ctx) {
  const { taskState, currentTodos, taskHistory, runHistory, state, now } = ctx;
  const lines = [];
  if (state === "sleep") {
    lines.push(`[${fmtTime(now ?? Date.now())}] 💤 睡觉中`);
  } else if (taskState.phase !== "idle" && taskState.phase !== "welcome") {
    const head = [
      TASK_PHASE_TEXT[taskState.phase]?.replace(/\s+$/, ""),
      taskState.tool ? String(taskState.tool).slice(0, 10) : taskState.label ? String(taskState.label).slice(0, 12) : null,
    ].filter(Boolean);
    lines.push(`[${fmtTime(now ?? Date.now())}] ${head.join(" · ")}`);
    const todos = currentTodos ?? [];
    const done = todos.filter((t) => t.status === "completed").length;
    const active = todos.find((t) => t.status === "in_progress");
    if (todos.length) {
      const doneItems = todos.filter((t) => t.status === "completed").map((t) => String(t.content).slice(0, 6));
      lines.push(
        `📋 ${done}/${todos.length}${active ? " 正在" + String(active.content).slice(0, 8) : ""}${doneItems.length ? " ✅" + doneItems.slice(-2).join(" ✅") : ""}`,
      );
    } else if (taskState.label) {
      lines.push(`🛠️ ${String(taskState.label).slice(0, 22)}`);
    }
  } else {
    lines.push(`[${fmtTime(now ?? Date.now())}] 空闲中`);
    const runs = (runHistory ?? []).slice(-3).reverse();
    if (runs.length) {
      lines.push(`🛠️ 已执行：${runs.join(" · ")}`);
    } else {
      const done = (taskHistory ?? []).slice(-2).reverse();
      if (done.length) lines.push(`✅ 已完成：${done.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

// UMD-ish: browser classic script -> window.PetCore; Node/vitest -> exports.
const PetCore = {
  GENERIC_TASK_LABELS,
  TASK_PHASE_TEXT,
  fmtTime,
  noteCompleted,
  noteRun,
  applyTaskSignal,
  syncNextState,
  hoverText,
  persistText,
  detailedText,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = PetCore;
}
if (typeof window !== "undefined") {
  window.PetCore = PetCore;
}
