// smoke-nap2.cjs — full nap cycle WITHOUT agent exec interference:
// post celebrate, sample 40s, expect celebrate -> sleep (~25s) -> idle.
// NOTE: must run as a background job and NO other tool may run meanwhile.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const target = list.find((t) => t.type === "page" && t.url.includes("index.html"));
  if (!target) throw new Error("no pet page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const q = (expr) =>
    new Promise((res) => {
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) res(m.result?.result?.value);
      };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
    });

  await fetch("http://127.0.0.1:43991/signal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "celebrate", label: "完整打盹测试" }),
  });
  const seq = [];
  for (let i = 0; i < 22; i++) {
    await sleep(2000);
    const st = await q("stage.dataset.state");
    const bub = await q("document.getElementById('bubble').textContent");
    seq.push(`${st}${bub ? "(" + bub.slice(0, 8) + ")" : ""}`);
  }
  console.log(seq.join(" "));
  const napAt = seq.findIndex((s) => s.startsWith("sleep"));
  const idleAfter = seq.slice(napAt).some((s) => s.startsWith("idle"));
  const napLen = seq.filter((s) => s.startsWith("sleep")).length;
  console.log(`nap starts at sample ${napAt + 1}, sleep samples: ${napLen} (>=5 => >=10s), returns to idle: ${idleAfter}`);
  console.log(napAt >= 0 && idleAfter && napLen >= 5 ? "FULL NAP CYCLE PASS" : "FULL NAP CYCLE FAIL");
  ws.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
