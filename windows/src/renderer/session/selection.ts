// Selections and what they do to pixels: the Marquee, Lasso and Magic Wand, combining and moving outlines,
// Expand/Contract, Select All/Inverse; filling, clearing, inverting; moving and transforming selected pixels;
// Copy, Copy Merged, Cut, Paste and Layer via Copy. Ports Selection.swift, SelectionEdits.swift,
// SelectionClipboard.swift, FloatingSelection.swift and MagicWand.swift.
import { EditorSession } from './session';
import { extend } from './observable';
import {
  DocumentSelection, SelectionMode, SelectionPath, draftOutline, dragBox, pathOffset, pathSubtracting,
  pathUnion, pathIntersection,
} from '../model/selection';
import type { Point, Rect } from '../model/geometry';
import { applyPoint, invert } from '../model/geometry';
import { Raster, premultiply, unpremultiply } from '../raster/raster';
import { rasterizeSelection, selectionClip, clipCoverageInGrid } from '../raster/rasterize';
import { imageOn, liveScene, layerMaskScene, maskBackground, distortedImage } from './scene';
import type { Scene, SceneLayer } from '../gl/compositor';
import type { Layer } from '../model/document';
import { asset, effectiveVisibleIDs, imageLayer, renderLayers } from '../model/document';
import {
  LayerTransform, TransformEdit, cornersOf, isValidTransform, pixelToDocument, makeTransform,
} from '../model/transform';
import { Matrix3, project, unitSquareTo, isUsableQuad } from '../model/projective';
import { encodePNG, decodeImageBytes } from '../io/codecs';
import { expandMask } from './rasterEdits';

const canvasRect = (session: EditorSession): Rect => ({ x: 0, y: 0, width: session.document!.width, height: session.document!.height });

/** A plain layer of a scene: its pixels at full opacity, no mask. */
export function sceneLayer(id: string, image: SceneLayer['image']): SceneLayer {
  return { id, parentID: null, isGroup: false, isVisible: true, image, opacity: 1, blendMode: 'Normal', mask: null,
    maskSourceID: null, adjustment: null };
}

/** One layer's pixels (no mask, full opacity) as a scene. */
export function singleLayerScene(width: number, height: number, image: SceneLayer['image']): Scene {
  return { width, height, layers: [sceneLayer('l', image)] };
}

function hash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 65536))) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return `${bytes.length}:${h}`;
}

const selection = {
  get canEditSelection(): boolean { return (this as unknown as EditorSession).canEditLayers; },

  /** Shift adds, Alt (with or without Shift) subtracts; otherwise the options-bar mode. */
  selectionMode(this: EditorSession, shift: boolean, option: boolean): SelectionMode {
    return option ? 'Subtract' : shift ? 'Add' : this.selectionModeChoice;
  },
  /** The mode the cursor advertises: an outline in progress keeps its starting mode. */
  lassoCursorMode(this: EditorSession, shift: boolean, option: boolean): SelectionMode {
    return this.lassoDraft?.mode ?? this.selectionMode(shift, option);
  },
  get displayedSelectionMode(): SelectionMode {
    const s = this as unknown as EditorSession;
    return s.lassoDraft?.mode ?? s.heldSelectionMode ?? s.selectionModeChoice;
  },
  updateHeldSelectionKeys(this: EditorSession, shift: boolean, option: boolean): void {
    const held: SelectionMode | null = option ? 'Subtract' : shift ? 'Add' : null;
    if (this.heldSelectionMode !== held) this.heldSelectionMode = held;
  },

  beginLasso(this: EditorSession, point: Point, mode: SelectionMode): void {
    if (this.tool !== 'marquee' && this.tool !== 'lasso') return;
    if (!this.canEditSelection || this.selectionMoveOrigin) return;
    if (this.tool === 'marquee') {
      const anchor = { x: Math.round(point.x), y: Math.round(point.y) };
      this.lassoDraft = { points: [anchor], cursor: null, mode, kind: this.marqueeKind, anchor };
    } else {
      this.lassoDraft = { points: [point], cursor: null, mode, kind: this.lassoKind, anchor: null };
    }
  },
  /** Marquee drag, in whole pixels; `square` evens the sides, `fromCenter` grows it around the anchor. */
  dragMarquee(this: EditorSession, point: Point, square: boolean, fromCenter: boolean): void {
    const draft = this.lassoDraft;
    if (!draft || (draft.kind !== 'Rectangle' && draft.kind !== 'Ellipse') || !draft.anchor || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const r = dragBox(draft.anchor, point, square, fromCenter);
    this.lassoDraft = { ...draft, points: [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }] };
  },
  /** Adds an outline point; points closer than a quarter pixel are skipped. */
  extendLasso(this: EditorSession, point: Point): void {
    const draft = this.lassoDraft;
    if (!draft || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const last = draft.points[draft.points.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.25) return;
    this.lassoDraft = { ...draft, points: [...draft.points, point] };
  },
  moveLassoCursor(this: EditorSession, point: Point | null): void {
    if (this.lassoDraft) this.lassoDraft = { ...this.lassoDraft, cursor: point };
  },
  removeLastLassoPoint(this: EditorSession): void {
    const draft = this.lassoDraft;
    if (!draft) return;
    const points = draft.points.slice(0, -1);
    this.lassoDraft = points.length ? { ...draft, points } : null;
  },
  cancelLasso(this: EditorSession): void { this.lassoDraft = null; },
  pressMarqueeKey(this: EditorSession): void { this.selectTool('marquee'); },
  toggleMarqueeKind(this: EditorSession): void { this.cancelLasso(); this.marqueeKind = this.marqueeKind === 'Rectangle' ? 'Ellipse' : 'Rectangle'; },
  pressLassoKey(this: EditorSession): void { this.selectTool('lasso'); },
  toggleLassoKind(this: EditorSession): void { this.cancelLasso(); this.lassoKind = this.lassoKind === 'Freehand' ? 'Polygonal' : 'Freehand'; },

  /** Closes the outline and combines it with the selection. A click enclosing nothing deselects in New mode. */
  finishLasso(this: EditorSession): void {
    const draft = this.lassoDraft;
    if (!draft) return;
    this.lassoDraft = null;
    const outline = draftOutline(draft);
    const bounds = outline.bounds;
    if (!((draft.points.length >= 3 || draft.kind === 'Ellipse') && bounds && bounds.width > 0 && bounds.height > 0)) {
      if (draft.mode === 'New') this.deselect();
      return;
    }
    this.applySelection(outline, draft.mode, draft.kind === 'Freehand' ? 'Lasso' : draft.kind === 'Polygonal' ? 'Polygonal Lasso'
      : draft.kind === 'Ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
  },

  applySelection(this: EditorSession, shape: SelectionPath, mode: SelectionMode, name: string): void {
    if (!this.document || !this.canEditSelection) return;
    const clipped = pathIntersection(shape, SelectionPath.rect(canvasRect(this)));
    let result: SelectionPath;
    const current = this.selection;
    switch (mode) {
      case 'New': result = clipped; break;
      case 'Add': result = current ? pathUnion(current.path, clipped) : clipped; break;
      case 'Subtract':
        // Subtracting from no selection selects nothing new, so nothing changes.
        if (!current) return;
        result = pathSubtracting(current.path, clipped);
        break;
    }
    this.setSelection({ path: result, antialiased: this.selectionAntialiased }, name);
  },

  setSelection(this: EditorSession, value: DocumentSelection | null, name: string): void {
    if (!this.document || !this.canEditSelection) return;
    const current = this.selection;
    if (current === value || (current && value && current.antialiased === value.antialiased && current.path.equals(value.path))) return;
    this.beginEdit(name);
    this.updateDocument((d) => { d.selection = value as never; });
    this.endEdit();
  },

  /** True where dragging in New mode would move the selection outline. */
  canMoveSelection(this: EditorSession, point: Point): boolean {
    const current = this.selection;
    if (!current || current.path.isEmpty || !this.canEditSelection || this.lassoDraft) return false;
    return current.path.contains(point);
  },
  /** Moves the outline only (never pixels). The whole drag is one undo step. */
  beginSelectionMove(this: EditorSession): boolean {
    const current = this.selection;
    if (this.selectionMoveOrigin || !current || current.path.isEmpty || !this.canEditSelection) return false;
    this.beginEdit('Move Selection');
    this.selectionMoveOrigin = current;
    return true;
  },
  /** Offsets from the drag's start, in whole pixels; not re-clipped, so it can leave the canvas and come back. */
  moveSelection(this: EditorSession, offset: { width: number; height: number }): void {
    const origin = this.selectionMoveOrigin;
    if (!origin) return;
    const moved = origin.path.translated(Math.round(offset.width), Math.round(offset.height));
    this.updateDocument((d) => { d.selection = { path: moved, antialiased: origin.antialiased } as never; });
  },
  endSelectionMove(this: EditorSession): void {
    if (!this.selectionMoveOrigin) return;
    this.selectionMoveOrigin = null;
    this.endEdit();
  },
  /** Arrow-key nudge: 1 px, or 10 px with Shift; each press one undo step. */
  nudgeSelection(this: EditorSession, dx: number, dy: number): void {
    if (!this.beginSelectionMove()) return;
    this.moveSelection({ width: dx, height: dy });
    this.endSelectionMove();
  },

  get canModifySelection(): boolean {
    const s = this as unknown as EditorSession;
    return s.selection?.path.isEmpty === false && s.canEditSelection && !s.lassoDraft;
  },
  expandSelection(this: EditorSession, amount: number): void { this.resizeSelection(amount, 'Expand Selection'); },
  contractSelection(this: EditorSession, amount: number): void { this.resizeSelection(-amount, 'Contract Selection'); },
  resizeSelection(this: EditorSession, delta: number, name: string): void {
    const current = this.selection;
    if (!this.document || !current || !this.canModifySelection || delta === 0 || Math.abs(delta) > 500) return;
    const offset = pathOffset(current.path, delta);
    const result = delta > 0 ? pathIntersection(offset, SelectionPath.rect(canvasRect(this))) : offset;
    this.setSelection({ path: result, antialiased: current.antialiased }, name);
  },
  selectAll(this: EditorSession): void {
    if (!this.document) return;
    this.setSelection({ path: SelectionPath.rect(canvasRect(this)), antialiased: true }, 'Select All');
  },
  deselect(this: EditorSession): void {
    if (!this.selection) return;
    this.setSelection(null, 'Deselect');
  },
  invertSelection(this: EditorSession): void {
    const current = this.selection;
    if (!this.document || !current) return;
    this.setSelection({ path: pathSubtracting(SelectionPath.rect(canvasRect(this)), current.path), antialiased: current.antialiased }, 'Inverse');
  },

  // MARK: Magic Wand

  /** Selects pixels like the one at `point`, from the active layer or every visible layer. */
  async magicWand(this: EditorSession, point: Point, mode: SelectionMode): Promise<void> {
    const document = this.document;
    if (!this.canEditSelection || this.isProjectBusy || this.selectionMoveOrigin || !document || !this.gpu || !this.workers
        || !(point.x >= 0 && point.y >= 0 && point.x < document.width && point.y < document.height)) return;
    const sample = this.wandSample();
    if (!sample) return;
    const settings = this.wandSettings;
    let loops: Float64Array[] | null;
    try {
      loops = await this.whileBusy(() => this.workers!.run('wand', { data: sample, width: document.width, height: document.height,
        x: Math.floor(point.x), y: Math.floor(point.y), radius: settings.sampleSize, tolerance: Math.min(255, Math.max(0, settings.tolerance)),
        contiguous: settings.contiguous }, [sample.buffer]));
    } catch (error) {
      this.brushError = (error as Error).message;
      return;
    }
    if (this.document?.id !== document.id) return;
    if (!loops || !loops.length) {
      // Nothing matched: New clears the selection, as a lasso click enclosing nothing does.
      if (mode === 'New') this.deselect();
      return;
    }
    const path = new SelectionPath(loops);
    // A traced outline already lies on the canvas, so a new selection skips the clip.
    if (mode === 'New') this.setSelection({ path, antialiased: this.selectionAntialiased }, 'Magic Wand');
    else this.applySelection(path, mode, 'Magic Wand');
  },

  /** What the wand reads, at document size: every visible layer, or the active layer's own pixels. */
  wandSample(this: EditorSession): Uint8Array | null {
    const document = this.document;
    if (!document || !this.gpu) return null;
    const rect = canvasRect(this);
    if (this.wandSettings.sampleAllLayers) return this.gpu.renderRegion(liveScene(this, document), rect);
    const layer = this.activeLayer;
    if (!layer || layer.isGroup || !layer.asset) return new Uint8Array(document.width * document.height * 4);
    return this.gpu.renderRegion(singleLayerScene(document.width, document.height, imageOn(layer.asset.image, this.displayedTransform(layer))), rect);
  },

  // MARK: Filling, clearing, inverting

  get canEditPixels(): boolean { return (this as unknown as EditorSession).canPaint; },

  /** Fills the selection (or the whole layer) with the foreground or background colour, as one undo step. On a
   *  mask the palette is black and white, so this hides or reveals. */
  async fillSelection(this: EditorSession, source: 'foreground' | 'background'): Promise<void> {
    const layer = this.activeLayer;
    if (!this.canEditPixels || !layer) return;
    const value = this.paletteColor(source === 'background');
    const color = this.isMaskSelected ? [value.red] : [value.red, value.green, value.blue];
    await this.applyPixelEdit(layer, this.isMaskSelected ? 'Fill Mask' : 'Fill', (edit) => edit.fill(color));
  },

  /** Delete with a selection: image pixels become transparent; on a mask the selection takes the background colour. */
  async clearSelectedPixels(this: EditorSession): Promise<void> {
    const layer = this.activeLayer;
    if (!this.selection || !this.canEditPixels || !layer) return;
    if (this.isMaskSelected) { await this.fillSelection('background'); return; }
    if (!layer.asset) return;
    await this.applyPixelEdit(layer, 'Clear', (edit) => edit.clearPixels());
  },

  /** Delete: clears the selection when there is one; otherwise deletes the targeted mask, or the layer. */
  deleteKeyPressed(this: EditorSession): void {
    if (this.selection) void this.clearSelectedPixels();
    else this.deleteLayerOrMask();
  },
  deleteLayerOrMask(this: EditorSession): void {
    if (this.isMaskSelected && this.activeLayer?.mask && this.selectedLayerIDs.size <= 1) this.deleteLayerMask();
    else this.deleteSelectedLayers();
  },

  async applyPixelEdit(this: EditorSession, layer: Layer, name: string, paint: (edit: import('../raster/brush').BrushStroke) => void): Promise<void> {
    this.finishOpacityEdit();
    try {
      const edit = this.makeRasterEdit(layer);
      paint(edit);
      if (!edit.hasEdits) return;
      await this.commitRasterEdit(edit, name);
    } catch (error) { this.brushError = (error as Error).message; }
  },

  /** Ctrl+I works in every tool: a pending gradient or transform is applied first. */
  get canInvert(): boolean {
    const s = this as unknown as EditorSession;
    const layer = s.activeLayer;
    if (!s.document || !layer || s.isProjectBusy || s.isImporting || s.brushStroke || s.pixelMove || s.renamingLayerID != null
        || s.showsNewDocument || s.showsImporter || s.selectedLayerIDs.size !== 1 || (layer.isGroup && !s.isMaskSelected)
        || !effectiveVisibleIDs(s.document).has(layer.id) || s.selection?.path.isEmpty === true) return false;
    return s.isMaskSelected ? layer.mask?.isEnabled === true : !!layer.asset;
  },

  /** Inverts the layer's colours (transparency kept) or its mask, inside the selection or everywhere. */
  async invertPixels(this: EditorSession): Promise<void> {
    if (!this.canInvert) return;
    this.commitTransform();
    if (this.gradientEdit) await this.commitGradient();
    const document = this.document, layer = this.activeLayer;
    if (!this.canInvert || !document || !layer || !this.workers) return;
    const mask = this.isMaskSelected;
    let image = mask ? layer.mask?.asset.image : layer.asset?.image;
    if (!image) return;
    this.finishOpacityEdit();
    try {
      await this.whileBusy(async () => {
        const clip = document.selection ? selectionClip(document.selection, document.width, document.height) : null;
        // A uniform 1 × 1 mask can't hold a partial selection; give it the layer's grid first.
        if (mask && clip && image!.width === 1 && image!.height === 1) {
          const width = layer.asset?.image.width ?? Math.round(layer.transform.size.width);
          const height = layer.asset?.image.height ?? Math.round(layer.transform.size.height);
          if (!(width * height <= 100_000_000)) throw new Error('This layer is too large.');
          image = Raster.fromData(width, height, 1, new Uint8Array(width * height).fill(image!.pixel(0, 0)[0]));
        }
        const source = image!;
        const original = source.toData();
        let inverted = await this.workers!.run('invert', { data: original.slice(), channels: source.channels });
        if (clip) {
          const toDocument = pixelToDocument(mask ? (layer.mask!.placement ?? layer.transform) : layer.transform, source.width, source.height);
          const coverage = clipCoverageInGrid(clip, toDocument, invert(toDocument), 0, 0, source.width, source.height);
          inverted = await this.workers!.run('blend', { adjusted: inverted, original, coverage, channels: source.channels });
        }
        const result = Raster.fromData(source.width, source.height, source.channels, inverted);
        const index = this.layerIndex(layer.id);
        const current = index >= 0 ? this.document!.layers[index] : null;
        // Only write over the layer the invert was computed from.
        if (!current || current.asset?.image !== layer.asset?.image || current.mask?.asset.image !== layer.mask?.asset.image) return;
        this.beginEdit(mask ? 'Invert Mask' : 'Invert');
        this.updateDocument((d) => {
          const target = d.layers[index];
          if (mask) target.mask = (target.mask ? { ...target.mask, asset: asset(result, 'Layer Mask') } : { asset: asset(result, 'Layer Mask'), isEnabled: true, placement: null, isLinked: true }) as never;
          else { target.asset = asset(result, target.name) as never; target.shape = null; }
        });
        this.endEdit();
        this.brushRevision += 1;
      });
    } catch (error) { this.brushError = (error as Error).message; }
  },

  // MARK: Moving selected pixels (Ctrl-drag / Ctrl-arrow)

  beginPixelMove(this: EditorSession, duplicate = false): boolean {
    const current = this.selection, layer = this.activeLayer;
    if (this.pixelMove || !current || current.path.isEmpty || !this.canPaint || this.isMaskSelected || !layer?.asset) return false;
    try {
      const raster = this.makeRasterEdit(layer);
      if (!raster.liftSelection()) return false;
      this.finishOpacityEdit();
      this.pixelMove = { raster, origin: current, duplicate, offset: { width: 0, height: 0 } };
      return true;
    } catch (error) { this.brushError = (error as Error).message; return false; }
  },
  movePixels(this: EditorSession, offset: { width: number; height: number }): void {
    const move = this.pixelMove;
    if (!move) return;
    const rounded = { width: Math.round(offset.width), height: Math.round(offset.height) };
    try { move.raster.moveLifted(rounded, move.duplicate); }
    catch (error) { this.cancelPixelMove(); this.brushError = (error as Error).message; return; }
    this.pixelMove = { ...move, offset: rounded };
    this.brushRevision += 1;
  },
  /** The outline to draw: during a pixel move the original shifted by the drag; while transforming selected pixels
   *  it follows the handles. */
  get displayedSelection(): DocumentSelection | null {
    const s = this as unknown as EditorSession;
    const move = s.pixelMove;
    if (move) return { path: move.origin.path.translated(move.offset.width, move.offset.height), antialiased: move.origin.antialiased };
    const edit = s.transformEdit, current = s.selection;
    if (edit?.floating && current) {
      const moved = s.floatingSelectionPath(edit, current.path);
      if (moved) return { path: moved, antialiased: current.antialiased };
    }
    return current;
  },
  async finishPixelMove(this: EditorSession): Promise<void> {
    const move = this.pixelMove;
    if (!move || this.isProjectBusy) return;
    if (move.offset.width || move.offset.height) {
      const moved = { path: move.origin.path.translated(move.offset.width, move.offset.height), antialiased: move.origin.antialiased };
      try {
        await this.commitRasterEdit(move.raster, move.duplicate ? 'Duplicate Pixels' : 'Move Pixels', () => {
          this.updateDocument((d) => { d.selection = moved as never; });
        });
      } catch (error) { this.brushError = (error as Error).message; }
    }
    this.gpu?.releaseStroke(move.raster);
    this.pixelMove = null;
    this.brushRevision += 1;
  },
  cancelPixelMove(this: EditorSession): void {
    if (!this.pixelMove) return;
    this.gpu?.releaseStroke(this.pixelMove.raster);
    this.pixelMove = null;
    this.brushRevision += 1;
  },
  async nudgePixels(this: EditorSession, dx: number, dy: number): Promise<void> {
    if (!this.beginPixelMove()) return;
    this.movePixels({ width: dx, height: dy });
    await this.finishPixelMove();
  },

  // MARK: Copy and paste

  /** Whole-pixel bounds of what Copy takes: the selection, or the whole canvas without one. */
  selectionCopyRegion(this: EditorSession): Rect | null {
    const document = this.document;
    if (!document) return null;
    const canvas = canvasRect(this);
    const bounds = this.selection?.path.bounds ?? canvas;
    const t = 0.001;
    const x0 = Math.max(0, Math.floor(bounds.x + t)), y0 = Math.max(0, Math.floor(bounds.y + t));
    const x1 = Math.min(canvas.width, Math.ceil(bounds.x + bounds.width - t)), y1 = Math.min(canvas.height, Math.ceil(bounds.y + bounds.height - t));
    return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
  },

  get canCopyPixels(): boolean {
    const s = this as unknown as EditorSession;
    const layer = s.activeLayer;
    if (!s.canEditLayers || !layer || (layer.isGroup && !s.isMaskSelected) || s.selection?.path.isEmpty === true) return false;
    return s.isMaskSelected ? !!layer.mask : !!layer.asset;
  },

  /** The selection's coverage over `region` (all selected without a selection); null for an empty selection. */
  selectionCoverage(this: EditorSession, region: Rect): Uint8Array | null {
    const current = this.selection;
    if (!current) return new Uint8Array(region.width * region.height).fill(255);
    if (current.path.isEmpty) return null;
    return rasterizeSelection(current, null, region.x, region.y, region.width, region.height);
  },

  /** The active layer's pixels (or its mask as opaque gray) as they sit on the canvas, clipped to the selection
   *  (soft edges kept), or the whole canvas without one. */
  renderSelectedPixels(this: EditorSession, layer: Layer, mask: boolean): { image: Raster; region: Rect } | null {
    const document = this.document, gpu = this.gpu;
    if (!document || !gpu) return null;
    const region = this.selectionCopyRegion();
    const coverage = region ? this.selectionCoverage(region) : null;
    if (!region || !coverage) return null;
    const transform = this.displayedTransform(layer);
    let pixels: Uint8Array;
    if (mask && layer.mask) {
      const placement = this.displayedMaskPlacement(layer);
      const scene = layerMaskScene({ ...layer.mask, isEnabled: true }, transform, placement)!;
      // Beyond a mask covering its layer there is nothing; a placed mask shows its edge tone.
      const gray = gpu.renderMask(scene.outside === 'clamp' ? { ...scene, outside: 0 } : scene, region.width, region.height,
        { a: 1, b: 0, c: 0, d: 1, tx: -region.x, ty: -region.y });
      pixels = new Uint8Array(region.width * region.height * 4);
      for (let i = 0; i < gray.length; i++) { pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = gray[i]; pixels[i * 4 + 3] = 255; }
    } else if (!mask && layer.asset) {
      pixels = gpu.renderRegion(singleLayerScene(document.width, document.height, imageOn(layer.asset.image, transform)), region);
    } else return null;
    for (let i = 0; i < coverage.length; i++) {
      const c = coverage[i];
      if (c === 255) continue;
      for (let k = 0; k < 4; k++) pixels[i * 4 + k] = Math.round(pixels[i * 4 + k] * c / 255);
    }
    return { image: Raster.fromData(region.width, region.height, 4, pixels), region };
  },

  get canCopyMerged(): boolean {
    const s = this as unknown as EditorSession;
    return s.canEditLayers && s.selection?.path.isEmpty !== true && !!s.document && renderLayers(s.document).some((l) => !!l.asset);
  },

  /** Every visible layer composited as the canvas shows it, through the selection (Copy Merged). */
  renderMergedPixels(this: EditorSession): { image: Raster; region: Rect } | null {
    const document = this.document, gpu = this.gpu;
    if (!document || !gpu) return null;
    const region = this.selectionCopyRegion();
    const coverage = region ? this.selectionCoverage(region) : null;
    if (!region || !coverage) return null;
    const pixels = gpu.renderRegion(liveScene(this, document), region);
    for (let i = 0; i < coverage.length; i++) {
      const c = coverage[i];
      if (c === 255) continue;
      for (let k = 0; k < 4; k++) pixels[i * 4 + k] = Math.round(pixels[i * 4 + k] * c / 255);
    }
    return { image: Raster.fromData(region.width, region.height, 4, pixels), region };
  },

  copyMergedSelection(this: EditorSession): void {
    if (!this.canCopyMerged) return;
    try {
      const copied = this.renderMergedPixels();
      if (copied) void this.storeCopy(copied);
    } catch (error) { this.brushError = (error as Error).message; }
  },

  /** Ctrl+C: the selected pixels (or the whole layer), for Paste and as PNG for other apps. */
  copySelection(this: EditorSession): Promise<void> | void {
    const layer = this.activeLayer;
    if (!this.canCopyPixels || !layer) return;
    try {
      const copied = this.renderSelectedPixels(layer, this.isMaskSelected);
      if (copied) return this.storeCopy(copied);
    } catch (error) { this.brushError = (error as Error).message; }
  },

  async storeCopy(this: EditorSession, copied: { image: Raster; region: Rect }): Promise<void> {
    const straight = copied.image.toData();
    unpremultiply(straight);
    const png = encodePNG(straight, copied.image.width, copied.image.height, 4, this.document?.resolution ?? 72);
    this.pixelClipboard = { image: copied.image, origin: { x: copied.region.x, y: copied.region.y }, signature: hash(png) };
    try { await window.compositor?.writeClipboardImage(png); } catch { /* the in-app copy still works */ }
  },

  /** Ctrl+X: copy, then clear the selected pixels. */
  async cutSelection(this: EditorSession): Promise<void> {
    if (!this.selection || !this.canCopyPixels) return;
    await this.copySelection();
    await this.clearSelectedPixels();
  },

  get canPaste(): boolean {
    const s = this as unknown as EditorSession;
    return !!s.document && s.canEditLayers;
  },

  /** Ctrl+V: a new layer above the active one. Pixels copied here go back where they came from; images copied in
   *  other apps are centred. */
  async paste(this: EditorSession): Promise<void> {
    const document = this.document;
    if (!this.canPaste || !document) return;
    let external: Uint8Array | null = null;
    try { external = await window.compositor?.readClipboardImage() ?? null; } catch { external = null; }
    const clip = this.pixelClipboard;
    if (clip && (!external || hash(external) === clip.signature)) {
      this.addPixelLayer(clip.image, clip.origin, this.nextLayerName(), 'Paste');
      return;
    }
    if (!external) return;
    try {
      const decoded = await decodeImageBytes(external);
      premultiply(decoded.data);
      const image = Raster.fromData(decoded.width, decoded.height, 4, decoded.data);
      const origin = { x: Math.floor((document.width - image.width) / 2), y: Math.floor((document.height - image.height) / 2) };
      this.addPixelLayer(image, origin, this.nextLayerName(), 'Paste');
    } catch (error) { this.brushError = (error as Error).message; }
  },

  /** Ctrl+J: the selection's pixels become a new layer in place; with no selection the layer is duplicated. */
  layerViaCopy(this: EditorSession): void {
    const layer = this.activeLayer;
    if (!this.canEditLayers || !layer || layer.isGroup || this.selection?.path.isEmpty === true) return;
    if (!this.selection) { this.duplicateActiveLayer(); return; }
    try {
      const copied = this.renderSelectedPixels(layer, this.isMaskSelected);
      if (copied) this.addPixelLayer(copied.image, copied.region, this.nextLayerName(), 'Layer via Copy');
    } catch (error) { this.brushError = (error as Error).message; }
  },

  duplicateActiveLayer(this: EditorSession): void {
    const layer = this.activeLayer;
    const index = this.layerIndex(layer?.id);
    if (!this.canEditLayers || !layer || layer.isGroup || index < 0) return;
    const copy: Layer = { ...layer, id: crypto.randomUUID().toUpperCase(), name: `${layer.name} copy` };
    this.beginEdit('Duplicate Layer');
    this.updateDocument((d) => { d.layers.splice(index + 1, 0, copy as never); });
    this.activeLayerID = copy.id;
    this.endEdit();
  },

  /** Alt-drag in the Layers panel: a copy placed where it was dropped, as one undo step. */
  duplicateLayer(this: EditorSession, id: string, parent: string | null, above: string | null = null, atBottom = false): boolean {
    const layer = this.layer(id);
    if (!this.canEditLayers || !layer || layer.isGroup || !this.canPlaceLayer(id, parent)) return false;
    this.beginEdit('Duplicate Layer');
    try {
      this.selectLayer(id);
      this.duplicateActiveLayer();
      const copy = this.activeLayerID;
      if (!copy || copy === id) return false;
      return this.placeLayer(copy, parent, above, atBottom);
    } finally { this.endEdit(); }
  },

  /** Pixels as a new layer above the active one (inside its folder), in one undo step. Pasting drops the
   *  selection, as in Photoshop; a drawn shape keeps it. */
  addPixelLayer(this: EditorSession, image: Raster, origin: Point, name: string, editName: string, dropsSelection = true,
                shape: Layer['shape'] = null): void {
    const document = this.document;
    if (!document) return;
    const active = this.activeLayer;
    const layer: Layer = { ...imageLayer(asset(image, name), { x: origin.x, y: origin.y }), name, shape,
      parentID: active?.isGroup ? active.id : active?.parentID ?? null };
    const index = active ? this.layerIndex(active.id) + 1 : document.layers.length;
    this.finishOpacityEdit();
    this.beginEdit(editName);
    this.updateDocument((d) => {
      d.layers.splice(index, 0, layer as never);
      if (dropsSelection) d.selection = null;
    });
    this.activeLayerID = layer.id;
    this.endEdit();
  },

  // MARK: Transforming selected pixels (Ctrl+T with a selection)

  get canTransformSelection(): boolean {
    const s = this as unknown as EditorSession;
    const current = s.selection;
    return !s.transformEdit && s.canEditPixels && !s.isMaskSelected && !!current && !current.path.isEmpty && !!s.activeLayer?.asset;
  },

  /** Ctrl+T: transforms the selected pixels when there is a selection, else the layer. */
  transformCommand(this: EditorSession): void {
    if (this.canTransformSelection) void this.beginSelectionTransform();
    else this.beginTransform();
  },

  /** The selected pixels float on a temporary layer, edited with the normal transform handles, then merge back.
   *  The whole thing is one "Transform Selection" undo step; Escape restores the document exactly. */
  async beginSelectionTransform(this: EditorSession): Promise<void> {
    const document = this.document, source = this.activeLayer;
    if (!this.canTransformSelection || !document || !source) return;
    let lifted: { image: Raster; region: Rect } | null;
    try { lifted = this.renderSelectedPixels(source, false); }
    catch (error) { this.brushError = (error as Error).message; return; }
    if (!lifted) return;
    const before = document, beforeActive = this.activeLayerID;
    // Closed by commitTransform (merge) or cancelTransform (restore).
    this.beginEdit('Transform Selection');
    await this.clearSelectedPixels();
    const index = this.layerIndex(source.id);
    if (index < 0) { this.document = before; this.endEdit(); return; }
    const floating: Layer = { ...imageLayer(asset(lifted.image, 'Floating Selection'), { x: lifted.region.x, y: lifted.region.y }),
      name: 'Floating Selection', parentID: source.parentID, opacity: source.opacity, blendMode: source.blendMode };
    this.updateDocument((d) => { d.layers.splice(index + 1, 0, floating as never); });
    this.activeLayerID = floating.id;
    this.tool = 'move';
    this.transformEdit = { layerID: floating.id, draft: floating.transform, persistent: true, corners: null, mask: false, group: null,
      floating: { sourceID: source.id, before, beforeActive, original: floating.transform, pixelSize: { width: lifted.region.width, height: lifted.region.height } } };
  },

  /** The original selection outline carried to where the floating pixels are now. */
  floatingSelectionPath(this: EditorSession, edit: TransformEdit, path: SelectionPath): SelectionPath | null {
    const floating = edit.floating;
    if (!floating) return null;
    const w = floating.pixelSize.width, h = floating.pixelSize.height;
    const placement = pixelToDocument(floating.original, w, h);
    if (edit.corners) return distortPath(path, placement, floating.pixelSize, edit.draft, edit.corners);
    const matrix = pixelToDocument(edit.draft, w, h);
    const toPixels = invert(placement);
    return path.mapped((p) => applyPoint(matrix, applyPoint(toPixels, p)));
  },

  /** Composites the transformed pixels back into their layer (growing it where they reach past it), moves the
   *  selection with them, and closes the undo step. */
  mergeFloatingTransform(this: EditorSession, edit: TransformEdit, floating: NonNullable<TransformEdit['floating']>): void {
    try {
      const layers = this.document?.layers ?? [];
      const floatingLayer = layers.find((l) => l.id === edit.layerID);
      const source = layers.find((l) => l.id === floating.sourceID);
      if (!isValidTransform(edit.draft) || !floatingLayer?.asset || !source?.asset || !this.gpu) throw new Error('The selection could not be merged.');
      const pixels = floatingLayer.asset.image;
      const placed = edit.corners ? distortedImage(pixels, edit.draft, edit.corners) : imageOn(pixels, edit.draft);
      if (!placed) throw new Error('That shape can’t be made.');
      const merged = mergeIntoLayer(this, placed, source);
      const current = this.selection;
      const moved = current ? this.floatingSelectionPath(edit, current.path) : null;
      this.updateDocument((d) => {
        d.layers = d.layers.filter((l) => l.id !== edit.layerID);
        const target = d.layers.find((l) => l.id === source.id)!;
        target.asset = asset(merged.image, source.name) as never;
        target.transform = merged.transform as never;
        target.mask = merged.mask as never;
        target.shape = null;
        d.selection = (moved && current ? { path: moved, antialiased: current.antialiased } : null) as never;
      });
      this.activeLayerID = source.id;
    } catch (error) {
      this.document = floating.before as never;
      this.activeLayerID = floating.beforeActive;
      this.brushError = (error as Error).message;
    } finally {
      this.endEdit();
    }
  },

  cancelFloatingTransform(this: EditorSession, floating: NonNullable<TransformEdit['floating']>): void {
    this.document = floating.before as never;
    this.activeLayerID = floating.beforeActive;
    this.endEdit();
  },
};

/** Draws `placed` onto `source`'s own pixel grid, growing the grid where it now extends past it; a mask covering the
 *  grid grows with it, revealing the new area (FloatingMerge.merge). */
function mergeIntoLayer(session: EditorSession, placed: import('../gl/compositor').SceneImage, source: Layer) {
  const image = source.asset!.image;
  const width = image.width, height = image.height;
  const toDocument = pixelToDocument(source.transform, width, height);
  const toPixels = invert(toDocument);
  // The floating pixels' bounds in the source grid.
  const corners = [[0, 0], [placed.width, 0], [placed.width, placed.height], [0, placed.height]].map(([x, y]) => {
    const doc = placed.projective ? project(placed.projective, { x, y }) : applyPoint(placed.gridToDocument, { x, y });
    return applyPoint(toPixels, doc);
  });
  const x0 = Math.min(0, Math.floor(Math.min(...corners.map((p) => p.x)))), y0 = Math.min(0, Math.floor(Math.min(...corners.map((p) => p.y))));
  const x1 = Math.max(width, Math.ceil(Math.max(...corners.map((p) => p.x)))), y1 = Math.max(height, Math.ceil(Math.max(...corners.map((p) => p.y))));
  const extent = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (extent.width > 30_000 || extent.height > 30_000 || extent.width * extent.height > 100_000_000) throw new Error('The result would be too large.');
  const scene: Scene = { width: session.document!.width, height: session.document!.height,
    layers: [sceneLayer('source', imageOn(image, source.transform)), sceneLayer('floating', placed)] };
  const docToGrid = { ...toPixels, tx: toPixels.tx - extent.x, ty: toPixels.ty - extent.y };
  const pixels = session.gpu!.renderMapped(scene, extent.width, extent.height, docToGrid);
  const raster = Raster.fromData(extent.width, extent.height, 4, pixels);
  const transform: LayerTransform = {
    ...source.transform,
    size: { width: extent.width * source.transform.size.width / width, height: extent.height * source.transform.size.height / height },
  };
  const middle = applyPoint(toDocument, { x: extent.x + extent.width / 2, y: extent.y + extent.height / 2 });
  transform.origin = { x: middle.x - transform.size.width / 2, y: middle.y - transform.size.height / 2 };
  let mask = source.mask;
  if (mask && !mask.placement && (extent.x !== 0 || extent.y !== 0 || extent.width !== width || extent.height !== height)) {
    mask = { ...mask, asset: asset(expandMask(mask.asset.image, { x: -extent.x, y: -extent.y, width, height },
      { x: 0, y: 0, width: extent.width, height: extent.height }), mask.asset.name) };
  }
  return { image: raster, transform, mask };
}

/** Carries an outline drawn over pixels placed by `placement` into a distorted shape (DistortWarp.mapPath). */
export function distortPath(path: SelectionPath, placement: import('../model/geometry').Affine, pixelSize: { width: number; height: number },
                            transform: LayerTransform, corners: Point[]): SelectionPath | null {
  if (!isUsableQuad(corners) || !(pixelSize.width > 0 && pixelSize.height > 0)) return null;
  const toPixels = invert(placement);
  const map: Matrix3 = unitSquareTo(corners);
  return path.mapped((point) => {
    const pixel = applyPoint(toPixels, point);
    let u = pixel.x / pixelSize.width, v = pixel.y / pixelSize.height;
    if (transform.flipX) u = 1 - u;
    if (transform.flipY) v = 1 - v;
    return project(map, { x: u, y: v });
  });
}

void maskBackground; void cornersOf; void makeTransform;

type Selection = typeof selection;
declare module './session' {
  interface EditorSession extends Selection {}
}
extend(EditorSession, selection);
