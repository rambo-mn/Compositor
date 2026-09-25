// Distorting layers (corner handles moved freely), the Shape tool, snapping while moving, cropping, Canvas Size and
// Image Size. Ports Distort.swift, ShapeTool.swift, the session half of Crop.swift, CanvasResizer and ImageResizer.
import { EditorSession } from './session';
import { extend } from './observable';
import type { Point, Rect } from '../model/geometry';
import { invert } from '../model/geometry';
import {
  LayerTransform, TransformEdit, center, cornersOf, following, isValidTransform, makeTransform, pixelToDocument, placing,
  radians, samePlacement, snapOffset, unitToDocument, LayerSampling,
} from '../model/transform';
import type { CanvasDocument, Layer, LayerMask, ShapeKind, LayerShapeStyle } from '../model/document';
import { asset, blankLayer, renderLayers } from '../model/document';
import { Raster, alphaBounds } from '../raster/raster';
import { rasterizePolygons } from '../raster/rasterize';
import { ellipsePoints, roundedRectPoints, dragBox } from '../model/selection';
import { isUsableQuad, project, unitSquareTo } from '../model/projective';
import type { SceneImage, SceneMask } from '../gl/compositor';
import { distortedImage, imageOn, layerMaskScene, maskBackground } from './scene';
import { sceneLayer } from './selection';
import { CanvasSizeOptions, canvasOffset, cropSnapped, cropValid } from '../model/crop';
import type { PaletteColor } from '../model/color';

export const MAX_SHAPE_PIXELS = 100_000_000;

/** Where `placement`'s corners land when the perspective taking `transform`'s corners to `corners` is applied around
 *  it too: how a linked mask placed apart distorts with its layer (DistortWarp.carried). */
export function carriedCorners(placement: LayerTransform, transform: LayerTransform, corners: Point[]): Point[] {
  const c = center(transform), r = radians(transform);
  const cos = Math.cos(r), sin = Math.sin(r);
  const map = unitSquareTo(corners);
  return cornersOf(placement).map((p) => {
    const dx = p.x - c.x, dy = p.y - c.y;
    const x = (dx * cos + dy * sin) / transform.size.width + 0.5, y = (-dx * sin + dy * cos) / transform.size.height + 0.5;
    return project(map, { x, y });
  });
}

/** The shape filling a `width` × `height` box, antialiased, as premultiplied RGBA. */
export function shapeRaster(kind: ShapeKind, width: number, height: number, color: PaletteColor, cornerRadius = 0): Raster {
  const box = { x: 0, y: 0, width, height };
  const polygon = kind === 'Ellipse' ? ellipsePoints(width / 2, height / 2, width / 2, height / 2) : roundedRectPoints(box, cornerRadius);
  const coverage = rasterizePolygons([polygon], null, 0, 0, width, height, true);
  const data = new Uint8Array(width * height * 4);
  const r = Math.round(color.red * 255), g = Math.round(color.green * 255), b = Math.round(color.blue * 255);
  for (let i = 0; i < coverage.length; i++) {
    const a = coverage[i];
    if (!a) continue;
    data[i * 4] = (r * a + 127) / 255 | 0;
    data[i * 4 + 1] = (g * a + 127) / 255 | 0;
    data[i * 4 + 2] = (b * a + 127) / 255 | 0;
    data[i * 4 + 3] = a;
  }
  return Raster.fromData(width, height, 4, data);
}

const shapePreviews = new Map<string, { width: number; height: number; image: Raster }>();

const transforms = {
  // MARK: Distort

  /** Ctrl-drag on a transform handle: the corners start moving freely; the edit then waits for Apply. */
  beginDistort(this: EditorSession): void {
    const edit = this.transformEdit;
    if (!edit || edit.corners || !isValidTransform(edit.draft)) return;
    this.transformEdit = { ...edit, persistent: true, corners: cornersOf(edit.draft) };
  },

  /** Moves the distortion's corners; a twisted or collapsed shape is ignored. */
  previewCorners(this: EditorSession, corners: Point[]): void {
    const edit = this.transformEdit;
    if (!edit?.corners || !isUsableQuad(corners)) return;
    this.transformEdit = { ...edit, corners };
  },

  /** Where a distortion takes `layer`: its transform under the edit and the corners it moves to. */
  distortTarget(this: EditorSession, layer: Layer, edit: TransformEdit, shape: Point[]): { transform: LayerTransform; corners: Point[] } | null {
    if (!edit.group) return edit.layerID === layer.id ? { transform: edit.draft, corners: shape } : null;
    const original = edit.group.originals.get(layer.id);
    if (!original) return null;
    const transform = following(original, edit.group.box, edit.draft);
    const corners = carriedCorners(transform, edit.draft, shape);
    return isUsableQuad(corners) ? { transform, corners } : null;
  },

  /** A layer under a pending distortion, for the canvas: its pixels and mask through the perspective. */
  distortScene(this: EditorSession, layer: Layer): { image: SceneImage; mask: SceneMask | null } | null {
    const edit = this.transformEdit;
    if (!edit || edit.mask || !edit.corners || !layer.asset) return null;
    const target = this.distortTarget(layer, edit, edit.corners);
    if (!target) return null;
    const image = distortedImage(layer.asset.image, target.transform, target.corners);
    if (!image) return null;
    return { image, mask: this.distortedMask(layer, target.transform, target.corners) };
  },

  /** A layer's mask as a distortion leaves it: covering the layer, it warps with it; placed apart and linked, it
   *  takes the same perspective over its own bounds; unlinked, it stays where it is. */
  distortedMask(this: EditorSession, layer: Layer, transform: LayerTransform, corners: Point[]): SceneMask | null {
    const mask = layer.mask;
    if (!mask?.isEnabled) return null;
    const raster = mask.asset.image;
    if (!mask.placement && mask.isLinked) {
      const image = distortedImage(raster, transform, corners);
      return image ? { image, outside: 'clamp' } : null;
    }
    if (mask.isLinked && mask.placement) {
      const placement = following(mask.placement, layer.transform, transform);
      const carried = carriedCorners(placement, transform, corners);
      const image = isUsableQuad(carried) ? distortedImage(raster, { ...placement, sampling: transform.sampling }, carried) : null;
      return image ? { image, outside: maskBackground(raster) } : null;
    }
    return { image: imageOn(raster, { ...(mask.placement ?? layer.transform), sampling: transform.sampling }), outside: maskBackground(raster) };
  },

  /** Apply for a distortion: each distorted layer's pixels and mask are resampled into its shape, one undo step. */
  commitDistort(this: EditorSession, edit: TransformEdit, shape: Point[]): void {
    const ids = edit.group ? [...edit.group.originals.keys()] : [edit.layerID];
    this.beginEdit(edit.group ? 'Distort Layers' : 'Distort');
    for (const id of ids) {
      const index = this.layerIndex(id);
      if (index < 0) continue;
      const layer = this.document!.layers[index];
      const target = this.distortTarget(layer, edit, shape);
      if (!target) continue;
      try { this.distortLayer(index, target.transform, target.corners); }
      catch (error) { this.brushError = (error as Error).message; }
    }
    this.endEdit();
  },

  /** The layer at `index`, shown by `transform`, resampled so its corners land on `corners`, trimmed to its pixels. */
  distortLayer(this: EditorSession, index: number, transform: LayerTransform, corners: Point[]): void {
    const layer = this.document!.layers[index];
    if (!layer.asset || !this.gpu) return;
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
    const width = Math.ceil(Math.max(...xs)) - x0, height = Math.ceil(Math.max(...ys)) - y0;
    if (!(width >= 1 && height >= 1 && width <= 30_000 && height <= 30_000 && width * height <= 100_000_000)) throw new Error('The result would be too large.');
    const image = distortedImage(layer.asset.image, transform, corners);
    if (!image) throw new Error('That shape can’t be made.');
    const toGrid = { a: 1, b: 0, c: 0, d: 1, tx: -x0, ty: -y0 };
    const pixels = this.gpu.renderMapped({ width: this.document!.width, height: this.document!.height, layers: [sceneLayer('d', image)] }, width, height, toGrid);
    const bounds = alphaBounds(pixels, width, height);
    const crop = bounds ?? { x: 0, y: 0, width, height };
    let raster = Raster.fromData(width, height, 4, pixels);
    if (crop.width !== width || crop.height !== height) raster = raster.crop(crop.x, crop.y, crop.width, crop.height);
    const placed = makeTransform({ x: x0 + crop.x, y: y0 + crop.y }, { width: crop.width, height: crop.height }, transform.sampling);
    let mask: LayerMask | null = layer.mask;
    const original = layer.mask;
    if (original && !original.placement && original.isLinked) {
      const m = original.asset.image;
      if (!(m.width === 1 && m.height === 1)) {
        const warped = distortedImage(m, transform, corners)!;
        const gray = this.gpu.renderMask({ image: warped, outside: 0 }, crop.width, crop.height, { a: 1, b: 0, c: 0, d: 1, tx: -(x0 + crop.x), ty: -(y0 + crop.y) });
        mask = { ...original, asset: asset(Raster.fromData(crop.width, crop.height, 1, gray), original.asset.name) };
      }
    } else if (original && original.isLinked && original.placement) {
      const placement = following(original.placement, layer.transform, transform);
      const carried = carriedCorners(placement, transform, corners);
      if (isUsableQuad(carried)) {
        const moved = this.warpMask(original, placement, carried);
        mask = { ...original, asset: moved.raster === original.asset.image ? original.asset : asset(moved.raster, original.asset.name),
          placement: moved.transform, isLinked: true };
      }
    } else if (original) {
      // An unlinked mask keeps its place on the document.
      mask = { ...original, placement: original.placement ?? layer.transform };
    }
    this.updateDocument((d) => {
      const target = d.layers[index];
      target.asset = asset(raster, layer.name) as never;
      target.transform = placed as never;
      target.mask = mask as never;
      target.shape = null;
    });
  },

  // MARK: Shapes

  beginShape(this: EditorSession, point: Point): void {
    if (this.tool !== 'shape' || !this.canEditLayers || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const anchor = { x: Math.round(point.x), y: Math.round(point.y) };
    this.shapeDraft = { kind: this.shapeKind, anchor, rect: { x: anchor.x, y: anchor.y, width: 0, height: 0 },
      cornerRadius: this.shapeKind === 'Rectangle' ? this.shapeCornerRadius : 0 };
  },
  /** Shift makes a square or circle; Alt grows the shape from its centre. */
  dragShape(this: EditorSession, point: Point, square: boolean, fromCenter: boolean): void {
    const draft = this.shapeDraft;
    if (!draft || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.shapeDraft = { ...draft, rect: dragBox(draft.anchor, point, square, fromCenter) };
  },
  cancelShape(this: EditorSession): void { if (this.shapeDraft) this.shapeDraft = null; },
  toggleShapeKind(this: EditorSession): void {
    this.cancelShape();
    this.shapeKind = this.shapeKind === 'Rectangle' ? 'Ellipse' : 'Rectangle';
  },
  /** Fills the dragged shape with the foreground colour on a new layer, one undo step; the selection stays. */
  finishShape(this: EditorSession): void {
    const draft = this.shapeDraft;
    if (!draft) return;
    this.shapeDraft = null;
    const r = draft.rect;
    if (!this.canEditLayers || !this.document || !(r.width >= 1 && r.height >= 1)) return;
    if (r.width * r.height > MAX_SHAPE_PIXELS) { this.brushError = 'That shape is too large. A shape can cover up to 100 megapixels.'; return; }
    const color = this.foregroundColor;
    const image = shapeRaster(draft.kind, r.width, r.height, color, draft.cornerRadius);
    const style: LayerShapeStyle = { kind: draft.kind, red: color.red, green: color.green, blue: color.blue, cornerRadius: draft.cornerRadius };
    this.addPixelLayer(image, { x: r.x, y: r.y }, this.nextLayerName(draft.kind), draft.kind, false, { style, image });
  },
  /** A shape layer scaled to a new size draws its shape again at that size, so rounded corners keep their radius. */
  redrawShape(this: EditorSession, index: number): void {
    const layer = this.document?.layers[index];
    const shape = layer?.shape;
    if (!layer || !shape || !layer.asset || layer.asset.image !== shape.image) return;
    const width = Math.max(1, Math.round(layer.transform.size.width)), height = Math.max(1, Math.round(layer.transform.size.height));
    if ((width === layer.asset.image.width && height === layer.asset.image.height) || width * height > MAX_SHAPE_PIXELS) return;
    const s = shape.style;
    const image = shapeRaster(s.kind, width, height, { red: s.red, green: s.green, blue: s.blue }, s.cornerRadius);
    this.updateDocument((d) => {
      const target = d.layers[index];
      // A mask following the layer's grid stays exactly where it is while that grid changes size.
      if (target.mask && !target.mask.placement) target.mask.placement = layer.transform as never;
      target.asset = asset(image, layer.asset!.name) as never;
      target.shape = { style: s, image } as never;
    });
  },
  /** While a rounded rectangle is scaled, the shape drawn at the dragged size (at most 2048 across), so its corners
   *  keep their radius during the drag. */
  shapeTransformPreview(this: EditorSession, layer: Layer, transform: LayerTransform): Raster | null {
    const shape = layer.shape;
    if (!this.transformEdit || !shape || layer.asset?.image !== shape.image || shape.style.kind !== 'Rectangle' || !(shape.style.cornerRadius > 0)) {
      if (!this.transformEdit && shapePreviews.size) shapePreviews.clear();
      return null;
    }
    const size = transform.size;
    if (!(size.width >= 1 && size.height >= 1) || (Math.abs(size.width - shape.image.width) < 0.5 && Math.abs(size.height - shape.image.height) < 0.5)) return null;
    const factor = Math.min(1, 2048 / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * factor)), height = Math.max(1, Math.round(size.height * factor));
    const cached = shapePreviews.get(layer.id);
    if (cached && cached.width === width && cached.height === height) return cached.image;
    const s = shape.style;
    const image = shapeRaster('Rectangle', width, height, { red: s.red, green: s.green, blue: s.blue }, s.cornerRadius * factor);
    shapePreviews.set(layer.id, { width, height, image });
    return image;
  },

  // MARK: Snapping

  /** What a moving layer snaps to: the canvas's edges and centre, and every other visible layer's bounds and centre. */
  transformSnapTargets(this: EditorSession, moving: Set<string>): { xs: number[]; ys: number[] } {
    const document = this.document;
    if (!document) return { xs: [], ys: [] };
    const xs = [0, document.width / 2, document.width], ys = [0, document.height / 2, document.height];
    for (const layer of renderLayers(document)) {
      if (!layer.asset || moving.has(layer.id)) continue;
      const corners = cornersOf(this.displayedTransform(layer));
      const cx = corners.map((p) => p.x), cy = corners.map((p) => p.y);
      const x0 = Math.min(...cx), x1 = Math.max(...cx), y0 = Math.min(...cy), y1 = Math.max(...cy);
      xs.push(Math.round(x0), Math.round((x0 + x1) / 2), Math.round(x1));
      ys.push(Math.round(y0), Math.round((y0 + y1) / 2), Math.round(y1));
    }
    return { xs, ys };
  },
  /** `draft` nudged so its layer lines up with a nearby edge or centre; `tolerance` in document pixels. */
  snappedMove(this: EditorSession, draft: LayerTransform, moving: Set<string>, tolerance: number): LayerTransform {
    const corners = cornersOf(draft);
    const cx = corners.map((p) => p.x), cy = corners.map((p) => p.y);
    const x0 = Math.min(...cx), y0 = Math.min(...cy);
    const box = { x: x0, y: y0, width: Math.max(...cx) - x0, height: Math.max(...cy) - y0 };
    const targets = this.transformSnapTargets(moving);
    const snap = snapOffset(box, targets.xs, targets.ys, tolerance);
    this.snapGuides = { xs: snap.x != null ? [snap.x] : [], ys: snap.y != null ? [snap.y] : [] };
    if (!snap.offset.width && !snap.offset.height) return draft;
    return { ...draft, origin: { x: draft.origin.x + snap.offset.width, y: draft.origin.y + snap.offset.height } };
  },

  // MARK: Crop

  /** What crop edges snap to: the canvas's edges and every visible layer's bounds, in whole pixels. */
  cropSnapTargets(this: EditorSession): { xs: number[]; ys: number[] } {
    const document = this.document;
    if (!document) return { xs: [], ys: [] };
    const xs = [0, document.width], ys = [0, document.height];
    for (const layer of renderLayers(document)) {
      if (!layer.asset) continue;
      const corners = cornersOf(this.displayedTransform(layer));
      const cx = corners.map((p) => p.x), cy = corners.map((p) => p.y);
      xs.push(Math.round(Math.min(...cx)), Math.round(Math.max(...cx)));
      ys.push(Math.round(Math.min(...cy)), Math.round(Math.max(...cy)));
    }
    return { xs, ys };
  },
  /** The frame the Crop tool shows, without creating an uncommitted edit. */
  get visibleCropRect(): Rect | null {
    const s = this as unknown as EditorSession;
    if (s.tool !== 'crop' || !s.document) return null;
    return s.cropRect ?? { x: 0, y: 0, width: s.document.width, height: s.document.height };
  },
  get cropRatio(): number | null {
    const s = this as unknown as EditorSession;
    switch (s.cropRatioChoice) {
      case 'Original': return s.document ? s.document.width / s.document.height : null;
      case '1:1': return 1;
      case '4:3': return 4 / 3;
      case '16:9': return 16 / 9;
      default: return null;
    }
  },
  cancelCrop(this: EditorSession): void { this.cropRect = null; },
  changeCropRatio(this: EditorSession): void {
    const rect = this.visibleCropRect, ratio = this.cropRatio;
    if (!rect || !ratio) return;
    const height = rect.width / ratio;
    const next = cropSnapped({ x: rect.x, y: rect.y + rect.height / 2 - height / 2, width: rect.width, height });
    if (cropValid(next)) this.cropRect = next;
  },
  async commitCrop(this: EditorSession): Promise<void> {
    const rect = this.cropRect, document = this.document;
    if (!this.canStartProjectOperation || !rect || !cropValid(rect) || !document) return;
    try {
      const resized = resizeCanvas(document, { width: rect.width, height: rect.height, anchor: 0, fill: null, contentOffset: { x: -rect.x, y: -rect.y } });
      this.cropRect = null;
      this.applyDocumentSize(resized, 'Crop');
    } catch (error) { this.cropError = (error as Error).message; }
  },

  /** Canvas Size: the canvas grows or shrinks around `anchor`; a grown area can be filled with a colour. */
  resizeCanvasTo(this: EditorSession, options: CanvasSizeOptions): void {
    const document = this.document;
    if (!document || !this.canStartProjectOperation) return;
    try { this.applyDocumentSize(resizeCanvas(document, options), 'Canvas Size'); }
    catch (error) { this.brushError = (error as Error).message; }
  },

  /** Image Size: every layer resampled to the new size; the resolution is stored for export. */
  async resizeImageTo(this: EditorSession, width: number, height: number, resolution: number, sampling: LayerSampling): Promise<void> {
    const document = this.document;
    if (!document || !this.canStartProjectOperation || !this.gpu) return;
    try {
      const resized = await this.whileBusy(async () => resizeImage(this, document, width, height, resolution, sampling));
      this.applyDocumentSize(resized, 'Image Size');
    } catch (error) { this.brushError = (error as Error).message; }
  },

  applyDocumentSize(this: EditorSession, next: CanvasDocument, actionName: string): void {
    if (this.document?.id !== next.id) return;
    this.beginEdit(actionName);
    this.document = next;
    this.endEdit();
    this.viewport.fit({ width: next.width, height: next.height });
    this.viewportChanged();
  },
};

/** The canvas resized, every layer (and placed mask) shifted by the anchor or crop offset; a grown canvas can be
 *  filled with a colour on a new bottom layer (CanvasResizer). */
export function resizeCanvas(document: CanvasDocument, options: CanvasSizeOptions): CanvasDocument {
  if (!(options.width >= 1 && options.width <= 30_000 && options.height >= 1 && options.height <= 30_000) || !(options.anchor >= 0 && options.anchor <= 8)) {
    throw new Error('Canvases can be up to 30,000 pixels on a side.');
  }
  const offset = canvasOffset(options, document.width, document.height);
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y) || Math.abs(offset.x) > 1_000_000 || Math.abs(offset.y) > 1_000_000) throw new Error('That crop is out of range.');
  if (options.width === document.width && options.height === document.height && !offset.x && !offset.y) return document;
  const shift = (t: LayerTransform): LayerTransform => ({ ...t, origin: { x: t.origin.x + offset.x, y: t.origin.y + offset.y } });
  const layers: Layer[] = document.layers.map((layer) => {
    const transform = shift(layer.transform);
    if (!isValidTransform(transform)) throw new Error('This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.');
    return { ...layer, transform, mask: layer.mask ? { ...layer.mask, placement: layer.mask.placement ? shift(layer.mask.placement) : null } : null };
  });
  const fill = options.fill;
  if (fill && (options.width > document.width || options.height > document.height)) {
    // A coloured extension is its own bottom layer; the old canvas area stays transparent in it.
    const data = new Uint8Array(options.width * options.height * 4);
    const r = Math.round(fill.red * 255), g = Math.round(fill.green * 255), b = Math.round(fill.blue * 255);
    for (let y = 0; y < options.height; y++) {
      for (let x = 0; x < options.width; x++) {
        const inside = x >= offset.x && x < offset.x + document.width && y >= offset.y && y < offset.y + document.height;
        if (inside) continue;
        const p = (y * options.width + x) * 4;
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      }
    }
    const extension = { ...blankLayer('Canvas Extension', options.width, options.height),
      asset: asset(Raster.fromData(options.width, options.height, 4, data), 'Canvas Extension') };
    layers.unshift(extension);
  }
  return { ...document, width: options.width, height: options.height, layers };
}

/** Every layer rasterized at the new size on its own (a rotated layer scaled unevenly would shear otherwise). */
function resizeImage(session: EditorSession, document: CanvasDocument, width: number, height: number, resolution: number,
                     sampling: LayerSampling): CanvasDocument {
  if (!(width >= 1 && width <= 30_000 && height >= 1 && height <= 30_000) || !(resolution >= 1 && resolution <= 9600)) throw new Error('Choose a size up to 30,000 pixels and a resolution from 1 to 9600.');
  if (width === document.width && height === document.height) return { ...document, resolution };
  if (width * height > 100_000_000) throw new Error('Images can be up to 100 megapixels.');
  const sx = width / document.width, sy = height / document.height;
  const gpu = session.gpu!;
  let usedPixels = 0, usedMaskPixels = 0;
  const layers = document.layers.map((layer): Layer => {
    const corners = cornersOf(layer.transform).map((p) => ({ x: p.x * sx, y: p.y * sy }));
    const left = Math.floor(Math.min(...corners.map((p) => p.x))), top = Math.floor(Math.min(...corners.map((p) => p.y)));
    const w = Math.ceil(Math.max(...corners.map((p) => p.x))) - left, h = Math.ceil(Math.max(...corners.map((p) => p.y))) - top;
    const transform = makeTransform({ x: left, y: top }, { width: w, height: h }, sampling);
    if (!isValidTransform(transform)) throw new Error('This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.');
    const docToGrid = { a: sx, b: 0, c: 0, d: sy, tx: -left, ty: -top };
    const sourceTransform = { ...layer.transform, sampling };
    let result: Layer = { ...layer, transform };
    if (layer.asset) {
      if (!(w <= 30_000 && h <= 30_000 && w * h <= 100_000_000 - usedPixels)) throw new Error('This project exceeds the 100-megapixel image limit.');
      usedPixels += w * h;
      const pixels = gpu.renderMapped({ width: document.width, height: document.height, layers: [sceneLayer('l', imageOn(layer.asset.image, sourceTransform))] }, w, h, docToGrid);
      result = { ...result, asset: asset(Raster.fromData(w, h, 4, pixels), layer.asset.name), shape: null };
    }
    if (layer.mask) {
      const m = layer.mask.asset.image;
      if ((m.width === 1 && m.height === 1) || layer.mask.placement) {
        // Uniform masks don't depend on size; a placed mask keeps its pixels and its placement scales.
        const placement = layer.mask.placement ? placing(layer.mask.placement, scaleAffine(unitToDocument(layer.mask.placement), sx, sy)) : null;
        result = { ...result, mask: { ...layer.mask, placement } };
      } else {
        if (!(w * h <= 100_000_000 - usedMaskPixels)) throw new Error('This project exceeds the 100-megapixel image limit.');
        usedMaskPixels += w * h;
        const gray = gpu.renderMask({ image: imageOn(m, sourceTransform), outside: 0 }, w, h, docToGrid);
        result = { ...result, mask: { ...layer.mask, asset: asset(Raster.fromData(w, h, 1, gray), layer.mask.asset.name) } };
      }
    }
    return result;
  });
  return { ...document, width, height, resolution, layers };
}

function scaleAffine(t: import('../model/geometry').Affine, sx: number, sy: number): import('../model/geometry').Affine {
  return { a: t.a * sx, b: t.b * sy, c: t.c * sx, d: t.d * sy, tx: t.tx * sx, ty: t.ty * sy };
}

void samePlacement; void pixelToDocument; void invert; void layerMaskScene;

type Transforms = typeof transforms;
declare module './session' {
  interface EditorSession extends Transforms {}
}
extend(EditorSession, transforms);
