// Magic Wand matching and outline tracing. A port of WandPixels.c: a scanline flood fill (or a whole-image match),
// then the selected pixels' boundary walked along exact pixel edges into closed loops (outer boundaries clockwise
// on screen, holes counterclockwise), so the nonzero rule reproduces exactly the traced pixels.

const EAST = 1, SOUTH = 2, WEST = 4, NORTH = 8;
/** Outlines with more pixel edges than this are refused: the path would be too slow to use. */
const EDGE_LIMIT = 8_000_000;

export class WandTooDetailedError extends Error {
  constructor() { super('That selection is too detailed to outline. Try a different Tolerance, or turn on Contiguous.'); }
}

/** Marks (255) pixels whose every channel is within `tolerance` of the (averaged) color at the seed. Returns the count. */
export function wandMask(rgba: Uint8Array, width: number, height: number, seedX: number, seedY: number, radius: number,
                         tolerance: number, contiguous: boolean, mask: Uint8Array): number {
  mask.fill(0);
  if (!width || !height || seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return 0;
  const x0 = Math.max(0, seedX - radius), x1 = Math.min(width - 1, seedX + radius);
  const y0 = Math.max(0, seedY - radius), y1 = Math.min(height - 1, seedY + radius);
  const sums = [0, 0, 0, 0];
  let samples = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++, samples++) {
      const p = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) sums[c] += rgba[p + c];
    }
  }
  const r0 = Math.floor((sums[0] + Math.floor(samples / 2)) / samples), r1 = Math.floor((sums[1] + Math.floor(samples / 2)) / samples);
  const r2 = Math.floor((sums[2] + Math.floor(samples / 2)) / samples), r3 = Math.floor((sums[3] + Math.floor(samples / 2)) / samples);
  const matches = (p: number) => {
    const d0 = rgba[p] - r0, d1 = rgba[p + 1] - r1, d2 = rgba[p + 2] - r2, d3 = rgba[p + 3] - r3;
    return d0 >= -tolerance && d0 <= tolerance && d1 >= -tolerance && d1 <= tolerance
      && d2 >= -tolerance && d2 <= tolerance && d3 >= -tolerance && d3 <= tolerance;
  };
  let count = 0;
  if (!contiguous) {
    const n = width * height;
    for (let i = 0; i < n; i++) if (matches(i * 4)) { mask[i] = 255; count++; }
    return count;
  }
  // Scanline flood fill: each popped seed fills its whole run, then pushes one seed per matching run above and below.
  let stack = new Int32Array(8192);
  let top = 0;
  const push = (x: number, y: number) => {
    if (top * 2 + 2 > stack.length) { const grown = new Int32Array(stack.length * 2); grown.set(stack); stack = grown; }
    stack[top * 2] = x; stack[top * 2 + 1] = y; top++;
  };
  push(seedX, seedY);
  while (top) {
    top--;
    const x = stack[top * 2], y = stack[top * 2 + 1];
    const row = y * width;
    if (mask[row + x] || !matches((row + x) * 4)) continue;
    let left = x, right = x;
    while (left > 0 && !mask[row + left - 1] && matches((row + left - 1) * 4)) left--;
    while (right + 1 < width && !mask[row + right + 1] && matches((row + right + 1) * 4)) right++;
    mask.fill(255, row + left, row + right + 1);
    count += right - left + 1;
    for (let side = 0; side < 2; side++) {
      if (side === 0 ? y === 0 : y + 1 >= height) continue;
      const ny = side === 0 ? y - 1 : y + 1;
      const nrow = ny * width;
      let inRun = false;
      for (let nx = left; nx <= right; nx++) {
        const candidate = !mask[nrow + nx] && matches((nrow + nx) * 4);
        if (candidate && !inRun) push(nx, ny);
        inRun = candidate;
      }
    }
  }
  return count;
}

const turnRight = (d: number) => (d === NORTH ? EAST : d << 1);
const turnLeft = (d: number) => (d === EAST ? NORTH : d >> 1);

/** Closed loops (flat [x0, y0, …] in pixel-corner coordinates) around a mask's nonzero pixels. */
export function wandTrace(mask: Uint8Array, width: number, height: number): Float64Array[] {
  if (!width || !height) return [];
  const stride = width + 1, vertices = stride * (height + 1);
  const out = new Uint8Array(vertices);
  let edges = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (y === 0 || !mask[row - width + x]) { out[y * stride + x] |= EAST; edges++; }
      if (x + 1 === width || !mask[row + x + 1]) { out[y * stride + x + 1] |= SOUTH; edges++; }
      if (y + 1 === height || !mask[row + width + x]) { out[(y + 1) * stride + x + 1] |= WEST; edges++; }
      if (x === 0 || !mask[row + x - 1]) { out[(y + 1) * stride + x] |= NORTH; edges++; }
    }
    if (edges > EDGE_LIMIT) throw new WandTooDetailedError();
  }
  const loops: Float64Array[] = [];
  let points: number[] = [];
  for (let start = 0; start < vertices; start++) {
    while (out[start]) {
      points = [];
      let v = start, heading = 0, initial = 0;
      do {
        const bits = out[v];
        let d: number;
        // Where two loops meet at a corner, turning right keeps them apart.
        if (!heading) d = bits & -bits;
        else if (bits & turnRight(heading)) d = turnRight(heading);
        else if (bits & heading) d = heading;
        else if (bits & turnLeft(heading)) d = turnLeft(heading);
        else d = bits & -bits;
        if (!d) break;
        out[v] &= ~d;
        if (d !== heading) points.push(v % stride, Math.floor(v / stride));
        if (!heading) initial = d;
        heading = d;
        v = d === EAST ? v + 1 : d === WEST ? v - 1 : d === SOUTH ? v + stride : v - stride;
      } while (v !== start);
      // The start is a corner unless the loop arrives on the heading it left with.
      if (heading === initial && points.length >= 2) points.splice(0, 2);
      if (points.length >= 6) loops.push(Float64Array.from(points));
    }
  }
  return loops;
}
