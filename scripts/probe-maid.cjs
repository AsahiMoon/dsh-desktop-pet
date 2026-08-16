/** Dev-only: verify maid styling + single-tool card + no horizontal overflow. */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 700, show: false, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, "..", "preload.js") },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: { chat: "1" } });
  await sleep(400);
  const evaljs = (expr) => win.webContents.executeJavaScript(expr, true);
  const sig = (kind, extra = {}) => win.webContents.send("pet:signal", { type: "chat", kind, sessionId: "s1", ...extra });
  win.webContents.send("pet:chat-panel", { open: true, side: "right", shiftY: 0 });
  await sleep(120);

  // ---- 1) single tool card: running sweep until tool-done ----
  sig("user", { text: "你好" });
  await sleep(20);
  sig("tool", { callId: "t1", tool: "read", label: "📖 读文件", summary: "renderer/pet.js", argsText: '{"file_path":"renderer/pet.js"}' });
  await sleep(50);
  const running = JSON.parse(await evaljs(`JSON.stringify({
    running: !!document.querySelector(".chat-tool[data-running]"),
    toolH: Math.round(document.querySelector(".chat-tool").getBoundingClientRect().height),
    headText: document.querySelector(".chat-tool-head")?.textContent.trim(),
  })`));
  check("single tool card marked running (sweep)", running.running === true, JSON.stringify(running));
  check("single tool card has visible height", running.toolH >= 24, `h=${running.toolH}`);
  sig("tool-done", { callId: "t1", output: "ok", isError: false });
  await sleep(50);
  const done = await evaljs(`!!document.querySelector(".chat-tool[data-running]")`);
  check("tool-done clears the running state", done === false);
  sig("assistant", { text: "好的" });
  await sleep(30);

  // ---- 2) maid bubbles ----
  const bubbles = JSON.parse(await evaljs(`JSON.stringify({
    userBg: getComputedStyle(document.querySelector(".chat-user .chat-bubble")).backgroundColor,
    userBorder: getComputedStyle(document.querySelector(".chat-user .chat-bubble")).borderColor,
    asstBorder: getComputedStyle(document.querySelector(".chat-assistant .chat-bubble")).borderColor,
    asstRadius: getComputedStyle(document.querySelector(".chat-assistant .chat-bubble")).borderRadius,
  })`));
  check("user bubble = porcelain blue-white", bubbles.userBg.includes("232, 237, 249"), bubbles.userBg);
  check("user bubble = gold rim", bubbles.userBorder.includes("197, 164, 104"), bubbles.userBorder);
  check("assistant bubble = gold rim", bubbles.asstBorder.includes("197, 164, 104"), bubbles.asstBorder);
  check("assistant bubble = asymmetric tail radius", bubbles.asstRadius.startsWith("18px 18px 18px 6px"), bubbles.asstRadius);

  // ---- 3) maid input: frame ::before + circular gold send ----
  const input = JSON.parse(await evaljs(`JSON.stringify({
    frame: (() => {
      const el = document.querySelector(".chat-input-row");
      const cs = getComputedStyle(el, "::before");
      return { borderImage: cs.borderImageSource.includes("maid-composer-frame.webp"),
               borderWidth: cs.borderTopWidth, display: cs.display };
    })(),
    send: (() => {
      const b = document.getElementById("chat-send");
      const cs = getComputedStyle(b);
      return { w: Math.round(b.getBoundingClientRect().width), radius: cs.borderRadius,
               bg: cs.backgroundImage.includes("linear-gradient"), gold: cs.borderColor };
    })(),
    overflowX: (() => {
      const m = document.getElementById("chat-messages");
      return m.scrollWidth - m.clientWidth;
    })(),
  })`));
  check("input has the maid frame border-image", input.frame.borderImage === true, input.frame.borderImage);
  check("send button is a gold-rimmed circle", input.send.w === 38 && input.send.radius === "50%", JSON.stringify(input.send));
  check("send button is porcelain-blue gradient", input.send.bg === true);
  check("no horizontal overflow in messages", input.overflowX <= 0, `dx=${input.overflowX}`);

  // ---- 4) horizontal scrollbar stays gone with long content ----
  await evaljs(`(() => {
    const m = document.getElementById("chat-messages");
    const long = document.createElement("div");
    long.className = "chat-row chat-user";
    long.innerHTML = '<div class="chat-bubble">' + "很长很长的没有空格的英文单词".repeat(30) + "https://github.com/some/really/long/path/with/no/spaces/at/all/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + '</div>';
    m.append(long);
    const card = document.createElement("div");
    card.className = "chat-tool";
    card.innerHTML = '<div class="chat-tool-head"><span class="chat-tool-icon">🛠️</span><span class="chat-tool-name">⚡ 执行命令</span><span class="chat-tool-sep"></span><span class="chat-tool-summary">' + "x".repeat(300) + '</span></div>' +
      '<div class="chat-tool-io"><span class="chat-tool-io-label">输入</span><code class="chat-tool-io-text">' + "y".repeat(400) + '</code></div>';
    m.append(card);
    return true;
  })()`);
  await sleep(60);
  const overflow = JSON.parse(await evaljs(`JSON.stringify({
    dx: document.getElementById("chat-messages").scrollWidth - document.getElementById("chat-messages").clientWidth,
    hScrollbar: document.getElementById("chat-messages").scrollWidth > document.getElementById("chat-messages").clientWidth,
  })`));
  check("no horizontal scrollbar with long content", overflow.hScrollbar === false, JSON.stringify(overflow));

  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error("ERR", e); app.exit(1); });
