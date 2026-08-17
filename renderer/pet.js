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
  taskBarPersistent: true,
  taskBarDetailed: true,
  hideWhenIdle: false,
  chatWidth: 300, // chat panel size (user-resizable; main process owns sizing)
  chatHeight: 560,
});

const TICK_ACTIVE_MS = 60_000; // +1 xp per minute of company
const XP_FEED = 5;
const XP_PLAY = 5;
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

// settings window mode: rendered with ?settings=1 — only the panel, no pet.
// Declared at the TOP so every module-scope registration below can skip pet
// behavior: the settings window must not process agent signals (STATES is
// null there — a state flip would crash), drag the pet, or touch the ledger.
const SETTINGS_MODE = typeof location !== "undefined" && new URLSearchParams(location.search).get("settings") === "1";
// chat window mode: rendered with ?chat=1 — a message list + input box for
// talking to the DSH agent, no pet sprite, no agent state flips.
const CHAT_MODE = typeof location !== "undefined" && new URLSearchParams(location.search).get("chat") === "1";

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

// Load-race guard: character loading is async (manifest/codex fetch + image
// decode). Rapidly switching characters starts several loads at once; only the
// MOST RECENT request may apply its result, otherwise the pet can end up
// showing a stale character.
let loadToken = 0;
async function loadCharacter(id) {
  if (!/^[a-z0-9-]+$/.test(id)) return;
  const token = ++loadToken;
  const base = `${CHARACTERS_BASE}${id}/`;
  try {
    // 1) native format: manifest.json
    const manifest = await (await fetch(`${base}manifest.json`)).json();
    const ch = manifest.characters?.[id] ?? manifest.characters?.[manifest.default];
    if (ch && ch.states) {
      if (token !== loadToken) return; // superseded by a newer load
      CHARACTER_ID = id;
      ASSET_BASE = base;
      STATES = ch.states;
      updateChatAvatar(); // the chat title bar shows this character's face
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
    if (token !== loadToken) return;
    CHARACTER_ID = id;
    ASSET_BASE = base; // unused for codex pets (sheets are inline data URLs)
    STATES = states;
    updateChatAvatar();
    if (stage.dataset.state) setState(stage.dataset.state);
    return;
  } catch (err) {
    if (token === loadToken) console.error(`character ${id} codex load failed:`, err.message);
  }
}

/** Show the ACTIVE character's idle frame (first frame only) as the round
 *  avatar in the chat title bar — the whale-girl face lives in the dialog. */
function updateChatAvatar() {
  const av = document.getElementById("chat-avatar");
  if (!av) return;
  const idle = STATES?.idle;
  if (!idle) {
    av.style.display = "none";
    return;
  }
  const url = /^(data:|https?:|pet:)/.test(idle.sheet) ? idle.sheet : `${ASSET_BASE}${idle.sheet}`;
  const frames = Math.max(1, idle.frames ?? 1);
  av.style.backgroundImage = `url("${url}")`;
  av.style.backgroundSize = `${frames * 100}% 100%`; // one frame of the strip
  av.style.backgroundPosition = "0 0";
  av.style.display = "inline-block";
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
  if (act === "chat") {
    // pet window: open the separate chat window
    window.petAPI.openChat();
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
// chat panel resize state (set by the resize handles in the chat panel):
// deltas are forwarded to main, which grows the window anchored to the pet.
let resizing = null;
// what started the current window drag: "pet" (sprite) or "title" (chat title
// bar) — a title-bar drag moves the window but leaves the pet's state alone.
let dragSource = "pet";
// a drag ends with the mouse over the stage too (the window follows the
// cursor), which would fire a "click" — remember whether the last drag moved
let lastDragWasMove = false;

petEl.addEventListener("mousedown", (e) => {
  if (SETTINGS_MODE) return; // the settings window never drags the pet
  if (e.button !== 0) return;
  if (settingsEl.contains(e.target)) return;
  if (pierceMode) return;
  setState("drag");
  // The main process anchors the window at its OWN authoritative bounds and
  // applies the mouse DELTAS. window.screenX / absolute screenX/Y are not
  // reliable across DPI-scaled multi-display setups (they drift by ~200px),
  // but the delta between two screenX values is exact.
  dragSource = "pet";
  drag = { startScreenX: e.screenX, startScreenY: e.screenY, moved: false };
  window.petAPI.dragStart();
  showPet();
  e.preventDefault();
});

let lastMoveAt = 0;
window.addEventListener("mousemove", (e) => {
  if (resizing) {
    const now = Date.now();
    if (now - lastMoveAt < 16) return; // throttle to ~60fps
    lastMoveAt = now;
    const rawDx = e.screenX - resizing.startX;
    const rawDy = e.screenY - resizing.startY;
    // intuitive edge stretch: drag an edge OUTWARD to enlarge the panel
    // (left edge: dragging left grows; right edge: dragging right grows).
    // The main process anchors the pet, so the window grows on the free side.
    const growthX = resizing.mode === "left" ? -rawDx : (resizing.mode === "right" ? rawDx : 0);
    const growthY = resizing.mode === "bottom" ? rawDy : 0;
    window.petAPI.chatResizeMove(growthX, growthY);
    return;
  }
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
  if (resizing) {
    resizing = null;
    if (window.petAPI && typeof window.petAPI.chatResizeEnd === "function") {
      window.petAPI.chatResizeEnd();
    }
    return;
  }
  if (!drag) return;
  const moved = drag.moved;
  const source = dragSource;
  drag = null;
  dragSource = "pet";
  if (source === "pet") {
    lastDragWasMove = moved;
    // a real drag interrupts any busy chain (celebrate / eat / post-work nap),
    // otherwise the dropped onEnd would leave busy stuck at true
    if (moved) busy = false;
    setState("idle");
  }
  window.petAPI.dragEnd();
});

// right-click opens the native action menu (left button is pure drag now)
petEl.addEventListener("contextmenu", (e) => {
  if (SETTINGS_MODE) return;
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
  actions.push("chat");
  actions.push(CONFIG.taskBarPersistent ? "task-off" : "task-on");
  actions.push(CONFIG.taskBarDetailed ? "detail-off" : "detail-on");
  actions.push("sep", "settings", "bottom", "pierce", "sep", "quit");
  return actions;
}

petEl.addEventListener("mouseenter", () => {
  if (SETTINGS_MODE) return;
  showStatusbar();
});
petEl.addEventListener("mouseleave", () => {
  if (SETTINGS_MODE) return;
  hideStatusbar();
});
// native menu item chosen by the user -> same action handler as before
if (!SETTINGS_MODE && window.petAPI && typeof window.petAPI.onMenuAction === "function") {
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
// set by bootChat while the in-window chat panel is visible — the window must
// never auto-hide (hideWhenIdle) while the user is looking at the dialog
let chatPanelVisible = false;
function hidePet() {
  if (petHidden) return;
  if (chatPanelVisible) return; // never vanish under an open chat panel
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
  if (SETTINGS_MODE) return;
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
// The settings window must NOT process agent signals: STATES is never loaded
// there, so any state-driving signal (celebrate/exec/error…) would crash the
// renderer on playState(STATES[name]) — and the pet itself already handles
// every signal. The chat window likewise processes ONLY chat signals.
if (!SETTINGS_MODE && !CHAT_MODE && window.petAPI && typeof window.petAPI.onSignal === "function") {
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
  // The settings window runs this same renderer with a FRESH default ledger —
  // it must never tick or persist growth data (main.js also rejects its saves).
  // The chat window likewise must not tick (it has no pet).
  if (SETTINGS_MODE || CHAT_MODE) return;
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

// settings window mode: declared at the TOP of this file (see SETTINGS_MODE)

async function boot() {
  // The chat panel's open flag (data-chat-open) hides the task-progress box
  // via CSS while the panel is open. It must never survive a boot: the panel
  // is closed on startup by definition, so clear any stale residue (an older
  // client that failed to remove it on panel-close would otherwise keep the
  // black caption hidden forever).
  delete document.body.dataset.chatOpen;
  delete document.body.dataset.chatSide;
  document.body.style.removeProperty("--pet-shift-y");
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
    // Re-scan characters + config whenever the settings window regains focus —
    // pets installed via petdex (or folders dropped into the characters dir)
    // and config changed elsewhere (DSH settings UI, tray) show up without
    // restarting the app. (Agent signals are NOT processed here, so this is
    // the settings window's only source of config refresh.)
    window.addEventListener("focus", async () => {
      try {
        const init = await window.petAPI.getConfig();
        if (init?.config) {
          CONFIG = { ...DEFAULT_CONFIG, ...init.config, walk: { ...DEFAULT_CONFIG.walk, ...(init.config.walk ?? {}) } };
        }
        if (Array.isArray(init?.roles)) ROLES = init.roles;
        fillSettingsValues();
      } catch {
        /* ignore */
      }
    });
    return;
  }

  if (CHAT_MODE) {
    // legacy ?chat=1 mode — kept for safety but no longer used by the app;
    // the chat panel now lives inside the pet window itself.
    document.body.dataset.chat = "";
    document.getElementById("chat").classList.remove("hidden");
    bootChat();
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

  // The in-pet-window chat panel initializes with the pet window; it stays
  // hidden until the user opens it (tray / right-click「💬 对话」).
  bootChat();
}

// ---------------------------------------------------------------------------
// chat panel — lives INSIDE the pet window, beside the model. Opening the
// panel (tray/right-click「💬 对话」) enlarges the window via pet:chat-panel;
// the renderer lays the panel out in the grown area. It shows a session
// picker (history), the transcript of the chosen session, an input box, and
// streams assistant replies as chat signals (kind: user / delta / assistant /
// done / error / sessions / history).
// ---------------------------------------------------------------------------
function bootChat() {
  const chatEl = document.getElementById("chat");
  const messagesEl = document.getElementById("chat-messages");
  const inputEl = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const hintEl = document.getElementById("chat-hint");
  const closeBtn = document.getElementById("chat-close");
  const sessionsEl = document.getElementById("chat-sessions");
  const pickerBtn = document.getElementById("chat-session-picker");
  const newBtn = document.getElementById("chat-new");
  const statsEl = document.getElementById("chat-stats");
  const titleLabel = document.getElementById("chat-title-label");

  let busy = false;
  let assistantBubble = null; // the in-progress assistant bubble being streamed
  let streamingText = ""; // raw markdown source accumulated from deltas
  let history = []; // [{ role: 'user' | 'assistant', text }]
  let sessions = []; // [{ id, title, preview, createdAt }]
  let currentSessionId = null;
  let chatInitialized = false;
  let sessionsLoaded = false; // set true once the picker has been opened by the user (🗂️)
  // texts of messages we just sent from the pet — the plugin echoes the
  // session's user/message event, and those echoes are deduped against this
  // set (the optimistic bubble already shows the message)
  const pendingUserEchoes = new Set();

  // History loading is asynchronous (the plugin reads the session log and
  // replies with a `history` signal). Two guards keep the panel honest:
  //   1. staleness — only a `history` for the session the user is waiting for
  //      (or, in mirror mode, ANY session) is applied, so a slow/stale
  //      response can never clobber a newer view;
  //   2. a watchdog — if the plugin never answers, the "⏳ 正在加载…" spinner
  //      is replaced by a retry button instead of hanging forever. The plugin
  //      reads live sessions from memory (instant) and waits for cold-log
  //      reads like the web UI does, so 30s is a generous dead-man switch.
  const HISTORY_LOAD_TIMEOUT_MS = 30_000;
  let historyReqSeq = 0;    // bumps on every load request (invalidates old ones)
  let pendingLoadId = null; // sessionId awaited; null = mirror mode
  let pendingLoadTimer = 0;

  /** Show a centered placeholder inside the message area. */
  const showPlaceholder = (text) => {
    messagesEl.innerHTML = "";
    const box = document.createElement("div");
    box.className = "chat-session-empty";
    box.textContent = text;
    messagesEl.append(box);
  };

  /** Replace the spinner with a timeout message + a retry button. The retry
   *  re-arms the watchdog and re-issues the same request. */
  const showLoadTimeout = (id, send) => {
    const label = document.createElement("span");
    label.textContent = "⏳ 加载超时，";
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "chat-retry-btn";
    retryBtn.textContent = "点击重试";
    retryBtn.addEventListener("click", () => {
      showPlaceholder("⏳ 正在加载历史对话…");
      armHistoryWatchdog(id, send); // re-arms the watchdog and re-sends
    });
    messagesEl.innerHTML = "";
    const box = document.createElement("div");
    box.className = "chat-session-empty";
    box.append(label, retryBtn);
    messagesEl.append(box);
    setHint("⚠️ 历史记录加载超时，请确认 DSH 插件已连接");
  };

  /** Arm the history-load watchdog, then issue the request.
   *  @param id sessionId awaited (null = accept the next history signal)
   *  @param send re-issuable request (also used by the retry button) */
  const armHistoryWatchdog = (id, send) => {
    pendingLoadId = id ?? null;
    const seq = ++historyReqSeq;
    clearTimeout(pendingLoadTimer);
    pendingLoadTimer = setTimeout(() => {
      if (seq !== historyReqSeq) return; // superseded by a newer request
      showLoadTimeout(id, send);
    }, HISTORY_LOAD_TIMEOUT_MS);
    send();
  };

  // If the plugin bridge is down, a sent message would hang "Agent 思考中…"
  // forever (the enqueue succeeds but nobody ever replies). Watchdog: any chat
  // traffic while waiting resets it; silence past the timeout unblocks input.
  const SEND_TIMEOUT_MS = 90_000;
  let sendWatchdog = 0;
  const armSendWatchdog = () => {
    clearTimeout(sendWatchdog);
    sendWatchdog = setTimeout(() => {
      if (!busy) return;
      busy = false;
      assistantBubble = null;
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      setHint("⚠️ 长时间未收到回复，请确认 DSH 插件已连接");
    }, SEND_TIMEOUT_MS);
  };

  /** Whether the transcript is scrolled to (near) the bottom — only then do
   *  new messages auto-scroll, so reading older history isn't yanked away. */
  const nearBottom = () =>
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;

  /** Consecutive tool calls (no message row between them) merge into ONE
   *  collapsible group — collapsed by default, the head shows the count plus
   *  the LATEST tool's preview; click to expand the full run. A lone tool
   *  call keeps the plain card look. */
  let lastMsgWasTool = false; // the last appended row was a tool card
  let lastToolCard = null;    // the most recent bare (ungrouped) tool card
  let activeToolGroup = null; // the open group container, if any

  /** A message row was appended — the current tool run ends here. */
  const sealToolRun = () => {
    lastMsgWasTool = false;
    lastToolCard = null;
    activeToolGroup = null;
  };

  /** Refresh a group's head: tool count, latest tool preview, running state. */
  const syncToolGroup = (group) => {
    if (!group) return;
    const cards = [...group.querySelectorAll(".chat-tool-group-body > .chat-tool")];
    const countEl = group.querySelector(".chat-tool-group-count");
    if (countEl) countEl.textContent = `🛠️ 工具调用 × ${cards.length}`;
    const last = cards[cards.length - 1];
    const previewEl = group.querySelector(".chat-tool-group-preview");
    if (previewEl) {
      const name = last?.querySelector(".chat-tool-name")?.textContent ?? "";
      const summary = last?.querySelector(".chat-tool-summary")?.textContent ?? "";
      previewEl.textContent = summary ? `${name} · ${summary}` : name;
    }
    group.classList.toggle("running", cards.some((c) => c.hasAttribute("data-running")));
  };

  /** Build a collapsible tool group (collapsed by default). */
  const createToolGroup = () => {
    const group = document.createElement("div");
    group.className = "chat-tool-group collapsed";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "chat-tool-group-head";
    const count = document.createElement("span");
    count.className = "chat-tool-group-count";
    const preview = document.createElement("span");
    preview.className = "chat-tool-group-preview";
    const chevron = document.createElement("span");
    chevron.className = "chat-tool-group-chevron";
    head.append(count, preview, chevron);
    const body = document.createElement("div");
    body.className = "chat-tool-group-body";
    group.append(head, body);
    head.addEventListener("click", () => {
      const collapsed = group.classList.toggle("collapsed");
      chevron.textContent = collapsed ? "▸" : "▾";
    });
    return group;
  };

  /** Append one message row; returns the row element (for streaming). */
  const appendRow = (role, text) => {
    sealToolRun(); // any message row ends the current tool run
    const row = document.createElement("div");
    row.className = `chat-row chat-${role}`;
    const bubbleEl = document.createElement("div");
    bubbleEl.className = "chat-bubble";
    // markdown body — the renderer escapes HTML first, so this is safe
    if (window.PetMarkdown) bubbleEl.innerHTML = window.PetMarkdown.render(text);
    else bubbleEl.textContent = text; // safe fallback (plain text)
    row.append(bubbleEl);
    messagesEl.append(row);
    if (nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
    return { row, bubbleEl };
  };

  /** Render all buffered history (fresh view — always show the newest end).
   *  Tool rows are drawn as frosted tool cards (with their output when done);
   *  consecutive tool calls collapse into one group.
   *
   *  ASYNC + CHUNKED: rendering EVERY row synchronously (each runs Markdown
   *  through a regex-heavy parser + a DOM insertion) froze the renderer for
   *  hundreds of ms-to-seconds on a long conversation — the whole pet window
   *  stalled "until the dialog loaded". Instead, show a loading placeholder
   *  immediately, then render rows in small batches across animation frames
   *  (yielding the main thread between batches), so the window stays
   *  responsive while history fills in. A per-render token cancels a stale
   *  render when a newer history arrives mid-flight. */
  let renderToken = 0;
  const RENDER_BATCH = 24; // rows per animation frame
  const renderHistory = (afterRender) => {
    messagesEl.innerHTML = "";
    sealToolRun();
    const items = history;
    // A loading placeholder is shown ONLY when there are rows to draw AND it
    // would take more than one frame; an empty history skips straight to the
    // empty-state note so tiny sessions never flash the placeholder.
    if (items.length > RENDER_BATCH) {
      const loading = document.createElement("div");
      loading.className = "chat-session-empty chat-history-loading";
      loading.textContent = "⏳ 正在渲染历史对话…";
      messagesEl.append(loading);
    }
    const token = ++renderToken;
    let i = 0;
    const renderBatch = () => {
      if (token !== renderToken) return; // superseded by a newer history
      // remove the placeholder on the first real batch
      if (i === 0) messagesEl.querySelector(".chat-history-loading")?.remove();
      const end = Math.min(i + RENDER_BATCH, items.length);
      for (; i < end; i++) {
        const item = items[i];
        if (item.role === "tool") {
          appendToolCard(item);
          if (item.done) finishToolCard(item);
        } else {
          appendRow(item.role, item.text);
        }
      }
      // keep the latest content in view as rows stream in (only while near the
      // bottom — same rule appendRow/finishToolCard use during live streaming)
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (i < items.length) {
        requestAnimationFrame(renderBatch);
      } else if (typeof afterRender === "function") {
        afterRender();
      }
    };
    if (items.length) requestAnimationFrame(renderBatch);
    else if (typeof afterRender === "function") afterRender();
  };

  /** Replace history with one session's transcript rows (user/assistant text +
   *  tool cards, so reopened sessions keep their tool-call records). When the
   *  plugin only sent the RECENT tail (long / old conversation), a note at the
   *  top tells the user earlier records were intentionally not loaded. */
  const showHistory = (rows, truncated) => {
    history = Array.isArray(rows) ? rows.map((r) => {
      if (r.role === "tool") {
        return {
          role: "tool",
          callId: r.callId,
          tool: r.tool,
          label: r.label,
          summary: r.summary,
          argsText: r.argsText,
          output: r.output,
          isError: r.isError,
          done: r.done,
        };
      }
      return { role: r.role === "user" ? "user" : "assistant", text: r.text ?? "" };
    }) : [];
    // truncated note + empty-state are appended AFTER the chunked render
    // completes, so the loading placeholder isn't hidden by `prepend`/`append`
    // ordering during streaming. renderHistory runs async and calls afterRender;
    // a stale render (newer history arrived) is already canceled by renderToken,
    // so this afterRender only runs for the CURRENT history.
    renderHistory(() => {
      if (truncated && truncated.skipped > 0) {
        const note = document.createElement("div");
        note.className = "chat-truncated-note";
        note.textContent = `⏳ 该会话较早/较长，仅显示最近 ${history.length} 条记录（已省略 ${truncated.skipped} 条更早的）`;
        messagesEl.prepend(note);
      }
      if (!history.length) {
        const empty = document.createElement("div");
        empty.className = "chat-session-empty";
        empty.textContent = "该会话暂无消息记录";
        messagesEl.append(empty);
      }
    });
  };

  /** Pretty-print a JSON string for the card's 输入 section (fallback to the
   *  raw text when it is truncated or not valid JSON). */
  const prettyJson = (json) => {
    if (!json) return "";
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  };

  /** Append (or update) a frosted web-style tool card: icon + name + target
   *  summary, an io-style 输入 section with the arguments, and a running sweep;
   *  finished via finishToolCard(). Re-sent tool signals for the same callId
   *  update the existing card instead of stacking duplicates.
   *
   *  Consecutive tool calls (no user/assistant row between them) merge into
   *  one collapsible group: the SECOND call upgrades the run into a group and
   *  collapses it, leaving only the latest preview visible until expanded. */
  const appendToolCard = (s) => {
    let card = null;
    if (s.callId) {
      for (const el of messagesEl.querySelectorAll(".chat-tool")) {
        if (el.dataset.callId === String(s.callId)) { card = el; break; }
      }
    }
    let group = null;
    if (card) {
      group = card.closest(".chat-tool-group");
    } else if (lastMsgWasTool) {
      // continuing a run: append into the open group, or upgrade the last
      // bare card into a group (the run now has 2+ calls)
      if (activeToolGroup) {
        group = activeToolGroup;
      } else if (lastToolCard && lastToolCard.isConnected) {
        group = createToolGroup();
        lastToolCard.replaceWith(group);
        group.querySelector(".chat-tool-group-body").append(lastToolCard);
        activeToolGroup = group;
      }
    }
    if (!card) {
      card = document.createElement("div");
      card.className = "chat-tool";
      // a fresh tool/call means "running" — the sweep + gold highlight show
      // until the matching tool-done (finishToolCard) clears it
      card.dataset.running = "";
      if (s.callId) card.dataset.callId = String(s.callId);
      if (s.tool) card.dataset.tool = String(s.tool);
      const head = document.createElement("div");
      head.className = "chat-tool-head";
      const icon = document.createElement("span");
      icon.className = "chat-tool-icon";
      icon.textContent = "🛠️";
      const name = document.createElement("span");
      name.className = "chat-tool-name";
      name.textContent = s.label ?? s.tool ?? "工具";
      const sep = document.createElement("span");
      sep.className = "chat-tool-sep";
      const summary = document.createElement("span");
      summary.className = "chat-tool-summary";
      summary.textContent = s.summary ?? "";
      head.append(icon, name, sep, summary);
      card.append(head);
      if (group) {
        group.querySelector(".chat-tool-group-body").append(card);
      } else {
        messagesEl.append(card);
      }
      lastToolCard = card;
      lastMsgWasTool = true;
    } else {
      // update the header in place (streamed arguments refine the summary)
      const summary = card.querySelector(".chat-tool-summary");
      if (summary && s.summary) summary.textContent = s.summary;
    }
    if (s.argsText) {
      // replace any previous 输入 section with the freshest arguments
      const old = card.querySelector(".chat-tool-io[data-kind='in']");
      if (old) old.remove();
      const io = document.createElement("div");
      io.className = "chat-tool-io";
      io.dataset.kind = "in";
      const label = document.createElement("span");
      label.className = "chat-tool-io-label";
      label.textContent = "输入";
      const body = document.createElement("code");
      body.className = "chat-tool-io-text";
      body.textContent = prettyJson(s.argsText);
      io.append(label, body);
      card.append(io);
    }
    if (group) syncToolGroup(group);
    if (nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  /** Finish the running tool card: stop the sweep and show the result. */
  const finishToolCard = (s) => {
    let card = null;
    if (s.callId) {
      for (const el of messagesEl.querySelectorAll(".chat-tool")) {
        if (el.dataset.callId === String(s.callId)) { card = el; break; }
      }
    }
    card = card ?? messagesEl.querySelector(".chat-tool[data-running]")
      ?? [...messagesEl.querySelectorAll(".chat-tool")].at(-1) ?? null;
    if (!card) return;
    delete card.dataset.running;
    if (s.output) {
      const io = document.createElement("div");
      io.className = "chat-tool-io";
      io.dataset.kind = "out";
      const label = document.createElement("span");
      label.className = "chat-tool-io-label";
      label.textContent = "输出";
      const body = document.createElement("code");
      body.className = "chat-tool-io-text";
      if (s.isError) body.dataset.error = "";
      body.textContent = s.output;
      io.append(label, body);
      card.append(io);
    }
    // the head's running sweep / preview follows the newest state inside
    syncToolGroup(card.closest(".chat-tool-group"));
  };

  /** Render the session picker list. */
  const renderSessions = () => {
    sessionsEl.innerHTML = "";
    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "chat-session-empty";
      empty.textContent = "暂无历史会话";
      sessionsEl.append(empty);
      return;
    }
    const head = document.createElement("div");
    head.className = "chat-sessions-head";
    head.textContent = `历史会话 · ${sessions.length}`;
    sessionsEl.append(head);
    for (const s of sessions) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "chat-session-row" + (s.id === currentSessionId ? " active" : "");
      const title = document.createElement("div");
      title.className = "chat-session-title";
      title.textContent = s.title ?? s.id;
      const meta = document.createElement("div");
      meta.className = "chat-session-meta";
      if (s.createdAt) {
        meta.textContent = new Date(s.createdAt).toLocaleString("zh-CN", {
          month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
        });
      }
      if (s.preview) {
        const preview = document.createElement("div");
        preview.className = "chat-session-preview";
        preview.textContent = s.preview;
        row.append(title, preview, meta);
      } else {
        row.append(title, meta);
      }
      row.addEventListener("click", () => {
        currentSessionId = s.id;
        titleLabel.textContent = s.title?.trim() ? s.title : "🐳 与鲸鱼娘对话";
        sessionsEl.classList.add("hidden");
        renderSessions();
        // switching sessions: drop any in-flight streaming bubble and show a
        // loading placeholder so "history not loaded yet" is never ambiguous
        assistantBubble = null;
        showPlaceholder("⏳ 正在加载历史对话…");
        setHint("");
        armHistoryWatchdog(s.id, () => window.petAPI.selectSession(s.id));
      });
      sessionsEl.append(row);
    }
  };

  /** Handle one chat signal from the plugin. */
  const onChatSignal = (signal) => {
    if (!signal || signal.type !== "chat") return;
    // any chat traffic while a pet-side send is pending means the bridge is
    // alive — keep the watchdog from tripping on long but active turns
    if (busy) armSendWatchdog();
    const kind = signal.kind;
    if (kind === "user") {
      const text = signal.text ?? "";
      // echo of a message WE just sent is already shown optimistically — the
      // plugin also forwards the session's user/message event, so dedupe it
      if (pendingUserEchoes.has(text)) {
        pendingUserEchoes.delete(text);
        return;
      }
      history.push({ role: "user", text });
      appendRow("user", text);
    } else if (kind === "delta") {
      if (!assistantBubble) {
        const row = appendRow("assistant", "");
        assistantBubble = row.bubbleEl;
        streamingText = "";
      }
      streamingText += signal.text ?? "";
      // re-render the accumulated markdown so formatting appears live
      if (window.PetMarkdown) assistantBubble.innerHTML = window.PetMarkdown.render(streamingText);
      else assistantBubble.textContent = streamingText;
      if (nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (kind === "assistant") {
      // full assembled reply replaces the streaming bubble (identical text)
      history.push({ role: "assistant", text: signal.text ?? "" });
      if (assistantBubble) {
        if (window.PetMarkdown) assistantBubble.innerHTML = window.PetMarkdown.render(signal.text ?? "");
        else assistantBubble.textContent = signal.text ?? "";
        assistantBubble = null;
        streamingText = "";
      } else {
        appendRow("assistant", signal.text ?? "");
      }
    } else if (kind === "done") {
      assistantBubble = null;
      busy = false;
      setHint("");
      const wasBusyInput = !!(inputEl && inputEl.disabled);
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      // only reclaim focus after a pet-side send — a web-driven stream must
      // not yank the keyboard away from the browser
      if (wasBusyInput && inputEl) inputEl.focus();
    } else if (kind === "error") {
      history.push({ role: "assistant", text: `⚠️ ${signal.text ?? "出错了"}` });
      appendRow("assistant", `⚠️ ${signal.text ?? "出错了"}`);
      assistantBubble = null;
      busy = false;
      setHint("");
      const wasBusyInput = !!(inputEl && inputEl.disabled);
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      if (wasBusyInput && inputEl) inputEl.focus();
    } else if (kind === "tool") {
      appendToolCard(signal);
    } else if (kind === "tool-done") {
      finishToolCard(signal);
    } else if (kind === "stats") {
      renderChatStats(signal);
    } else if (kind === "sessions") {
      sessions = Array.isArray(signal.list) ? signal.list : [];
      renderSessions();
    } else if (kind === "new-session") {
      // the plugin created a fresh session and pinned the chat to it — show a
      // clean slate so the user knows they're in a brand-new conversation
      clearTimeout(pendingLoadTimer);
      pendingLoadId = null;
      historyReqSeq++;
      currentSessionId = signal.sessionId ?? null;
      assistantBubble = null;
      pendingUserEchoes.clear();
      history = [];
      busy = false;
      clearTimeout(sendWatchdog);
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      messagesEl.innerHTML = "";
      const welcome = document.createElement("div");
      welcome.className = "chat-session-empty";
      welcome.textContent = "🐳 新对话已开启，来说点什么吧！";
      messagesEl.append(welcome);
      titleLabel.textContent = "🐳 与鲸鱼娘对话";
      if (statsEl) statsEl.textContent = "";
      setHint("💬 输入消息开始新的对话");
      if (inputEl) inputEl.focus();
    } else if (kind === "history") {
      const nextId = signal.sessionId ?? null;
      // Stale-response guard: while a specific session load is pending, a
      // history signal for a DIFFERENT session is dropped — a slow response
      // must never clobber the view the user just asked for.
      if (pendingLoadId !== null && nextId !== pendingLoadId) return;
      clearTimeout(pendingLoadTimer);
      pendingLoadId = null;
      if (signal.failed) {
        // the plugin could not read the log in time — offer a retry instead
        // of pretending the session is empty
        showLoadTimeout(nextId, () => window.petAPI.selectSession(nextId));
        return;
      }
      const switched = nextId !== null && nextId !== currentSessionId;
      currentSessionId = nextId;
      if (nextId === null) {
        // the plugin has nothing to mirror yet — keep the panel clean
        messagesEl.innerHTML = "";
        setHint("💬 先在网页中打开一个会话，这里会自动跟随");
        return;
      }
      showHistory(signal.rows, signal.truncated);
      if (switched) {
        // the view moved to another conversation: drop any stale streaming
        // bubble / pending echoes and update the title to the new session
        assistantBubble = null;
        pendingUserEchoes.clear();
      }
      // a real session is now loaded — ENABLE the composer (it was disabled
      // while the panel waited for the user to pick a conversation).
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      if (signal.title) titleLabel.textContent = signal.title;
      setHint(signal.follow ? "📡 正在跟随网页会话，输入消息会发送到该会话" : "💬 在下方输入消息继续这个对话");
      // focus only for user-initiated loads (picker / panel open) — a web-side
      // follow switch must not steal focus from the browser
      if (!signal.follow && inputEl) inputEl.focus();
    }
  };

  const setHint = (text) => {
    if (hintEl) hintEl.textContent = text;
  };

  /** Format token counts like the web ("1.2k" / "3.4M"). */
  const fmtTokens = (n) => {
    n = n ?? 0;
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  /** Render the 轮次 / token / 缓存命中 readout under the input (web-style). */
  const renderChatStats = (s) => {
    if (!statsEl) return;
    const parts = [];
    if (s.turn) parts.push(`轮次 ${s.turn}`);
    const input = s.inputTokens ?? 0;
    const output = s.outputTokens ?? 0;
    const cacheRead = s.cacheReadTokens ?? 0;
    const billed = input + cacheRead + (s.cacheWriteTokens ?? 0);
    if (billed > 0 || output > 0) {
      parts.push(`输入 ${fmtTokens(input)} tok · 输出 ${fmtTokens(output)} tok`);
      if (cacheRead > 0 && billed > 0) {
        parts.push(`缓存命中 ${Math.round((cacheRead / billed) * 100)}%`);
      }
    }
    statsEl.textContent = parts.join("  ·  ");
  };

  /** Submit the current input to the agent. */
  const send = async () => {
    if (busy) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    history.push({ role: "user", text });
    appendRow("user", text);
    pendingUserEchoes.add(text); // the plugin echoes this event — dedupe it
    busy = true;
    assistantBubble = null;
    if (inputEl) inputEl.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    setHint("⏳ Agent 思考中…");
    armSendWatchdog(); // unblock the input if the plugin bridge never answers
    const result = await window.petAPI.sendChat(text);
    if (!result?.ok) {
      const errText = result?.error ?? "无法连接 Agent（插件桥未启动）";
      history.push({ role: "assistant", text: `⚠️ ${errText}` });
      appendRow("assistant", `⚠️ ${errText}`);
      busy = false;
      clearTimeout(sendWatchdog);
      setHint("");
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  };

  const onChatPanel = (payload) => {
    const open = !!payload?.open;
    chatPanelVisible = open;
    chatEl.classList.toggle("hidden", !open);
    document.body.dataset.chatOpen = open ? "1" : "";
    if (open) {
      // the main process keeps the pet at its exact on-screen spot: the panel
      // may grow LEFT of the pet (data-chat-side="left") or UP past it
      // (--pet-shift-y) — apply the layout the window was grown for
      document.body.dataset.chatSide = payload?.side === "left" ? "left" : "right";
      document.body.style.setProperty("--pet-shift-y", `${payload?.shiftY ?? 0}px`);
      if (!chatInitialized) {
        chatInitialized = true;
        if (window.petAPI && typeof window.petAPI.onSignal === "function") {
          window.petAPI.onSignal(onChatSignal);
        }
      }
      // BLANK first open: do NOT auto-mirror the web's current conversation —
      // loading its full history on every open is what froze the window and
      // felt like a wall of context the user did not ask for. The panel opens
      // empty and asks the user to pick a history session (🗂️) or start a new
      // one (➕); only then is a transcript loaded (and only its last 20 rows).
      // The history picker still populates in the background so 🗂️ is ready.
      clearTimeout(pendingLoadTimer);
      pendingLoadId = null;
      historyReqSeq++;
      currentSessionId = null;
      assistantBubble = null;
      pendingUserEchoes.clear();
      history = [];
      busy = false;
      clearTimeout(sendWatchdog);
      // input is disabled until the user chooses a conversation to talk in
      if (inputEl) inputEl.disabled = true;
      if (sendBtn) sendBtn.disabled = true;
      messagesEl.innerHTML = "";
      const welcome = document.createElement("div");
      welcome.className = "chat-session-empty";
      welcome.textContent = "🐳 点 🗂️ 选择历史会话，或点 ➕ 开启新对话";
      messagesEl.append(welcome);
      titleLabel.textContent = "🐳 与鲸鱼娘对话";
      if (statsEl) statsEl.textContent = "";
      setHint("💬 先选择一个会话或开启新对话，再开始聊天");
      // Pre-fetch the session list in the background so 🗂️ opens populated,
      // but do NOT auto-reveal the picker on first open — the user wants a
      // clean blank panel until they explicitly click 🗂️ to browse history.
      if (window.petAPI && typeof window.petAPI.listSessions === "function") {
        window.petAPI.listSessions();
      }
    } else {
      // closing: restore the pet's default layout (top-left, no shift)
      // CRITICAL: also clear data-chat-open — leaving it set keeps the CSS
      // rule body[data-chat-open] #statusbar { display:none !important } in
      // force, so the task-progress box could never reappear after the panel
      // was closed once (the black caption stayed hidden forever until the
      // pet window reloaded).
      delete document.body.dataset.chatOpen;
      delete document.body.dataset.chatSide;
      document.body.style.removeProperty("--pet-shift-y");
      // ...and drop the pinned chat target — the next open is blank again
      clearTimeout(pendingLoadTimer);
      pendingLoadId = null;
      historyReqSeq++;
      if (window.petAPI && typeof window.petAPI.resetChatTarget === "function") {
        window.petAPI.resetChatTarget();
      }
    }
  };

  if (window.petAPI && typeof window.petAPI.onChatPanel === "function") {
    window.petAPI.onChatPanel(onChatPanel);
  }
  // drag the whole chat window from the title bar (buttons keep their clicks):
  // reuses the pet-drag plumbing (main anchors + applies deltas) but leaves
  // the pet's state machine untouched
  chatEl.querySelector(".chat-title")?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (pierceMode) return;
    if (e.target.closest("button")) return; // 🗂️ ➕ ⛶ ✕ keep their own handlers
    e.preventDefault();
    dragSource = "title";
    drag = { startScreenX: e.screenX, startScreenY: e.screenY, moved: false };
    window.petAPI.dragStart();
  });
  // resize handles: the LEFT / RIGHT edges stretch the panel width, the
  // bottom edge the height. Deltas go to main, which anchors the pet.
  const beginResize = (e, mode) => {
    if (e.button !== 0) return;
    if (pierceMode) return;
    e.preventDefault();
    e.stopPropagation();
    resizing = { startX: e.screenX, startY: e.screenY, mode };
    if (window.petAPI && typeof window.petAPI.chatResizeStart === "function") {
      window.petAPI.chatResizeStart();
    }
  };
  chatEl.querySelector(".chat-resize-left")?.addEventListener("mousedown", (e) => beginResize(e, "left"));
  chatEl.querySelector(".chat-resize-right")?.addEventListener("mousedown", (e) => beginResize(e, "right"));
  chatEl.querySelector(".chat-resize-bottom")?.addEventListener("mousedown", (e) => beginResize(e, "bottom"));
  // one-click maximize / restore: fills the work area beside the pet, or
  // returns to the size remembered before maximizing
  const maximizeBtn = chatEl.querySelector("#chat-maximize");
  maximizeBtn?.addEventListener("click", () => {
    if (window.petAPI && typeof window.petAPI.chatMaximize === "function") {
      window.petAPI.chatMaximize();
    }
  });
  if (window.petAPI && typeof window.petAPI.onChatMaximized === "function") {
    window.petAPI.onChatMaximized((payload) => {
      const on = !!(payload && payload.on);
      maximizeBtn?.classList.toggle("active", on);
      if (maximizeBtn) maximizeBtn.title = on ? "还原面板大小" : "最大化 / 还原面板大小";
      if (maximizeBtn) maximizeBtn.textContent = on ? "🗗" : "⛶";
    });
  }
  // height resizes near the screen bottom shift the window top; main tells us
  // the new sprite offset so the pet stays at its exact screen spot
  if (window.petAPI && typeof window.petAPI.onChatShift === "function") {
    window.petAPI.onChatShift((shiftY) => {
      document.body.style.setProperty("--pet-shift-y", `${shiftY ?? 0}px`);
    });
  }
  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  closeBtn.addEventListener("click", () => window.petAPI.closeChat());
  pickerBtn.addEventListener("click", () => {
    sessionsEl.classList.toggle("hidden");
    if (!sessionsEl.classList.contains("hidden") && window.petAPI) {
      window.petAPI.listSessions();
    }
  });
  newBtn.addEventListener("click", () => {
    if (busy) return;
    // clear the view right away for responsiveness; the plugin confirms with a
    // `new-session` signal (or an error) — the watchdog unblocks on silence
    clearTimeout(pendingLoadTimer);
    pendingLoadId = null;
    historyReqSeq++;
    currentSessionId = null;
    assistantBubble = null;
    pendingUserEchoes.clear();
    history = [];
    messagesEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "chat-session-empty";
    loading.textContent = "⏳ 正在开启新对话…";
    messagesEl.append(loading);
    setHint("");
    if (inputEl) inputEl.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    busy = true;
    armSendWatchdog();
    if (window.petAPI && typeof window.petAPI.newSession === "function") {
      window.petAPI.newSession();
    }
  });
}

boot();
