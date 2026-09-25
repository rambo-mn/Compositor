// Renders a document (or a preview of one) into a target: every visible layer in tree order, each clipped by its
// own mask, its folders' masks and any clipping-mask source, blended in its mode; clipping stacks composited as
// Photoshop does; adjustment layers applied to what is below them. A port of the drawing in EditorCanvas.drawLayers,
// LiveMaskRenderer, FolderMaskClip and ImageExporter, on the GPU. Coverage (masks, clips) is rendered into
// output-space textures first, so layer images, masks and their tiles never need to line up.
import type { GLContext, Target } from './context';
import { APRON, GLImage, GLImageCache, GLTile, MAX_LEVEL } from './images';
import {
  ADJUST_FRAGMENT, COMPOSITE_FRAGMENT, LAYER_FRAGMENT, MASK_FRAGMENT, MULTIPLY_FRAGMENT, OPAQUE_FRAGMENT, RESTORE_FRAGMENT,
} from './shaders';
import { Affine, invert } from '../model/geometry';
import { Matrix3, compose3, fromAffine, invert3, project } from '../model/projective';
import type { LayerSampling } from '../model/transform';
import type { LayerBlendMode } from '../model/document';
import { BLEND_MODES } from '../model/document';
import {
  LayerAdjustment, adjustmentExposure, adjustmentGradientMap, adjustmentGrain, curvesTables, exposureTables,
  gradientMapTable, hueSaturationCube, levelsIsIdentity, levelsTables, resolvedHSV, CUBE_DIMENSION, hsIsIdentity,
  curvesIsIdentity, exposureIsIdentity,
} from '../model/adjustments';
import type { Raster } from '../raster/raster';

/** Pixels placed on the document: a raster (uploaded on demand) or an image already on the GPU. */
export interface SceneImage {
  raster?: Raster | null;
  gl?: GLImage | null;
  /** The pixel grid's size (level 0). */
  width: number;
  height: number;
  /** Maps the grid (pixels, y down) onto the document. */
  gridToDocument: Affine;
  /** A perspective mapping of the grid onto the document, used instead of `gridToDocument` (a distortion). */
  projective?: Matrix3 | null;
  sampling: LayerSampling;
}

export interface SceneMask {
  image: SceneImage;
  /** 'clamp': the mask's edge continues beyond it (a layer's own mask); a number: coverage beyond it. */
  outside: 'clamp' | number;
  /** Grid rect (in the layer's grid) beyond which the mask doesn't apply: paint past a layer's old bounds. */
  limit?: { x: number; y: number; width: number; height: number } | null;
}

/** A colour adjustment previewed on one layer's own pixels (Levels, Curves… before they are applied). */
export interface ScenePreview {
  adjustment: LayerAdjustment;
  /** Document-space coverage limiting it (the selection), or null for everywhere. */
  clip: SceneMask | null;
}

export interface SceneLayer {
  id: string;
  parentID: string | null;
  isGroup: boolean;
  isVisible: boolean;
  image: SceneImage | null;
  opacity: number;
  blendMode: LayerBlendMode;
  /** A layer's own mask; for a folder, the mask clipping everything inside; for an adjustment, where it applies. */
  mask: SceneMask | null;
  maskSourceID: string | null;
  adjustment: LayerAdjustment | null;
  preview?: ScenePreview | null;
}

export interface Scene {
  width: number;
  height: number;
  /** Bottom to top, folders included. */
  layers: SceneLayer[];
}

interface Coverage { target: Target; channel: 0 | 3 }

const blendIndex = (mode: LayerBlendMode) => Math.max(0, BLEND_MODES.indexOf(mode));

/** Halvings to draw from when an image lands `factor` output pixels per image pixel (DownsampleCache.level). */
export function levelFor(factor: number): number {
  if (!(factor > 0) || !(factor < 0.5)) return 0;
  return Math.min(MAX_LEVEL, Math.floor(Math.log2(1 / factor)));
}

export class Compositor {
  readonly ctx: GLContext;
  readonly images: GLImageCache;
  private backdrop: Target | null = null;
  private frameTargets: Target[] = [];
  private adjustmentTextures = new Map<string, { key: string; table: WebGLTexture | null; cube: WebGLTexture | null }>();
  private emptyTexture: WebGLTexture;
  private emptyCube: WebGLTexture;

  constructor(ctx: GLContext, images?: GLImageCache) {
    this.ctx = ctx;
    this.images = images ?? new GLImageCache(ctx);
    const gl = ctx.gl;
    this.emptyTexture = ctx.createTable(new Float32Array(4), 1);
    this.emptyCube = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.emptyCube);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
  }

  // MARK: Frame

  private width = 0;
  private height = 0;
  private docToOut: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  private outToDoc: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  private scene: Scene | null = null;
  private byID = new Map<string, SceneLayer>();
  private ownMaskCache = new Map<string, Coverage | null>();
  private folderClipCache = new Map<string, Coverage | null>();
  private liveCache = new Map<string, Coverage | null>();
  private liveVisiting = new Set<string>();
  private stacks = new Map<string, string[]>();
  private stacked = new Set<string>();

  private acquire(): Target {
    const target = this.ctx.acquire(this.width, this.height);
    this.frameTargets.push(target);
    return target;
  }

  private backdropFor(target: Target): Target {
    if (!this.backdrop || this.backdrop.width !== target.width || this.backdrop.height !== target.height) {
      if (this.backdrop) this.ctx.destroyTarget(this.backdrop);
      this.backdrop = this.ctx.createTarget(target.width, target.height);
    }
    return this.backdrop;
  }

  /** Renders `scene` into `target` (cleared first). `docToOut` maps document pixels onto the target's pixels. */
  render(scene: Scene, target: Target, docToOut: Affine): void {
    this.images.frame += 1;
    this.width = target.width;
    this.height = target.height;
    this.docToOut = docToOut;
    this.outToDoc = invert(docToOut);
    this.scene = scene;
    this.byID = new Map(scene.layers.map((layer) => [layer.id, layer]));
    this.ownMaskCache.clear();
    this.folderClipCache.clear();
    this.liveCache.clear();
    this.liveVisiting.clear();
    this.stacks.clear();
    this.stacked.clear();
    this.ctx.clear(target, 0, 0, 0, 0);
    const order = renderOrder(scene.layers);
    this.prepareStacks(order);
    try {
      for (const id of order) {
        const clip = this.folderClip(this.byID.get(id)!.parentID);
        this.drawComposite(id, target, clip);
      }
    } finally {
      for (const t of this.frameTargets) this.ctx.release(t);
      this.frameTargets = [];
      this.scene = null;
    }
  }

  /** Renders a mask's coverage into `target` (every channel holds it). */
  renderMask(mask: SceneMask, target: Target, docToOut: Affine): void {
    this.images.frame += 1;
    this.width = target.width;
    this.height = target.height;
    this.docToOut = docToOut;
    this.outToDoc = invert(docToOut);
    const outside = mask.outside === 'clamp' ? 1 : mask.outside;
    this.ctx.clear(target, outside, outside, outside, 1);
    this.drawImage(mask.image, target, { mask: true, outside: mask.outside });
  }

  /** Clipping stacks share the base's alpha: a base (no source, not an adjustment) and the layers directly above
   *  it in the same folder that clip to it. (LiveMaskRenderer.prepareStacks) */
  private prepareStacks(ids: string[]): void {
    ids.forEach((base, index) => {
      const layer = this.byID.get(base)!;
      if (layer.maskSourceID || layer.adjustment) return;
      const children: string[] = [];
      for (const child of ids.slice(index + 1)) {
        const c = this.byID.get(child)!;
        if (c.maskSourceID !== base || c.parentID !== layer.parentID) break;
        children.push(child);
      }
      if (!children.length) return;
      this.stacks.set(base, children);
      for (const child of children) this.stacked.add(child);
    });
  }

  private drawComposite(id: string, target: Target, clip: Coverage | null): void {
    if (this.stacked.has(id)) return;
    const layer = this.byID.get(id)!;
    if (layer.adjustment) {
      if (!layer.maskSourceID) this.adjust(layer, target, this.combine([this.ownMask(layer, true), clip]));
      return;
    }
    const children = this.stacks.get(id);
    if (!children) { this.draw(id, target, clip); return; }
    const group = this.acquire();
    this.ctx.clear(group, 0, 0, 0, 0);
    this.drawOwn(layer, group, null);
    const opaque = this.acquire();
    this.fullPass(OPAQUE_FRAGMENT, 'stack-opaque', opaque, (program) => {
      this.bind(program, 'u_src', 0, group.texture);
    });
    for (const childID of children) {
      const child = this.byID.get(childID)!;
      if (child.adjustment) this.adjust(child, opaque, this.ownMask(child, true));
      else this.drawOwn(child, opaque, null);
    }
    const restored = this.acquire();
    this.fullPass(RESTORE_FRAGMENT, 'stack-restore', restored, (program) => {
      this.bind(program, 'u_src', 0, opaque.texture);
      this.bind(program, 'u_alpha', 1, group.texture);
    });
    this.composite(restored, target, layer.blendMode, clip);
  }

  /** A layer clipped by its clipping-mask source's coverage, if it has one. (LiveMaskRenderer.draw) */
  private draw(id: string, target: Target, clip: Coverage | null): void {
    const layer = this.byID.get(id)!;
    if (layer.maskSourceID) {
      const coverage = this.liveCoverage(layer.maskSourceID);
      if (!coverage) return;
      clip = this.combine([clip, coverage]);
    }
    this.drawOwn(layer, target, clip);
  }

  /** The alpha a layer leaves when drawn on its own (with its masks, opacity and its own clipping source),
   *  whether or not it is visible. */
  private liveCoverage(id: string): Coverage | null {
    if (this.liveCache.has(id)) return this.liveCache.get(id)!;
    if (this.liveVisiting.has(id) || this.liveVisiting.size >= 256) return null;
    const layer = this.byID.get(id);
    if (!layer) return null;
    this.liveVisiting.add(id);
    const target = this.acquire();
    this.ctx.clear(target, 0, 0, 0, 0);
    this.draw(id, target, null);
    this.liveVisiting.delete(id);
    const coverage: Coverage = { target, channel: 3 };
    this.liveCache.set(id, coverage);
    return coverage;
  }

  // MARK: Coverage

  /** The product of every enclosing folder's enabled mask. */
  private folderClip(folderID: string | null): Coverage | null {
    if (!folderID) return null;
    if (this.folderClipCache.has(folderID)) return this.folderClipCache.get(folderID)!;
    const folder = this.byID.get(folderID);
    let result: Coverage | null = null;
    if (folder) {
      const outer = this.folderClip(folder.parentID);
      const own = folder.mask ? this.maskCoverage(folder.mask, 0) : null;
      result = this.combine([own, outer]);
    }
    this.folderClipCache.set(folderID, result);
    return result;
  }

  /** A layer's own mask as output-space coverage. Adjustments and folders clip to their mask's bounds. */
  private ownMask(layer: SceneLayer, bounded = false): Coverage | null {
    if (!layer.mask) return null;
    const key = `${layer.id}:${bounded}`;
    if (this.ownMaskCache.has(key)) return this.ownMaskCache.get(key)!;
    const coverage = this.maskCoverage(layer.mask, bounded ? 0 : null);
    this.ownMaskCache.set(key, coverage);
    return coverage;
  }

  /** Renders a mask into a new coverage target. `outsideOverride` replaces the mask's own outside rule. */
  private maskCoverage(mask: SceneMask, outsideOverride: number | null): Coverage | null {
    const outside = outsideOverride ?? mask.outside;
    const target = this.acquire();
    this.ctx.clear(target, outside === 'clamp' ? 1 : outside, 0, 0, 1);
    this.drawImage(mask.image, target, { mask: true, outside });
    return { target, channel: 0 };
  }

  /** Multiplies coverages together (nulls mean full coverage). */
  private combine(parts: (Coverage | null)[]): Coverage | null {
    const present = parts.filter((p): p is Coverage => !!p);
    if (present.length === 0) return null;
    if (present.length === 1) return present[0];
    let current = present[0];
    for (const next of present.slice(1)) {
      const target = this.acquire();
      const a = current, b = next;
      this.fullPass(MULTIPLY_FRAGMENT, 'coverage-multiply', target, (program) => {
        const gl = this.ctx.gl;
        this.bind(program, 'u_a', 0, a.target.texture);
        gl.uniform1i(this.ctx.uniform(program, 'u_aChannel'), a.channel);
        this.bind(program, 'u_b', 1, b.target.texture);
        gl.uniform1i(this.ctx.uniform(program, 'u_bChannel'), b.channel);
        gl.uniform1i(this.ctx.uniform(program, 'u_hasB'), 1);
      });
      current = { target, channel: 0 };
    }
    return current;
  }

  // MARK: Layers

  /** Draws one layer's pixels with its opacity, own mask and blend mode, clipped by `clip`. */
  private drawOwn(layer: SceneLayer, target: Target, clip: Coverage | null): void {
    if (!layer.image) return;
    if (layer.preview && !adjustmentIsIdentity(layer.preview.adjustment)) {
      // Isolated: drawn plainly, adjusted where the preview's clip allows, then blended.
      const isolated = this.acquire();
      this.ctx.clear(isolated, 0, 0, 0, 0);
      this.drawImage(layer.image, isolated, {
        opacity: layer.opacity, ownMask: this.ownMask(layer), maskLimit: layer.mask?.limit ?? null, clip, blend: 0,
      });
      const previewClip = layer.preview.clip ? this.maskCoverage(layer.preview.clip, null) : null;
      this.adjust({ ...layer, adjustment: layer.preview.adjustment, opacity: 1, blendMode: 'Normal', mask: null }, isolated, previewClip);
      this.composite(isolated, target, layer.blendMode, null);
      return;
    }
    this.drawImage(layer.image, target, {
      opacity: layer.opacity, ownMask: this.ownMask(layer), maskLimit: layer.mask?.limit ?? null, clip, blend: blendIndex(layer.blendMode),
    });
  }

  private glImage(image: SceneImage): GLImage | null {
    if (image.gl && !image.gl.disposed) return image.gl;
    if (image.raster) return this.images.get(image.raster);
    return null;
  }

  /** Draws a tiled image (a layer's pixels or, with `mask`, a mask's coverage) into `target`. */
  drawImage(image: SceneImage, target: Target, options: {
    mask?: boolean; outside?: 'clamp' | number; opacity?: number; ownMask?: Coverage | null;
    maskLimit?: { x: number; y: number; width: number; height: number } | null; clip?: Coverage | null; blend?: number;
  }): void {
    const base = this.glImage(image);
    if (!base) return;
    const ctx = this.ctx, gl = ctx.gl;
    const gridToOut = compose3(image.projective ?? fromAffine(image.gridToDocument), fromAffine(this.docToOut));
    const outToGrid = invert3(gridToOut);
    if (!outToGrid) return;
    const map = (x: number, y: number) => project(gridToOut, { x, y });
    // Output pixels per grid pixel, along the grid's x axis at its middle (as LayerRenderer measures it).
    const middle = map(base.width / 2, base.height / 2), step = map(base.width / 2 + 1, base.height / 2);
    const factor = Math.hypot(step.x - middle.x, step.y - middle.y);
    const level = image.sampling === 'Nearest' ? 0 : levelFor(factor);
    const source = base.levelImage(level);
    const levelScale = 1 << source.level;
    const finalFactor = factor * levelScale;
    const sampling = image.sampling === 'Nearest' ? 0 : finalFactor <= 1 || image.sampling === 'Smooth' ? 1 : 2;
    const extentX = source.width * levelScale, extentY = source.height * levelScale;
    const isMask = !!options.mask;
    const blend = options.blend ?? 0;
    const useBackdrop = !isMask && blend > 0;
    // Grid pixels per output pixel (the largest across the image's corners), for the margins around each quad.
    let perOut = 0;
    for (const [x, y] of [[0, 0], [extentX, 0], [extentX, extentY], [0, extentY]]) {
      const p = map(x, y), q = project(outToGrid, { x: p.x + 1, y: p.y }), r = project(outToGrid, { x: p.x, y: p.y + 1 });
      perOut = Math.max(perOut, Math.hypot(q.x - x, q.y - y), Math.hypot(r.x - x, r.y - y));
    }
    if (!Number.isFinite(perOut)) return;
    const clampOutside = isMask && options.outside === 'clamp';
    // Seams are cut exactly by the shader; outer edges need room for their antialiased fringe.
    const near = 2 * perOut + 2;

    // The whole quad's bounds in the target, for the backdrop copy.
    if (useBackdrop) {
      const corners = [[-near, -near], [extentX + near, -near], [extentX + near, extentY + near], [-near, extentY + near]]
        .map(([x, y]) => map(x, y));
      const x0 = Math.floor(Math.min(...corners.map((p) => p.x))) - 1, y0 = Math.floor(Math.min(...corners.map((p) => p.y))) - 1;
      const x1 = Math.ceil(Math.max(...corners.map((p) => p.x))) + 1, y1 = Math.ceil(Math.max(...corners.map((p) => p.y))) + 1;
      if (x1 <= 0 || y1 <= 0 || x0 >= target.width || y0 >= target.height) return;
      ctx.copyRegion(target, this.backdropFor(target), x0, y0, x1 - x0, y1 - y0);
    }

    const program = isMask ? ctx.program('mask', MASK_FRAGMENT) : ctx.program('layer', LAYER_FRAGMENT);
    ctx.use(program, target, target.width, target.height);
    const u = (name: string) => ctx.uniform(program, name);
    const m = outToGrid;
    gl.uniformMatrix3fv(u('u_outToGrid'), false, new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]));
    gl.uniform1f(u('u_levelScale'), levelScale);
    gl.uniform2f(u('u_imageSize'), source.width, source.height);
    gl.uniform2f(u('u_extent'), extentX, extentY);
    gl.uniform1i(u('u_sampling'), sampling);
    gl.uniform1i(u('u_antialias'), image.sampling === 'Nearest' ? 0 : 1);
    gl.uniform1i(u('u_tex'), 0);
    if (isMask) {
      gl.uniform1i(u('u_clampOutside'), clampOutside ? 1 : 0);
      gl.uniform1f(u('u_outside'), typeof options.outside === 'number' ? options.outside : 1);
      gl.disable(gl.BLEND);
    } else {
      gl.uniform1f(u('u_opacity'), options.opacity ?? 1);
      this.bindCoverage(program, 'u_ownMask', 'u_hasOwnMask', null, 1, options.ownMask ?? null);
      gl.uniform1i(u('u_useMaskLimit'), options.maskLimit ? 1 : 0);
      if (options.maskLimit) {
        const l = options.maskLimit;
        gl.uniform4f(u('u_maskLimit'), l.x, l.y, l.width, l.height);
      }
      this.bindCoverage(program, 'u_clip', 'u_hasClip', 'u_clipChannel', 2, options.clip ?? null);
      if (useBackdrop) {
        gl.uniform1i(u('u_blend'), blend);
        this.bind(program, 'u_backdrop', 3, this.backdrop!.texture);
        gl.disable(gl.BLEND);
      } else {
        gl.uniform1i(u('u_blend'), -1);
        this.bind(program, 'u_backdrop', 3, this.emptyTexture);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    }
    for (const tile of source.tiles) {
      if (!tile.texture) {
        // Unallocated tiles hold the fill: nothing for colour; a mask's uniform value.
        if (!isMask) continue;
        gl.uniform1i(u('u_useFill'), 1);
        const f = source.fill / 255;
        gl.uniform4f(u('u_fill'), f, f, f, f);
        ctx.bindTexture(0, this.emptyTexture);
      } else {
        gl.uniform1i(u('u_useFill'), 0);
        ctx.bindTexture(0, tile.texture);
        gl.uniform2f(u('u_texOrigin'), tile.x - APRON, tile.y - APRON);
        gl.uniform2f(u('u_texSize'), tile.texWidth, tile.texHeight);
      }
      gl.uniform4f(u('u_tile'), tile.x, tile.y, tile.width, tile.height);
      const seams = this.seams(source, tile);
      gl.uniform4f(u('u_seams'), seams[0], seams[1], seams[2], seams[3]);
      const x0 = tile.x * levelScale - near, y0 = tile.y * levelScale - near;
      const x1 = (tile.x + tile.width) * levelScale + near, y1 = (tile.y + tile.height) * levelScale + near;
      const quad = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
        const p = map(x, y);
        return [p.x, p.y] as [number, number];
      });
      ctx.drawQuad(quad);
    }
    gl.disable(gl.BLEND);
    source.lastUsed = this.images.frame;
    base.lastUsed = this.images.frame;
  }

  private seams(image: GLImage, tile: GLTile): [number, number, number, number] {
    return [tile.col > 0 ? 1 : 0, tile.row > 0 ? 1 : 0, tile.col < image.cols - 1 ? 1 : 0, tile.row < image.rows - 1 ? 1 : 0];
  }

  // MARK: Passes

  private bind(program: WebGLProgram, name: string, unit: number, texture: WebGLTexture | null): void {
    this.ctx.bindTexture(unit, texture);
    this.ctx.gl.uniform1i(this.ctx.uniform(program, name), unit);
  }

  private bindCoverage(program: WebGLProgram, sampler: string, flag: string, channel: string | null, unit: number,
                       coverage: Coverage | null): void {
    const gl = this.ctx.gl;
    this.bind(program, sampler, unit, coverage ? coverage.target.texture : this.emptyTexture);
    gl.uniform1i(this.ctx.uniform(program, flag), coverage ? 1 : 0);
    if (channel) gl.uniform1i(this.ctx.uniform(program, channel), coverage?.channel ?? 0);
  }

  /** A full-target pass with blending off. */
  private fullPass(fragment: string, name: string, target: Target, setup: (program: WebGLProgram) => void): void {
    const ctx = this.ctx;
    const program = ctx.program(name, fragment);
    ctx.use(program, target, target.width, target.height);
    ctx.gl.disable(ctx.gl.BLEND);
    setup(program);
    ctx.drawRect(0, 0, target.width, target.height);
  }

  /** Draws a whole target over another in a blend mode, clipped. */
  private composite(source: Target, target: Target, mode: LayerBlendMode, clip: Coverage | null): void {
    const blend = blendIndex(mode);
    const ctx = this.ctx, gl = ctx.gl;
    if (blend > 0) ctx.copyRegion(target, this.backdropFor(target), 0, 0, target.width, target.height);
    const program = ctx.program('composite', COMPOSITE_FRAGMENT);
    ctx.use(program, target, target.width, target.height);
    this.bind(program, 'u_src', 0, source.texture);
    this.bindCoverage(program, 'u_clip', 'u_hasClip', 'u_clipChannel', 1, clip);
    if (blend > 0) {
      gl.disable(gl.BLEND);
      gl.uniform1i(ctx.uniform(program, 'u_blend'), blend);
      this.bind(program, 'u_backdrop', 2, this.backdrop!.texture);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(ctx.uniform(program, 'u_blend'), -1);
      this.bind(program, 'u_backdrop', 2, this.emptyTexture);
    }
    ctx.drawRect(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);
  }

  /** Applies an adjustment layer to `target` (what is below it), by its opacity, through `clip`. */
  private adjust(layer: SceneLayer, target: Target, clip: Coverage | null): void {
    const adjustment = layer.adjustment;
    if (!adjustment || adjustmentIsIdentity(adjustment)) return;
    const ctx = this.ctx, gl = ctx.gl;
    // Built first: creating textures disturbs the texture units' bindings.
    const { kind, table, cube } = this.adjustmentResources(layer.id, adjustment);
    const backdrop = this.backdropFor(target);
    ctx.copyRegion(target, backdrop, 0, 0, target.width, target.height);
    const program = ctx.program('adjust', ADJUST_FRAGMENT);
    ctx.use(program, target, target.width, target.height);
    gl.disable(gl.BLEND);
    const u = (name: string) => ctx.uniform(program, name);
    this.bind(program, 'u_backdrop', 0, backdrop.texture);
    gl.uniform1i(u('u_kind'), kind);
    this.bind(program, 'u_table', 1, table ?? this.emptyTexture);
    ctx.bindTexture(2, cube ?? this.emptyCube, gl.TEXTURE_3D);
    gl.uniform1i(u('u_cube'), 2);
    gl.uniform1f(u('u_cubeSize'), CUBE_DIMENSION);
    gl.uniform1i(u('u_blend'), blendIndex(layer.blendMode));
    gl.uniform1f(u('u_opacity'), layer.opacity);
    this.bindCoverage(program, 'u_ownMask', 'u_hasOwnMask', null, 3, null);
    this.bindCoverage(program, 'u_clip', 'u_hasClip', 'u_clipChannel', 4, clip);
    const d = this.outToDoc;
    gl.uniformMatrix3fv(u('u_outToDoc'), false, new Float32Array([d.a, d.b, 0, d.c, d.d, 0, d.tx, d.ty, 1]));
    gl.uniform1f(u('u_unitsPerPixel'), Math.hypot(d.a, d.b));
    const grain = adjustmentGrain(adjustment);
    gl.uniform1f(u('u_grainAmount'), grain.amount);
    gl.uniform1f(u('u_grainSize'), grain.size);
    gl.uniform1f(u('u_grainRoughness'), grain.roughness);
    gl.uniform1ui(u('u_grainSeed'), grain.seed >>> 0);
    ctx.drawRect(0, 0, target.width, target.height);
    ctx.bindTexture(2, null, gl.TEXTURE_3D);
  }

  /** Lookup tables for an adjustment, rebuilt only when its settings change. */
  private adjustmentResources(id: string, adjustment: LayerAdjustment): { kind: number; table: WebGLTexture | null; cube: WebGLTexture | null } {
    const key = JSON.stringify(adjustment);
    const cached = this.adjustmentTextures.get(id);
    let kind = 0;
    switch (adjustment.kind) {
      case 'Hue/Saturation': kind = 1; break;
      case 'Gradient Map': kind = 2; break;
      case 'Grain': kind = 3; break;
      default: kind = 0;
    }
    if (cached && cached.key === key) return { kind, table: cached.table, cube: cached.cube };
    const gl = this.ctx.gl;
    if (cached?.table) gl.deleteTexture(cached.table);
    if (cached?.cube) gl.deleteTexture(cached.cube);
    let table: WebGLTexture | null = null, cube: WebGLTexture | null = null;
    const rgbTable = (values: Float32Array) => {
      const data = new Float32Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        data[i * 4] = values[i]; data[i * 4 + 1] = values[256 + i]; data[i * 4 + 2] = values[512 + i]; data[i * 4 + 3] = 1;
      }
      return this.ctx.createTable(data, 256);
    };
    switch (adjustment.kind) {
      case 'Levels': table = rgbTable(levelsTables(adjustment.levels)); break;
      case 'Curves': table = rgbTable(curvesTables(adjustment.curves)); break;
      case 'Exposure': table = rgbTable(exposureTables(adjustmentExposure(adjustment))); break;
      case 'Gradient Map': {
        const bytes = gradientMapTable(adjustmentGradientMap(adjustment));
        const data = new Float32Array(256 * 4);
        for (let i = 0; i < 256; i++) {
          data[i * 4] = bytes[i * 3] / 255; data[i * 4 + 1] = bytes[i * 3 + 1] / 255; data[i * 4 + 2] = bytes[i * 3 + 2] / 255; data[i * 4 + 3] = 1;
        }
        table = this.ctx.createTable(data, 256);
        break;
      }
      case 'Hue/Saturation': cube = this.ctx.createCube(hueSaturationCube(resolvedHSV(adjustment)), CUBE_DIMENSION); break;
      default: break;
    }
    if (this.adjustmentTextures.size > 64) {
      for (const entry of this.adjustmentTextures.values()) {
        if (entry.table) gl.deleteTexture(entry.table);
        if (entry.cube) gl.deleteTexture(entry.cube);
      }
      this.adjustmentTextures.clear();
    }
    this.adjustmentTextures.set(id, { key, table, cube });
    return { kind, table, cube };
  }

  dispose(): void {
    if (this.backdrop) this.ctx.destroyTarget(this.backdrop);
    this.backdrop = null;
    const gl = this.ctx.gl;
    for (const entry of this.adjustmentTextures.values()) {
      if (entry.table) gl.deleteTexture(entry.table);
      if (entry.cube) gl.deleteTexture(entry.cube);
    }
    this.adjustmentTextures.clear();
  }

  // MARK: Offscreen

  /** Renders the document region `rect` at one pixel per document pixel and reads it back (premultiplied RGBA,
   *  rows top to bottom), in tiles no larger than the GPU allows. */
  renderRegion(scene: Scene, rect: { x: number; y: number; width: number; height: number }): Uint8Array {
    const out = new Uint8Array(rect.width * rect.height * 4);
    const step = Math.min(4096, this.ctx.maxTextureSize);
    for (let y = 0; y < rect.height; y += step) {
      for (let x = 0; x < rect.width; x += step) {
        const w = Math.min(step, rect.width - x), h = Math.min(step, rect.height - y);
        const target = this.ctx.createTarget(w, h);
        try {
          this.render(scene, target, { a: 1, b: 0, c: 0, d: 1, tx: -(rect.x + x), ty: -(rect.y + y) });
          const pixels = this.ctx.read(target);
          for (let row = 0; row < h; row++) {
            out.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * rect.width + x) * 4);
          }
        } finally {
          this.ctx.destroyTarget(target);
        }
      }
    }
    return out;
  }
}

/** Visible, non-folder layers in drawing order (CanvasDocument.renderLayers). */
export function renderOrder(layers: SceneLayer[]): string[] {
  const children = new Map<string | null, SceneLayer[]>();
  for (const layer of layers) {
    const list = children.get(layer.parentID);
    if (list) list.push(layer); else children.set(layer.parentID, [layer]);
  }
  const result: string[] = [];
  const visit = (parent: string | null, depth: number) => {
    if (depth > 64) return;
    for (const layer of children.get(parent) ?? []) {
      if (!layer.isVisible) continue;
      if (layer.isGroup) visit(layer.id, depth + 1);
      else result.push(layer.id);
    }
  };
  visit(null, 0);
  return result;
}

export function adjustmentIsIdentity(adjustment: LayerAdjustment): boolean {
  switch (adjustment.kind) {
    case 'Levels': return levelsIsIdentity(adjustment.levels);
    case 'Curves': return curvesIsIdentity(adjustment.curves);
    case 'Exposure': return exposureIsIdentity(adjustmentExposure(adjustment));
    case 'Hue/Saturation': return hsIsIdentity(resolvedHSV(adjustment));
    case 'Grain': return !(adjustmentGrain(adjustment).amount > 0);
    case 'Gradient Map': return false;
  }
}
