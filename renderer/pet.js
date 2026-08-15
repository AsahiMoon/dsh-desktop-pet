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
});

const TICK_ACTIVE_MS = 60_000; // +1 xp per minute of company
const XP_FEED = 5;
const XP_PLAY = 5;
const MENU_OPEN_MS = 4_000; // unused (native menu) — kept for reference
const BUBBLE_MS = 1_800;
const POST_WORK_NAP_MS = 25_000; // doze duration after a DSH task completes
const TITLES = [
  { id: "first-feed", name: "初次投喂", when: (s) => s.feeds >= 1 },
  { id: "regular", name: "常客", when: (s) => s.feeds >= 20 },
  { id: "veteran", name: "资深伙伴", when: (s) => s.feeds >= 100 },
  { id: "loyal", name: "常驻伙伴", when: (s) => s.activeMs >= 6 * 3_600_000 },
  { id: "playful", name: "玩伴", when: (s) => s.plays >= 30 },
];

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

// runtime config (merged defaults + signal/file config)
let CONFIG = { ...DEFAULT_CONFIG, walk: { ...DEFAULT_CONFIG.walk } };
let ROLES = [];

// ---------------------------------------------------------------------------
// growth ledger
// ---------------------------------------------------------------------------
const DEFAULT_LEDGER = { xp: 0, feeds: 0, plays: 0, activeMs: 0, firstSeenAt: Date.now(), titles: [] };

function levelFor(xp) {
  return Math.floor((1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 25)) / 2);
}
function checkTitles(ledger) {
  let changed = false;
  for (const t of TITLES) {
    if (t.when(ledger) && !ledger.titles.includes(t.id)) {
      ledger.titles.push(t.id);
      changed = true;
    }
  }
  return changed;
}
function addXp(ledger, n) {
  const before = levelFor(ledger.xp);
  ledger.xp += n;
  return levelFor(ledger.xp) > before;
}

// ---------------------------------------------------------------------------
// config application (hot, from signals or boot)
// ---------------------------------------------------------------------------
function applyConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  const next = { ...CONFIG, ...cfg, walk: { ...CONFIG.walk, ...(cfg.walk ?? {}) } };
  const characterChanged = next.character !== CONFIG.character;
  CONFIG = next;
  document.body.style.setProperty("--pet-size", `${CONFIG.size}px`);
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
    const t = ((performance.now() - t0) / motion.dur) * Math.PI * 2;
    stage.style.transform = motion.apply(t);
    anim.motionTimer = setTimeout(step, 16);
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
let lastInteractAt = Date.now();
let lastWalkAt = Date.now();
let busy = false;

function setState(name, opts = {}) {
  state = name;
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
      addXp(ledger, XP_FEED);
      chain(hasDistinct("eat") ? "eat" : "celebrate", 1600, () => chain("joy", 1400, toIdle));
      bubble("🍗 好吃~ 谢谢你！");
      break;
    case "play":
      busy = true;
      ledger.plays++;
      addXp(ledger, XP_PLAY);
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

/** [HH:MM] — same timestamp style as the original whale-girl's memory notes. */
function fmtTime(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Hover summary — abbreviated, referencing the original whale-girl status
 *  card: a [HH:MM] note + short status (no growth stats). Wide flat box. */
function statusTextHover() {
  const lines = [];
  let note;
  if (state === "sleep") {
    note = "💤 睡觉中";
  } else if (taskState.phase !== "idle" && taskState.phase !== "welcome") {
    const phase = TASK_PHASE_TEXT[taskState.phase];
    const tool = taskState.tool
      ? String(taskState.tool).slice(0, 10)
      : taskState.label
        ? String(taskState.label).slice(0, 10)
        : "";
    note = [phase ? phase.replace(/\s+$/, "") : null, tool].filter(Boolean).join(" ") || "工作中";
  } else {
    note = "空闲中";
  }
  lines.push(`[${fmtTime()}] ${note}`);
  const done = currentTodos.filter((t) => t.status === "completed").length;
  if (currentTodos.length) {
    const active = currentTodos.find((t) => t.status === "in_progress");
    lines.push(`📋 ${done}/${currentTodos.length}${active ? " · " + String(active.content).slice(0, 10) : ""}`);
  }
  return lines.join("\n");
}

/** Persistent task progress: brief (same compact style as hover) or detailed
 *  (current run specifics + completed steps + executed tools). */
function statusTextPersist() {
  if (CONFIG.taskBarDetailed) return statusTextDetailed();
  return statusTextHover();
}

/** Detailed view — what is actually running: time + phase/tool, todo progress
 *  with the active step and completed steps, or the executed tools when idle. */
function statusTextDetailed() {
  const lines = [];
  if (state === "sleep") {
    lines.push(`[${fmtTime()}] 💤 睡觉中`);
  } else if (taskState.phase !== "idle" && taskState.phase !== "welcome") {
    const head = [
      TASK_PHASE_TEXT[taskState.phase]?.replace(/\s+$/, ""),
      taskState.tool ? String(taskState.tool).slice(0, 10) : taskState.label ? String(taskState.label).slice(0, 12) : null,
    ].filter(Boolean);
    lines.push(`[${fmtTime()}] ${head.join(" · ")}`);
    const done = currentTodos.filter((t) => t.status === "completed").length;
    const active = currentTodos.find((t) => t.status === "in_progress");
    if (currentTodos.length) {
      const doneItems = currentTodos
        .filter((t) => t.status === "completed")
        .map((t) => String(t.content).slice(0, 6));
      lines.push(
        `📋 ${done}/${currentTodos.length}${active ? " 正在" + String(active.content).slice(0, 8) : ""}${doneItems.length ? " ✅" + doneItems.slice(-2).join(" ✅") : ""}`,
      );
    } else if (taskState.label) {
      lines.push(`🛠️ ${String(taskState.label).slice(0, 22)}`);
    }
  } else {
    lines.push(`[${fmtTime()}] 空闲中`);
    const runs = runHistory.slice(-3).reverse();
    if (runs.length) {
      lines.push(`🛠️ 已执行：${runs.join(" · ")}`);
    } else {
      const done = taskHistory.slice(-2).reverse();
      if (done.length) lines.push(`✅ 已完成：${done.join(" · ")}`);
    }
  }
  return lines.join("\n");
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
  if (busy || state !== "idle") return;
  if (Date.now() - lastInteractAt >= CONFIG.sleepAfterMs) {
    setState("sleep");
    bubble("💤 打个盹…");
  }
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

// Recently completed tasks (from todo transitions + celebrate labels) and
// recently executed tools (from exec signals) — shown in the detailed view.
// Generic round-complete labels ("回合完成" fires on EVERY turn/end) carry no
// information and would flood the list — only meaningful entries are kept,
// and consecutive duplicates are collapsed.
const GENERIC_TASK_LABELS = new Set(["回合完成", "任务完成", "任务失败", "请求出错"]);
let taskHistory = [];
let runHistory = [];
function noteCompletedTask(text) {
  if (!text) return;
  const t = String(text).slice(0, 18);
  if (GENERIC_TASK_LABELS.has(t)) return;
  if (taskHistory[taskHistory.length - 1] === t) return; // consecutive dedupe
  taskHistory.push(t);
  if (taskHistory.length > 6) taskHistory.shift();
}
function noteRun(tool, label) {
  const t = (tool ?? label ?? "").toString().slice(0, 12);
  if (!t) return;
  if (runHistory[runHistory.length - 1] === t) return; // consecutive dedupe
  runHistory.push(t);
  if (runHistory.length > 8) runHistory.shift();
}

function trackTaskSignal(signal) {
  switch (signal.type) {
    case "exec":
      taskState.phase = "exec";
      taskState.tool = signal.tool ?? null;
      taskState.label = signal.label ?? null;
      noteRun(signal.tool, signal.label);
      break;
    case "todo": {
      if (Array.isArray(signal.todos)) {
        const prev = new Map((taskState.todos ?? []).map((t) => [t.content, t.status]));
        taskState.todos = signal.todos;
        for (const t of signal.todos) {
          if (t.status === "completed" && prev.get(t.content) !== "completed") {
            noteCompletedTask(t.content);
          }
        }
      }
      break;
    }
    case "celebrate":
      taskState.phase = "done";
      taskState.label = signal.label ?? null;
      if (signal.label) noteCompletedTask(signal.label);
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
  renderCaption(); // live task line under the pet
}

const TASK_PHASE_TEXT = {
  idle: "😴 空闲中",
  think: "💭 思考中…",
  exec: "🛠️ 执行中",
  wait: "🕐 等待中…",
  done: "🎉 已完成",
  error: "😱 出错了",
  welcome: "👋 就绪",
};

function handleSignal(signal) {
  if (!signal || typeof signal.type !== "string") return;
  trackTaskSignal(signal);
  if (signal.type === "config") {
    applyConfig(signal.config);
    return;
  }
  if (signal.type === "sync") {
    // heartbeat state alignment; must NOT refresh lastInteractAt (a 5s
    // heartbeat would otherwise keep the pet awake forever)
    if (Array.isArray(signal.todos)) applyTodos(signal.todos);
    // exec: show the pet working. Wake from ANY sleep — the natural nap or
    // the post-work rest — so a new task interrupts the doze; skip a busy walk.
    if (signal.exec && (state === "sleep" || (!busy && state === "idle"))) {
      setState("working");
    } else if (!signal.exec && state === "working") {
      setState("think");
    }
    if (signal.think && (state === "sleep" || (!busy && (state === "idle" || state === "walk")))) {
      setState("think");
    } else if (signal.wait && !busy && state === "think") {
      setState("wait");
    } else if (!signal.think && !signal.wait && !signal.exec && (state === "think" || state === "working" || state === "wait")) {
      busy = false;
      setState("idle");
    }
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
let ledger = { ...DEFAULT_LEDGER };
let saveTimer = 0;
function saveLedgerSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.petAPI.saveLedger(ledger), 300);
}

setInterval(() => {
  ledger.activeMs += TICK_ACTIVE_MS;
  if (checkTitles(ledger)) bubble(`🏅 获得称号：${statusText().split("｜").pop().trim()}`);
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
    if (saved && saved.ledger) ledger = { ...DEFAULT_LEDGER, ...saved.ledger };
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
