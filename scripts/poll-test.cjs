const http = require("http");
const POLL_HOLD_MS = 2000;
const queue = [];
let pendingPoll = null;

function enqueue(cmd) { queue.push(cmd); if (pendingPoll) { const { res } = pendingPoll; pendingPoll = null; deliver(res); } }
function deliver(res) {
  const cmd = queue.shift();
  if (cmd !== undefined) { res.writeHead(200); res.end(JSON.stringify(cmd)); return; }
  if (pendingPoll) { const old = pendingPoll; pendingPoll = null; clearTimeout(old.timer); try { old.res.writeHead(200); old.res.end(JSON.stringify({empty:true})); } catch {} }
  pendingPoll = { res };
  const timer = setTimeout(() => { if (pendingPoll?.res === res) { pendingPoll = null; res.writeHead(200); res.end(JSON.stringify({empty:true})); } }, POLL_HOLD_MS);
  pendingPoll.timer = timer;
  res.on("close", () => { clearTimeout(timer); if (pendingPoll?.res === res) pendingPoll = null; });
}

const server = http.createServer((req, res) => deliver(res));
server.listen(43999, "127.0.0.1", async () => {
  const poll = () => new Promise((resolve, reject) => {
    const r = http.get("http://127.0.0.1:43999", (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    r.on("error", reject); r.setTimeout(10000, () => reject(new Error("client timeout")));
  });
  // A parks
  const a = poll();
  await new Promise(r => setTimeout(r, 100));
  // B arrives -> A must get {empty:true}, B parks
  const b = poll();
  const aRes = await a;
  console.log("A got (should be empty):", aRes);
  await new Promise(r => setTimeout(r, 100));
  // enqueue a command -> B must get it
  enqueue({ cmd: "select-session", sessionId: "s1" });
  const bRes = await b;
  console.log("B got (should be the command):", bRes);
  // park again, wait for hold -> empty
  const c = poll();
  const cRes = await c;
  console.log("C got (should be empty after hold):", cRes);
  server.close();
  process.exit(0);
});
