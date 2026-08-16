/**
 * Preload — minimal secure bridge between the renderer and the main process.
 * Exposes only the pet-specific surface under window.petAPI.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  /** Resolve persisted { x, y, ledger } from disk. */
  ready: () => ipcRenderer.invoke("pet:ready"),
  /** Resolve current { config, roles } (config + installed characters). */
  getConfig: () => ipcRenderer.invoke("pet:get-config"),
  /** Resolve the characters/config folder paths (settings panel). */
  getPaths: () => ipcRenderer.invoke("pet:paths"),
  /** Open a folder in the OS file manager ("characters" | "config"). */
  openPath: (which) => ipcRenderer.send("pet:open-path", which),
  /** Ask the main process to move the window by a mouse delta (dip). */
  moveTo: (dx, dy) => ipcRenderer.send("pet:move-to", dx, dy),
  /** Capture the window position as the drag anchor (also cancels any walk). */
  dragStart: () => ipcRenderer.send("pet:drag-start"),
  /** Release the drag anchor. */
  dragEnd: () => ipcRenderer.send("pet:drag-end"),
  /** Ask the main process to drive a walk animation for durationMs. */
  walkStart: (opts) => ipcRenderer.send("pet:walk-start", opts),
  /** Persist the pet's growth ledger. */
  saveLedger: (ledger) => ipcRenderer.send("pet:save-ledger", ledger),
  /** Apply + persist a config patch (size / opacity / ...). */
  setConfig: (patch) => ipcRenderer.send("pet:set-config", patch),
  /** Subscribe to agent-state signals pushed from the DSH bundle Node half. */
  onSignal: (cb) => {
    ipcRenderer.on("pet:signal", (_event, signal) => cb(signal));
  },
  /** Toggle click-through (ignore mouse events). */
  setClickThrough: (enabled) => ipcRenderer.send("pet:click-through", enabled),
  /** Hide or show the pet window (hideWhenIdle auto-hide). */
  setWindowVisible: (visible) => ipcRenderer.send("pet:set-window-visible", visible),
  /** Toggle desktop-bottom mode (pin below other windows). */
  setBottomMode: (enabled) => ipcRenderer.send("pet:bottom-mode", !!enabled),
  /** Enlarge the window temporarily for the settings panel. */
  openSettingsPanel: () => ipcRenderer.send("pet:panel-open"),
  /** Restore the pet window size after the settings panel closes. */
  closeSettingsPanel: () => ipcRenderer.send("pet:panel-close"),
  /** Pop the native system click-menu at the given screen position. */
  showMenu: (pos) => ipcRenderer.send("pet:show-menu", pos),
  /** Native menu item chosen by the user. */
  onMenuAction: (cb) => {
    ipcRenderer.on("pet:menu-action", (_event, act) => cb(act));
  },
  /** Open the separate chat window (talk to the DSH agent). */
  openChat: () => ipcRenderer.send("pet:chat-open"),
  /** Close the separate chat window. */
  closeChat: () => ipcRenderer.send("pet:chat-close"),
  /** Submit one prompt to the DSH agent through the plugin chat bridge. */
  sendChat: (text) => ipcRenderer.invoke("pet:chat-send", text),
  /** Ask the plugin to list persisted sessions (chat panel picker). */
  listSessions: () => ipcRenderer.send("pet:chat-list-sessions"),
  /** Switch the chat to one historical session (loads its transcript). */
  selectSession: (sessionId) => ipcRenderer.send("pet:chat-select-session", sessionId),
  /** Ask the plugin to mirror the web's current conversation into the panel. */
  currentSession: () => ipcRenderer.send("pet:chat-current-session"),
  /** Drop the pinned chat target (sent when the chat panel closes). */
  resetChatTarget: () => ipcRenderer.send("pet:chat-reset-target"),
  /** Start a brand-new conversation (creates a fresh agent session). */
  newSession: () => ipcRenderer.send("pet:chat-new-session"),
  /** Begin resizing the chat panel (captures the anchor window bounds). */
  chatResizeStart: () => ipcRenderer.send("pet:chat-resize-start"),
  /** Grow the chat panel by (dx, dy) — positive dx widens, positive dy
   *  tallens; the main process anchors the pet in place. */
  chatResizeMove: (dx, dy) => ipcRenderer.send("pet:chat-resize-move", dx, dy),
  /** Finish resizing and persist the new panel size. */
  chatResizeEnd: () => ipcRenderer.send("pet:chat-resize-end"),
  /** Toggle maximize: fill the work area beside the pet / restore the
   *  previous size. */
  chatMaximize: () => ipcRenderer.send("pet:chat-maximize"),
  /** Follow the maximize state so the ⛶ button can show 最大化/还原. */
  onChatMaximized: (cb) => {
    ipcRenderer.on("pet:chat-maximized", (_event, payload) => cb(payload));
  },
  /** Follow the pet's sprite offset while the panel height resizes near the
   *  screen bottom (keeps the pet at its exact screen spot). */
  onChatShift: (cb) => {
    ipcRenderer.on("pet:chat-shift", (_event, shiftY) => cb(shiftY));
  },
  /** Subscribe to chat-panel open/close events (in-pet-window panel). */
  onChatPanel: (cb) => {
    ipcRenderer.on("pet:chat-panel", (_event, payload) => cb(payload));
  },
  /** Quit the app. */
  quit: () => ipcRenderer.send("pet:quit"),
});
