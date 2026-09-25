// The colour and filter dialogs: Levels, Hue/Saturation, and the Filter menu (Gaussian Blur, Motion Blur, Add Noise,
// Lens Correction, Remove Background, Content-Aware Fill) with the Image menu's Curves, Exposure, Gradient Map and
// Grain; and editing adjustment layers with the same dialogs. Colour adjustments preview live on the GPU; filters
// render their previews in a worker from a copy at most 2048 pixels across. Ports Levels.swift, LevelsAutomatic.swift,
// HueSaturation.swift, Filters.swift and AdjustmentEditing.swift.
import { EditorSession } from './session';
import { extend } from './observable';
import type { ScenePreview } from '../gl/compositor';
import {
  ColorRange, COLOR_RANGES, HueSaturationSettings, LayerAdjustment, LevelsAuto, LevelsSample, LevelsSettings,
  autoLevels, bandCentered, bandExcluding, bandIncluding, curvesIsIdentity, curvesTables, defaultLevels, exposureIsIdentity,
  exposureTables, gradientMapTable, hsBand, hsIsIdentity, hsWith, hsWithBand, hsWeight, levelsIsIdentity, levelsSampling,
  levelsTables, makeAdjustment, makeHueSaturation, resolvedHSV, hueSaturationCube, CUBE_DIMENSION,
} from '../model/adjustments';
import { FilterKind, FilterSettings, defaultFilterSettings, isAutomaticFilter, isImageAdjustment, normalizedFilterSettings } from '../model/settings';
import type { Point, Rect } from '../model/geometry';
import { applyPoint, invert, integral, union } from '../model/geometry';
import { LayerTransform, pixelToDocument } from '../model/transform';
import { Raster, alphaBounds, downsampleArea } from '../raster/raster';
import { SelectionClip, clipCoverageInGrid, selectionClip } from '../raster/rasterize';
import type { Layer } from '../model/document';
import { asset, effectiveVisibleIDs } from '../model/document';
import { hsbFromRGB } from '../model/color';
import { imageOn, maskBackground, plainScene, selectionMask } from './scene';
import { refineMatte } from '../raster/kernels/guidedMatte';

const MOTION_RADIUS_PER_PIXEL = 1 / Math.sqrt(12);
const LENS_STRENGTH = 0.35;

// MARK: Edit state

/** The layer being adjusted, as a dialog saw it when it opened. */
abstract class LayerEdit {
  committing = false;
  preview = true;
  constructor(readonly layerID: string, readonly original: Raster, readonly transform: LayerTransform, readonly selection: SelectionClip | null) {}
  get mapping() { return pixelToDocument(this.transform, this.original.width, this.original.height); }
}

export class LevelsEdit extends LayerEdit {
  settings: LevelsSettings = defaultLevels();
  sampleMode: LevelsSample | null = null;
  histogram: number[][] = [0, 1, 2, 3].map(() => new Array(256).fill(0));
  histogramReady = false;
}

export class HueSaturationEdit extends LayerEdit {
  settings: HueSaturationSettings = makeHueSaturation();
}

export class FilterEdit extends LayerEdit {
  settings: FilterSettings;
  previewError: string | null = null;
  preparing = false;
  /** Add Noise's and Grain's pattern, fixed while the panel is open. */
  readonly seed = (Math.random() * 0x100000000) >>> 0;
  preparedPreview: Raster | null = null;
  preparedSettings: FilterSettings | null = null;
  /** A filter reaching past the layer's edge works on the layer padded out (a blur's room to spread,
   *  Content-Aware Fill over a selection past the edge), placed by `grownTransform`. */
  grownImage: Raster | null = null;
  grownTransform: LayerTransform | null = null;
  grownMargin = 0;
  pending = false;
  running = false;

  constructor(readonly kind: FilterKind, layerID: string, original: Raster, transform: LayerTransform, selection: SelectionClip | null, settings: FilterSettings) {
    super(layerID, original, transform, selection);
    this.settings = normalizedFilterSettings(settings);
  }

  /** The image the filter works on and the transform placing it. */
  get working(): { image: Raster; transform: LayerTransform } {
    return { image: this.grownImage ?? this.original, transform: this.grownTransform ?? this.transform };
  }

  previewImageFor(id: string): Raster | null { return this.preview && id === this.layerID ? this.preparedPreview : null; }

  /** Colour adjustments preview on the GPU; the rest render pixels. */
  get previewsOnGPU(): boolean { return this.kind === 'Curves' || this.kind === 'Exposure' || this.kind === 'Gradient Map'; }

  static blurMargin(kind: FilterKind, settings: FilterSettings): number {
    if (kind === 'Gaussian Blur') return settings.radius * 3 + 2;
    if (kind === 'Motion Blur') return settings.distance / 2 + 2;
    return 0;
  }

  /** Pads the layer out to cover `extent` (layer pixels). */
  grow(extent: Rect): void {
    const bounds = { x: 0, y: 0, width: this.original.width, height: this.original.height };
    const current = this.grownImage ? { x: -this.grownOffset.x, y: -this.grownOffset.y, width: this.grownImage.width, height: this.grownImage.height } : bounds;
    const target = integral(union(current, extent));
    if (target.x === current.x && target.y === current.y && target.width === current.width && target.height === current.height) return;
    if (target.width > 30_000 || target.height > 30_000 || target.width * target.height > 100_000_000) throw new Error('The layer would grow too large.');
    const image = Raster.fromData(target.width, target.height, 4, this.original.readRegion(target.x, target.y, target.width, target.height, 0));
    const toDocument = pixelToDocument(this.transform, bounds.width, bounds.height);
    const size = { width: target.width * this.transform.size.width / bounds.width, height: target.height * this.transform.size.height / bounds.height };
    const middle = applyPoint(toDocument, { x: target.x + target.width / 2, y: target.y + target.height / 2 });
    this.grownImage = image;
    this.grownOffset = { x: -target.x, y: -target.y };
    this.grownTransform = { ...this.transform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
    this.grownMargin = Math.min(-target.x, -target.y, target.x + target.width - bounds.width, target.y + target.height - bounds.height);
    this.preparedPreview = null;
  }
  grownOffset = { x: 0, y: 0 };

  growForBlur(): void {
    const margin = FilterEdit.blurMargin(this.kind, this.settings);
    if (margin <= this.grownMargin) return;
    const m = Math.ceil(margin);
    this.grow({ x: -m, y: -m, width: this.original.width + m * 2, height: this.original.height + m * 2 });
  }
}

/** A copy of `raster` no larger than `limit` on its longest side, and the scale it was made at. */
function previewCopy(raster: Raster, limit: number): { image: Raster; scale: number } {
  const factor = Math.min(1, limit / Math.max(raster.width, raster.height));
  if (factor >= 1) return { image: raster, scale: 1 };
  const width = Math.max(1, Math.floor(raster.width * factor)), height = Math.max(1, Math.floor(raster.height * factor));
  return { image: Raster.fromData(width, height, raster.channels, downsampleArea(raster, width, height)), scale: width / raster.width };
}

/** The luminance of premultiplied RGBA over black, 0–1: a guide for refining a mask. */
function luminancePlane(data: Uint8Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  return out;
}

const edits = {
  /** Colour adjustments need a visible image layer (not a mask), and a non-empty selection if there is one. */
  get canAdjustColors(): boolean {
    const s = this as unknown as EditorSession;
    const layer = s.activeLayer;
    return !s.levels && !s.filterEdit && !!s.document && !!layer && !s.isProjectBusy && !s.isImporting && !s.brushStroke
      && !s.pixelMove && s.renamingLayerID == null && !s.showsNewDocument && !s.showsImporter && s.selectedLayerIDs.size === 1
      && !layer.isGroup && !s.isMaskSelected && !!layer.asset && effectiveVisibleIDs(s.document).has(layer.id)
      && s.selection?.path.isEmpty !== true;
  },

  selectionClipNow(this: EditorSession): SelectionClip | null {
    const document = this.document;
    return document?.selection ? selectionClip(document.selection, document.width, document.height) : null;
  },

  /** The GPU preview for a layer being adjusted in a dialog, if any. */
  colorPreviewFor(this: EditorSession, layerID: string): ScenePreview | null {
    if (this.adjustmentEditingID) return null;
    let adjustment: LayerAdjustment | null = null;
    const levels = this.levels, hue = this.hueSaturation, filter = this.filterEdit;
    if (levels && levels.layerID === layerID && levels.preview && !levelsIsIdentity(levels.settings)) {
      adjustment = { ...makeAdjustment('Levels'), levels: levels.settings };
    } else if (hue && hue.layerID === layerID && hue.preview && !hsIsIdentity(hue.settings)) {
      adjustment = { ...makeAdjustment('Hue/Saturation'), hsvSettings: hue.settings };
    } else if (filter && filter.layerID === layerID && filter.preview && filter.previewsOnGPU) {
      if (filter.kind === 'Curves' && !curvesIsIdentity(filter.settings.curves)) adjustment = { ...makeAdjustment('Curves'), curves: filter.settings.curves };
      if (filter.kind === 'Exposure' && !exposureIsIdentity(filter.settings.exposure)) adjustment = { ...makeAdjustment('Exposure'), exposureSettings: filter.settings.exposure };
      if (filter.kind === 'Gradient Map') adjustment = { ...makeAdjustment('Gradient Map'), gradientMapSettings: filter.settings.gradientMap };
    }
    if (!adjustment) return null;
    return { adjustment, clip: this.selection ? selectionMask(this) : null };
  },

  // MARK: Levels

  beginLevels(this: EditorSession): void {
    if (this.levels || this.hueSaturation || !this.canAdjustColors) return;
    if (this.gradientEdit) { void this.commitGradient().then(() => this.beginLevels()); return; }
    this.commitTransform(); this.cancelCrop(); this.cancelLasso();
    const layer = this.activeLayer;
    if (!layer?.asset) return;
    const edit = new LevelsEdit(layer.id, layer.asset.image, layer.transform, this.selectionClipNow());
    this.levels = edit;
    void this.computeHistogram(edit);
  },

  async computeHistogram(this: EditorSession, edit: LevelsEdit, source?: Raster): Promise<void> {
    if (!this.workers) return;
    const image = previewCopy(source ?? edit.original, 4000).image;
    const data = image.toData();
    let coverage: Uint8Array | null = null;
    if (edit.selection) {
      const toDocument = pixelToDocument(edit.transform, image.width, image.height);
      coverage = clipCoverageInGrid(edit.selection, toDocument, invert(toDocument), 0, 0, image.width, image.height);
    }
    try {
      const bins = await this.workers.run('histogram', { data, coverage }, [data.buffer]);
      if (this.levels !== edit) return;
      edit.histogram = [0, 1, 2, 3].map((c) => Array.from(bins.subarray(c * 256, (c + 1) * 256)));
      edit.histogramReady = true;
      this.changed();
    } catch { edit.histogramReady = true; this.changed(); }
  },

  updateLevels(this: EditorSession, settings: LevelsSettings, preview: boolean): void {
    const edit = this.levels;
    if (!edit || edit.committing) return;
    edit.settings = settings;
    edit.preview = preview;
    this.previewAdjustmentEditing(preview);
    this.changed();
    this.brushRevision += 1;
  },

  autoLevels(this: EditorSession, mode: LevelsAuto): void {
    const edit = this.levels;
    if (!edit || !edit.histogramReady || edit.committing) return;
    edit.sampleMode = null;
    this.updateLevels(autoLevels(mode, edit.histogram), edit.preview);
  },

  setLevelsSampleMode(this: EditorSession, mode: LevelsSample | null): void {
    if (!this.levels) return;
    this.levels.sampleMode = mode;
    this.changed();
  },

  /** The eyedroppers: the layer's own pixel under the point sets black, gray or white. */
  sampleLevels(this: EditorSession, point: Point): void {
    const edit = this.levels, document = this.document;
    if (!edit || !edit.sampleMode || edit.committing || !document || !(point.x >= 0 && point.y >= 0 && point.x < document.width && point.y < document.height)) return;
    const pixel = applyPoint(invert(edit.mapping), point);
    const x = Math.floor(pixel.x), y = Math.floor(pixel.y);
    if (x < 0 || y < 0 || x >= edit.original.width || y >= edit.original.height) return;
    const [r, g, b, a] = edit.original.pixel(x, y);
    if (!a) return;
    this.updateLevels(levelsSampling(edit.settings, [r, g, b].map((v) => Math.min(1, v / a)), edit.sampleMode), edit.preview);
  },

  cancelLevels(this: EditorSession): void {
    if (this.finishAdjustmentEditing(false)) return;
    const edit = this.levels;
    if (!edit || edit.committing) return;
    this.levels = null;
    this.brushRevision += 1;
  },

  async commitLevels(this: EditorSession): Promise<void> {
    if (this.finishAdjustmentEditing(true)) return;
    const edit = this.levels;
    if (!edit || edit.committing) return;
    if (levelsIsIdentity(edit.settings)) { this.cancelLevels(); return; }
    edit.committing = true;
    try {
      await this.whileBusy(async () => {
        const data = edit.original.toData();
        const adjusted = await this.workers!.run('tables', { data, tables: levelsTables(edit.settings) });
        await this.installAdjusted(edit, adjusted, 'Levels');
      });
    } catch (error) { this.brushError = (error as Error).message; }
    finally { this.levels = null; this.brushRevision += 1; }
  },

  /** A dialog's full-size result, through its selection, as the layer's new pixels (one undo step). */
  async installAdjusted(this: EditorSession, edit: LayerEdit, adjusted: Uint8Array, name: string): Promise<void> {
    let result = adjusted;
    if (edit.selection) {
      const toDocument = edit.mapping;
      const coverage = clipCoverageInGrid(edit.selection, toDocument, invert(toDocument), 0, 0, edit.original.width, edit.original.height);
      result = await this.workers!.run('blend', { adjusted, original: edit.original.toData(), coverage, channels: 4 });
    }
    const index = this.layerIndex(edit.layerID);
    const current = index >= 0 ? this.document!.layers[index] : null;
    if (!current || current.asset?.image !== edit.original) return;
    const raster = Raster.fromData(edit.original.width, edit.original.height, 4, result);
    this.beginEdit(name);
    this.updateDocument((d) => {
      const target = d.layers[index];
      target.asset = asset(raster, current.name) as never;
      target.shape = null;
    });
    this.endEdit();
  },

  // MARK: Hue/Saturation

  beginHueSaturation(this: EditorSession): void {
    if (this.hueSaturation || !this.canAdjustColors) return;
    this.commitTransform();
    if (this.gradientEdit) this.resolveGradient();
    const layer = this.activeLayer;
    if (!layer?.asset) return;
    this.hueSaturation = new HueSaturationEdit(layer.id, layer.asset.image, layer.transform, this.selectionClipNow());
  },

  updateHueSaturation(this: EditorSession, settings: HueSaturationSettings, preview: boolean): void {
    const edit = this.hueSaturation;
    if (!edit) return;
    edit.settings = settings;
    edit.preview = preview;
    this.previewAdjustmentEditing(preview);
    this.changed();
    this.brushRevision += 1;
  },

  async commitHueSaturation(this: EditorSession): Promise<void> {
    if (this.finishAdjustmentEditing(true)) return;
    const edit = this.hueSaturation;
    if (!edit) return;
    this.hueSampleMode = null;
    this.hueTargeting = false;
    this.hueTargetDrag = null;
    try {
      if (hsIsIdentity(edit.settings)) return;
      await this.whileBusy(async () => {
        const data = edit.original.toData();
        const adjusted = await this.workers!.run('cube', { data, cube: hueSaturationCube(edit.settings), dimension: CUBE_DIMENSION });
        await this.installAdjusted(edit, adjusted, 'Hue/Saturation');
      });
    } catch (error) { this.brushError = (error as Error).message; }
    finally { this.hueSaturation = null; this.brushRevision += 1; }
  },

  cancelHueSaturation(this: EditorSession): void {
    if (this.finishAdjustmentEditing(false)) return;
    this.hueSampleMode = null;
    this.hueTargeting = false;
    this.hueTargetDrag = null;
    if (!this.hueSaturation) return;
    this.hueSaturation = null;
    this.brushRevision += 1;
  },

  /** The hue under a document point, from the visible composite; near-neutral pixels have none. */
  sampledHue(this: EditorSession, point: Point): number | null {
    const color = this.sampleCompositeColor(point);
    if (!color) return null;
    const hsb = hsbFromRGB(color);
    return hsb.saturation > 0.02 ? hsb.hue : null;
  },

  /** The eyedroppers: re-centre, widen or narrow the selected range's band. */
  sampleHueRange(this: EditorSession, point: Point): void {
    const edit = this.hueSaturation, mode = this.hueSampleMode;
    if (!edit || !mode) return;
    const settings = edit.settings;
    const hue = this.sampledHue(point);
    if (settings.range === 'Master' || settings.colorize || hue == null) return;
    const band = hsBand(settings);
    const next = mode === 'replace' ? bandCentered(band, hue) : mode === 'add' ? bandIncluding(band, hue) : bandExcluding(band, hue);
    this.updateHueSaturation(hsWithBand(settings, next), edit.preview);
  },

  /** Targeted adjustment: picks the range owning the sampled colour and drags its saturation (hue with Ctrl). */
  beginHueTargeting(this: EditorSession, point: Point): boolean {
    const edit = this.hueSaturation;
    const hue = edit && this.hueTargeting && !edit.settings.colorize ? this.sampledHue(point) : null;
    if (!edit || hue == null) return false;
    let settings = edit.settings;
    let range: ColorRange = 'Reds', best = -1;
    for (const r of COLOR_RANGES) { const w = hsWeight(settings, r, hue); if (w > best) { best = w; range = r; } }
    settings = { ...settings, range };
    const current = settings.adjustments[range] ?? { hue: 0, saturation: 0, lightness: 0 };
    this.hueTargetDrag = { range, hue: current.hue, saturation: current.saturation };
    this.updateHueSaturation(settings, edit.preview);
    return true;
  },
  dragHueTargeting(this: EditorSession, delta: number, adjustsHue: boolean): void {
    const edit = this.hueSaturation, drag = this.hueTargetDrag;
    if (!edit || !drag) return;
    const settings = adjustsHue
      ? hsWith(edit.settings, 'hue', Math.min(180, Math.max(-180, drag.hue + delta / 2)), drag.range)
      : hsWith(edit.settings, 'saturation', Math.min(100, Math.max(-100, drag.saturation + delta / 2)), drag.range);
    this.updateHueSaturation(settings, edit.preview);
  },
  endHueTargeting(this: EditorSession): void { this.hueTargetDrag = null; },

  // MARK: Filters

  get canContentAwareFill(): boolean {
    const s = this as unknown as EditorSession;
    return s.canAdjustColors && !s.isMaskSelected && s.selection?.path.isEmpty === false && !s.filterEdit && !s.hueSaturation;
  },

  beginFilter(this: EditorSession, kind: FilterKind): void {
    if (kind === 'Content-Aware Fill' && !this.canContentAwareFill) return;
    if (this.filterEdit || this.hueSaturation || !this.canAdjustColors) return;
    if (this.gradientEdit) { void this.commitGradient().then(() => this.beginFilter(kind)); return; }
    this.commitTransform(); this.cancelCrop(); this.cancelLasso();
    const layer = this.activeLayer, document = this.document;
    if (!layer?.asset || !document) return;
    try {
      const settings = { ...this.filterSettings };
      // Gradient Map starts from the foreground and background colours, as in Photoshop.
      if (kind === 'Gradient Map') {
        const fg = this.foregroundColor, bg = this.backgroundColor;
        settings.gradientMap = { shadows: { ...fg }, highlights: { ...bg }, reversed: false };
      }
      const edit = new FilterEdit(kind, layer.id, layer.asset.image, layer.transform, this.selectionClipNow(), settings);
      // Content-Aware Fill extends the layer over any of the selection on the canvas past its edge.
      if (kind === 'Content-Aware Fill' && document.selection?.path.bounds) {
        const b = document.selection.path.bounds;
        const area = { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(document.width, b.x + b.width) - Math.max(0, b.x),
          height: Math.min(document.height, b.y + b.height) - Math.max(0, b.y) };
        if (area.width > 0 && area.height > 0) {
          const toPixels = invert(edit.mapping);
          const corners = [[area.x, area.y], [area.x + area.width, area.y], [area.x, area.y + area.height], [area.x + area.width, area.y + area.height]]
            .map(([x, y]) => applyPoint(toPixels, { x, y }));
          const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
          edit.grow(integral({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }));
        }
      }
      edit.growForBlur();
      this.filterEdit = edit;
      this.updateFilter(edit.settings, true);
    } catch (error) { this.brushError = (error as Error).message; }
  },

  updateFilter(this: EditorSession, settings: FilterSettings, preview: boolean): void {
    const edit = this.filterEdit;
    if (!edit || edit.committing) return;
    edit.settings = normalizedFilterSettings(settings);
    edit.preview = preview;
    // A bigger blur needs more room around the layer than it was given.
    try { edit.growForBlur(); } catch (error) { this.brushError = (error as Error).message; }
    this.changed();
    if (this.previewAdjustmentEditing(preview)) return;
    this.brushRevision += 1;
    if (edit.previewsOnGPU) return;
    if (isAutomaticFilter(edit.kind) && edit.preparedPreview && sameSettings(edit.preparedSettings, edit.settings)) return;
    if (!preview && !isAutomaticFilter(edit.kind)) { edit.preparedPreview = null; return; }
    edit.pending = true;
    void this.renderFilterPreview(edit);
  },

  /** Renders the newest settings; changes arriving mid-render wait for it rather than cancelling it, so a dragged
   *  slider keeps the canvas updating. */
  async renderFilterPreview(this: EditorSession, edit: FilterEdit): Promise<void> {
    if (this.filterEdit !== edit || edit.running || !edit.pending) return;
    edit.pending = false;
    edit.running = true;
    edit.preparing = true;
    edit.previewError = null;
    this.changed();
    const settings = edit.settings;
    try {
      const full = [ 'Add Noise', 'Grain', 'Content-Aware Fill', 'Remove Background' ].includes(edit.kind);
      const { image, scale } = full ? { image: edit.working.image, scale: 1 } : previewCopy(edit.working.image, 2048);
      const result = await this.runFilter(edit, image, scale, settings, true);
      if (this.filterEdit !== edit) return;
      if (edit.preview || isAutomaticFilter(edit.kind)) { edit.preparedPreview = result; edit.preparedSettings = settings; this.brushRevision += 1; }
    } catch (error) {
      if (this.filterEdit === edit) edit.previewError = (error as Error).message;
    } finally {
      edit.running = false;
      edit.preparing = false;
      this.changed();
    }
    if (edit.pending) void this.renderFilterPreview(edit);
  },

  /** One filter over `image` (the working grid, scaled by `scale`), through the selection. */
  async runFilter(this: EditorSession, edit: FilterEdit, image: Raster, scale: number, settings: FilterSettings, preview: boolean): Promise<Raster> {
    const workers = this.workers!;
    const w = image.width, h = image.height;
    const data = image.toData();
    let out: Uint8Array;
    switch (edit.kind) {
      case 'Gaussian Blur':
        out = await workers.run('gaussianBlur', { data, width: w, height: h, channels: 4, sigma: settings.radius * scale, clampEdges: false }, [data.buffer]);
        break;
      case 'Motion Blur':
        out = await workers.run('motionBlur', { data, width: w, height: h, sigma: settings.distance * scale * MOTION_RADIUS_PER_PIXEL, angle: settings.angle }, [data.buffer]);
        break;
      case 'Add Noise':
        out = await workers.run('addNoise', { data, width: w, height: h, amount: settings.amount, gaussian: settings.gaussian, monochromatic: settings.monochromatic, seed: edit.seed }, [data.buffer]);
        break;
      case 'Lens Correction':
        out = await workers.run('lens', { data, width: w, height: h, k: settings.distortion / 100 * LENS_STRENGTH }, [data.buffer]);
        break;
      case 'Curves':
        out = await workers.run('tables', { data, tables: curvesTables(settings.curves) }, [data.buffer]);
        break;
      case 'Exposure':
        out = await workers.run('tables', { data, tables: exposureTables(settings.exposure) }, [data.buffer]);
        break;
      case 'Gradient Map':
        out = await workers.run('gradientMap', { data, width: w, height: h, table: gradientMapTable(settings.gradientMap) }, [data.buffer]);
        break;
      case 'Grain':
        out = await workers.run('grain', { data, width: w, height: h, amount: settings.grain.amount, size: settings.grain.size,
          roughness: settings.grain.roughness, seed: edit.seed, originX: 0, originY: 0, unitsPerPixel: 1 / scale }, [data.buffer]);
        break;
      case 'Content-Aware Fill': {
        const mask = this.selectionOnGrid(edit, w, h);
        if (!mask) throw new Error('Select the area to fill first.');
        const result = await workers.run('contentFill', { data, mask, width: w, height: h }, [data.buffer]);
        if (!result.ok) throw new Error('Not enough unselected, opaque image pixels to synthesize a fill. Use a smaller selection with some surrounding image.');
        return Raster.fromData(w, h, 4, result.data);
      }
      case 'Remove Background': {
        const mask = await this.subjectMask(image, settings, preview ? 1400 : Infinity);
        const pixels = data;
        for (let i = 0; i < w * h; i++) {
          const m = mask[i];
          if (m === 255) continue;
          for (let k = 0; k < 4; k++) pixels[i * 4 + k] = Math.round(pixels[i * 4 + k] * m / 255);
        }
        return Raster.fromData(w, h, 4, pixels);
      }
    }
    if (edit.selection) {
      const coverage = this.selectionOnGrid(edit, w, h)!;
      out = await workers.run('blend', { adjusted: out, original: image.toData(), coverage, channels: 4 });
    }
    return Raster.fromData(w, h, 4, out);
  },

  /** The filter's selection on its working grid at `w` × `h`. */
  selectionOnGrid(this: EditorSession, edit: FilterEdit, w: number, h: number): Uint8Array | null {
    if (!edit.selection) return null;
    const toDocument = pixelToDocument(edit.working.transform, w, h);
    return clipCoverageInGrid(edit.selection, toDocument, invert(toDocument), 0, 0, w, h);
  },

  /** Remove Background's mask for `image`: white over the subject, refined as the panel's settings ask. */
  async subjectMask(this: EditorSession, image: Raster, settings: FilterSettings, limit: number): Promise<Uint8Array> {
    const { segmentSubject } = await import('../ml/segmentation');
    const raw = await segmentSubject(image);
    const w = image.width, h = image.height;
    if (settings.backgroundQuality !== 'Advanced') return raw;
    let mask: Float32Array<ArrayBufferLike> = Float32Array.from(raw, (v) => v / 255);
    if (settings.refineEdges > 0) mask = refineMatte(mask, luminancePlane(image.toData(), w * h), w, h, settings.refineEdges, limit);
    if (settings.shiftEdge !== 0) {
      // A blur then a hard threshold at the matching level moves the edge by the blur's reach.
      const reach = Math.abs(settings.shiftEdge);
      const bytes = Uint8Array.from(mask, (v) => Math.round(v * 255));
      const blurred = await this.workers!.run('gaussianBlur', { data: bytes, width: w, height: h, channels: 1, sigma: reach / 2, clampEdges: true });
      const level = settings.shiftEdge < 0 ? 0.75 : 0.25;
      mask = Float32Array.from(blurred, (v) => Math.min(1, Math.max(0, (v / 255 - level) / 0.001)));
    }
    if (settings.matteContrast > 0) {
      // 0 leaves the mask as it is; 100 is a hard cut at the middle.
      const strength = settings.matteContrast / 100;
      const slope = 1 / Math.max(0.02, 1 - strength * 0.98);
      mask = mask.map((v) => Math.min(1, Math.max(0, v * slope + (1 - slope) / 2)));
    }
    return Uint8Array.from(mask, (v) => Math.round(v * 255));
  },

  cancelFilter(this: EditorSession): void {
    if (this.colorPicker?.target.kind === 'gradientMap') this.closeColorPicker(false);
    if (this.finishAdjustmentEditing(false)) return;
    const edit = this.filterEdit;
    if (!edit || edit.committing) return;
    this.filterEdit = null;
    this.brushRevision += 1;
  },

  async commitFilter(this: EditorSession): Promise<void> {
    if (this.colorPicker?.target.kind === 'gradientMap') this.closeColorPicker(true);
    if (this.finishAdjustmentEditing(true)) return;
    const edit = this.filterEdit;
    if (!edit || edit.committing) return;
    if (isAutomaticFilter(edit.kind)) {
      while (edit.running || edit.pending) await new Promise((r) => setTimeout(r, 50));
      if (this.filterEdit !== edit || !edit.preparedPreview || edit.previewError) return;
    }
    // Nothing to do: close as Cancel does, without an undo step.
    const s = edit.settings;
    if ((edit.kind === 'Lens Correction' && s.distortion === 0) || (edit.kind === 'Exposure' && exposureIsIdentity(s.exposure))
        || (edit.kind === 'Grain' && s.grain.amount === 0) || (edit.kind === 'Curves' && curvesIsIdentity(s.curves))) { this.cancelFilter(); return; }
    edit.committing = true;
    this.filterSettings = edit.settings;
    try {
      await this.whileBusy(async () => {
        if (edit.kind === 'Remove Background') { await this.commitBackgroundMask(edit); return; }
        const cached = isAutomaticFilter(edit.kind) && sameSettings(edit.preparedSettings, edit.settings) ? edit.preparedPreview : null;
        let image = cached ?? await this.runFilter(edit, edit.working.image, 1, edit.settings, false);
        let placed: LayerTransform | null = edit.grownTransform;
        const spreads = edit.kind === 'Gaussian Blur' || edit.kind === 'Motion Blur';
        if (spreads && edit.grownTransform) {
          // Trimmed to what the blur left; its transform keeps the pixels in place.
          const bounds = alphaBounds(image.toData(), image.width, image.height);
          if (bounds && (bounds.width !== image.width || bounds.height !== image.height)) {
            const toDocument = pixelToDocument(edit.grownTransform, image.width, image.height);
            const size = { width: bounds.width * edit.grownTransform.size.width / image.width, height: bounds.height * edit.grownTransform.size.height / image.height };
            const middle = applyPoint(toDocument, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
            image = image.crop(bounds.x, bounds.y, bounds.width, bounds.height);
            placed = { ...edit.grownTransform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
          }
        }
        const index = this.layerIndex(edit.layerID);
        const current = index >= 0 ? this.document!.layers[index] : null;
        if (!current || current.asset?.image !== edit.original) return;
        // A grown layer's mask (covering the old grid) is carried onto the new grid, its edge tone past the old edge.
        let mask = current.mask;
        const target = placed ?? current.transform;
        if (placed && mask && !mask.placement && (mask.asset.image.width > 1 || mask.asset.image.height > 1)) {
          const toGrid = invert(pixelToDocument(target, image.width, image.height));
          const gray = this.gpu!.renderMask({ image: imageOn(mask.asset.image, current.transform), outside: maskBackground(mask.asset.image) },
            image.width, image.height, toGrid);
          mask = { ...mask, asset: asset(Raster.fromData(image.width, image.height, 1, gray), mask.asset.name) };
        }
        this.beginEdit(edit.kind);
        this.updateDocument((d) => {
          const layer = d.layers[index];
          layer.asset = asset(image, current.name) as never;
          layer.transform = target as never;
          layer.mask = mask as never;
          layer.shape = null;
        });
        this.endEdit();
      });
    } catch (error) { this.brushError = (error as Error).message; }
    finally { this.filterEdit = null; this.brushRevision += 1; }
  },

  /** Remove Background as a layer mask: subject white, background black; an existing mask on the layer's grid is
   *  kept (whatever either hides stays hidden); with a selection only the selected part of the mask changes. */
  async commitBackgroundMask(this: EditorSession, edit: FilterEdit): Promise<void> {
    const source = edit.original;
    const current = this.layer(edit.layerID);
    const existing = current?.mask && !current.mask.placement && current.mask.asset.image.width === source.width
      && current.mask.asset.image.height === source.height ? current.mask.asset.image : null;
    let mask = await this.subjectMask(source, edit.settings, Infinity);
    if (existing) {
      const base = existing.toData();
      for (let i = 0; i < mask.length; i++) mask[i] = Math.round(mask[i] * base[i] / 255);
    }
    if (edit.selection) {
      const toDocument = edit.mapping;
      const coverage = clipCoverageInGrid(edit.selection, toDocument, invert(toDocument), 0, 0, source.width, source.height);
      const base = existing ? existing.toData() : new Uint8Array(mask.length).fill(255);
      mask = await this.workers!.run('blend', { adjusted: mask, original: base, coverage, channels: 1 });
    }
    const index = this.layerIndex(edit.layerID);
    const layer = index >= 0 ? this.document!.layers[index] : null;
    if (!layer || layer.asset?.image !== edit.original) return;
    const image = asset(Raster.fromData(source.width, source.height, 1, mask), 'Layer Mask');
    this.beginEdit(edit.kind);
    this.updateDocument((d) => {
      const target = d.layers[index];
      target.mask = (target.mask ? { ...target.mask, asset: image, isEnabled: true } : { asset: image, isEnabled: true, placement: null, isLinked: true }) as never;
    });
    this.isMaskSelected = true;
    this.endEdit();
  },

  // MARK: Adjustment layers

  /** Opens the ordinary dialog for an adjustment layer; its changes go to the layer's settings. The dialog reads the
   *  composite beneath the layer only for its histogram and sampling. */
  async beginAdjustmentEditing(this: EditorSession, id: string): Promise<void> {
    const document = this.document;
    const index = this.layerIndex(id);
    const original = index >= 0 ? document!.layers[index].adjustment : null;
    if (this.adjustmentEditingID !== id || this.adjustmentOriginal || this.levels || this.hueSaturation || this.filterEdit || !document || !original || !this.gpu) return;
    // Everything beneath the adjustment, as it shows.
    const order = new Set<string>();
    for (const layer of document.layers) { if (layer.id === id) break; order.add(layer.id); }
    const scene = plainScene(document);
    for (const s of scene.layers) if (!s.isGroup && !order.has(s.id)) s.isVisible = false;
    const pixels = this.gpu.renderRegion(scene, { x: 0, y: 0, width: document.width, height: document.height });
    const raster = Raster.fromData(document.width, document.height, 4, pixels);
    const stand: Layer = { id: `adjustment-input-${id}`, asset: asset(raster, 'Adjustment input'), transform: { origin: { x: 0, y: 0 },
      size: { width: document.width, height: document.height }, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' },
      name: 'Adjustment input', isVisible: true, parentID: null, isGroup: false, opacity: 1, blendMode: 'Normal', maskSourceID: null,
      mask: null, adjustment: null, shape: null };
    switch (original.kind) {
      case 'Levels': {
        const edit = new LevelsEdit(stand.id, raster, stand.transform, null);
        edit.settings = original.levels;
        this.levels = edit;
        void this.computeHistogram(edit);
        break;
      }
      case 'Hue/Saturation': {
        const edit = new HueSaturationEdit(stand.id, raster, stand.transform, null);
        edit.settings = resolvedHSV(original);
        this.hueSaturation = edit;
        break;
      }
      default: {
        const settings = { ...defaultFilterSettings(), curves: original.curves, exposure: original.exposureSettings ?? defaultFilterSettings().exposure,
          gradientMap: original.gradientMapSettings ?? defaultFilterSettings().gradientMap, grain: original.grainSettings ?? defaultFilterSettings().grain };
        const kind = original.kind as FilterKind;
        this.filterEdit = new FilterEdit(isImageAdjustment(kind) ? kind : 'Curves', stand.id, raster, stand.transform, null, settings);
      }
    }
    this.adjustmentOriginal = original;
    this.beginEdit(`Edit ${original.kind} Adjustment`);
  },

  get editedAdjustment(): LayerAdjustment | null {
    const s = this as unknown as EditorSession;
    const value = s.adjustmentOriginal;
    if (!value) return null;
    switch (value.kind) {
      case 'Levels': return s.levels ? { ...value, levels: s.levels.settings } : null;
      case 'Hue/Saturation': return s.hueSaturation ? { ...value, hsvSettings: s.hueSaturation.settings } : null;
      default: {
        const f = s.filterEdit;
        if (!f) return null;
        if (value.kind === 'Exposure') return { ...value, exposureSettings: f.settings.exposure };
        if (value.kind === 'Gradient Map') return { ...value, gradientMapSettings: f.settings.gradientMap };
        if (value.kind === 'Grain') return { ...value, grainSettings: f.settings.grain };
        return { ...value, curves: f.settings.curves };
      }
    }
  },

  previewAdjustmentEditing(this: EditorSession, preview: boolean): boolean {
    const id = this.adjustmentEditingID, original = this.adjustmentOriginal, value = this.editedAdjustment;
    if (!id || !original || !value) return false;
    this.updateAdjustment(id, preview ? value : original);
    return true;
  },

  /** OK keeps the edited settings; Cancel restores them. */
  finishAdjustmentEditing(this: EditorSession, commit: boolean): boolean {
    const id = this.adjustmentEditingID, original = this.adjustmentOriginal;
    if (!id || !original) return false;
    this.updateAdjustment(id, commit ? (this.editedAdjustment ?? original) : original);
    this.hueSampleMode = null;
    this.hueTargeting = false;
    this.hueTargetDrag = null;
    this.levels = null;
    this.hueSaturation = null;
    this.filterEdit = null;
    this.endEdit();
    this.adjustmentOriginal = null;
    this.adjustmentEditingID = null;
    this.canvasFocusRequest += 1;
    this.brushRevision += 1;
    return true;
  },

  /** Opens the dialog for an existing adjustment layer (double-clicking it in the Layers panel). */
  editAdjustmentLayer(this: EditorSession, id: string): void {
    if (!this.canEditLayers || !this.layer(id)?.adjustment) return;
    this.selectLayer(id);
    this.adjustmentEditingID = id;
    void this.beginAdjustmentEditing(id);
  },
};

function sameSettings(a: FilterSettings | null, b: FilterSettings): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

void hsWeight; void COLOR_RANGES;

type Edits = typeof edits;
declare module './session' {
  interface EditorSession extends Edits {}
}
extend(EditorSession, edits);
