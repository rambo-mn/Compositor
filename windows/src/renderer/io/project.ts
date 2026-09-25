// Compositor projects, read and written in the Mac app's format (docs/project-format.md): manifest.json plus
// images/<layer UUID>.png and images/<layer UUID>.mask.png. On the Mac a project is a folder package; on Windows it
// is normally one .comp file (a ZIP holding the same files), and folder packages open and save too, so projects move
// between the two. Manifests are version 7, written with every key the Mac's decoder requires; versions 1–7 open.
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import type { CanvasDocument, Layer, LayerMask, LayerShapeStyle, ImageAsset } from '../model/document';
import {
  BLEND_MODES, InvalidProjectError, LayerBlendMode, SHAPE_KINDS, asset, validateHierarchy, validateLiveMasks,
} from '../model/document';
import { LAYER_SAMPLINGS, LayerSampling, LayerTransform, isValidTransform } from '../model/transform';
import { adjustmentIsValid, decodeAdjustment, encodeAdjustment } from '../model/adjustments';
import { Raster, premultiply, unpremultiply } from '../raster/raster';
import { decodeImageBytes, decodeProjectPNG, encodePNG } from './codecs';

export const FORMAT = 'com.compositor.project';
export const VERSION = 7;

export class ProjectError extends Error {}
export const errors = {
  invalid: () => new ProjectError('This is not a valid Compositor project, or its metadata is damaged.'),
  version: (v: number) => new ProjectError(`This project uses format version ${v}. This app supports versions 1–7.`),
  missingImage: () => new ProjectError('An image inside the project is missing or damaged. The current document has not been replaced.'),
  tooLarge: () => new ProjectError('This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.'),
  encode: () => new ProjectError('An image could not be saved. The previous project has not been replaced.'),
};

// MARK: Manifest (Swift Codable shapes: points and sizes are [x, y] arrays)

interface TransformRecord { origin: [number, number]; size: [number, number]; rotation: number; flipX: boolean; flipY: boolean; sampling: LayerSampling }

export interface LayerRecord {
  id: string;
  name: string;
  isVisible: boolean;
  transform: LayerTransform;
  imageFile: string | null;
  parentID: string | null;
  isGroup: boolean | null;
  opacity: number | null;
  blendMode: LayerBlendMode | null;
  maskFile: string | null;
  maskEnabled: boolean | null;
  maskSourceID: string | null;
  adjustment: import('../model/adjustments').LayerAdjustment | null;
  maskPlacement: LayerTransform | null;
  maskLinked: boolean | null;
  shape: LayerShapeStyle | null;
}

export interface Manifest {
  format: string;
  version: number;
  colorSpace: string;
  resolution: number | null;
  documentID: string;
  width: number;
  height: number;
  activeLayerID: string | null;
  layers: LayerRecord[];
}

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const need = (o: Record<string, unknown>, key: string) => { if (!(key in o)) throw errors.invalid(); return o[key]; };
const num = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw errors.invalid(); return v; };
const int = (v: unknown) => { const n = num(v); if (!Number.isInteger(n)) throw errors.invalid(); return n; };
const bool = (v: unknown) => { if (typeof v !== 'boolean') throw errors.invalid(); return v; };
const str = (v: unknown) => { if (typeof v !== 'string') throw errors.invalid(); return v; };
const uuid = (v: unknown) => { const s = str(v); if (!UUID.test(s)) throw errors.invalid(); return s.toUpperCase(); };
const optional = <T>(o: Record<string, unknown>, key: string, read: (v: unknown) => T): T | null =>
  o[key] === undefined || o[key] === null ? null : read(o[key]);
const pair = (v: unknown): [number, number] => {
  if (Array.isArray(v) && v.length === 2) return [num(v[0]), num(v[1])];
  // Tolerate the keyed form other encoders use.
  if (isObject(v)) {
    if ('x' in v && 'y' in v) return [num(v.x), num(v.y)];
    if ('width' in v && 'height' in v) return [num(v.width), num(v.height)];
  }
  throw errors.invalid();
};

function decodeTransform(v: unknown): LayerTransform {
  if (!isObject(v)) throw errors.invalid();
  const origin = pair(need(v, 'origin')), size = pair(need(v, 'size'));
  const sampling = str(need(v, 'sampling'));
  if (!LAYER_SAMPLINGS.includes(sampling as LayerSampling)) throw errors.invalid();
  return {
    origin: { x: origin[0], y: origin[1] }, size: { width: size[0], height: size[1] },
    rotation: num(need(v, 'rotation')), flipX: bool(need(v, 'flipX')), flipY: bool(need(v, 'flipY')), sampling: sampling as LayerSampling,
  };
}

function encodeTransform(t: LayerTransform): TransformRecord {
  return { origin: [t.origin.x, t.origin.y], size: [t.size.width, t.size.height], rotation: t.rotation, flipX: t.flipX, flipY: t.flipY, sampling: t.sampling };
}

function decodeShape(v: unknown): LayerShapeStyle {
  if (!isObject(v)) throw errors.invalid();
  const kind = str(need(v, 'kind'));
  if (!SHAPE_KINDS.includes(kind as LayerShapeStyle['kind'])) throw errors.invalid();
  return { kind: kind as LayerShapeStyle['kind'], red: num(need(v, 'red')), green: num(need(v, 'green')), blue: num(need(v, 'blue')), cornerRadius: num(need(v, 'cornerRadius')) };
}

export function decodeManifest(json: unknown): Manifest {
  if (!isObject(json)) throw errors.invalid();
  const format = json.format, version = json.version;
  if (format !== FORMAT) throw errors.invalid();
  if (typeof version !== 'number' || !Number.isInteger(version)) throw errors.invalid();
  if (!(version >= 1 && version <= 7)) throw errors.version(version);
  const layers = need(json, 'layers');
  if (!Array.isArray(layers)) throw errors.invalid();
  const manifest: Manifest = {
    format, version, colorSpace: str(need(json, 'colorSpace')), resolution: optional(json, 'resolution', num),
    documentID: uuid(need(json, 'documentID')), width: int(need(json, 'width')), height: int(need(json, 'height')),
    activeLayerID: optional(json, 'activeLayerID', uuid),
    layers: layers.map((l): LayerRecord => {
      if (!isObject(l)) throw errors.invalid();
      const blend = optional(l, 'blendMode', str);
      if (blend !== null && !BLEND_MODES.includes(blend as LayerBlendMode)) throw errors.invalid();
      let adjustment = null;
      if (l.adjustment != null) {
        try { adjustment = decodeAdjustment(l.adjustment); } catch { throw errors.invalid(); }
      }
      return {
        id: uuid(need(l, 'id')), name: str(need(l, 'name')), isVisible: bool(need(l, 'isVisible')),
        transform: decodeTransform(need(l, 'transform')), imageFile: optional(l, 'imageFile', str),
        parentID: optional(l, 'parentID', uuid), isGroup: optional(l, 'isGroup', bool), opacity: optional(l, 'opacity', num),
        blendMode: blend as LayerBlendMode | null, maskFile: optional(l, 'maskFile', str), maskEnabled: optional(l, 'maskEnabled', bool),
        maskSourceID: optional(l, 'maskSourceID', uuid), adjustment, maskPlacement: optional(l, 'maskPlacement', decodeTransform),
        maskLinked: optional(l, 'maskLinked', bool), shape: optional(l, 'shape', decodeShape),
      };
    }),
  };
  validateManifest(manifest);
  return manifest;
}

/** ProjectStore.validate. */
export function validateManifest(m: Manifest): void {
  if (m.format !== FORMAT) throw errors.invalid();
  if (!(m.version >= 1 && m.version <= 7)) throw errors.version(m.version);
  if (m.colorSpace !== 'sRGB') throw errors.invalid();
  if (m.resolution != null && !(Number.isFinite(m.resolution) && m.resolution >= 1 && m.resolution <= 9600)) throw errors.invalid();
  if (!(m.width >= 1 && m.width <= 30_000 && m.height >= 1 && m.height <= 30_000) || m.layers.length > 10_000) throw errors.tooLarge();
  for (const layer of m.layers) {
    if (layer.adjustment) {
      if (m.version < 7 || layer.isGroup === true || layer.imageFile != null || !adjustmentIsValid(layer.adjustment)) throw errors.invalid();
    }
    // Layer masks arrived in version 4, folder masks in version 6.
    if (layer.maskFile != null && !(m.version >= (layer.isGroup ? 6 : 4) && layer.maskFile === `${layer.id}.mask.png`)) throw errors.invalid();
    if (layer.maskEnabled != null && layer.maskFile == null) throw errors.invalid();
    if (layer.maskPlacement && !(isValidTransform(layer.maskPlacement) && layer.maskFile != null)) throw errors.invalid();
    const opacity = layer.opacity ?? 1, blend = layer.blendMode ?? 'Normal';
    if (!(opacity >= 0 && opacity <= 1) || !(m.version >= 3 || (opacity === 1 && blend === 'Normal'))
        || (layer.isGroup && !(opacity === 1 && blend === 'Normal'))) throw errors.invalid();
  }
  const records = m.layers.map((l) => ({ id: l.id, parentID: l.parentID, isGroup: l.isGroup === true, hasImage: l.imageFile != null,
    maskSourceID: l.maskSourceID, isAdjustment: !!l.adjustment }));
  try { validateHierarchy(records); validateLiveMasks(records); } catch { throw errors.invalid(); }
  if (m.version < 5 && m.layers.some((l) => l.maskSourceID)) throw errors.invalid();
  if (m.version === 1 && m.layers.some((l) => l.parentID || l.isGroup)) throw errors.invalid();
  const ids = new Set<string>();
  for (const layer of m.layers) {
    if (ids.has(layer.id) || !isValidTransform(layer.transform) || !layer.name.trim() || new TextEncoder().encode(layer.name).length > 16_384
        || (layer.imageFile != null && layer.imageFile !== `${layer.id}.png`)) throw errors.invalid();
    ids.add(layer.id);
  }
  if (m.activeLayerID && !ids.has(m.activeLayerID)) throw errors.invalid();
}

/** Keys sorted, nulls left out: the Mac's JSONEncoder output (.sortedKeys, optionals omitted). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === null || v === undefined) continue;
      out[key] = sorted(v);
    }
    return out;
  }
  return value;
}

export function encodeManifest(m: Manifest): Uint8Array {
  const json = {
    ...m,
    layers: m.layers.map((l) => ({
      ...l,
      transform: encodeTransform(l.transform),
      maskPlacement: l.maskPlacement ? encodeTransform(l.maskPlacement) : null,
      adjustment: l.adjustment ? encodeAdjustment(l.adjustment) : null,
    })),
  };
  const bytes = strToU8(JSON.stringify(sorted(json), null, 2));
  if (bytes.length > 4 * 1024 * 1024) throw errors.tooLarge();
  return bytes;
}

// MARK: Documents

export interface ProjectContents {
  document: CanvasDocument;
  activeLayerID: string | null;
}

/** The manifest for a document (EditorSession.projectSnapshot). */
export function manifestFor(document: CanvasDocument, activeLayerID: string | null): Manifest {
  return {
    format: FORMAT, version: VERSION, colorSpace: 'sRGB', resolution: document.resolution, documentID: document.id,
    width: document.width, height: document.height, activeLayerID,
    layers: document.layers.map((layer): LayerRecord => ({
      id: layer.id, name: layer.name, isVisible: layer.isVisible, transform: layer.transform,
      imageFile: layer.asset ? `${layer.id}.png` : null, parentID: layer.parentID, isGroup: layer.isGroup,
      opacity: layer.opacity, blendMode: layer.blendMode, maskFile: layer.mask ? `${layer.id}.mask.png` : null,
      maskEnabled: layer.mask ? layer.mask.isEnabled : null, maskSourceID: layer.maskSourceID, adjustment: layer.adjustment,
      maskPlacement: layer.mask?.placement ?? null, maskLinked: layer.mask ? layer.mask.isLinked : null,
      shape: layer.shape && layer.asset && layer.asset.image === layer.shape.image ? layer.shape.style : null,
    })),
  };
}

const encodedImages = new WeakMap<Raster, Uint8Array>();

/** A raster as project PNG bytes: straight RGBA, or 8-bit gray without alpha for masks. Cached per raster, so
 *  saving again re-encodes only what changed. */
export function rasterPNG(raster: Raster): Uint8Array {
  const cached = encodedImages.get(raster);
  if (cached) return cached;
  const data = raster.toData();
  if (raster.channels === 4) unpremultiply(data);
  const png = encodePNG(data, raster.width, raster.height, raster.channels, 0);
  encodedImages.set(raster, png);
  return png;
}

/** Every file of a project: manifest.json and images/…, ready for a ZIP or a folder package. */
export function projectFiles(document: CanvasDocument, activeLayerID: string | null,
                             encode: (raster: Raster) => Uint8Array = rasterPNG): Record<string, Uint8Array> {
  const manifest = manifestFor(document, activeLayerID);
  validateManifest(manifest);
  const files: Record<string, Uint8Array> = { 'manifest.json': encodeManifest(manifest) };
  let pixels = 0, maskPixels = 0;
  for (const layer of document.layers) {
    if (layer.asset) {
      const r = layer.asset.image;
      pixels = checkSize(r.width, r.height, pixels);
      files[`images/${layer.id}.png`] = encode(r);
    }
    if (layer.mask) {
      const r = layer.mask.asset.image;
      if (r.channels !== 1) throw errors.invalid();
      maskPixels = checkSize(r.width, r.height, maskPixels);
      files[`images/${layer.id}.mask.png`] = encode(r);
    }
  }
  return files;
}

function checkSize(width: number, height: number, used: number): number {
  if (!(width >= 1 && width <= 30_000 && height >= 1 && height <= 30_000) || width * height > 100_000_000 - used) throw errors.tooLarge();
  return used + width * height;
}

/** A .comp file: the project's files in a ZIP (images stored, the manifest compressed). */
export function zipProject(files: Record<string, Uint8Array>): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, data] of Object.entries(files)) entries[name] = [data, { level: name.endsWith('.png') ? 0 : 6 }];
  return zipSync(entries as never);
}

/** The files of a .comp file (a ZIP), refusing anything outside manifest.json and images/. */
export function unzipProject(bytes: Uint8Array): Record<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { throw errors.invalid(); }
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    // Some tools nest everything in one top-level folder ("Photo.comp/manifest.json").
    const normalized = name.replace(/\\/g, '/').replace(/^[^/]+\.comp\//i, '');
    if (normalized.endsWith('/')) continue;
    if (normalized === 'manifest.json' || /^images\/[^/]+$/.test(normalized)) files[normalized] = data;
  }
  return files;
}

/** Decodes a project PNG: colour layers premultiplied; masks must be 8-bit gray without alpha. */
export async function decodeLayerPNG(bytes: Uint8Array, mask: boolean, budget: { pixels: number }): Promise<Raster> {
  if (bytes.length > 512 * 1024 * 1024) throw errors.tooLarge();
  let png: ReturnType<typeof decodeProjectPNG>;
  try { png = decodeProjectPNG(bytes); } catch { throw errors.missingImage(); }
  if (png.depth > 8) throw errors.missingImage();
  budget.pixels = checkSize(png.width, png.height, budget.pixels);
  if (mask) {
    if (png.channels !== 1 || png.depth !== 8 || png.palette) throw errors.invalid();
    return Raster.fromData(png.width, png.height, 1, png.data);
  }
  let rgba: Uint8Array;
  if (png.depth === 8 && !png.palette && !png.profile && png.channels >= 1) {
    const n = png.width * png.height, c = png.channels, src = png.data;
    rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (c === 4) { rgba[i * 4] = src[i * 4]; rgba[i * 4 + 1] = src[i * 4 + 1]; rgba[i * 4 + 2] = src[i * 4 + 2]; rgba[i * 4 + 3] = src[i * 4 + 3]; }
      else if (c === 3) { rgba[i * 4] = src[i * 3]; rgba[i * 4 + 1] = src[i * 3 + 1]; rgba[i * 4 + 2] = src[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
      else if (c === 2) { const g = src[i * 2]; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = src[i * 2 + 1]; }
      else { const g = src[i]; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255; }
    }
  } else {
    const decoded = await decodeImageBytes(bytes);
    rgba = decoded.data;
  }
  premultiply(rgba);
  return Raster.fromData(png.width, png.height, 4, rgba);
}

/** A project's document from its files, validated completely before anything is returned. */
export async function readProject(files: Record<string, Uint8Array>): Promise<ProjectContents> {
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes || manifestBytes.length > 4 * 1024 * 1024) throw errors.invalid();
  let json: unknown;
  try { json = JSON.parse(strFromU8(manifestBytes)); } catch { throw errors.invalid(); }
  const manifest = decodeManifest(json);
  const images = { pixels: 0 }, masks = { pixels: 0 };
  const layers: Layer[] = [];
  for (const record of manifest.layers) {
    let image: ImageAsset | null = null, mask: LayerMask | null = null;
    if (record.imageFile) {
      const bytes = files[`images/${record.imageFile}`];
      if (!bytes) throw errors.missingImage();
      image = asset(await decodeLayerPNG(bytes, false, images), record.name);
    }
    if (record.maskFile) {
      const bytes = files[`images/${record.maskFile}`];
      if (!bytes) throw errors.missingImage();
      mask = { asset: asset(await decodeLayerPNG(bytes, true, masks), record.name), isEnabled: record.maskEnabled ?? true,
        placement: record.maskPlacement, isLinked: record.maskLinked ?? true };
    }
    layers.push({
      id: record.id, asset: image, transform: record.transform, name: record.name, isVisible: record.isVisible,
      parentID: record.parentID, isGroup: record.isGroup === true, opacity: record.opacity ?? 1, blendMode: record.blendMode ?? 'Normal',
      maskSourceID: record.maskSourceID, mask, adjustment: record.adjustment,
      shape: record.shape && image ? { style: record.shape, image: image.image } : null,
    });
  }
  const document: CanvasDocument = { id: manifest.documentID, width: manifest.width, height: manifest.height,
    resolution: manifest.resolution ?? 72, layers, selection: null };
  return { document, activeLayerID: manifest.activeLayerID };
}

void InvalidProjectError;
