// Spot healing, in place, over premultiplied RGBA. A port of HealPixels.c:
//   mode 0, Content-Aware: copies texture from the nearby patch whose surrounding ring best matches the spot's ring;
//   mode 1, Create Texture: fills smoothly from the spot's edges and adds grain matching the detail around it;
//   mode 2, Proximity Match: like 0, but takes the closest good patch.
// Copied texture is blended so it meets the surrounding tone exactly: the edge difference is spread across the
// spot (a membrane fill). The result replaces the original by coverage × opacity.
import { mix32 } from './adjust';

const OUTSIDE = 0, RING = 1, HOLE = 2;

/** Half-open bounds of nonzero bytes; null when empty. */
export function coverageBounds(gray: Uint8Array, width: number, height: number): [number, number, number, number] | null {
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!gray[row + x]) continue;
      if (x < x0) x0 = x;
      if (x + 1 > x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y + 1 > y1) y1 = y + 1;
    }
  }
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

/** C's lround: halves away from zero. */
const lround = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
const healUnit = (key: number) => (mix32(key >>> 0) >>> 8) / 16777216;

function score(rgba: Uint8Array, stride: number, role: Uint8Array, wx0: number, wy0: number, ww: number, wh: number,
               dx: number, dy: number, W: number, H: number): number {
  if (Math.abs(dx) < ww && Math.abs(dy) < wh) return Infinity;
  if (wx0 + dx < 0 || wy0 + dy < 0 || wx0 + ww + dx > W || wy0 + wh + dy > H) return Infinity;
  let sum = 0, n = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      if (role[y * ww + x] !== RING) continue;
      const t = (wy0 + y) * stride + (wx0 + x) * 4;
      const s = (wy0 + y + dy) * stride + (wx0 + x + dx) * 4;
      for (let c = 0; c < 4; c++) { const d = rgba[t + c] - rgba[s + c]; sum += d * d; }
      n++;
    }
  }
  return n ? sum / n : Infinity;
}

/** Smooth values over HOLE pixels, fixed to the RING values around them; coarse-to-fine so big spots settle fast. */
function solve(value: Float32Array, role: Uint8Array, w: number, h: number, depth: number): void {
  let iterations = 300;
  if (w > 32 && h > 32 && depth < 16) {
    const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    const coarse = new Float32Array(cw * ch * 4);
    const coarseRole = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let known = 0, hole = 0;
        const knownSum = [0, 0, 0, 0], holeSum = [0, 0, 0, 0];
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const fx = x * 2 + i, fy = y * 2 + j;
            if (fx >= w || fy >= h) continue;
            const p = fy * w + fx;
            if (role[p] === RING) { known++; for (let c = 0; c < 4; c++) knownSum[c] += value[p * 4 + c]; }
            else if (role[p] === HOLE) { hole++; for (let c = 0; c < 4; c++) holeSum[c] += value[p * 4 + c]; }
          }
        }
        const q = y * cw + x;
        if (known) { coarseRole[q] = RING; for (let c = 0; c < 4; c++) coarse[q * 4 + c] = knownSum[c] / known; }
        else if (hole) { coarseRole[q] = HOLE; for (let c = 0; c < 4; c++) coarse[q * 4 + c] = holeSum[c] / hole; }
      }
    }
    solve(coarse, coarseRole, cw, ch, depth + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x, q = (y >> 1) * cw + (x >> 1);
        if (role[p] === HOLE && coarseRole[q] === HOLE) {
          value[p * 4] = coarse[q * 4]; value[p * 4 + 1] = coarse[q * 4 + 1];
          value[p * 4 + 2] = coarse[q * 4 + 2]; value[p * 4 + 3] = coarse[q * 4 + 3];
        }
      }
    }
    iterations = 40;
  }
  const omega = 1.8;
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (role[p] !== HOLE) continue;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n = 0;
        if (x > 0) { const q = p - 1; if (role[q] !== OUTSIDE) { s0 += value[q * 4]; s1 += value[q * 4 + 1]; s2 += value[q * 4 + 2]; s3 += value[q * 4 + 3]; n++; } }
        if (x + 1 < w) { const q = p + 1; if (role[q] !== OUTSIDE) { s0 += value[q * 4]; s1 += value[q * 4 + 1]; s2 += value[q * 4 + 2]; s3 += value[q * 4 + 3]; n++; } }
        if (y > 0) { const q = p - w; if (role[q] !== OUTSIDE) { s0 += value[q * 4]; s1 += value[q * 4 + 1]; s2 += value[q * 4 + 2]; s3 += value[q * 4 + 3]; n++; } }
        if (y + 1 < h) { const q = p + w; if (role[q] !== OUTSIDE) { s0 += value[q * 4]; s1 += value[q * 4 + 1]; s2 += value[q * 4 + 2]; s3 += value[q * 4 + 3]; n++; } }
        if (!n) continue;
        const o = p * 4;
        value[o] += omega * (s0 / n - value[o]);
        value[o + 1] += omega * (s1 / n - value[o + 1]);
        value[o + 2] += omega * (s2 / n - value[o + 2]);
        value[o + 3] += omega * (s3 / n - value[o + 3]);
      }
    }
  }
}

/** `rgba` is `width` × `height` premultiplied pixels; `coverage` the same size, marking what to heal. */
export function spotHeal(rgba: Uint8Array, coverage: Uint8Array, width: number, height: number, opacity: number,
                         mode: number, seed: number): void {
  const W = width, H = height, stride = width * 4;
  const bounds = coverageBounds(coverage, width, height);
  if (!bounds) return;
  const bw = bounds[2] - bounds[0], bh = bounds[3] - bounds[1], size = Math.max(bw, bh);
  const ring = Math.min(16, Math.max(2, Math.floor(size / 8)));
  const wx0 = Math.max(0, bounds[0] - ring), wy0 = Math.max(0, bounds[1] - ring);
  const wx1 = Math.min(W, bounds[2] + ring), wy1 = Math.min(H, bounds[3] + ring);
  const ww = wx1 - wx0, wh = wy1 - wy0, wn = ww * wh;
  const role = new Uint8Array(wn), near = new Uint8Array(wn);
  const prefix = new Int32Array(Math.max(ww, wh) + 1);
  const value = new Float32Array(wn * 4);
  for (let y = 0; y < wh; y++)
    for (let x = 0; x < ww; x++)
      role[y * ww + x] = coverage[(wy0 + y) * width + (wx0 + x)] ? HOLE : OUTSIDE;
  // The ring: pixels within `ring` of the spot (a square dilation, row pass then column pass).
  for (let y = 0; y < wh; y++) {
    prefix[0] = 0;
    for (let x = 0; x < ww; x++) prefix[x + 1] = prefix[x] + (role[y * ww + x] === HOLE ? 1 : 0);
    for (let x = 0; x < ww; x++) {
      const lo = Math.max(0, x - ring), hi = Math.min(ww, x + ring + 1);
      near[y * ww + x] = prefix[hi] - prefix[lo] > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < ww; x++) {
    prefix[0] = 0;
    for (let y = 0; y < wh; y++) prefix[y + 1] = prefix[y] + near[y * ww + x];
    for (let y = 0; y < wh; y++) {
      const lo = Math.max(0, y - ring), hi = Math.min(wh, y + ring + 1);
      if (role[y * ww + x] === OUTSIDE && prefix[hi] - prefix[lo] > 0) role[y * ww + x] = RING;
    }
  }
  let ringCount = 0;
  for (let p = 0; p < wn; p++) if (role[p] === RING) ringCount++;
  if (!ringCount) return;

  // Source patch for Content-Aware and Proximity Match.
  let ox = 0, oy = 0, haveSource = false;
  if (mode !== 1) {
    const factors = [1.05, 1.35, 1.75, 2.25, 2.8];
    const count = mode === 2 ? 2 : 5;
    let best = Infinity;
    for (let f = 0; f < count; f++) {
      for (let a = 0; a < 24; a++) {
        const angle = a * Math.PI / 12;
        const dx = lround(Math.cos(angle) * factors[f] * ww), dy = lround(Math.sin(angle) * factors[f] * wh);
        let s = score(rgba, stride, role, wx0, wy0, ww, wh, dx, dy, W, H);
        if (!Number.isFinite(s)) continue;
        s *= mode === 2 ? 1 + 0.6 * f : 1 + 0.1 * f;
        if (s < best) { best = s; ox = dx; oy = dy; }
      }
    }
    if (Number.isFinite(best)) {
      // Fine-tune the alignment so repeating texture lines up.
      const cx = ox, cy = oy;
      let refined = score(rgba, stride, role, wx0, wy0, ww, wh, cx, cy, W, H);
      for (let j = -3; j <= 3; j++) {
        for (let i = -3; i <= 3; i++) {
          const s = score(rgba, stride, role, wx0, wy0, ww, wh, cx + i, cy + j, W, H);
          if (s < refined) { refined = s; ox = cx + i; oy = cy + j; }
        }
      }
      haveSource = true;
    }
  }

  // Membrane: the edge difference between the original and the patch (or the original itself), spread across.
  const mean = [0, 0, 0, 0], detail = [0, 0, 0];
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const p = y * ww + x;
      if (role[p] !== RING) { value[p * 4] = value[p * 4 + 1] = value[p * 4 + 2] = value[p * 4 + 3] = 0; continue; }
      const ix = wx0 + x, iy = wy0 + y;
      const t = iy * stride + ix * 4;
      const s = haveSource ? (iy + oy) * stride + (ix + ox) * 4 : -1;
      for (let c = 0; c < 4; c++) {
        value[p * 4 + c] = rgba[t + c] - (s >= 0 ? rgba[s + c] : 0);
        mean[c] += value[p * 4 + c];
      }
      if (!haveSource) {
        for (let c = 0; c < 3; c++) {
          let around = 0, n = 0;
          const offsets = [[ix - 1, iy], [ix + 1, iy], [ix, iy - 1], [ix, iy + 1]];
          for (const [nx, ny] of offsets) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            around += rgba[ny * stride + nx * 4 + c];
            n++;
          }
          if (n) { const d = rgba[t + c] - around / n; detail[c] += d * d; }
        }
      }
    }
  }
  for (let c = 0; c < 4; c++) mean[c] /= ringCount;
  for (let p = 0; p < wn; p++) if (role[p] === HOLE) for (let c = 0; c < 4; c++) value[p * 4 + c] = mean[c];
  solve(value, role, ww, wh, 0);
  for (let c = 0; c < 3; c++) detail[c] = Math.sqrt(detail[c] / ringCount) * 0.9;

  seed = seed >>> 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const p = y * ww + x;
      if (role[p] !== HOLE) continue;
      const ix = wx0 + x, iy = wy0 + y;
      const t = iy * stride + ix * 4;
      const s = haveSource ? (iy + oy) * stride + (ix + ox) * 4 : -1;
      const amount = coverage[iy * width + ix] / 255 * opacity;
      let grain = 0;
      if (!haveSource) {
        const key = mix32((seed ^ mix32((iy * W + ix) >>> 0)) >>> 0);
        const u1 = healUnit(key), u2 = healUnit((key ^ 0x68e31da4) >>> 0);
        grain = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
      }
      const out = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        const healed = (s >= 0 ? rgba[s + c] : 0) + value[p * 4 + c] + (c < 3 ? grain * detail[c] : 0);
        out[c] = rgba[t + c] + (healed - rgba[t + c]) * amount;
      }
      const alpha = Math.round(out[3] < 0 ? 0 : out[3] > 255 ? 255 : out[3]);
      rgba[t + 3] = alpha;
      for (let c = 0; c < 3; c++) {
        const v = out[c] < 0 ? 0 : out[c] > alpha ? alpha : out[c];
        rgba[t + c] = Math.round(v);
      }
    }
  }
}
