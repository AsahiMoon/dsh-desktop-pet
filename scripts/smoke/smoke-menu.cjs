/**
 * smoke-menu.cjs — end-to-end menu position check for the packaged pet exe.
 * Usage: node smoke-menu.cjs <petPid>
 * 1. Finds the pet's main window (visible Chrome_WidgetWin_1 of that pid).
 * 2. Sends a real left-click at the window's center (SetCursorPos + mouse_event).
 * 3. Waits, then re-enumerates: any NEW visible window is the popup menu.
 * 4. Prints the menu rect and its offset from the click point.
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
const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
const getCursorPos = user32.func("bool GetCursorPos(_Out_ POINT *pt)");
const mouseEvent = user32.func(
  "void mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, uint32_t dwData, void *dwExtraInfo)",
);

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const keybdEvent = user32.func("void keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, void *dwExtraInfo)");
const VK_ESCAPE = 0x1b;
const KEYEVENTF_KEYUP = 0x0002;

function pressEscape() {
  keybdEvent(VK_ESCAPE, 0, 0, null);
  keybdEvent(VK_ESCAPE, 0, KEYEVENTF_KEYUP, null);
}

function enumOwn(pid) {
  const out = [];
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
      out.push({
        cls,
        visible: !!isWindowVisible(hwnd),
        rect: [rc.left, rc.top, rc.right, rc.bottom],
      });
    } catch (e) {
      /* skip */
    }
    return true;
  };
  enumWindows(cb, null);
  return out;
}

const pid = parseInt(process.argv[2], 10);
if (!pid) {
  console.error("usage: node smoke-menu.cjs <petPid>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  pressEscape(); // close any menu left open by a previous run
  await sleep(250);
  const before = enumOwn(pid).filter((w) => w.visible && w.cls === "Chrome_WidgetWin_1");
  console.log("before:", JSON.stringify(before));

  // Pet main window = the smallest visible Chrome_WidgetWin_1 (settings is bigger)
  before.sort((a, b) => (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]) - (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]));
  const pet = before[0];
  if (!pet) {
    console.error("no pet window found");
    process.exit(1);
  }
  const cx = Math.round((pet.rect[0] + pet.rect[2]) / 2);
  const cy = Math.round((pet.rect[1] + pet.rect[3]) / 2);
  const cur = {};
  getCursorPos(cur);
  console.log("cursor before:", JSON.stringify(cur), "-> set to:", cx, cy);
  const moved = setCursorPos(cx, cy);
  console.log("setCursorPos returned:", moved);
  const cur2 = {};
  getCursorPos(cur2);
  console.log("cursor after:", JSON.stringify(cur2));
  await sleep(80);
  mouseEvent(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, null);
  await sleep(60);
  mouseEvent(MOUSEEVENTF_RIGHTUP, 0, 0, 0, null);

  await sleep(600);

  const after = enumOwn(pid).filter((w) => w.visible && w.cls === "Chrome_WidgetWin_1");
  console.log("after:", JSON.stringify(after));

  // The menu is the visible window that wasn't there before (or the one whose
  // rect is small and near the click)
  const key = (r) => r.join(",");
  const beforeKeys = new Set(before.map((w) => key(w.rect)));
  const menu = after.find((w) => !beforeKeys.has(key(w.rect)));
  const candidates = after.filter((w) => !beforeKeys.has(key(w.rect)));
  console.log("new windows:", JSON.stringify(candidates));
  if (menu) {
    const mx = Math.round((menu.rect[0] + menu.rect[2]) / 2);
    const my = Math.round((menu.rect[1] + menu.rect[3]) / 2);
    console.log(
      `MENU rect=${JSON.stringify(menu.rect)} size=${menu.rect[2] - menu.rect[0]}x${menu.rect[3] - menu.rect[1]} ` +
        `center=(${mx},${my}) click=(${cx},${cy}) delta=(${mx - cx},${my - cy})`,
    );
    // PASS: the menu window must cover (or nearly cover) the click point —
    // i.e. it appears at the pet, not clamped to a display corner.
    const inside =
      cx >= menu.rect[0] && cx <= menu.rect[2] && cy >= menu.rect[1] && cy <= menu.rect[3];
    const near =
      Math.abs(mx - cx) < 150 && Math.abs(my - cy) < 150;
    console.log(inside || near ? "SMOKE PASS" : "SMOKE FAIL");
  } else {
    console.log("NO MENU FOUND");
    process.exit(1);
  }
})().catch((e) => {
  console.error("ERR", e.message, e.stack);
  process.exit(1);
});
