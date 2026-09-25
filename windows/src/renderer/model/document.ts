// The document: a canvas size and a stack of layers, bottom to top. Values are immutable; edits produce new
// objects (via immer in the session), so undo history can keep whole documents cheaply. Ports ImageLayer and
// CanvasDocument (EditorSession.swift), LayerHierarchy (LayerGroups.swift) and the mask/shape value types.
import { Raster } from '../raster/raster';
import { LayerTransform, makeTransform, transformsEqual } from './transform';
import { LayerAdjustment, deepEqual } from './adjustments';
import type { DocumentSelection } from './selection';
import { selectionsEqual } from './selection';

export type LayerBlendMode = 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten' | 'Difference'
  | 'Color Dodge' | 'Color Burn' | 'Hue' | 'Saturation' | 'Color' | 'Luminosity';
export const BLEND_MODES: LayerBlendMode[] = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'Difference', 'Color Dodge', 'Color Burn', 'Hue', 'Saturation', 'Color', 'Luminosity'];

/** Pixels plus the Layers panel's small preview. */
export interface ImageAsset {
  image: Raster;
  thumbnail: Raster;
  name: string;
}

/** Normalized layer-local coverage: white reveals, black hides. */
export interface LayerMask {
  asset: ImageAsset;
  isEnabled: boolean;
  /** Where the mask sits once moved apart from its layer; null while it covers the layer's own pixel grid. */
  placement: LayerTransform | null;
  /** Linked, layer and mask move together; unlinked, each transforms on its own. */
  isLinked: boolean;
}

export type ShapeKind = 'Rectangle' | 'Ellipse';
export const SHAPE_KINDS: ShapeKind[] = ['Rectangle', 'Ellipse'];
export interface LayerShapeStyle { kind: ShapeKind; red: number; green: number; blue: number; cornerRadius: number }
/** A layer made with the Shape tool; live while the layer's image is still this image. */
export interface LayerShape { style: LayerShapeStyle; image: Raster }

export interface Layer {
  id: string;
  asset: ImageAsset | null;
  transform: LayerTransform;
  name: string;
  isVisible: boolean;
  parentID: string | null;
  isGroup: boolean;
  opacity: number;
  blendMode: LayerBlendMode;
  /** Clipping mask: the layer supplying live alpha. */
  maskSourceID: string | null;
  mask: LayerMask | null;
  adjustment: LayerAdjustment | null;
  shape: LayerShape | null;
}

export interface CanvasDocument {
  id: string;
  width: number;
  height: number;
  resolution: number;
  /** Bottom to top. */
  layers: Layer[];
  /** Part of the document so undo covers selection changes. Not saved. */
  selection: DocumentSelection | null;
}

export function newID(): string {
  return crypto.randomUUID().toUpperCase();
}

export function makeDocument(width: number, height: number, layers: Layer[] = [], resolution = 72, id = newID()): CanvasDocument {
  return { id, width, height, resolution, layers, selection: null };
}

export function makeLayer(fields: Partial<Layer> & { name: string; transform: LayerTransform }): Layer {
  return {
    id: newID(), asset: null, isVisible: true, parentID: null, isGroup: false, opacity: 1, blendMode: 'Normal',
    maskSourceID: null, mask: null, adjustment: null, shape: null, ...fields,
  };
}

export function imageLayer(asset: ImageAsset, origin: { x: number; y: number }): Layer {
  return makeLayer({ name: asset.name, asset, transform: makeTransform(origin, { width: asset.image.width, height: asset.image.height }) });
}

export function blankLayer(name: string, width: number, height: number): Layer {
  return makeLayer({ name, transform: makeTransform({ x: 0, y: 0 }, { width, height }) });
}

export function validDimension(value: string): number | null {
  const text = value.trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 30_000 ? n : null;
}

// MARK: Equality (what counts as a change for undo)

export function masksEqual(a: LayerMask | null, b: LayerMask | null): boolean {
  if (!a || !b) return a === b;
  return a.asset.image === b.asset.image && a.isEnabled === b.isEnabled && transformsEqual(a.placement, b.placement) && a.isLinked === b.isLinked;
}

export function shapesEqual(a: LayerShape | null, b: LayerShape | null): boolean {
  if (!a || !b) return a === b;
  return a.image === b.image && deepEqual(a.style, b.style);
}

export function layersEqual(a: Layer, b: Layer): boolean {
  if (a === b) return true;
  return a.id === b.id && a.name === b.name && a.isVisible === b.isVisible && transformsEqual(a.transform, b.transform)
    && (a.asset?.image ?? null) === (b.asset?.image ?? null) && a.parentID === b.parentID && a.isGroup === b.isGroup
    && a.opacity === b.opacity && a.blendMode === b.blendMode && masksEqual(a.mask, b.mask)
    && a.maskSourceID === b.maskSourceID && deepEqual(a.adjustment, b.adjustment) && shapesEqual(a.shape, b.shape);
}

export function documentsEqual(a: CanvasDocument | null, b: CanvasDocument | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.width === b.width && a.height === b.height && a.resolution === b.resolution
    && a.layers.length === b.layers.length && a.layers.every((layer, i) => layersEqual(layer, b.layers[i]))
    && selectionsEqual(a.selection, b.selection);
}

// MARK: Layer helpers

/** Where the mask's pixels sit on the document: its own placement, else the layer's. */
export function maskTransform(layer: Layer): LayerTransform { return layer.mask?.placement ?? layer.transform; }

/** The shape this layer still is: null once its pixels were edited some other way. */
export function liveShape(layer: Layer): LayerShape | null {
  if (!layer.shape || !layer.asset || layer.asset.image !== layer.shape.image) return null;
  return layer.shape;
}

export function enabledMaskImage(mask: LayerMask | null): Raster | null {
  return mask && mask.isEnabled ? mask.asset.image : null;
}

/** Pixel dimensions a layer's grid has: its image, else its size. */
export function layerPixelSize(layer: Layer): { width: number; height: number } {
  return layer.asset
    ? { width: layer.asset.image.width, height: layer.asset.image.height }
    : { width: Math.round(layer.transform.size.width), height: Math.round(layer.transform.size.height) };
}

// MARK: Hierarchy

export interface HierarchyEntry {
  layer: Layer;
  depth: number;
  visible: boolean;
}

/** Layers in tree order (bottom to top, or top first for the Layers panel), with depth and effective visibility. */
export function hierarchyEntries(layers: Layer[], topFirst = false, collapsed: ReadonlySet<string> = new Set()): HierarchyEntry[] {
  const children = new Map<string | null, Layer[]>();
  for (const layer of layers) {
    const key = layer.parentID ?? null;
    const list = children.get(key);
    if (list) list.push(layer); else children.set(key, [layer]);
  }
  const result: HierarchyEntry[] = [];
  const visit = (parent: string | null, depth: number, visible: boolean) => {
    if (depth > 64) return;
    const siblings = children.get(parent) ?? [];
    const ordered = topFirst ? siblings.slice().reverse() : siblings;
    for (const layer of ordered) {
      const effective = visible && layer.isVisible;
      result.push({ layer, depth, visible: effective });
      if (layer.isGroup && !collapsed.has(layer.id)) visit(layer.id, depth + 1, effective);
    }
  };
  visit(null, 0, true);
  return result;
}

/** Visible, non-folder layers in drawing order. */
export function renderLayers(doc: CanvasDocument): Layer[] {
  return hierarchyEntries(doc.layers).filter((e) => e.visible && !e.layer.isGroup).map((e) => e.layer);
}

export function effectiveVisibleIDs(doc: CanvasDocument): Set<string> {
  return new Set(hierarchyEntries(doc.layers).filter((e) => e.visible).map((e) => e.layer.id));
}

/** Everything inside a folder, at any depth. */
export function descendantIDs(layers: Layer[], id: string): Set<string> {
  const children = new Map<string | null, Layer[]>();
  for (const layer of layers) {
    const list = children.get(layer.parentID);
    if (list) list.push(layer); else children.set(layer.parentID, [layer]);
  }
  const result = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const child of children.get(parent) ?? []) {
      if (!result.has(child.id)) { result.add(child.id); pending.push(child.id); }
    }
  }
  return result;
}

export class InvalidProjectError extends Error {
  constructor(message = 'This is not a valid Compositor project, or its metadata is damaged.') { super(message); }
}

export interface HierarchyRecord {
  id: string;
  parentID: string | null;
  isGroup: boolean;
  hasImage: boolean;
  maskSourceID: string | null;
  isAdjustment: boolean;
}

export const hierarchyRecord = (layer: Layer): HierarchyRecord => ({
  id: layer.id, parentID: layer.parentID, isGroup: layer.isGroup, hasImage: !!layer.asset,
  maskSourceID: layer.maskSourceID, isAdjustment: !!layer.adjustment,
});

/** Parents must be existing folders; no cycles; nesting at most 64 deep; folders carry no image. */
export function validateHierarchy(records: HierarchyRecord[]): void {
  const byID = new Map<string, HierarchyRecord>();
  for (const record of records) {
    if (byID.has(record.id) || (record.isGroup && record.hasImage)) throw new InvalidProjectError();
    byID.set(record.id, record);
  }
  for (const record of records) {
    const seen = new Set([record.id]);
    let parent = record.parentID;
    while (parent) {
      const node = byID.get(parent);
      if (seen.size > 64 || seen.has(parent) || !node || !node.isGroup) throw new InvalidProjectError();
      seen.add(parent);
      parent = node.parentID;
    }
    if (record.isGroup && seen.size > 64) throw new InvalidProjectError();
  }
}

/** Clipping-mask links: sources must exist, not be folders or adjustments; no cycles; chains under 256. */
export function validateLiveMasks(records: HierarchyRecord[]): void {
  const byID = new Map<string, HierarchyRecord>();
  for (const record of records) {
    if (byID.has(record.id)) throw new InvalidProjectError();
    byID.set(record.id, record);
  }
  for (const record of records) {
    const path = new Set<string>();
    let current: string | null = record.id;
    while (current) {
      const node = byID.get(current);
      if (path.size >= 256 || path.has(current) || !node) throw new InvalidProjectError();
      path.add(current);
      if (node.maskSourceID) {
        const source = byID.get(node.maskSourceID);
        if (node.isGroup || !source || source.isGroup || source.isAdjustment) throw new InvalidProjectError();
      }
      current = node.maskSourceID;
    }
  }
}

export function isValidHierarchy(layers: Layer[]): boolean {
  try { validateHierarchy(layers.map(hierarchyRecord)); return true; } catch { return false; }
}
