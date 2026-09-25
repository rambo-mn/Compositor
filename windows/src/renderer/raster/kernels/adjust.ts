// Whole-image color kernels on premultiplied RGBA (4 bytes per pixel, rows packed). Ports of LevelsPixels.c,
// AdjustPixels.c, NoisePixels.c and LensPixels.c, plus invert (PixelInvert.swift) and the Hue/Saturation color cube
// (CIColorCube's trilinear lookup). Integer hashing uses Math.imul / >>> 0 to match the C code's uint32 arithmetic.

/** Applies per-channel tables (768 floats, 0–1 output per input byte) to colors, interpolating between entries at
 *  the unpremultiplied value. Alpha is kept; transparent pixels are left alone. (levels_apply) */
export function levelsApply(pixels: Uint8Array, count: number, tables: Float32Array): void {
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const alpha = pixels[p + 3];
    if (!alpha) continue;
    for (let channel = 0; channel < 3; channel++) {
      const x = Math.min(255, pixels[p + channel] * 255 / alpha);
      const lo = x | 0, hi = lo < 255 ? lo + 1 : 255;
      const t = channel * 256;
      const result = tables[t + lo] + (tables[t + hi] - tables[t + lo]) * (x - lo);
      pixels[p + channel] = Math.min(alpha, Math.max(0, Math.round(result * alpha)));
    }
  }
}

/** Alpha- (and selection-) weighted histograms: bins[0…255] RGB mean, then red, green, blue. (levels_histogram) */
export function levelsHistogram(pixels: Uint8Array, coverage: Uint8Array | null, count: number, bins: Float64Array): void {
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const a = pixels[p + 3];
    if (!a) continue;
    const weight = a / 255 * (coverage ? coverage[i] / 255 : 1);
    for (let channel = 0; channel < 3; channel++) {
      const value = Math.min(255, Math.round(pixels[p + channel] * 255 / a));
      bins[(channel + 1) * 256 + value] += weight;
      bins[value] += weight / 3;
    }
  }
}

/** Gradient Map: each pixel's luminance picks a color from `table` (256 × 3 straight bytes). (adjust_gradient_map) */
export function gradientMapApply(pixels: Uint8Array, width: number, height: number, table: Uint8Array): void {
  const count = width * height;
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const a = pixels[p + 3];
    if (a === 0) continue;
    let r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    if (a < 255) {
      r = Math.min(255, ((r * 255 + (a >> 1)) / a) >>> 0);
      g = Math.min(255, ((g * 255 + (a >> 1)) / a) >>> 0);
      b = Math.min(255, ((b * 255 + (a >> 1)) / a) >>> 0);
    }
    const level = Math.min(255, ((2126 * r + 7152 * g + 722 * b + 5000) / 10000) >>> 0);
    const c = level * 3;
    pixels[p] = ((table[c] * a + 127) / 255) >>> 0;
    pixels[p + 1] = ((table[c + 1] * a + 127) / 255) >>> 0;
    pixels[p + 2] = ((table[c + 2] * a + 127) / 255) >>> 0;
  }
}

export function mix32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/** A value in −1…1 for an integer lattice point, fixed by the point and the seed. */
function lattice(ix: number, iy: number, seed: number): number {
  const h = mix32((Math.imul(ix >>> 0, 0x9E3779B1) ^ mix32((Math.imul(iy >>> 0, 0x85EBCA77) ^ seed) >>> 0)) >>> 0);
  return Math.fround(Math.fround((h & 0xffff) / 65535) + Math.fround((h >>> 16) / 65535) - 1);
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Film grain fixed in document space. (adjust_grain) */
export function grainApply(pixels: Uint8Array, width: number, height: number, amount: number, size: number,
                           roughness: number, seed: number, originX: number, originY: number, unitsPerPixel: number): void {
  if (!(amount > 0) || !(unitsPerPixel > 0)) return;
  if (!(size > 0)) size = 1;
  seed = seed >>> 0;
  const strength = Math.fround((amount > 100 ? 1 : amount / 100) * 0.35 * 255);
  const rough = roughness < 0 ? 0 : roughness > 100 ? 1 : roughness / 100;
  const fineSeed = mix32((seed ^ 0xA511E9B3) >>> 0);
  for (let y = 0; y < height; y++) {
    const v = originY + (y + 0.5) * unitsPerPixel;
    const cellY = Math.floor(v / size);
    let ty = v / size - cellY;
    ty = ty * ty * (3 - 2 * ty);
    const iy = cellY, fineY = Math.floor(v);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const a = pixels[p + 3];
      if (a === 0) continue;
      const u = originX + (x + 0.5) * unitsPerPixel;
      const cellX = Math.floor(u / size);
      let tx = u / size - cellX;
      tx = tx * tx * (3 - 2 * tx);
      const ix = cellX;
      const n00 = lattice(ix, iy, seed), n10 = lattice(ix + 1, iy, seed);
      const n01 = lattice(ix, iy + 1, seed), n11 = lattice(ix + 1, iy + 1, seed);
      const top = n00 + (n10 - n00) * tx, bottom = n01 + (n11 - n01) * tx;
      const smooth = (top + (bottom - top) * ty) * 1.6;
      const fine = lattice(Math.floor(u), fineY, fineSeed);
      const noise = smooth + (fine - smooth) * rough;
      const unpremultiply = a === 255 ? 1 : 255 / a;
      const r = pixels[p] * unpremultiply, g = pixels[p + 1] * unpremultiply, b = pixels[p + 2] * unpremultiply;
      let level = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (level > 1) level = 1;
      const delta = noise * strength * (0.4 + 2.4 * level * (1 - level));
      const coverage = a / 255;
      pixels[p] = (clamp255(r + delta) * coverage + 0.5) | 0;
      pixels[p + 1] = (clamp255(g + delta) * coverage + 0.5) | 0;
      pixels[p + 2] = (clamp255(b + delta) * coverage + 0.5) | 0;
    }
  }
}

/** Premultiplied invert: color becomes alpha − color, so transparency is kept. */
export function invertRGBA(pixels: Uint8Array): void {
  for (let p = 0; p < pixels.length; p += 4) {
    const a = pixels[p + 3];
    pixels[p] = a - Math.min(a, pixels[p]);
    pixels[p + 1] = a - Math.min(a, pixels[p + 1]);
    pixels[p + 2] = a - Math.min(a, pixels[p + 2]);
  }
}

export function invertGray(pixels: Uint8Array): void {
  for (let i = 0; i < pixels.length; i++) pixels[i] = 255 - pixels[i];
}

/** Hue/Saturation through its color cube (red fastest), trilinear, on unpremultiplied color. */
export function colorCubeApply(pixels: Uint8Array, cube: Float32Array, dimension: number): void {
  const n = dimension, step = n - 1;
  for (let p = 0; p < pixels.length; p += 4) {
    const a = pixels[p + 3];
    if (a === 0) continue;
    const inv = 1 / a;
    const r = Math.min(1, pixels[p] * inv) * step, g = Math.min(1, pixels[p + 1] * inv) * step, b = Math.min(1, pixels[p + 2] * inv) * step;
    const r0 = Math.min(step - 1, r | 0), g0 = Math.min(step - 1, g | 0), b0 = Math.min(step - 1, b | 0);
    const fr = r - r0, fg = g - g0, fb = b - b0;
    const base = ((b0 * n + g0) * n + r0) * 3;
    const dr = 3, dg = n * 3, db = n * n * 3;
    for (let k = 0; k < 3; k++) {
      const c000 = cube[base + k], c100 = cube[base + dr + k], c010 = cube[base + dg + k], c110 = cube[base + dg + dr + k];
      const c001 = cube[base + db + k], c101 = cube[base + db + dr + k], c011 = cube[base + db + dg + k], c111 = cube[base + db + dg + dr + k];
      const c00 = c000 + (c100 - c000) * fr, c10 = c010 + (c110 - c010) * fr;
      const c01 = c001 + (c101 - c001) * fr, c11 = c011 + (c111 - c011) * fr;
      const c0 = c00 + (c10 - c00) * fg, c1 = c01 + (c11 - c01) * fg;
      const value = c0 + (c1 - c0) * fb;
      pixels[p + k] = Math.min(a, Math.max(0, Math.round(value * a)));
    }
  }
}

/** coverage × adjusted + (1 − coverage) × original, per byte (CIBlendWithMask). `channels` is 4 or 1. */
export function blendThroughCoverage(adjusted: Uint8Array, original: Uint8Array, coverage: Uint8Array, channels: number): Uint8Array {
  const out = new Uint8Array(adjusted.length);
  const count = coverage.length;
  for (let i = 0; i < count; i++) {
    const c = coverage[i];
    const o = i * channels;
    if (c === 255) { for (let k = 0; k < channels; k++) out[o + k] = adjusted[o + k]; continue; }
    if (c === 0) { for (let k = 0; k < channels; k++) out[o + k] = original[o + k]; continue; }
    const t = c / 255;
    for (let k = 0; k < channels; k++) out[o + k] = Math.round(original[o + k] + (adjusted[o + k] - original[o + k]) * t);
  }
  return out;
}

// MARK: Noise (noise_add)

function noiseUnit(key: number): number { return (mix32(key >>> 0) >>> 8) * (1 / 16777216); }

export function noiseAdd(pixels: Uint8Array, width: number, height: number, amount: number, gaussian: boolean,
                         monochromatic: boolean, seed: number): void {
  const spread = amount / 100 * 127.5;
  seed = seed >>> 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const alpha = pixels[p + 3];
      if (!alpha) continue;
      const base = mix32((seed ^ mix32(((y * width + x) >>> 0))) >>> 0);
      for (let c = 0; c < 3; c++) {
        const key = monochromatic ? base : (base + Math.imul(c, 0x9e3779b9)) >>> 0;
        let n: number;
        if (gaussian) {
          const u1 = noiseUnit(key), u2 = noiseUnit((key ^ 0x68e31da4) >>> 0);
          n = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(6.2831853 * u2) * spread * (2 / 3);
        } else {
          n = (noiseUnit(key) * 2 - 1) * spread;
        }
        let value = pixels[p + c] * 255 / alpha + n;
        value = value < 0 ? 0 : value > 255 ? 255 : value;
        pixels[p + c] = Math.round(value * alpha / 255);
      }
    }
  }
}

// MARK: Lens (lens_distort)

export function lensDistort(source: Uint8Array, width: number, height: number, k: number): Uint8Array {
  const destination = new Uint8Array(source.length);
  const cx = width * 0.5, cy = height * 0.5;
  const halfDiagonal2 = cx * cx + cy * cy;
  const sums = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const scale = 1 - k * (dx * dx + dy * dy) / halfDiagonal2;
      const sx = cx + dx * scale - 0.5, sy = cy + dy * scale - 0.5;
      const fx0 = Math.floor(sx), fy0 = Math.floor(sy);
      const fx = sx - fx0, fy = sy - fy0;
      sums[0] = sums[1] = sums[2] = sums[3] = 0;
      for (let j = 0; j < 2; j++) {
        const row = fy0 + j;
        if (row < 0 || row >= height) continue;
        const wy = j ? fy : 1 - fy;
        if (wy === 0) continue;
        for (let i = 0; i < 2; i++) {
          const column = fx0 + i;
          if (column < 0 || column >= width) continue;
          const weight = wy * (i ? fx : 1 - fx);
          if (weight === 0) continue;
          const p = (row * width + column) * 4;
          sums[0] += weight * source[p]; sums[1] += weight * source[p + 1];
          sums[2] += weight * source[p + 2]; sums[3] += weight * source[p + 3];
        }
      }
      const o = (y * width + x) * 4;
      destination[o] = Math.round(sums[0]); destination[o + 1] = Math.round(sums[1]);
      destination[o + 2] = Math.round(sums[2]); destination[o + 3] = Math.round(sums[3]);
    }
  }
  return destination;
}

/** Clamps each color to its alpha after a resampling filter that rings. (rgba_clamp_premultiplied) */
export function clampPremultiplied(pixels: Uint8Array): void {
  for (let p = 0; p < pixels.length; p += 4) {
    const a = pixels[p + 3];
    if (pixels[p] > a) pixels[p] = a;
    if (pixels[p + 1] > a) pixels[p + 1] = a;
    if (pixels[p + 2] > a) pixels[p + 2] = a;
  }
}

/** Base alpha pulled out, colors made opaque (unpremultiplied), for clipping stacks. (layer_extract_alpha & co.) */
export function extractAlpha(rgba: Uint8Array, count: number): Uint8Array {
  const alpha = new Uint8Array(count);
  for (let i = 0; i < count; i++) alpha[i] = rgba[i * 4 + 3];
  return alpha;
}
export function unpremultiplyOpaque(rgba: Uint8Array): void {
  for (let p = 0; p < rgba.length; p += 4) {
    const a = rgba[p + 3];
    for (let c = 0; c < 3; c++) {
      const v = a ? ((rgba[p + c] * 255 + (a >> 1)) / a) >>> 0 : 0;
      rgba[p + c] = v > 255 ? 255 : v;
    }
    rgba[p + 3] = 255;
  }
}
export function restoreAlpha(rgba: Uint8Array, alpha: Uint8Array): void {
  for (let i = 0; i < alpha.length; i++) {
    const p = i * 4, a = alpha[i];
    for (let c = 0; c < 3; c++) rgba[p + c] = ((rgba[p + c] * a + 127) / 255) >>> 0;
    rgba[p + 3] = a;
  }
}
