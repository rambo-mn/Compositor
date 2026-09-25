// Painting: the Brush (paint and erase), Spot Healing, Clone Stamp and the Smear tool's Blur, Smudge and Liquify;
// the Gradient tool; brush size, hardness and opacity keys. Ports EditorSession+Brush.swift, CloneStamp.swift,
// BlurTool.swift, SmudgeLiquify.swift and Gradient.swift.
import { EditorSession } from './session';
import { extend } from './observable';
import type { Point } from '../model/geometry';
import { effectiveVisibleIDs } from '../model/document';
import { isBrushTool } from '../model/settings';
import { Raster } from '../raster/raster';
import { imageOn, liveScene, maskBackground } from './scene';
import { singleLayerScene } from './selection';
import { WarpStroke } from './warp';

const paint = {
  /** Whether the active layer (or its mask) can be painted: an empty selection leaves nothing paintable. */
  get canPaint(): boolean {
    const s = this as unknown as EditorSession;
    const layer = s.activeLayer;
    return s.canEditLayers && s.selectedLayerIDs.size === 1 && !!layer && (!layer.isGroup || s.isMaskSelected)
      && s.selection?.path.isEmpty !== true && !!s.document && effectiveVisibleIDs(s.document).has(layer.id)
      && (!s.isMaskSelected || layer.mask?.isEnabled === true) && (s.isMaskSelected || !layer.adjustment);
  },

  beginBrush(this: EditorSession, point: Point): void {
    if (this.tool === 'blur' && this.blurMode !== 'Blur') { this.beginWarp(point); return; }
    // Spot Healing and Clone Stamp rework image pixels; they have nothing to do on a mask.
    const allowed = this.tool === 'brush' || this.tool === 'blur' || (isBrushTool(this.tool) && !this.isMaskSelected);
    const layer = this.activeLayer, document = this.document;
    if (!allowed || !this.canPaint || !layer || !document) return;
    let clone: { image: Raster; offset: { width: number; height: number } } | null = null;
    if (this.tool === 'cloneStamp') {
      const offset = this.cloneStrokeOffset(point);
      if (!offset) { this.brushError = 'Alt-click where Clone Stamp should copy from first.'; return; }
      const image = this.cloneSample();
      if (!image) return;
      this.cloneOffset = offset;
      clone = { image, offset };
    }
    // Blur paints a softened copy of the layer, in place, through the brush tip.
    if (this.tool === 'blur') {
      const image = this.blurSample(this.isMaskSelected);
      if (!image) return;
      clone = { image, offset: { width: 0, height: 0 } };
    }
    this.finishOpacityEdit();
    try {
      const settings = { ...this.brushSettings, healing: this.tool === 'spotHealing',
        erasing: this.tool === 'brush' && this.brushMode === 'Erase' && !this.isMaskSelected, healingMode: this.spotHealingMode };
      if (this.isMaskSelected) { const v = this.maskPaintWhite ? 1 : 0; settings.red = v; settings.green = v; settings.blue = v; }
      const stroke = this.makeRasterEdit(layer, settings);
      stroke.clone = clone;
      stroke.isBlur = this.tool === 'blur';
      this.brushStroke = stroke;
      stroke.append(point);
      this.lastBrushPoint = { point, layerID: layer.id, mask: this.isMaskSelected };
      this.brushRevision += 1;
    } catch (error) { this.cancelBrush(); this.brushError = (error as Error).message; }
  },

  continueBrush(this: EditorSession, point: Point): void {
    const warp = this.warpStroke;
    if (warp) {
      warp.append(point);
      if (this.lastBrushPoint) this.lastBrushPoint = { ...this.lastBrushPoint, point };
      this.brushRevision += 1;
      return;
    }
    const stroke = this.brushStroke;
    if (!stroke) return;
    try {
      stroke.append(point);
      if (this.lastBrushPoint) this.lastBrushPoint = { ...this.lastBrushPoint, point };
      this.brushRevision += 1;
    } catch (error) { this.cancelBrush(); this.brushError = (error as Error).message; }
  },

  /** Where a Shift-click paints a line from: the end of the last stroke on the same layer (or mask). */
  shiftLineStart(this: EditorSession): Point | null {
    const last = this.lastBrushPoint;
    return last && last.layerID === this.activeLayerID && last.mask === this.isMaskSelected ? last.point : null;
  },

  cancelBrush(this: EditorSession): void {
    if (this.warpStroke) this.gpu?.releaseWarp(this.warpStroke);
    if (this.brushStroke) this.gpu?.releaseStroke(this.brushStroke);
    this.warpStroke = null;
    this.brushStroke = null;
    this.brushRevision += 1;
  },

  /** Called by pointer-up, before the next input event. */
  finishBrushImmediately(this: EditorSession): boolean {
    if (this.warpStroke) {
      if (this.isProjectBusy) return false;
      this.finishWarp();
      return true;
    }
    const stroke = this.brushStroke;
    if (!stroke) return true;
    if (this.isProjectBusy) return false;
    try {
      stroke.flush();
      if (stroke.settings.healing) stroke.heal((Math.random() * 0x100000000) >>> 0);
      if (stroke.hasEdits) this.commitPaintSnapshot(stroke);
    } catch (error) { this.brushError = (error as Error).message; }
    this.brushStroke = null;
    this.gpu?.releaseStroke(stroke);
    this.brushRevision += 1;
    return true;
  },

  async finishBrush(this: EditorSession): Promise<void> { this.finishBrushImmediately(); },

  // MARK: Clone Stamp

  /** Alt-click: where Clone Stamp copies from. A new source starts a new alignment. */
  setCloneSource(this: EditorSession, point: Point): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.cloneSource = point;
    this.cloneOffset = null;
  },
  /** The whole-pixel offset a stroke starting at `point` copies with: aligned strokes keep the first stroke's. */
  cloneStrokeOffset(this: EditorSession, point: Point): { width: number; height: number } | null {
    const source = this.cloneSource;
    if (!source) return null;
    return (this.cloneSettings.aligned ? this.cloneOffset : null)
      ?? { width: Math.round(source.x - point.x), height: Math.round(source.y - point.y) };
  },
  /** Where the source sits for a brush at `point`, for the canvas's crosshair. */
  cloneSamplePoint(this: EditorSession, point: Point): Point | null {
    const source = this.cloneSource;
    if (!source) return null;
    const offset = this.cloneOffset;
    if (!offset || !(this.cloneSettings.aligned || this.brushStroke)) return source;
    return { x: point.x + offset.width, y: point.y + offset.height };
  },
  /** What a Clone Stamp stroke copies from, at document size: the active layer's pixels, or every visible layer. */
  cloneSample(this: EditorSession): Raster | null {
    const document = this.document, gpu = this.gpu;
    if (!document || !gpu) return null;
    const rect = { x: 0, y: 0, width: document.width, height: document.height };
    let pixels: Uint8Array;
    if (this.cloneSettings.sampleAllLayers) pixels = gpu.renderRegion(liveScene(this, document), rect);
    else {
      const layer = this.activeLayer;
      if (!layer?.asset) return Raster.blank(document.width, document.height, 4);
      pixels = gpu.renderRegion(singleLayerScene(document.width, document.height, imageOn(layer.asset.image, this.displayedTransform(layer))), rect);
    }
    return Raster.fromData(document.width, document.height, 4, pixels);
  },

  // MARK: Smear: Blur

  /** What a Blur stroke paints: the active layer (or its mask) as the canvas shows it, at document size, softened by
   *  an amount that follows the brush size. Taken when the stroke starts, so going over an area again softens it more. */
  blurSample(this: EditorSession, mask = false): Raster | null {
    const document = this.document, gpu = this.gpu, layer = this.activeLayer;
    if (!document || !gpu || !layer) return null;
    const sigma = Math.min(30, Math.max(1.5, this.brushSettings.diameter / 10));
    const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    if (mask) {
      const owned = layer.mask;
      if (!owned) return null;
      // Past its pixels a mask keeps its edge tone, so blurring near its edge doesn't pull in the wrong one.
      const placement = owned.placement ?? layer.transform;
      const gray = gpu.renderMask({ image: imageOn(owned.asset.image, placement), outside: maskBackground(owned.asset.image) },
        document.width, document.height, identity);
      return gpu.gaussianBlur(Raster.fromData(document.width, document.height, 1, gray), sigma, true);
    }
    if (!layer.asset) return null;
    const pixels = gpu.renderRegion(singleLayerScene(document.width, document.height, imageOn(layer.asset.image, this.displayedTransform(layer))),
      { x: 0, y: 0, width: document.width, height: document.height });
    return gpu.gaussianBlur(Raster.fromData(document.width, document.height, 4, pixels), sigma, false);
  },

  // MARK: Smear: Smudge and Liquify

  beginWarp(this: EditorSession, point: Point): void {
    const layer = this.activeLayer, document = this.document, gpu = this.gpu;
    if (!this.canPaint || this.isMaskSelected || !layer?.asset || !document || !gpu) {
      if (this.isMaskSelected) this.brushError = 'Smudge and Liquify work on a layer’s pixels, not its mask.';
      return;
    }
    this.finishOpacityEdit();
    try {
      const pixels = gpu.renderRegion(singleLayerScene(document.width, document.height, imageOn(layer.asset.image, this.displayedTransform(layer))),
        { x: 0, y: 0, width: document.width, height: document.height });
      const stroke = new WarpStroke(layer, pixels, document.width, document.height, this.blurMode, this.brushSettings);
      stroke.append(point);
      this.warpStroke = stroke;
      this.lastBrushPoint = { point, layerID: layer.id, mask: false };
      this.brushRevision += 1;
    } catch (error) { this.brushError = (error as Error).message; }
  },

  /** Paints the finished Smudge or Liquify result into the layer's pixels along the stroke, as one undo step. */
  finishWarp(this: EditorSession): void {
    const warp = this.warpStroke;
    if (!warp) return;
    this.warpStroke = null;
    this.gpu?.releaseWarp(warp);
    this.brushRevision += 1;
    const current = this.layer(warp.layer.id);
    if (!warp.points.length || !current || current.asset?.image !== warp.layer.asset?.image) return;
    try {
      // A hard tip a little wider than the brush covers everything the stroke moved.
      const settings = { ...this.brushSettings, diameter: warp.diameter + 4, hardness: 1, opacity: 1, erasing: false, healing: false };
      const stroke = this.makeRasterEdit(current, settings);
      stroke.clone = { image: Raster.fromData(warp.width, warp.height, 4, warp.pixels), offset: { width: 0, height: 0 } };
      stroke.replacesWithClone = true;
      stroke.editName = warp.mode;
      for (const point of warp.points) stroke.append(point);
      stroke.flush();
      if (stroke.hasEdits) this.commitPaintSnapshot(stroke);
    } catch (error) { this.brushError = (error as Error).message; }
  },

  // MARK: Keys

  /** Tools where number keys set opacity: brushes, the gradient, or with Move the selected layers' opacity. */
  get usesOpacityKeys(): boolean {
    const s = this as unknown as EditorSession;
    return isBrushTool(s.tool) || s.tool === 'gradient' || s.tool === 'move';
  },

  /** Photoshop's opacity keys: 1 = 10% … 9 = 90%, 0 = 100%; two digits typed quickly set an exact value. */
  typeOpacityDigit(this: EditorSession, digit: number, time = performance.now() / 1000): void {
    if (!this.usesOpacityKeys || this.brushStroke || this.isProjectBusy || !(digit >= 0 && digit <= 9)) return;
    let percent = digit === 0 ? 100 : digit * 10;
    const pending = this.pendingOpacityDigit;
    if (pending && time - pending.time < 0.6) {
      percent = Math.max(1, pending.digit * 10 + digit);
      this.pendingOpacityDigit = null;
    } else {
      this.pendingOpacityDigit = { digit, time };
    }
    const value = percent / 100;
    if (isBrushTool(this.tool)) this.brushSettings = { ...this.brushSettings, opacity: value };
    else if (this.tool === 'gradient') this.gradientSettings = { ...this.gradientSettings, opacity: value };
    else this.setSelectedLayersOpacity(value);
  },

  /** Shift+[ / Shift+]: hardness in 25% steps. */
  changeBrushHardness(this: EditorSession, increase: boolean): void {
    if (this.brushStroke) return;
    const quarter = this.brushSettings.hardness * 4;
    const step = increase ? Math.floor(quarter + 0.001) + 1 : Math.ceil(quarter - 0.001) - 1;
    this.brushSettings = { ...this.brushSettings, hardness: Math.min(4, Math.max(0, step)) / 4 };
  },

  /** [ / ]: a step of a fifth, but always at least one pixel. */
  changeBrushSize(this: EditorSession, increase: boolean): void {
    if (this.brushStroke) return;
    const current = this.brushSettings.diameter;
    const stepped = increase ? Math.max(current + 1, Math.round(current * 1.2)) : Math.min(current - 1, Math.round(current / 1.2));
    this.brushSettings = { ...this.brushSettings, diameter: Math.min(2000, Math.max(1, stepped)) };
  },

  // MARK: Gradient

  beginGradient(this: EditorSession, point: Point): void {
    const layer = this.activeLayer;
    if (this.tool !== 'gradient' || !(this.canPaint || this.gradientEdit) || !layer) return;
    // Dragging a new line replaces the pending one on the same target.
    const edit = this.gradientEdit;
    if (edit && edit.raster.layer.id === layer.id && edit.raster.isMask === this.isMaskSelected) {
      this.gradientEdit = { ...edit, start: point, end: point };
      this.refreshGradient();
      return;
    }
    if (!this.canPaint) return;
    this.finishOpacityEdit();
    try {
      this.gradientEdit = { raster: this.makeRasterEdit(layer), start: point, end: point };
      this.brushRevision += 1;
    } catch (error) { this.brushError = (error as Error).message; }
  },

  moveGradient(this: EditorSession, start: Point | null = null, end: Point | null = null): void {
    const edit = this.gradientEdit;
    if (!edit) return;
    this.gradientEdit = { ...edit, start: start ?? edit.start, end: end ?? edit.end };
    this.refreshGradient();
  },

  /** Re-renders the pending gradient from the current endpoints, settings and palette. */
  refreshGradient(this: EditorSession): void {
    const edit = this.gradientEdit;
    if (!edit) return;
    if (Math.hypot(edit.end.x - edit.start.x, edit.end.y - edit.start.y) >= 0.5) {
      try {
        edit.raster.fillGradient(this.gradientSettings.shape === 'Radial', edit.start, edit.end,
          this.gradientColors(edit.raster.isMask), this.gradientSettings.opacity);
      } catch (error) { this.cancelGradient(); this.brushError = (error as Error).message; return; }
    }
    this.brushRevision += 1;
  },

  /** The gradient's two ends as straight RGBA (0–1); masks read the red channel as gray. */
  gradientColors(this: EditorSession, _mask: boolean): [number[], number[]] {
    const fg = this.paletteColor(false);
    const colors: [number[], number[]] = this.gradientSettings.style === 'Foreground to Background'
      ? [[fg.red, fg.green, fg.blue, 1], (() => { const bg = this.paletteColor(true); return [bg.red, bg.green, bg.blue, 1]; })()]
      : [[fg.red, fg.green, fg.blue, 1], [fg.red, fg.green, fg.blue, 0]];
    return this.gradientSettings.reversed ? [colors[1], colors[0]] : colors;
  },

  /** Ends a drag; a click without a line leaves nothing pending. */
  endGradientDrag(this: EditorSession): void {
    const edit = this.gradientEdit;
    if (edit && Math.hypot(edit.end.x - edit.start.x, edit.end.y - edit.start.y) < 0.5) this.cancelGradient();
  },

  cancelGradient(this: EditorSession): void {
    if (!this.gradientEdit) return;
    this.gpu?.releaseStroke(this.gradientEdit.raster);
    this.gradientEdit = null;
    this.brushRevision += 1;
  },

  async commitGradient(this: EditorSession): Promise<void> {
    const edit = this.gradientEdit;
    if (!edit || this.isProjectBusy) return;
    if (Math.hypot(edit.end.x - edit.start.x, edit.end.y - edit.start.y) < 0.5) { this.cancelGradient(); return; }
    try { await this.commitRasterEdit(edit.raster, edit.raster.isMask ? 'Gradient Mask' : 'Gradient'); }
    catch (error) { this.brushError = (error as Error).message; }
    if (this.gradientEdit?.raster === edit.raster) this.cancelGradient();
  },

  /** Switching tools, layers or targets applies the pending gradient, as in Photoshop. */
  resolveGradient(this: EditorSession): void {
    if (this.gradientEdit) void this.commitGradient();
  },
};

type Paint = typeof paint;
declare module './session' {
  interface EditorSession extends Paint {}
}
extend(EditorSession, paint);
