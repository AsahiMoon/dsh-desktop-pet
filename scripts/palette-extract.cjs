/** One-off palette extractor: decode a PNG (zlib built-in) and print the
 *  dominant opaque colors. Used to theme the chat panel after whale-girl. */
const zlib = require("zlib");
const fs = require("fs");

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      cur[i] = v;
    }
    for (let i = 0; i < w; i++) {
      const o = i * 4;
      if (colorType === 6) {
        out[(y * w + i) * 4] = cur[o];
        out[(y * w + i) * 4 + 1] = cur[o + 1];
        out[(y * w + i) * 4 + 2] = cur[o + 2];
        out[(y * w + i) * 4 + 3] = cur[o + 3];
      } else if (colorType === 2) {
        out[(y * w + i) * 4] = cur[o];
        out[(y * w + i) * 4 + 1] = cur[o + 1];
        out[(y * w + i) * 4 + 2] = cur[o + 2];
        out[(y * w + i) * 4 + 3] = 255;
      } else if (colorType === 3) {
        const idx = cur[o];
        out[(y * w + i) * 4] = palette[idx * 3];
        out[(y * w + i) * 4 + 1] = palette[idx * 3 + 1];
        out[(y * w + i) * 4 + 2] = palette[idx * 3 + 2];
        out[(y * w + i) * 4 + 3] = 255;
      }
    }
    prev = cur;
  }
  return { w, h, pixels: out };
}

/** Quantize opaque pixels and report dominant colors (rounded to 8). */
function dominantColors(png, topN = 12, alphaMin = 200, step = 2) {
  const counts = new Map();
  const { pixels, w, h } = png;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const a = pixels[i + 3];
      if (a < alphaMin) continue;
      const r = Math.round(pixels[i] / 8) * 8;
      const g = Math.round(pixels[i + 1] / 8) * 8;
      const b = Math.round(pixels[i + 2] / 8) * 8;
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, n]) => {
      const r = (key >> 16) & 0xff, g = (key >> 8) & 0xff, b = key & 0xff;
      return { hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`, rgb: [r, g, b], count: n };
    });
}

for (const file of process.argv.slice(2)) {
  try {
    const png = decodePNG(fs.readFileSync(file));
    const colors = dominantColors(png);
    console.log(`\n== ${file} (${png.w}x${png.h}) ==`);
    for (const c of colors) console.log(`  ${c.hex}  rgb(${c.rgb.join(",")})  ${c.count}`);
  } catch (e) {
    console.log(`\n== ${file} == ERROR: ${e.message}`);
  }
}
