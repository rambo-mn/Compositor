// Layer placement: unrotated bounds in document pixels, rotated clockwise about their center, optionally flipped.
// A port of LayerTransform.swift (including TransformDrag and TransformSnap).
import {
  Affine, Point, Rect, Size, applyPoint, concat, hypot, invert, makeTranslation, rotatedBy, roundHalfAway,
  scaledBy, translatedBy,
} from './geometry';

export type LayerSampling = 'Nearest' | 'Smooth' | 'High quality';
export const LAYER_SAMPLINGS: LayerSampling[] = ['Nearest', 'Smooth', 'High quality'];

export interface LayerTransform {
  origin: Point;
  size: Size;
  /** Degrees, clockwise. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  sampling: LayerSampling;
}

export function makeTransform(origin: Point, size: Size, sampling: LayerSampling = 'High quality'): LayerTransform {
  return { origin: { ...origin }, size: { ...size }, rotation: 0, flipX: false, flipY: false, sampling };
}

export function transformsEqual(a: LayerTransform | null | undefined, b: LayerTransform | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.size.width === b.size.width
    && a.size.height === b.size.height && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY
    && a.sampling === b.sampling;
}

export function center(t: LayerTransform): Point {
  return { x: t.origin.x + t.size.width / 2, y: t.origin.y + t.size.height / 2 };
}

export function radians(t: LayerTransform): number { return (t.rotation % 360) * Math.PI / 180; }

export function isValidTransform(t: LayerTransform): boolean {
  const values = [t.origin.x, t.origin.y, t.size.width, t.size.height, t.rotation];
  return values.every(Number.isFinite)
    && t.size.width >= 1 && t.size.width <= 300_000 && t.size.height >= 1 && t.size.height <= 300_000
    && Math.abs(t.origin.x) <= 1_000_000 && Math.abs(t.origin.y) <= 1_000_000;
}

/** Where a unit point (0…1, y down) of the layer lands on the document. */
export function unitPoint(t: LayerTransform, unit: Point): Point {
  const c = center(t), r = radians(t);
  const x = (unit.x - 0.5) * t.size.width, y = (unit.y - 0.5) * t.size.height;
  return { x: c.x + x * Math.cos(r) - y * Math.sin(r), y: c.y + x * Math.sin(r) + y * Math.cos(r) };
}

export function transformContains(t: LayerTransform, p: Point): boolean {
  const c = center(t), r = radians(t);
  const x = p.x - c.x, y = p.y - c.y;
  return Math.abs(x * Math.cos(r) + y * Math.sin(r)) <= t.size.width / 2
    && Math.abs(-x * Math.sin(r) + y * Math.cos(r)) <= t.size.height / 2;
}

/** Width as a percentage of the pixels it places (100% draws them 1:1). */
export function scalePercent(t: LayerTransform, pixelSize: Size): number {
  return t.size.width / Math.max(1, pixelSize.width) * 100;
}

export function scaledToPercent(t: LayerTransform, percent: number, pixelSize: Size): LayerTransform {
  const c = center(t);
  const size = { width: pixelSize.width * percent / 100, height: pixelSize.height * percent / 100 };
  return { ...t, size, origin: { x: c.x - size.width / 2, y: c.y - size.height / 2 } };
}

/** Whole pixels and whole degrees: what dragging, scaling and rotating leave behind. */
export function roundedTransform(t: LayerTransform): LayerTransform {
  return {
    ...t,
    origin: { x: roundHalfAway(t.origin.x), y: roundHalfAway(t.origin.y) },
    size: { width: Math.max(1, roundHalfAway(t.size.width)), height: Math.max(1, roundHalfAway(t.size.height)) },
    rotation: roundHalfAway(t.rotation),
  };
}

/** Maps a `width` × `height` pixel grid (top-left origin) onto the document through `t` (BrushRaster.pixelToDocument). */
export function pixelToDocument(t: LayerTransform, width: number, height: number): Affine {
  const c = center(t);
  let m = makeTranslation(c.x, c.y);
  m = rotatedBy(m, radians(t));
  m = scaledBy(m, t.size.width / width * (t.flipX ? -1 : 1), t.size.height / height * (t.flipY ? -1 : 1));
  m = translatedBy(m, -width / 2, -height / 2);
  return m;
}

/** The unit square mapped where the transform places a layer. */
export function unitToDocument(t: LayerTransform): Affine { return pixelToDocument(t, 1, 1); }

/** A transform placing the unit square as `map` does (shear dropped). Keeps `t`'s sampling. */
export function placing(t: LayerTransform, map: Affine): LayerTransform {
  const sign = t.flipX ? -1 : 1;
  const angle = Math.atan2(map.b * sign, map.a * sign);
  const along = -map.c * Math.sin(angle) + map.d * Math.cos(angle);
  const middle = applyPoint(map, { x: 0.5, y: 0.5 });
  const size = { width: hypot(map.a, map.b), height: Math.abs(along) };
  const degrees = angle * 180 / Math.PI;
  return {
    ...t,
    size,
    rotation: degrees + roundHalfAway((t.rotation - degrees) / 360) * 360,
    flipY: along < 0,
    origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 },
  };
}

/** This placement carried along as a layer moves from `old` to `next`. */
export function following(t: LayerTransform, old: LayerTransform, next: LayerTransform): LayerTransform {
  if (transformsEqual(old, next)) return t;
  if (old.size.width === next.size.width && old.size.height === next.size.height && old.rotation === next.rotation
      && old.flipX === next.flipX && old.flipY === next.flipY) {
    return { ...t, origin: { x: t.origin.x + next.origin.x - old.origin.x, y: t.origin.y + next.origin.y - old.origin.y } };
  }
  return placing(t, concat(concat(unitToDocument(t), invert(unitToDocument(old))), unitToDocument(next)));
}

/** The same place on the document, whatever the sampling. */
export function samePlacement(t: LayerTransform, other: LayerTransform): boolean {
  return transformsEqual({ ...t, sampling: other.sampling }, other);
}

/** This placement mirrored across a vertical line at `axis` (or, not horizontally, a horizontal one). */
export function mirrored(t: LayerTransform, horizontally: boolean, axis: number): LayerTransform {
  const c = center(t);
  const result: LayerTransform = { ...t, origin: { ...t.origin }, rotation: -t.rotation };
  if (horizontally) {
    result.flipX = !t.flipX;
    result.origin.x = 2 * axis - c.x - t.size.width / 2;
  } else {
    result.flipY = !t.flipY;
    result.origin.y = 2 * axis - c.y - t.size.height / 2;
  }
  return result;
}

export const HANDLES: Point[] = [
  { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 },
  { x: 1, y: 1 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.5 },
];

/** The four corners in handle order: top-left, top-right, bottom-right, bottom-left. */
export function cornersOf(t: LayerTransform): Point[] {
  return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].map((u) => unitPoint(t, u));
}

/** The upright box around a transform's corners. */
export function boundingBox(t: LayerTransform): Rect {
  const corners = cornersOf(t);
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

// MARK: Dragging

export type DragMode =
  | { kind: 'move' }
  | { kind: 'resize'; index: number }
  | { kind: 'rotate' }
  | { kind: 'distort'; index: number };

export interface TransformDrag {
  original: LayerTransform;
  start: Point;
  mode: DragMode;
  /** The distortion's corners when the drag began; null for an ordinary transform. */
  originalCorners: Point[] | null;
}

/** Corners after dragging to `point`: a corner handle moves its corner, an edge handle both of that edge's
 *  corners, and the body the whole shape. Null when the drag isn't distorting. */
export function dragCorners(drag: TransformDrag, point: Point, shift = false): Point[] | null {
  if (!drag.originalCorners) return null;
  const result = drag.originalCorners.map((p) => ({ ...p }));
  let dx = point.x - drag.start.x, dy = point.y - drag.start.y;
  if (shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  let moved: number[];
  if (drag.mode.kind === 'distort') {
    const index = drag.mode.index;
    moved = index % 2 === 0 ? [index / 2] : [Math.floor(index / 2), (Math.floor(index / 2) + 1) % 4];
  } else if (drag.mode.kind === 'move') {
    moved = [0, 1, 2, 3];
  } else {
    return null;
  }
  for (const corner of moved) { result[corner].x += dx; result[corner].y += dy; }
  return result;
}

export function dragUpdated(drag: TransformDrag, point: Point, lockRatio: boolean, shift: boolean, option = false): LayerTransform {
  const original = drag.original;
  let result: LayerTransform = { ...original, origin: { ...original.origin }, size: { ...original.size } };
  const mode = drag.mode;
  if (mode.kind === 'move') {
    let dx = point.x - drag.start.x, dy = point.y - drag.start.y;
    if (shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    result.origin.x += dx;
    result.origin.y += dy;
  } else if (mode.kind === 'rotate') {
    const c = center(original);
    const delta = Math.atan2(point.y - c.y, point.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
    result.rotation += delta * 180 / Math.PI;
    if (shift) result.rotation = roundHalfAway(result.rotation / 15) * 15;
  } else if (mode.kind === 'resize') {
    const handle = HANDLES[mode.index];
    const anchorUnit = option ? { x: 0.5, y: 0.5 } : { x: 1 - handle.x, y: 1 - handle.y };
    const anchor = unitPoint(original, anchorUnit);
    const initialHandle = unitPoint(original, handle);
    const dx = initialHandle.x + point.x - drag.start.x - anchor.x;
    const dy = initialHandle.y + point.y - drag.start.y - anchor.y;
    const span = option ? 2 : 1;
    const r = radians(original);
    const localX = (dx * Math.cos(r) + dy * Math.sin(r)) * span;
    const localY = (-dx * Math.sin(r) + dy * Math.cos(r)) * span;
    const sx = handle.x * 2 - 1, sy = handle.y * 2 - 1;
    let width = sx === 0 ? original.size.width : Math.max(1, localX * sx);
    let height = sy === 0 ? original.size.height : Math.max(1, localY * sy);
    if (lockRatio !== shift) {
      let factor: number;
      if (sx === 0) factor = height / original.size.height;
      else if (sy === 0) factor = width / original.size.width;
      else {
        factor = Math.max(1 / Math.min(original.size.width, original.size.height),
          (localX * sx * original.size.width + localY * sy * original.size.height)
          / (original.size.width * original.size.width + original.size.height * original.size.height));
      }
      width = original.size.width * factor;
      height = original.size.height * factor;
    }
    result.size = { width, height };
    const offsetX = (0.5 - anchorUnit.x) * width;
    const offsetY = (0.5 - anchorUnit.y) * height;
    const c = { x: anchor.x + offsetX * Math.cos(r) - offsetY * Math.sin(r), y: anchor.y + offsetX * Math.sin(r) + offsetY * Math.cos(r) };
    result.origin = { x: c.x - width / 2, y: c.y - height / 2 };
  }
  return isValidTransform(result) ? result : original;
}

// MARK: Snapping

/** How close, in screen points, a guide comes before it snaps. */
export const SNAP_DISTANCE = 10;

export function snapOffset(box: Rect, xs: number[], ys: number[], tolerance: number):
    { offset: { width: number; height: number }; x: number | null; y: number | null } {
  const horizontal = shift([box.x, box.x + box.width / 2, box.x + box.width], xs, tolerance);
  const vertical = shift([box.y, box.y + box.height / 2, box.y + box.height], ys, tolerance);
  return { offset: { width: horizontal.move, height: vertical.move }, x: horizontal.target, y: vertical.target };
}

function shift(guides: number[], targets: number[], tolerance: number): { move: number; target: number | null } {
  let best: { move: number; target: number } | null = null;
  for (const guide of guides) {
    for (const target of targets) {
      const move = target - guide;
      if (Math.abs(move) > tolerance) continue;
      if (best && Math.abs(best.move) <= Math.abs(move)) continue;
      best = { move, target };
    }
  }
  return { move: best?.move ?? 0, target: best?.target ?? null };
}

// MARK: Group and edit state

/** Several layers transformed together: the upright box around them when the edit began, and each one's transform. */
export interface TransformGroup {
  box: LayerTransform;
  originals: Map<string, LayerTransform>;
}

export interface FloatingTransform {
  sourceID: string;
  before: unknown; // CanvasDocument snapshot; typed in session code
  beforeActive: string | null;
  original: LayerTransform;
  pixelSize: Size;
}

export interface TransformEdit {
  layerID: string;
  draft: LayerTransform;
  persistent: boolean;
  floating: FloatingTransform | null;
  corners: Point[] | null;
  mask: boolean;
  group: TransformGroup | null;
}
