// The editor's state and the operations on it: one open project (a tab). A port of EditorSession.swift; the
// feature areas live in the other files of this folder, added to the class as Swift adds extensions.
import { produce, type Draft } from 'immer';
import { Observable, observeFields } from './observable';
import {
  CanvasDocument, ImageAsset, Layer, LayerBlendMode, blankLayer, effectiveVisibleIDs, imageLayer, makeDocument,
  renderLayers,
} from '../model/document';
import { DocumentHistory, HistorySnapshot } from '../model/history';
import { CanvasViewport } from '../model/viewport';
import type { Point, Rect } from '../model/geometry';
import {
  LayerTransform, TransformEdit, boundingBox, cornersOf, following, isValidTransform, makeTransform,
  transformsEqual,
} from '../model/transform';
import {
  BrushSettings, BlurToolMode, BrushToolMode, CloneSettings, FilterSettings, GradientSettings, NavigationTool,
  SpotHealingMode, WandSettings, defaultBrushSettings, defaultFilterSettings, defaultGradientSettings,
  defaultWandSettings, isBrushTool,
} from '../model/settings';
import type { DocumentSelection, LassoDraft, LassoKind, SelectionMode } from '../model/selection';
import type { PaletteColor } from '../model/color';
import { WHITE } from '../model/color';
import type { ShapeKind } from '../model/document';
import type { LayerAdjustment } from '../model/adjustments';
import type { BrushStroke } from '../raster/brush';
import type { Raster } from '../raster/raster';
import type { GPU } from '../gpu/service';
import type { Workers } from '../workers/pool';

/** A modal question for the person: the UI shows it and resolves with the index of the button chosen. */
export interface AlertRequest {
  title: string;
  message: string;
  buttons: string[];
  /** Index of the button Escape chooses. */
  cancel?: number;
  resolve: (choice: number) => void;
}

/** Selected pixels being dragged (SelectionEdits.swift). */
export interface PixelMove {
  raster: BrushStroke;
  origin: DocumentSelection;
  duplicate: boolean;
  offset: { width: number; height: number };
}

/** An uncommitted gradient on one layer or mask (Gradient.swift). */
export interface GradientEdit {
  raster: BrushStroke;
  start: Point;
  end: Point;
}

/** Pixels copied here, with where they came from so Paste puts them back in place. */
export interface PixelClipboard {
  image: Raster;
  origin: Point;
  /** The system clipboard's image when this was copied, to tell whether another app has copied since. */
  signature: string;
}

export interface ShapeDraft { kind: ShapeKind; anchor: Point; rect: Rect; cornerRadius: number }

export interface ColorPickerState {
  target: { kind: 'palette'; background: boolean } | { kind: 'gradientMap'; highlights: boolean };
  original: PaletteColor;
  hue: number;
  saturation: number;
  brightness: number;
}

let sessionCounter = 0;

export class EditorSession extends Observable {
  readonly key = ++sessionCounter;
  /** The tab's name before the project is saved. */
  defaultName = 'Untitled';
  gpu: GPU | null = null;
  workers: Workers | null = null;

  document: CanvasDocument | null = null;
  canvasFocusRequest = 0;
  showsSampleRing = true;
  adjustmentOriginal: LayerAdjustment | null = null;
  adjustmentEditingID: string | null = null;
  /** Where the project was last opened from or saved to (a .comp file or a Mac project folder). */
  projectPath: string | null = null;
  /** Whether projectPath is a Mac-style folder package rather than a single file. */
  projectIsFolder = false;
  private busy = false;
  /** True once a busy operation has lasted long enough to show. */
  showsBusy = false;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private busyWaiters: (() => void)[] = [];
  viewport = new CanvasViewport();
  tool: NavigationTool = 'move';
  collapsedGroupIDs: ReadonlySet<string> = new Set();
  cropRect: Rect | null = null;
  cropRatioChoice = 'Free';
  cropError: string | null = null;
  transformEdit: TransformEdit | null = null;
  /** Document positions a move has just snapped to, drawn as guides while it lasts. */
  snapGuides: { xs: number[]; ys: number[] } = { xs: [], ys: [] };
  /** Where the last brush stroke ended, so a Shift-click paints a straight line on from it. */
  lastBrushPoint: { point: Point; layerID: string; mask: boolean } | null = null;
  locksTransformRatio = true;
  transformAutoSelect = false;
  showsTransformControls = true;
  transformDuplicate: { copy: string; source: string } | null = null;
  private brushSettingsValue: BrushSettings = defaultBrushSettings();
  spotHealingMode: SpotHealingMode = 'Content-Aware';
  blurMode: BlurToolMode = 'Liquify';
  brushMode: BrushToolMode = 'Paint';
  cloneSource: Point | null = null;
  cloneSettings: CloneSettings = { aligned: true, sampleAllLayers: false };
  /** The tips of the brush families not in use: Clone Stamp and Smear keep their own (both soft to start). */
  parkedBrushTips: Record<number, { diameter: number; hardness: number; opacity: number }> = {
    1: { diameter: 40, hardness: 0, opacity: 1 }, 2: { diameter: 40, hardness: 0, opacity: 1 },
  };
  cloneOffset: { width: number; height: number } | null = null;
  private maskPaintWhiteValue = false;
  private backgroundColorValue: PaletteColor = WHITE;
  private gradientSettingsValue: GradientSettings = defaultGradientSettings();
  gradientEdit: GradientEdit | null = null;
  lassoDraft: LassoDraft | null = null;
  lassoKind: LassoKind = 'Freehand';
  marqueeKind: LassoKind = 'Rectangle';
  shapeKind: ShapeKind = 'Rectangle';
  shapeCornerRadius = 0;
  shapeDraft: ShapeDraft | null = null;
  selectionModeChoice: SelectionMode = 'New';
  heldSelectionMode: SelectionMode | null = null;
  selectionMoveOrigin: DocumentSelection | null = null;
  pixelMove: PixelMove | null = null;
  pixelClipboard: PixelClipboard | null = null;
  // Edits in dialogs (typed in their own files).
  levels: import('./adjustmentEdits').LevelsEdit | null = null;
  hueSaturation: import('./adjustmentEdits').HueSaturationEdit | null = null;
  filterEdit: import('./adjustmentEdits').FilterEdit | null = null;
  filterSettings: FilterSettings = defaultFilterSettings();
  /** The Hue/Saturation panel's armed eyedropper: re-centre, widen or narrow the selected range. */
  hueSampleMode: 'replace' | 'add' | 'remove' | null = null;
  hueTargeting = false;
  hueTargetDrag: { range: import('../model/adjustments').ColorRange; hue: number; saturation: number } | null = null;
  selectionAntialiased = true;
  wandSettings: WandSettings = defaultWandSettings();
  showsPixelGrid = true;
  selectionExpandAmount = 1;
  selectionContractAmount = 1;
  pendingOpacityDigit: { digit: number; time: number } | null = null;
  colorPicker: ColorPickerState | null = null;
  brushError: string | null = null;
  /** Bumped whenever a raster edit in progress changes, so the canvas redraws. */
  brushRevision = 0;
  brushStroke: BrushStroke | null = null;
  warpStroke: import('./warp').WarpStroke | null = null;
  showsNewDocument = false;
  showsImporter = false;
  isImporting = false;
  importError: string | null = null;
  opacityEditLayerID: string | null = null;
  blendPreview: { layerID: string; mode: LayerBlendMode } | null = null;
  isMaskSelected = false;
  selectedLayerIDs: ReadonlySet<string> = new Set();
  private activeLayerIDValue: string | null = null;
  renamingLayerID: string | null = null;
  /** Questions waiting for the person (NSAlert on the Mac). */
  alert: AlertRequest | null = null;
  /** Sheets and panels the UI shows. */
  sheet: 'canvasSize' | 'imageSize' | 'jpegExport' | null = null;
  readonly history = new DocumentHistory();

  constructor(gpu: GPU | null = null, workers: Workers | null = null) {
    super();
    this.gpu = gpu;
    this.workers = workers;
    observeFields(this, new Set(['gpu', 'workers', 'history', 'key', 'busyTimer', 'busyWaiters']));
    this.history.onChange = () => this.changed();
  }

  // MARK: Observed with side effects (Swift didSet)

  get activeLayerID(): string | null { return this.activeLayerIDValue; }
  set activeLayerID(value: string | null) {
    if (value !== this.activeLayerIDValue) this.isMaskSelected = false;
    this.activeLayerIDValue = value;
    this.selectedLayerIDs = value ? new Set([value]) : new Set();
    this.changed();
  }

  get brushSettings(): BrushSettings { return this.brushSettingsValue; }
  set brushSettings(value: BrushSettings) { this.brushSettingsValue = value; this.changed(); this.refreshGradient(); }

  get maskPaintWhite(): boolean { return this.maskPaintWhiteValue; }
  set maskPaintWhite(value: boolean) { this.maskPaintWhiteValue = value; this.changed(); this.refreshGradient(); }

  get backgroundColor(): PaletteColor { return this.backgroundColorValue; }
  set backgroundColor(value: PaletteColor) { this.backgroundColorValue = value; this.changed(); this.refreshGradient(); }

  get gradientSettings(): GradientSettings { return this.gradientSettingsValue; }
  set gradientSettings(value: GradientSettings) { this.gradientSettingsValue = value; this.changed(); this.refreshGradient(); }

  /** Blocks overlapping edits at once; the UI dims only once an operation has run long enough to notice. */
  get isProjectBusy(): boolean { return this.busy; }
  set isProjectBusy(value: boolean) {
    if (this.busy === value) return;
    this.busy = value;
    if (value) {
      this.busyTimer ??= setTimeout(() => { this.busyTimer = null; if (this.busy) this.showsBusy = true; }, 250);
    } else {
      if (this.busyTimer) clearTimeout(this.busyTimer);
      this.busyTimer = null;
      this.showsBusy = false;
      const waiters = this.busyWaiters;
      this.busyWaiters = [];
      for (const waiter of waiters) waiter();
    }
    this.changed();
  }

  waitForProjectAccess(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise<void>((resolve) => { this.busyWaiters.push(resolve); }).then(() => this.waitForProjectAccess());
  }

  /** Runs `body` with the project marked busy. */
  async whileBusy<T>(body: () => Promise<T>): Promise<T> {
    this.isProjectBusy = true;
    try { return await body(); } finally { this.isProjectBusy = false; }
  }

  // MARK: Document edits

  /** Changes the document through an Immer draft (Swift's in-place struct mutation). */
  updateDocument(recipe: (draft: Draft<CanvasDocument>) => void): void {
    if (!this.document) return;
    this.document = produce(this.document, recipe);
  }

  layerIndex(id: string | null | undefined): number {
    if (!id || !this.document) return -1;
    return this.document.layers.findIndex((layer) => layer.id === id);
  }

  layer(id: string | null | undefined): Layer | null {
    const index = this.layerIndex(id);
    return index >= 0 ? this.document!.layers[index] : null;
  }

  /** Nestable transaction boundary; one undo step per outermost pair. */
  beginEdit(name: string): void { this.history.begin(name, this.document, this.activeLayerID); }
  endEdit(): void { this.history.end(this.document, this.activeLayerID); }

  get isModified(): boolean { return this.history.isModified; }

  // MARK: Availability

  get canStartProjectOperation(): boolean {
    return !this.isProjectBusy && !this.isImporting && !this.brushStroke && !this.warpStroke && !this.levels
      && !this.showsNewDocument && !this.showsImporter && this.renamingLayerID == null && this.importError == null
      && this.adjustmentEditingID == null;
  }

  get canUseHistory(): boolean {
    return !this.isProjectBusy && !this.isImporting && !this.brushStroke && !this.warpStroke && !this.levels
      && !this.showsNewDocument && !this.showsImporter && this.renamingLayerID == null && this.importError == null
      && !this.transformEdit;
  }
  get canUndo(): boolean { return this.canUseHistory && (this.history.canUndo || !!this.gradientEdit); }
  get canRedo(): boolean { return this.canUseHistory && this.history.canRedo; }

  get activeLayer(): Layer | null { return this.layer(this.activeLayerID); }

  get canEditLayers(): boolean {
    return !!this.document && !this.brushStroke && !this.warpStroke && !this.isProjectBusy && !this.isImporting
      && !this.showsNewDocument && !this.showsImporter && this.renamingLayerID == null && !this.transformEdit
      && !this.cropRect && !this.gradientEdit && !this.pixelMove && !this.hueSaturation && !this.levels && !this.filterEdit
      && this.adjustmentEditingID == null;
  }

  get selection(): DocumentSelection | null { return this.document?.selection ?? null; }

  // MARK: Undo

  undo(): void {
    // Like Photoshop, the first Undo discards a pending gradient.
    if (this.gradientEdit) { this.cancelGradient(); return; }
    if (!this.canUndo) return;
    const snapshot = this.history.undo();
    if (snapshot) this.restore(snapshot);
  }

  redo(): void {
    if (!this.canRedo) return;
    const snapshot = this.history.redo();
    if (snapshot) this.restore(snapshot);
  }

  private restore(snapshot: HistorySnapshot): void {
    this.cancelCrop();
    this.cancelGradient();
    const changedCanvas = this.document?.id !== snapshot.document?.id;
    const keepMaskTarget = this.isMaskSelected && this.activeLayerID === snapshot.activeLayerID;
    this.document = snapshot.document;
    this.activeLayerID = snapshot.activeLayerID;
    this.isMaskSelected = keepMaskTarget && !!this.activeLayer?.mask;
    if (changedCanvas && this.document) this.viewport.fit({ width: this.document.width, height: this.document.height });
    this.brushRevision += 1;
  }

  // MARK: Transforms

  /** Several layers selected, or a folder: they transform together in one box. */
  get transformsAsGroup(): boolean {
    return this.selectedLayerIDs.size > 1 || (this.selectedLayerIDs.size === 1 && !!this.activeLayer?.isGroup);
  }

  /** What a group transform moves: the visible pixel layers selected, and those inside selected folders. */
  get groupTransformMembers(): Layer[] {
    const document = this.document;
    if (!this.transformsAsGroup || !document) return [];
    const parents = new Map(document.layers.map((layer) => [layer.id, layer.parentID]));
    const visible = effectiveVisibleIDs(document);
    return document.layers.filter((layer) => {
      if (!layer.asset || layer.isGroup || !visible.has(layer.id)) return false;
      let current: string | null = layer.id;
      for (let i = 0; i < 64 && current; i++) {
        if (this.selectedLayerIDs.has(current)) return true;
        current = parents.get(current) ?? null;
      }
      return false;
    });
  }

  /** The upright box around `groupTransformMembers`. */
  get groupTransformBox(): LayerTransform | null {
    const points = this.groupTransformMembers.flatMap((layer) => cornersOf(layer.transform));
    if (!points.length) return null;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return makeTransform({ x: x0, y: y0 }, { width: Math.max(1, Math.max(...xs) - x0), height: Math.max(1, Math.max(...ys) - y0) });
  }

  get canTransform(): boolean {
    if (!this.canEditLayers) return false;
    if (this.transformsAsGroup) return this.groupTransformMembers.length > 0;
    const layer = this.activeLayer;
    return !!layer?.asset && !layer.isGroup && !!this.document && effectiveVisibleIDs(this.document).has(layer.id);
  }

  selectLayer(id: string | null): void {
    if (this.brushStroke || this.warpStroke || this.levels) return;
    if (id !== this.activeLayerID) { this.commitTransform(); this.resolveGradient(); }
    this.activeLayerID = id;
  }

  private static tipFamily(tool: NavigationTool): number { return tool === 'cloneStamp' ? 1 : tool === 'blur' ? 2 : 0; }

  selectTool(value: NavigationTool): void {
    if (this.isProjectBusy || this.brushStroke || this.warpStroke || this.levels) return;
    if (this.tool !== value) { this.commitTransform(); this.cancelCrop(); this.resolveGradient(); this.cancelLasso(); this.cancelShape(); }
    const from = EditorSession.tipFamily(this.tool), to = EditorSession.tipFamily(value);
    const parked = this.parkedBrushTips[to];
    if (from !== to && parked) {
      this.parkedBrushTips = { ...this.parkedBrushTips, [from]: { diameter: this.brushSettings.diameter, hardness: this.brushSettings.hardness, opacity: this.brushSettings.opacity } };
      this.brushSettings = { ...this.brushSettings, diameter: parked.diameter, hardness: parked.hardness, opacity: parked.opacity };
    }
    this.tool = value;
    if (value === 'crop' && !this.cropRect && this.document) {
      this.cropRatioChoice = 'Free';
      this.cropRect = { x: 0, y: 0, width: this.document.width, height: this.document.height };
    }
  }

  beginTransform(persistent = true): void {
    this.cancelCrop();
    const layer = this.activeLayer;
    if (this.transformEdit || !this.canTransform || !layer) return;
    this.tool = 'move';
    if (this.transformsAsGroup) {
      const members = this.groupTransformMembers;
      const box = this.groupTransformBox;
      if (!box) return;
      this.transformEdit = {
        layerID: layer.id, draft: box, persistent, floating: null, corners: null, mask: false,
        group: { box, originals: new Map(members.map((m) => [m.id, m.transform])) },
      };
      return;
    }
    // An unlinked mask, when selected, transforms on its own; linked, layer and mask move together.
    const maskAlone = this.isMaskSelected && layer.mask?.isLinked === false;
    this.transformEdit = {
      layerID: layer.id, draft: maskAlone ? (layer.mask!.placement ?? layer.transform) : layer.transform, persistent,
      floating: null, corners: null, mask: maskAlone, group: null,
    };
  }

  previewTransform(value: LayerTransform): void {
    if (!isValidTransform(value) || !this.transformEdit) return;
    this.transformEdit = { ...this.transformEdit, draft: value };
  }

  beginDuplicateTransform(): void {
    const source = this.activeLayerID;
    // Alt-drag duplicates a single layer; several selected, or a folder, just move.
    if (this.transformDuplicate || this.transformsAsGroup || !source) return;
    this.commitTransform();
    if (!this.canTransform) return;
    this.beginEdit('Duplicate Layer');
    this.duplicateActiveLayer();
    const copy = this.activeLayerID;
    if (!copy || copy === source) { this.endEdit(); return; }
    this.transformDuplicate = { copy, source };
    this.beginTransform(false);
  }

  commitTransform(): void {
    this.snapGuides = { xs: [], ys: [] };
    this.blendPreview = null;
    this.finishOpacityEdit();
    const edit = this.transformEdit;
    if (!edit) return;
    try {
      this.transformEdit = null;
      if (edit.floating) {
        // Unchanged: restore exactly, so soft selection edges never pick up a seam.
        if (transformsEqual(edit.draft, edit.floating.original) && !edit.corners) this.cancelFloatingTransform(edit.floating);
        else this.mergeFloatingTransform(edit, edit.floating);
        return;
      }
      if (edit.mask) { this.commitMaskTransform(edit); return; }
      if (edit.corners) { this.commitDistort(edit, edit.corners); return; }
      if (edit.group) {
        if (!isValidTransform(edit.draft)) return;
        this.beginEdit('Transform Layers');
        for (const [id, original] of edit.group.originals) {
          const index = this.layerIndex(id);
          if (index < 0) continue;
          const moved = following(original, edit.group.box, edit.draft);
          if (!isValidTransform(moved)) continue;
          this.updateDocument((d) => {
            const layer = d.layers[index];
            if (layer.mask) layer.mask.placement = maskPlacementMoving(layer.mask as never, original, moved) as never;
            layer.transform = moved as never;
          });
          this.redrawShape(index);
        }
        this.endEdit();
        return;
      }
      const index = this.layerIndex(edit.layerID);
      if (!isValidTransform(edit.draft) || index < 0) return;
      this.beginEdit('Transform Layer');
      this.updateDocument((d) => {
        const layer = d.layers[index];
        if (layer.mask) layer.mask.placement = maskPlacementMoving(layer.mask as never, layer.transform as LayerTransform, edit.draft) as never;
        layer.transform = edit.draft as never;
      });
      this.redrawShape(index);
      this.endEdit();
    } finally {
      if (this.transformDuplicate) { this.transformDuplicate = null; this.endEdit(); }
    }
  }

  cancelTransform(): void {
    this.snapGuides = { xs: [], ys: [] };
    const edit = this.transformEdit;
    if (!edit) return;
    this.transformEdit = null;
    const duplicate = this.transformDuplicate;
    if (duplicate) {
      this.updateDocument((d) => { d.layers = d.layers.filter((layer) => layer.id !== duplicate.copy); });
      this.activeLayerID = duplicate.source;
      this.transformDuplicate = null;
      this.endEdit();
    }
    if (edit.floating) this.cancelFloatingTransform(edit.floating);
  }

  /** Pixels the transform places — what 100% scale draws 1:1. Null for a layer without pixels. */
  get transformPixelSize(): { width: number; height: number } | null {
    if (this.transformEdit?.group) return this.transformEdit.group.box.size;
    if (!this.transformEdit && this.transformsAsGroup) return this.groupTransformBox?.size ?? null;
    if (this.transformTargetsMask) return null;
    if (this.transformEdit?.floating) return this.transformEdit.floating.pixelSize;
    const image = this.activeLayer?.asset?.image;
    return image ? { width: image.width, height: image.height } : null;
  }

  displayedTransform(layer: Layer): LayerTransform {
    const pending = this.pendingTransform(layer);
    if (pending) return pending;
    // Content-Aware Fill past the layer's edge previews on the grown layer.
    const edit = this.filterEdit;
    if (edit && edit.grownTransform && edit.previewImageFor(layer.id)) return edit.grownTransform;
    return layer.transform;
  }

  /** Whether transforming places only the active layer's mask (an unlinked mask selected in the Layers panel). */
  get transformTargetsMask(): boolean {
    return this.transformEdit ? this.transformEdit.mask : this.isMaskSelected && this.activeLayer?.mask?.isLinked === false;
  }

  /** Where `layer`'s transform handles sit. */
  editedTransform(layer: Layer): LayerTransform {
    if (this.transformEdit?.layerID === layer.id) return this.transformEdit.draft;
    if (!this.transformEdit && layer.id === this.activeLayerID && this.transformsAsGroup) {
      const box = this.groupTransformBox;
      if (box) return box;
    }
    return layer.id === this.activeLayerID && this.transformTargetsMask ? (layer.mask?.placement ?? layer.transform) : layer.transform;
  }

  /** A layer's transform under the pending edit; null when the edit doesn't move it. */
  pendingTransform(layer: Layer): LayerTransform | null {
    const edit = this.transformEdit;
    if (!edit || edit.mask) return null;
    if (edit.group) {
      const original = edit.group.originals.get(layer.id);
      return original ? following(original, edit.group.box, edit.draft) : null;
    }
    return edit.layerID === layer.id ? edit.draft : null;
  }

  nudgeLayer(dx: number, dy: number): void {
    const alreadyEditing = !!this.transformEdit;
    if (!alreadyEditing) this.beginTransform(false);
    const draft = this.transformEdit?.draft;
    if (!draft) return;
    this.previewTransform({ ...draft, origin: { x: draft.origin.x + dx, y: draft.origin.y + dy } });
    const corners = this.transformEdit?.corners;
    if (corners) this.previewCorners(corners.map((c) => ({ x: c.x + dx, y: c.y + dy })));
    if (!alreadyEditing) this.commitTransform();
  }

  // MARK: Layers

  nextLayerName(prefix = 'Layer'): string {
    const names = new Set(this.document?.layers.map((layer) => layer.name) ?? []);
    let number = 1;
    while (names.has(`${prefix} ${number}`)) number++;
    return `${prefix} ${number}`;
  }

  addBlankLayer(): void {
    const document = this.document;
    if (!this.canEditLayers || !document) return;
    const active = this.activeLayer;
    const layer = { ...blankLayer(this.nextLayerName(), document.width, document.height),
      parentID: active?.isGroup ? active.id : active?.parentID ?? null };
    if (layer.parentID) this.expandGroup(layer.parentID);
    let insertion = active ? document.layers.findIndex((l) => l.id === active.id) + 1 : document.layers.length;
    // With a folder selected the layer goes to the top of the folder, just above its topmost contents.
    if (active?.isGroup) {
      const inside = this.descendantIDs(active.id);
      let topmost = -1;
      document.layers.forEach((l, i) => { if (inside.has(l.id)) topmost = i; });
      if (topmost >= 0) insertion = Math.max(insertion, topmost + 1);
    }
    this.beginEdit('New Blank Layer');
    this.updateDocument((d) => { d.layers.splice(insertion, 0, layer as never); });
    this.activeLayerID = layer.id;
    this.endEdit();
  }

  deleteLayer(id: string): void {
    if (!this.canEditLayers || this.layerIndex(id) < 0) return;
    void this.deleteWithLiveMaskChoice([id]).then((handled) => { if (!handled) this.finishDeletingLayer(id, new Map()); });
  }

  deleteActiveLayer(): void { if (this.activeLayerID) this.deleteLayer(this.activeLayerID); }

  /** Deletes every selected layer as one undo step (a selected folder takes its contents). */
  deleteSelectedLayers(): void {
    const document = this.document;
    if (!this.canEditLayers || !document) return;
    const ids = document.layers.map((l) => l.id).filter((id) => this.selectedLayerIDs.has(id));
    if (ids.length <= 1) { this.deleteActiveLayer(); return; }
    void this.deleteWithLiveMaskChoice(ids).then((handled) => { if (!handled) this.finishDeletingLayers(ids, new Map()); });
  }

  finishDeletingLayer(id: string, baked: Map<string, ImageAsset>): void {
    const index = this.layerIndex(id);
    if (index < 0) return;
    const removed = new Set([...this.descendantIDs(id), id]);
    this.beginEdit('Delete Layer');
    this.updateDocument((d) => {
      d.layers = d.layers.filter((layer) => !removed.has(layer.id));
      for (const layer of d.layers) {
        if (layer.maskSourceID && removed.has(layer.maskSourceID)) {
          layer.maskSourceID = null;
          const asset = baked.get(layer.id);
          if (asset) layer.asset = asset as never;
        }
      }
    });
    if (this.activeLayerID && removed.has(this.activeLayerID)) {
      const layers = this.document?.layers ?? [];
      this.activeLayerID = layers.length ? layers[Math.min(index, layers.length - 1)].id : null;
    }
    this.endEdit();
  }

  finishDeletingLayers(ids: string[], baked: Map<string, ImageAsset>): void {
    if (ids.length <= 1) { if (ids[0]) this.finishDeletingLayer(ids[0], baked); return; }
    this.beginEdit('Delete Layers');
    for (const id of ids) this.finishDeletingLayer(id, baked);
    this.endEdit();
  }

  renameLayer(id: string, name: string): void {
    const trimmed = name.trim();
    const index = this.layerIndex(id);
    if (this.isProjectBusy || this.isImporting || !trimmed || index < 0) return;
    this.beginEdit('Rename Layer');
    this.updateDocument((d) => { d.layers[index].name = trimmed; });
    this.endEdit();
  }

  toggleLayerVisibility(id: string): void {
    const index = this.layerIndex(id);
    if (!this.canEditLayers || index < 0) return;
    this.beginEdit(this.document!.layers[index].isVisible ? 'Hide Layer' : 'Show Layer');
    this.updateDocument((d) => { d.layers[index].isVisible = !d.layers[index].isVisible; });
    this.endEdit();
  }

  /** Photoshop's eye swipe: the press shows or hides a layer; dragging over other eyes gives them the same state;
   *  all one undo step. Returns the state set, or null when nothing can change. */
  beginVisibilitySwipe(id: string): boolean | null {
    const layer = this.layer(id);
    if (!this.canEditLayers || !layer) return null;
    const visible = !layer.isVisible;
    this.beginEdit(visible ? 'Show Layer' : 'Hide Layer');
    this.setVisibilityInSwipe(id, visible);
    return visible;
  }
  setVisibilityInSwipe(id: string, visible: boolean): void {
    const index = this.layerIndex(id);
    if (index < 0 || this.document!.layers[index].isVisible === visible) return;
    this.updateDocument((d) => { d.layers[index].isVisible = visible; });
  }
  endVisibilitySwipe(): void { this.endEdit(); }

  canMoveActiveLayer(offset: number): boolean {
    const active = this.activeLayer;
    if (!this.canEditLayers || !active) return false;
    const siblings = this.document!.layers.filter((l) => l.parentID === active.parentID);
    const index = siblings.findIndex((l) => l.id === active.id);
    return index + offset >= 0 && index + offset < siblings.length;
  }

  moveActiveLayer(offset: number): void {
    const active = this.activeLayer;
    if (!this.canMoveActiveLayer(offset) || !active) return;
    const layers = this.document!.layers;
    const siblings = layers.filter((l) => l.parentID === active.parentID);
    const index = siblings.findIndex((l) => l.id === active.id);
    const a = layers.findIndex((l) => l.id === active.id), b = layers.findIndex((l) => l.id === siblings[index + offset].id);
    this.beginEdit('Reorder Layers');
    this.updateDocument((d) => { const t = d.layers[a]; d.layers[a] = d.layers[b]; d.layers[b] = t; });
    this.endEdit();
  }

  /** Adds `asset` as a new layer centred on `point` (the canvas centre by default); the first image makes the
   *  canvas its size. */
  insert(asset: ImageAsset, point: Point | null = null): void {
    this.beginEdit('Import Image');
    if (!this.document) {
      this.document = makeDocument(asset.image.width, asset.image.height);
      this.viewport.fit({ width: asset.image.width, height: asset.image.height });
    }
    const document = this.document!;
    const center = point ?? { x: document.width / 2, y: document.height / 2 };
    const active = this.activeLayer;
    const layer = { ...imageLayer(asset, { x: Math.floor(center.x - asset.image.width / 2), y: Math.floor(center.y - asset.image.height / 2) }),
      parentID: active?.isGroup ? active.id : active?.parentID ?? null };
    if (layer.parentID) this.expandGroup(layer.parentID);
    this.updateDocument((d) => { d.layers.push(layer as never); });
    this.activeLayerID = layer.id;
    this.endEdit();
  }

  /** `emptyLayer` starts the canvas with a selected blank "Layer 1", as File > New does. */
  createDocument(width: number, height: number, emptyLayer = false): void {
    if (this.isProjectBusy || this.isImporting || !(width >= 1 && width <= 30000 && height >= 1 && height <= 30000)) return;
    this.commitTransform();
    this.beginEdit('New Canvas');
    const layer = emptyLayer ? blankLayer('Layer 1', width, height) : null;
    this.document = makeDocument(width, height, layer ? [layer] : []);
    this.activeLayerID = layer?.id ?? null;
    this.renamingLayerID = null;
    this.viewport.fit({ width, height });
    this.showsNewDocument = false;
    this.endEdit();
  }

  fit(): void {
    if (this.document) { this.viewport.fit({ width: this.document.width, height: this.document.height }); this.viewportChanged(); }
  }

  zoom(value: number, anchor: Point | null = null): void {
    if (!this.document) return;
    this.viewport.setZoom(value, anchor ?? this.viewport.center, { width: this.document.width, height: this.document.height });
    this.viewportChanged();
  }

  /** The viewport is mutable in place; tell listeners after changing it. */
  viewportChanged(): void {
    this.viewport = this.viewport.copy();
  }

  expandGroup(id: string): void {
    if (!this.collapsedGroupIDs.has(id)) return;
    const next = new Set(this.collapsedGroupIDs);
    next.delete(id);
    this.collapsedGroupIDs = next;
  }

  get renderLayers(): Layer[] { return this.document ? renderLayers(this.document) : []; }

  /** The canvas box around every pixel layer's corners (for fitting a group). */
  layerBounds(layer: Layer): Rect { return boundingBox(this.displayedTransform(layer)); }

  isBrushToolActive(): boolean { return isBrushTool(this.tool); }

  // Declared here, defined in the feature files (see index.ts).
  declare refreshGradient: () => void;
  declare cancelGradient: () => void;
  declare resolveGradient: () => void;
  declare cancelCrop: () => void;
  declare cancelLasso: () => void;
  declare cancelShape: () => void;
  declare finishOpacityEdit: () => void;
  declare cancelFloatingTransform: (floating: NonNullable<TransformEdit['floating']>) => void;
  declare mergeFloatingTransform: (edit: TransformEdit, floating: NonNullable<TransformEdit['floating']>) => void;
  declare commitMaskTransform: (edit: TransformEdit) => void;
  declare commitDistort: (edit: TransformEdit, corners: Point[]) => void;
  declare previewCorners: (corners: Point[]) => void;
  declare redrawShape: (index: number) => void;
  declare duplicateActiveLayer: () => void;
  declare descendantIDs: (id: string) => Set<string>;
  declare deleteWithLiveMaskChoice: (ids: string[]) => Promise<boolean>;
}

/** Where a mask sits once its layer moves from `old` to `next` (LayerMask.placement(movingLayer:to:)). */
export function maskPlacementMoving(mask: { asset: ImageAsset; placement: LayerTransform | null; isLinked: boolean },
                                    old: LayerTransform, next: LayerTransform): LayerTransform | null {
  // A uniform mask looks the same wherever it sits.
  if (mask.asset.image.width <= 1 && mask.asset.image.height <= 1) return null;
  const moved = mask.isLinked ? (mask.placement ? following(mask.placement, old, next) : null) : (mask.placement ?? old);
  if (!moved) return null;
  return samePlacementAs(moved, next) ? null : moved;
}

function samePlacementAs(a: LayerTransform, b: LayerTransform): boolean {
  return transformsEqual({ ...a, sampling: b.sampling }, b);
}
