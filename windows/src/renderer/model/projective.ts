// 3 × 3 projective transforms (row-major), for the Distort tool's perspective and for drawing through it.
import type { Affine, Point } from './geometry';

export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export function fromAffine(t: Affine): Matrix3 {
  return [t.a, t.c, t.tx, t.b, t.d, t.ty, 0, 0, 1];
}

/** `m` then `n` (n · m). Not named `then`: a module exporting `then` is a thenable, and `await import()` of it never settles. */
export function compose3(m: Matrix3, n: Matrix3): Matrix3 {
  const r = new Array(9) as Matrix3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = n[i * 3] * m[j] + n[i * 3 + 1] * m[3 + j] + n[i * 3 + 2] * m[6 + j];
    }
  }
  return r;
}

export function invert3(m: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const inv = 1 / det;
  return [A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
    C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv];
}

export function project(m: Matrix3, p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

/** The perspective mapping of the unit square onto corners `c` (top-left, top-right, bottom-right, bottom-left),
 *  as DistortWarp.homography computes it. */
export function unitSquareTo(c: Point[]): Matrix3 {
  const sx = c[0].x - c[1].x + c[2].x - c[3].x, sy = c[0].y - c[1].y + c[2].y - c[3].y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = c[1].x - c[2].x, dx2 = c[3].x - c[2].x, dy1 = c[1].y - c[2].y, dy2 = c[3].y - c[2].y;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) > 1e-12) {
      g = (sx * dy2 - dx2 * sy) / den;
      h = (dx1 * sy - sx * dy1) / den;
    }
  }
  const a = c[1].x - c[0].x + g * c[1].x, b = c[3].x - c[0].x + h * c[3].x, x0 = c[0].x;
  const d = c[1].y - c[0].y + g * c[1].y, e = c[3].y - c[0].y + h * c[3].y, y0 = c[0].y;
  return [a, b, x0, d, e, y0, g, h, 1];
}

/** Four finite corners making a convex, non-degenerate shape (DistortWarp.isUsable). */
export function isUsableQuad(corners: Point[]): boolean {
  if (corners.length !== 4 || !corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)
      && Math.abs(p.x) <= 1_000_000 && Math.abs(p.y) <= 1_000_000)) return false;
  let sign = 0;
  for (let index = 0; index < 4; index++) {
    const a = corners[index], b = corners[(index + 1) % 4], c = corners[(index + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(Math.abs(cross) > 0.01)) return false;
    if (sign === 0) sign = cross < 0 ? -1 : 1;
    else if ((cross < 0) !== (sign < 0)) return false;
  }
  return true;
}
