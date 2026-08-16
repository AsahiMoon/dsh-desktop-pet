// make-icon.cjs — crop whale-girl idle frame 0 (256x256) from idle.png and
// build build/icon.ico (PNG-compressed ICO, supported by Vista+ and
// electron-builder). Handles truecolor RGB / RGBA PNGs.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---------- minimal PNG reader ----------
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let pos = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (interlace !== 0) throw new Error("interlaced png not supported");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error("unsupported colortype " + colorType);
  const bpp = (bitDepth / 8) * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 1: v += a; break; // Sub
        case 2: v += b; break; // Up
        case 3: v += (a + b) >> 1; break; // Average
        case 4: { // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, bitDepth, pixels: out, stride };
}

// ---------- minimal PNG writer (RGBA) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePngRgba(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- ICO ----------
/** Multi-size PNG-compressed ICO (Vista+ supports PNG entries at any size).
 *  Sizes list uses 0 to encode 256, per the ICO spec. */
function icoFromPngs(sizes, pngForSize) {
  const entries = sizes.map((size) => ({ size, png: pngForSize(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const parts = [header];
  let offset = 6 + entries.length * 16;
  for (const e of entries) {
    const entry = Buffer.alloc(16);
    const s = e.size === 256 ? 0 : e.size;
    entry[0] = s; // width (0 = 256)
    entry[1] = s; // height
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(e.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    parts.push(entry);
    offset += e.png.length;
  }
  for (const e of entries) parts.push(e.png);
  return Buffer.concat(parts);
}

// ---------- main ----------
const idlePath = path.join(__dirname, "..", "assets", "characters", "whale-girl", "idle.png");
const { width, height, channels, pixels, stride } = readPng(fs.readFileSync(idlePath));
const frame = Math.floor(width / height); // frames per row (256px cells)
const cell = height; // assume square cells
console.log(`idle.png ${width}x${height} channels=${channels} frames=${frame}`);
const rgba = Buffer.alloc(cell * cell * 4);
for (let y = 0; y < cell; y++) {
  for (let x = 0; x < cell; x++) {
    const src = y * stride + x * channels;
    const dst = (y * cell + x) * 4;
    rgba[dst] = channels >= 3 ? pixels[src] : pixels[src];
    rgba[dst + 1] = channels >= 3 ? pixels[src + 1] : pixels[src];
    rgba[dst + 2] = channels >= 3 ? pixels[src + 2] : pixels[src];
    rgba[dst + 3] = channels === 4 ? pixels[src + 3] : 255;
  }
}
const outDir = path.join(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });

// Alpha-aware content crop: the idle frame has transparent margins around the
// character; cropping them makes every icon size show the whale-girl larger
// and crisper instead of a small figure floating in a sea of transparency.
function contentBbox(rgba, size) {
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: size, h: size };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
const bbox = contentBbox(rgba, cell);
const cw = bbox.w, ch = bbox.h;
console.log(`content bbox: x${bbox.x}+${cw} y${bbox.y}+${ch}`);

// Crop the RGBA buffer to the content box.
function cropRgba(rgba, size, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    rgba.copy(out, y * box.w * 4, ((box.y + y) * size + box.x) * 4, ((box.y + y) * size + box.x + box.w) * 4);
  }
  return out;
}
const content = cropRgba(rgba, cell, bbox);

/** Bilinear downscale (RGBA), clearer than nearest-neighbor for icons. */
function bilinear(rgba, w, h, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const sx = (w - 1) / (tw - 1 || 1);
  const sy = (h - 1) / (th - 1 || 1);
  for (let y = 0; y < th; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * tw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = rgba[(y0 * w + x0) * 4 + c];
        const p10 = rgba[(y0 * w + x1) * 4 + c];
        const p01 = rgba[(y1 * w + x0) * 4 + c];
        const p11 = rgba[(y1 * w + x1) * 4 + c];
        const top = p00 + (p10 - p00) * wx;
        const bot = p01 + (p11 - p01) * wx;
        out[o + c] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return out;
}

/** Fit the cropped content into a square canvas of `size`, centered with a
 *  small transparent margin so tiny icons read as a glyph, not a blob. The
 *  margin shrinks for very small sizes (a 16px tray icon has little room to
 *  spare) and grows slightly for large ones (premium look). */
function fitTo(rgba, cw, ch, size) {
  const margin = size <= 24 ? 0.06 : size <= 48 ? 0.08 : 0.1;
  const inner = Math.round(size * (1 - margin * 2)); // content box inside canvas
  const scale = inner / Math.max(cw, ch);
  const tw = Math.max(1, Math.round(cw * scale));
  const th = Math.max(1, Math.round(ch * scale));
  const scaled = bilinear(rgba, cw, ch, tw, th);
  const out = Buffer.alloc(size * size * 4); // transparent
  const ox = Math.floor((size - tw) / 2);
  const oy = Math.floor((size - th) / 2);
  for (let y = 0; y < th; y++) {
    scaled.copy(out, ((oy + y) * size + ox) * 4, y * tw * 4, (y + 1) * tw * 4);
  }
  return out;
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const icoBuf = icoFromPngs(ICO_SIZES, (size) => writePngRgba(size, size, fitTo(content, cw, ch, size)));
const icoPath = path.join(outDir, "icon.ico");
fs.writeFileSync(icoPath, icoBuf);
console.log("wrote", icoPath, icoBuf.length, "bytes", `(${ICO_SIZES.join("/")})`);

// ---------- cross-platform icons ----------
function icnsFromPngs(entries) {
  // entries: [{ type: 'ic07'|'ic08'|'ic09'|'ic10', png: Buffer }]
  let body = Buffer.alloc(0);
  for (const e of entries) {
    const head = Buffer.alloc(8);
    head.write(e.type, 0, "ascii");
    head.writeUInt32BE(8 + e.png.length, 4);
    body = Buffer.concat([body, head, e.png]);
  }
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

const icns = icnsFromPngs([
  { type: "ic10", png: writePngRgba(512, 512, fitTo(content, cw, ch, 512)) }, // 512@2x
  { type: "ic09", png: writePngRgba(256, 256, fitTo(content, cw, ch, 256)) }, // 256@1x
  { type: "ic08", png: writePngRgba(128, 128, fitTo(content, cw, ch, 128)) }, // 128
  { type: "ic07", png: writePngRgba(64, 64, fitTo(content, cw, ch, 64)) }, // 64
]);
fs.writeFileSync(path.join(outDir, "icon.icns"), icns);
console.log("wrote", path.join(outDir, "icon.icns"), icns.length, "bytes");

// Linux icon set (electron-builder reads build/icons/)
const iconsDir = path.join(outDir, "icons");
fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256]) {
  const px = fitTo(content, cw, ch, size);
  fs.writeFileSync(path.join(iconsDir, `${size}x${size}.png`), writePngRgba(size, size, px));
}
console.log("wrote linux icons to", iconsDir);
