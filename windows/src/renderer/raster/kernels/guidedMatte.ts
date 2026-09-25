// Guided filtering (He, Sun & Tang): a mask pulled onto the edges of the image it came from, which recovers hair
// and fur a segmentation model cuts straight through. A port of GuidedMatte.swift.

/** Mean over a (2r+1)² square, as two running-sum passes. */
export function boxMean(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const span = radius * 2 + 1;
  const pass = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += source[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      pass[row + x] = sum / span;
      sum -= source[row + Math.min(width - 1, Math.max(0, x - radius))];
      sum += source[row + Math.min(width - 1, Math.max(0, x + radius + 1))];
    }
  }
  const result = new Float32Array(width * height);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += pass[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      result[y * width + x] = sum / span;
      sum -= pass[Math.min(height - 1, Math.max(0, y - radius)) * width + x];
      sum += pass[Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x];
    }
  }
  return result;
}

/** `mask` refined by `guide` (both 0–1, the same size). */
export function guidedFilter(mask: Float32Array, guide: Float32Array, width: number, height: number, radius: number, epsilon: number): Float32Array {
  const count = width * height;
  const meanGuide = boxMean(guide, width, height, radius);
  const meanMask = boxMean(mask, width, height, radius);
  const squares = new Float32Array(count), products = new Float32Array(count);
  for (let i = 0; i < count; i++) { squares[i] = guide[i] * guide[i]; products[i] = guide[i] * mask[i]; }
  const meanSquares = boxMean(squares, width, height, radius);
  const meanProducts = boxMean(products, width, height, radius);
  const slope = new Float32Array(count), offset = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const variance = meanSquares[i] - meanGuide[i] * meanGuide[i];
    const covariance = meanProducts[i] - meanGuide[i] * meanMask[i];
    slope[i] = covariance / (variance + epsilon);
    offset[i] = meanMask[i] - slope[i] * meanGuide[i];
  }
  const meanSlope = boxMean(slope, width, height, radius);
  const meanOffset = boxMean(offset, width, height, radius);
  const result = new Float32Array(count);
  for (let i = 0; i < count; i++) result[i] = Math.min(1, Math.max(0, meanSlope[i] * guide[i] + meanOffset[i]));
  return result;
}

/** Bilinear resize of a float plane. */
export function resizePlane(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const top = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const bottom = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

/** Area-averaged shrink of a float plane (used before refining big images). */
export function shrinkPlane(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * sy)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * sx)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * sw + xx];
      out[y * dw + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** `mask` refined against `guide`, both full size, working on a copy no larger than `limit` on its longest side. */
export function refineMatte(mask: Float32Array, guide: Float32Array, width: number, height: number, radius: number, limit: number): Float32Array {
  const factor = Math.min(1, limit / Math.max(width, height));
  const w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor));
  const steps = Math.max(1, Math.round(radius * factor));
  const refined = guidedFilter(shrinkPlane(mask, width, height, w, h), shrinkPlane(guide, width, height, w, h), w, h, steps, 1e-4);
  return w === width && h === height ? refined : resizePlane(refined, w, h, width, height);
}
