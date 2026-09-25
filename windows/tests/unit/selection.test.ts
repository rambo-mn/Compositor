import { describe, expect, it } from 'vitest';
import { SelectionPath, pathUnion, pathSubtracting, pathIntersection, pathOffset, dragBox } from '../../src/renderer/model/selection';

const area = (p: SelectionPath) => p.polygons.reduce((sum, poly) => {
  let a = 0;
  for (let i = 0, n = poly.length / 2, j = n - 1; i < n; j = i++) a += poly[j * 2] * poly[i * 2 + 1] - poly[i * 2] * poly[j * 2 + 1];
  return sum + a / 2;
}, 0);

describe('selection paths', () => {
  it('unions, subtracts and intersects rectangles', () => {
    const a = SelectionPath.rect({ x: 0, y: 0, width: 10, height: 10 });
    const b = SelectionPath.rect({ x: 5, y: 0, width: 10, height: 10 });
    expect(Math.abs(area(pathUnion(a, b)))).toBeCloseTo(150, 3);
    expect(Math.abs(area(pathSubtracting(a, b)))).toBeCloseTo(50, 3);
    expect(Math.abs(area(pathIntersection(a, b)))).toBeCloseTo(50, 3);
    expect(pathSubtracting(a, a).isEmpty).toBe(true);
  });
  it('tests containment with holes', () => {
    const outer = SelectionPath.rect({ x: 0, y: 0, width: 20, height: 20 });
    const hole = SelectionPath.rect({ x: 5, y: 5, width: 10, height: 10 });
    const ring = pathSubtracting(outer, hole);
    expect(ring.contains({ x: 2, y: 2 })).toBe(true);
    expect(ring.contains({ x: 10, y: 10 })).toBe(false);
  });
  it('expands with rounded corners and contracts', () => {
    const a = SelectionPath.rect({ x: 0, y: 0, width: 10, height: 10 });
    const grown = pathOffset(a, 2);
    expect(grown.bounds!.x).toBeCloseTo(-2, 2);
    expect(Math.abs(area(grown))).toBeCloseTo(100 + 4 * 20 + Math.PI * 4, 0);
    expect(pathOffset(a, -6).isEmpty).toBe(true);
  });
  it('drags whole-pixel boxes', () => {
    expect(dragBox({ x: 10, y: 10 }, { x: 4.4, y: 20.6 }, false, false)).toEqual({ x: 4, y: 10, width: 6, height: 11 });
    expect(dragBox({ x: 10, y: 10 }, { x: 14, y: 12 }, true, true)).toEqual({ x: 6, y: 6, width: 8, height: 8 });
  });
});
