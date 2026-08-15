/**
 * smoke-drag.cjs — drag test: mousedown on the pet, move the cursor, mouseup,
 * then verify the window rect moved by the same delta.
 * Usage: node smoke-drag.cjs <petPid>
 */
const koffi = require("koffi");
const user32 = koffi.load("user32.dll");

const enumCb = koffi.proto("bool enum_cb(void *hwnd, void *lparam)");
const enumWindows = user32.func("bool EnumWindows(enum_cb *cb, void *lparam)");
const getClassNameW = user32.func("int GetClassNameW(void *hwnd, char16_t *buf, int n)");
const getWindowThreadProcessId = user32.func(
  "uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)",
);
const isWindowVisible = user32.func("bool IsWindowVisible(void *hwnd)");
const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const getWindowRect = user32.func("bool GetWindowRect(void *hwnd, _Out_ RECT *rect)");
const setCursorPos = user32.func("bool SetCursorPos(int32 x, int32 y)");
const mouseEvent = user32.func(
  "void mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, uint32_t dwData, void *dwExtraInfo)",
);
const keybdEvent = user32.func("void keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, void *dwExtraInfo)");
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const VK_ESCAPE = 0x1b;
const KEYEVENTF_KEYUP = 0x0002;

function petRect(pid) {
  const own = [];
  const cb = (hwnd) => {
    try {
      const pidArr = [null];
      getWindowThreadProcessId(hwnd, pidArr);
      if (pidArr[0] !== pid) return true;
      const buf = Buffer.allocUnsafe(512);
      const n = getClassNameW(hwnd, buf, 256);
      const cls = n > 0 && n < 256 ? koffi.decode(buf, "char16_t", n) : "";
      const rc = {};
      getWindowRect(hwnd, rc);
      if (cls === "Chrome_WidgetWin_1" && isWindowVisible(hwnd)) {
        own.push([rc.left, rc.top, rc.right, rc.bottom]);
      }
    } catch (e) {
      /* skip */
    }
    return true;
  };
  enumWindows(cb, null);
  if (!own.length) return null;
  own.sort((a, b) => (a[2] - a[0]) * (a[3] - a[1]) - (b[2] - b[0]) * (b[3] - b[1]));
  return own[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = parseInt(process.argv[2], 10);
const DX = parseInt(process.argv[3] || "100", 10);
const DY = parseInt(process.argv[4] || "60", 10);

(async () => {
  keybdEvent(VK_ESCAPE, 0, 0, null);
  keybdEvent(VK_ESCAPE, 0, KEYEVENTF_KEYUP, null);
  await sleep(200);

  const before = petRect(pid);
  if (!before) {
    console.error("no pet window");
    process.exit(1);
  }
  const cx = Math.round((before[0] + before[2]) / 2);
  const cy = Math.round((before[1] + before[3]) / 2);
  console.log("before:", JSON.stringify(before), "click at", cx, cy);

  setCursorPos(cx, cy);
  await sleep(80);
  mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null);
  await sleep(80);
  // move in small steps so the renderer sees a real drag
  for (let i = 1; i <= 8; i++) {
    setCursorPos(cx + Math.round((DX * i) / 8), cy + Math.round((DY * i) / 8));
    await sleep(40);
  }
  await sleep(120);
  mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, null);
  await sleep(400);

  const after = petRect(pid);
  console.log("after:", JSON.stringify(after));
  if (!after) process.exit(1);
  const dx = after[0] - before[0];
  const dy = after[1] - before[1];
  console.log(`moved by (${dx}, ${dy}) expected (${DX}, ${DY}) -> ${Math.abs(dx - DX) <= 40 && Math.abs(dy - DY) <= 40 ? "PASS" : "FAIL"}`);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
