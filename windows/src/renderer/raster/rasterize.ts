// Polygon rasterization for selection coverage. Anti-aliased coverage is the exact area each pixel shares with the
// shape (signed-area accumulation); without anti-aliasing a pixel is in when its center is (nonzero winding).
import { Affine } from '../model/geometry';
import type { DocumentSelection, SelectionPath } from '../model/selection';

/** Coverage (0–255) of `polygons`, mapped by `transform` (if any), over the grid `x0, y0, width, height`. */
export function rasterizePolygons(polygons: ReadonlyArray<Float64Array>, transform: Affine | null, x0: number, y0: number,
                                  width: number, height: number, antialias: boolean): Uint8Array {
  const out = new Uint8Array(width * height);
  if (!width || !height || polygons.length === 0) return out;
  const mapped = polygons.map((polygon) => {
    const points = new Float64Array(polygon.length);
    for (let i = 0; i < polygon.length; i += 2) {
      let x = polygon[i], y = polygon[i + 1];
      if (transform) {
        const tx = transform.a * x + transform.c * y + transform.tx;
        y = transform.b * x + transform.d * y + transform.ty;
        x = tx;
      }
      points[i] = x - x0;
      points[i + 1] = y - y0;
    }
    return points;
  });
  if (antialias) accumulate(mapped, width, height, out);
  else sampleCenters(mapped, width, height, out);
  return out;
}

export function rasterizeSelection(selection: DocumentSelection, transform: Affine | null, x0: number, y0: number,
                                   width: number, height: number): Uint8Array {
  return rasterizePolygons(selection.path.polygons, transform, x0, y0, width, height, selection.antialiased);
}

export function rasterizePath(path: SelectionPath, transform: Affine | null, x0: number, y0: number, width: number,
                              height: number, antialias = true): Uint8Array {
  return rasterizePolygons(path.polygons, transform, x0, y0, width, height, antialias);
}

/** Signed-area accumulation: each edge deposits its area into the cells it crosses; a running sum along each row
 *  gives the winding-weighted coverage, clamped to 0…1 (nonzero). */
function accumulate(polygons: Float64Array[], width: number, height: number, out: Uint8Array): void {
  const stride = width + 2;
  const acc = new Float32Array(stride * height);
  const line = (ax: number, ay: number, bx: number, by: number) => {
    if (ay === by) return;
    // Clip in y to the grid.
    let dir = 1;
    if (ay > by) { [ax, ay, bx, by] = [bx, by, ax, ay]; dir = -1; }
    if (by <= 0 || ay >= height) return;
    const dxdy = (bx - ax) / (by - ay);
    if (ay < 0) { ax -= ay * dxdy; ay = 0; }
    if (by > height) { bx -= (by - height) * dxdy; by = height; }
    // Split where the edge crosses x = 0 or x = width; outside parts become vertical runs along the border.
    const pieces: number[] = [];
    const crossings: number[] = [];
    if (dxdy !== 0) {
      for (const border of [0, width]) {
        const t = (border - ax) / (bx - ax);
        if (t > 0 && t < 1) crossings.push(ay + (by - ay) * t);
      }
      crossings.sort((m, n) => m - n);
    }
    let startY = ay;
    for (const y of [...crossings, by]) {
      const midY = (startY + y) / 2;
      const midX = ax + (midY - ay) * dxdy;
      const sx = ax + (startY - ay) * dxdy, ex = ax + (y - ay) * dxdy;
      if (midX <= 0) pieces.push(0, startY, 0, y);
      else if (midX >= width) pieces.push(width, startY, width, y);
      else pieces.push(Math.min(width, Math.max(0, sx)), startY, Math.min(width, Math.max(0, ex)), y);
      startY = y;
    }
    for (let i = 0; i < pieces.length; i += 4) depositSegment(acc, stride, pieces[i], pieces[i + 1], pieces[i + 2], pieces[i + 3], dir);
  };
  for (const polygon of polygons) {
    const n = polygon.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      line(polygon[i * 2], polygon[i * 2 + 1], polygon[j * 2], polygon[j * 2 + 1]);
    }
  }
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      sum += acc[row + x];
      const coverage = Math.min(1, Math.abs(sum));
      out[y * width + x] = Math.round(coverage * 255);
    }
  }
}

/** A downward (y0 < y1) segment inside the grid's x range, winding `dir`. */
function depositSegment(acc: Float32Array, stride: number, x0: number, y0: number, x1: number, y1: number, dir: number): void {
  if (y0 === y1) return;
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  const yStart = Math.floor(y0), yEnd = Math.ceil(y1);
  for (let y = yStart; y < yEnd; y++) {
    const rowStart = y * stride;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xNext = x + dxdy * dy;
    const d = dy * dir;
    const left = Math.min(x, xNext), right = Math.max(x, xNext);
    const leftFloor = Math.floor(left);
    const li = leftFloor;
    const rightCeil = Math.ceil(right);
    const ri = rightCeil;
    if (ri <= li + 1) {
      const xmf = 0.5 * (x + xNext) - leftFloor;
      acc[rowStart + li] += d - d * xmf;
      acc[rowStart + li + 1] += d * xmf;
    } else {
      const s = 1 / (right - left);
      const x0f = left - leftFloor;
      const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
      const x1f = right - rightCeil + 1;
      const am = 0.5 * s * x1f * x1f;
      acc[rowStart + li] += d * a0;
      if (ri === li + 2) {
        acc[rowStart + li + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - x0f);
        acc[rowStart + li + 1] += d * (a1 - a0);
        for (let xi = li + 2; xi < ri - 1; xi++) acc[rowStart + xi] += d * s;
        const a2 = a1 + (ri - li - 3) * s;
        acc[rowStart + ri - 1] += d * (1 - a2 - am);
      }
      acc[rowStart + ri] += d * am;
    }
    x = xNext;
  }
}

/** Pixels whose centers the outline winds around. */
function sampleCenters(polygons: Float64Array[], width: number, height: number, out: Uint8Array): void {
  const crossings: { x: number; w: number }[] = [];
  for (let y = 0; y < height; y++) {
    const sy = y + 0.5;
    crossings.length = 0;
    for (const polygon of polygons) {
      const n = polygon.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = polygon[i * 2], ay = polygon[i * 2 + 1], bx = polygon[j * 2], by = polygon[j * 2 + 1];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
          const x = ax + (sy - ay) * (bx - ax) / (by - ay);
          crossings.push({ x, w: by > ay ? 1 : -1 });
        }
      }
    }
    if (!crossings.length) continue;
    crossings.sort((a, b) => a.x - b.x);
    let winding = 0;
    for (let k = 0; k < crossings.length - 1; k++) {
      winding += crossings[k].w;
      if (winding === 0) continue;
      const start = Math.max(0, Math.ceil(crossings[k].x - 0.5)), end = Math.min(width, Math.ceil(crossings[k + 1].x - 0.5));
      if (end > start) out.fill(255, y * width + start, y * width + end);
    }
  }
}

/** Selection coverage for one region of the document, ready to clip edits. `coverage` null means an empty
 *  selection: it clips everything away. (SelectionClip) */
export interface SelectionClip {
  rect: { x: number; y: number; width: number; height: number };
  coverage: Uint8Array | null;
  selection: DocumentSelection;
}

export function selectionClip(selection: DocumentSelection, canvasWidth: number, canvasHeight: number): SelectionClip {
  const bounds = selection.path.bounds;
  if (selection.path.isEmpty || !bounds) return { rect: { x: 0, y: 0, width: 0, height: 0 }, coverage: null, selection };
  const x0 = Math.max(0, Math.floor(bounds.x - 1)), y0 = Math.max(0, Math.floor(bounds.y - 1));
  const x1 = Math.min(canvasWidth, Math.ceil(bounds.x + bounds.width + 1)), y1 = Math.min(canvasHeight, Math.ceil(bounds.y + bounds.height + 1));
  if (x1 - x0 < 1 || y1 - y0 < 1) return { rect: { x: 0, y: 0, width: 0, height: 0 }, coverage: null, selection };
  return {
    rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    coverage: rasterizeSelection(selection, null, x0, y0, x1 - x0, y1 - y0),
    selection,
  };
}

/** Selection coverage on another pixel grid (a layer's), where `docToGrid` maps document points into it. Pixels
 *  outside the clip's canvas region get nothing, as clipping to the region does. */
export function clipCoverageInGrid(clip: SelectionClip, gridToDocument: Affine, docToGrid: Affine, x0: number, y0: number,
                                   width: number, height: number): Uint8Array {
  if (!clip.coverage) return new Uint8Array(width * height);
  const r = clip.rect;
  // The clip region as a rectangle intersected with the outline, in grid space.
  const region = new Float64Array([r.x, r.y, r.x + r.width, r.y, r.x + r.width, r.y + r.height, r.x, r.y + r.height]);
  const inside = rasterizePolygons([region], docToGrid, x0, y0, width, height, true);
  const shape = rasterizePolygons(clip.selection.path.polygons, docToGrid, x0, y0, width, height, clip.selection.antialiased);
  for (let i = 0; i < shape.length; i++) shape[i] = Math.round(shape[i] * inside[i] / 255);
  void gridToDocument;
  return shape;
}
