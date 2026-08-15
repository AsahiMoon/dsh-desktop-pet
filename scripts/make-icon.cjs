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
function icoFromPng(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256px (0 means 256)
  entry[1] = 0;
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
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
const pngBuf = writePngRgba(cell, cell, rgba);
const icoBuf = icoFromPng(pngBuf);
const outDir = path.join(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });
const icoPath = path.join(outDir, "icon.ico");
fs.writeFileSync(icoPath, icoBuf);
console.log("wrote", icoPath, icoBuf.length, "bytes");

// ---------- cross-platform icons ----------
// nearest-neighbor downscale of the RGBA frame
function downscale(rgba, from, to) {
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) {
    const sy = Math.min(from - 1, Math.floor((y * from) / to));
    for (let x = 0; x < to; x++) {
      const sx = Math.min(from - 1, Math.floor((x * from) / to));
      rgba.copy(out, (y * to + x) * 4, (sy * from + sx) * 4, (sy * from + sx) * 4 + 4);
    }
  }
  return out;
}
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
  { type: "ic08", png: writePngRgba(cell, cell, rgba) }, // 256
  { type: "ic07", png: writePngRgba(cell / 2, cell / 2, downscale(rgba, cell, cell / 2)) }, // 128
]);
fs.writeFileSync(path.join(outDir, "icon.icns"), icns);
console.log("wrote", path.join(outDir, "icon.icns"), icns.length, "bytes");

// Linux icon set (electron-builder reads build/icons/)
const iconsDir = path.join(outDir, "icons");
fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256]) {
  const px = downscale(rgba, cell, size);
  fs.writeFileSync(path.join(iconsDir, `${size}x${size}.png`), writePngRgba(size, size, px));
}
console.log("wrote linux icons to", iconsDir);
