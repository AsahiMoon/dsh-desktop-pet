/**
 * smoke-idle.cjs — verify the richer idle animation + left-click reaction:
 *  1. while idle, sample #stage transform over ~20s: expect continuous bob
 *     (translateY) with occasional different pulses (hop/wiggle/sigh/wave)
 *  2. left-click (no drag) -> state becomes joy + bubble appears
 *  3. drag -> no reaction (click after drag must be suppressed)
 * Usage: node smoke-idle.cjs <petPid>
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
      if (cls === "Chrome_WidgetWin_1" && isWindowVisible(hwnd)) own.push([rc.left, rc.top, rc.right, rc.bottom]);
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

const pid = parseInt(process.argv[2], 10);
if (!pid) {
  console.error("usage: node smoke-idle.cjs <petPid>");
  process.exit(2);
}

(async () => {
  keybdEvent(VK_ESCAPE, 0, 0, null);
  keybdEvent(VK_ESCAPE, 0, KEYEVENTF_KEYUP, null);
  await sleep(250);

  // --- 1. idle motion sampling ---
  console.log("=== idle motion sampling (24s) ===");
  const seen = new Set();
  let bobCount = 0;
  let idleSamples = 0;
  for (let i = 0; i < 24; i++) {
    const st = await cdpEval("stage.dataset.state");
    const t = await cdpEval("stage.style.transform");
    if (st === "idle") idleSamples++;
    if (t && t.includes("translateY") && !t.includes("rotate")) bobCount++;
    if (t) seen.add(t);
    await sleep(1000);
  }
  console.log(`idle samples: ${idleSamples}/24; bob-ish: ${bobCount}; distinct transforms: ${[...seen].slice(0, 6).join(" | ")}`);
  console.log(idleSamples >= 15 && bobCount >= 10 ? "IDLE MOTION PASS" : "IDLE MOTION FAIL");

  // --- 2. left click -> joy + bubble ---
  console.log("=== left click reaction ===");
  let r = petRect(pid);
  const cx = Math.round((r[0] + r[2]) / 2);
  const cy = Math.round((r[1] + r[3]) / 2);
  await cdpEval("window.__clicks = []; document.getElementById('stage').addEventListener('click', () => window.__clicks.push(1)); 'ok'");
  setCursorPos(cx, cy);
  await sleep(80);
  mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null);
  await sleep(60);
  mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, null);
  await sleep(300);
  const st = await cdpEval("stage.dataset.state");
  const bubble = await cdpEval("document.getElementById('bubble').textContent");
  console.log("state after click:", st, "| bubble:", JSON.stringify(bubble));
  console.log(st === "joy" && bubble ? "CLICK REACTION PASS" : "CLICK REACTION FAIL");
  await sleep(1200);

  // --- 3. drag must NOT trigger the reaction ---
  console.log("=== drag (no click reaction) ===");
  r = petRect(pid);
  await sleep(200);
  setCursorPos(cx, cy);
  await sleep(80);
  mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null);
  await sleep(70);
  for (let i = 1; i <= 6; i++) {
    setCursorPos(cx + (100 * i) / 6, cy + (50 * i) / 6);
    await sleep(40);
  }
  await sleep(120);
  mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, null);
  await sleep(500);
  const st2 = await cdpEval("stage.dataset.state");
  const r2 = petRect(pid);
  console.log(`state after drag: ${st2} | window moved: (${r2[0] - r[0]}, ${r2[1] - r[1]})`);
  console.log(st2 === "idle" ? "DRAG GUARD PASS" : "DRAG GUARD FAIL");
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
