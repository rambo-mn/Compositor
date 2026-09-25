// Immutable pixel storage. Images are split into 256 × 256 tiles; an edit produces a new Raster that shares every
// tile it didn't touch with the old one, so undo history holds only what changed (the Mac app's RasterSnapshot).
// RGBA rasters hold premultiplied sRGB, 4 bytes per pixel (R, G, B, A); gray rasters (masks) 1 byte per pixel.
// A null tile is uniformly `fill` (transparent for RGBA).

export const TILE_SIZE = 256;

let nextRasterId = 1;
export function newRasterId(): number { return nextRasterId++; }

export interface TileRect { x: number; y: number; width: number; height: number }

export class Raster {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly cols: number;
  readonly rows: number;
  readonly tiles: ReadonlyArray<Uint8Array | null>;
  /** The value every channel of a null tile holds. */
  readonly fill: number;

  constructor(width: number, height: number, channels: 1 | 4, tiles: ReadonlyArray<Uint8Array | null>, fill = 0) {
    if (!(width >= 1 && height >= 1)) throw new Error(`Invalid raster size ${width}×${height}`);
    this.id = newRasterId();
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.cols = Math.ceil(width / TILE_SIZE);
    this.rows = Math.ceil(height / TILE_SIZE);
    if (tiles.length !== this.cols * this.rows) throw new Error('Tile count mismatch');
    this.tiles = tiles;
    this.fill = fill;
  }

  get isMask(): boolean { return this.channels === 1; }
  get pixelCount(): number { return this.width * this.height; }

  tileRect(index: number): TileRect {
    const tx = index % this.cols, ty = Math.floor(index / this.cols);
    const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
    return { x, y, width: Math.min(TILE_SIZE, this.width - x), height: Math.min(TILE_SIZE, this.height - y) };
  }

  tileIndex(tx: number, ty: number): number { return ty * this.cols + tx; }

  static blank(width: number, height: number, channels: 1 | 4, fill = 0): Raster {
    const cols = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
    return new Raster(width, height, channels, new Array(cols * rows).fill(null), fill);
  }

  /** Splits contiguous pixels into tiles. Tiles entirely equal to `fill` are left null. */
  static fromData(width: number, height: number, channels: 1 | 4, data: Uint8Array | Uint8ClampedArray, fill = 0): Raster {
    const cols = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
    const tiles: (Uint8Array | null)[] = new Array(cols * rows);
    const rowBytes = width * channels;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
        const w = Math.min(TILE_SIZE, width - x), h = Math.min(TILE_SIZE, height - y);
        const tile = new Uint8Array(w * h * channels);
        let uniform = true;
        for (let row = 0; row < h; row++) {
          const start = (y + row) * rowBytes + x * channels;
          const slice = data.subarray(start, start + w * channels);
          tile.set(slice, row * w * channels);
          if (uniform) for (let i = 0; i < slice.length; i++) if (slice[i] !== fill) { uniform = false; break; }
        }
        tiles[ty * cols + tx] = uniform ? null : tile;
      }
    }
    return new Raster(width, height, channels, tiles, fill);
  }

  /** A 1 × 1 image, e.g. a reveal-all (255) or hide-all (0) mask. */
  static solid(channels: 1 | 4, values: number[]): Raster {
    return new Raster(1, 1, channels, [Uint8Array.from(values)], 0);
  }

  /** Every pixel in one contiguous array, rows top to bottom. */
  toData(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * this.channels);
    const rowBytes = this.width * this.channels;
    for (let i = 0; i < this.tiles.length; i++) {
      const r = this.tileRect(i);
      const tile = this.tiles[i];
      for (let row = 0; row < r.height; row++) {
        const start = (r.y + row) * rowBytes + r.x * this.channels;
        if (tile) out.set(tile.subarray(row * r.width * this.channels, (row + 1) * r.width * this.channels), start);
        else if (this.fill !== 0) out.fill(this.fill, start, start + r.width * this.channels);
      }
    }
    return out;
  }

  /** Pixels in `x, y, w, h`; anything outside the image reads as `outside` (default: the null-tile fill). */
  readRegion(x: number, y: number, w: number, h: number, outside = this.fill < 0 ? 0 : this.fill): Uint8Array {
    const c = this.channels;
    const out = new Uint8Array(w * h * c);
    if (outside !== 0) out.fill(outside);
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w), y1 = Math.min(this.height, y + h);
    if (x1 <= x0 || y1 <= y0) return out;
    const tx0 = Math.floor(x0 / TILE_SIZE), tx1 = Math.floor((x1 - 1) / TILE_SIZE);
    const ty0 = Math.floor(y0 / TILE_SIZE), ty1 = Math.floor((y1 - 1) / TILE_SIZE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const index = ty * this.cols + tx;
        const r = this.tileRect(index);
        const tile = this.tiles[index];
        const sx0 = Math.max(x0, r.x), sx1 = Math.min(x1, r.x + r.width);
        const sy0 = Math.max(y0, r.y), sy1 = Math.min(y1, r.y + r.height);
        for (let row = sy0; row < sy1; row++) {
          const dst = ((row - y) * w + (sx0 - x)) * c;
          if (tile) {
            const src = ((row - r.y) * r.width + (sx0 - r.x)) * c;
            out.set(tile.subarray(src, src + (sx1 - sx0) * c), dst);
          } else {
            out.fill(this.fill < 0 ? 0 : this.fill, dst, dst + (sx1 - sx0) * c);
          }
        }
      }
    }
    return out;
  }

  /** One pixel's channels; zeros outside the image. */
  pixel(x: number, y: number): number[] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return new Array(this.channels).fill(0);
    const tx = Math.floor(x / TILE_SIZE), ty = Math.floor(y / TILE_SIZE);
    const index = ty * this.cols + tx;
    const r = this.tileRect(index);
    const tile = this.tiles[index];
    if (!tile) return new Array(this.channels).fill(this.fill < 0 ? 0 : this.fill);
    const offset = ((y - r.y) * r.width + (x - r.x)) * this.channels;
    return Array.from(tile.subarray(offset, offset + this.channels));
  }

  /** A new raster with some tiles replaced (null clears a tile to the fill value). */
  withTiles(changes: Map<number, Uint8Array | null>): Raster {
    if (changes.size === 0) return this;
    const tiles = this.tiles.slice();
    for (const [index, tile] of changes) tiles[index] = tile;
    return new Raster(this.width, this.height, this.channels, tiles, this.fill);
  }

  /** A tile's pixels, allocated (filled) when the tile is null. Always a copy. */
  tileCopy(index: number): Uint8Array {
    const r = this.tileRect(index);
    const tile = this.tiles[index];
    if (tile) return tile.slice();
    const out = new Uint8Array(r.width * r.height * this.channels);
    if (this.fill > 0) out.fill(this.fill);
    return out;
  }

  /** Bytes held by tiles, not counting shared null tiles. */
  get byteCount(): number {
    let total = 0;
    for (const tile of this.tiles) if (tile) total += tile.byteLength;
    return total;
  }

  /** The part of the image in `rect` as a new raster of that size. */
  crop(x: number, y: number, w: number, h: number): Raster {
    return Raster.fromData(w, h, this.channels, this.readRegion(x, y, w, h), this.fill < 0 ? 0 : this.fill);
  }
}

// MARK: Pixel helpers

/** Premultiplies straight RGBA in place (ImageData → storage). */
export function premultiply(data: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) continue;
    if (a === 0) { data[i] = data[i + 1] = data[i + 2] = 0; continue; }
    data[i] = (data[i] * a + 127) / 255 | 0;
    data[i + 1] = (data[i + 1] * a + 127) / 255 | 0;
    data[i + 2] = (data[i + 2] * a + 127) / 255 | 0;
  }
}

/** Unpremultiplies RGBA in place (storage → ImageData / PNG). */
export function unpremultiply(data: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255 || a === 0) continue;
    data[i] = Math.min(255, (data[i] * 255 + (a >> 1)) / a | 0);
    data[i + 1] = Math.min(255, (data[i + 1] * 255 + (a >> 1)) / a | 0);
    data[i + 2] = Math.min(255, (data[i + 2] * 255 + (a >> 1)) / a | 0);
  }
}

/** Half-open bounds of nonzero alpha in premultiplied RGBA; null when fully transparent (brush_alpha_bounds). */
export function alphaBounds(data: Uint8Array, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  let left = width, right = 0, top = height, bottom = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = 0;
    while (first < width && data[row + first * 4 + 3] === 0) first++;
    if (first === width) continue;
    let last = width;
    while (last > first && data[row + (last - 1) * 4 + 3] === 0) last--;
    if (first < left) left = first;
    if (last > right) right = last;
    if (y < top) top = y;
    bottom = y + 1;
  }
  if (!right) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Bounds of nonzero alpha across a whole raster, scanning only non-null tiles. */
export function rasterAlphaBounds(raster: Raster): { x: number; y: number; width: number; height: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < raster.tiles.length; i++) {
    const tile = raster.tiles[i];
    if (!tile) continue;
    const r = raster.tileRect(i);
    const b = alphaBounds(tile, r.width, r.height);
    if (!b) continue;
    x0 = Math.min(x0, r.x + b.x); y0 = Math.min(y0, r.y + b.y);
    x1 = Math.max(x1, r.x + b.x + b.width); y1 = Math.max(y1, r.y + b.y + b.height);
  }
  if (x1 <= x0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** An area-averaged copy no larger than `limit` on its longest side (the Layers panel's thumbnails). */
export function thumbnailOf(raster: Raster, limit = 96): Raster {
  const factor = Math.min(1, limit / Math.max(raster.width, raster.height));
  const width = Math.max(1, Math.floor(raster.width * factor)), height = Math.max(1, Math.floor(raster.height * factor));
  if (width === raster.width && height === raster.height) return raster;
  return Raster.fromData(width, height, raster.channels, downsampleArea(raster, width, height), raster.fill < 0 ? 0 : raster.fill);
}

/** Box-filtered resize to a smaller size (each output pixel averages the source pixels it covers). */
export function downsampleArea(raster: Raster, width: number, height: number): Uint8Array {
  const c = raster.channels;
  const out = new Uint8Array(width * height * c);
  const sx = raster.width / width, sy = raster.height / height;
  // Process in bands of source rows so huge images are read a strip at a time.
  const sums = new Float64Array(width * c);
  const weights = new Float64Array(width);
  for (let oy = 0; oy < height; oy++) {
    const fy0 = oy * sy, fy1 = (oy + 1) * sy;
    const iy0 = Math.floor(fy0), iy1 = Math.min(raster.height, Math.ceil(fy1));
    sums.fill(0); weights.fill(0);
    const band = raster.readRegion(0, iy0, raster.width, iy1 - iy0);
    for (let iy = iy0; iy < iy1; iy++) {
      const wy = Math.min(fy1, iy + 1) - Math.max(fy0, iy);
      if (wy <= 0) continue;
      const rowOffset = (iy - iy0) * raster.width * c;
      for (let ox = 0; ox < width; ox++) {
        const fx0 = ox * sx, fx1 = (ox + 1) * sx;
        const ix0 = Math.floor(fx0), ix1 = Math.min(raster.width, Math.ceil(fx1));
        for (let ix = ix0; ix < ix1; ix++) {
          const wx = Math.min(fx1, ix + 1) - Math.max(fx0, ix);
          if (wx <= 0) continue;
          const w = wx * wy, p = rowOffset + ix * c;
          for (let k = 0; k < c; k++) sums[ox * c + k] += band[p + k] * w;
          weights[ox] += w;
        }
      }
    }
    for (let ox = 0; ox < width; ox++) {
      for (let k = 0; k < c; k++) out[(oy * width + ox) * c + k] = Math.round(sums[ox * c + k] / (weights[ox] || 1));
    }
  }
  return out;
}

/** Unique tile buffers across rasters, for memory accounting shared between history snapshots. */
export function collectTiles(raster: Raster | null | undefined, into: Set<Uint8Array>): void {
  if (!raster) return;
  for (const tile of raster.tiles) if (tile) into.add(tile);
}
