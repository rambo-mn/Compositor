// Committing tiled raster edits (brush strokes, gradients, fills, clears, moved pixels) to their layer as one undo
// step. Ports commitPaintSnapshot and commitRasterEdit (EditorSession+Brush.swift) and BrushCommit.expandMask.
import { EditorSession } from './session';
import { extend } from './observable';
import { BrushStroke, TooLargeError } from '../raster/brush';
import { Raster } from '../raster/raster';
import type { Layer, LayerMask } from '../model/document';
import { asset } from '../model/document';
import { isValidTransform, transformsEqual } from '../model/transform';
import type { Rect } from '../model/geometry';
import { selectionClip } from '../raster/rasterize';
import type { BrushSettings } from '../model/settings';
import { defaultBrushSettings } from '../model/settings';

/** A mask covering a layer's old grid (`sourceRect`, in the grid of `crop`'s coordinates) carried onto the grown
 *  grid `crop`: new area reveals, existing coverage stays aligned. */
export function expandMask(mask: Raster, sourceRect: Rect, crop: Rect): Raster {
  if (sourceRect.x === crop.x && sourceRect.y === crop.y && sourceRect.width === crop.width && sourceRect.height === crop.height) return mask;
  const out = new Uint8Array(crop.width * crop.height).fill(255);
  const ox = sourceRect.x - crop.x, oy = sourceRect.y - crop.y;
  const aligned = mask.width === sourceRect.width && mask.height === sourceRect.height;
  const rows = aligned ? null : new Map<number, Uint8Array>();
  for (let y = Math.max(0, oy); y < Math.min(crop.height, oy + sourceRect.height); y++) {
    const gy = y - oy;
    let row: Uint8Array;
    if (aligned) row = mask.readRegion(0, gy, mask.width, 1);
    else {
      const my = Math.min(mask.height - 1, Math.floor((gy + 0.5) * mask.height / sourceRect.height));
      row = rows!.get(my) ?? mask.readRegion(0, my, mask.width, 1);
      rows!.set(my, row);
    }
    for (let x = Math.max(0, ox); x < Math.min(crop.width, ox + sourceRect.width); x++) {
      const gx = x - ox;
      const mx = aligned ? gx : Math.min(mask.width - 1, Math.floor((gx + 0.5) * mask.width / sourceRect.width));
      out[y * crop.width + x] = row[mx];
    }
  }
  return Raster.fromData(crop.width, crop.height, 1, out);
}

const rasterEdits = {
  /** A tiled raster edit of the active layer's pixels or mask, within the shared pixel budgets. */
  makeRasterEdit(this: EditorSession, layer: Layer, settings: BrushSettings = defaultBrushSettings()): BrushStroke {
    const document = this.document;
    if (!document) throw new TooLargeError();
    const mask = this.isMaskSelected;
    const stroke = new BrushStroke(layer, mask, settings, document.width, document.height);
    const used = document.layers.filter((l) => l.id !== layer.id).reduce((total, l) => {
      const image = mask ? l.mask?.asset.image : l.asset?.image;
      return total + (image ? image.width * image.height : 0);
    }, 0);
    stroke.pixelLimit = 100_000_000 - used;
    stroke.selectionClip = document.selection ? selectionClip(document.selection, document.width, document.height) : null;
    if (!mask && layer.mask) {
      const maskPixels = document.layers.filter((l) => l.id !== layer.id)
        .reduce((total, l) => total + (l.mask ? l.mask.asset.image.width * l.mask.asset.image.height : 0), 0);
      stroke.pixelLimit = Math.min(stroke.pixelLimit, 100_000_000 - maskPixels);
    }
    return stroke;
  },

  /** A brush stroke's tiles installed at once as one undo step; painting keeps at least the layer's old bounds. */
  commitPaintSnapshot(this: EditorSession, stroke: BrushStroke): void {
    const result = stroke.result(false);
    const index = this.layerIndex(stroke.layer.id);
    if (!isValidTransform(result.transform) || index < 0) return;
    const current = this.document!.layers[index];
    if ((current.asset?.image ?? null) !== (stroke.layer.asset?.image ?? null) || !transformsEqual(current.transform, stroke.layer.transform)) return;
    this.installRasterEdit(stroke, current, result.raster, result.transform, result.bounds,
      stroke.editName ?? (stroke.isMask ? 'Paint Mask' : stroke.settings.erasing ? 'Erase' : stroke.isBlur ? 'Blur'
        : stroke.clone ? 'Clone Stamp' : stroke.settings.healing ? 'Spot Healing' : 'Brush Stroke'));
  },

  /** Fills, clears, gradients and moved pixels: the result trimmed to what is there, as one undo step. */
  async commitRasterEdit(this: EditorSession, stroke: BrushStroke, name: string, alsoApply?: () => void): Promise<void> {
    await this.whileBusy(async () => {
      const result = stroke.result(true);
      if (!isValidTransform(result.transform)) throw new TooLargeError();
      const index = this.layerIndex(stroke.layer.id);
      if (index < 0) return;
      const current = this.document!.layers[index];
      // Built from this layer's pixels, transform and mask; never written over content that changed underneath.
      if ((current.asset?.image ?? null) !== (stroke.layer.asset?.image ?? null) || !transformsEqual(current.transform, stroke.layer.transform)
          || (current.mask?.asset.image ?? null) !== (stroke.layer.mask?.asset.image ?? null)) return;
      this.installRasterEdit(stroke, current, result.raster, result.transform, result.bounds, name, alsoApply);
    });
  },

  installRasterEdit(this: EditorSession, stroke: BrushStroke, current: Layer, raster: Raster, transform: import('../model/transform').LayerTransform,
                    bounds: Rect, name: string, alsoApply?: () => void): void {
    const index = this.layerIndex(current.id);
    let mask: LayerMask | null = current.mask;
    // Painting past the old bounds grows the layer; a mask covering its grid grows with it, revealing the new area.
    if (!stroke.isMask && mask && !mask.placement) {
      const s = stroke.sourceRect;
      if (bounds.x !== s.x || bounds.y !== s.y || bounds.width !== s.width || bounds.height !== s.height) {
        mask = { ...mask, asset: asset(expandMask(mask.asset.image, s, bounds), mask.asset.name) };
      }
    }
    this.beginEdit(name);
    this.updateDocument((d) => {
      const layer = d.layers[index];
      if (stroke.isMask) {
        const image = asset(raster, layer.mask?.asset.name ?? 'Layer Mask');
        layer.mask = (layer.mask ? { ...layer.mask, asset: image } : { asset: image, isEnabled: true, placement: null, isLinked: true }) as never;
      } else {
        layer.asset = asset(raster, layer.name) as never;
        layer.transform = transform as never;
        layer.mask = mask as never;
        layer.isGroup = false;
        layer.adjustment = null;
        layer.shape = null;
      }
    });
    alsoApply?.();
    this.endEdit();
    this.gpu?.releaseStroke(stroke);
    this.brushRevision += 1;
  },
};

type RasterEdits = typeof rasterEdits;
declare module './session' {
  interface EditorSession extends RasterEdits {}
}
extend(EditorSession, rasterEdits);
