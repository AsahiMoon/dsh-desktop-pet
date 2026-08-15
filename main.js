/**
 * dsh-desktop-pet — main process.
 * A transparent, frameless, always-on-top desktop pet window with system tray
 * support, hot-reloadable config (size / opacity / walk / sleep / character)
 * and a local HTTP signal channel for DSH agent-state sync. Sprites live under
 * ../assets/characters/<id>/ (whale-girl set is MIT, see NOTICE.md). Pet logic
 * lives in the renderer; this process owns the window, tray, click-through,
 * position/config persistence, character discovery and the pet:// protocol.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, protocol, net, screen } = require("electron");
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
const koffi = require("koffi");

const ROOT = __dirname;
// Built-in characters ship inside the (read-only) asar. A SECOND, writable
// characters directory under userData makes the pet compatible with ANY new
// model the user adds at runtime: drop a character folder in, or run
// `npx petdex install <name>` — it shows up in the character list.
const CHARACTERS_DIR = path.join(ROOT, "assets", "characters");
const USER_CHARACTERS_DIR = () => path.join(app.getPath("userData"), "characters");
/** Characters to NEVER auto-import from petdex (user deletions). One id per line. */
const IGNORE_FILE = () => path.join(app.getPath("userData"), "characters", ".ignore");

// Pin the userData directory to the app name regardless of how electron is
// launched (unpacked dev runs default to %APPDATA%/Electron otherwise).
app.setName("dsh-desktop-pet");
// Taskbar grouping + correct icon association (Windows-only API; no-op safe)
if (IS_WIN) app.setAppUserModelId("com.dsh.desktop-pet");

const STATE_FILE = () => path.join(app.getPath("userData"), "pet-state.json");
const CONFIG_FILE = () => path.join(app.getPath("userData"), "config.json");

// Local HTTP signal channel shared with the dsh-desktop-pet bundle Node half.
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
  taskBarPersistent: false, // keep the task-progress caption always visible
  taskBarDetailed: false, // persistent caption shows detailed progress + completed tasks
  hideWhenIdle: false, // hide the pet window entirely during its long-quiet sleep
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

/** Window icon: whale-girl idle frame (nativeImage accepts the PNG directly). */
const WINDOW_ICON = () => path.join(CHARACTERS_DIR, "whale-girl", "idle.png");

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
      const { w, h } = authoritativeSize();
      win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: w, height: h });
      win.setSize(w, h); // re-apply so Windows re-scales the transparent window
    }
    lastScaleFactor = scale;
  } catch {
    /* display query failed — ignore */
  }
}

function applyWindowConfig(cfg) {
  if (!win || win.isDestroyed()) return;
  const size = Math.max(64, Math.min(256, Math.round(cfg.size ?? DEFAULT_CONFIG.size)));
  if (appliedWindow.size !== size) {
    const [x, y] = win.getPosition();
    const { width: w, height: h } = win.getBounds(); // getBounds returns an object
    appliedWindow.size = size;
    // setBounds with the authoritative value (setSize on DPI-scaled
    // transparent windows drifts; bounds write avoids the read-back)
    win.setBounds({
      x: Math.round(x + (w - (size + WINDOW_EXTRA)) / 2),
      y: Math.round(y + (h - (size + WINDOW_STRIP)) / 2),
      width: size + WINDOW_EXTRA,
      height: size + WINDOW_STRIP,
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
  let ignore = new Set();
  try {
    ignore = new Set(
      fs
        .readFileSync(IGNORE_FILE(), "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    /* no ignore file */
  }
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

// ---------------------------------------------------------------------------
// HTTP signal listener (agent-state sync from the DSH bundle)
// ---------------------------------------------------------------------------
function startSignalServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/signal") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        const signal = JSON.parse(body);
        if (signal && typeof signal.type === "string" && signal.type === "config" && signal.config) {
          // hot config: merge, persist, apply window-level, forward to all windows
          config = {
            ...DEFAULT_CONFIG,
            ...signal.config,
            walk: { ...DEFAULT_CONFIG.walk, ...(signal.config.walk ?? {}) },
          };
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
  server.listen(SIGNAL_PORT, SIGNAL_HOST, () => {
    console.log(`[pet] http signal server listening on ${SIGNAL_HOST}:${SIGNAL_PORT}`);
  });
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
  const pos = saved.x !== null && saved.y !== null ? { x: saved.x, y: saved.y } : defaultPosition();

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
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error(`[renderer] did-fail-load ${code} ${desc}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[renderer] process gone: ${details.reason}`);
  });
  if (process.argv.includes("--dev")) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------
function trayIcon() {
  // always use the built-in whale-girl art: codex characters have no
  // idle.png, and createFromPath silently returns an EMPTY image for
  // missing files — an invisible tray icon.
  const png = path.join(CHARACTERS_DIR, "whale-girl", "idle.png");
  try {
    return nativeImage.createFromPath(png).resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("dsh-desktop-pet");
  refreshTrayMenu();
  tray.on("click", () => toggleWindow());
}

/** Rebuild the tray context menu from the CURRENT state so checkbox items
 *  (bottom mode / mouse pierce) always reflect reality — otherwise a stale
 *  checkbox makes the first click re-enable instead of disable. */
function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "显示 / 隐藏", click: () => toggleWindow() },
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
    height: 352,
    title: "DSH Desktop Pet 设置",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: WINDOW_ICON(),
    backgroundColor: "#141426",
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
  settingsWin.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[settings:${level}] ${message} (${sourceId}:${line})`);
  });
}
function closeSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
}

// ---------------------------------------------------------------------------
// (task info display lives in the pet window's black caption box below the
// sprite — hover or persistent via the menu / settings; no popup window)
// ---------------------------------------------------------------------------

/** Deliver a signal to every window (pet + settings). */
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
    // re-read win.getSize(): it drifts on transparent windows).
    const { w, h } = authoritativeSize();
    win.setBounds({
      x: Math.round(dragAnchor.x + dx),
      y: Math.round(dragAnchor.y + dy),
      width: w,
      height: h,
    });
    correctForDisplay(); // re-scale if the drag crossed a DPI boundary
  });

  // walk: window movement driven from the main process (the renderer only
  // plays the animation). Bounds are anchored at walk start, clamped to the
  // current display's work area, and cancelled by pet:drag-start.
  ipcMain.on("pet:walk-start", (_e, opts) => {
    if (!win || win.isDestroyed() || win.walkTimer) return;
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

  ipcMain.on("pet:save-ledger", (_e, ledger) => {
    if (!win) return;
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
    loadConfig();
    importExternalCharacters(); // petdex pets -> userData/characters
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
