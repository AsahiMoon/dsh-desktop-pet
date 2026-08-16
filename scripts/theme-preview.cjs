/** Dev-only: verify theme renders when backdrop-filter is disabled (offscreen
 *  software compositing turns blur surfaces black — real windows are fine). */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640, height: 640, show: false, frame: false, backgroundColor: "#f9fafb",
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, "..", "preload.js") },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: { chat: "1" } });
  await new Promise((r) => setTimeout(r, 600));
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById("chat").classList.remove("hidden");
      document.body.dataset.chatOpen = "1";
      // neutralize backdrop-filter for the software-composited capture
      const st = document.createElement("style");
      st.textContent = "*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}";
      document.head.append(st);
      // paint a realistic conversation with frosted tool cards (参数/输出 io)
      const msgs = document.getElementById("chat-messages");
      msgs.innerHTML =
        '<div class="chat-truncated-note">⏳ 该会话较早/较长，仅显示最近 250 条记录（已省略 480 条更早的）</div>' +
        '<div class="chat-row chat-user"><div class="chat-bubble">鲸鱼娘，帮我把对话框做得像网页一样～</div></div>' +
        // consecutive tool calls collapse into ONE group — head shows the latest
        '<div class="chat-tool-group collapsed">' +
          '<button type="button" class="chat-tool-group-head">' +
            '<span class="chat-tool-group-count">🛠️ 工具调用 × 3</span>' +
            '<span class="chat-tool-group-preview">⚡ 执行命令 · Get-Process | Select-Object -First 3</span>' +
            '<span class="chat-tool-group-chevron">▸</span>' +
          '</button>' +
          '<div class="chat-tool-group-body">' +
            '<div class="chat-tool" data-call-id="c2">' +
              '<div class="chat-tool-head"><span class="chat-tool-icon">🛠️</span><span class="chat-tool-name">🔎 搜索内容</span><span class="chat-tool-sep"></span><span class="chat-tool-summary">pattern: chat-bg in renderer</span></div>' +
              '<div class="chat-tool-io"><span class="chat-tool-io-label">输入</span><code class="chat-tool-io-text">{"pattern":"chat-bg","path":"renderer"}</code></div>' +
              '<div class="chat-tool-io"><span class="chat-tool-io-label">输出</span><code class="chat-tool-io-text">renderer/pet.css: chat-bg.webp 50% 0% / cover no-repeat</code></div>' +
            '</div>' +
            '<div class="chat-tool" data-call-id="c1">' +
              '<div class="chat-tool-head"><span class="chat-tool-icon">🛠️</span><span class="chat-tool-name">📖 读文件</span><span class="chat-tool-sep"></span><span class="chat-tool-summary">renderer/pet.css</span></div>' +
              '<div class="chat-tool-io"><span class="chat-tool-io-label">输入</span><code class="chat-tool-io-text">{"file_path":"renderer/pet.css"}</code></div>' +
            '</div>' +
            '<div class="chat-tool" data-running data-call-id="c0">' +
              '<div class="chat-tool-head"><span class="chat-tool-icon">🛠️</span><span class="chat-tool-name">⚡ 执行命令</span><span class="chat-tool-sep"></span><span class="chat-tool-summary">Get-Process | Select-Object -First 3</span></div>' +
              '<div class="chat-tool-io"><span class="chat-tool-io-label">输入</span><code class="chat-tool-io-text">{"command":"Get-Process | Select-Object -First 3"}</code></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="chat-row chat-assistant"><div class="chat-bubble">好的！连续的工具调用我会合并成一张小卡片，点一下就能展开看全部～ 🐳</div></div>' +
        '<div class="chat-row chat-user"><div class="chat-bubble">太棒了，谢谢！</div></div>';
      document.getElementById("chat-title-label").textContent = "🐳 与鲸鱼娘对话";
      // whale-girl avatar in the title bar (first idle frame)
      const av = document.getElementById("chat-avatar");
      av.style.backgroundImage = "url('pet://assets/characters/whale-girl/idle.png')";
      av.style.backgroundSize = "300% 100%";
      av.style.backgroundPosition = "0 0";
      av.style.display = "inline-block";
      document.getElementById("chat-stats").textContent = "轮次 3  ·  输入 1.2k tok · 输出 856 tok  ·  缓存命中 62%";
      document.getElementById("chat-input").value = "再讲讲你的缎带…";
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, "..", "docs", "chat-theme-preview.png");
  fs.writeFileSync(out, img.toPNG());
  console.log("preview saved:", out);
  app.quit();
});
