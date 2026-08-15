/* E2E verify: pet state + A1 ledger-protection fix + settings-window signal safety. */
const http = require("http");
const fs = require("fs");
const path = require("path");

const get = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });

let ws;
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
}
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function onMessage(e) {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const statePath = path.join(process.env.APPDATA, "dsh-desktop-pet", "pet-state.json");
  const logPath = path.join(process.env.APPDATA, "dsh-desktop-pet", "pet.log");
  const ledgerBefore = JSON.parse(fs.readFileSync(statePath, "utf8")).ledger;

  let targets = await get("http://127.0.0.1:9222/json/list");
  const pet = targets.find((t) => t.type === "page" && !t.url.includes("settings=1"));
  if (!pet) throw new Error("pet window target not found");
  await cdp(pet.webSocketDebuggerUrl);
  ws.onmessage = onMessage;

  // 1) pet renderer health
  const health = await send("Runtime.evaluate", {
    expression: `JSON.stringify({state: (window.__petState = (document.getElementById('stage')||{}).dataset?.state ?? 'no-stage'), petCore: !!window.PetCore, petAPI: !!window.petAPI})`,
    returnByValue: true,
  });
  console.log("PET:", health.result.value);

  // 2) open the settings window
  await send("Runtime.evaluate", { expression: "window.petAPI.openSettingsPanel()" });
  await sleep(1800);

  // 3) find the settings target
  targets = await get("http://127.0.0.1:9222/json/list");
  const settings = targets.find((t) => t.type === "page" && t.url.includes("settings=1"));
  if (!settings) throw new Error("settings window target not found");
  console.log("SETTINGS URL:", settings.url.slice(0, 60));

  // 4) settings renderer health + attempt to clobber the pet ledger from it
  const sWs = new WebSocket(settings.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sWs.onopen = res; sWs.onerror = rej; });
  let sId = 0;
  const sPending = new Map();
  const sSend = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sId;
      sPending.set(id, { resolve, reject });
      sWs.send(JSON.stringify({ id, method, params }));
    });
  sWs.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && sPending.has(m.id)) {
      const p = sPending.get(m.id);
      sPending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  const sHealth = await sSend("Runtime.evaluate", {
    expression: `JSON.stringify({settingsMode: !!document.body.dataset.settings, roles: document.getElementById('character-select').options.length, paths: (document.getElementById('paths-info')||{}).textContent})`,
    returnByValue: true,
  });
  console.log("SETTINGS:", sHealth.result.value);

  // malicious save from the settings window (the old code accepted this)
  await sSend("Runtime.evaluate", {
    expression: `window.petAPI.saveLedger({xp: 999, feeds: 99, plays: 99, activeMs: 999999, firstSeenAt: Date.now(), titles: []})`,
  });
  await sleep(1500);

  const after = JSON.parse(fs.readFileSync(statePath, "utf8")).ledger;
  console.log("LEDGER BEFORE:", JSON.stringify(ledgerBefore));
  console.log("LEDGER AFTER: ", JSON.stringify(after));
  const clobbered = after.xp === 999 || after.feeds === 99;
  console.log("A1 ledger protection:", clobbered ? "FAIL (clobbered!)" : "PASS");

  // 5) let a few heartbeats pass, then check for settings-window errors in the log
  await sleep(7000);
  const log = fs.readFileSync(logPath, "utf8");
  const tail = log.split("\n").filter(Boolean).slice(-12);
  console.log("--- LOG TAIL ---");
  console.log(tail.join("\n"));
  const settingsErrors = tail.filter((l) => l.includes("[settings:") && l.includes("Uncaught"));
  console.log("settings-window signal crash:", settingsErrors.length ? "FAIL" : "PASS (no errors)");
  sWs.close();
  ws.close();
})().catch((e) => {
  console.error("E2E ERR:", e.message);
  try { ws?.close(); } catch {}
  process.exit(1);
});
