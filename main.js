/**
 * dsh-desktop-pet — main process.
 * A transparent, frameless, always-on-top desktop pet window with system tray
 * support, hot-reloadable config (size / opacity / walk / sleep / character)
 * and a local HTTP signal channel for DSH agent-state sync. Sprites live under
 * ../assets/characters/<id>/ (whale-girl set is MIT, see NOTICE.md). Pet logic
 * lives in the renderer; this process owns the window, tray, click-through,
 * position/config persistence, character discovery and the pet:// protocol.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, protocol, net, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { pathToFileURL } = require("url");
// Native Win32 calls (z-order bottom, taskbar styles). Loaded at top level so
// every helper can decode window handles from Electron's native-handle Buffers.
// koffi itself is cross-platform (prebuilt for win/mac/linux); the USER32
// specific calls below are guarded to win32 and degrade to Electron's native
// behavior elsewhere.
const IS_WIN = process.platform === "win32";
// koffi loads native bindings — guard the require itself so a missing/broken
// prebuild degrades to Electron's native behavior instead of crashing the
// whole app at startup (the USER32 calls below are already try/catch'd).
let koffi = null;
try {
  koffi = require("koffi");
} catch {
  /* koffi unavailable — win32 extras fall back to Electron natives */
}

const ROOT = __dirname;
// Built-in characters ship inside the (read-only) asar. A SECOND, writable
// characters directory under userData makes the pet compatible with ANY new
// model the user adds at runtime: drop a character folder in, or run
// `npx petdex install <name>` — it shows up in the character list.
const CHARACTERS_DIR = path.join(ROOT, "assets", "characters");
const USER_CHARACTERS_DIR = () => path.join(app.getPath("userData"), "characters");
/** Characters to NEVER auto-import (petdex OR built-in sync — user deletions).
 *  One id per line in userData/characters/.ignore. */
const IGNORE_FILE = () => path.join(app.getPath("userData"), "characters", ".ignore");

// Pin the userData directory to the app name regardless of how electron is
// launched (unpacked dev runs default to %APPDATA%/Electron otherwise).
app.setName("dsh-desktop-pet");
// Taskbar grouping + correct icon association (Windows-only API; no-op safe)
if (IS_WIN) app.setAppUserModelId("com.dsh.desktop-pet");

// ---------------------------------------------------------------------------
// file logging — the packaged exe has no visible stdout, so mirror everything
// to %APPDATA%/dsh-desktop-pet/pet.log (rotated at 1MB)
// ---------------------------------------------------------------------------
const LOG_FILE = () => path.join(app.getPath("userData"), "pet.log");
function writeLog(level, message) {
  try {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    fs.appendFileSync(LOG_FILE(), line);
    try {
      if (fs.statSync(LOG_FILE()).size > 1_000_000) {
        fs.renameSync(LOG_FILE(), LOG_FILE() + ".old");
      }
    } catch {
      /* best-effort */
    }
  } catch {
    /* best-effort */
  }
}
{
  const _log = console.log.bind(console);
  const _err = console.error.bind(console);
  console.log = (...a) => {
    _log(...a);
    writeLog("info", a.join(" "));
  };
  console.error = (...a) => {
    _err(...a);
    writeLog("error", a.join(" "));
  };
}

const STATE_FILE = () => path.join(app.getPath("userData"), "pet-state.json");
const CONFIG_FILE = () => path.join(app.getPath("userData"), "config.json");

// Local HTTP channel shared with the dsh-desktop-pet bundle Node half. ONE
// port, owned by the pet window: the plugin POSTs state/chat signals to
// /signal and long-polls /poll to collect user prompts. The plugin itself
// never listens — no extra port, no inbound surface.
const SIGNAL_PORT = 43991;
const SIGNAL_HOST = "127.0.0.1";

// Default config — keep in sync with config.mjs DEFAULTS (the DSH settings
// schema source of truth; this copy serves the standalone app).
const DEFAULT_CONFIG = Object.freeze({
  size: 110,
  opacity: 1,
  character: "whale-girl",
  walk: { enabled: true, intervalMs: 300000, durationMs: 26000 },
  sleepAfterMs: 60000,
  bottomMode: false, // pin the pet below other windows (desktop wallpaper style)
  taskBarPersistent: true, // keep the task-progress caption always visible (default on)
  taskBarDetailed: true, // persistent caption shows detailed progress + completed tasks (default on)
  hideWhenIdle: false, // hide the pet window entirely during its long-quiet sleep
  chatWidth: 300, // chat panel width px (user-resizable, remembered)
  chatHeight: 560, // chat panel height px (user-resizable, remembered)
});

// Height of the caption strip below the pet (bubble / statusbar / task
// progress). The sprite keeps its configured size and anchors to the TOP of
// the window; the strip is transparent and lives inside the window so the
// text is actually visible (an absolutely-positioned element outside the
// window bounds gets clipped by the renderer).
const WINDOW_STRIP = 52;
// Extra window width (right of the pet) giving the black info box more
// horizontal room — wide & flat instead of tall & narrow.
const WINDOW_EXTRA = 150;

const SAVE_DEBOUNCE_MS = 400;

let win = null;
let tray = null;
let saveTimer = null;
let lastWindowPos = null;
let config = { ...DEFAULT_CONFIG };
// Window position captured at drag start (main-side anchor for delta dragging).
let dragAnchor = null;
// Single source of truth for mouse-pierce mode. The tray checkbox, the pet
// menu action and the renderer's pierceMode all converge on this value; every
// change is applied to the window, reflected in the tray menu and broadcast
// back to the renderer so it can never get stuck in pierce mode.
let clickThrough = false;

// ---------------------------------------------------------------------------
// config: load / save / apply window-level / hot reload
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE(), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      config = { ...DEFAULT_CONFIG, ...data, walk: { ...DEFAULT_CONFIG.walk, ...(data.walk ?? {}) } };
    }
  } catch {
    /* first run or corrupt file — keep defaults */
  }
  return config;
}

/**
 * Desktop-bottom mode: the pet lives below every other window (wallpaper
 * style). The window is made non-focusable so clicking it never lifts it
 * above your work, and alwaysOnTop is disabled with the z-order pushed to
 * the bottom.
 *
 * Electron has no moveBottom() (only macOS moveAbove/moveBelow), so the
 * z-order push uses SetWindowPos(HWND_BOTTOM) through koffi.
 */
let moveWindowBottom = null;
if (IS_WIN) {
  try {
    const user32 = koffi.load("user32.dll");
    const setWindowPos = user32.func(
      "bool SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint flags)",
    );
    const SWP_NOSIZE = 0x0001;
    const SWP_NOMOVE = 0x0002;
    const SWP_NOACTIVATE = 0x0010;
    moveWindowBottom = (hwnd) => {
      setWindowPos(hwnd, 1 /* HWND_BOTTOM */, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    };
  } catch {
    /* koffi unavailable — bottom mode falls back to alwaysOnTop:false only */
  }
} else {
  // non-Windows: bottom mode falls back to setAlwaysOnTop(false)
}

/**
 * Keep windows OUT of the taskbar. Electron's skipTaskbar can silently fail
 * on Windows (verified: the pet window stayed taskbar-eligible — unowned,
 * no WS_EX_TOOLWINDOW — so it showed a default-Electron-icon taskbar button).
 * Force WS_EX_TOOLWINDOW through koffi and re-apply on every show, because
 * Windows re-adds taskbar buttons for eligible windows when they are shown.
 */
let forceToolWindow = null;
if (IS_WIN) {
  try {
    const user32b = koffi.load("user32.dll");
    const getExStyle = user32b.func("intptr_t GetWindowLongPtrW(intptr_t hwnd, int32 index)");
    const setExStyle = user32b.func("intptr_t SetWindowLongPtrW(intptr_t hwnd, int32 index, intptr_t value)");
    const GWL_EXSTYLE = -20;
    const WS_EX_TOOLWINDOW = 0x00000080;
    forceToolWindow = (hwnd) => {
      const ex = Number(getExStyle(hwnd, GWL_EXSTYLE));
      setExStyle(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW);
    };
  } catch {
    /* koffi unavailable — rely on win.setSkipTaskbar() only */
  }
} else {
  // macOS / Linux: skipTaskbar is native, no extra work needed
}

/** Decode an Electron native-window-handle Buffer into a plain integer HWND
 *  (getNativeWindowHandle() returns a Buffer CONTAINING the handle value —
 *  passing the Buffer straight to koffi would pass the buffer's own address).
 *  Only meaningful on Windows. */
function nativeHwnd(win) {
  if (!IS_WIN) return null;
  try {
    return Number(koffi.decode(win.getNativeWindowHandle(), "intptr_t"));
  } catch {
    return null;
  }
}

function forceNoTaskbar(win) {
  if (!win || win.isDestroyed()) return;
  win.setSkipTaskbar(true);
  if (forceToolWindow) {
    const hwnd = nativeHwnd(win);
    if (hwnd) {
      try {
        forceToolWindow(hwnd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Resolve a character asset, user dir FIRST (the writable copy is the source
 *  of truth after syncBuiltinCharacters; the asar copy is the fallback). */
function characterAsset(id, file) {
  for (const base of [USER_CHARACTERS_DIR(), CHARACTERS_DIR]) {
    const p = path.join(base, id, file);
    if (fs.existsSync(p)) return p;
  }
  return path.join(CHARACTERS_DIR, id, file);
}

/** Crop ONE idle frame (256x256, first of the sprite strip) out of idle.png
 *  so the tray/window icon shows a single whale-girl instead of the whole
 *  3-frame sprite strip squashed into the icon box. idle.png is 768x256 —
 *  frame 0 is x∈[0,256). Falls back to the raw file when cropping fails. */
function whaleGirlFrameIcon() {
  const png = characterAsset("whale-girl", "idle.png");
  try {
    const img = nativeImage.createFromPath(png);
    if (img.isEmpty()) return img;
    const { width, height } = img.getSize();
    // the sprite strip is 3 square frames side by side; take the first one
    if (width > height && height > 0) {
      const frame = img.crop({ x: 0, y: 0, width: Math.min(height, width), height });
      if (!frame.isEmpty()) return frame;
    }
    return img;
  } catch {
    /* fall through to raw file */
  }
  return nativeImage.createFromPath(png);
}

/** Window icon: whale-girl idle frame (single cropped frame, not the strip). */
const WINDOW_ICON = () => whaleGirlFrameIcon();

function applyBottomMode(enabled) {
  if (!win || win.isDestroyed()) return;
  if (enabled) {
    win.setFocusable(false);
    win.setAlwaysOnTop(false);
    if (moveWindowBottom) {
      try {
        const hwnd = nativeHwnd(win);
        if (hwnd) moveWindowBottom(hwnd);
      } catch {
        /* z-order push failed — alwaysOnTop:false still keeps it below others */
      }
    }
  } else {
    win.setFocusable(true);
    win.setAlwaysOnTop(true);
    win.moveTop();
  }
  refreshTrayMenu(); // keep the tray checkbox in sync with the real state
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2));
  } catch {
    /* best-effort */
  }
}

// Last applied size/opacity. Guards against repeated setSize on Windows
// transparent windows: each setSize can re-apply DPI scaling, so calling it
// with the "same" size repeatedly makes the window grow on every config
// cycle. Only apply when the resolved value actually changed.
let appliedWindow = { size: null, opacity: null };

/** The authoritative logical window size (config value, never read back).
 *  Width includes the extra room right of the pet for the info box; height
 *  includes the caption strip. */
function authoritativeSize() {
  const s = Math.max(64, Math.min(256, Math.round(appliedWindow.size ?? config.size ?? DEFAULT_CONFIG.size)));
  return { w: s + WINDOW_EXTRA, h: s + WINDOW_STRIP };
}

// Cross-display DPI handling: transparent windows don't auto-rescale when
// dragged onto a display with a different scale factor (Electron/Windows
// quirk). Track the current display scale and force a re-scale whenever the
// window lands on a different display.
let lastScaleFactor = null;
function correctForDisplay() {
  if (!win || win.isDestroyed()) return;
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    const scale = display.scaleFactor;
    if (lastScaleFactor !== null && scale !== lastScaleFactor) {
      const { w, h } = currentWindowSize();
      win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: w, height: h });
      win.setSize(w, h); // re-apply so Windows re-scales the transparent window
    }
    lastScaleFactor = scale;
  } catch {
    /* display query failed — ignore */
  }
}

/**
 * Clamp a position so the window stays reachable on the CURRENT display set.
 * - boot mode: a position inside ANY display's work area is kept as-is (the
 *   pet may legitimately sit on a secondary screen); a position outside every
 *   area (saved on a now-disconnected display) is pulled back into the union.
 * - drag mode (keepSliver): the window can be pushed almost off-screen but a
 *   sliver stays visible so the user can always grab it again.
 */
function clampToDisplays(x, y, w, h, keepSliver = false) {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  if (areas.length === 0) return { x, y };
  if (!keepSliver) {
    const inside = areas.some(
      (a) => x >= a.x - 20 && y >= a.y - 20 && x < a.x + a.width && y < a.y + a.height,
    );
    if (inside) return { x, y };
  }
  const ux = Math.min(...areas.map((a) => a.x));
  const uy = Math.min(...areas.map((a) => a.y));
  const ux2 = Math.max(...areas.map((a) => a.x + a.width));
  const uy2 = Math.max(...areas.map((a) => a.y + a.height));
  const minX = keepSliver ? ux - (w - 40) : ux;
  const minY = keepSliver ? uy - (h - 30) : uy;
  const maxX = keepSliver ? ux2 - 40 : ux2 - Math.min(w, ux2 - ux);
  const maxY = keepSliver ? uy2 - 30 : uy2 - Math.min(h, uy2 - uy);
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
  };
}

function applyWindowConfig(cfg) {
  if (!win || win.isDestroyed()) return;
  const size = Math.max(64, Math.min(256, Math.round(cfg.size ?? DEFAULT_CONFIG.size)));
  if (appliedWindow.size !== size) {
    const [x, y] = win.getPosition();
    appliedWindow.size = size;
    // Anchor the pet's TOP-LEFT corner: the sprite sits at the window's
    // top-left, so a size change only alters width/height (the pet grows
    // right/down in place) — re-centering the window would slide the pet
    // diagonally by (new-old)/2 and feel like it "jumped". When the chat
    // panel is open, keep the enlarged chat layout instead of collapsing it.
    const cur = currentWindowSize();
    win.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: cur.w,
      height: cur.h,
    });
  }
  const opacity = Math.max(0.2, Math.min(1, cfg.opacity ?? DEFAULT_CONFIG.opacity));
  if (appliedWindow.opacity !== opacity) {
    appliedWindow.opacity = opacity;
    win.setOpacity(opacity);
  }
}

function watchConfigFile() {
  try {
    fs.watch(CONFIG_FILE(), () => {
      loadConfig();
      applyWindowConfig(config);
      if (win && !win.isDestroyed()) broadcast({ type: "config", config });
    });
  } catch {
    /* fs.watch unsupported — config still applies on boot and via signals */
  }
}

/**
 * Discover installed characters across BOTH the built-in (read-only asar) and
 * the writable userData characters directory. Supported formats:
 *   1. native — manifest.json + per-state PNG strips
 *   2. codex  — pet.json + spritesheet (Codex / petdex ecosystem)
 * Every character gets the full state machine + DSH linkage in the renderer;
 * missing states fall back to idle art there.
 */
function scanCharacters() {
  const list = [];
  const seen = new Set();
  for (const base of [USER_CHARACTERS_DIR(), CHARACTERS_DIR]) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (seen.has(id)) continue;
      const info = inspectCharacter(id, path.join(base, id));
      if (info) {
        seen.add(id);
        list.push(info);
      }
    }
  }
  return list;
}

/** Identify one character directory and return { id, name, format }. */
function inspectCharacter(id, dir) {
  try {
    const manifestPath = path.join(dir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const name = manifest.characters?.[id]?.name ?? manifest.characters?.[manifest.default]?.name ?? id;
      return { id, name, format: "native" };
    }
    const petJsonPath = path.join(dir, "pet.json");
    if (fs.existsSync(petJsonPath)) {
      const pet = JSON.parse(fs.readFileSync(petJsonPath, "utf8"));
      return { id, name: pet.displayName ?? pet.id ?? id, format: "codex" };
    }
  } catch {
    /* skip malformed character */
  }
  return null;
}

/** Parse the .ignore list (ids the user never wants auto-copied). */
function readIgnoreFile() {
  try {
    return new Set(
      fs
        .readFileSync(IGNORE_FILE(), "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set(); /* no ignore file */
  }
}

/**
 * Import runtime characters from `npx petdex install` (respecting .ignore).
 * Folders placed directly into the user characters dir are picked up by
 * scanCharacters without any import step.
 */
function importExternalCharacters() {
  try {
    fs.mkdirSync(USER_CHARACTERS_DIR(), { recursive: true });
  } catch {
    /* best-effort */
  }
  const ignore = readIgnoreFile();
  const known = new Set(scanCharacters().map((c) => c.id));
  try {
    const petdexDir = path.join(os.homedir(), ".petdex", "pets");
    const petdexEntries = fs.readdirSync(petdexDir, { withFileTypes: true });
    for (const e of petdexEntries) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      if (ignore.has(id) || known.has(id)) continue;
      const src = path.join(petdexDir, id);
      if (!fs.existsSync(path.join(src, "pet.json"))) continue;
      try {
        fs.cpSync(src, path.join(USER_CHARACTERS_DIR(), id), { recursive: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* no petdex dir */
  }
}

/**
 * Recursive copy that works with ASAR sources. fs.cpSync / fs.copyFileSync use
 * the native uv_fs_copyfile path which is NOT patched by Electron's asar
 * layer, so copying OUT of the packaged app.asar silently produces an empty
 * directory. readFileSync / writeFileSync ARE asar-aware, so drive the copy
 * through them instead.
 */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else fs.writeFileSync(d, fs.readFileSync(s));
  }
}

/**
 * Sync the BUILT-IN characters (whale-girl) into the writable user characters
 * dir so EVERY character lives in one place — the user opens the folder and
 * sees whale-girl next to the imported ones, can replace its art, or delete
 * it. The built-in asar copy stays as a read-only fallback (user dir wins on
 * conflict, see scanCharacters / resolveCharacterFile).
 *
 * Copy-if-missing semantics: a missing folder is re-copied on the next boot
 * (acts as a "reset to default"); to remove a built-in permanently, add its
 * id to .ignore.
 */
function syncBuiltinCharacters() {
  let builtins = [];
  try {
    builtins = fs
      .readdirSync(CHARACTERS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return; /* built-in dir unreadable (shouldn't happen inside asar) */
  }
  if (!builtins.length) return;
  try {
    fs.mkdirSync(USER_CHARACTERS_DIR(), { recursive: true });
  } catch {
    return;
  }
  const ignore = readIgnoreFile();
  for (const id of builtins) {
    if (ignore.has(id)) continue;
    const dest = path.join(USER_CHARACTERS_DIR(), id);
    if (fs.existsSync(dest)) continue;
    try {
      copyDirRecursive(path.join(CHARACTERS_DIR, id), dest);
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP channel (agent-state sync from the DSH bundle, one port, pet-owned)
//   POST /signal  — plugin pushes state/chat signals (existing behavior)
//   POST /poll    — plugin long-polls for user prompts queued by the chat
//                   window (drains one prompt per response; a pending poll
//                   resolves immediately when a prompt arrives, or after
//                   POLL_HOLD_MS with { empty: true } so the plugin can retry)
// ---------------------------------------------------------------------------
const POLL_HOLD_MS = 20_000; // longest the plugin waits before re-polling
const chatCommandQueue = [];
let pendingPoll = null; // { res, timer } parked while the queue is empty

/** Queue one chat command for the plugin to collect via /poll. */
function enqueueChatCommand(cmd) {
  chatCommandQueue.push(cmd);
  if (pendingPoll) {
    const { res } = pendingPoll;
    pendingPoll = null;
    deliverPoll(res);
  }
}

/** Answer one /poll request with the next queued command (or park it).
 *  Robustness: only ONE long-poll may be parked. A second poll while one is
 *  parked must release the OLD one (empty reply) instead of overwriting it —
 *  an orphaned poll would never receive a response, and the plugin's fetch
 *  would hang forever, killing the whole chat bridge. */
function deliverPoll(res) {
  const cmd = chatCommandQueue.shift();
  if (cmd !== undefined) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(cmd));
    return;
  }
  if (pendingPoll) {
    // release the previous parked poll so no client is ever stranded
    const old = pendingPoll;
    pendingPoll = null;
    clearTimeout(old.timer);
    try {
      old.res.writeHead(200, { "content-type": "application/json" });
      old.res.end(JSON.stringify({ empty: true }));
    } catch {
      /* already closed */
    }
  }
  pendingPoll = { res };
  const timer = setTimeout(() => {
    if (pendingPoll?.res === res) {
      pendingPoll = null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ empty: true }));
    }
  }, POLL_HOLD_MS);
  pendingPoll.timer = timer;
  res.on("close", () => {
    clearTimeout(timer);
    if (pendingPoll?.res === res) pendingPoll = null;
  });
}

function startSignalServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.url === "/poll") {
      deliverPoll(res);
      return;
    }
    if (req.url !== "/signal") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // History transcripts legitimately run to a few hundred KB (a truncated
      // 250-row tail with tool outputs); 64KB silently DROPPED them — the
      // plugin's history signal never arrived and the panel "timed out". Allow
      // a generous bounded body so transcripts always land, still capped to
      // stop a runaway/abusive POST from exhausting memory.
      if (body.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        const signal = JSON.parse(body);
        if (signal && typeof signal.type === "string" && signal.type === "config" && signal.config) {
          // hot config: merge, persist, apply window-level, forward to all windows
          const prevCharacter = config.character;
          config = {
            ...DEFAULT_CONFIG,
            ...signal.config,
            walk: { ...DEFAULT_CONFIG.walk, ...(signal.config.walk ?? {}) },
          };
          if (config.character !== prevCharacter) refreshTrayIcon();
          saveConfig();
          applyWindowConfig(config);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, received: "config" }));
          broadcast(signal);
          return;
        }
        if (signal && typeof signal.type === "string") {
          broadcast(signal);
          if (win && !win.isDestroyed()) win.setTitle(`dsh-desktop-pet · ${signal.type}`);
          // tray tooltip mirrors meaningful agent states (character base + state)
          if (["exec", "working", "think", "wait", "celebrate", "error", "welcome"].includes(signal.type)) {
            tray?.setToolTip(`${trayTooltipBase} · ${signal.type}`);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, received: signal.type }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
  server.on("error", (err) => {
    console.error("[pet] http server error:", err.message);
  });
  server.listen(SIGNAL_PORT, SIGNAL_HOST, () => {});
}

// ---------------------------------------------------------------------------
// protocol: pet://assets/... serves the sprite files to the renderer
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: "pet", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Resolve pet://assets/characters/<id>/<file> across the writable userData
 *  dir first, then the built-in asar dir. Nothing outside those roots. */
function resolveCharacterFile(rel) {
  const m = rel.match(/^assets\/characters\/([^/]+)\/(.+)$/);
  if (!m) {
    const p = path.resolve(ROOT, rel);
    return p.startsWith(ROOT + path.sep) && fs.existsSync(p) ? p : null;
  }
  const [, id, file] = m;
  for (const base of [USER_CHARACTERS_DIR(), CHARACTERS_DIR]) {
    const p = path.resolve(base, id, file);
    if (p.startsWith(base + path.sep) && fs.existsSync(p)) return p;
  }
  return null;
}

function registerPetProtocol() {
  protocol.handle("pet", (request) => {
    const url = new URL(request.url);
    // pet://assets/characters/... -> host is "assets", pathname is the rest
    const rel = decodeURIComponent(url.host + url.pathname).replace(/^\/+/, "");
    const filePath = resolveCharacterFile(rel);
    if (!filePath) {
      return new Response("not found", { status: 404 });
    }
    // CORS header keeps canvas reads safe (fetch/createImageBitmap paths)
    return net.fetch(pathToFileURL(filePath).toString()).then((res) => {
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(res.body, { status: res.status, headers });
    });
  });
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE(), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch {
    /* first run or corrupt file */
  }
  return { x: null, y: null, ledger: null };
}

function saveStateNow() {
  if (!win || lastWindowPos === null) return;
  const data = { x: lastWindowPos.x, y: lastWindowPos.y, ledger: win.ledger ?? null };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(data));
  } catch (err) {
    console.error("save state failed:", err.message);
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------
function defaultPosition() {
  const { screen } = require("electron");
  const area = screen.getPrimaryDisplay().workArea;
  const { w, h } = authoritativeSize();
  return {
    x: Math.round(area.x + area.width - w - 24),
    y: Math.round(area.y + area.height - h - 24),
  };
}

function createWindow() {
  const size = Math.max(64, Math.min(256, Math.round(config.size ?? DEFAULT_CONFIG.size)));
  appliedWindow = { size, opacity: config.opacity ?? 1 };
  const saved = loadState();
  let pos = saved.x !== null && saved.y !== null ? { x: saved.x, y: saved.y } : defaultPosition();
  // a saved position can land on a display that is no longer connected —
  // clamp it back into the visible desktop so the pet never spawns off-screen
  pos = clampToDisplays(pos.x, pos.y, size + WINDOW_EXTRA, size + WINDOW_STRIP);

  win = new BrowserWindow({
    width: size + WINDOW_EXTRA,
    height: size + WINDOW_STRIP,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    icon: WINDOW_ICON(),
    opacity: config.opacity ?? 1,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The pet window is almost never the focused window; without this the
      // Chromium background throttle freezes requestAnimationFrame and timers,
      // so the sprite animation stops. Keep it rendering always.
      backgroundThrottling: false,
    },
  });
  forceNoTaskbar(win);
  // Chromium keeps configuring the window's extended styles shortly after
  // creation (transparent / topmost / layered), which can overwrite the
  // TOOLWINDOW flag we just set — re-apply on ready-to-show and after a beat.
  win.once("ready-to-show", () => forceNoTaskbar(win));
  win.on("show", () => forceNoTaskbar(win));
  setTimeout(() => forceNoTaskbar(win), 800);
  win.ledger = saved.ledger;
  lastWindowPos = { x: pos.x, y: pos.y };
  win.on("move", () => {
    const [x, y] = win.getPosition();
    lastWindowPos = { x, y };
    queueSave();
  });
  win.on("moved", () => correctForDisplay());
  win.on("closed", () => {
    win = null;
  });
  win.loadFile(path.join(ROOT, "renderer", "index.html"));
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error(`[renderer] did-fail-load ${code} ${desc}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[renderer] process gone: ${details.reason}`);
  });
  // markdown links open in the system browser — the pet window must never
  // navigate away or spawn an untitled Electron window on a link click
  const openExternal = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    openExternal(url);
    e.preventDefault();
  });
  if (process.argv.includes("--dev")) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------
function trayIcon() {
  // Custom tray icon: use assets/1.png when present (ships with the package).
  // Resize for the platform; fall back to the whale-girl idle frame so the
  // tray is never blank when that file is missing.
  const customPng = path.join(ROOT, "assets", "1.png");
  try {
    if (fs.existsSync(customPng)) {
      const custom = nativeImage.createFromPath(customPng);
      if (!custom.isEmpty()) {
        const size = process.platform === "win32" ? 32 : 16;
        return custom.resize({ width: size, height: size, quality: "best" });
      }
    }
  } catch {
    /* fall through to whale-girl */
  }
  // always use whale-girl art: codex characters have no idle.png, and
  // createFromPath silently returns an EMPTY image for missing files — an
  // invisible tray icon. Resolves the user copy first (customized art wins),
  // then crops to the single idle frame so the tray shows one whale-girl
  // rather than the squashed 3-frame sprite strip.
  try {
    const frame = whaleGirlFrameIcon();
    if (!frame.isEmpty()) {
      // Windows tray is 16x16 DIP; 32x32 covers per-monitor DPI scaling.
      const small = frame.resize({ width: 16, height: 16, quality: "best" });
      if (process.platform === "win32") {
        return small.resize({ width: 32, height: 32, quality: "best" });
      }
      return small;
    }
  } catch {
    /* fall through to raw */
  }
  const png = characterAsset("whale-girl", "idle.png");
  try {
    return nativeImage.createFromPath(png).resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
}

function createTray() {
  tray = new Tray(trayIcon());
  refreshTrayTooltip();
  refreshTrayMenu();
  tray.on("click", () => toggleWindow());
}

/** Swap the tray icon (e.g. after a character change). */
function refreshTrayIcon() {
  if (!tray) return;
  try {
    tray.setImage(trayIcon());
  } catch {
    /* best-effort */
  }
  refreshTrayTooltip();
}

/** Tray tooltip base: app name + current character. State signals append the
 *  agent state on top of this base (see the signal handler). */
let trayTooltipBase = "dsh-desktop-pet";
function refreshTrayTooltip() {
  if (!tray) return;
  try {
    const role = scanCharacters().find((c) => c.id === config.character);
    trayTooltipBase = `dsh-desktop-pet · ${role?.name ?? config.character}`;
    tray.setToolTip(trayTooltipBase);
  } catch {
    /* best-effort */
  }
}

/** Rebuild the tray context menu from the CURRENT state so checkbox items
 *  (bottom mode / mouse pierce) always reflect reality — otherwise a stale
 *  checkbox makes the first click re-enable instead of disable. */
function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "显示 / 隐藏", click: () => toggleWindow() },
    { label: "💬 对话", click: () => openChatPanel() },
    { label: "回到右下角", click: () => {
      if (!win) return;
      const pos = defaultPosition();
      win.setPosition(pos.x, pos.y);
    } },
    { type: "separator" },
    {
      label: "置底模式（贴在桌面）",
      type: "checkbox",
      checked: !!config.bottomMode,
      click: (item) => {
        if (!win) return;
        config = { ...config, bottomMode: item.checked };
        saveConfig();
        applyBottomMode(config.bottomMode);
      },
    },
    {
      label: "鼠标穿透",
      type: "checkbox",
      checked: clickThrough,
      click: (item) => setClickThrough(item.checked),
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show();
}

// ---------------------------------------------------------------------------
// chat panel: IN the pet window, beside the model. Opening chat enlarges the
// pet window to (petSize + CHAT_PANEL_W + gap) x CHAT_H, clamped and shifted
// so it stays fully on the hosting display (the sprite stays at its top-left
// corner; the renderer lays the chat panel out in the grown area). Closing
// restores the pet's normal size — at its pre-panel spot unless the user
// dragged the enlarged window. Prompts/replies flow over the
// single 43991 channel (/poll commands + /signal chat signals).
// ---------------------------------------------------------------------------
const CHAT_PANEL_W = 300; // chat panel width (matches #chat's CSS width target)
const CHAT_GAP = 12;      // gap between the pet sprite and the panel
const CHAT_H = 560;
let chatPanelOpen = false;
// Position captured right before the panel enlarges the window; closing
// returns the pet there (unless the user dragged the enlarged window).
let chatRestoreBounds = null;
// The bounds actually applied when the panel opened (the left-side flip moves
// the window, which must NOT count as a user drag when closing).
let chatOpenBounds = null;
// Bottom mode (贴桌面) would keep the enlarged window behind every other
// window, so the panel is temporarily lifted while the chat is open and the
// pet is pushed back to the bottom when it closes.
let chatLiftBottom = false;

/** The window size to enforce RIGHT NOW: the chat layout while the panel is
 *  open, the normal pet layout otherwise. Every setBounds that pins the
 *  width/height must go through this, or dragging the pet / a live config
 *  size change while chatting would collapse the enlarged window and clip
 *  the chat panel (the "对话框显示不全" bug). Uses the user-resizable panel
 *  size (config.chatWidth/chatHeight) so a resized panel survives reopening. */
function currentWindowSize() {
  const size = Math.max(64, Math.min(256, Math.round(appliedWindow.size ?? config.size ?? DEFAULT_CONFIG.size)));
  if (chatPanelOpen) {
    const panelW = Math.max(240, Math.min(800, Math.round(config.chatWidth ?? CHAT_PANEL_W)));
    const h = Math.max(280, Math.min(2000, Math.round(config.chatHeight ?? CHAT_H)));
    // pet sprite (size) + panel + gap — the panel never overlaps the sprite
    return { w: Math.round(size + panelW + CHAT_GAP), h };
  }
  return { w: size + WINDOW_EXTRA, h: size + WINDOW_STRIP };
}

// Which side the chat panel is laid out on (right by default; flipped to the
// left when the pet sits near the right screen edge). Needed to anchor the
// window correctly while the user resizes the panel.
let chatSide = "right";
// Bounds captured when a resize drag starts; deltas are applied to it.
let chatResizeAnchor = null;
// The pet's sprite offset inside the window (--pet-shift-y) — the pet's screen
// position is always windowY + chatShiftY, and every size change re-derives it.
let chatShiftY = 0;
// One-click maximize state: the panel fills the work area beside the pet;
// toggling again restores the size remembered before maximizing.
let chatMaximized = false;
let chatPrevPanel = null;

/** Apply a chat panel size while keeping the pet at its exact screen spot:
 *  the window grows around the pet (right layout anchors the pet to the left
 *  edge, left layout to the right edge; vertical overflow is absorbed by the
 *  pet's sprite offset). Also clamps to the display work area and remembers
 *  the resulting panel size in config. */
function applyChatBounds(panelW, h) {
  if (!win || win.isDestroyed()) return;
  const size = Math.max(64, Math.min(256, Math.round(config.size ?? DEFAULT_CONFIG.size)));
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const b = win.getBounds();
  const petScreenX = chatSide === "left" ? b.x + b.width : b.x;
  const petScreenY = b.y + (chatShiftY ?? 0);
  const w = Math.min(Math.round(size + Math.max(240, Math.round(panelW)) + CHAT_GAP), wa.width);
  let hh = Math.min(Math.max(Math.round(h), Math.min(280, wa.height)), wa.height);
  // vertical: keep the current window top unless the pet would clip — when it
  // would, shift the window (and the pet's sprite offset) so the pet stays put
  let y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - hh));
  if (petScreenY + size > y + hh) {
    y = Math.max(wa.y, Math.min(petScreenY + size - hh, wa.y + wa.height - hh));
  }
  const shiftY = Math.max(0, petScreenY - y);
  let x;
  if (chatSide === "left") {
    x = Math.min(Math.max(petScreenX - w, wa.x), wa.x + wa.width - w);
  } else {
    x = Math.min(Math.max(petScreenX, wa.x), wa.x + wa.width - w);
  }
  win.setBounds({ x, y, width: w, height: hh });
  chatShiftY = shiftY;
  win.webContents.send("pet:chat-shift", shiftY);
  config = { ...config, chatWidth: Math.round(w - size - CHAT_GAP), chatHeight: hh };
}

function openChatPanel() {
  if (!win || win.isDestroyed()) return;
  if (chatPanelOpen) return;
  chatPanelOpen = true;
  const [x, y] = win.getPosition();
  chatRestoreBounds = { x, y };
  const size = Math.max(64, Math.min(256, Math.round(appliedWindow.size ?? config.size ?? DEFAULT_CONFIG.size)));

  // housekeeping: a mid-walk window must not keep wandering under the panel,
  // and a hideWhenIdle-hidden window has to become visible for the chat
  if (win.walkTimer) {
    clearInterval(win.walkTimer);
    win.walkTimer = null;
  }
  if (!win.isVisible()) {
    win.show();
    forceNoTaskbar(win);
  }
  // bottom mode pins the window BELOW every other window — the chat panel
  // would be invisible there, so lift it for the duration of the chat
  if (config.bottomMode) {
    chatLiftBottom = true;
    win.setFocusable(true);
    win.setAlwaysOnTop(true);
    win.moveTop();
  }

  const target = currentWindowSize();
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const w = Math.min(target.w, wa.width);
  const h = Math.min(target.h, wa.height);
  const panelSpan = w - size - CHAT_GAP; // space the panel occupies

  // The PET stays exactly where it is — the panel grows beside it, toward the
  // free space. Right side first; when the right edge is full, flip to the
  // left (the renderer lays the panel out on the left and anchors the pet to
  // the window's right edge). Vertically the panel may grow UPWARD past the
  // pet when there is no room below; shiftY tells the renderer to offset the
  // sprite so its on-screen position never changes.
  let side = "right";
  if (x + size + CHAT_GAP + panelSpan > wa.x + wa.width && x - panelSpan - CHAT_GAP >= wa.x) side = "left";
  let tx, ty;
  if (side === "left") {
    // pet (right-anchored) stays at screen x: window left = x - panel - gap
    tx = x - panelSpan - CHAT_GAP;
  } else {
    // keep the pet corner when it fits; only shift on very narrow screens
    tx = Math.min(Math.max(x, wa.x), wa.x + wa.width - w);
  }
  ty = Math.min(Math.max(y, wa.y), wa.y + wa.height - h); // grow down first, up only as needed
  const shiftY = y - ty; // pet's CSS top offset so its screen y never moves

  win.setBounds({ x: tx, y: ty, width: w, height: h });
  chatOpenBounds = { x: tx, y: ty };
  chatSide = side;
  chatShiftY = shiftY;
  chatMaximized = false;
  chatPrevPanel = null;
  win.webContents.send("pet:chat-panel", { open: true, side, shiftY });
  win.focus();
}
function closeChatPanel() {
  if (!win || win.isDestroyed()) return;
  if (!chatPanelOpen) return;
  chatPanelOpen = false;
  const size = Math.max(64, Math.min(256, Math.round(config.size ?? DEFAULT_CONFIG.size)));
  const w = size + WINDOW_EXTRA;
  const h = size + WINDOW_STRIP;
  const [x, y] = win.getPosition();
  // If the user dragged the enlarged window while chatting, keep their spot;
  // otherwise return the pet to exactly where it was before the panel opened.
  // Compare against the OPENED bounds (with a small tolerance — the left-side
  // flip legitimately moves the window and must not be mistaken for a drag).
  const dragged = chatOpenBounds !== null
    && (Math.abs(x - chatOpenBounds.x) > 2 || Math.abs(y - chatOpenBounds.y) > 2);
  const pos = dragged
    ? clampToDisplays(x, y, w, h)
    : clampToDisplays(chatRestoreBounds?.x ?? x, chatRestoreBounds?.y ?? y, w, h);
  chatRestoreBounds = null;
  chatOpenBounds = null;
  chatShiftY = 0;
  chatMaximized = false;
  chatPrevPanel = null;
  win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
  if (chatLiftBottom) {
    chatLiftBottom = false;
    applyBottomMode(true); // push the pet back below other windows
  }
  win.webContents.send("pet:chat-panel", { open: false });
}
/** Queue one user prompt for the plugin's /poll long-poll (best-effort). */
function sendChatPrompt(text) {
  enqueueChatCommand({ cmd: "prompt", text });
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// settings window: a SEPARATE window so the pet window never enlarges
// ---------------------------------------------------------------------------
let settingsWin = null;
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 300,
    // the panel (title + 角色/大小/透明度 + 3 checkboxes + paths + 完成) needs
    // ~436 CSS px inside the content area; 500 outer leaves room for the
    // title bar on every platform (see #settings max-height as a safety net)
    height: 500,
    title: "DSH Desktop Pet 设置",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: WINDOW_ICON(),
    backgroundColor: "#f9fafb", // light web theme base
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  forceNoTaskbar(settingsWin);
  settingsWin.once("ready-to-show", () => forceNoTaskbar(settingsWin));
  settingsWin.on("show", () => forceNoTaskbar(settingsWin));
  setTimeout(() => forceNoTaskbar(settingsWin), 800);
  settingsWin.setMenuBarVisibility(false);
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  settingsWin.loadFile(path.join(ROOT, "renderer", "index.html"), { query: { settings: "1" } });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  settingsWin.webContents.on("will-navigate", (e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    e.preventDefault();
  });
}
function closeSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
}

// ---------------------------------------------------------------------------
// (task info display lives in the pet window's black caption box below the
// sprite — hover or persistent via the menu / settings; no popup window)
// ---------------------------------------------------------------------------

/** Deliver a signal to every window (pet + settings + chat). */
function broadcast(signal) {
  for (const w of [win, settingsWin]) {
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send("pet:signal", signal);
      } catch {
        /* window gone mid-send */
      }
    }
  }
}

function setClickThrough(enabled) {
  clickThrough = !!enabled;
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
  }
  // keep the renderer's pierceMode in sync so the pet menu reopens after a
  // tray-side restore (and vice versa)
  broadcast({ type: "pierce", enabled: clickThrough });
  refreshTrayMenu(); // checkbox must reflect the state we just applied
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle("pet:ready", () => loadState());

  ipcMain.handle("pet:get-config", () => ({ config, roles: scanCharacters() }));

  ipcMain.handle("pet:paths", () => ({
    characters: USER_CHARACTERS_DIR(),
    configDir: path.dirname(CONFIG_FILE()),
  }));

  // open a folder in the OS file manager (settings panel helper)
  ipcMain.on("pet:open-path", (_e, which) => {
    const p = which === "config" ? path.dirname(CONFIG_FILE()) : USER_CHARACTERS_DIR();
    try {
      shell.openPath(p);
    } catch {
      /* best-effort */
    }
  });

  ipcMain.on("pet:drag-start", () => {
    if (!win) return;
    // a user drag supersedes any running walk animation
    if (win.walkTimer) {
      clearInterval(win.walkTimer);
      win.walkTimer = null;
    }
    const b = win.getBounds();
    dragAnchor = { x: b.x, y: b.y };
  });

  ipcMain.on("pet:drag-end", () => {
    dragAnchor = null;
  });

  ipcMain.on("pet:move-to", (_e, dx, dy) => {
    if (!win) return;
    if (!dragAnchor) {
      const b = win.getBounds();
      dragAnchor = { x: b.x, y: b.y };
    }
    // Anchor on the authoritative bounds captured at drag start and apply the
    // renderer's mouse deltas. Never use renderer absolute coords: screenX/Y
    // and window.screenX drift on DPI-scaled multi-display setups, but the
    // delta between two screenX readings is exact. Pin the size too (never
    // re-read win.getSize(): it drifts on transparent windows) — and use the
    // chat layout while the panel is open so dragging doesn't clip the panel.
    const { w, h } = currentWindowSize();
    const target = clampToDisplays(dragAnchor.x + dx, dragAnchor.y + dy, w, h, true);
    win.setBounds({
      x: target.x,
      y: target.y,
      width: w,
      height: h,
    });
    correctForDisplay(); // re-scale if the drag crossed a DPI boundary
  });

  // walk: window movement driven from the main process (the renderer only
  // plays the animation). Bounds are anchored at walk start, clamped to the
  // current display's work area, and cancelled by pet:drag-start.
  ipcMain.on("pet:walk-start", (_e, opts) => {
    if (!win || win.isDestroyed() || win.walkTimer || chatPanelOpen) return;
    const b = win.getBounds();
    // the pet is at the window's left edge; clamp by the PET width so it
    // walks right up to the work area instead of stopping 150px short
    const petW = Math.max(32, b.width - WINDOW_EXTRA);
    const wa = screen.getDisplayMatching(b).workArea;
    const dir = Math.random() < 0.5 ? -1 : 1;
    const dist = Math.max(30, Math.min(120, petW * 0.6));
    const steps = 22;
    const durationMs = Math.max(500, Math.min(60000, opts?.durationMs ?? 26000));
    const startX = b.x;
    const y = b.y;
    let i = 0;
    win.walkTimer = setInterval(() => {
      i++;
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      let x = startX + dir * dist * ease;
      x = Math.max(wa.x, Math.min(wa.x + wa.width - petW, x));
      win.setBounds({ x: Math.round(x), y, width: b.width, height: b.height });
      if (i >= steps) {
        clearInterval(win.walkTimer);
        win.walkTimer = null;
      }
    }, Math.round(durationMs / steps));
  });

  ipcMain.on("pet:save-ledger", (e, ledger) => {
    // ONLY the pet window's ledger is authoritative. The settings window runs
    // the same renderer (with a fresh default ledger) and would otherwise
    // overwrite the pet's real growth data with a blank one.
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
    win.ledger = ledger;
    queueSave();
  });

  ipcMain.on("pet:set-config", (_e, patch) => {
    if (!patch || typeof patch !== "object") return;
    config = {
      ...config,
      ...patch,
      walk: { ...config.walk, ...(patch.walk ?? {}) },
    };
    saveConfig();
    applyWindowConfig(config);
    broadcast({ type: "config", config });
  });

  ipcMain.on("pet:click-through", (_e, enabled) => setClickThrough(enabled));

  // hideWhenIdle: the renderer asks the main process to hide/show the pet
  ipcMain.on("pet:set-window-visible", (_e, visible) => {
    if (!win || win.isDestroyed()) return;
    if (visible) {
      win.show();
      forceNoTaskbar(win);
    } else {
      win.hide();
    }
  });

  // click menu: native system popup (no window enlargement needed). The
  // renderer sends the exact action list, derived from the current
  // character's actual animation tracks.
  function sendMenuAction(act) {
    if (win && !win.isDestroyed()) win.webContents.send("pet:menu-action", act);
  }
  const ACTION_DEFS = {
    feed: { label: "🍗 喂食" },
    play: { label: "🎾 玩耍" },
    cheer: { label: "🎉 庆祝" },
    chat: { label: "💬 对话" },
    "task-on": { label: "📋 常驻任务进度" },
    "task-off": { label: "📋 关闭任务进度" },
    "detail-on": { label: "📋 详细进度" },
    "detail-off": { label: "📋 简略进度" },
    settings: { label: "⚙️ 设置" },
    bottom: { label: "📌 桌面置底" },
    pierce: { label: "🧊 鼠标穿透" },
    quit: { label: "✕ 退出" },
  };
  ipcMain.on("pet:show-menu", (_e, pos) => {
    if (!win || win.isDestroyed()) return;
    const actions = Array.isArray(pos?.actions) ? pos.actions : null;
    const items = [];
    for (const action of actions ?? ["feed", "play", "cheer", "settings", "bottom", "pierce", "quit"]) {
      if (action === "sep") {
        items.push({ type: "separator" });
        continue;
      }
      const def = ACTION_DEFS[action];
      if (!def) continue;
      items.push({
        label: def.label,
        click: () => {
          if (action === "quit") app.quit();
          else sendMenuAction(action);
        },
      });
    }
    if (!items.length) return;
    const menu = Menu.buildFromTemplate(items);
    // Native popup coordinate semantics (verified against v33.4.11 source):
    // ALL platforms treat x/y as window-content-relative — Windows/Linux via
    // MenuViews::PopupAt (location = contentOrigin + (x,y)), macOS via
    // MenuMac::PopupAt (position = (x, viewHeight - y) in view space). So the
    // renderer's clientX/clientY pass straight through everywhere; missing
    // coords (-1/-1) make the platform use the real mouse position.
    const x = Number.isFinite(pos?.x) ? Math.round(pos.x) : -1;
    const y = Number.isFinite(pos?.y) ? Math.round(pos.y) : -1;
    menu.popup({ window: win, x, y });
  });

  ipcMain.on("pet:bottom-mode", (_e, enabled) => {
    if (!win || win.isDestroyed()) return;
    config = { ...config, bottomMode: !!enabled };
    saveConfig();
    applyBottomMode(config.bottomMode);
    if (win && !win.isDestroyed()) broadcast({ type: "config", config });
  });

  // settings: a SEPARATE window — the pet window itself never enlarges
  ipcMain.on("pet:panel-open", () => openSettingsWindow());
  ipcMain.on("pet:panel-close", () => closeSettingsWindow());

  // chat: an in-pet-window panel to talk to the DSH agent
  ipcMain.on("pet:chat-open", () => openChatPanel());
  ipcMain.on("pet:chat-close", () => closeChatPanel());
  ipcMain.handle("pet:chat-send", (_e, text) => {
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "empty" };
    return sendChatPrompt(text.trim());
  });
  // Ask the plugin for the persisted session list (shown in the chat panel).
  ipcMain.on("pet:chat-list-sessions", () => {
    enqueueChatCommand({ cmd: "list-sessions" });
  });
  // Switch the chat to a specific historical session (loads its transcript).
  ipcMain.on("pet:chat-select-session", (_e, sessionId) => {
    if (typeof sessionId === "string" && sessionId) {
      enqueueChatCommand({ cmd: "select-session", sessionId });
    }
  });
  // The panel opened: mirror the web's current conversation into the panel.
  ipcMain.on("pet:chat-current-session", () => {
    enqueueChatCommand({ cmd: "current-session" });
  });
  // The panel closed: drop the pinned chat target so the next open follows
  // the web's active conversation again.
  ipcMain.on("pet:chat-reset-target", () => {
    enqueueChatCommand({ cmd: "reset-chat-target" });
  });
  // The user clicked "new conversation": the plugin creates a fresh session.
  ipcMain.on("pet:chat-new-session", () => {
    enqueueChatCommand({ cmd: "new-session" });
  });
  // Chat panel resize (drag the panel's pet-facing edge / bottom corner):
  // capture the anchor bounds on start, then grow the window from the deltas.
  ipcMain.on("pet:chat-resize-start", () => {
    if (!win || win.isDestroyed() || !chatPanelOpen) return;
    if (win.walkTimer) {
      clearInterval(win.walkTimer);
      win.walkTimer = null;
    }
    chatResizeAnchor = { ...win.getBounds() };
  });
  ipcMain.on("pet:chat-resize-move", (_e, dx, dy) => {
    if (!win || win.isDestroyed() || !chatResizeAnchor || !chatPanelOpen) return;
    const a = chatResizeAnchor;
    const size = Math.max(64, Math.min(256, Math.round(config.size ?? DEFAULT_CONFIG.size)));
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const w = Math.round(Math.min(Math.max(a.width + (Number.isFinite(dx) ? dx : 0),
      Math.min(size + 240 + CHAT_GAP, wa.width)), wa.width));
    const h = Math.round(Math.min(Math.max(a.height + (Number.isFinite(dy) ? dy : 0),
      Math.min(280, wa.height)), wa.height));
    applyChatBounds(w - size - CHAT_GAP, h);
  });
  ipcMain.on("pet:chat-resize-end", () => {
    chatResizeAnchor = null;
    saveConfig(); // persist the resized panel size
  });
  // One-click maximize / restore: fill the work area beside the pet, or return
  // to the size remembered before maximizing (the pet never moves either way).
  ipcMain.on("pet:chat-maximize", () => {
    if (!win || win.isDestroyed() || !chatPanelOpen) return;
    const size = Math.max(64, Math.min(256, Math.round(config.size ?? DEFAULT_CONFIG.size)));
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const b = win.getBounds();
    if (!chatMaximized) {
      chatMaximized = true;
      chatPrevPanel = { w: Math.round(b.width - size - CHAT_GAP), h: b.height };
      const petScreenX = chatSide === "left" ? b.x + b.width : b.x;
      const panelW = (chatSide === "left" ? petScreenX - wa.x : wa.x + wa.width - petScreenX) - CHAT_GAP;
      applyChatBounds(panelW, wa.height);
    } else {
      chatMaximized = false;
      if (chatPrevPanel) applyChatBounds(chatPrevPanel.w, chatPrevPanel.h);
      chatPrevPanel = null;
    }
    win.webContents.send("pet:chat-maximized", { on: chatMaximized });
    saveConfig();
  });

  ipcMain.on("pet:quit", () => app.quit());
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // a desktop pet doesn't belong in the Dock (Windows/Linux handle this via
    // skipTaskbar + WS_EX_TOOLWINDOW; macOS shows the Dock icon by default)
    if (process.platform === "darwin" && app.dock?.hide) app.dock.hide();
    loadConfig();
    importExternalCharacters(); // petdex pets -> userData/characters
    syncBuiltinCharacters(); // whale-girl -> userData/characters (统一管理)
    registerPetProtocol();
    setupIpc();
    startSignalServer();
    watchConfigFile();
    createWindow();
    createTray();
    applyBottomMode(!!config.bottomMode);
    lastScaleFactor = null;
    correctForDisplay();
    screen.on("display-metrics-changed", () => correctForDisplay());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    clearTimeout(saveTimer);
    saveStateNow();
    saveConfig();
  });

  app.on("window-all-closed", (event) => {
    // keep running in the tray; only quit explicitly
    event.preventDefault();
  });
}
