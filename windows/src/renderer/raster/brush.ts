// Tiled raster edits of one layer's pixels or mask: brush strokes (paint, erase, clone, blur, spot-healing wash),
// gradients, fills, clearing, and moving selected pixels. A port of BrushStroke.swift together with the Metal
// kernel's continuous coverage model: soft paint integrates deposition along the stroke's path (so it doesn't
// depend on how many pointer events arrive), hard paint keeps an antialiased silhouette, and the provisional tail
// to the pointer is kept apart from settled paint so replacing it never leaves anything behind.
// Only touched 256 × 256 tiles are allocated; the stroke's grid is the layer's pixel grid grown to cover the canvas,
// aligned so its tiles line up with the layer's own raster tiles (unchanged tiles are shared on commit).
import { Affine, Point, Rect, applyPoint, applyRect, concat, hypot, integral, intersection, invert, translatedBy, union } from '../model/geometry';
import { LayerTransform, center, pixelToDocument as transformPixelToDocument } from '../model/transform';
import type { Layer } from '../model/document';
import type { BrushSettings } from '../model/settings';
import { Raster, TILE_SIZE, alphaBounds } from './raster';
import { SelectionClip, clipCoverageInGrid } from './rasterize';
import { spotHeal } from './kernels/heal';

export class TooLargeError extends Error {
  constructor() { super('This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.'); }
}

/** Soft-brush falloff between the hardness radius and the rim: a normalized Gaussian reaching zero at the rim. */
export function falloff(u: number): number {
  const k = 2.5;
  return Math.max(0, (Math.exp(-k * u * u) - Math.exp(-k)) / (1 - Math.exp(-k)));
}

/** Soft tips deposit at 2.5% of their diameter per step, hard ones 1.5%. */
export const spacingFraction = (hardness: number) => (hardness >= 1 ? 0.015 : 0.025);

interface Segment { x0: number; y0: number; x1: number; y1: number }
const segment = (a: Point, b: Point): Segment => ({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });

// MARK: Soft-tip integral table

/** Normalized density of a soft tip at distance ρ (in radii) from its center. */
function tipDensityNormalized(rho: number, hardness: number): number {
  const t = Math.min(1, Math.max(0, (rho - hardness) / (1 - hardness)));
  const coverage = rho >= 1 ? 0 : falloff(t);
  return -Math.log(Math.max(1 - coverage, 0.001));
}

const TABLE_A = 160, TABLE_B = 320;
const tableCache = new Map<number, Float32Array>();

/** g[a][b] = ∫₀^{b/B} density(√((a/A)² + v²)) dv, in radii. */
function integralTable(hardness: number): Float32Array {
  const key = Math.round(hardness * 1000);
  const cached = tableCache.get(key);
  if (cached) return cached;
  const table = new Float32Array((TABLE_A + 1) * (TABLE_B + 1));
  const substeps = 6;
  for (let a = 0; a <= TABLE_A; a++) {
    const perp = a / TABLE_A;
    let sum = 0;
    let previous = tipDensityNormalized(perp, hardness);
    table[a * (TABLE_B + 1)] = 0;
    for (let b = 1; b <= TABLE_B; b++) {
      for (let s = 1; s <= substeps; s++) {
        const v = (b - 1 + s / substeps) / TABLE_B;
        const value = tipDensityNormalized(Math.sqrt(perp * perp + v * v), hardness);
        sum += (previous + value) * 0.5 / (TABLE_B * substeps);
        previous = value;
      }
      table[a * (TABLE_B + 1) + b] = sum;
    }
  }
  if (tableCache.size > 16) tableCache.clear();
  tableCache.set(key, table);
  return table;
}

function tableLookup(table: Float32Array, perp: number, x: number): number {
  const sign = x < 0 ? -1 : 1;
  const fa = Math.min(TABLE_A, perp * TABLE_A), fb = Math.min(TABLE_B, Math.abs(x) * TABLE_B);
  const a0 = Math.min(TABLE_A - 1, fa | 0), b0 = Math.min(TABLE_B - 1, fb | 0);
  const ta = fa - a0, tb = fb - b0;
  const row0 = a0 * (TABLE_B + 1), row1 = row0 + TABLE_B + 1;
  const top = table[row0 + b0] + (table[row0 + b0 + 1] - table[row0 + b0]) * tb;
  const bottom = table[row1 + b0] + (table[row1 + b0 + 1] - table[row1 + b0]) * tb;
  return sign * (top + (bottom - top) * ta);
}

// MARK: The stroke

interface Tile {
  rect: Rect;
  /** The tile as the edit currently leaves it. */
  pixels: Uint8Array;
  /** The original content, or null where nothing was there (transparent, or a mask's fill). */
  base: Uint8Array;
}

export interface CloneSource {
  /** Document-sized sample. */
  image: Raster;
  /** From each painted point to its source, in document pixels. */
  offset: { width: number; height: number };
}

export interface RasterEditResult {
  raster: Raster;
  transform: LayerTransform;
  /** The committed pixels' bounds in the stroke's grid. */
  bounds: Rect;
}

export class BrushStroke {
  readonly layer: Layer;
  readonly isMask: boolean;
  readonly channels: 1 | 4;
  readonly width: number;
  readonly height: number;
  readonly settings: BrushSettings;
  readonly canvas: Rect;
  /** The stroke's grid (with its extent's offset) onto the document. */
  readonly pixelToDocument: Affine;
  private readonly documentToPixel: Affine;
  /** The layer's (or mask's) original pixels within the grid. */
  readonly sourceRect: Rect;
  readonly paintTransform: LayerTransform;
  private readonly source: Raster | null;
  private readonly sourceAligned: boolean;
  private readonly paintValues: number[];
  pixelLimit = 100_000_000;
  selectionClip: SelectionClip | null = null;
  clone: CloneSource | null = null;
  isBlur = false;
  replacesWithClone = false;
  editName: string | null = null;

  private readonly tiles = new Map<number, Tile>();
  private readonly permanent = new Map<number, Float32Array>();
  private readonly preview = new Map<number, Uint8Array>();
  private readonly selectionCache = new Map<number, Uint8Array>();
  private allocatedBounds: Rect | null = null;
  private samples: Point[] = [];
  private previousTail: Segment[] = [];
  /** Tiles changed since the display last uploaded them. */
  readonly dirtyTiles = new Set<number>();
  readonly columns: number;
  private readonly radius: number;
  private readonly antialias: number;
  private readonly spacing: number;
  private readonly table: Float32Array | null;
  private readonly fillValue: number;

  constructor(layer: Layer, mask: boolean, settings: BrushSettings, canvasWidth: number, canvasHeight: number) {
    this.layer = layer;
    this.isMask = mask;
    this.channels = mask ? 1 : 4;
    this.settings = settings;
    this.canvas = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
    const placedMask = mask && layer.mask?.placement ? layer.mask : null;
    const base = placedMask?.placement ?? layer.transform;
    const originalWidth = placedMask ? placedMask.asset.image.width : layer.asset?.image.width ?? Math.round(layer.transform.size.width);
    const originalHeight = placedMask ? placedMask.asset.image.height : layer.asset?.image.height ?? Math.round(layer.transform.size.height);
    if (!(originalWidth >= 1 && originalWidth <= 30_000 && originalHeight >= 1 && originalHeight <= 30_000)) throw new TooLargeError();
    const originalMapping = transformPixelToDocument(base, originalWidth, originalHeight);
    const originalBounds: Rect = { x: 0, y: 0, width: originalWidth, height: originalHeight };
    let extent = mask ? originalBounds : union(originalBounds, integral(applyRect(invert(originalMapping), this.canvas)));
    // Line the grid's tiles up with the original raster's tiles.
    const left = Math.min(0, extent.x), top = Math.min(0, extent.y);
    const alignedLeft = -Math.ceil(-left / TILE_SIZE) * TILE_SIZE, alignedTop = -Math.ceil(-top / TILE_SIZE) * TILE_SIZE;
    extent = { x: alignedLeft, y: alignedTop, width: extent.x + extent.width - alignedLeft, height: extent.y + extent.height - alignedTop };
    this.width = extent.width;
    this.height = extent.height;
    this.sourceRect = { x: -extent.x, y: -extent.y, width: originalWidth, height: originalHeight };
    this.pixelToDocument = translatedBy(originalMapping, extent.x, extent.y);
    this.documentToPixel = invert(this.pixelToDocument);
    const expandedSize = { width: this.width * base.size.width / originalWidth, height: this.height * base.size.height / originalHeight };
    const middle = applyPoint(originalMapping, { x: extent.x + extent.width / 2, y: extent.y + extent.height / 2 });
    this.paintTransform = { ...base, size: expandedSize, origin: { x: middle.x - expandedSize.width / 2, y: middle.y - expandedSize.height / 2 } };
    if (!(this.width >= 1 && this.width <= 1_000_000_000 && this.height >= 1 && this.height <= 1_000_000_000)
        || !(settings.diameter >= 1 && settings.diameter <= 2000) || !(settings.hardness >= 0 && settings.hardness <= 1)
        || !(settings.opacity >= 0.01 && settings.opacity <= 1)) throw new TooLargeError();
    this.source = mask ? layer.mask?.asset.image ?? null : layer.asset?.image ?? null;
    this.sourceAligned = !!this.source && this.source.width === originalWidth && this.source.height === originalHeight;
    this.paintValues = mask ? [Math.round(settings.red * 255)] : [Math.round(settings.red * 255), Math.round(settings.green * 255), Math.round(settings.blue * 255)];
    this.columns = Math.ceil(this.width / TILE_SIZE);
    this.radius = settings.diameter / 2;
    const m = this.pixelToDocument;
    this.antialias = Math.max(0.001, Math.min(hypot(m.a, m.b), hypot(m.c, m.d)));
    this.spacing = Math.max(0.25, settings.diameter * spacingFraction(settings.hardness));
    this.table = settings.hardness >= 1 ? null : integralTable(settings.hardness);
    // Where a mask has no pixels of its own (a uniform mask stretched over the layer), its tiles hold that value.
    this.fillValue = mask && this.source && !this.sourceAligned && this.source.width === 1 && this.source.height === 1
      ? this.source.pixel(0, 0)[0] : 0;
  }

  get patchCount(): number { return this.tiles.size; }
  get hasEdits(): boolean { return this.tiles.size > 0; }
  tileRect(key: number): Rect {
    const tx = key % this.columns, ty = Math.floor(key / this.columns);
    const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
    return { x, y, width: Math.min(TILE_SIZE, this.width - x), height: Math.min(TILE_SIZE, this.height - y) };
  }
  /** The tile's current pixels, if the edit has touched it. */
  tilePixels(key: number): Uint8Array | null { return this.tiles.get(key)?.pixels ?? null; }
  editedTileKeys(): number[] { return [...this.tiles.keys()]; }
  get sourceRaster(): Raster | null { return this.source; }
  get isSourceAligned(): boolean { return this.sourceAligned; }
  get uniformFill(): number { return this.fillValue; }

  // MARK: Tiles

  /** The layer's original content for a tile of the grid. */
  baseContent(rect: Rect): Uint8Array {
    const c = this.channels;
    const out = new Uint8Array(rect.width * rect.height * c);
    const source = this.source;
    if (!source) return out;
    const s = this.sourceRect;
    if (this.sourceAligned) {
      const region = source.readRegion(rect.x - s.x, rect.y - s.y, rect.width, rect.height, this.isMask ? 0 : 0);
      if (this.isMask) {
        // Outside the mask's own pixels a covering mask has nothing to say; strokes only reach inside.
        return region;
      }
      return region;
    }
    // A mask of another size stretched over the layer's grid, sampled nearest (as Core Graphics draws it).
    if (this.fillValue && source.width === 1 && source.height === 1) {
      const inside = intersection(rect, s);
      if (inside) {
        for (let y = inside.y; y < inside.y + inside.height; y++) {
          out.fill(this.fillValue, ((y - rect.y) * rect.width + inside.x - rect.x) * c, ((y - rect.y) * rect.width + inside.x + inside.width - rect.x) * c);
        }
      }
      return out;
    }
    const sx = source.width / s.width, sy = source.height / s.height;
    for (let y = 0; y < rect.height; y++) {
      const gy = rect.y + y - s.y;
      if (gy < 0 || gy >= s.height) continue;
      const py = Math.min(source.height - 1, Math.floor((gy + 0.5) * sy));
      const row = source.readRegion(0, py, source.width, 1);
      for (let x = 0; x < rect.width; x++) {
        const gx = rect.x + x - s.x;
        if (gx < 0 || gx >= s.width) continue;
        const px = Math.min(source.width - 1, Math.floor((gx + 0.5) * sx));
        for (let k = 0; k < c; k++) out[(y * rect.width + x) * c + k] = row[px * c + k];
      }
    }
    return out;
  }

  private allocateTile(key: number): Tile {
    const existing = this.tiles.get(key);
    if (existing) return existing;
    const rect = this.tileRect(key);
    const next = this.allocatedBounds ? union(this.allocatedBounds, rect) : (this.source ? union(this.sourceRect, rect) : rect);
    if (next.width > 30_000 || next.height > 30_000 || next.width * next.height > this.pixelLimit) throw new TooLargeError();
    this.allocatedBounds = next;
    const base = this.baseContent(rect);
    const tile: Tile = { rect, pixels: base.slice(), base };
    this.tiles.set(key, tile);
    return tile;
  }

  private keysIn(area: Rect | null): number[] {
    if (!area) return [];
    const r = intersection(integral(area), { x: 0, y: 0, width: this.width, height: this.height });
    if (!r || r.width <= 0 || r.height <= 0) return [];
    const keys: number[] = [];
    for (let ty = Math.floor(r.y / TILE_SIZE); ty <= Math.floor((r.y + r.height - 1) / TILE_SIZE); ty++) {
      for (let tx = Math.floor(r.x / TILE_SIZE); tx <= Math.floor((r.x + r.width - 1) / TILE_SIZE); tx++) keys.push(ty * this.columns + tx);
    }
    return keys;
  }

  /** Selection coverage over a tile, in the stroke's grid (all 255 without a selection). */
  private selectionCoverage(key: number, rect: Rect): Uint8Array | null {
    if (!this.selectionClip) return null;
    const cached = this.selectionCache.get(key);
    if (cached) return cached;
    const coverage = clipCoverageInGrid(this.selectionClip, this.pixelToDocument, this.documentToPixel, rect.x, rect.y, rect.width, rect.height);
    this.selectionCache.set(key, coverage);
    return coverage;
  }

  private insideCanvas(px: number, py: number): boolean {
    const m = this.pixelToDocument;
    const x = m.a * px + m.c * py + m.tx, y = m.b * px + m.d * py + m.ty;
    return x >= 0 && y >= 0 && x < this.canvas.width && y < this.canvas.height;
  }

  // MARK: Continuous strokes

  append(point: Point): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 10_000_000 || Math.abs(point.y) > 10_000_000) return;
    const last = this.samples[this.samples.length - 1];
    if (last && last.x === point.x && last.y === point.y) return;
    this.samples.push(point);
    if (this.samples.length > 4) this.samples.shift();
    const n = this.samples.length, s = this.samples;
    let settled: Segment[] = [];
    if (n === 1) settled = [segment(point, point)];
    else if (n >= 3) settled = continuousCurve(s[n - 3], s[n - 2], s[Math.max(0, n - 4)], point);
    const tail = n >= 2 ? [segment(s[n - 2], point)] : [];
    this.render(settled, tail);
  }

  /** Replaces the provisional tail with the stroke's final curve piece. Safe to repeat. */
  flush(): void {
    const n = this.samples.length, s = this.samples;
    if (n < 2) {
      if (this.previousTail.length) this.render([], []);
      return;
    }
    const settled = continuousCurve(s[n - 2], s[n - 1], s[Math.max(0, n - 3)], s[n - 1]);
    this.render(settled, []);
    this.samples = [s[n - 1]];
  }

  private segmentsBounds(segments: Segment[]): Rect | null {
    let r: Rect | null = null;
    const reach = this.radius + 2;
    for (const g of segments) {
      const box = { x: Math.min(g.x0, g.x1) - reach, y: Math.min(g.y0, g.y1) - reach, width: Math.abs(g.x1 - g.x0) + reach * 2, height: Math.abs(g.y1 - g.y0) + reach * 2 };
      const clipped = intersection(box, this.canvas);
      if (!clipped || clipped.width <= 0 || clipped.height <= 0) continue;
      const inGrid = applyRect(this.documentToPixel, clipped);
      r = r ? union(r, inGrid) : inGrid;
    }
    return r;
  }

  private render(settled: Segment[], tail: Segment[]): void {
    const areas = [this.segmentsBounds(settled), this.segmentsBounds(tail), this.segmentsBounds(this.previousTail)].filter((a): a is Rect => !!a);
    this.previousTail = tail;
    if (!areas.length) return;
    let area = areas[0];
    for (const a of areas.slice(1)) area = union(area, a);
    const region = intersection(integral(area), { x: 0, y: 0, width: this.width, height: this.height });
    if (!region || region.width <= 0 || region.height <= 0) return;
    const m = this.pixelToDocument;
    const hard = this.settings.hardness >= 1;
    const r = this.radius, r2 = r * r;
    const prepared = (segments: Segment[]) => segments.map((g) => {
      const vx = g.x1 - g.x0, vy = g.y1 - g.y0, length = Math.sqrt(vx * vx + vy * vy);
      return { ...g, length, dx: length > 1e-6 ? vx / length : 0, dy: length > 1e-6 ? vy / length : 0 };
    });
    const settledP = prepared(settled), tailP = prepared(tail);
    for (const key of this.keysIn(region)) {
      const tile = this.allocateTile(key);
      let permanent = this.permanent.get(key);
      let preview = this.preview.get(key);
      if (!permanent || !preview) {
        permanent = new Float32Array(tile.rect.width * tile.rect.height);
        preview = new Uint8Array(tile.rect.width * tile.rect.height);
        this.permanent.set(key, permanent);
        this.preview.set(key, preview);
      }
      const local = intersection(region, tile.rect)!;
      for (let py = local.y; py < local.y + local.height; py++) {
        for (let px = local.x; px < local.x + local.width; px++) {
          const index = (py - tile.rect.y) * tile.rect.width + (px - tile.rect.x);
          const lx = px + 0.5, ly = py + 0.5;
          const x = m.a * lx + m.c * ly + m.tx, y = m.b * lx + m.d * ly + m.ty;
          if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) { preview[index] = 0; continue; }
          if (hard) {
            let settledD = Infinity, tailD = Infinity;
            for (const g of settledP) settledD = Math.min(settledD, segmentDistanceSquared(x, y, g));
            for (const g of tailP) tailD = Math.min(tailD, segmentDistanceSquared(x, y, g));
            const value = Math.max(permanent[index], this.hardCoverage(settledD));
            permanent[index] = value;
            preview[index] = Math.round(255 * Math.max(value, this.hardCoverage(tailD)));
          } else {
            let value = permanent[index], tailValue = 0;
            for (const g of settledP) value += this.segmentDensity(x, y, g, r2);
            for (const g of tailP) tailValue += this.segmentDensity(x, y, g, r2);
            permanent[index] = Math.min(value, 20);
            preview[index] = Math.round(255 * (1 - Math.exp(-Math.min(value + tailValue, 20))));
          }
        }
      }
      this.compose(key, tile, local);
    }
  }

  private hardCoverage(distanceSquared: number): number {
    if (!Number.isFinite(distanceSquared)) return 0;
    return Math.min(1, Math.max(0, (this.radius - Math.sqrt(distanceSquared)) / this.antialias + 0.5));
  }

  private segmentDensity(x: number, y: number, g: { x0: number; y0: number; length: number; dx: number; dy: number }, r2: number): number {
    const r = this.radius;
    const px = x - g.x0, py = y - g.y0;
    if (g.length < 1e-6) {
      const d2 = px * px + py * py;
      if (d2 >= r2) return 0;
      return tipDensityNormalized(Math.sqrt(d2) / r, this.settings.hardness);
    }
    const projection = px * g.dx + py * g.dy;
    const perpendicularSquared = Math.max(0, px * px + py * py - projection * projection);
    if (perpendicularSquared >= r2) return 0;
    const reach = Math.sqrt(r2 - perpendicularSquared);
    const lo = Math.max(0, projection - reach), hi = Math.min(g.length, projection + reach);
    if (hi <= lo) return 0;
    const perp = Math.sqrt(perpendicularSquared) / r;
    const integralValue = (tableLookup(this.table!, perp, (hi - projection) / r) - tableLookup(this.table!, perp, (lo - projection) / r)) * r;
    return integralValue / this.spacing;
  }

  /** Rebuilds part of a tile: the original, then the stroke's paint through its coverage. */
  private compose(key: number, tile: Tile, local: Rect): void {
    const coverage = this.preview.get(key);
    if (!coverage) return;
    const c = this.channels, w = tile.rect.width;
    const selection = this.selectionCoverage(key, tile.rect);
    const opacity = this.settings.opacity;
    const out = tile.pixels, base = tile.base;
    const clone = this.clone && (!this.isMask || this.isBlur) ? this.cloneSampler(local) : null;
    const healing = this.settings.healing && !this.isMask;
    const erasing = this.settings.erasing && !this.isMask;
    const paint = this.paintValues;
    for (let py = local.y; py < local.y + local.height; py++) {
      for (let px = local.x; px < local.x + local.width; px++) {
        const i = (py - tile.rect.y) * w + (px - tile.rect.x);
        const o = i * c;
        let cov = coverage[i] / 255;
        if (selection) cov *= selection[i] / 255;
        if (cov <= 0) { for (let k = 0; k < c; k++) out[o + k] = base[o + k]; continue; }
        if (clone) {
          const s = clone(px, py);
          const alpha = cov * opacity;
          if (c === 1) {
            out[o] = Math.round(this.replacesWithClone ? base[o] * (1 - cov) + s[0] * opacity * cov : base[o] * (1 - alpha) + s[0] * alpha);
          } else if (this.replacesWithClone) {
            for (let k = 0; k < 4; k++) out[o + k] = Math.round(base[o + k] * (1 - cov) + s[k] * opacity * cov);
          } else {
            const keep = 1 - s[3] / 255 * alpha;
            for (let k = 0; k < 4; k++) out[o + k] = Math.round(base[o + k] * keep + s[k] * alpha);
          }
        } else if (healing) {
          const alpha = cov * 0.45;
          const wash = 0.12 * 255;
          for (let k = 0; k < 3; k++) out[o + k] = Math.round(base[o + k] * (1 - alpha) + wash * alpha);
          out[o + 3] = Math.round(base[o + 3] * (1 - alpha) + 255 * alpha);
        } else if (erasing) {
          const keep = 1 - cov * opacity;
          for (let k = 0; k < 4; k++) out[o + k] = Math.round(base[o + k] * keep);
        } else {
          const alpha = cov * opacity;
          if (c === 1) out[o] = Math.round(base[o] * (1 - alpha) + paint[0] * alpha);
          else {
            for (let k = 0; k < 3; k++) out[o + k] = Math.round(base[o + k] * (1 - alpha) + paint[k] * alpha);
            out[o + 3] = Math.round(base[o + 3] * (1 - alpha) + 255 * alpha);
          }
        }
      }
    }
    this.dirtyTiles.add(key);
  }

  /** Bilinear sampling of the clone image for grid pixels in `area`; returns the sample at a grid pixel. */
  private cloneSampler(area: Rect): (px: number, py: number) => number[] {
    const clone = this.clone!;
    const image = clone.image;
    const docArea = applyRect(this.pixelToDocument, area);
    const x0 = Math.floor(docArea.x + clone.offset.width) - 2, y0 = Math.floor(docArea.y + clone.offset.height) - 2;
    const w = Math.ceil(docArea.width) + 5, h = Math.ceil(docArea.height) + 5;
    const c = image.channels;
    const region = image.readRegion(x0, y0, w, h, 0);
    const m = this.pixelToDocument;
    const out = [0, 0, 0, 0];
    return (px, py) => {
      const lx = px + 0.5, ly = py + 0.5;
      const sx = m.a * lx + m.c * ly + m.tx + clone.offset.width - 0.5 - x0;
      const sy = m.b * lx + m.d * ly + m.ty + clone.offset.height - 0.5 - y0;
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      out[0] = out[1] = out[2] = out[3] = 0;
      for (let j = 0; j < 2; j++) {
        const yy = iy + j;
        if (yy < 0 || yy >= h) continue;
        const wy = j ? fy : 1 - fy;
        if (wy === 0) continue;
        for (let i = 0; i < 2; i++) {
          const xx = ix + i;
          if (xx < 0 || xx >= w) continue;
          const weight = wy * (i ? fx : 1 - fx);
          if (weight === 0) continue;
          const p = (yy * w + xx) * c;
          for (let k = 0; k < c; k++) out[k] += region[p + k] * weight;
        }
      }
      return out;
    };
  }

  // MARK: Whole-canvas edits

  /** Runs `paint` for every grid pixel the canvas and selection cover (only the layer's own pixels with
   *  `withinSource`), starting from each tile's original content. `paint` gets the document point and
   *  the pixel offset in the tile, and the combined canvas/selection coverage (0–1). */
  private paintCanvas(withinSource: boolean, paint: (out: Uint8Array, base: Uint8Array, o: number, x: number, y: number, coverage: number) => void): void {
    let area: Rect | null = this.canvas;
    if (this.selectionClip) area = intersection(this.canvas, this.selectionClip.rect);
    if (!area || area.width <= 0 || area.height <= 0) return;
    let affected: Rect | null = intersection(integral(applyRect(this.documentToPixel, area)), { x: 0, y: 0, width: this.width, height: this.height });
    if (affected && withinSource) affected = intersection(affected, this.sourceRect);
    if (!affected || affected.width <= 0 || affected.height <= 0) return;
    const m = this.pixelToDocument;
    for (const key of this.keysIn(affected)) {
      const tile = this.allocateTile(key);
      tile.pixels.set(tile.base);
      const selection = this.selectionCoverage(key, tile.rect);
      const c = this.channels, w = tile.rect.width;
      const local = intersection(affected, tile.rect)!;
      for (let py = local.y; py < local.y + local.height; py++) {
        for (let px = local.x; px < local.x + local.width; px++) {
          const lx = px + 0.5, ly = py + 0.5;
          const x = m.a * lx + m.c * ly + m.tx, y = m.b * lx + m.d * ly + m.ty;
          if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) continue;
          const i = (py - tile.rect.y) * w + (px - tile.rect.x);
          const coverage = selection ? selection[i] / 255 : 1;
          if (coverage <= 0) continue;
          paint(tile.pixels, tile.base, i * c, x, y, coverage);
        }
      }
      this.dirtyTiles.add(key);
    }
  }

  /** A gradient over the canvas (or selection), composited onto the original pixels. `colors` are straight
   *  [r, g, b, a] (0–1) for the start and end; masks read r as gray. */
  fillGradient(radial: boolean, start: Point, end: Point, colors: [number[], number[]], opacity: number): void {
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy, radius = Math.sqrt(lengthSquared);
    const o = Math.min(1, Math.max(0, opacity));
    const [c0, c1] = colors;
    const c = this.channels;
    this.paintCanvas(false, (out, base, index, x, y, coverage) => {
      let t: number;
      if (radial) t = radius > 0 ? hypot(x - start.x, y - start.y) / radius : 1;
      else t = lengthSquared > 0 ? ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared : 0;
      t = Math.min(1, Math.max(0, t));
      const a = (c0[3] + (c1[3] - c0[3]) * t) * o * coverage;
      if (c === 1) {
        const g = (c0[0] + (c1[0] - c0[0]) * t) * 255;
        out[index] = Math.round(base[index] * (1 - a) + g * a);
      } else {
        for (let k = 0; k < 3; k++) {
          const v = (c0[k] + (c1[k] - c0[k]) * t) * 255;
          out[index + k] = Math.round(base[index + k] * (1 - a) + v * a);
        }
        out[index + 3] = Math.round(base[index + 3] * (1 - a) + 255 * a);
      }
    });
  }

  /** Fills the selection (or the whole canvas) with a solid color (0–1 components; masks use the first). */
  fill(color: number[]): void {
    const values = color.map((v) => v * 255);
    const c = this.channels;
    this.paintCanvas(false, (out, base, index, _x, _y, coverage) => {
      if (c === 1) out[index] = Math.round(base[index] * (1 - coverage) + values[0] * coverage);
      else {
        for (let k = 0; k < 3; k++) out[index + k] = Math.round(base[index + k] * (1 - coverage) + values[k] * coverage);
        out[index + 3] = Math.round(base[index + 3] * (1 - coverage) + 255 * coverage);
      }
    });
  }

  /** Erases image pixels to transparency inside the selection, only where pixels exist. */
  clearPixels(): void {
    this.paintCanvas(true, (out, base, index, _x, _y, coverage) => {
      for (let k = 0; k < 4; k++) out[index + k] = Math.round(base[index + k] * (1 - coverage));
    });
  }

  // MARK: Moving selected pixels

  private lifted: { pixels: Uint8Array; rect: Rect } | null = null;
  private moveTiles = new Set<number>();

  /** Cuts the selected pixels out of the original image. False when nothing is lifted. */
  liftSelection(): boolean {
    if (this.isMask || !this.source || !this.selectionClip || !this.selectionClip.coverage) return false;
    const region = intersection(integral(applyRect(this.documentToPixel, this.selectionClip.rect)), this.sourceRect);
    if (!region || region.width < 1 || region.height < 1) return false;
    const pixels = this.baseContent(region);
    const coverage = clipCoverageInGrid(this.selectionClip, this.pixelToDocument, this.documentToPixel, region.x, region.y, region.width, region.height);
    for (let i = 0; i < coverage.length; i++) {
      const s = coverage[i] / 255;
      if (s >= 1) continue;
      for (let k = 0; k < 4; k++) pixels[i * 4 + k] = Math.round(pixels[i * 4 + k] * s);
    }
    this.lifted = { pixels, rect: region };
    return true;
  }

  /** The selection becomes a hole (unless duplicating) and the lifted pixels land `offset` document pixels away. */
  moveLifted(offset: { width: number; height: number }, duplicate = false): void {
    const lifted = this.lifted;
    if (!lifted || !this.selectionClip) return;
    const zero = applyPoint(this.documentToPixel, { x: 0, y: 0 });
    const moved = applyPoint(this.documentToPixel, { x: offset.width, y: offset.height });
    const tx = moved.x - zero.x, ty = moved.y - zero.y;
    const target = { ...lifted.rect, x: lifted.rect.x + tx, y: lifted.rect.y + ty };
    const whole = Number.isInteger(target.x) && Number.isInteger(target.y);
    const needed = intersection(integral(union(lifted.rect, target)), { x: 0, y: 0, width: this.width, height: this.height });
    const keys = new Set(this.moveTiles);
    for (const key of this.keysIn(needed)) { this.allocateTile(key); keys.add(key); }
    for (const key of keys) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      const out = tile.pixels, w = tile.rect.width;
      out.set(tile.base);
      if (!duplicate) {
        const selection = this.selectionCoverage(key, tile.rect)!;
        for (let i = 0; i < selection.length; i++) {
          const keep = 1 - selection[i] / 255;
          if (keep >= 1) continue;
          for (let k = 0; k < 4; k++) out[i * 4 + k] = Math.round(out[i * 4 + k] * keep);
        }
      }
      // Draw the lifted pixels at `target` (source-over).
      const overlap = intersection(tile.rect, integral(target));
      if (!overlap || overlap.width <= 0 || overlap.height <= 0) continue;
      for (let py = overlap.y; py < overlap.y + overlap.height; py++) {
        for (let px = overlap.x; px < overlap.x + overlap.width; px++) {
          const sample = whole
            ? samplePixel(lifted.pixels, lifted.rect.width, lifted.rect.height, px - target.x, py - target.y)
            : sampleBilinear(lifted.pixels, lifted.rect.width, lifted.rect.height, px + 0.5 - target.x - 0.5, py + 0.5 - target.y - 0.5);
          if (!sample || sample[3] === 0) continue;
          const o = ((py - tile.rect.y) * w + (px - tile.rect.x)) * 4;
          const keep = 1 - sample[3] / 255;
          for (let k = 0; k < 4; k++) out[o + k] = Math.round(out[o + k] * keep + sample[k]);
        }
      }
      this.dirtyTiles.add(key);
    }
    this.moveTiles = keys;
  }

  // MARK: Spot healing

  /** Rebuilds the painted area from nearby texture and writes it into the stroke's tiles. Reads the original
   *  pixels, never the dark wash shown while painting. */
  heal(seed: number): void {
    if (!this.settings.healing || this.isMask) return;
    let painted: Rect | null = null;
    for (const [key, coverage] of this.preview) {
      const rect = this.tileRect(key);
      let x0 = rect.width, y0 = rect.height, x1 = 0, y1 = 0;
      for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
        if (!coverage[y * rect.width + x]) continue;
        if (x < x0) x0 = x; if (x + 1 > x1) x1 = x + 1; if (y < y0) y0 = y; if (y + 1 > y1) y1 = y + 1;
      }
      if (x1 <= x0 || y1 <= y0) continue;
      const r = { x: rect.x + x0, y: rect.y + y0, width: x1 - x0, height: y1 - y0 };
      painted = painted ? union(painted, r) : r;
    }
    if (!painted) return;
    const reach = (Math.max(painted.width, painted.height) + 32) * 3.2;
    const region = intersection(integral({ x: painted.x - reach, y: painted.y - reach, width: painted.width + reach * 2, height: painted.height + reach * 2 }),
      { x: 0, y: 0, width: this.width, height: this.height });
    if (!region) return;
    const w = region.width, h = region.height;
    const pixels = this.baseContent(region);
    const painting = new Uint8Array(w * h);
    for (const [key, coverage] of this.preview) {
      const rect = this.tileRect(key);
      const overlap = intersection(rect, region);
      if (!overlap) continue;
      for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
        for (let x = overlap.x; x < overlap.x + overlap.width; x++) {
          painting[(y - region.y) * w + (x - region.x)] = coverage[(y - rect.y) * rect.width + (x - rect.x)];
        }
      }
    }
    const modes = ['Content-Aware', 'Create Texture', 'Proximity Match'];
    spotHeal(pixels, painting, w, h, this.settings.opacity, Math.max(0, modes.indexOf(this.settings.healingMode)), seed);
    for (const key of this.preview.keys()) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      const out = tile.pixels, tw = tile.rect.width;
      out.set(tile.base);
      const selection = this.selectionCoverage(key, tile.rect);
      const overlap = intersection(tile.rect, region);
      if (!overlap) continue;
      for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
        for (let x = overlap.x; x < overlap.x + overlap.width; x++) {
          const i = (y - tile.rect.y) * tw + (x - tile.rect.x);
          const s = selection ? selection[i] / 255 : 1;
          if (s <= 0) continue;
          const src = ((y - region.y) * w + (x - region.x)) * 4;
          for (let k = 0; k < 4; k++) out[i * 4 + k] = Math.round(out[i * 4 + k] * (1 - s) + pixels[src + k] * s);
        }
      }
      this.dirtyTiles.add(key);
    }
  }

  // MARK: Results

  get committedBounds(): Rect { return integral(this.allocatedBounds ?? this.sourceRect); }

  /** The transform placing grid bounds `bounds` on the document. */
  transformFor(bounds: Rect): LayerTransform {
    const middle = applyPoint(this.pixelToDocument, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    const size = { width: bounds.width * this.paintTransform.size.width / this.width, height: bounds.height * this.paintTransform.size.height / this.height };
    return { ...this.paintTransform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
  }

  /** Pixels of the grid in `rect`, edited tiles first, the original elsewhere. */
  readRegion(rect: Rect): Uint8Array {
    const c = this.channels;
    const out = this.baseContent(rect);
    for (const [key, tile] of this.tiles) {
      const overlap = intersection(tile.rect, rect);
      if (!overlap || overlap.width <= 0 || overlap.height <= 0) continue;
      for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
        const src = ((y - tile.rect.y) * tile.rect.width + (overlap.x - tile.rect.x)) * c;
        out.set(tile.pixels.subarray(src, src + overlap.width * c), ((y - rect.y) * rect.width + (overlap.x - rect.x)) * c);
      }
      void key;
    }
    return out;
  }

  /** The edit as a new raster for the layer (or mask). Painting keeps at least the original bounds and adds any
   *  paint beyond them (`trimToAlpha` false); fills and clears trim to what is there. */
  result(trimToAlpha: boolean): RasterEditResult {
    let bounds: Rect | null = null;
    if (this.isMask) bounds = this.sourceRect;
    else {
      if (!trimToAlpha && this.source) bounds = this.sourceRect;
      const areas: Rect[] = [];
      if (trimToAlpha && this.source) {
        // Everything that could hold pixels: the original and every edited tile.
        const full = this.readRegion(this.sourceRect);
        const b = alphaBounds(full, this.sourceRect.width, this.sourceRect.height);
        if (b) areas.push({ ...b, x: b.x + this.sourceRect.x, y: b.y + this.sourceRect.y });
      }
      for (const tile of this.tiles.values()) {
        const b = alphaBounds(tile.pixels, tile.rect.width, tile.rect.height);
        if (b) areas.push({ x: tile.rect.x + b.x, y: tile.rect.y + b.y, width: b.width, height: b.height });
      }
      for (const a of areas) bounds = bounds ? union(bounds, a) : a;
    }
    const crop = integral(bounds ?? this.committedBounds);
    const raster = this.rasterFor(crop);
    return { raster, transform: this.transformFor(crop), bounds: crop };
  }

  /** A raster of the grid's `crop`, sharing the original's unchanged tiles when it lines up with them. */
  private rasterFor(crop: Rect): Raster {
    const source = this.source;
    const s = this.sourceRect;
    if (source && this.sourceAligned && crop.x === s.x && crop.y === s.y && crop.width === s.width && crop.height === s.height) {
      const changes = new Map<number, Uint8Array | null>();
      const c = this.channels;
      for (const [key, tile] of this.tiles) {
        const overlap = intersection(tile.rect, crop);
        if (!overlap || overlap.width <= 0 || overlap.height <= 0) continue;
        const tx = Math.floor((overlap.x - crop.x) / TILE_SIZE), ty = Math.floor((overlap.y - crop.y) / TILE_SIZE);
        const index = ty * source.cols + tx;
        const target = source.tileRect(index);
        const pixels = new Uint8Array(target.width * target.height * c);
        for (let y = 0; y < target.height; y++) {
          const src = ((target.y + crop.y + y - tile.rect.y) * tile.rect.width + (target.x + crop.x - tile.rect.x)) * c;
          pixels.set(tile.pixels.subarray(src, src + target.width * c), y * target.width * c);
        }
        changes.set(index, pixels);
        void key;
      }
      return source.withTiles(changes);
    }
    if (this.isMask && this.fillValue && !this.sourceAligned && crop.x === s.x && crop.y === s.y) {
      // A uniform mask painted for the first time: untouched tiles keep its value without being stored.
      const blank = Raster.blank(crop.width, crop.height, 1, this.fillValue);
      const changes = new Map<number, Uint8Array | null>();
      for (let index = 0; index < blank.tiles.length; index++) {
        const r = blank.tileRect(index);
        const gridRect = { x: r.x + crop.x, y: r.y + crop.y, width: r.width, height: r.height };
        if (!this.keysIn(gridRect).some((key) => this.tiles.has(key))) continue;
        changes.set(index, this.readRegion(gridRect));
      }
      return blank.withTiles(changes);
    }
    return Raster.fromData(crop.width, crop.height, this.channels, this.readRegion(crop), 0);
  }
}

// MARK: Geometry helpers

function segmentDistanceSquared(x: number, y: number, g: Segment): number {
  const vx = g.x1 - g.x0, vy = g.y1 - g.y0;
  const t = Math.min(1, Math.max(0, ((x - g.x0) * vx + (y - g.y0) * vy) / Math.max(vx * vx + vy * vy, 1e-12)));
  const dx = x - (g.x0 + t * vx), dy = y - (g.y0 + t * vy);
  return dx * dx + dy * dy;
}

/** Centripetal Catmull–Rom from `start` to `end`, split until within 0.2 document pixels of the curve. */
export function continuousCurve(start: Point, end: Point, before: Point, after: Point): Segment[] {
  const knot = (t: number, a: Point, b: Point) => t + Math.max(0.0001, Math.sqrt(hypot(b.x - a.x, b.y - a.y)));
  const mix = (a: Point, b: Point, ta: number, tb: number, t: number): Point => {
    const wa = (tb - t) / (tb - ta), wb = (t - ta) / (tb - ta);
    return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb };
  };
  const t0 = 0, t1 = knot(t0, before, start), t2 = knot(t1, start, end), t3 = knot(t2, end, after);
  const point = (u: number): Point => {
    if (u === 0) return start;
    if (u === 1) return end;
    const t = t1 + (t2 - t1) * u;
    const a = mix(before, start, t0, t1, t), b = mix(start, end, t1, t2, t), c = mix(end, after, t2, t3, t);
    return mix(mix(a, b, t0, t2, t), mix(b, c, t1, t3, t), t1, t2, t);
  };
  const result: Segment[] = [];
  const subdivide = (a: Point, b: Point, lo: number, hi: number, depth: number) => {
    const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
    const error = (p: Point) => {
      const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
      return hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    const mid = (lo + hi) / 2, m = point(mid);
    const deviation = Math.max(error(m), error(point((lo + mid) / 2)), error(point((mid + hi) / 2)));
    if (deviation <= 0.2 || depth >= 10) { result.push(segment(a, b)); return; }
    subdivide(a, m, lo, mid, depth + 1);
    subdivide(m, b, mid, hi, depth + 1);
  };
  subdivide(start, end, 0, 1, 0);
  return result;
}

function samplePixel(pixels: Uint8Array, width: number, height: number, x: number, y: number): number[] | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const p = (y * width + x) * 4;
  return [pixels[p], pixels[p + 1], pixels[p + 2], pixels[p + 3]];
}

function sampleBilinear(pixels: Uint8Array, width: number, height: number, x: number, y: number): number[] {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const out = [0, 0, 0, 0];
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= height) continue;
    const wy = j ? fy : 1 - fy;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= width) continue;
      const weight = wy * (i ? fx : 1 - fx);
      const p = (yy * width + xx) * 4;
      for (let k = 0; k < 4; k++) out[k] += pixels[p + k] * weight;
    }
  }
  return out;
}

/** Where a stroke's grid sits: the transform's center, for tests and callers that need it. */
export function strokeCenter(stroke: BrushStroke): Point { return center(stroke.paintTransform); }

export const _internals = { concat };
