// Layer structure and appearance: folders, masks (adding, enabling, linking, copying, placing, loading as a
// selection), clipping masks, merging, flipping, opacity and blend modes, adjustment layers. Ports LayerGroups.swift,
// LayerMask.swift, LiveLayerMask.swift, MaskTracing.swift, LayerMerge.swift, LayerFlip.swift, LayerAppearance.swift
// and LayerAdjustment.swift.
import { EditorSession, maskPlacementMoving } from './session';
import { extend } from './observable';
import {
  BLEND_MODES, HierarchyEntry, Layer, LayerBlendMode, LayerMask, asset, hierarchyEntries, hierarchyRecord, isValidHierarchy,
  makeLayer, validateLiveMasks, blankLayer,
} from '../model/document';
import { AdjustmentKind, LayerAdjustment, makeAdjustment, adjustmentIsValid, randomSeed } from '../model/adjustments';
import { LayerTransform, makeTransform, mirrored, pixelToDocument, samePlacement, isValidTransform } from '../model/transform';
import { applyPoint, invert } from '../model/geometry';
import { Raster, alphaBounds } from '../raster/raster';
import { rasterizePolygons } from '../raster/rasterize';
import { SelectionMode, SelectionPath } from '../model/selection';
import { wandTrace } from '../raster/kernels/wand';
import { traceDarkPixels, traceOpaquePixels } from '../raster/kernels/maskTrace';
import { imageOn, liveScene, plainScene, distortedImage, maskBackground } from './scene';
import type { Point } from '../model/geometry';
import { isUsableQuad } from '../model/projective';

const layers = {
  // MARK: Selection of layers

  selectLayers(this: EditorSession, ids: Set<string>, primary: string | null): void {
    if (this.brushStroke) return;
    const all = new Set(this.document?.layers.map((l) => l.id) ?? []);
    const valid = new Set([...ids].filter((id) => all.has(id)));
    const same = valid.size === this.selectedLayerIDs.size && [...valid].every((id) => this.selectedLayerIDs.has(id));
    if (!same) { this.commitTransform(); this.resolveGradient(); }
    this.activeLayerID = primary && valid.has(primary) ? primary : ([...valid][0] ?? null);
    this.selectedLayerIDs = valid;
  },

  // MARK: Folders

  get layerRows(): HierarchyEntry[] {
    const s = this as unknown as EditorSession;
    return hierarchyEntries(s.document?.layers ?? [], true, s.collapsedGroupIDs);
  },

  descendantIDs(this: EditorSession, id: string): Set<string> {
    const children = new Map<string | null, Layer[]>();
    for (const layer of this.document?.layers ?? []) {
      const list = children.get(layer.parentID);
      if (list) list.push(layer); else children.set(layer.parentID, [layer]);
    }
    const result = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const parent = pending.pop()!;
      for (const child of children.get(parent) ?? []) if (!result.has(child.id)) { result.add(child.id); pending.push(child.id); }
    }
    return result;
  },

  nextFolderName(this: EditorSession): string {
    const names = new Set(this.document?.layers.map((l) => l.name) ?? []);
    let number = 1;
    while (names.has(`Folder ${number}`)) number++;
    return `Folder ${number}`;
  },

  groupSelectedLayers(this: EditorSession): void {
    const document = this.document;
    if (!this.canEditLayers || !document || document.layers.length >= 10_000) return;
    const byID = new Map(document.layers.map((l) => [l.id, l]));
    const selected = new Set([...this.selectedLayerIDs].filter((id) => byID.has(id)));
    const ancestors = (id: string): (string | null)[] => {
      const result: (string | null)[] = [];
      let parent = byID.get(id)?.parentID ?? null;
      while (parent) { result.push(parent); parent = byID.get(parent)?.parentID ?? null; }
      result.push(null);
      return result;
    };
    // A selected folder carries its subtree; selected descendants must not be pulled out of it.
    const roots = new Set([...selected].filter((id) => !ancestors(id).some((a) => a !== null && selected.has(a))));
    const ordered = hierarchyEntries(document.layers).map((e) => e.layer.id).filter((id) => roots.has(id));
    if (!ordered.length) return;
    const parent = ancestors(ordered[0]).find((candidate) => ordered.every((id) => ancestors(id).includes(candidate))) ?? null;
    const group: Layer = { ...blankLayer(this.nextFolderName(), document.width, document.height), isGroup: true, parentID: parent };
    // The folder goes where the topmost selected branch was, in the common parent.
    const branches = ordered.map((id) => {
      let branch = id;
      for (;;) {
        const next = byID.get(branch)?.parentID ?? null;
        if (next === parent || next === null) break;
        branch = next;
      }
      return branch;
    });
    let highest = -1;
    document.layers.forEach((l, i) => { if (branches.includes(l.id)) highest = i; });
    const insertion = highest >= 0 ? document.layers.slice(0, highest + 1).filter((l) => !roots.has(l.id)).length : document.layers.length;
    const next = document.layers.filter((l) => !roots.has(l.id));
    next.splice(Math.min(insertion, next.length), 0, group);
    for (const id of ordered) next.push({ ...byID.get(id)!, parentID: group.id });
    if (!isValidHierarchy(next)) return;
    this.beginEdit('Group Layers');
    this.updateDocument((d) => { d.layers = next as never; });
    this.activeLayerID = group.id;
    if (parent) this.expandGroup(parent);
    this.endEdit();
  },

  addGroup(this: EditorSession): void {
    const document = this.document;
    if (!this.canEditLayers || !document || document.layers.length >= 10_000) return;
    const active = this.activeLayer;
    const group: Layer = { ...blankLayer(this.nextFolderName(), document.width, document.height), isGroup: true,
      parentID: active?.isGroup ? active.id : active?.parentID ?? null };
    const next = document.layers.slice();
    const insertion = active ? this.layerIndex(active.id) + 1 : next.length;
    next.splice(insertion, 0, group);
    if (!isValidHierarchy(next)) return;
    this.beginEdit('New Folder');
    this.updateDocument((d) => { d.layers = next as never; });
    this.activeLayerID = group.id;
    if (group.parentID) this.expandGroup(group.parentID);
    this.endEdit();
  },

  toggleGroupExpansion(this: EditorSession, id: string): void {
    if (this.isProjectBusy || !this.layer(id)?.isGroup) return;
    if (this.collapsedGroupIDs.has(id)) { this.expandGroup(id); return; }
    if (this.activeLayerID && this.descendantIDs(id).has(this.activeLayerID)) this.selectLayer(id);
    this.collapsedGroupIDs = new Set([...this.collapsedGroupIDs, id]);
  },

  canPlaceLayer(this: EditorSession, id: string, parent: string | null): boolean {
    if (!this.canEditLayers || !this.layer(id)) return false;
    if (!parent) return true;
    return parent !== id && !this.descendantIDs(id).has(parent) && !!this.layer(parent)?.isGroup;
  },

  /** Moves a layer (with its contents) into `parent`, just above `above`, or to the very bottom. */
  placeLayer(this: EditorSession, id: string, parent: string | null, above: string | null = null, atBottom = false): boolean {
    if (!this.canPlaceLayer(id, parent) || above === id) return false;
    const next = this.document!.layers.slice();
    const index = next.findIndex((l) => l.id === id);
    if (index < 0) return false;
    const [moving] = next.splice(index, 1);
    let insertion = atBottom ? 0 : next.length;
    if (above) {
      const target = next.findIndex((l) => l.id === above && l.parentID === parent);
      if (target < 0) return false;
      insertion = target + 1;
    }
    next.splice(insertion, 0, { ...moving, parentID: parent });
    adoptClipping(id, next);
    releaseDetachedClipping(next);
    if (!isValidHierarchy(next)) return false;
    this.beginEdit('Move Layer');
    this.updateDocument((d) => { d.layers = next as never; });
    this.activeLayerID = id;
    if (parent) this.expandGroup(parent);
    this.endEdit();
    return true;
  },

  /** Reorders by the Layers panel's list (top first): `from` rows moved before row `to`. */
  reorderLayers(this: EditorSession, from: number[], to: number): void {
    const document = this.document;
    if (!this.canEditLayers || !document) return;
    const list = document.layers.slice().reverse();
    if (!from.every((i) => i >= 0 && i < list.length) || !(to >= 0 && to <= list.length)) return;
    const moving = from.map((i) => list[i]);
    const kept = list.filter((_, i) => !from.includes(i));
    const before = from.filter((i) => i < to).length;
    kept.splice(to - before, 0, ...moving);
    this.beginEdit('Reorder Layers');
    this.updateDocument((d) => { d.layers = kept.reverse() as never; });
    this.endEdit();
  },

  moveActiveLayerOutOfGroup(this: EditorSession): void {
    const layer = this.activeLayer;
    const group = layer?.parentID ? this.layer(layer.parentID) : null;
    if (!layer || !group) return;
    this.placeLayer(layer.id, group.parentID, group.id);
  },

  // MARK: Appearance

  displayedBlendMode(this: EditorSession, layer: Layer): LayerBlendMode {
    const preview = this.blendPreview;
    if (preview && preview.layerID === layer.id && this.activeLayerID === layer.id) return preview.mode;
    return layer.blendMode;
  },
  previewBlendMode(this: EditorSession, mode: LayerBlendMode | null, id: string | null): void {
    this.blendPreview = mode && id && id === this.activeLayerID && this.canEditAppearance ? { layerID: id, mode } : null;
  },
  get canEditAppearance(): boolean {
    const s = this as unknown as EditorSession;
    return s.canEditLayers && s.selectedLayerIDs.size === 1 && s.activeLayer?.isGroup === false;
  },
  beginOpacityEdit(this: EditorSession): void {
    if (!this.canEditAppearance || this.opacityEditLayerID || !this.activeLayerID) return;
    this.beginEdit('Layer Opacity');
    this.opacityEditLayerID = this.activeLayerID;
  },
  finishOpacityEdit(this: EditorSession): void {
    if (!this.opacityEditLayerID) return;
    this.opacityEditLayerID = null;
    this.endEdit();
  },
  setLayerOpacity(this: EditorSession, opacity: number): void {
    const id = this.opacityEditLayerID ?? this.activeLayerID;
    const index = this.layerIndex(id);
    if (!Number.isFinite(opacity) || !this.canEditAppearance || index < 0) return;
    const standalone = !this.opacityEditLayerID;
    if (standalone) this.beginEdit('Layer Opacity');
    this.updateDocument((d) => { d.layers[index].opacity = Math.min(1, Math.max(0, opacity)); });
    if (standalone) this.endEdit();
  },
  /** Every selected pixel layer's opacity as one undo step (folders have no opacity of their own). */
  setSelectedLayersOpacity(this: EditorSession, opacity: number): void {
    const document = this.document;
    if (!Number.isFinite(opacity) || !this.canEditLayers || !document) return;
    const value = Math.min(1, Math.max(0, opacity));
    const indices = document.layers.map((l, i) => (this.selectedLayerIDs.has(l.id) && !l.isGroup && l.opacity !== value ? i : -1)).filter((i) => i >= 0);
    if (!indices.length) return;
    this.finishOpacityEdit();
    this.beginEdit('Layer Opacity');
    this.updateDocument((d) => { for (const i of indices) d.layers[i].opacity = value; });
    this.endEdit();
  },
  /** Shift+ + / Shift+ −: the blend mode steps through the menu's order, wrapping around. */
  cycleBlendMode(this: EditorSession, forward: boolean): void {
    const layer = this.activeLayer;
    if (!this.canEditAppearance || !layer) return;
    const index = Math.max(0, BLEND_MODES.indexOf(layer.blendMode));
    this.setLayerBlendMode(BLEND_MODES[(index + (forward ? 1 : BLEND_MODES.length - 1)) % BLEND_MODES.length]);
  },
  setLayerBlendMode(this: EditorSession, mode: LayerBlendMode): void {
    this.blendPreview = null;
    const index = this.layerIndex(this.activeLayerID);
    if (!this.canEditAppearance || index < 0) return;
    this.finishOpacityEdit();
    this.beginEdit('Layer Blend Mode');
    this.updateDocument((d) => { d.layers[index].blendMode = mode; });
    this.endEdit();
  },

  // MARK: Masks

  /** Layers and folders alike take a mask. */
  get canEditMask(): boolean {
    const s = this as unknown as EditorSession;
    return s.canEditLayers && s.selectedLayerIDs.size === 1 && !!s.activeLayer;
  },

  selectLayerTarget(this: EditorSession, id: string, mask: boolean): void {
    if (this.isProjectBusy || this.isImporting || this.brushStroke) return;
    this.resolveGradient();
    this.selectLayer(id);
    this.isMaskSelected = mask && !!this.activeLayer?.mask;
  },

  /** With no selection, a mask all white (reveal) or black (hide); with one, that colour with the selected area
   *  the opposite. The selection is used up in the same undo step, as Photoshop does. */
  addMask(this: EditorSession, revealing = true): void {
    const selection = this.selection;
    if (!selection) { this.addLayerMask(revealing); return; }
    const layer = this.activeLayer;
    const index = this.layerIndex(layer?.id);
    if (!this.canEditMask || !layer || layer.mask || index < 0) return;
    const width = layer.asset?.image.width ?? Math.round(layer.transform.size.width);
    const height = layer.asset?.image.height ?? Math.round(layer.transform.size.height);
    try {
      if (!(width > 0 && height > 0 && width * height <= 100_000_000)) throw new Error('This layer is too large for a mask.');
      const toPixels = invert(pixelToDocument(layer.transform, width, height));
      const coverage = rasterizePolygons(selection.path.polygons, toPixels, 0, 0, width, height, selection.antialiased);
      const data = new Uint8Array(width * height);
      for (let i = 0; i < data.length; i++) data[i] = revealing ? 255 - coverage[i] : coverage[i];
      const mask: LayerMask = { asset: asset(Raster.fromData(width, height, 1, data), 'Layer Mask'), isEnabled: true, placement: null, isLinked: true };
      this.finishOpacityEdit();
      this.beginEdit('Add Mask from Selection');
      this.updateDocument((d) => { d.layers[index].mask = mask as never; d.selection = null; });
      this.isMaskSelected = true;
      this.endEdit();
    } catch (error) { this.brushError = (error as Error).message; }
  },

  /** A plain all-white (reveal) or all-black (hide) mask. */
  addLayerMask(this: EditorSession, revealing = true): void {
    const index = this.layerIndex(this.activeLayerID);
    if (!this.canEditMask || this.activeLayer?.mask || index < 0) return;
    const mask: LayerMask = { asset: asset(Raster.solid(1, [revealing ? 255 : 0]), 'Layer Mask'), isEnabled: true, placement: null, isLinked: true };
    this.finishOpacityEdit();
    this.beginEdit(revealing ? 'Add Reveal-All Mask' : 'Add Hide-All Mask');
    this.updateDocument((d) => { d.layers[index].mask = mask as never; });
    this.isMaskSelected = true;
    this.endEdit();
  },

  toggleLayerMask(this: EditorSession): void {
    const index = this.layerIndex(this.activeLayerID);
    if (!this.canEditMask || !this.activeLayer?.mask || index < 0) return;
    this.finishOpacityEdit();
    this.beginEdit(this.activeLayer.mask.isEnabled ? 'Disable Layer Mask' : 'Enable Layer Mask');
    this.updateDocument((d) => { d.layers[index].mask!.isEnabled = !d.layers[index].mask!.isEnabled; });
    this.endEdit();
  },

  deleteLayerMask(this: EditorSession): void {
    const index = this.layerIndex(this.activeLayerID);
    if (!this.canEditMask || !this.activeLayer?.mask || index < 0) return;
    this.finishOpacityEdit();
    this.beginEdit('Delete Layer Mask');
    this.updateDocument((d) => { d.layers[index].mask = null; });
    this.isMaskSelected = false;
    this.endEdit();
  },

  canCopyMask(this: EditorSession, source: string, target: string): boolean {
    if (!this.canEditLayers || source === target || !this.layer(source)?.mask) return false;
    const layer = this.layer(target);
    return !!layer && !layer.isGroup;
  },

  /** Alt-dragging a mask thumbnail onto another layer: a copy sitting where it sits on the document. */
  copyMask(this: EditorSession, source: string, target: string): void {
    const from = this.layer(source), index = this.layerIndex(target);
    if (!this.canCopyMask(source, target) || !from?.mask || index < 0) return;
    this.commitTransform();
    this.finishOpacityEdit();
    const mask: LayerMask = { ...from.mask, placement: from.mask.placement ?? from.transform };
    this.beginEdit(this.document!.layers[index].mask ? 'Replace Layer Mask' : 'Copy Layer Mask');
    this.updateDocument((d) => { d.layers[index].mask = mask as never; });
    this.selectLayer(target);
    this.isMaskSelected = true;
    this.endEdit();
  },

  toggleMaskLink(this: EditorSession, id: string): void {
    const index = this.layerIndex(id);
    const mask = index >= 0 ? this.document!.layers[index].mask : null;
    if (!this.canEditLayers || !mask) return;
    this.commitTransform();
    this.finishOpacityEdit();
    this.beginEdit(mask.isLinked ? 'Unlink Layer Mask' : 'Link Layer Mask');
    this.updateDocument((d) => { d.layers[index].mask!.isLinked = !mask.isLinked; });
    this.endEdit();
  },

  /** Where `layer`'s mask shows right now; null while it covers the layer's (displayed) grid. */
  displayedMaskPlacement(this: EditorSession, layer: Layer): LayerTransform | null {
    const mask = layer.mask;
    if (!mask) return null;
    const filter = this.filterEdit;
    if (filter?.grownTransform && filter.previewImageFor(layer.id)) return mask.placement ?? layer.transform;
    const edit = this.transformEdit;
    if (edit?.group) {
      const original = edit.group.originals.get(layer.id);
      if (!original) return mask.placement;
      if (edit.corners) return mask.isLinked && !mask.placement ? null : mask.placement ?? layer.transform;
      const moved = this.pendingTransform(layer)!;
      return maskPlacementMoving(mask, layer.transform, moved);
    }
    if (!edit || edit.layerID !== layer.id || edit.floating) return mask.placement;
    if (edit.mask) return samePlacement(edit.draft, layer.transform) ? null : edit.draft;
    if (edit.corners) return mask.isLinked && !mask.placement ? null : mask.placement ?? layer.transform;
    return maskPlacementMoving(mask, layer.transform, edit.draft);
  },

  /** An unlinked mask transformed on its own takes the new placement (its pixels untouched); distorted, it is
   *  resampled into the shape over the shape's bounds, its edge tone outside it. */
  commitMaskTransform(this: EditorSession, edit: import('../model/transform').TransformEdit): void {
    const index = this.layerIndex(edit.layerID);
    const layer = index >= 0 ? this.document!.layers[index] : null;
    const mask = layer?.mask;
    if (!isValidTransform(edit.draft) || !layer || !mask) return;
    if (edit.corners) {
      try {
        const moved = this.warpMask(mask, edit.draft, edit.corners);
        this.finishOpacityEdit();
        this.beginEdit('Distort Layer Mask');
        this.updateDocument((d) => {
          d.layers[index].mask = { ...mask, asset: moved.raster === mask.asset.image ? mask.asset : asset(moved.raster, mask.asset.name),
            placement: samePlacement(moved.transform, layer.transform) ? null : moved.transform } as never;
        });
        this.endEdit();
      } catch (error) { this.brushError = (error as Error).message; }
      return;
    }
    const placement = samePlacement(edit.draft, layer.transform) ? null : edit.draft;
    if (placement === mask.placement || (placement && mask.placement && samePlacement(placement, mask.placement) && placement.sampling === mask.placement.sampling)) return;
    this.finishOpacityEdit();
    this.beginEdit('Transform Layer Mask');
    this.updateDocument((d) => { d.layers[index].mask!.placement = placement as never; });
    this.endEdit();
  },

  /** A mask placed by `transform` warped so its corners land on `corners`, over the shape's whole-pixel bounds,
   *  with its edge tone outside the shape (DistortWarp.warpMask). */
  warpMask(this: EditorSession, mask: LayerMask, transform: LayerTransform, corners: Point[]): { raster: Raster; transform: LayerTransform } {
    if (!isUsableQuad(corners) || !this.gpu) throw new Error('That shape can’t be made.');
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
    const width = Math.ceil(Math.max(...xs)) - x0, height = Math.ceil(Math.max(...ys)) - y0;
    if (!(width >= 1 && height >= 1 && width <= 30_000 && height <= 30_000 && width * height <= 100_000_000)) throw new Error('The result would be too large.');
    const placed = makeTransform({ x: x0, y: y0 }, { width, height }, transform.sampling);
    const image = mask.asset.image;
    // A uniform 1 × 1 mask already covers any shape.
    if (image.width === 1 && image.height === 1) return { raster: image, transform: placed };
    const warped = distortedImage(image, transform, corners)!;
    const gray = this.gpu.renderMask({ image: warped, outside: maskBackground(image) }, width, height, { a: 1, b: 0, c: 0, d: 1, tx: -x0, ty: -y0 });
    return { raster: Raster.fromData(width, height, 1, gray), transform: placed };
  },

  /** Ctrl-click a mask thumbnail: the mask's dark (hidden) areas become the selection. */
  loadMaskSelection(this: EditorSession, layerID: string, mode: SelectionMode = 'New'): void {
    const layer = this.layer(layerID);
    const mask = layer?.mask?.asset.image;
    if (!this.canEditSelection || !layer || !mask) return;
    const loops = traceDarkPixels(mask);
    if (!loops.length) return;
    const toDocument = pixelToDocument(layer.mask!.placement ?? layer.transform, mask.width, mask.height);
    this.applySelection(new SelectionPath(loops).transformed(toDocument), mode, 'Load Mask Selection');
  },

  /** Ctrl-click a layer thumbnail: its visible (≥ 50% opaque) pixels become the selection, ignoring its mask. */
  loadLayerSelection(this: EditorSession, layerID: string, mode: SelectionMode = 'New'): void {
    const layer = this.layer(layerID);
    const image = layer?.asset?.image;
    if (!this.canEditSelection || !layer || layer.isGroup || !image) return;
    const loops = traceOpaquePixels(image);
    if (!loops.length) return;
    this.applySelection(new SelectionPath(loops).transformed(pixelToDocument(layer.transform, image.width, image.height)), mode, 'Load Layer Selection');
  },

  // MARK: Clipping masks

  canLinkMask(this: EditorSession, source: string, target: string): boolean {
    const all = this.document?.layers;
    if (!this.canEditLayers || source === target || !all) return false;
    const from = all.find((l) => l.id === source), to = all.find((l) => l.id === target);
    if (!from || from.isGroup || from.adjustment || !to || to.isGroup) return false;
    try {
      validateLiveMasks(all.map((l) => ({ ...hierarchyRecord(l), maskSourceID: l.id === target ? source : l.maskSourceID })));
      return true;
    } catch { return false; }
  },

  linkMask(this: EditorSession, source: string, target: string): boolean {
    const index = this.layerIndex(target);
    if (!this.canLinkMask(source, target) || index < 0) return false;
    if (this.document!.layers[index].maskSourceID === source) return true;
    this.beginEdit('Create Clipping Mask');
    this.updateDocument((d) => { d.layers[index].maskSourceID = source; });
    this.endEdit();
    return true;
  },

  /** Releasing a base releases the clipped layers above it that share it; releasing a child leaves lower ones. */
  removeLiveMask(this: EditorSession, target: string): void {
    const document = this.document;
    const layer = this.layer(target);
    const source = layer?.maskSourceID;
    if (!this.canEditLayers || !document || !layer || !source) return;
    const siblings = document.layers.filter((l) => l.parentID === layer.parentID);
    const start = siblings.findIndex((l) => l.id === target);
    const releases: string[] = [];
    for (const l of siblings.slice(start)) {
      if (l.id !== target && l.maskSourceID !== source) break;
      releases.push(l.id);
    }
    this.beginEdit('Release Clipping Mask');
    this.updateDocument((d) => { for (const l of d.layers) if (releases.includes(l.id)) l.maskSourceID = null; });
    this.endEdit();
  },

  canToggleClippingMask(this: EditorSession, id: string): boolean {
    const document = this.document;
    const layer = this.layer(id);
    if (!this.canEditLayers || !document || !layer || layer.isGroup) return false;
    if (layer.maskSourceID) return true;
    const siblings = document.layers.filter((l) => l.parentID === layer.parentID);
    const index = siblings.findIndex((l) => l.id === id);
    if (index <= 0 || siblings[index - 1].isGroup) return false;
    return this.canLinkMask(siblings[index - 1].maskSourceID ?? siblings[index - 1].id, id);
  },

  /** Alt-click between layers (Ctrl+Alt+G): clips to the next lower sibling, sharing its base when that is
   *  already clipped; again releases. */
  toggleClippingMask(this: EditorSession, id: string): void {
    const document = this.document;
    const layer = this.layer(id);
    if (!this.canEditLayers || !document || !layer || layer.isGroup) return;
    if (layer.maskSourceID) { this.removeLiveMask(id); return; }
    const siblings = document.layers.filter((l) => l.parentID === layer.parentID);
    const index = siblings.findIndex((l) => l.id === id);
    if (index <= 0) return;
    const below = siblings[index - 1];
    if (below.isGroup) return;
    this.linkMask(below.maskSourceID ?? below.id, id);
  },

  /** When layers being deleted supply clipping masks to layers that stay, asks whether to bake or unlink first.
   *  Returns false (having done nothing) when none do. */
  async deleteWithLiveMaskChoice(this: EditorSession, ids: string[]): Promise<boolean> {
    const document = this.document;
    if (!document) return false;
    const removed = new Set<string>();
    for (const id of ids) { removed.add(id); for (const d of this.descendantIDs(id)) removed.add(d); }
    const targets = document.layers.filter((l) => !removed.has(l.id) && l.maskSourceID && removed.has(l.maskSourceID)).map((l) => l.id);
    if (!targets.length) return false;
    const choice = await this.ask(ids.length === 1 ? 'This layer supplies a live mask' : 'These layers supply live masks',
      'Bake keeps the current masked appearance in the dependent layers’ pixels. Remove Links reveals their pixels. You can undo either choice.',
      ['Bake and Delete', 'Cancel', 'Remove Links and Delete'], 1);
    if (choice === 2) { this.finishDeletingLayers(ids, new Map()); return true; }
    if (choice !== 0) return true;
    try {
      const baked = new Map<string, import('../model/document').ImageAsset>();
      for (const target of targets) {
        const result = this.bakeLiveMask(target);
        if (result) baked.set(target, result);
      }
      this.finishDeletingLayers(ids, baked);
    } catch (error) { this.brushError = (error as Error).message; }
    return true;
  },

  /** A layer's own pixels (its grid) clipped by its clipping-mask source, the source's opacity and masks included;
   *  its own mask and appearance are kept (LiveMaskBaker). */
  bakeLiveMask(this: EditorSession, target: string): import('../model/document').ImageAsset | null {
    const document = this.document, layer = this.layer(target);
    if (!document || !layer?.asset || !this.gpu) return null;
    const scene = plainScene(document);
    for (const s of scene.layers) {
      if (s.id === target) { s.isVisible = true; s.opacity = 1; s.mask = null; s.blendMode = 'Normal'; s.parentID = null; }
      else s.isVisible = false;
    }
    const image = layer.asset.image;
    const toPixels = invert(pixelToDocument(layer.transform, image.width, image.height));
    const pixels = this.gpu.renderMapped(scene, image.width, image.height, toPixels);
    return asset(Raster.fromData(image.width, image.height, 4, pixels), layer.asset.name);
  },

  /** A question for the person; resolves with the chosen button's index. */
  ask(this: EditorSession, title: string, message: string, buttons: string[], cancel = buttons.length - 1): Promise<number> {
    return new Promise((resolve) => {
      this.alert = { title, message, buttons, cancel, resolve: (choice) => { this.alert = null; resolve(choice); } };
    });
  },

  // MARK: Merging

  /** What Ctrl+E merges: one layer with the one beneath it; several selected layers together; a folder's contents. */
  mergePlan(this: EditorSession): { ids: string[]; removed: Set<string>; name: string; parent: string | null; anchor: string; action: string } | null {
    const document = this.document, active = this.activeLayer;
    if (!this.canEditLayers || !document || !active) return null;
    const all = document.layers;
    if (this.selectedLayerIDs.size > 1) {
      const picked = new Set(this.selectedLayerIDs);
      for (const id of this.selectedLayerIDs) for (const d of this.descendantIDs(id)) picked.add(d);
      const ordered = all.filter((l) => picked.has(l.id));
      const top = [...ordered].reverse().find((l) => this.selectedLayerIDs.has(l.id));
      if (!ordered.some((l) => !l.isGroup) || !top) return null;
      return { ids: ordered.map((l) => l.id), removed: picked, name: top.name, parent: top.parentID, anchor: top.id, action: 'Merge Layers' };
    }
    if (active.isGroup) {
      const inside = this.descendantIDs(active.id);
      if (!all.some((l) => inside.has(l.id) && !l.isGroup)) return null;
      const ids = all.filter((l) => inside.has(l.id) || l.id === active.id).map((l) => l.id);
      return { ids, removed: new Set(ids), name: active.name, parent: active.parentID, anchor: active.id, action: 'Merge Group' };
    }
    const index = all.findIndex((l) => l.id === active.id);
    const below = all.slice(0, index).reverse().find((l) => l.parentID === active.parentID);
    if (!below || below.isGroup) return null;
    return { ids: [below.id, active.id], removed: new Set([below.id, active.id]), name: below.name, parent: active.parentID, anchor: active.id, action: 'Merge Down' };
  },

  get canMergeLayers(): boolean { return (this as unknown as EditorSession).mergePlan() !== null; },
  get mergeTitle(): string { return (this as unknown as EditorSession).mergePlan()?.action ?? 'Merge Down'; },

  /** The layers composited as the canvas shows them (blend modes, opacity, masks, clipping, adjustments baked in)
   *  into one pixel layer, trimmed to what is there, in their place, as one undo step. */
  mergeLayers(this: EditorSession): void {
    this.commitTransform();
    const plan = this.mergePlan(), document = this.document;
    if (!plan || !document || !this.gpu) return;
    const kept = new Set(plan.ids);
    // Only the merged layers, cut loose from anything outside the merge.
    const subset = document.layers.filter((l) => kept.has(l.id)).map((l) => ({
      ...l, parentID: l.parentID && !kept.has(l.parentID) ? null : l.parentID,
      maskSourceID: l.maskSourceID && !kept.has(l.maskSourceID) ? null : l.maskSourceID,
    }));
    const flat = { ...document, layers: subset };
    const pixels = this.gpu.renderRegion(liveScene(this, flat), { x: 0, y: 0, width: document.width, height: document.height });
    const bounds = alphaBounds(pixels, document.width, document.height) ?? { x: 0, y: 0, width: document.width, height: document.height };
    const full = Raster.fromData(document.width, document.height, 4, pixels);
    const trimmed = bounds.width === document.width && bounds.height === document.height ? full : full.crop(bounds.x, bounds.y, bounds.width, bounds.height);
    const merged: Layer = { ...makeLayer({ name: plan.name, transform: makeTransform({ x: bounds.x, y: bounds.y }, { width: bounds.width, height: bounds.height }) }),
      asset: asset(trimmed, plan.name), parentID: plan.parent };
    const next = document.layers.filter((l) => !plan.removed.has(l.id))
      .map((l) => (l.maskSourceID && plan.removed.has(l.maskSourceID) ? { ...l, maskSourceID: merged.id } : l));
    const slot = document.layers.findIndex((l) => l.id === plan.anchor);
    const insertion = slot - document.layers.slice(0, slot).filter((l) => plan.removed.has(l.id)).length;
    next.splice(Math.min(Math.max(0, insertion), next.length), 0, merged);
    if (!isValidHierarchy(next)) return;
    this.finishOpacityEdit();
    this.beginEdit(plan.action);
    this.updateDocument((d) => { d.layers = next as never; });
    this.activeLayerID = merged.id;
    this.endEdit();
  },

  // MARK: Flipping

  /** Flips the selected layer about its middle, or several layers / a folder's contents about the middle of the box
   *  around them, as one undo step. A linked mask flips with its layer; an unlinked one stays. */
  flipLayers(this: EditorSession, horizontally: boolean): void {
    this.commitTransform();
    const document = this.document;
    if (!this.canTransform || !document) return;
    let members: Layer[], axis: number;
    if (this.transformsAsGroup) {
      const box = this.groupTransformBox;
      if (!box) return;
      members = this.groupTransformMembers;
      axis = horizontally ? box.origin.x + box.size.width / 2 : box.origin.y + box.size.height / 2;
    } else {
      const layer = this.activeLayer;
      if (!layer) return;
      members = [layer];
      axis = horizontally ? layer.transform.origin.x + layer.transform.size.width / 2 : layer.transform.origin.y + layer.transform.size.height / 2;
    }
    const ids = new Set(members.map((m) => m.id));
    if (!ids.size) return;
    this.finishOpacityEdit();
    this.beginEdit(horizontally ? 'Flip Horizontal' : 'Flip Vertical');
    this.updateDocument((d) => {
      for (const layer of d.layers) {
        if (!ids.has(layer.id)) continue;
        const flipped = mirrored(layer.transform as LayerTransform, horizontally, axis);
        if (layer.mask) layer.mask.placement = maskPlacementMoving(layer.mask as never, layer.transform as LayerTransform, flipped) as never;
        layer.transform = flipped as never;
      }
    });
    this.endEdit();
  },

  /** Flips the whole canvas: every layer, folder and placed mask, and the selection, as one undo step. */
  flipCanvas(this: EditorSession, horizontally: boolean): void {
    this.commitTransform();
    this.cancelCrop();
    const document = this.document;
    if (!this.canEditLayers || !document) return;
    const axis = horizontally ? document.width / 2 : document.height / 2;
    this.finishOpacityEdit();
    this.beginEdit(horizontally ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical');
    const mirror = horizontally ? { a: -1, b: 0, c: 0, d: 1, tx: document.width, ty: 0 } : { a: 1, b: 0, c: 0, d: -1, tx: 0, ty: document.height };
    this.updateDocument((d) => {
      for (const layer of d.layers) {
        layer.transform = mirrored(layer.transform as LayerTransform, horizontally, axis) as never;
        if (layer.mask?.placement) layer.mask.placement = mirrored(layer.mask.placement as LayerTransform, horizontally, axis) as never;
      }
      if (d.selection) d.selection = { path: (d.selection.path as unknown as SelectionPath).transformed(mirror), antialiased: d.selection.antialiased } as never;
    });
    this.endEdit();
  },

  // MARK: Adjustment layers

  addAdjustment(this: EditorSession, kind: AdjustmentKind): void {
    const document = this.document;
    if (!this.canEditLayers || !document || document.layers.length >= 10_000) return;
    const adjustment: LayerAdjustment = makeAdjustment(kind);
    // A new Gradient Map runs from the foreground to the background colour; each Grain layer gets its own pattern.
    if (kind === 'Gradient Map') {
      const fg = this.foregroundColor, bg = this.backgroundColor;
      adjustment.gradientMapSettings = { shadows: { ...fg }, highlights: { ...bg }, reversed: false };
    }
    if (kind === 'Grain') adjustment.grainSettings = { amount: 25, size: 1.5, roughness: 50, seed: randomSeed() };
    const active = this.activeLayer;
    const layer: Layer = { ...blankLayer(kind, document.width, document.height), adjustment,
      parentID: active?.isGroup ? active.id : active?.parentID ?? null };
    const index = active ? this.layerIndex(active.id) + 1 : document.layers.length;
    this.beginEdit(`New ${kind} Adjustment`);
    this.updateDocument((d) => { d.layers.splice(index, 0, layer as never); });
    if (layer.parentID) this.expandGroup(layer.parentID);
    this.activeLayerID = layer.id;
    this.endEdit();
    this.adjustmentEditingID = layer.id;
    void this.beginAdjustmentEditing(layer.id);
  },

  updateAdjustment(this: EditorSession, id: string, value: LayerAdjustment): void {
    const index = this.layerIndex(id);
    if (index < 0 || !adjustmentIsValid(value)) return;
    this.updateDocument((d) => { d.layers[index].adjustment = value as never; });
    this.brushRevision += 1;
  },
};


/** A layer dropped into the middle of a clipping group joins it (LiveLayerMask.adoptClipping). */
export function adoptClipping(id: string, all: Layer[]): void {
  const layer = all.find((l) => l.id === id);
  if (!layer || layer.isGroup) return;
  const siblings = all.filter((l) => l.parentID === layer.parentID);
  const index = siblings.findIndex((l) => l.id === id);
  if (index <= 0 || index + 1 >= siblings.length) return;
  const source = siblings[index + 1].maskSourceID;
  if (!source || source === id) return;
  const below = siblings[index - 1];
  if (below.id !== source && below.maskSourceID !== source) return;
  const position = all.findIndex((l) => l.id === id);
  all[position] = { ...all[position], maskSourceID: source };
}

/** A moved layer stops clipping when it no longer sits in the contiguous stack above its base. */
export function releaseDetachedClipping(all: Layer[]): void {
  const byParent = new Map<string | null, Layer[]>();
  for (const l of all) { const list = byParent.get(l.parentID); if (list) list.push(l); else byParent.set(l.parentID, [l]); }
  const release = new Set<string>();
  for (const stack of byParent.values()) {
    let base: string | null = null;
    for (const l of stack) {
      if (l.maskSourceID) {
        if (l.maskSourceID !== base) { release.add(l.id); base = l.id; }
      } else base = l.isGroup ? null : l.id;
    }
  }
  for (let i = 0; i < all.length; i++) if (release.has(all[i].id)) all[i] = { ...all[i], maskSourceID: null };
}

void wandTrace; void applyPoint; void imageOn;

type Layers = typeof layers;
declare module './session' {
  interface EditorSession extends Layers {}
}
extend(EditorSession, layers);
