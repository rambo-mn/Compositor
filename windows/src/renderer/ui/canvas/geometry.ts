// Where the canvas's handles are on screen: the Move tool's transform box, the crop frame, and the pending
// gradient's endpoints (TransformOverlay.swift). Shared by drawing and hit-testing, in view (CSS pixel) coordinates.
import type { EditorSession } from '../../session';
import type { Point, Rect } from '../../model/geometry';
import { DragMode, HANDLES, LayerTransform, radians, unitPoint } from '../../model/transform';
import type { CanvasViewport } from '../../model/viewport';
import { effectiveVisibleIDs } from '../../model/document';

export interface TransformGeometry {
  handles: Point[];
  rotationHandle: Point;
  /** A distortion has no single rotation, so its rotation handle is hidden. */
  showsRotation: boolean;
}

type Size = { width: number; height: number };

export function geometryFromTransform(transform: LayerTransform, viewport: CanvasViewport, size: Size): TransformGeometry {
  const handles = HANDLES.map((unit) => viewport.viewPoint(unitPoint(transform, unit), size));
  const r = radians(transform);
  return {
    handles,
    rotationHandle: { x: handles[1].x + Math.sin(r) * 28, y: handles[1].y - Math.cos(r) * 28 },
    showsRotation: true,
  };
}

/** Handles for a distortion: its four corners (document pixels) and the midpoints of its edges. */
export function geometryFromCorners(corners: Point[], viewport: CanvasViewport, size: Size): TransformGeometry {
  const view = corners.map((p) => viewport.viewPoint(p, size));
  const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const handles = [view[0], middle(view[0], view[1]), view[1], middle(view[1], view[2]),
    view[2], middle(view[2], view[3]), view[3], middle(view[3], view[0])];
  return { handles, rotationHandle: handles[1], showsRotation: false };
}

/** What a press at `point` grabs: the rotation handle, a handle, or an edge (which resizes like its middle). */
export function hitTransform(geometry: TransformGeometry, point: Point): DragMode | null {
  const near = (other: Point) => Math.hypot(point.x - other.x, point.y - other.y) <= 10;
  if (geometry.showsRotation && near(geometry.rotationHandle)) return { kind: 'rotate' };
  const index = geometry.handles.findIndex(near);
  if (index >= 0) return { kind: 'resize', index };
  for (const [start, end, handle] of [[0, 2, 1], [2, 4, 3], [4, 6, 5], [6, 0, 7]]) {
    const a = geometry.handles[start], b = geometry.handles[end];
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0) continue;
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    if (t >= 0 && t <= 1 && Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= 10) return { kind: 'resize', index: handle };
  }
  return null;
}

/** The Move tool's box: the active layer's, or one around a group or several selected layers. */
export function transformGeometry(session: EditorSession): TransformGeometry | null {
  const document = session.document;
  if (session.tool !== 'move' || !(session.showsTransformControls || session.transformEdit?.persistent === true) || !document) return null;
  const size = { width: document.width, height: document.height };
  const edit = session.transformEdit;
  if (edit?.group || (!edit && session.transformsAsGroup)) {
    if (edit?.corners) return geometryFromCorners(edit.corners, session.viewport, size);
    const box = edit?.draft ?? session.groupTransformBox;
    return box ? geometryFromTransform(box, session.viewport, size) : null;
  }
  const layer = session.activeLayer;
  if (!layer || !layer.asset || layer.isGroup || !effectiveVisibleIDs(document).has(layer.id)) return null;
  if (edit && edit.layerID === layer.id && edit.corners) return geometryFromCorners(edit.corners, session.viewport, size);
  return geometryFromTransform(session.editedTransform(layer), session.viewport, size);
}

/** The pending gradient's endpoints on screen, once it has a line. */
export function gradientLine(session: EditorSession): { start: Point; end: Point } | null {
  const edit = session.gradientEdit, document = session.document;
  if (!edit || !document || Math.hypot(edit.end.x - edit.start.x, edit.end.y - edit.start.y) < 0.5) return null;
  const size = { width: document.width, height: document.height };
  return { start: session.viewport.viewPoint(edit.start, size), end: session.viewport.viewPoint(edit.end, size) };
}

export function cropViewRect(session: EditorSession): Rect | null {
  const rect = session.visibleCropRect, document = session.document;
  if (!rect || !document) return null;
  const origin = session.viewport.viewPoint({ x: rect.x, y: rect.y }, { width: document.width, height: document.height });
  const scale = session.viewport.pointsPerPixel;
  return { x: origin.x, y: origin.y, width: rect.width * scale, height: rect.height * scale };
}

export function cropHandles(rect: Rect): Point[] {
  return HANDLES.map((unit) => ({ x: rect.x + unit.x * rect.width, y: rect.y + unit.y * rect.height }));
}

/** The crop frame's grab areas: its corners, and whole edges rather than just their middles. */
export function cropResizeRegions(session: EditorSession): { index: number; rect: Rect }[] {
  const rect = cropViewRect(session);
  if (!rect) return [];
  const handles = cropHandles(rect);
  const radius = 10;
  const regions = [0, 2, 4, 6].map((index) => ({
    index, rect: { x: handles[index].x - radius, y: handles[index].y - radius, width: radius * 2, height: radius * 2 },
  }));
  for (const index of [1, 5]) {
    regions.push({ index, rect: { x: rect.x + radius, y: handles[index].y - radius, width: Math.max(0, rect.width - radius * 2), height: radius * 2 } });
  }
  for (const index of [3, 7]) {
    regions.push({ index, rect: { x: handles[index].x - radius, y: rect.y + radius, width: radius * 2, height: Math.max(0, rect.height - radius * 2) } });
  }
  return regions;
}

export const rectContains = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
