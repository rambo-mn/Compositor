// What the compositor draws for a document: the plain document (export, merge), the live composite (with pending
// transforms and blend previews: drawLiveComposite), and the canvas display (also everything being edited: brush
// strokes, gradients, moved pixels, smudges, distortions, filter previews).
import type { Scene, SceneImage, SceneLayer, SceneMask } from '../gl/compositor';
import type { CanvasDocument, Layer, LayerMask } from '../model/document';
import type { LayerTransform } from '../model/transform';
import { pixelToDocument, samePlacement, following } from '../model/transform';
import { Affine, makeTranslation } from '../model/geometry';
import { Raster, TILE_SIZE } from '../raster/raster';
import type { EditorSession } from './session';
import { Matrix3, compose3, fromAffine, unitSquareTo, isUsableQuad } from '../model/projective';
import { rasterizeSelection } from '../raster/rasterize';

/** Pixels stretched over `transform`. */
export function imageOn(raster: Raster, transform: LayerTransform): SceneImage {
  return { raster, width: raster.width, height: raster.height, gridToDocument: pixelToDocument(transform, raster.width, raster.height),
    sampling: transform.sampling };
}

const backgrounds = new WeakMap<Raster, number>();
/** What a mask shows beyond its pixels once placed apart from its layer: white or black, whichever most of its
 *  edge is (LayerMask.background). */
export function maskBackground(raster: Raster): number {
  const cached = backgrounds.get(raster);
  if (cached !== undefined) return cached;
  let total = 0, count = 0;
  const w = raster.width, h = raster.height;
  const add = (data: Uint8Array) => { for (const v of data) { total += v; count++; } };
  add(raster.readRegion(0, 0, w, 1));
  if (h > 1) add(raster.readRegion(0, h - 1, w, 1));
  if (h > 2) { add(raster.readRegion(0, 1, 1, h - 2)); if (w > 1) add(raster.readRegion(w - 1, 1, 1, h - 2)); }
  const value = total * 2 >= count * 255 ? 1 : 0;
  backgrounds.set(raster, value);
  return value;
}

/** A layer's own mask for drawing: stretched over the layer's grid, or on its own placement with its edge tone
 *  beyond it. `layerTransform` is where the layer is drawn. */
export function layerMaskScene(mask: LayerMask, layerTransform: LayerTransform, placement: LayerTransform | null): SceneMask | null {
  if (!mask.isEnabled) return null;
  const raster = mask.asset.image;
  if (!placement || samePlacement(placement, layerTransform)) {
    return { image: imageOn(raster, { ...layerTransform }), outside: 'clamp' };
  }
  return { image: imageOn(raster, { ...placement, sampling: layerTransform.sampling }), outside: maskBackground(raster) };
}

/** A folder's (or adjustment's) mask: stretched over its transform, nothing beyond it (FolderMaskClip). */
export function folderMaskScene(mask: LayerMask, transform: LayerTransform): SceneMask | null {
  if (!mask.isEnabled) return null;
  return { image: imageOn(mask.asset.image, transform), outside: 0 };
}

function baseSceneLayer(layer: Layer): SceneLayer {
  return {
    id: layer.id, parentID: layer.parentID, isGroup: layer.isGroup, isVisible: layer.isVisible, image: null,
    opacity: layer.opacity, blendMode: layer.blendMode, mask: null, maskSourceID: layer.maskSourceID,
    adjustment: layer.adjustment,
  };
}

/** The document as saved. */
export function plainScene(document: CanvasDocument): Scene {
  return {
    width: document.width, height: document.height,
    layers: document.layers.map((layer) => {
      const scene = baseSceneLayer(layer);
      if (layer.isGroup || layer.adjustment) {
        scene.mask = layer.mask ? folderMaskScene(layer.mask, layer.transform) : null;
      } else {
        scene.image = layer.asset ? imageOn(layer.asset.image, layer.transform) : null;
        scene.mask = layer.mask ? layerMaskScene(layer.mask, layer.transform, layer.mask.placement) : null;
      }
      return scene;
    }),
  };
}

/** The document as the canvas shows it without edits in progress: pending transforms and blend previews. */
export function liveScene(session: EditorSession, document: CanvasDocument): Scene {
  return {
    width: document.width, height: document.height,
    layers: document.layers.map((layer) => {
      const scene = baseSceneLayer(layer);
      scene.blendMode = session.displayedBlendMode(layer);
      const transform = session.displayedTransform(layer);
      if (layer.isGroup || layer.adjustment) {
        scene.mask = layer.mask ? folderMaskScene(layer.mask, transform) : null;
      } else {
        scene.image = layer.asset ? imageOn(layer.asset.image, transform) : null;
        scene.mask = layer.mask ? layerMaskScene(layer.mask, transform, session.displayedMaskPlacement(layer)) : null;
      }
      return scene;
    }),
  };
}

/** A stroke's grid as a scene image, drawn from the GPU copy that follows it. */
function strokeImage(session: EditorSession, stroke: import('../raster/brush').BrushStroke, sampling: LayerTransform['sampling']): SceneImage | null {
  const gpu = session.gpu;
  if (!gpu) return null;
  const image = gpu.strokeImage(stroke);
  return { gl: image, width: stroke.width, height: stroke.height, gridToDocument: stroke.pixelToDocument, sampling };
}

/** Everything the canvas shows, edits in progress included. */
export function displayScene(session: EditorSession): Scene | null {
  const document = session.document;
  if (!document) return null;
  const scene = liveScene(session, document);
  const byID = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const edits = [session.brushStroke, session.gradientEdit?.raster, session.pixelMove?.raster].filter((s): s is NonNullable<typeof s> => !!s);
  for (const layer of document.layers) {
    const target = byID.get(layer.id)!;
    const stroke = edits.find((s) => s.layer.id === layer.id);
    const transform = session.displayedTransform(layer);
    if (stroke && !stroke.isMask) {
      // Painting pixels: the layer as the stroke leaves it. Its mask covers the old grid only; paint beyond it
      // is revealed (the limit is in the stroke's grid).
      target.image = strokeImage(session, stroke, transform.sampling);
      if (target.mask && layer.mask && !layer.mask.placement) target.mask = { ...target.mask, limit: { ...stroke.sourceRect } };
    } else if (stroke && stroke.isMask) {
      const image = strokeImage(session, stroke, transform.sampling);
      if (image) {
        const placed = !!layer.mask?.placement && !layer.isGroup && !layer.adjustment;
        target.mask = { image, outside: layer.isGroup || layer.adjustment ? 0 : placed ? maskBackground(layer.mask!.asset.image) : 'clamp' };
      }
    }
    if (session.warpStroke?.layer.id === layer.id && session.gpu) {
      // Smudge or Liquify in progress: the layer as the stroke has reshaped it so far, across the canvas.
      const warp = session.warpStroke;
      target.image = { gl: session.gpu.warpImage(warp), width: warp.width, height: warp.height,
        gridToDocument: makeTranslation(0, 0), sampling: layer.transform.sampling };
      if (layer.mask?.isEnabled) {
        target.mask = { image: imageOn(layer.mask.asset.image, layer.mask.placement ?? layer.transform),
          outside: maskBackground(layer.mask.asset.image) };
      }
    }
    // A pending distortion shows the layer warped into its new shape.
    const distorted = !stroke ? session.distortScene(layer) : null;
    if (distorted) {
      target.image = distorted.image;
      target.mask = distorted.mask;
    }
    const shaped = !stroke ? session.shapeTransformPreview(layer, transform) : null;
    if (shaped) target.image = imageOn(shaped, transform);
    // Previews of edits to the layer's pixels.
    const filterPreview = session.filterEdit?.previewImageFor(layer.id);
    if (filterPreview) {
      const placed = session.filterEdit!.grownTransform ?? layer.transform;
      target.image = { raster: filterPreview, width: filterPreview.width, height: filterPreview.height,
        gridToDocument: pixelToDocument(placed, filterPreview.width, filterPreview.height), sampling: placed.sampling };
    }
    const preview = session.colorPreviewFor(layer.id);
    if (preview) target.preview = preview;
  }
  return scene;
}

/** A selection's coverage as a document-space mask (for previews limited to it). */
export function selectionMask(session: EditorSession): SceneMask | null {
  const document = session.document, selection = document?.selection;
  if (!document || !selection) return null;
  const bounds = selection.path.bounds;
  if (!bounds || selection.path.isEmpty) {
    return { image: { raster: Raster.solid(1, [0]), width: 1, height: 1, gridToDocument: { a: document.width, b: 0, c: 0, d: document.height, tx: 0, ty: 0 }, sampling: 'Nearest' }, outside: 0 };
  }
  const x0 = Math.max(0, Math.floor(bounds.x) - 1), y0 = Math.max(0, Math.floor(bounds.y) - 1);
  const x1 = Math.min(document.width, Math.ceil(bounds.x + bounds.width) + 1), y1 = Math.min(document.height, Math.ceil(bounds.y + bounds.height) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const key = selection;
  let raster = selectionRasters.get(key);
  if (!raster || raster.x !== x0 || raster.y !== y0) {
    const coverage = rasterizeSelection(selection, null, x0, y0, x1 - x0, y1 - y0);
    raster = { raster: Raster.fromData(x1 - x0, y1 - y0, 1, coverage), x: x0, y: y0 };
    selectionRasters.set(key, raster);
  }
  return { image: { raster: raster.raster, width: x1 - x0, height: y1 - y0, gridToDocument: makeTranslation(x0, y0), sampling: 'Smooth' }, outside: 0 };
}
const selectionRasters = new WeakMap<object, { raster: Raster; x: number; y: number }>();

/** A distortion's perspective for a grid placed by `transform` whose corners move to `corners`. */
export function distortedImage(raster: Raster, transform: LayerTransform, corners: import('../model/geometry').Point[]): SceneImage | null {
  if (!isUsableQuad(corners)) return null;
  // Unit square → the shape, with a flipped layer's pixels going to the opposite corners.
  const order = (x: number, y: number) => {
    const u = transform.flipX ? 1 - x : x, v = transform.flipY ? 1 - y : y;
    return corners[[0, 1, 3, 2][v * 2 + u]];
  };
  const H = unitSquareTo([order(0, 0), order(1, 0), order(1, 1), order(0, 1)]);
  const gridToUnit: Matrix3 = [1 / raster.width, 0, 0, 0, 1 / raster.height, 0, 0, 0, 1];
  return { raster, width: raster.width, height: raster.height, gridToDocument: pixelToDocument(transform, raster.width, raster.height),
    projective: compose3(gridToUnit, H), sampling: transform.sampling };
}

export { following, fromAffine, TILE_SIZE };
export type { Affine };
