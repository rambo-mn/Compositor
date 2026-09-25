// The one WebGL context the app draws with: the canvas view, and every operation that needs layers drawn into
// pixels (copying, merging, sampling, warping, thumbnails), so uploaded textures are shared by all of them.
import { CanvasRenderer } from '../gl/view';
import type { Compositor, Scene, SceneImage, SceneMask } from '../gl/compositor';
import { GLImage, mergeRects } from '../gl/images';
import type { WarpStroke } from '../session/warp';
import type { Target } from '../gl/context';
import type { Affine } from '../model/geometry';
import { Raster, unpremultiply } from '../raster/raster';
import type { BrushStroke } from '../raster/brush';

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform ivec2 u_dir;
uniform int u_radius;
uniform float u_sigma;
uniform ivec2 u_srcSize;
uniform ivec2 u_offset;   // source texel of output pixel (0, 0)
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + u_offset;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    total += w;
    ivec2 q = p + u_dir * i;
    if (q.x < 0 || q.y < 0 || q.x >= u_srcSize.x || q.y >= u_srcSize.y) continue;
    sum += texelFetch(u_src, q, 0) * w;
  }
  vec4 v = sum / total;
  o = vec4(min(v.rgb, vec3(v.a)), v.a);
}`;

interface StrokeEntry { image: GLImage; initialized: boolean }

export class GPU {
  readonly canvas: HTMLCanvasElement;
  readonly view: CanvasRenderer;
  private strokes = new WeakMap<BrushStroke, StrokeEntry>();
  private thumbnails = new WeakMap<Raster, Map<number, ImageData>>();
  private warps = new WeakMap<WarpStroke, GLImage>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'canvas-gl';
    this.view = new CanvasRenderer(this.canvas);
    this.view.onRestored = () => { this.strokes = new WeakMap(); this.thumbnails = new WeakMap(); };
  }

  get compositor(): Compositor { return this.view.compositor; }
  get ctx() { return this.view.ctx; }

  /** The composite of `scene` over the document region `rect`, at 1:1: premultiplied RGBA, rows top to bottom. */
  renderRegion(scene: Scene, rect: { x: number; y: number; width: number; height: number }): Uint8Array {
    return this.compositor.renderRegion(scene, rect);
  }

  /** `scene` drawn into a `width` × `height` grid through `docToOut` (document → grid pixels). */
  renderMapped(scene: Scene, width: number, height: number, docToOut: Affine): Uint8Array {
    return this.tiled(width, height, (target, x, y) => {
      this.compositor.render(scene, target, { ...docToOut, tx: docToOut.tx - x, ty: docToOut.ty - y });
    }, 4);
  }

  /** A mask's coverage drawn into a `width` × `height` grid through `docToOut`: one byte per pixel. */
  renderMask(mask: SceneMask, width: number, height: number, docToOut: Affine): Uint8Array {
    return this.tiled(width, height, (target, x, y) => {
      this.compositor.renderMask(mask, target, { ...docToOut, tx: docToOut.tx - x, ty: docToOut.ty - y });
    }, 1);
  }

  /** Runs `draw` over the output in GPU-sized tiles and gathers the result (`channels` 4, or 1 taking red). */
  private tiled(width: number, height: number, draw: (target: Target, x: number, y: number) => void, channels: 1 | 4): Uint8Array {
    const out = new Uint8Array(width * height * channels);
    const step = Math.min(4096, this.ctx.maxTextureSize);
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const w = Math.min(step, width - x), h = Math.min(step, height - y);
        const target = this.ctx.createTarget(w, h);
        try {
          draw(target, x, y);
          const pixels = this.ctx.read(target);
          for (let row = 0; row < h; row++) {
            if (channels === 4) out.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4);
            else for (let col = 0; col < w; col++) out[(y + row) * width + x + col] = pixels[(row * w + col) * 4];
          }
        } finally {
          this.ctx.destroyTarget(target);
        }
      }
    }
    return out;
  }

  /** A Gaussian blur of `raster` (premultiplied RGBA or gray). Beyond the image a colour image is transparent;
   *  with `clampEdges` (masks) its edge pixels continue. */
  gaussianBlur(raster: Raster, sigma: number, clampEdges: boolean): Raster {
    if (!(sigma > 0.05)) return raster;
    const ctx = this.ctx, gl = ctx.gl;
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const width = raster.width, height = raster.height;
    const step = Math.max(64, Math.min(4096, ctx.maxTextureSize) - radius * 2 - 2);
    const out = new Uint8Array(width * height * raster.channels);
    const program = ctx.program('gaussian-blur', BLUR_FRAGMENT);
    for (let ty = 0; ty < height; ty += step) {
      for (let tx = 0; tx < width; tx += step) {
        const w = Math.min(step, width - tx), h = Math.min(step, height - ty);
        // The tile and a margin of the radius around it.
        const sx = tx - radius, sy = ty - radius, sw = w + radius * 2, sh = h + radius * 2;
        let data = clampEdges ? raster.readRegionClamped(sx, sy, sw, sh) : raster.readRegion(sx, sy, sw, sh, 0);
        if (raster.channels === 1) {
          const rgba = new Uint8Array(sw * sh * 4);
          for (let i = 0; i < sw * sh; i++) { const v = data[i]; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
          data = rgba;
        }
        const source = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, source);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, sw, sh);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, data);
        const across = ctx.createTarget(w, sh);
        const down = ctx.createTarget(w, h);
        try {
          ctx.use(program, across, w, sh);
          gl.disable(gl.BLEND);
          ctx.bindTexture(0, source);
          gl.uniform1i(ctx.uniform(program, 'u_src'), 0);
          gl.uniform2i(ctx.uniform(program, 'u_dir'), 1, 0);
          gl.uniform1i(ctx.uniform(program, 'u_radius'), radius);
          gl.uniform1f(ctx.uniform(program, 'u_sigma'), sigma);
          gl.uniform2i(ctx.uniform(program, 'u_srcSize'), sw, sh);
          gl.uniform2i(ctx.uniform(program, 'u_offset'), radius, 0);
          ctx.drawRect(0, 0, w, sh);
          ctx.use(program, down, w, h);
          ctx.bindTexture(0, across.texture);
          gl.uniform1i(ctx.uniform(program, 'u_src'), 0);
          gl.uniform2i(ctx.uniform(program, 'u_dir'), 0, 1);
          gl.uniform1i(ctx.uniform(program, 'u_radius'), radius);
          gl.uniform1f(ctx.uniform(program, 'u_sigma'), sigma);
          gl.uniform2i(ctx.uniform(program, 'u_srcSize'), w, sh);
          gl.uniform2i(ctx.uniform(program, 'u_offset'), 0, radius);
          ctx.drawRect(0, 0, w, h);
          const pixels = ctx.read(down);
          for (let row = 0; row < h; row++) {
            if (raster.channels === 4) out.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((ty + row) * width + tx) * 4);
            else for (let col = 0; col < w; col++) out[(ty + row) * width + tx + col] = pixels[(row * w + col) * 4];
          }
        } finally {
          ctx.destroyTarget(across);
          ctx.destroyTarget(down);
          gl.deleteTexture(source);
        }
      }
    }
    return Raster.fromData(width, height, raster.channels, out);
  }

  // MARK: Edits in progress

  /** The GPU copy of a raster edit in progress, brought up to date with the tiles it changed. */
  strokeImage(stroke: BrushStroke): GLImage {
    let entry = this.strokes.get(stroke);
    const source = stroke.sourceRaster;
    if (!entry || entry.image.disposed) {
      const fill = stroke.uniformFill || (stroke.isMask && source && stroke.isSourceAligned ? Math.max(0, source.fill) : 0);
      entry = { image: new GLImage(this.ctx, stroke.width, stroke.height, stroke.channels, fill), initialized: false };
      this.strokes.set(stroke, entry);
    }
    const image = entry.image;
    if (!entry.initialized) {
      entry.initialized = true;
      const s = stroke.sourceRect;
      if (source && stroke.isSourceAligned) {
        // The original pixels, copied on the GPU from the layer's own textures.
        const base = this.compositor.images.get(source);
        for (const tile of image.tilesIn(s)) {
          const covered = base.tiles.some((t) => t.texture && t.x + s.x < tile.x + tile.width + 8 && t.x + t.width + s.x > tile.x - 8
            && t.y + s.y < tile.y + tile.height + 8 && t.y + t.height + s.y > tile.y - 8);
          if (!covered) continue;
          image.materialize(tile);
          image.copyFrom(base, s.x, s.y, tile);
        }
      } else if (source && !stroke.uniformFill) {
        // A mask of another size stretched over the layer: its pixels as the stroke sees them.
        for (const tile of image.tilesIn(s)) {
          const part = intersectRects(tile, s);
          if (part) image.uploadPixels(part, stroke.baseContent(part));
        }
      }
    }
    if (stroke.dirtyTiles.size) {
      for (const key of stroke.dirtyTiles) {
        const pixels = stroke.tilePixels(key);
        if (pixels) image.uploadPixels(stroke.tileRect(key), pixels);
      }
      stroke.dirtyTiles.clear();
    }
    return image;
  }

  /** Frees a finished edit's textures. */
  releaseStroke(stroke: BrushStroke): void {
    const entry = this.strokes.get(stroke);
    if (entry) { entry.image.dispose(); this.strokes.delete(stroke); }
  }

  /** Hands a finished edit's textures to the raster it produced, when that raster is the same grid. */
  adoptStroke(stroke: BrushStroke, raster: Raster): boolean {
    const entry = this.strokes.get(stroke);
    if (!entry || entry.image.width !== raster.width || entry.image.height !== raster.height) return false;
    this.strokes.delete(stroke);
    this.compositor.images.adopt(raster, entry.image);
    return true;
  }

  /** The GPU copy of a Smudge or Liquify stroke's working pixels. */
  warpImage(warp: WarpStroke): GLImage {
    let image = this.warps.get(warp);
    if (!image || image.disposed) {
      image = new GLImage(this.ctx, warp.width, warp.height, 4, 0);
      image.uploadPixels({ x: 0, y: 0, width: warp.width, height: warp.height }, warp.pixels);
      warp.dirty.length = 0;
      this.warps.set(warp, image);
    }
    if (warp.dirty.length) {
      for (const rect of mergeRects(warp.dirty)) {
        const part = new Uint8Array(rect.width * rect.height * 4);
        for (let row = 0; row < rect.height; row++) {
          const start = ((rect.y + row) * warp.width + rect.x) * 4;
          part.set(warp.pixels.subarray(start, start + rect.width * 4), row * rect.width * 4);
        }
        image.uploadPixels(rect, part);
      }
      warp.dirty.length = 0;
    }
    return image;
  }

  releaseWarp(warp: WarpStroke): void {
    const image = this.warps.get(warp);
    if (image) { image.dispose(); this.warps.delete(warp); }
  }

  // MARK: Thumbnails

  /** A thumbnail of `raster` no larger than `limit` on its longest side, as straight-alpha ImageData. */
  thumbnail(raster: Raster, limit = 96): ImageData {
    let byLimit = this.thumbnails.get(raster);
    const cached = byLimit?.get(limit);
    if (cached) return cached;
    const factor = Math.min(1, limit / Math.max(raster.width, raster.height));
    const width = Math.max(1, Math.round(raster.width * factor)), height = Math.max(1, Math.round(raster.height * factor));
    const image: SceneImage = { raster, width: raster.width, height: raster.height,
      gridToDocument: { a: width / raster.width, b: 0, c: 0, d: height / raster.height, tx: 0, ty: 0 }, sampling: 'High quality' };
    let rgba: Uint8Array;
    if (raster.isMask) {
      const gray = this.renderMask({ image, outside: 0 }, width, height, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
      rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < gray.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray[i]; rgba[i * 4 + 3] = 255; }
    } else {
      rgba = this.renderRegion({ width, height, layers: [{ id: 't', parentID: null, isGroup: false, isVisible: true, image,
        opacity: 1, blendMode: 'Normal', mask: null, maskSourceID: null, adjustment: null }] }, { x: 0, y: 0, width, height });
      unpremultiply(rgba);
    }
    const data = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height);
    if (!byLimit) { byLimit = new Map(); this.thumbnails.set(raster, byLimit); }
    byLimit.set(limit, data);
    return data;
  }
}

function intersectRects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

let shared: GPU | null = null;
/** The app's GPU, created on first use. */
export function gpu(): GPU {
  shared ??= new GPU();
  return shared;
}
