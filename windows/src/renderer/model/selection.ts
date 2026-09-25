// Selections: a document-space outline made of closed polygons, filled with the nonzero winding rule, clipped to
// the canvas. `null` on the document means no selection; an outline with no area is an explicit empty selection,
// which edits must treat as "touch nothing". Boolean operations and Expand/Contract use Clipper (clipper-lib) in place of the
// Core Graphics path operations the Mac app uses. Ports Selection.swift.
import ClipperLib from 'clipper-lib';
import type { Paths as ClipperPaths } from 'clipper-lib';
import { Affine, Point, Rect, applyPoint } from './geometry';

/** Clipper works in integers: coordinates are stored at this many units per document pixel. */
const SCALE = 256;

export class SelectionPath {
  /** Closed polygons as flat [x0, y0, x1, y1, …] in document pixels. */
  readonly polygons: ReadonlyArray<Float64Array>;
  private cachedBounds: Rect | null | undefined;

  constructor(polygons: ReadonlyArray<Float64Array>) {
    this.polygons = polygons.filter((p) => p.length >= 6);
  }

  static readonly empty = new SelectionPath([]);

  static rect(r: Rect): SelectionPath {
    return new SelectionPath([Float64Array.from([r.x, r.y, r.x + r.width, r.y, r.x + r.width, r.y + r.height, r.x, r.y + r.height])]);
  }

  static polygon(points: Point[]): SelectionPath {
    const flat = new Float64Array(points.length * 2);
    points.forEach((p, i) => { flat[i * 2] = p.x; flat[i * 2 + 1] = p.y; });
    return new SelectionPath([flat]);
  }

  /** An ellipse filling `r`, flattened finely enough that it stays within 0.01 px of the true curve. */
  static ellipse(r: Rect): SelectionPath {
    return new SelectionPath([ellipsePoints(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2)]);
  }

  static roundedRect(r: Rect, radius: number): SelectionPath {
    return new SelectionPath([roundedRectPoints(r, radius)]);
  }

  get isEmpty(): boolean {
    const b = this.bounds;
    return !b || !(b.width > 0) || !(b.height > 0);
  }

  get bounds(): Rect | null {
    if (this.cachedBounds !== undefined) return this.cachedBounds;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const polygon of this.polygons) {
      for (let i = 0; i < polygon.length; i += 2) {
        const x = polygon[i], y = polygon[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    this.cachedBounds = x1 >= x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
    return this.cachedBounds;
  }

  get pointCount(): number { return this.polygons.reduce((n, p) => n + p.length / 2, 0); }

  transformed(t: Affine): SelectionPath {
    return new SelectionPath(this.polygons.map((polygon) => {
      const out = new Float64Array(polygon.length);
      for (let i = 0; i < polygon.length; i += 2) {
        const x = polygon[i], y = polygon[i + 1];
        out[i] = t.a * x + t.c * y + t.tx;
        out[i + 1] = t.b * x + t.d * y + t.ty;
      }
      return out;
    }));
  }

  mapped(map: (p: Point) => Point): SelectionPath {
    return new SelectionPath(this.polygons.map((polygon) => {
      const out = new Float64Array(polygon.length);
      for (let i = 0; i < polygon.length; i += 2) {
        const p = map({ x: polygon[i], y: polygon[i + 1] });
        out[i] = p.x; out[i + 1] = p.y;
      }
      return out;
    }));
  }

  translated(dx: number, dy: number): SelectionPath {
    return this.transformed({ a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy });
  }

  /** Nonzero winding test. */
  contains(p: Point): boolean {
    let winding = 0;
    for (const polygon of this.polygons) {
      const n = polygon.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i * 2], yi = polygon[i * 2 + 1], xj = polygon[j * 2], yj = polygon[j * 2 + 1];
        if (yj <= p.y) {
          if (yi > p.y && (xi - xj) * (p.y - yj) - (p.x - xj) * (yi - yj) > 0) winding++;
        } else if (yi <= p.y && (xi - xj) * (p.y - yj) - (p.x - xj) * (yi - yj) < 0) {
          winding--;
        }
      }
    }
    return winding !== 0;
  }

  equals(other: SelectionPath): boolean {
    if (this === other) return true;
    if (this.polygons.length !== other.polygons.length) return false;
    for (let i = 0; i < this.polygons.length; i++) {
      const a = this.polygons[i], b = other.polygons[i];
      if (a.length !== b.length) return false;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    }
    return true;
  }
}

export interface DocumentSelection {
  path: SelectionPath;
  antialiased: boolean;
}

export function selectionsEqual(a: DocumentSelection | null, b: DocumentSelection | null): boolean {
  if (!a || !b) return a === b;
  return a.antialiased === b.antialiased && a.path.equals(b.path);
}

export function selectionIsEmpty(s: DocumentSelection | null | undefined): boolean {
  return !!s && s.path.isEmpty;
}

// MARK: Shapes

export function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Float64Array {
  const radius = Math.max(rx, ry, 0.5);
  // Chord deviation r(1 − cos(θ/2)) ≤ 0.01 px.
  const steps = Math.max(16, Math.min(20000, Math.ceil(2 * Math.PI / Math.sqrt(8 * 0.01 / radius))));
  const out = new Float64Array(steps * 2);
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    out[i * 2] = cx + Math.cos(angle) * rx;
    out[i * 2 + 1] = cy + Math.sin(angle) * ry;
  }
  return out;
}

export function roundedRectPoints(r: Rect, cornerRadius: number): Float64Array {
  const radius = Math.min(Math.max(0, cornerRadius), r.width / 2, r.height / 2);
  if (!(radius > 0)) return Float64Array.from([r.x, r.y, r.x + r.width, r.y, r.x + r.width, r.y + r.height, r.x, r.y + r.height]);
  const quarter = Math.max(4, Math.ceil(Math.PI / 2 / Math.sqrt(8 * 0.01 / radius)));
  const points: number[] = [];
  const corner = (cx: number, cy: number, start: number) => {
    for (let i = 0; i <= quarter; i++) {
      const angle = start + (i / quarter) * Math.PI / 2;
      points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
  };
  corner(r.x + r.width - radius, r.y + radius, -Math.PI / 2);
  corner(r.x + r.width - radius, r.y + r.height - radius, 0);
  corner(r.x + radius, r.y + r.height - radius, Math.PI / 2);
  corner(r.x + radius, r.y + radius, Math.PI);
  return Float64Array.from(points);
}

// MARK: Boolean operations

function toClipper(path: SelectionPath): ClipperPaths {
  return path.polygons.map((polygon) => {
    const out = new Array(polygon.length / 2);
    for (let i = 0; i < polygon.length; i += 2) out[i / 2] = { X: Math.round(polygon[i] * SCALE), Y: Math.round(polygon[i + 1] * SCALE) };
    return out;
  });
}

function fromClipper(paths: ClipperPaths): SelectionPath {
  return new SelectionPath(paths.map((path) => {
    const out = new Float64Array(path.length * 2);
    path.forEach((p, i) => { out[i * 2] = p.X / SCALE; out[i * 2 + 1] = p.Y / SCALE; });
    return out;
  }));
}

function boolean(clipType: number, a: SelectionPath, b: SelectionPath | null): SelectionPath {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toClipper(a), ClipperLib.PolyType.ptSubject, true);
  if (b) clipper.AddPaths(toClipper(b), ClipperLib.PolyType.ptClip, true);
  const solution: ClipperPaths = [];
  clipper.Execute(clipType, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return fromClipper(solution);
}

export function pathUnion(a: SelectionPath, b: SelectionPath): SelectionPath {
  if (a.polygons.length === 0) return normalizePath(b);
  if (b.polygons.length === 0) return normalizePath(a);
  return boolean(ClipperLib.ClipType.ctUnion, a, b);
}

export function pathIntersection(a: SelectionPath, b: SelectionPath): SelectionPath {
  if (a.polygons.length === 0 || b.polygons.length === 0) return SelectionPath.empty;
  return boolean(ClipperLib.ClipType.ctIntersection, a, b);
}

export function pathSubtracting(a: SelectionPath, b: SelectionPath): SelectionPath {
  if (a.polygons.length === 0) return SelectionPath.empty;
  if (b.polygons.length === 0) return normalizePath(a);
  return boolean(ClipperLib.ClipType.ctDifference, a, b);
}

/** The outline resolved into non-overlapping polygons (nonzero rule). */
export function normalizePath(a: SelectionPath): SelectionPath {
  if (a.polygons.length === 0) return a;
  return boolean(ClipperLib.ClipType.ctUnion, a, null);
}

/** Grows (positive) or shrinks (negative) the outline by `delta` pixels with rounded corners. */
export function pathOffset(a: SelectionPath, delta: number): SelectionPath {
  if (a.polygons.length === 0 || delta === 0) return a;
  const offset = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  offset.AddPaths(toClipper(normalizePath(a)), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution: ClipperPaths = [];
  offset.Execute(solution, delta * SCALE);
  return fromClipper(solution);
}

// MARK: Tools

export type LassoKind = 'Freehand' | 'Polygonal' | 'Rectangle' | 'Ellipse';
export const LASSO_CHOICES: LassoKind[] = ['Freehand', 'Polygonal'];
export const MARQUEE_CHOICES: LassoKind[] = ['Rectangle', 'Ellipse'];

export type SelectionMode = 'New' | 'Add' | 'Subtract';
export const SELECTION_MODES: SelectionMode[] = ['New', 'Add', 'Subtract'];

/** The box a drag from `anchor` to `point` spans, in whole pixels. Shared by the Marquee and the Shape tool. */
export function dragBox(anchor: Point, point: Point, square: boolean, fromCenter: boolean): Rect {
  const round = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
  let dx = round(point.x) - anchor.x, dy = round(point.y) - anchor.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }
  return fromCenter
    ? { x: anchor.x - Math.abs(dx), y: anchor.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 }
    : { x: Math.min(anchor.x, anchor.x + dx), y: Math.min(anchor.y, anchor.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

export interface LassoDraft {
  points: Point[];
  cursor: Point | null;
  mode: SelectionMode;
  kind: LassoKind;
  anchor: Point | null;
}

/** The outline a finished draft makes; null when it encloses nothing. */
export function draftOutline(draft: LassoDraft): SelectionPath {
  if (draft.kind === 'Ellipse' && draft.points.length === 4) {
    const xs = draft.points.map((p) => p.x), ys = draft.points.map((p) => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return SelectionPath.ellipse({ x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 });
  }
  return SelectionPath.polygon(draft.points);
}

export function pointOnPath(path: SelectionPath, t: Affine): Point[][] {
  return path.polygons.map((polygon) => {
    const out: Point[] = [];
    for (let i = 0; i < polygon.length; i += 2) out.push(applyPoint(t, { x: polygon[i], y: polygon[i + 1] }));
    return out;
  });
}
