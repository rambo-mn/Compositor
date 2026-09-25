// Points, sizes, rectangles and affine transforms with Core Graphics semantics, so geometry ported from the
// Mac app behaves identically. Document space: pixels, top-left origin, y down.

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

export const pt = (x: number, y: number): Point => ({ x, y });
export const sz = (width: number, height: number): Size => ({ width, height });
export const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

export const ZERO_POINT: Point = Object.freeze({ x: 0, y: 0 });

export function pointsEqual(a: Point | null | undefined, b: Point | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y;
}
export function sizesEqual(a: Size, b: Size): boolean { return a.width === b.width && a.height === b.height; }
export function rectsEqual(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export const minX = (r: Rect) => r.x;
export const minY = (r: Rect) => r.y;
export const maxX = (r: Rect) => r.x + r.width;
export const maxY = (r: Rect) => r.y + r.height;
export const midX = (r: Rect) => r.x + r.width / 2;
export const midY = (r: Rect) => r.y + r.height / 2;

/** A rect with non-negative width and height, as CGRect.standardized. */
export function standardized(r: Rect): Rect {
  const x = r.width < 0 ? r.x + r.width : r.x;
  const y = r.height < 0 ? r.y + r.height : r.y;
  return { x, y, width: Math.abs(r.width), height: Math.abs(r.height) };
}

export function isEmptyRect(r: Rect | null | undefined): boolean {
  return !r || !(r.width > 0) || !(r.height > 0);
}

/** CGRect.intersection: null when the rects don't overlap (CGRect.null). Touching edges give a zero-size rect. */
export function intersection(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 < x0 || y1 < y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function unionOptional(a: Rect | null, b: Rect): Rect { return a ? union(a, b) : b; }

/** CGRect.integral: the smallest whole-pixel rect containing this one. */
export function integral(r: Rect): Rect {
  const x0 = Math.floor(r.x), y0 = Math.floor(r.y);
  const x1 = Math.ceil(r.x + r.width), y1 = Math.ceil(r.y + r.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function insetBy(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width - dx * 2, height: r.height - dy * 2 };
}

export function offsetBy(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  const i = intersection(a, b);
  return !!i && i.width > 0 && i.height > 0;
}

export function hypot(x: number, y: number): number { return Math.sqrt(x * x + y * y); }
export function distance(a: Point, b: Point): number { return hypot(b.x - a.x, b.y - a.y); }
export function clamp(value: number, low: number, high: number): number { return Math.min(high, Math.max(low, value)); }

/** Swift's `rounded()`: to nearest, halves away from zero. */
export function roundHalfAway(value: number): number { return value < 0 ? -Math.round(-value) : Math.round(value); }

/** Swift's truncatingRemainder. */
export function truncRem(value: number, divisor: number): number { return value % divisor; }

// MARK: Affine transforms (CGAffineTransform)

/** x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export interface Affine { a: number; b: number; c: number; d: number; tx: number; ty: number }

export const IDENTITY: Affine = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

export function affine(a: number, b: number, c: number, d: number, tx: number, ty: number): Affine {
  return { a, b, c, d, tx, ty };
}
export function makeTranslation(tx: number, ty: number): Affine { return { a: 1, b: 0, c: 0, d: 1, tx, ty }; }
export function makeScale(sx: number, sy: number): Affine { return { a: sx, b: 0, c: 0, d: sy, tx: 0, ty: 0 }; }
export function makeRotation(angle: number): Affine {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { a: c, b: s, c: -s, d: c, tx: 0, ty: 0 };
}

/** t1 then t2 (CGAffineTransformConcat). */
export function concat(t1: Affine, t2: Affine): Affine {
  return {
    a: t1.a * t2.a + t1.b * t2.c,
    b: t1.a * t2.b + t1.b * t2.d,
    c: t1.c * t2.a + t1.d * t2.c,
    d: t1.c * t2.b + t1.d * t2.d,
    tx: t1.tx * t2.a + t1.ty * t2.c + t2.tx,
    ty: t1.tx * t2.b + t1.ty * t2.d + t2.ty,
  };
}

/** `t.translatedBy(x:y:)`: translate first, then t. */
export function translatedBy(t: Affine, tx: number, ty: number): Affine { return concat(makeTranslation(tx, ty), t); }
/** `t.scaledBy(x:y:)`: scale first, then t. */
export function scaledBy(t: Affine, sx: number, sy: number): Affine { return concat(makeScale(sx, sy), t); }
/** `t.rotated(by:)`: rotate first, then t. */
export function rotatedBy(t: Affine, angle: number): Affine { return concat(makeRotation(angle), t); }

export function invert(t: Affine): Affine {
  const det = t.a * t.d - t.b * t.c;
  if (det === 0 || !Number.isFinite(det)) return t; // CGAffineTransformInvert returns the input when singular.
  const a = t.d / det, b = -t.b / det, c = -t.c / det, d = t.a / det;
  return { a, b, c, d, tx: -(t.tx * a + t.ty * c), ty: -(t.tx * b + t.ty * d) };
}

export function applyPoint(t: Affine, p: Point): Point {
  return { x: t.a * p.x + t.c * p.y + t.tx, y: t.b * p.x + t.d * p.y + t.ty };
}

/** CGRect.applying: the bounding box of the transformed corners. */
export function applyRect(t: Affine, r: Rect): Rect {
  const corners = [applyPoint(t, { x: r.x, y: r.y }), applyPoint(t, { x: r.x + r.width, y: r.y }),
    applyPoint(t, { x: r.x, y: r.y + r.height }), applyPoint(t, { x: r.x + r.width, y: r.y + r.height })];
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

export function affinesEqual(a: Affine, b: Affine): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.tx === b.tx && a.ty === b.ty;
}

/** 3×3 column-major matrix for WebGL from an affine transform. */
export function affineToMat3(t: Affine): Float32Array {
  return new Float32Array([t.a, t.b, 0, t.c, t.d, 0, t.tx, t.ty, 1]);
}
