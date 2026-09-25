// Layer pixels on the GPU. An image is split into GL tiles of GL_TILE × GL_TILE pixels, each texture carrying an
// APRON of its neighbours' pixels so filtering across a seam matches the whole image. Tiles holding nothing but the
// image's fill value are never allocated. Reduced copies ("levels") are made by sharp 2× halvings, as the Mac app's
// DownsampleCache does, so zoomed-out views stay crisp; each level is itself a tiled image, rebuilt only where the
// full-size pixels change. A painted layer's new raster shares most tiles with the old one, so the cache patches
// the old textures instead of uploading everything again.
import type { GLContext, Target } from './context';
import { Raster, TILE_SIZE } from '../raster/raster';

export const GL_TILE = 1024;
export const APRON = 8;
/** Most halvings ever used (DownsampleCache.maxLevel). */
export const MAX_LEVEL = 6;

export interface PixelRect { x: number; y: number; width: number; height: number }

const COPY_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform ivec2 u_offset;
uniform ivec4 u_clamp;
uniform bool u_useFill;
uniform vec4 u_fill;
out vec4 o;
void main() {
  if (u_useFill) { o = u_fill; return; }
  ivec2 p = clamp(ivec2(gl_FragCoord.xy) + u_offset, u_clamp.xy, u_clamp.zw);
  o = texelFetch(u_src, p, 0);
}`;

// One level-k pixel from the 8 × 8 level-(k − 1) pixels around it, Lanczos-2 weighted. Colour images fade to
// transparency beyond their edges (the Mac pads them so); masks repeat their edge pixels.
const HALVE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform ivec2 u_srcOrigin;
uniform ivec2 u_srcSize;
uniform ivec2 u_dstOrigin;
uniform bool u_mask;
out vec4 o;
const float W[8] = float[8](-0.0089, -0.0419, 0.1165, 0.4343, 0.4343, 0.1165, -0.0419, -0.0089);
void main() {
  ivec2 d = ivec2(gl_FragCoord.xy) + u_dstOrigin;
  ivec2 s0 = d * 2 - 3;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    vec4 row = vec4(0.0);
    for (int i = 0; i < 8; i++) {
      ivec2 q = s0 + ivec2(i, j);
      if (u_mask) q = clamp(q, ivec2(0), u_srcSize - 1);
      else if (q.x < 0 || q.y < 0 || q.x >= u_srcSize.x || q.y >= u_srcSize.y) continue;
      row += texelFetch(u_src, q - u_srcOrigin, 0) * W[i];
    }
    sum += row * W[j];
  }
  if (u_mask) { o = vec4(clamp(sum.r, 0.0, 1.0)); return; }
  float a = clamp(sum.a, 0.0, 1.0);
  o = vec4(clamp(sum.rgb, vec3(0.0), vec3(a)), a);
}`;

export class GLTile {
  texture: WebGLTexture | null = null;
  framebuffer: WebGLFramebuffer | null = null;
  constructor(readonly index: number, readonly col: number, readonly row: number,
              readonly x: number, readonly y: number, readonly width: number, readonly height: number) {}
  get texWidth(): number { return this.width + APRON * 2; }
  get texHeight(): number { return this.height + APRON * 2; }
  get materialized(): boolean { return this.texture !== null; }
}

const fillBuffers = new Map<string, Uint8Array>();
function fillBuffer(channels: number, value: number, pixels: number): Uint8Array {
  const key = `${channels}:${value}`;
  let buffer = fillBuffers.get(key);
  if (!buffer || buffer.length < pixels * channels) {
    buffer = new Uint8Array(Math.max(pixels, TILE_SIZE * TILE_SIZE) * channels);
    if (value) buffer.fill(value);
    fillBuffers.set(key, buffer);
  }
  return buffer;
}

function intersect(a: PixelRect, b: PixelRect): PixelRect | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export class GLImage {
  readonly cols: number;
  readonly rows: number;
  readonly tiles: GLTile[];
  /** Levels 1…k, built on demand. */
  private levelImages: GLImage[] = [];
  /** Level-0 rects changed since each built level was last brought up to date (index k − 1). */
  private pendingLevels: PixelRect[][] = [];
  bytes = 0;
  lastUsed = 0;
  disposed = false;

  constructor(readonly ctx: GLContext, readonly width: number, readonly height: number, readonly channels: 1 | 4,
              readonly fill: number, readonly level = 0) {
    this.cols = Math.ceil(width / GL_TILE);
    this.rows = Math.ceil(height / GL_TILE);
    this.tiles = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const x = col * GL_TILE, y = row * GL_TILE;
        this.tiles.push(new GLTile(row * this.cols + col, col, row, x, y, Math.min(GL_TILE, width - x), Math.min(GL_TILE, height - y)));
      }
    }
  }

  get isMask(): boolean { return this.channels === 1; }

  /** Total bytes of this image and its levels. */
  get totalBytes(): number { return this.levelImages.reduce((n, image) => n + image.bytes, this.bytes); }

  tileAt(col: number, row: number): GLTile | null {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    return this.tiles[row * this.cols + col];
  }

  // MARK: Allocation

  /** Allocates a tile's texture, cleared to the fill value. */
  materialize(tile: GLTile): void {
    if (tile.texture) return;
    const gl = this.ctx.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.isMask ? gl.R8 : gl.RGBA8, tile.texWidth, tile.texHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    tile.texture = texture;
    this.bytes += tile.texWidth * tile.texHeight * this.channels;
    const target = this.tileTarget(tile);
    const f = this.fill / 255;
    this.ctx.clear(target, f, this.isMask ? 0 : f, this.isMask ? 0 : f, this.isMask ? 1 : f);
  }

  /** The tile as a render target (its whole texture, apron included). */
  tileTarget(tile: GLTile): Target {
    const gl = this.ctx.gl;
    if (!tile.texture) this.materialize(tile);
    if (!tile.framebuffer) {
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tile.texture, 0);
      tile.framebuffer = framebuffer;
    }
    return { texture: tile.texture!, framebuffer: tile.framebuffer, width: tile.texWidth, height: tile.texHeight, format: this.isMask ? 'r8' : 'rgba8' };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.ctx.gl;
    for (const tile of this.tiles) {
      if (tile.framebuffer) gl.deleteFramebuffer(tile.framebuffer);
      if (tile.texture) gl.deleteTexture(tile.texture);
      tile.framebuffer = null;
      tile.texture = null;
    }
    this.bytes = 0;
    for (const image of this.levelImages) image.dispose();
    this.levelImages = [];
    this.pendingLevels = [];
  }

  // MARK: Uploads

  /** A new image holding `raster`'s pixels. */
  static fromRaster(ctx: GLContext, raster: Raster): GLImage {
    const image = new GLImage(ctx, raster.width, raster.height, raster.channels, raster.fill < 0 ? 0 : raster.fill);
    image.uploadRaster(raster, null);
    return image;
  }

  /** Uploads `raster` (the same size as this image): every tile, or only the raster tiles listed. */
  uploadRaster(raster: Raster, changed: number[] | null): void {
    if (raster.width !== this.width || raster.height !== this.height || raster.channels !== this.channels) {
      throw new Error('Raster does not match the image');
    }
    const gl = this.ctx.gl;
    const format = this.isMask ? gl.RED : gl.RGBA;
    const rasterTilesPerGL = GL_TILE / TILE_SIZE;
    const byGLTile = new Map<number, number[]>();
    const indices = changed ?? raster.tiles.map((_, i) => i);
    for (const index of indices) {
      const tx = index % raster.cols, ty = Math.floor(index / raster.cols);
      const key = Math.floor(ty / rasterTilesPerGL) * this.cols + Math.floor(tx / rasterTilesPerGL);
      const list = byGLTile.get(key);
      if (list) list.push(index); else byGLTile.set(key, [index]);
    }
    const dirty: PixelRect[] = [];
    for (const [key, list] of byGLTile) {
      const tile = this.tiles[key];
      let uploads = list;
      if (!tile.texture) {
        // Only tiles with content are allocated; a newly allocated one gets all of its pixels.
        if (!list.some((i) => raster.tiles[i])) continue;
        this.materialize(tile);
        uploads = [];
        const tx0 = tile.x / TILE_SIZE, ty0 = tile.y / TILE_SIZE;
        for (let ty = ty0; ty < Math.min(raster.rows, ty0 + rasterTilesPerGL); ty++) {
          for (let tx = tx0; tx < Math.min(raster.cols, tx0 + rasterTilesPerGL); tx++) uploads.push(ty * raster.cols + tx);
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      for (const index of uploads) {
        const r = raster.tileRect(index);
        const data = raster.tiles[index] ?? fillBuffer(this.channels, raster.fill < 0 ? 0 : raster.fill, r.width * r.height);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x - tile.x + APRON, r.y - tile.y + APRON, r.width, r.height, format, gl.UNSIGNED_BYTE,
          data.subarray(0, r.width * r.height * this.channels));
        dirty.push(r);
      }
    }
    this.changed(dirty);
  }

  /** Uploads pixels for `rect` (level 0, inside the image), allocating tiles as needed. */
  uploadPixels(rect: PixelRect, data: Uint8Array, initialize?: (tile: GLTile) => void): void {
    const gl = this.ctx.gl;
    const format = this.isMask ? gl.RED : gl.RGBA;
    const c = this.channels;
    for (const tile of this.tilesIn(rect)) {
      if (!tile.texture) {
        this.materialize(tile);
        initialize?.(tile);
      }
      const part = intersect(rect, tile)!;
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      if (part.x === rect.x && part.width === rect.width) {
        const start = (part.y - rect.y) * rect.width * c;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, part.x - tile.x + APRON, part.y - tile.y + APRON, part.width, part.height, format,
          gl.UNSIGNED_BYTE, data.subarray(start, start + part.width * part.height * c));
      } else {
        const rows = new Uint8Array(part.width * part.height * c);
        for (let y = 0; y < part.height; y++) {
          const src = ((part.y - rect.y + y) * rect.width + (part.x - rect.x)) * c;
          rows.set(data.subarray(src, src + part.width * c), y * part.width * c);
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, part.x - tile.x + APRON, part.y - tile.y + APRON, part.width, part.height, format,
          gl.UNSIGNED_BYTE, rows);
      }
    }
    this.changed([rect]);
  }

  tilesIn(rect: PixelRect): GLTile[] {
    const c0 = Math.max(0, Math.floor(rect.x / GL_TILE)), c1 = Math.min(this.cols - 1, Math.floor((rect.x + rect.width - 1) / GL_TILE));
    const r0 = Math.max(0, Math.floor(rect.y / GL_TILE)), r1 = Math.min(this.rows - 1, Math.floor((rect.y + rect.height - 1) / GL_TILE));
    const result: GLTile[] = [];
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) result.push(this.tiles[row * this.cols + col]);
    return result;
  }

  /** After interior pixels in `rects` changed: neighbours' aprons and every built level follow. */
  changed(rects: PixelRect[]): void {
    if (!rects.length) return;
    this.refreshApronsNear(rects);
    for (const pending of this.pendingLevels) pending.push(...rects);
  }

  // MARK: Copies

  /** Copies (or fills) `rect` of `dest`'s texture (texel coordinates) from `source` tile, where texel p of
   *  `dest` reads texel p + offset of `source`, clamped to `source`'s interior. */
  private copyPiece(dest: GLTile, rect: PixelRect, source: GLTile | null, offsetX: number, offsetY: number, fill: number,
                    sourceImage: GLImage): void {
    const ctx = this.ctx, gl = ctx.gl;
    const program = ctx.program('image-copy', COPY_FRAGMENT);
    const target = this.tileTarget(dest);
    ctx.use(program, target, target.width, target.height);
    if (source?.texture) {
      ctx.bindTexture(0, source.texture);
      gl.uniform1i(ctx.uniform(program, 'u_src'), 0);
      gl.uniform1i(ctx.uniform(program, 'u_useFill'), 0);
      gl.uniform2i(ctx.uniform(program, 'u_offset'), offsetX, offsetY);
      gl.uniform4i(ctx.uniform(program, 'u_clamp'), APRON, APRON, APRON + source.width - 1, APRON + source.height - 1);
    } else {
      const f = fill / 255;
      // Nothing is sampled, but the sampler must not name a texture being drawn into (a feedback loop WebGL refuses).
      ctx.bindTexture(0, null);
      gl.uniform1i(ctx.uniform(program, 'u_src'), 0);
      gl.uniform1i(ctx.uniform(program, 'u_useFill'), 1);
      gl.uniform4f(ctx.uniform(program, 'u_fill'), f, sourceImage.isMask ? 0 : f, sourceImage.isMask ? 0 : f, sourceImage.isMask ? 1 : f);
    }
    ctx.drawRect(rect.x, rect.y, rect.width, rect.height);
  }

  /** Brings the aprons of every tile whose apron overlaps `rects` up to date with its neighbours. */
  private refreshApronsNear(rects: PixelRect[]): void {
    const tiles = new Map<GLTile, PixelRect[]>();
    for (const rect of rects) {
      const grown = { x: rect.x - APRON, y: rect.y - APRON, width: rect.width + APRON * 2, height: rect.height + APRON * 2 };
      for (const tile of this.tilesIn(grown)) {
        if (!tile.texture) continue;
        const list = tiles.get(tile);
        if (list) list.push(rect); else tiles.set(tile, [rect]);
      }
    }
    for (const [tile, near] of tiles) {
      if (near.length > 4) this.refreshAprons(tile);
      else for (const rect of near) this.refreshAprons(tile, rect);
    }
  }

  /** Copies neighbours' pixels into `tile`'s apron (only the parts overlapping `near`, when given). Aprons past
   *  the image's edges are never read. */
  refreshAprons(tile: GLTile, near: PixelRect | null = null): void {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const neighbour = this.tileAt(tile.col + dc, tile.row + dr);
        if (!neighbour) continue;
        // The apron piece in image pixels.
        const x0 = dc < 0 ? tile.x - APRON : dc > 0 ? tile.x + tile.width : tile.x;
        const y0 = dr < 0 ? tile.y - APRON : dr > 0 ? tile.y + tile.height : tile.y;
        let piece: PixelRect | null = { x: x0, y: y0, width: dc ? APRON : tile.width, height: dr ? APRON : tile.height };
        piece = intersect(piece, neighbour);
        if (piece && near) piece = intersect(piece, { x: near.x - APRON, y: near.y - APRON, width: near.width + APRON * 2, height: near.height + APRON * 2 });
        if (!piece) continue;
        const rect = { x: piece.x - tile.x + APRON, y: piece.y - tile.y + APRON, width: piece.width, height: piece.height };
        // dest texel t ↔ image pixel t + tile.x − APRON ↔ neighbour texel (image pixel) − neighbour.x + APRON.
        this.copyPiece(tile, rect, neighbour.texture ? neighbour : null, tile.x - neighbour.x, tile.y - neighbour.y, this.fill, this);
      }
    }
  }

  /** Fills this image's tile `dest` (level 0) with `source`'s pixels, `source` sitting at `offset` in this image's grid
   *  (whole pixels). Pixels `source` doesn't cover keep what they had. */
  copyFrom(source: GLImage, offsetX: number, offsetY: number, dest: GLTile): void {
    const region = { x: dest.x - APRON, y: dest.y - APRON, width: dest.texWidth, height: dest.texHeight };
    for (const tile of source.tiles) {
      const placed = { x: tile.x + offsetX, y: tile.y + offsetY, width: tile.width, height: tile.height };
      const part = intersect(placed, region);
      if (!part) continue;
      if (!tile.texture && source.fill === this.fill) continue;
      const rect = { x: part.x - region.x, y: part.y - region.y, width: part.width, height: part.height };
      // dest texel t ↔ grid pixel t + region.x ↔ source pixel − offset ↔ source texel + APRON − tile.x.
      this.copyPiece(dest, rect, tile.texture ? tile : null, region.x - offsetX - tile.x + APRON, region.y - offsetY - tile.y + APRON,
        source.fill, source);
    }
  }

  // MARK: Levels

  /** The image reduced by `level` halvings (this image for 0), brought up to date. */
  levelImage(level: number): GLImage {
    if (level <= 0 || this.level !== 0) return this;
    level = Math.min(level, MAX_LEVEL);
    for (let k = 1; k <= level; k++) {
      const parent = k === 1 ? this : this.levelImages[k - 2];
      if (parent.width <= 1 && parent.height <= 1) return parent;
      let image = this.levelImages[k - 1];
      if (!image) {
        image = new GLImage(this.ctx, Math.ceil(parent.width / 2), Math.ceil(parent.height / 2), this.channels, this.fill, k);
        this.levelImages[k - 1] = image;
        this.pendingLevels[k - 1] = [];
        image.halveAll(parent);
      } else if (this.pendingLevels[k - 1].length) {
        // Changes reach level k through each coarser level: grow the level-0 rects by the halving's support.
        const scale = 1 << k;
        const rects = this.pendingLevels[k - 1].map((r) => {
          const x0 = Math.floor((r.x - 4 * (scale - 1)) / scale) - 1, y0 = Math.floor((r.y - 4 * (scale - 1)) / scale) - 1;
          const x1 = Math.ceil((r.x + r.width + 4 * (scale - 1)) / scale) + 1, y1 = Math.ceil((r.y + r.height + 4 * (scale - 1)) / scale) + 1;
          return intersect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { x: 0, y: 0, width: image!.width, height: image!.height });
        }).filter((r): r is PixelRect => !!r);
        this.pendingLevels[k - 1] = [];
        image.halveRegions(parent, mergeRects(rects));
      }
    }
    return this.levelImages[level - 1] ?? this;
  }

  /** Builds every tile from `parent` (one level finer). */
  private halveAll(parent: GLImage): void {
    this.halveRegions(parent, [{ x: 0, y: 0, width: this.width, height: this.height }]);
  }

  /** Recomputes `rects` (this level's pixels) from `parent`, allocating tiles whose sources hold content. */
  private halveRegions(parent: GLImage, rects: PixelRect[]): void {
    const done: PixelRect[] = [];
    for (const tile of this.tiles) {
      const sources = this.sourceTiles(parent, tile);
      const materialized = sources.some((s) => s.texture);
      if (!materialized && !tile.texture) continue;
      const fresh = !tile.texture;
      if (fresh) this.materialize(tile);
      const areas = fresh ? [{ x: tile.x, y: tile.y, width: tile.width, height: tile.height }]
        : rects.map((r) => intersect(r, tile)).filter((r): r is PixelRect => !!r);
      if (!areas.length) continue;
      for (const source of sources) {
        // Destination pixels whose centre (2d + 1) falls in this source tile.
        const own = { x: Math.ceil(source.x / 2), y: Math.ceil(source.y / 2),
          width: Math.ceil((source.x + source.width) / 2) - Math.ceil(source.x / 2),
          height: Math.ceil((source.y + source.height) / 2) - Math.ceil(source.y / 2) };
        for (const area of areas) {
          const part = intersect(own, area);
          if (!part) continue;
          const rect = { x: part.x - tile.x + APRON, y: part.y - tile.y + APRON, width: part.width, height: part.height };
          if (source.texture) this.halvePiece(tile, rect, parent, source);
          else this.copyPiece(tile, rect, null, 0, 0, parent.fill, parent);
        }
      }
      done.push(...areas);
    }
    if (done.length) this.refreshApronsNear(done);
  }

  private sourceTiles(parent: GLImage, tile: GLTile): GLTile[] {
    const result: GLTile[] = [];
    const c0 = Math.floor(tile.x * 2 / GL_TILE), c1 = Math.floor((tile.x * 2 + tile.width * 2 - 1) / GL_TILE);
    const r0 = Math.floor(tile.y * 2 / GL_TILE), r1 = Math.floor((tile.y * 2 + tile.height * 2 - 1) / GL_TILE);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const source = parent.tileAt(col, row);
        if (source) result.push(source);
      }
    }
    return result;
  }

  private halvePiece(dest: GLTile, rect: PixelRect, parent: GLImage, source: GLTile): void {
    const ctx = this.ctx, gl = ctx.gl;
    const program = ctx.program('image-halve', HALVE_FRAGMENT);
    const target = this.tileTarget(dest);
    ctx.use(program, target, target.width, target.height);
    ctx.bindTexture(0, source.texture);
    gl.uniform1i(ctx.uniform(program, 'u_src'), 0);
    gl.uniform2i(ctx.uniform(program, 'u_srcOrigin'), source.x - APRON, source.y - APRON);
    gl.uniform2i(ctx.uniform(program, 'u_srcSize'), parent.width, parent.height);
    gl.uniform2i(ctx.uniform(program, 'u_dstOrigin'), dest.x - APRON, dest.y - APRON);
    gl.uniform1i(ctx.uniform(program, 'u_mask'), this.isMask ? 1 : 0);
    ctx.drawRect(rect.x, rect.y, rect.width, rect.height);
  }
}

/** Overlapping or touching rects merged, and many rects collapsed into their bounds. */
export function mergeRects(rects: PixelRect[]): PixelRect[] {
  if (rects.length > 48) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
    }
    return [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }];
  }
  const result = rects.slice();
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i], b = result[j];
        if (a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height) {
          const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
          const x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height);
          // Merge only when the union doesn't add much area.
          if ((x1 - x0) * (y1 - y0) <= (a.width * a.height + b.width * b.height) * 1.5) {
            result[i] = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            result.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  return result;
}

// MARK: Cache

/** GL images for rasters, least recently used dropped beyond a byte budget. A raster that shares most tiles with
 *  one no longer on screen takes over its textures and uploads only the tiles that differ. */
export class GLImageCache {
  private entries = new Map<Raster, GLImage>();
  frame = 0;
  budget: number;

  constructor(readonly ctx: GLContext, budget = 1024 * 1024 * 1024) { this.budget = budget; }

  get(raster: Raster): GLImage {
    let image = this.entries.get(raster);
    if (image && !image.disposed) {
      image.lastUsed = this.frame;
      return image;
    }
    image = this.adoptSimilar(raster) ?? GLImage.fromRaster(this.ctx, raster);
    image.lastUsed = this.frame;
    this.entries.set(raster, image);
    this.evict();
    return image;
  }

  /** Registers an image already holding `raster`'s pixels (built on the GPU). */
  adopt(raster: Raster, image: GLImage): void {
    const old = this.entries.get(raster);
    if (old && old !== image) old.dispose();
    image.lastUsed = this.frame;
    this.entries.set(raster, image);
    this.evict();
  }

  has(raster: Raster): boolean { return this.entries.has(raster); }

  private adoptSimilar(raster: Raster): GLImage | null {
    let best: { raster: Raster; image: GLImage; shared: number } | null = null;
    for (const [candidate, image] of this.entries) {
      if (image.lastUsed >= this.frame || candidate.width !== raster.width || candidate.height !== raster.height
          || candidate.channels !== raster.channels || candidate.fill !== raster.fill) continue;
      let shared = 0;
      for (let i = 0; i < raster.tiles.length; i++) if (candidate.tiles[i] === raster.tiles[i]) shared++;
      if (shared * 2 < raster.tiles.length) continue;
      if (!best || shared > best.shared) best = { raster: candidate, image, shared };
    }
    if (!best) return null;
    this.entries.delete(best.raster);
    const changed: number[] = [];
    for (let i = 0; i < raster.tiles.length; i++) if (best.raster.tiles[i] !== raster.tiles[i]) changed.push(i);
    if (changed.length) best.image.uploadRaster(raster, changed);
    return best.image;
  }

  private evict(): void {
    let total = 0;
    for (const image of this.entries.values()) total += image.totalBytes;
    if (total <= this.budget) return;
    const candidates = [...this.entries].filter(([, image]) => image.lastUsed < this.frame).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [raster, image] of candidates) {
      if (total <= this.budget) break;
      total -= image.totalBytes;
      image.dispose();
      this.entries.delete(raster);
    }
  }

  /** Drops images for rasters nothing uses any more. */
  retainOnly(live: Set<Raster>): void {
    for (const [raster, image] of this.entries) {
      if (live.has(raster) || image.lastUsed >= this.frame - 1) continue;
      image.dispose();
      this.entries.delete(raster);
    }
  }

  clear(): void {
    for (const image of this.entries.values()) image.dispose();
    this.entries.clear();
  }
}
