// Gaussian and motion blurs on premultiplied RGBA or gray bytes, standing in for Core Image's CIGaussianBlur and
// CIMotionBlur. Small blurs use an exact separable kernel; large ones three successive box blurs (a close Gaussian
// approximation whose cost doesn't grow with the radius). Outside the image is transparent (a blur spreads into the
// room around a layer) unless `clampEdges` extends the border pixels, as Core Image's clampedToExtent does.

/** Box widths whose three successive passes approximate a Gaussian of `sigma` (Kovesi). */
export function boxesForGauss(sigma: number, n = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** One 1-D pass over every line of a float image (`channels` interleaved). `horizontal` picks rows or columns. */
function convolveLines(src: Float32Array, dst: Float32Array, width: number, height: number, channels: number,
                       horizontal: boolean, kernel: Float32Array, clampEdges: boolean): void {
  const radius = (kernel.length - 1) / 2;
  const lines = horizontal ? height : width, length = horizontal ? width : height;
  const step = horizontal ? channels : width * channels;
  const line = new Float32Array(length * channels);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * width * channels : l * channels;
    for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) line[i * channels + c] = src[base + i * step + c];
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          let j = i + k;
          if (j < 0 || j >= length) {
            if (!clampEdges) continue;
            j = j < 0 ? 0 : length - 1;
          }
          sum += line[j * channels + c] * kernel[k + radius];
        }
        dst[base + i * step + c] = sum;
      }
    }
  }
}

/** One box pass of odd width `size` along every line; zero (or the edge value) outside. */
function boxLines(src: Float32Array, dst: Float32Array, width: number, height: number, channels: number,
                  horizontal: boolean, size: number, clampEdges: boolean): void {
  const r = (size - 1) >> 1;
  const lines = horizontal ? height : width, length = horizontal ? width : height;
  const step = horizontal ? channels : width * channels;
  const inv = 1 / size;
  const sums = new Float64Array(channels);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * width * channels : l * channels;
    const value = (j: number, c: number) => {
      if (j < 0 || j >= length) {
        if (!clampEdges) return 0;
        j = j < 0 ? 0 : length - 1;
      }
      return src[base + j * step + c];
    };
    for (let c = 0; c < channels; c++) {
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += value(j, c);
      sums[c] = sum;
    }
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) {
        dst[base + i * step + c] = sums[c] * inv;
        sums[c] += value(i + r + 1, c) - value(i - r, c);
      }
    }
  }
}

/** Gaussian blur of `sigma` pixels; returns new bytes of the same layout. */
export function gaussianBlur(data: Uint8Array, width: number, height: number, channels: number, sigma: number,
                             clampEdges = false): Uint8Array {
  if (!(sigma > 0.05)) return data.slice();
  let a = Float32Array.from(data), b = new Float32Array(data.length);
  if (sigma <= 4) {
    const kernel = gaussianKernel(sigma);
    convolveLines(a, b, width, height, channels, true, kernel, clampEdges);
    convolveLines(b, a, width, height, channels, false, kernel, clampEdges);
  } else {
    for (const size of boxesForGauss(sigma)) {
      boxLines(a, b, width, height, channels, true, size, clampEdges);
      [a, b] = [b, a];
    }
    for (const size of boxesForGauss(sigma)) {
      boxLines(a, b, width, height, channels, false, size, clampEdges);
      [a, b] = [b, a];
    }
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, Math.round(a[i])));
  if (channels === 4) for (let p = 0; p < out.length; p += 4) {
    const alpha = out[p + 3];
    if (out[p] > alpha) out[p] = alpha;
    if (out[p + 1] > alpha) out[p + 1] = alpha;
    if (out[p + 2] > alpha) out[p + 2] = alpha;
  }
  return out;
}

/** Bilinear sample of premultiplied RGBA (transparent outside) into `out`. */
function sampleRGBA(src: Float32Array, width: number, height: number, x: number, y: number, out: Float64Array): void {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= height) continue;
    const wy = j ? fy : 1 - fy;
    if (wy === 0) continue;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= width) continue;
      const w = wy * (i ? fx : 1 - fx);
      if (w === 0) continue;
      const p = (yy * width + xx) * 4;
      out[0] += src[p] * w; out[1] += src[p + 1] * w; out[2] += src[p + 2] * w; out[3] += src[p + 3] * w;
    }
  }
}

/** A Gaussian streak of spread `sigma` along `angle` degrees (counterclockwise from horizontal, as in Photoshop).
 *  The image is turned so the streak runs along rows, blurred there with box passes, and turned back. */
export function motionBlur(data: Uint8Array, width: number, height: number, sigma: number, angleDegrees: number): Uint8Array {
  if (!(sigma > 0.05)) return data.slice();
  const angle = angleDegrees * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Screen y points down, so counterclockwise on screen is a negative rotation in these coordinates.
  const ux = cos, uy = -sin;
  const axisAligned = Math.abs(uy) < 1e-9 || Math.abs(ux) < 1e-9;
  if (axisAligned) {
    const horizontal = Math.abs(uy) < 1e-9;
    let a = Float32Array.from(data), b = new Float32Array(data.length);
    if (sigma <= 4) convolveLines(a, b, width, height, 4, horizontal, gaussianKernel(sigma), false), [a, b] = [b, a];
    else for (const size of boxesForGauss(sigma)) { boxLines(a, b, width, height, 4, horizontal, size, false); [a, b] = [b, a]; }
    const out = new Uint8Array(data.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, Math.round(a[i])));
    return out;
  }
  // The rotated frame: u along the streak, v across it, big enough to hold the whole image.
  const cx = width / 2, cy = height / 2;
  const rw = Math.ceil(Math.abs(width * ux) + Math.abs(height * uy)) + 2;
  const rh = Math.ceil(Math.abs(width * uy) + Math.abs(height * ux)) + 2;
  const src = Float32Array.from(data);
  let rotated = new Float32Array(rw * rh * 4);
  const sample = new Float64Array(4);
  for (let v = 0; v < rh; v++) {
    for (let u = 0; u < rw; u++) {
      const du = u + 0.5 - rw / 2, dv = v + 0.5 - rh / 2;
      const x = cx + du * ux - dv * uy - 0.5, y = cy + du * uy + dv * ux - 0.5;
      sampleRGBA(src, width, height, x, y, sample);
      const o = (v * rw + u) * 4;
      rotated[o] = sample[0]; rotated[o + 1] = sample[1]; rotated[o + 2] = sample[2]; rotated[o + 3] = sample[3];
    }
  }
  let scratch = new Float32Array(rotated.length);
  if (sigma <= 4) { convolveLines(rotated, scratch, rw, rh, 4, true, gaussianKernel(sigma), false); [rotated, scratch] = [scratch, rotated]; }
  else for (const size of boxesForGauss(sigma)) { boxLines(rotated, scratch, rw, rh, 4, true, size, false); [rotated, scratch] = [scratch, rotated]; }
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = dx * ux + dy * uy + rw / 2 - 0.5, v = -dx * uy + dy * ux + rh / 2 - 0.5;
      sampleRGBA(rotated, rw, rh, u, v, sample);
      const o = (y * width + x) * 4;
      const alpha = Math.min(255, Math.max(0, Math.round(sample[3])));
      out[o + 3] = alpha;
      for (let c = 0; c < 3; c++) out[o + c] = Math.min(alpha, Math.max(0, Math.round(sample[c])));
    }
  }
  return out;
}
