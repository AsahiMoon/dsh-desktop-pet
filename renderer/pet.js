/**
 * dsh-desktop-pet — renderer pet logic.
 * A sprite frame player (driven by the active character's manifest) plus a
 * small state machine with idle / walk / sleep / wake / eat / play / joy /
 * drag and event states, draggable window movement, a click menu, a growth
 * ledger (XP -> level -> titles, zero-negative), DSH agent-state signals and
 * hot config (size / opacity / walk / sleep / character).
 *
 * Frame animation is driven by a CSS @keyframes + steps() animation on
 * background-position-x — rendered by Chromium's compositor, immune to JS
 * timer throttling on unfocused windows (backgroundThrottling is also off in
 * main.js).
 */
"use strict";

const CHARACTERS_BASE = "pet://assets/characters/";

/** Default config — keep in sync with config.mjs DEFAULTS and main.js. */
const DEFAULT_CONFIG = Object.freeze({
  size: 110,
  opacity: 1,
  character: "whale-girl",
  walk: { enabled: true, intervalMs: 300000, durationMs: 26000 },
  sleepAfterMs: 60000,
  taskBarPersistent: false,
  taskBarDetailed: false,
  hideWhenIdle: false,
});

const TICK_ACTIVE_MS = 60_000; // +1 xp per minute of company
const XP_FEED = 5;
const XP_PLAY = 5;
const MENU_OPEN_MS = 4_000; // unused (native menu) — kept for reference
const BUBBLE_MS = 1_800;
const POST_WORK_NAP_MS = 25_000; // doze duration after a DSH task completes

const stage = document.getElementById("stage");
const petEl = document.getElementById("pet");
const spriteEl = document.getElementById("sprite");
const bubbleEl = document.getElementById("bubble");
const statusbarEl = document.getElementById("statusbar");
const settingsEl = document.getElementById("settings");
const characterSelect = document.getElementById("character-select");
const sizeRange = document.getElementById("size-range");
const sizeValue = document.getElementById("size-value");
const opacityRange = document.getElementById("opacity-range");
const opacityValue = document.getElementById("opacity-value");
const taskBarPersistentInput = document.getElementById("task-bar-persistent");
const taskBarDetailedInput = document.getElementById("task-bar-detailed");
const hideWhenIdleInput = document.getElementById("hide-when-idle");

// runtime config (merged defaults + signal/file config)
let CONFIG = { ...DEFAULT_CONFIG, walk: { ...DEFAULT_CONFIG.walk } };
let ROLES = [];

// Pure logic (task tracking / transitions / caption text / ledger) lives in
// core.cjs so it is unit-testable; pet.js wires it to the DOM + state machine.
// NOTE: classic <script> top-level const/let share ONE global lexical scope
// across files, so we must NOT re-declare any core name (e.g. DEFAULT_LEDGER)
// — always go through C.*.
const C = window.PetCore;

// ---------------------------------------------------------------------------
// config application (hot, from signals or boot)
// ---------------------------------------------------------------------------
function applyConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  const next = { ...CONFIG, ...cfg, walk: { ...CONFIG.walk, ...(cfg.walk ?? {}) } };
  const characterChanged = next.character !== CONFIG.character;
  const hideToggled = cfg.hideWhenIdle !== undefined && cfg.hideWhenIdle !== CONFIG.hideWhenIdle;
  CONFIG = next;
  document.body.style.setProperty("--pet-size", `${CONFIG.size}px`);
  if (hideToggled) {
    // live toggle: apply hide immediately if already in the long-quiet sleep
    if (CONFIG.hideWhenIdle && state === "sleep" && naturalSleep) hidePet();
    else if (!CONFIG.hideWhenIdle) showPet();
  }
  if (characterChanged && next.character) {
    loadCharacter(next.character);
  }
  renderCaption(); // persistent task bar can toggle live
}

// ---------------------------------------------------------------------------
// character loading — supports TWO formats:
//   1. our native format:   manifest.json { characters: { <id>: { name, states } } }
//   2. Codex pet format:    pet.json { id, displayName, spritesheetPath, frame,
//                            animations: { <state>: { frames: [indices], fps, loop } } }
//                           + spritesheet.webp (8x9 grid atlas, 192x208 cells).
// Codex pets are adapted: each animation's frame indices are sliced from the
// atlas into a horizontal strip (our player's native sheet shape), and state
// names are mapped onto our state machine with sensible defaults.
// ---------------------------------------------------------------------------
const CODE_TO_OURS = {
  idle: { name: "idle" },
  thinking: { name: "think", motion: "float" },
  working: { name: "working" },
  listening: { name: "wait", motion: "wiggle" },
  error: { name: "error", motion: "shake" },
  done: { name: "celebrate" },
  success: { name: "celebrate" },
  failed: { name: "error", motion: "shake" },
  welcome: { name: "welcome" },
  walking: { name: "walk" },
  sleeping: { name: "sleep" },
  eating: { name: "eat" },
  playing: { name: "play" },
  joyful: { name: "joy" },
  dragging: { name: "drag", motion: "tilt" },
  disappointed: { name: "disappointed" },
  // codex default animation track names
  "move_right": { name: "walk" },
  "move_left": { name: "walk" },
  running: { name: "working" },
  wave: { name: "welcome" },
  bounce: { name: "celebrate" },
  sad: { name: "disappointed" },
  waiting: { name: "wait", motion: "wiggle" },
  review: { name: "think", motion: "float" },
};

/**
 * Codex's built-in default animation table (used when pet.json omits
 * `animations`). Layout: 8 columns; row 0 = idle (uneven durations),
 * rows 1-8 = app-state tracks (uniform frame durations).
 */
function codexRow(row, count, ms, finalMs) {
  const frames = [];
  for (let c = 0; c < count; c++) frames.push(row * 8 + c);
  const avg = (ms * (count - 1) + (finalMs ?? ms)) / count;
  return { frames, fps: Math.max(1, Math.round(1000 / avg)) };
}
const CODEX_DEFAULT_ANIMATIONS = {
  idle: { frames: [0, 1, 2, 3, 4, 5], fps: 1, loop: true },
  "move_right": codexRow(1, 8, 120, 220),
  "move_left": codexRow(2, 8, 120, 220),
  wave: codexRow(3, 4, 140, 280),
  bounce: codexRow(4, 5, 140, 280),
  sad: codexRow(5, 8, 140, 240),
  waiting: codexRow(6, 6, 150, 260),
  running: codexRow(7, 6, 120, 220),
  review: codexRow(8, 6, 150, 280),
};
Object.values(CODEX_DEFAULT_ANIMATIONS).forEach((a) => { a.loop = true; });

/** States our state machine may request; codex pets without one fall back to idle art. */
const REQUIRED_STATES = [
  "idle", "think", "working", "wait", "celebrate", "error", "disappointed",
  "welcome", "walk", "sleep", "wake", "eat", "play", "joy", "drag",
];

async function loadImage(url) {
  // fetch as blob -> createImageBitmap: loading the custom-scheme image via
  // <img> would taint the canvas, making toDataURL() throw a SecurityError
  // and the whole codex character fail to render (blank pet).
  const res = await fetch(url);
  if (!res.ok) throw new Error("image fetch failed: " + url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

/** Adapt a Codex pet package (pet.json + spritesheet) into our states map. */
async function codexToStates(base, pet) {
  const frame = pet.frame ?? { width: 192, height: 208, columns: 8, rows: 9 };
  const sheetPath = pet.spritesheetPath ?? "spritesheet.webp";
  const img = await loadImage(base + sheetPath);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const animations = pet.animations ?? CODEX_DEFAULT_ANIMATIONS;
  const states = {};
  for (const [name, anim] of Object.entries(animations)) {
    const mapped = CODE_TO_OURS[name] ?? { name };
    const frames = Array.isArray(anim.frames) ? anim.frames.filter((n) => Number.isInteger(n) && n >= 0) : [];
    if (!frames.length) continue;
    canvas.width = frame.width * frames.length;
    canvas.height = frame.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frames.forEach((idx, i) => {
      const col = idx % frame.columns;
      const row = Math.floor(idx / frame.columns);
      ctx.drawImage(
        img,
        col * frame.width, row * frame.height, frame.width, frame.height,
        i * frame.width, 0, frame.width, frame.height,
      );
    });
    states[mapped.name] = {
      sheet: canvas.toDataURL("image/png"),
      frames: frames.length,
      fps: anim.fps ?? 8,
      playback: anim.loop === false ? "once" : "loop",
      ...(mapped.motion ? { motion: mapped.motion } : {}),
    };
  }
  // fill any state our machine needs that the pet lacks — fall back to idle
  const idle = states.idle ?? states[Object.keys(states)[0]];
  if (idle) {
    for (const need of REQUIRED_STATES) {
      if (!states[need]) states[need] = { ...idle, playback: idle.playback === "once" ? "loop" : idle.playback };
    }
  }
  if (Object.keys(states).length === 0) throw new Error("no animations in pet.json");
  return states;
}

async function loadCharacter(id) {
  if (!/^[a-z0-9-]+$/.test(id)) return;
  const base = `${CHARACTERS_BASE}${id}/`;
  try {
    // 1) native format: manifest.json
    const manifest = await (await fetch(`${base}manifest.json`)).json();
    const ch = manifest.characters?.[id] ?? manifest.characters?.[manifest.default];
    if (ch && ch.states) {
      CHARACTER_ID = id;
      ASSET_BASE = base;
      STATES = ch.states;
      if (stage.dataset.state) setState(stage.dataset.state); // replay with new art
      return;
    }
  } catch {
    /* not native format — try codex format next */
  }
  try {
    // 2) Codex pet format: pet.json + spritesheet
    const pet = await (await fetch(`${base}pet.json`)).json();
    const states = await codexToStates(base, pet);
    CHARACTER_ID = id;
    ASSET_BASE = base; // unused for codex pets (sheets are inline data URLs)
    STATES = states;
    if (stage.dataset.state) setState(stage.dataset.state);
    return;
  } catch (err) {
    console.error(`character ${id} codex load failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// sprite frame player (CSS animation driven)
// ---------------------------------------------------------------------------
let ASSET_BASE = `${CHARACTERS_BASE}whale-girl/`;
let CHARACTER_ID = "whale-girl";
const anim = { timer: 0, frameTimer: 0, frame: 0, dir: 1, def: null, onEnd: null, motionTimer: 0, motionName: null };
let innerEl = null;

// ---------------------------------------------------------------------------
// motion animations (JS-driven transform, mirroring whale-girl's manifest
// motion classes: tilt / shake / wiggle / float / hop / sigh / bob / squash / wave)
// ---------------------------------------------------------------------------
const MOTION_DEFS = {
  tilt: { dur: 900, apply: (t) => `rotate(${Math.sin(t) * 4}deg)` },
  shake: { dur: 500, apply: (t) => `translateX(${Math.sin(t) * 6}px)` },
  wiggle: { dur: 1100, apply: (t) => `rotate(${Math.sin(t) * 3}deg)` },
  float: { dur: 2600, apply: (t) => `translateY(${Math.sin(t) * -8}px)` },
  hop: { dur: 800, apply: (t) => `translateY(${-Math.abs(Math.sin(t)) * 14}px)` },
  hopSmall: { dur: 700, apply: (t) => `translateY(${-Math.abs(Math.sin(t)) * 9}px)` },
  sigh: { dur: 1600, apply: (t) => `translateY(${Math.sin(t) * 3}px) scaleY(${1 - Math.abs(Math.sin(t)) * 0.03})` },
  bob: { dur: 1800, apply: (t) => `translateY(${Math.sin(t) * -3}px)` },
  squash: { dur: 900, apply: (t) => `scaleY(${1 + Math.sin(t) * 0.04})` },
  wave: { dur: 1200, apply: (t) => `rotate(${Math.sin(t) * -6}deg)` },
};

// Idle "life" scheduler: while idle the pet gently bobs and occasionally
// plays a short micro-action (hop / wiggle / sigh / wave). Pure motion —
// never touches state/busy/lastInteractAt, so sleep & walk logic is unaffected.
let idleLifeTimer = null;
const IDLE_PULSES = [
  { motion: "hopSmall", dur: 700 },
  { motion: "wiggle", dur: 1100 },
  { motion: "sigh", dur: 1600 },
  { motion: "wave", dur: 1200 },
];
function scheduleIdleLife() {
  clearTimeout(idleLifeTimer);
  if (state !== "idle" || pierceMode) return;
  if (petHidden) {
    idleLifeTimer = setTimeout(scheduleIdleLife, 10_000); // hidden — defer pulses
    return;
  }
  idleLifeTimer = setTimeout(() => {
    if (state !== "idle" || pierceMode) return;
    const pulse = IDLE_PULSES[Math.floor(Math.random() * IDLE_PULSES.length)];
    startMotion(pulse.motion);
    idleLifeTimer = setTimeout(() => {
      if (state === "idle" && !STATES.idle?.motion) startMotion("bob");
      scheduleIdleLife();
    }, pulse.dur);
  }, 4500 + Math.random() * 8500);
}

function startMotion(name) {
  const motion = MOTION_DEFS[name];
  clearTimeout(anim.motionTimer);
  if (!motion) {
    anim.motionName = null;
    stage.style.transform = "";
    return;
  }
  anim.motionName = name;
  const t0 = performance.now();
  const step = () => {
    if (anim.motionName !== name) return;
    if (petHidden) {
      // nothing visible — keep the loop alive but almost free (~4fps)
      anim.motionTimer = setTimeout(step, 250);
      return;
    }
    const t = ((performance.now() - t0) / motion.dur) * Math.PI * 2;
    stage.style.transform = motion.apply(t);
    anim.motionTimer = setTimeout(step, 33); // ~30fps is plenty for gentle motions
  };
  step();
}

function stopMotion() {
  clearTimeout(anim.motionTimer);
  anim.motionName = null;
  stage.style.transform = "";
}

/** Lazily create the frame-strip viewport child (#sprite-inner). */
function ensureInner() {
  if (innerEl && innerEl.isConnected) return innerEl;
  innerEl = document.createElement("div");
  innerEl.id = "sprite-inner";
  spriteEl.append(innerEl);
  return innerEl;
}

function clearAnim() {
  clearTimeout(anim.timer);
  clearTimeout(anim.frameTimer);
  stopMotion();
  anim.onEnd = null;
}

/** Show frame i by translating the frame strip (compositor-safe). */
function renderFrame(i) {
  anim.frame = i;
  const def = anim.def;
  if (!def || def.frames <= 1) {
    innerEl.style.transform = "translateX(0)";
    return;
  }
  innerEl.style.transform = `translateX(-${(i / def.frames) * 100}%)`;
}

function playState(name, opts = {}) {
  clearAnim();
  const def = STATES[name];
  if (!def) return;
  anim.def = def;
  anim.frame = 0;
  anim.dir = 1;
  anim.onEnd = opts.onEnd ?? null;

  stage.dataset.state = name;
  startMotion(def.motion);

  const inner = ensureInner();
  // native-format sheets are filenames relative to ASSET_BASE; codex-adapted
  // sheets are absolute data URLs and must NOT get the prefix prepended
  const sheetUrl = /^(data:|https?:|pet:)/.test(def.sheet) ? def.sheet : `${ASSET_BASE}${def.sheet}`;
  inner.style.backgroundImage = `url("${sheetUrl}")`;
  inner.style.backgroundSize = "100% 100%";
  inner.style.width = `${def.frames * 100}%`;
  inner.style.animation = "none";
  renderFrame(0);

  if (def.frames <= 1) {
    // single-frame state: static art; motion (JS-driven on #stage) moves it
    if (opts.afterMs) anim.timer = setTimeout(finishState, opts.afterMs);
    return;
  }

  // timed states keep animating until the duration elapses, then advance
  if (opts.afterMs) anim.timer = setTimeout(finishState, opts.afterMs);
  startFrames();
}

/** JS timer loop — proven to run (renderer timers are not throttled with
 *  backgroundThrottling disabled in main.js); transform is a compositor
 *  property so the visual update is reliable. */
function startFrames() {
  const def = anim.def;
  if (!def || def.frames <= 1) return;
  if (def.playback === "blink") {
    const scheduleBlink = () => {
      if (anim.def !== def) return;
      anim.timer = setTimeout(() => {
        if (anim.def !== def) return;
        let i = 1;
        const step = () => {
          if (anim.def !== def) return;
          renderFrame(i);
          i++;
          if (i < def.frames) anim.timer = setTimeout(step, 120);
          else {
            renderFrame(0);
            scheduleBlink();
          }
        };
        step();
      }, 1200 + Math.random() * 2400);
    };
    scheduleBlink();
    return;
  }
  const interval = 1000 / def.fps;
  const step = () => {
    if (anim.def !== def) return;
    if (petHidden) {
      // window hidden — slow the frame loop to ~2fps, keep it alive
      anim.frameTimer = setTimeout(step, 500);
      return;
    }
    advanceFrame();
    anim.frameTimer = setTimeout(step, interval);
  };
  anim.frameTimer = setTimeout(step, interval);
}

function advanceFrame() {
  const def = anim.def;
  const max = def.frames - 1;
  if (def.playback === "pingpong") {
    anim.frame += anim.dir;
    if (anim.frame >= max) { anim.frame = max; anim.dir = -1; }
    else if (anim.frame <= 0) { anim.frame = 0; anim.dir = 1; }
  } else if (def.playback === "once") {
    if (anim.frame < max) anim.frame++;
    else {
      renderFrame(max);
      finishState();
      return;
    }
  } else {
    anim.frame = (anim.frame + 1) % def.frames;
  }
  renderFrame(anim.frame);
}

function finishState() {
  // capture the callback BEFORE clearAnim() — clearAnim nulls anim.onEnd,
  // so checking it afterwards would make every chained onEnd a no-op
  const cb = anim.onEnd;
  clearAnim();
  if (cb) {
    cb();
  }
}

// ---------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------
let state = "boot";
let stateSince = Date.now(); // for heartbeat-transition debounce (min-hold)
let lastInteractAt = Date.now();
let lastWalkAt = Date.now();
let busy = false;

function setState(name, opts = {}) {
  state = name;
  stateSince = Date.now();
  if (name === "idle" || name === "sleep") lastInteractAt = Date.now();
  playState(name, opts);
  if (name === "idle") {
    // richer idle: gentle breathing bob (unless the character defines its own
    // idle motion) + occasional micro-actions from the idle-life scheduler
    if (!STATES.idle?.motion) startMotion("bob");
    scheduleIdleLife();
  } else {
    clearTimeout(idleLifeTimer);
  }
}

function chain(name, durationMs, next) {
  // `next` is a callback (a state name string is also accepted): the old
  // `setState(next)` treated the FUNCTION itself as the state name, which
  // made playState(STATES[fn]) a silent no-op — every chained transition
  // froze on the last frame until some unrelated event interrupted it.
  setState(name, {
    afterMs: durationMs,
    onEnd: () => (typeof next === "function" ? next() : setState(next)),
  });
}

function toIdle() {
  busy = false;
  setState("idle");
}

function onMenuAction(act) {
  if (act === "settings") {
    openSettings();
    return;
  }
  lastInteractAt = Date.now();
  // codex pets often lack eat/play/joy tracks — fall back to the celebrate
  // (bounce) animation so feeding/playing still gives clear visual feedback
  const hasDistinct = (name) => !!STATES[name] && !!STATES.idle && STATES[name].sheet !== STATES.idle.sheet;
  switch (act) {
    case "feed":
      busy = true;
      ledger.feeds++;
      C.addXp(ledger, XP_FEED);
      chain(hasDistinct("eat") ? "eat" : "celebrate", 1600, () => chain("joy", 1400, toIdle));
      bubble("🍗 好吃~ 谢谢你！");
      break;
    case "play":
      busy = true;
      ledger.plays++;
      C.addXp(ledger, XP_PLAY);
      chain(hasDistinct("play") ? "play" : "celebrate", 1600, () => chain("joy", 1400, toIdle));
      bubble("🎾 接住啦！");
      break;
    case "cheer":
      busy = true;
      chain("celebrate", 2000, toIdle);
      bubble("🎉 加油！");
      break;
    case "task-on":
    case "task-off":
      // toggle the black task-progress box under the pet
      window.petAPI.setConfig({ taskBarPersistent: act === "task-on" });
      bubble(act === "task-on" ? "📋 任务进度已常驻显示" : "📋 任务进度已隐藏");
      break;
    case "detail-on":
    case "detail-off":
      // toggle the detailed persistent progress (completed tasks etc.)
      window.petAPI.setConfig({ taskBarDetailed: act === "detail-on" });
      bubble(act === "detail-on" ? "📋 已切换详细进度" : "📋 已切换简略进度");
      break;
    case "bottom":
      CONFIG = { ...CONFIG, bottomMode: !CONFIG.bottomMode };
      window.petAPI.setBottomMode(CONFIG.bottomMode);
      bubble(CONFIG.bottomMode ? "📌 已置底（贴桌面）" : "💫 已恢复置顶");
      break;
    case "pierce":
      togglePierce();
      bubble(pierceMode ? "🧊 已进入鼠标穿透（托盘菜单恢复）" : "💫 已恢复交互");
      break;
    case "quit":
      window.petAPI.quit();
      break;
  }
  if (act !== "pierce" && act !== "quit") saveLedgerSoon();
}

function togglePierce() {
  pierceMode = !pierceMode;
  window.petAPI.setClickThrough(pierceMode);
  spriteEl.style.opacity = pierceMode ? "0.4" : "1";
}

// ---------------------------------------------------------------------------
// settings panel — rendered in its own separate window (pet never enlarges).
// ---------------------------------------------------------------------------
function fillSettingsValues() {
  characterSelect.innerHTML = "";
  const FORMAT_TAG = { native: "", codex: " · Codex" };
  for (const role of ROLES) {
    const opt = document.createElement("option");
    opt.value = role.id;
    opt.textContent = `${role.name ?? role.id}${FORMAT_TAG[role.format] ?? ""}`;
    if (role.id === CHARACTER_ID) opt.selected = true;
    characterSelect.append(opt);
  }
  sizeRange.value = String(Math.round(CONFIG.size));
  sizeValue.textContent = String(Math.round(CONFIG.size));
  opacityRange.value = String(Math.round(CONFIG.opacity * 100));
  opacityValue.textContent = `${Math.round(CONFIG.opacity * 100)}%`;
  if (taskBarPersistentInput) taskBarPersistentInput.checked = !!CONFIG.taskBarPersistent;
  if (taskBarDetailedInput) taskBarDetailedInput.checked = !!CONFIG.taskBarDetailed;
  if (hideWhenIdleInput) hideWhenIdleInput.checked = !!CONFIG.hideWhenIdle;
}
function openSettings() {
  // pet window: just open the separate settings window
  window.petAPI.openSettingsPanel();
}
function closeSettings() {
  // settings window: close itself
  window.petAPI.closeSettingsPanel();
}
characterSelect.addEventListener("change", () => {
  const id = characterSelect.value;
  if (!id || id === CHARACTER_ID) return;
  window.petAPI.setConfig({ character: id });
  bubble(`🎭 切换角色：${ROLES.find((r) => r.id === id)?.name ?? id}`);
});
sizeRange.addEventListener("input", () => {
  const v = Number(sizeRange.value);
  sizeValue.textContent = String(v);
  window.petAPI.setConfig({ size: v });
});
opacityRange.addEventListener("input", () => {
  const v = Number(opacityRange.value);
  opacityValue.textContent = `${v}%`;
  window.petAPI.setConfig({ opacity: v / 100 });
});
document.getElementById("settings-close").addEventListener("click", closeSettings);
if (taskBarPersistentInput) {
  taskBarPersistentInput.addEventListener("change", () => {
    window.petAPI.setConfig({ taskBarPersistent: taskBarPersistentInput.checked });
  });
}
if (taskBarDetailedInput) {
  taskBarDetailedInput.addEventListener("change", () => {
    window.petAPI.setConfig({ taskBarDetailed: taskBarDetailedInput.checked });
  });
}
if (hideWhenIdleInput) {
  hideWhenIdleInput.addEventListener("change", () => {
    window.petAPI.setConfig({ hideWhenIdle: hideWhenIdleInput.checked });
  });
}

// ---------------------------------------------------------------------------
// interactivity: LEFT drag to move; RIGHT click opens the native menu
// ---------------------------------------------------------------------------
let drag = null;
let pierceMode = false;
// a drag ends with the mouse over the stage too (the window follows the
// cursor), which would fire a "click" — remember whether the last drag moved
let lastDragWasMove = false;

petEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (settingsEl.contains(e.target)) return;
  if (pierceMode) return;
  setState("drag");
  // The main process anchors the window at its OWN authoritative bounds and
  // applies the mouse DELTAS. window.screenX / absolute screenX/Y are not
  // reliable across DPI-scaled multi-display setups (they drift by ~200px),
  // but the delta between two screenX values is exact.
  drag = { startScreenX: e.screenX, startScreenY: e.screenY, moved: false };
  window.petAPI.dragStart();
  showPet();
  e.preventDefault();
});

let lastMoveAt = 0;
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const now = Date.now();
  if (now - lastMoveAt < 16) return; // throttle to ~60fps
  const dx = e.screenX - drag.startScreenX;
  const dy = e.screenY - drag.startScreenY;
  // 10px threshold: small jitter stays a click instead of a drag
  if (Math.abs(dx) + Math.abs(dy) > 10) drag.moved = true;
  if (drag.moved) {
    lastMoveAt = now;
    window.petAPI.moveTo(dx, dy); // deltas only — main adds the drag-start anchor
  }
});

window.addEventListener("mouseup", (e) => {
  if (!drag) return;
  lastDragWasMove = drag.moved;
  drag = null;
  // a real drag interrupts any busy chain (celebrate / eat / post-work nap),
  // otherwise the dropped onEnd would leave busy stuck at true
  if (lastDragWasMove) busy = false;
  setState("idle");
  window.petAPI.dragEnd();
});

// right-click opens the native action menu (left button is pure drag now)
petEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (settingsEl.contains(e.target)) return;
  if (pierceMode) return;
  window.petAPI.showMenu({ x: e.clientX, y: e.clientY, actions: availableActions() });
});

/** Menu actions derive from the character's actual animation tracks. */
function availableActions() {
  const hasDistinct = (n) => !!STATES[n] && !!STATES.idle && STATES[n].sheet !== STATES.idle.sheet;
  const actions = [];
  if (hasDistinct("eat")) actions.push("feed");
  if (hasDistinct("play")) actions.push("play");
  actions.push("cheer");
  actions.push(CONFIG.taskBarPersistent ? "task-off" : "task-on");
  actions.push(CONFIG.taskBarDetailed ? "detail-off" : "detail-on");
  actions.push("sep", "settings", "bottom", "pierce", "sep", "quit");
  return actions;
}

petEl.addEventListener("mouseenter", showStatusbar);
petEl.addEventListener("mouseleave", hideStatusbar);
// native menu item chosen by the user -> same action handler as before
if (window.petAPI && typeof window.petAPI.onMenuAction === "function") {
  window.petAPI.onMenuAction((act) => onMenuAction(act));
}

function bubble(text) {
  // While the agent is working, the black task box owns the caption strip:
  // transient bubbles (exec tool names arrive on EVERY tool call) would keep
  // stealing the strip and the task progress would never show.
  const taskActive = taskState.phase !== "idle" && taskState.phase !== "welcome";
  if (taskActive) return;
  bubbleEl.textContent = text;
  bubbleEl.classList.remove("hidden");
  statusbarEl.classList.add("hidden"); // the caption strip is exclusive
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubbleEl.classList.add("hidden");
    renderCaption(); // restore hover / persistent caption
  }, BUBBLE_MS);
}
let bubbleTimer = 0;

// Caption strip under the pet: one line, owned by either the transient
// bubble or the statusbar (hover or persistent task progress).
let hovering = false;
function showStatusbar() {
  if (SETTINGS_MODE) return; // never show the caption in the settings window
  hovering = true;
  renderCaption();
}
function hideStatusbar() {
  hovering = false;
  renderCaption();
}
function renderCaption() {
  if (SETTINGS_MODE) return; // the caption strip belongs to the pet window
  if (!bubbleEl.classList.contains("hidden")) return; // bubble owns the strip
  if (hovering || CONFIG.taskBarPersistent) {
    statusbarEl.textContent = hovering ? statusTextHover() : statusTextPersist();
    statusbarEl.classList.remove("hidden");
  } else {
    statusbarEl.classList.add("hidden");
  }
}

/** Caption text — pure formatting delegated to core.cjs (unit-tested). */
function captionCtx() {
  return {
    taskState,
    currentTodos,
    taskHistory,
    runHistory,
    state,
    offline,
    detailed: !!CONFIG.taskBarDetailed,
    now: Date.now(),
  };
}function statusTextHover() {
  return C.hoverText(captionCtx());
}
function statusTextPersist() {
  return C.persistText(captionCtx());
}
function statusTextDetailed() {
  return C.detailedText(captionCtx());
}

// task-progress snapshot from the agent's todo list (todo/write events)
let currentTodos = [];
function applyTodos(todos) {
  currentTodos = Array.isArray(todos) ? todos : [];
}

// ---------------------------------------------------------------------------
// autonomous loops (config-driven)
// ---------------------------------------------------------------------------
function tickIdle() {
  // keep the black box's [HH:MM] clock fresh while it is visible
  if (!statusbarEl.classList.contains("hidden")) renderCaption();
  if (updateOffline()) renderCaption(); // 📡 offline edge re-renders the caption
  if (busy || state !== "idle") return;
  if (Date.now() - lastInteractAt >= CONFIG.sleepAfterMs) {
    naturalSleep = true;
    setState("sleep");
    bubble("💤 打个盹…");
    if (CONFIG.hideWhenIdle) hidePet(); // long-quiet sleep -> hide the window
  }
}

// hideWhenIdle: hide the pet entirely during its long-quiet sleep, reappear
// on any real activity (DSH signals / click / drag). `naturalSleep` tells the
// long-quiet sleep apart from the brief post-work nap (which stays visible).
let naturalSleep = false;
let petHidden = false;
function hidePet() {
  if (petHidden) return;
  petHidden = true;
  stopMotion(); // nothing to animate while hidden — save CPU
  if (window.petAPI && typeof window.petAPI.setWindowVisible === "function") {
    window.petAPI.setWindowVisible(false);
  }
}
function showPet() {
  naturalSleep = false;
  if (!petHidden) return;
  petHidden = false;
  if (window.petAPI && typeof window.petAPI.setWindowVisible === "function") {
    window.petAPI.setWindowVisible(true);
  }
  // resume the right motion for the current state
  if (anim.def?.motion) startMotion(anim.def.motion);
  else if (state === "idle") {
    startMotion("bob");
    scheduleIdleLife();
  }
}

// offline detection: the DSH bundle heartbeats every 5s; if we ever received
// a signal and then go quiet for OFFLINE_AFTER_MS, show 📡 in the caption and
// relax any stuck agent states (never fires for the standalone exe).
let lastSignalAt = Date.now();
let everReceivedSignal = false;
let offline = false;
const OFFLINE_AFTER_MS = C.OFFLINE_AFTER_MS;

function updateOffline() {
  const was = offline;
  offline = everReceivedSignal && Date.now() - lastSignalAt > OFFLINE_AFTER_MS;
  if (offline && !was) {
    // link lost: stop waiting/working poses, relax to idle
    busy = false;
    if (state === "think" || state === "working" || state === "wait") setState("idle");
  }
  return offline !== was;
}

function maybeWalk() {
  if (!CONFIG.walk.enabled || busy || state !== "idle") return;
  if (Date.now() - lastWalkAt >= CONFIG.walk.intervalMs) {
    lastWalkAt = Date.now();
    busy = true;
    setState("walk", {
      afterMs: CONFIG.walk.durationMs,
      onEnd: () => {
        busy = false;
        setState("idle");
      },
    });
    // window movement is driven by the MAIN process (renderer screenX/Y and
    // window.screenX are unreliable on DPI-scaled multi-display setups); the
    // renderer only plays the walk animation while it lasts
    window.petAPI.walkStart({ durationMs: CONFIG.walk.durationMs });
  }
}

// left-click reaction (the menu itself is right-click only): wake from sleep,
// otherwise a quick happy bounce + a random line. Guarded against the click
// that fires right after a real drag.
const CLICK_LINES = ["呀！", "嘿嘿~", "♪", "在呢在呢！", "戳我干嘛~", "好耶！"];
petEl.addEventListener("click", (e) => {
  if (pierceMode) return;
  if (settingsEl.contains(e.target)) return;
  showPet(); // clicking always brings the pet back
  if (lastDragWasMove) {
    lastDragWasMove = false;
    return;
  }
  if (state === "sleep") {
    setState("wake", { onEnd: toIdle });
    bubble("😊 醒啦！");
    return;
  }
  if (busy || state === "drag" || state === "walk") return;
  const hasDistinct = (n) => !!STATES[n] && !!STATES.idle && STATES[n].sheet !== STATES.idle.sheet;
  if (hasDistinct("joy") || hasDistinct("celebrate")) {
    busy = true;
    chain(hasDistinct("joy") ? "joy" : "celebrate", 900, toIdle);
  } else {
    // codex pets without joy/celebrate art: motion-only reaction
    startMotion("hopSmall");
  }
  bubble(CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)]);
});

// ---------------------------------------------------------------------------
// DSH agent-state sync (signals pushed over HTTP by the bundle Node half)
// ---------------------------------------------------------------------------
// Current-task info snapshot, maintained from signals and rendered in the
// black info box below the pet (hover or persistent).
let taskState = { phase: "idle", tool: null, label: null, todos: [] };

// Recently completed tasks + executed tools — shown in the detailed view.
let taskHistory = [];
let runHistory = [];

function trackTaskSignal(signal) {
  C.applyTaskSignal(taskState, signal, taskHistory, runHistory);
  renderCaption(); // live task line under the pet
}

function handleSignal(signal) {
  if (!signal || typeof signal.type !== "string") return;
  // any signal proves the DSH link is alive (heartbeat is every 5s)
  lastSignalAt = Date.now();
  everReceivedSignal = true;
  trackTaskSignal(signal);
  if (signal.type === "config") {
    applyConfig(signal.config);
    return;
  }
  if (signal.type === "sync") {
    // heartbeat state alignment; must NOT refresh lastInteractAt (a 5s
    // heartbeat would otherwise keep the pet awake forever)
    if (Array.isArray(signal.todos)) applyTodos(signal.todos);
    if (signal.exec || signal.think || signal.wait) showPet(); // real activity
    const rawNext = C.syncNextState(state, busy, { exec: !!signal.exec, think: !!signal.think, wait: !!signal.wait });
    // min-hold: suppress heartbeat flips that arrive <300ms after the current
    // state began (prevents think/work jitter from rapid tool transitions)
    const next = C.debounceTransition(rawNext, state, stateSince, Date.now(), 300);
    if (next === "idle") busy = false;
    if (next) setState(next);
    return;
  }
  if (signal.type === "pierce") {
    // main process is authoritative for click-through mode (tray checkbox and
    // pet menu both converge there). Sync the local flag + dim the sprite.
    pierceMode = !!signal.enabled;
    spriteEl.style.opacity = pierceMode ? "0.4" : "1";
    return;
  }
  lastInteractAt = Date.now(); // DSH activity keeps the pet awake
  if (["exec", "working", "think", "wait", "celebrate", "error", "welcome"].includes(signal.type)) {
    showPet(); // real agent activity brings the pet back
  }
  switch (signal.type) {
    case "exec":
      // a tool call is running — show what the agent is doing (codex-pet style)
      if (!busy && (state === "idle" || state === "sleep" || state === "think" || state === "walk")) {
        setState("working");
      }
      bubble(signal.label ?? `🛠️ ${signal.tool ?? "工具"}`);
      break;
    case "tool-done":
      if (state === "working") setState("think");
      break;
    case "todo":
      applyTodos(signal.todos);
      break;
    case "celebrate":
      busy = true;
      chain("celebrate", 2200, () => {
        // after-work rest: the pet dozes off for a while (like the original
        // whale-girl), then wakes back to idle on its own — or immediately
        // when a new agent task arrives (see the sync exec/think branches)
        chain("sleep", POST_WORK_NAP_MS, toIdle);
        bubble("💤 干完活，睡一小会儿~");
      });
      bubble(`🎉 ${signal.label ?? "任务完成"}！`);
      break;
    case "error":
      busy = true;
      setState("error", { onEnd: () => chain("disappointed", 1600, toIdle) });
      bubble(`😱 ${signal.label ?? "出错了"}`);
      break;
    case "think":
      if (!busy && (state === "idle" || state === "sleep" || state === "walk")) {
        setState("think");
      }
      break;
    case "working":
      if (!busy && (state === "idle" || state === "sleep" || state === "walk")) {
        setState("working");
      }
      break;
    case "wait":
      if (!busy && (state === "think" || state === "working")) setState("wait");
      break;
    case "idle":
      if (state === "think" || state === "working" || state === "wait") {
        busy = false;
        setState("idle");
      }
      break;
    case "welcome":
      if (!busy) setState("welcome", { onEnd: toIdle });
      break;
  }
}
if (window.petAPI && typeof window.petAPI.onSignal === "function") {
  window.petAPI.onSignal(handleSignal);
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
let ledger = { ...C.DEFAULT_LEDGER };
let saveTimer = 0;
function saveLedgerSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.petAPI.saveLedger(ledger), 300);
}

setInterval(() => {
  ledger.activeMs += TICK_ACTIVE_MS;
  const unlocked = C.checkTitles(ledger); // returns newly unlocked title names
  if (unlocked.length) bubble(`🏅 获得称号：${unlocked.join("、")}`);
  saveLedgerSoon();
}, TICK_ACTIVE_MS);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
let STATES = null;
const FALLBACK_STATES = {
  idle: { sheet: "idle.png", frames: 3, fps: 2, playback: "blink" },
  walk: { sheet: "walk.png", frames: 3, fps: 6, playback: "pingpong" },
  sleep: { sheet: "sleep.png", frames: 2, fps: 1, playback: "loop" },
  wake: { sheet: "wake.png", frames: 2, fps: 3, playback: "once" },
  eat: { sheet: "eat.png", frames: 3, fps: 8, playback: "loop" },
  play: { sheet: "play.png", frames: 3, fps: 4, playback: "loop" },
  joy: { sheet: "joy.png", frames: 2, fps: 5, playback: "loop" },
  drag: { sheet: "drag.png", frames: 1, fps: 5, motion: "tilt", playback: "loop" },
  celebrate: { sheet: "celebrate.png", frames: 3, fps: 4, playback: "loop" },
  welcome: { sheet: "welcome.png", frames: 2, fps: 3, playback: "loop" },
  think: { sheet: "think.png", frames: 1, fps: 2, motion: "float", playback: "loop" },
  working: { sheet: "working.png", frames: 3, fps: 3, playback: "loop" },
  error: { sheet: "error.png", frames: 2, fps: 8, motion: "shake", playback: "once" },
  disappointed: { sheet: "disappointed.png", frames: 2, fps: 2, playback: "loop" },
  wait: { sheet: "wait.png", frames: 1, fps: 2, motion: "wiggle", playback: "loop" },
};

// settings window mode: rendered with ?settings=1 — only the panel, no pet
const SETTINGS_MODE = typeof location !== "undefined" && new URLSearchParams(location.search).get("settings") === "1";

async function boot() {
  // config + roles from the main process (hot config arrives as signals later)
  try {
    const init = await window.petAPI.getConfig();
    if (init && init.config) {
      CONFIG = { ...DEFAULT_CONFIG, ...init.config, walk: { ...DEFAULT_CONFIG.walk, ...(init.config.walk ?? {}) } };
      document.body.style.setProperty("--pet-size", `${CONFIG.size}px`);
    }
    if (Array.isArray(init?.roles)) ROLES = init.roles;
  } catch { /* standalone boot without IPC */ }

  if (SETTINGS_MODE) {
    // separate settings window: show only the panel
    document.body.dataset.settings = "";
    settingsEl.classList.remove("hidden");
    fillSettingsValues();
    // folder paths + open buttons (help users add pets / edit config)
    try {
      const paths = await window.petAPI.getPaths();
      const info = document.getElementById("paths-info");
      if (info) info.textContent = `角色文件夹：${paths?.characters ?? "—"}`;
      document.getElementById("open-characters")?.addEventListener("click", () => window.petAPI.openPath("characters"));
      document.getElementById("open-config")?.addEventListener("click", () => window.petAPI.openPath("config"));
    } catch {
      /* settings helper unavailable */
    }
    return;
  }

  // load the active character's manifest (fallback states if it fails)
  try {
    await loadCharacter(CONFIG.character || "whale-girl");
  } catch {
    /* fall through to FALLBACK_STATES */
  }
  if (!STATES) STATES = FALLBACK_STATES;

  // restore ledger + window position
  try {
    const saved = await window.petAPI.ready();
    if (saved && saved.ledger) ledger = { ...C.DEFAULT_LEDGER, ...saved.ledger };
  } catch { /* first run */ }

  stage.classList.add("enter");
  setTimeout(() => stage.classList.remove("enter"), 500);

  renderCaption(); // apply the persistent task bar on boot

  setState("welcome", {
    afterMs: 2600, // welcome art is a loop — move on to idle on its own
    onEnd: () => {
      if (Date.now() - (ledger.firstSeenAt || Date.now()) < 60_000) {
        bubble("👋 你好呀，我是鲸鱼娘！");
      }
      toIdle();
    },
  });

  setInterval(tickIdle, 5000);
  setInterval(maybeWalk, 5000);
  setInterval(() => saveLedgerSoon(), 30000);
}

boot();
