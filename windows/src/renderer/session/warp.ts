// Smudge and Liquify: a stroke working on the active layer as the canvas shows it, at document size, changing it
// dab by dab; the canvas shows that working copy in place of the layer. A port of WarpStroke (SmudgeLiquify.swift).
import type { Point } from '../model/geometry';
import type { Layer } from '../model/document';
import type { BlurToolMode, BrushSettings } from '../model/settings';

export class WarpStroke {
  readonly diameter: number;
  readonly hardness: number;
  readonly strength: number;
  /** Every dab's centre, for painting the result into the layer. */
  readonly points: Point[] = [];
  /** Areas changed since the display last uploaded them. */
  readonly dirty: { x: number; y: number; width: number; height: number }[] = [];
  private last: Point | null = null;
  /** Smudge: the colour the brush carries, a (2r+1)² RGBA square. */
  private carried = new Float32Array(0);
  private scratch = new Float32Array(0);

  constructor(readonly layer: Layer, readonly pixels: Uint8Array, readonly width: number, readonly height: number,
              readonly mode: BlurToolMode, settings: BrushSettings) {
    this.diameter = Math.max(2, settings.diameter);
    this.hardness = Math.min(0.98, Math.max(0, settings.hardness));
    this.strength = Math.min(1, Math.max(0.01, settings.opacity));
  }

  private get radius(): number { return Math.ceil(this.diameter / 2); }

  /** How much a dab moves pixels at a distance `u` (0 centre, 1 rim) from its centre. */
  private weight(u: number): number {
    if (u >= 1) return 0;
    const h = this.hardness;
    if (u <= h) return 1;
    const t = (1 - u) / (1 - h);
    return t * t * (3 - 2 * t);
  }

  /** Continues the stroke to `point`, dabbing along the way. */
  append(point: Point): void {
    const from = this.last;
    if (!from) {
      this.last = point;
      if (this.mode === 'Smudge') this.pickUp(point);
      return;
    }
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const spacing = Math.max(1, this.diameter * (this.mode === 'Smudge' ? 0.08 : 0.025));
    if (distance < spacing) return;
    const steps = Math.ceil(distance / spacing);
    let previous = from;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const next = { x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t };
      if (this.mode === 'Smudge') this.smudge(next); else this.push(previous, next);
      this.points.push(next);
      previous = next;
    }
    this.last = point;
  }

  private markDirty(cx: number, cy: number, reach: number): void {
    const x0 = Math.max(0, cx - reach), y0 = Math.max(0, cy - reach);
    const x1 = Math.min(this.width, cx + reach + 1), y1 = Math.min(this.height, cy + reach + 1);
    if (x1 > x0 && y1 > y0) this.dirty.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }

  private pickUp(center: Point): void {
    const r = this.radius, side = 2 * r + 1;
    this.carried = new Float32Array(side * side * 4);
    const cx = Math.round(center.x), cy = Math.round(center.y);
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= this.width) continue;
        const p = (y * this.width + x) * 4, c = ((dy + r) * side + dx + r) * 4;
        for (let k = 0; k < 4; k++) this.carried[c + k] = this.pixels[p + k];
      }
    }
  }

  private smudge(center: Point): void {
    const r = this.radius, side = 2 * r + 1;
    const cx = Math.round(center.x), cy = Math.round(center.y);
    const keep = this.strength, invR = 1 / (this.diameter / 2);
    const pixels = this.pixels, carried = this.carried;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= this.width) continue;
        const w = this.weight(Math.sqrt(dx * dx + dy * dy) * invR);
        if (w <= 0) continue;
        const p = (y * this.width + x) * 4, c = ((dy + r) * side + dx + r) * 4;
        for (let k = 0; k < 4; k++) {
          const under = pixels[p + k];
          const painted = under + (carried[c + k] - under) * w;
          pixels[p + k] = Math.max(0, Math.min(255, Math.round(painted)));
          // The brush picks up some of what it just left, more the weaker the smudge.
          carried[c + k] = painted + (carried[c + k] - painted) * keep;
        }
      }
    }
    this.markDirty(cx, cy, r);
  }

  /** Forward warp: pixels under the brush move with it, most at its centre, fading to none at its rim. */
  private push(a: Point, b: Point): void {
    const r = this.radius;
    const mx = (b.x - a.x) * this.strength, my = (b.y - a.y) * this.strength;
    const margin = Math.ceil(Math.max(Math.abs(mx), Math.abs(my))) + 2;
    const cx = Math.round(b.x), cy = Math.round(b.y);
    // A copy of the area as it was before this dab, which the dab samples from.
    const x0 = Math.max(0, cx - r - margin), x1 = Math.min(this.width - 1, cx + r + margin);
    const y0 = Math.max(0, cy - r - margin), y1 = Math.min(this.height - 1, cy + r + margin);
    if (x0 > x1 || y0 > y1) return;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    if (this.scratch.length < cw * ch * 4) this.scratch = new Float32Array(cw * ch * 4);
    const scratch = this.scratch, pixels = this.pixels;
    for (let y = 0; y < ch; y++) {
      const src = ((y + y0) * this.width + x0) * 4;
      for (let i = 0; i < cw * 4; i++) scratch[y * cw * 4 + i] = pixels[src + i];
    }
    const invR = 1 / (this.diameter / 2);
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < y0 || y > y1) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        if (x < x0 || x > x1) continue;
        const w = this.weight(Math.sqrt(dx * dx + dy * dy) * invR);
        if (w <= 0) continue;
        // Bilinear sample of the old pixels, from behind the brush's travel.
        const sx = Math.min(cw - 1, Math.max(0, x - x0 - mx * w));
        const sy = Math.min(ch - 1, Math.max(0, y - y0 - my * w));
        const ix = Math.min(cw - 2, Math.floor(sx)), iy = Math.min(ch - 2, Math.floor(sy));
        if (ix < 0 || iy < 0) continue;
        const fx = sx - ix, fy = sy - iy;
        const p = (y * this.width + x) * 4;
        const s00 = (iy * cw + ix) * 4, s10 = s00 + 4, s01 = s00 + cw * 4, s11 = s01 + 4;
        for (let k = 0; k < 4; k++) {
          const top = scratch[s00 + k] + (scratch[s10 + k] - scratch[s00 + k]) * fx;
          const bottom = scratch[s01 + k] + (scratch[s11 + k] - scratch[s01 + k]) * fx;
          pixels[p + k] = Math.max(0, Math.min(255, Math.round(top + (bottom - top) * fy)));
        }
      }
    }
    this.markDirty(cx, cy, r);
  }
}
