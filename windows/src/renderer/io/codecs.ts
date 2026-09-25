// Reading and writing image files. Imports accept JPEG, PNG, HEIC and TIFF (as the Mac app does) plus WebP, BMP
// and GIF, recognised by their contents rather than their names; EXIF orientation is applied and colours are
// converted to sRGB by the browser's decoders. PNG and JPEG are written with the document's resolution.
import { encode as encodePng, decode as decodePng } from 'fast-png';

export type ImageFormat = 'png' | 'jpeg' | 'heic' | 'tiff' | 'webp' | 'bmp' | 'gif';

export class ImageImportError extends Error {}
export const UNREADABLE = 'The image could not be read. It may be damaged or unavailable.';
export const UNSUPPORTED = 'Choose a JPEG, PNG, HEIC, TIFF, WebP, BMP or GIF image.';
export const TOO_LARGE = 'This import exceeds the current 100-megapixel document budget or 30,000-pixel side limit.';

/** The format `bytes` hold, from their signature. */
export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  const ascii = (i: number, text: string) => [...text].every((ch, k) => bytes[i + k] === ch.charCodeAt(0));
  if (bytes.length < 12) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'tiff';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'BM')) return 'bmp';
  if (ascii(0, 'GIF8')) return 'gif';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.slice(8, 12)).replace('\0', ' ').trim();
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'heic';
  }
  return null;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA, rows top to bottom. */
  data: Uint8Array;
}

/** Decodes image file contents. `limit` caps width × height. */
export async function decodeImageBytes(bytes: Uint8Array, limit = 100_000_000): Promise<DecodedImage> {
  const format = sniffFormat(bytes);
  if (!format) throw new ImageImportError(UNSUPPORTED);
  let decoded: DecodedImage;
  try {
    const exact = format === 'png' ? tryDecodePNGExact(bytes) : null;
    if (exact) { checkSize(exact.width, exact.height, limit); decoded = exact; }
    else if (format === 'tiff') decoded = await decodeTIFF(bytes, limit);
    else if (format === 'heic') decoded = await decodeHEIC(bytes, limit);
    else decoded = await decodeWithBrowser(bytes, format, limit);
  } catch (error) {
    if (error instanceof ImageImportError) throw error;
    throw new ImageImportError(UNREADABLE);
  }
  return decoded;
}

function checkSize(width: number, height: number, limit: number): void {
  if (!(width > 0 && height > 0)) throw new ImageImportError(UNREADABLE);
  if (width > 30_000 || height > 30_000 || width * height > limit) throw new ImageImportError(TOO_LARGE);
}

const MIME: Record<ImageFormat, string> = {
  png: 'image/png', jpeg: 'image/jpeg', heic: 'image/heic', tiff: 'image/tiff', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
};

/** The browser's own decoders: orientation from EXIF, colours converted to sRGB. Read back in tiles so very large
 *  images never need one enormous canvas. */
async function decodeWithBrowser(bytes: Uint8Array, format: ImageFormat, limit: number): Promise<DecodedImage> {
  const blob = new Blob([bytes as BlobPart], { type: MIME[format] });
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  try {
    const width = bitmap.width, height = bitmap.height;
    checkSize(width, height, limit);
    const data = new Uint8Array(width * height * 4);
    const step = 4096;
    const canvas = new OffscreenCanvas(Math.min(step, width), Math.min(step, height));
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const w = Math.min(step, width - x), h = Math.min(step, height - y);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        const part = context.getImageData(0, 0, w, h).data;
        for (let row = 0; row < h; row++) data.set(part.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4);
      }
    }
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}

/** A PNG decoded exactly (no canvas round trip, which can shift translucent colours by a level), when it has no
 *  colour profile or palette (the common case); null to leave it to the browser. */
function tryDecodePNGExact(bytes: Uint8Array): DecodedImage | null {
  let png: ReturnType<typeof decodePng>;
  try { png = decodePng(bytes); } catch { return null; }
  if (png.iccEmbeddedProfile || png.palette) return null;
  const { width, height, channels, depth } = png;
  const source = png.data;
  const data = new Uint8Array(width * height * 4);
  const scale = depth === 16 ? 1 / 257 : depth === 8 ? 1 : 255 / ((1 << depth) - 1);
  if (depth < 8) return null;
  for (let i = 0; i < width * height; i++) {
    const v = (k: number) => Math.round(source[i * channels + k] * scale);
    if (channels === 1) { const g = v(0); data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g; data[i * 4 + 3] = 255; }
    else if (channels === 2) { const g = v(0); data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g; data[i * 4 + 3] = v(1); }
    else if (channels === 3) { data[i * 4] = v(0); data[i * 4 + 1] = v(1); data[i * 4 + 2] = v(2); data[i * 4 + 3] = 255; }
    else { data[i * 4] = v(0); data[i * 4 + 1] = v(1); data[i * 4 + 2] = v(2); data[i * 4 + 3] = v(3); }
  }
  return { width, height, data };
}

async function decodeTIFF(bytes: Uint8Array, limit: number): Promise<DecodedImage> {
  const UTIF = (await import('utif2')).default ?? (await import('utif2'));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ifds = UTIF.decode(buffer);
  const ifd = ifds.find((i: { width?: number }) => i) ?? ifds[0];
  if (!ifd) throw new ImageImportError(UNREADABLE);
  UTIF.decodeImage(buffer, ifd);
  const width = ifd.width as number, height = ifd.height as number;
  checkSize(width, height, limit);
  return { width, height, data: new Uint8Array(UTIF.toRGBA8(ifd)) };
}

async function decodeHEIC(bytes: Uint8Array, limit: number): Promise<DecodedImage> {
  const module = await import('heic-decode');
  const decode = (module.default ?? module) as (options: { buffer: Uint8Array }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  const image = await decode({ buffer: bytes });
  checkSize(image.width, image.height, limit);
  return { width: image.width, height: image.height, data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) };
}

// MARK: Writing

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG of straight RGBA (4 channels) or gray (1 channel) pixels, with a pHYs chunk giving `dpi`. */
export function encodePNG(data: Uint8Array, width: number, height: number, channels: 1 | 4, dpi = 72): Uint8Array {
  const png = encodePng({ width, height, data, channels, depth: 8 }, { zlib: { level: 6 } });
  if (!(dpi > 0)) return png;
  // Insert pHYs (pixels per metre) right after IHDR, which always ends at byte 33.
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, 33), 0);
  out.set(chunk, 33);
  out.set(png.subarray(33), 33 + chunk.length);
  return out;
}

/** JPEG of straight RGBA flattened onto `background` (0–1 RGB), at `quality` (0–1), with the JFIF density set to
 *  `dpi`. */
export async function encodeJPEG(data: Uint8Array, width: number, height: number, quality: number,
                                 background: [number, number, number], dpi = 72): Promise<Uint8Array> {
  const flat = new Uint8ClampedArray(width * height * 4);
  const bg = background.map((v) => v * 255);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let k = 0; k < 3; k++) flat[i * 4 + k] = Math.round(data[i * 4 + k] * a + bg[k] * (1 - a));
    flat[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(flat, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: Math.min(1, Math.max(0, quality)) });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return withJFIFDensity(bytes, dpi);
}

/** Sets the JFIF APP0 segment's density to `dpi` dots per inch (adding the segment if missing). */
export function withJFIFDensity(bytes: Uint8Array, dpi: number): Uint8Array {
  const density = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.slice(6, 10)) === 'JFIF') {
    const out = bytes.slice();
    out[13] = 1;
    out[14] = density >> 8; out[15] = density & 0xff;
    out[16] = density >> 8; out[17] = density & 0xff;
    return out;
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 1,
    density >> 8, density & 0xff, density >> 8, density & 0xff, 0, 0]);
  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(bytes.subarray(2), 2 + app0.length);
  return out;
}

/** A small JPEG preview decoded back from encoded bytes (for the export dialog's size preview). */
export async function previewOf(bytes: Uint8Array, type: string, limit = 1000): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
  const factor = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
  if (factor >= 1) return bitmap;
  const scaled = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * factor), resizeHeight: Math.round(bitmap.height * factor), resizeQuality: 'high' });
  bitmap.close();
  return scaled;
}

/** Decodes a PNG exactly (masks and layer images in projects): gray stays one channel. */
export function decodeProjectPNG(bytes: Uint8Array): { width: number; height: number; channels: number; data: Uint8Array; depth: number; palette: boolean; profile: boolean } {
  const png = decodePng(bytes);
  const data = png.depth === 8 ? new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) : new Uint8Array(0);
  return { width: png.width, height: png.height, channels: png.channels, data, depth: png.depth, palette: !!png.palette, profile: !!png.iccEmbeddedProfile };
}
