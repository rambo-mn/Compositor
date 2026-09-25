// Builds build/icon.ico (the app's and the installer's icon) from the Mac app's icon artwork, with the sizes Windows
// uses: 16, 24, 32, 48, 64, 128 and 256 pixels. Sizes the Mac set lacks are area-averaged from the next larger one.
// Usage: node scripts/make-icons.mjs
import { decode, encode } from 'fast-png';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, '..', 'Compositor', 'Assets.xcassets', 'AppIcon.appiconset');
const available = [16, 32, 64, 128, 256, 512, 1024];
const wanted = [16, 24, 32, 48, 64, 128, 256];

async function load(size) {
  const png = decode(await readFile(path.join(source, `app-icon-${size}.png`)));
  const rgba = new Uint8Array(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) {
    for (let c = 0; c < 4; c++) rgba[i * 4 + c] = c < png.channels ? png.data[i * png.channels + c] : 255;
  }
  return { width: png.width, height: png.height, data: rgba };
}

/** Area-averaged reduction, weighting colour by alpha so transparent edges don't darken. */
function reduce(image, size) {
  const out = new Uint8Array(size * size * 4);
  const scale = image.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * scale); sy < Math.floor((y + 1) * scale); sy++) {
        for (let sx = Math.floor(x * scale); sx < Math.floor((x + 1) * scale); sx++) {
          const i = (sy * image.width + sx) * 4, alpha = image.data[i + 3];
          r += image.data[i] * alpha; g += image.data[i + 1] * alpha; b += image.data[i + 2] * alpha; a += alpha; n++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: size, height: size, data: out };
}

const entries = [];
for (const size of wanted) {
  let image;
  if (available.includes(size)) image = await load(size);
  else image = reduce(await load(available.find((s) => s > size && s % size === 0) ?? 1024), size);
  entries.push({ size, png: encode({ width: size, height: size, data: image.data, channels: 4, depth: 8 }) });
}

// ICO: a 6-byte header, a 16-byte directory entry per image, then the PNGs.
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((entry, index) => {
  const at = 6 + index * 16;
  header.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
  header.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(entry.png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += entry.png.length;
});
await mkdir(path.join(root, 'build'), { recursive: true });
await writeFile(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, ...entries.map((e) => Buffer.from(e.png))]));
await writeFile(path.join(root, 'build', 'icon.png'), await readFile(path.join(source, 'app-icon-512.png')));
console.log(`build/icon.ico: ${entries.map((e) => e.size).join(', ')} px`);
