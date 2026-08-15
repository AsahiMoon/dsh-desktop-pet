/**
 * smoke-pierce.cjs — end-to-end interaction test (right-click menu, left-drag,
 * click-through) against the running pet via CDP + real Win32 input.
 * Usage: node smoke-pierce.cjs <petPid>
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
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const VK_ESCAPE = 0x1b;
const KEYEVENTF_KEYUP = 0x0002;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpEval(expr) {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const target = list.find((t) => t.type === "page" && t.url.includes("index.html"));
  if (!target) throw new Error("no pet page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const result = await new Promise((res) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) res(msg);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  if (result.result?.exceptionDetails) return "EXC: " + JSON.stringify(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  return result.result?.result?.value;
}

function enumWindowsOf(pid) {
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
      if (cls === "Chrome_WidgetWin_1" && isWindowVisible(hwnd)) out.push([rc.left, rc.top, rc.right, rc.bottom]);
    } catch (e) {
      /* skip */
    }
    return true;
  };
  enumWindows(cb, null);
  return out;
}

function petRect(pid) {
  const own = enumWindowsOf(pid);
  if (!own.length) return null;
  own.sort((a, b) => (a[2] - a[0]) * (a[3] - a[1]) - (b[2] - b[0]) * (b[3] - b[1]));
  return own[0];
}

function countMenus(pid) {
  const own = enumWindowsOf(pid);
  if (!own.length) return 0;
  own.sort((a, b) => (a[2] - a[0]) * (a[3] - a[1]) - (b[2] - b[0]) * (b[3] - b[1]));
  const petArea = (own[0][2] - own[0][0]) * (own[0][3] - own[0][1]);
  return own.filter((w) => (w[2] - w[0]) * (w[3] - w[1]) > petArea * 1.5).length;
}

async function rightClickAt(cx, cy) {
  setCursorPos(cx, cy);
  await sleep(70);
  mouseEvent(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, null);
  await sleep(50);
  mouseEvent(MOUSEEVENTF_RIGHTUP, 0, 0, 0, null);
}

async function dragFrom(cx, cy, dx, dy) {
  setCursorPos(cx, cy);
  await sleep(70);
  mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null);
  await sleep(70);
  for (let i = 1; i <= 8; i++) {
    setCursorPos(cx + Math.round((dx * i) / 8), cy + Math.round((dy * i) / 8));
    await sleep(35);
  }
  await sleep(120);
  mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, null);
}

const pid = parseInt(process.argv[2], 10);
if (!pid) {
  console.error("usage: node smoke-pierce.cjs <petPid>");
  process.exit(2);
}

(async () => {
  keybdEvent(VK_ESCAPE, 0, 0, null);
  keybdEvent(VK_ESCAPE, 0, KEYEVENTF_KEYUP, null);
  await sleep(250);

  let r = petRect(pid);
  if (!r) throw new Error("no pet window");
  const cx = Math.round((r[0] + r[2]) / 2);
  const cy = Math.round((r[1] + r[3]) / 2);

  console.log("=== 1. LEFT click must NOT open a menu (pure drag now) ===");
  await dragFrom(cx, cy, 1, 1); // ~no movement => treated as click
  await sleep(400);
  console.log("menus after left click:", countMenus(pid), countMenus(pid) === 0 ? "PASS" : "FAIL");

  console.log("=== 2. RIGHT click opens the menu ===");
  keybdEvent(VK_ESCAPE, 0, 0, null);
  keybdEvent(VK_ESCAPE, 0, KEYEVENTF_KEYUP, null);
  await sleep(200);
  await rightClickAt(cx, cy);
  await sleep(500);
  console.log("menus after right click:", countMenus(pid), countMenus(pid) >= 1 ? "PASS" : "FAIL");
  keybdEvent(VK_ESCAPE, 0, 0, null);
  keybdEvent(VK_ESCAPE, 0, KEYEVENTF_KEYUP, null);
  await sleep(200);

  console.log("=== 3. LEFT drag moves the window ===");
  console.log("windows before step3:", JSON.stringify(enumWindowsOf(pid)), "menus:", countMenus(pid));
  r = petRect(pid);
  await dragFrom(Math.round((r[0] + r[2]) / 2), Math.round((r[1] + r[3]) / 2), 120, 50);
  await sleep(500);
  console.log("windows after step3:", JSON.stringify(enumWindowsOf(pid)));
  const r2 = petRect(pid);
  const dx = r2[0] - r[0];
  const dy = r2[1] - r[1];
  console.log(`moved (${dx}, ${dy}) expected (120, 50) -> ${Math.abs(dx - 120) <= 40 && Math.abs(dy - 50) <= 40 ? "PASS" : "FAIL"}`);

  console.log("=== 4. pierce ON: no menu, no drag ===");
  await cdpEval("window.petAPI.setClickThrough(true)");
  await sleep(400);
  console.log("pierceMode:", await cdpEval("pierceMode"));
  r = petRect(pid);
  await dragFrom(Math.round((r[0] + r[2]) / 2), Math.round((r[1] + r[3]) / 2), 80, 40);
  await rightClickAt(Math.round((r[0] + r[2]) / 2), Math.round((r[1] + r[3]) / 2));
  await sleep(500);
  const r3 = petRect(pid);
  console.log(
    `while piercing: menus=${countMenus(pid)} moved=(${r3[0] - r[0]}, ${r3[1] - r[1]}) -> ${
      countMenus(pid) === 0 && Math.abs(r3[0] - r[0]) <= 5 && Math.abs(r3[1] - r[1]) <= 5 ? "PASS" : "FAIL"
    }`,
  );

  console.log("=== 5. restore: menu + drag work again ===");
  await cdpEval("window.petAPI.setClickThrough(false)");
  await sleep(400);
  console.log("pierceMode:", await cdpEval("pierceMode"));
  r = petRect(pid);
  await dragFrom(Math.round((r[0] + r[2]) / 2), Math.round((r[1] + r[3]) / 2), 100, 40);
  await sleep(400);
  const r4 = petRect(pid);
  console.log(`drag after restore: moved=(${r4[0] - r[0]}, ${r4[1] - r[1]}) -> ${Math.abs(r4[0] - r[0] - 100) <= 40 && Math.abs(r4[1] - r[1] - 40) <= 40 ? "PASS" : "FAIL"}`);
  await rightClickAt(Math.round((r4[0] + r4[2]) / 2), Math.round((r4[1] + r4[3]) / 2));
  await sleep(500);
  console.log("menus after restore + right click:", countMenus(pid), countMenus(pid) >= 1 ? "PASS" : "FAIL");
  keybdEvent(VK_ESCAPE, 0, 0, null);
  keybdEvent(VK_ESCAPE, 0, KEYEVENTF_KEYUP, null);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
