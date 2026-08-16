/** Dev-only: downscale the maid-atelier composer frame (1800x588) to a size
 *  proportionate for the compact pet input card, and save it as a WebP next to
 *  the renderer. */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const GENERATED = "F:/AI_workspace/dsh-deep-whale-main/maid-atelier/src/client/chrome-art.generated.ts";
const OUT = path.join(__dirname, "..", "renderer", "maid-composer-frame.webp");
const SCALE = 0.18;

const src = fs.readFileSync(GENERATED, "utf8");
const m = src.match(/MAID_ATELIER_COMPOSER_FRAME\s*=\s*'(data:image\/webp;base64,[^']+)'/);
if (!m) { console.error("COMPOSER_FRAME art not found"); process.exit(1); }
const dataUrl = m[1];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 420, height: 660, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const W = Math.round(img.naturalWidth * ${SCALE});
          const H = Math.round(img.naturalHeight * ${SCALE});
          const c = document.createElement("canvas");
          c.width = W; c.height = H;
          const ctx = c.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, W, H);
          resolve({ dataUrl: c.toDataURL("image/webp", 0.92), W, H });
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error("image load failed"));
      img.src = ${JSON.stringify(dataUrl)};
      setTimeout(() => reject(new Error("decode timeout")), 15000);
    })
  `);
  const b64 = result.dataUrl.slice(result.dataUrl.indexOf(",") + 1);
  fs.writeFileSync(OUT, Buffer.from(b64, "base64"));
  console.log(`saved ${OUT} (${result.W}x${result.H}, ${fs.statSync(OUT).size} bytes)`);
  console.log(`slice = ${Math.round(170*SCALE)} ${Math.round(120*SCALE)} ${Math.round(115*SCALE)} ${Math.round(120*SCALE)}`);
  app.exit(0);
}).catch((e) => { console.error("ERR", e); app.exit(1); });
