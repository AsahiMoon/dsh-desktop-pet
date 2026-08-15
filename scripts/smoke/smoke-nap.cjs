/**
 * smoke-nap.cjs — verify the post-work DSH linkage:
 *  1. POST celebrate -> pet celebrates, then naps (sleep state ~25s), then idle
 *  2. POST celebrate again -> during the nap, POST sync exec=true -> wakes to working
 * Run as a BACKGROUND job so the agent's own exec heartbeats don't interfere.
 */
const pid = parseInt(process.argv[2], 10);
if (!pid) {
  console.error("usage: node smoke-nap.cjs <petPid>");
  process.exit(2);
}
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

async function postSignal(signal) {
  const res = await fetch("http://127.0.0.1:43991/signal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signal),
  });
  return res.status;
}

async function sampleStates(label, seconds) {
  const seq = [];
  for (let i = 0; i < seconds / 2; i++) {
    const st = await cdpEval("stage.dataset.state");
    const bub = await cdpEval("document.getElementById('bubble').textContent");
    seq.push(`${st}${bub ? "(" + bub.slice(0, 10) + ")" : ""}`);
    await sleep(2000);
  }
  console.log(label, "->", seq.join(" "));
  return seq;
}

(async () => {
  // wait for the agent's own exec heartbeats to stop (pet back to idle)
  await sleep(6000);
  console.log("initial state:", await cdpEval("stage.dataset.state"));

  // --- 1. celebrate -> nap -> idle ---
  console.log("POST celebrate...");
  console.log("signal status:", await postSignal({ type: "celebrate", label: "测试任务完成" }));
  await sleep(1000);
  const seq1 = await sampleStates("after celebrate", 40);
  const napSeen = seq1.some((s) => s.startsWith("sleep"));
  const idleSeen = seq1.slice(-2).every((s) => s.startsWith("idle"));
  console.log(napSeen && idleSeen ? "NAP CYCLE PASS" : "NAP CYCLE FAIL");

  // --- 2. new task (exec) interrupts the nap ---
  console.log("POST celebrate #2...");
  await postSignal({ type: "celebrate", label: "再来一个" });
  await sleep(6000); // should now be in the nap
  console.log("state before exec:", await cdpEval("stage.dataset.state"));
  console.log("POST sync exec=true...");
  await postSignal({ type: "sync", exec: true, think: false, wait: false, todos: [] });
  await sleep(3000);
  const st = await cdpEval("stage.dataset.state");
  console.log("state after exec:", st);
  console.log(st === "working" || st === "think" ? "EXEC WAKE PASS" : "EXEC WAKE FAIL");
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
