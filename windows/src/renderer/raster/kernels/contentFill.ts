// Content-Aware Fill: fills the selected pixels from the rest of the layer, propagating coherent source offsets
// and refining with a randomized patch search. A port of ContentFill.c. Returns false when there are no usable
// source pixels (unselected, opaque, with a full neighborhood).

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
  return state.value;
}

function match(pixels: Uint8Array, known: Uint8Array, w: number, h: number, p: number, q: number, radius: number): number {
  const px = p % w, py = (p / w) | 0, qx = q % w, qy = (q / w) | 0;
  let sum = 0, count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = px + dx, y = py + dy, sx = qx + dx, sy = qy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || sx < 0 || sy < 0 || sx >= w || sy >= h || !known[y * w + x]) continue;
      const a = (y * w + x) * 4, b = (sy * w + sx) * 4;
      for (let c = 0; c < 4; c++) { const d = pixels[a + c] - pixels[b + c]; sum += d * d; }
      count++;
    }
  }
  return count ? sum / count : Number.MAX_VALUE;
}

/** `pixels` (w × h premultiplied RGBA) is filled in place wherever `mask` (w × h) is nonzero. */
export function contentFill(pixels: Uint8Array, mask: Uint8Array, w: number, h: number): boolean {
  const n = w * h;
  const known = new Uint8Array(n), target = new Uint8Array(n), valid = new Uint8Array(n), queued = new Uint8Array(n);
  const donors = new Int32Array(n), queue = new Int32Array(n), chosen = new Int32Array(n);
  const radius = w >= 5 && h >= 5 ? 2 : 0;
  let missing = 0, donorCount = 0, head = 0, tail = 0, scan = 0;
  // Selected pixels are filled. Unselected opaque pixels are the image to match and copy from; unselected
  // transparent ones are neither.
  for (let p = 0; p < n; p++) {
    target[p] = mask[p] !== 0 ? 1 : 0;
    known[p] = !target[p] && pixels[p * 4 + 3] === 255 ? 1 : 0;
    chosen[p] = -1;
    if (target[p]) missing++;
  }
  if (!missing) return true;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!known[p]) continue;
      let ok = true;
      for (let dy = -radius; dy <= radius && ok; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx, sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h || !known[sy * w + sx]) { ok = false; break; }
        }
      }
      if (ok) { valid[p] = 1; donors[donorCount++] = p; }
    }
  }
  if (!donorCount) return false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (target[p] && ((x && known[p - 1]) || (x + 1 < w && known[p + 1]) || (y && known[p - w]) || (y + 1 < h && known[p + w]))) {
        queue[tail++] = p; queued[p] = 1;
      }
    }
  }
  const seed = { value: 0x6d2b79f5 };
  for (;;) {
    while (head < tail) {
      const p = queue[head++], x = p % w, y = (p / w) | 0;
      let best = -1, score = Number.MAX_VALUE;
      const neighbors = [x ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y ? p - w : -1, y + 1 < h ? p + w : -1];
      // Propagate coherent source offsets, then refine with randomized patch search.
      for (let k = 0; k < 28; k++) {
        let q = -1;
        if (k < 4) {
          const t = neighbors[k];
          if (t >= 0) q = (chosen[t] >= 0 ? chosen[t] : t) + (p - t);
        } else q = donors[nextRandom(seed) % donorCount];
        if (q < 0 || q >= n || !valid[q]) continue;
        const s = match(pixels, known, w, h, p, q, radius);
        if (best < 0 || s < score) { score = s; best = q; }
      }
      if (best < 0) best = donors[0];
      for (let r = 64; r >= 1; r >>= 1) {
        const qx = best % w + (nextRandom(seed) % (2 * r + 1)) - r;
        const qy = ((best / w) | 0) + (nextRandom(seed) % (2 * r + 1)) - r;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h || !valid[qy * w + qx]) continue;
        const q = qy * w + qx;
        const s = match(pixels, known, w, h, p, q, radius);
        if (s < score) { score = s; best = q; }
      }
      pixels.copyWithin(p * 4, best * 4, best * 4 + 4);
      known[p] = 1; chosen[p] = best;
      for (let k = 0; k < 4; k++) {
        const q = neighbors[k];
        if (q >= 0 && target[q] && !known[q] && !queued[q]) { queued[q] = 1; queue[tail++] = q; }
      }
    }
    // A selected area that only transparency touches starts from a donor, then spreads.
    while (scan < n && (!target[scan] || known[scan])) scan++;
    if (scan >= n) break;
    queue[tail++] = scan; queued[scan] = 1;
  }
  return true;
}
