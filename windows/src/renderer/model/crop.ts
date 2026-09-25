// Crop frame geometry, dragging and edge snapping, plus Canvas Size's draft values. Ports Crop.swift and CanvasSize.swift.
import { Point, Rect, roundHalfAway, standardized } from './geometry';
import { HANDLES, TransformDrag, dragUpdated, makeTransform } from './transform';

export function cropSnapped(input: Rect): Rect {
  const r = standardized(input);
  const x = roundHalfAway(r.x), y = roundHalfAway(r.y);
  return { x, y, width: Math.max(1, roundHalfAway(r.x + r.width) - x), height: Math.max(1, roundHalfAway(r.y + r.height) - y) };
}

export function cropValid(r: Rect): boolean {
  return [r.x, r.y, r.width, r.height].every(Number.isFinite)
    && r.width >= 1 && r.width <= 30_000 && r.height >= 1 && r.height <= 30_000
    && Math.abs(r.x) <= 1_000_000 && Math.abs(r.y) <= 1_000_000;
}

/** A frame dragged from `start` to `end`, or with `symmetric` grown out from `start` as its center. */
export function cropCreate(start: Point, end: Point, ratio: number | null, symmetric = false): Rect {
  let dx = end.x - start.x, dy = end.y - start.y;
  if (ratio != null) {
    if (Math.abs(dx) > Math.abs(dy) * ratio) dy = (dy < 0 ? -1 : 1) * Math.abs(dx) / ratio;
    else dx = (dx < 0 ? -1 : 1) * Math.abs(dy) * ratio;
  }
  if (symmetric) return cropSnapped({ x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 });
  return cropSnapped({ x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy) });
}

export type CropDragMode = { kind: 'create' } | { kind: 'move' } | { kind: 'resize'; index: number };

export interface CropDrag { start: Point; original: Rect; mode: CropDragMode }

export function cropDragUpdated(drag: CropDrag, point: Point, ratio: number | null, symmetric = false): Rect {
  switch (drag.mode.kind) {
    case 'create': return cropCreate(drag.start, point, ratio, symmetric);
    case 'move': return cropSnapped({ ...drag.original, x: drag.original.x + point.x - drag.start.x, y: drag.original.y + point.y - drag.start.y });
    case 'resize': {
      const transform = makeTransform({ x: drag.original.x, y: drag.original.y }, { width: drag.original.width, height: drag.original.height });
      const transformDrag: TransformDrag = { original: transform, start: drag.start, mode: { kind: 'resize', index: drag.mode.index }, originalCorners: null };
      const next = dragUpdated(transformDrag, point, ratio != null, false, symmetric);
      return cropSnapped({ x: next.origin.x, y: next.origin.y, width: next.size.width, height: next.size.height });
    }
  }
}

/** Crop edges snap to nearby layer and canvas edges while dragging. */
export interface CropSnap { xs: number[]; ys: number[]; tolerance: number }

function nearest(snap: CropSnap, value: number, targets: number[]): number | null {
  let best: number | null = null;
  for (const target of targets) {
    if (Math.abs(target - value) > snap.tolerance) continue;
    if (best != null && Math.abs(best - value) <= Math.abs(target - value)) continue;
    best = target;
  }
  return best;
}

export function cropSnapApply(snap: CropSnap, rect: Rect, drag: CropDrag, point: Point, ratio: number | null, symmetric = false): Rect {
  if (!(snap.tolerance > 0)) return rect;
  let horizontal: boolean, vertical: boolean;
  switch (drag.mode.kind) {
    case 'move': {
      const shift = (edges: number[], targets: number[]) => {
        const moves = edges.map((edge) => { const n = nearest(snap, edge, targets); return n == null ? null : n - edge; })
          .filter((m): m is number => m != null);
        if (!moves.length) return 0;
        return moves.reduce((best, m) => (Math.abs(m) < Math.abs(best) ? m : best));
      };
      return { ...rect, x: rect.x + shift([rect.x, rect.x + rect.width], snap.xs), y: rect.y + shift([rect.y, rect.y + rect.height], snap.ys) };
    }
    case 'create':
      if (ratio != null) return rect;
      horizontal = true; vertical = true;
      break;
    case 'resize': {
      if (ratio != null) return rect;
      const handle = HANDLES[drag.mode.index];
      horizontal = handle.x !== 0.5; vertical = handle.y !== 0.5;
      break;
    }
  }
  let result = { ...rect };
  const maxX = () => result.x + result.width, maxY = () => result.y + result.height;
  if (horizontal) {
    if (Math.abs(point.x - result.x) <= Math.abs(point.x - maxX())) {
      const x = nearest(snap, result.x, snap.xs);
      if (x != null && x < maxX()) result = { ...result, x, width: maxX() - x };
    } else {
      const x = nearest(snap, maxX(), snap.xs);
      if (x != null && x > result.x) result.width = x - result.x;
    }
  }
  if (vertical) {
    if (Math.abs(point.y - result.y) <= Math.abs(point.y - maxY())) {
      const y = nearest(snap, result.y, snap.ys);
      if (y != null && y < maxY()) result = { ...result, y, height: maxY() - y };
    } else {
      const y = nearest(snap, maxY(), snap.ys);
      if (y != null && y > result.y) result.height = y - result.y;
    }
  }
  if (symmetric) {
    let c = { x: drag.original.x + drag.original.width / 2, y: drag.original.y + drag.original.height / 2 };
    if (drag.mode.kind === 'create') c = drag.start;
    if (horizontal) {
      const half = point.x >= c.x ? maxX() - c.x : c.x - result.x;
      if (half >= 0.5) { result.x = c.x - half; result.width = half * 2; }
    }
    if (vertical) {
      const half = point.y >= c.y ? maxY() - c.y : c.y - result.y;
      if (half >= 0.5) { result.y = c.y - half; result.height = half * 2; }
    }
  }
  return result;
}

export type CropRatioChoice = 'Free' | 'Original' | '1:1' | '4:3' | '16:9';
export const CROP_RATIOS: CropRatioChoice[] = ['Free', 'Original', '1:1', '4:3', '16:9'];

// MARK: Canvas Size

export type CanvasUnit = 'Pixels' | 'Percent' | 'Inches' | 'Centimeters';
export const CANVAS_UNITS: CanvasUnit[] = ['Pixels', 'Percent', 'Inches', 'Centimeters'];

export interface CanvasSizeDraft {
  originalWidth: number;
  originalHeight: number;
  resolution: number;
  width: number;
  height: number;
  relative: boolean;
  locked: boolean;
  unit: CanvasUnit;
}

export function makeCanvasSizeDraft(width: number, height: number, resolution: number): CanvasSizeDraft {
  return { originalWidth: width, originalHeight: height, resolution, width, height, relative: false, locked: false, unit: 'Pixels' };
}

export function canvasDraftValid(d: CanvasSizeDraft): boolean {
  const w = roundHalfAway(d.width), h = roundHalfAway(d.height);
  return Number.isFinite(d.width) && Number.isFinite(d.height) && w >= 1 && w <= 30_000 && h >= 1 && h <= 30_000;
}

export function canvasDraftDisplayed(d: CanvasSizeDraft, widthAxis: boolean): number {
  const original = widthAxis ? d.originalWidth : d.originalHeight;
  const pixels = (widthAxis ? d.width : d.height) - (d.relative ? original : 0);
  switch (d.unit) {
    case 'Pixels': return pixels;
    case 'Percent': return pixels / original * 100;
    case 'Inches': return pixels / d.resolution;
    case 'Centimeters': return pixels / d.resolution * 2.54;
  }
}

export function canvasDraftSet(d: CanvasSizeDraft, value: number, widthAxis: boolean): CanvasSizeDraft {
  const original = widthAxis ? d.originalWidth : d.originalHeight;
  let pixels: number;
  switch (d.unit) {
    case 'Pixels': pixels = value; break;
    case 'Percent': pixels = value / 100 * original; break;
    case 'Inches': pixels = value * d.resolution; break;
    case 'Centimeters': pixels = value / 2.54 * d.resolution; break;
  }
  const final = pixels + (d.relative ? original : 0);
  const next = { ...d };
  if (widthAxis) {
    next.width = final;
    if (d.locked) next.height = final * d.originalHeight / d.originalWidth;
  } else {
    next.height = final;
    if (d.locked) next.width = final * d.originalWidth / d.originalHeight;
  }
  return next;
}

export interface CanvasExtensionColor { red: number; green: number; blue: number }

export interface CanvasSizeOptions {
  width: number;
  height: number;
  /** Row-major, top-left through bottom-right. */
  anchor: number;
  fill: CanvasExtensionColor | null;
  /** Crop supplies an explicit document-space translation. */
  contentOffset: Point | null;
}

export function canvasOffset(options: CanvasSizeOptions, fromWidth: number, fromHeight: number): Point {
  if (options.contentOffset) return options.contentOffset;
  // Floor puts the extra pixel on the right/bottom when expanding and removes it from the left/top when shrinking.
  return {
    x: Math.floor((options.width - fromWidth) * (options.anchor % 3) / 2),
    y: Math.floor((options.height - fromHeight) * Math.floor(options.anchor / 3) / 2),
  };
}
