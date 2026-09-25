// Everything drawn over the document (TransformOverlay, BrushCursorOverlay and SampleRingOverlay in the Mac app):
// the crop frame, the gradient line, the transform box, marching ants, lasso and shape drafts, snap guides, the
// brush circle with Clone Stamp's source mark and preview, and the eyedropper's sample ring.
import type { EditorSession } from '../../session';
import type { Point } from '../../model/geometry';
import type { PaletteColor } from '../../model/color';
import { cssColor } from '../../model/color';
import { cropHandles, cropViewRect, gradientLine, transformGeometry } from './geometry';

export let ACCENT = '#2f8cff';
/** Windows' accent colour, once the main process has read it. */
export function setAccent(color: string): void { ACCENT = color; }

export interface BrushCursorState {
  point: Point;
  /** On screen, in CSS pixels. */
  diameter: number;
  /** While hardness is being dragged: the fraction painted at full strength, shown as an inner ring. */
  hardness: number | null;
  /** Clone Stamp's source, on screen. */
  sample: Point | null;
  /** Clone Stamp's preview of what a click would stamp, already shaped by the brush tip. */
  preview: CanvasImageSource | null;
  previewOpacity: number;
}

export interface OverlayState {
  antsPhase: number;
  brush: BrushCursorState | null;
  ring: { point: Point; original: PaletteColor; sampled: PaletteColor } | null;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, session: EditorSession, state: OverlayState, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  const document = session.document;
  if (document) {
    if (session.tool === 'crop') drawCrop(ctx, session, width, height);
    else {
      const line = gradientLine(session);
      if (line) drawGradientLine(ctx, session, line);
      else drawTransformHandles(ctx, session);
    }
    drawSelection(ctx, session, state.antsPhase);
    drawLassoDraft(ctx, session);
    drawShapeDraft(ctx, session);
    drawSnapGuides(ctx, session);
  }
  if (state.brush) drawBrushCursor(ctx, state.brush);
  if (state.ring) drawSampleRing(ctx, state.ring);
}

function documentToView(session: EditorSession): { x: number; y: number; scale: number } {
  const document = session.document!;
  const origin = session.viewport.documentRect({ width: document.width, height: document.height });
  return { x: origin.x, y: origin.y, scale: session.viewport.pointsPerPixel };
}

function drawSnapGuides(ctx: CanvasRenderingContext2D, session: EditorSession) {
  const guides = session.snapGuides;
  if (!guides.xs.length && !guides.ys.length) return;
  const t = documentToView(session), document = session.document!;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of guides.xs) {
    ctx.moveTo(t.x + x * t.scale, t.y);
    ctx.lineTo(t.x + x * t.scale, t.y + document.height * t.scale);
  }
  for (const y of guides.ys) {
    ctx.moveTo(t.x, t.y + y * t.scale);
    ctx.lineTo(t.x + document.width * t.scale, t.y + y * t.scale);
  }
  ctx.stroke();
  ctx.restore();
}

/** Marching ants: a white line under an animated black dash. */
function drawSelection(ctx: CanvasRenderingContext2D, session: EditorSession, phase: number) {
  const selection = session.displayedSelection;
  if (!selection || selection.path.isEmpty) return;
  const t = documentToView(session);
  ctx.save();
  ctx.beginPath();
  for (const polygon of selection.path.polygons) {
    for (let i = 0; i < polygon.length; i += 2) {
      const x = t.x + polygon[i] * t.scale, y = t.y + polygon[i + 1] * t.scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -phase;
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.restore();
}

/** The shape being dragged, filled with the colour it will get and outlined so it reads on any background. */
function drawShapeDraft(ctx: CanvasRenderingContext2D, session: EditorSession) {
  const draft = session.shapeDraft;
  if (!draft || draft.rect.width <= 0 || draft.rect.height <= 0) return;
  const t = documentToView(session);
  const x = t.x + draft.rect.x * t.scale, y = t.y + draft.rect.y * t.scale;
  const w = draft.rect.width * t.scale, h = draft.rect.height * t.scale;
  ctx.save();
  ctx.beginPath();
  if (draft.kind === 'Ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.roundRect(x, y, w, h, Math.min(draft.cornerRadius * t.scale, w / 2, h / 2));
  ctx.fillStyle = cssColor(session.foregroundColor);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawLassoDraft(ctx: CanvasRenderingContext2D, session: EditorSession) {
  const draft = session.lassoDraft;
  if (!draft) return;
  const t = documentToView(session);
  const points = draft.points.map((p) => ({ x: t.x + p.x * t.scale, y: t.y + p.y * t.scale }));
  if (draft.kind === 'Polygonal' && draft.cursor) points.push({ x: t.x + draft.cursor.x * t.scale, y: t.y + draft.cursor.y * t.scale });
  if (!points.length) return;
  ctx.save();
  ctx.beginPath();
  if (draft.kind === 'Ellipse' && points.length === 4) {
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
  } else {
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (draft.kind === 'Rectangle') ctx.closePath();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (draft.kind === 'Polygonal') {
    // The first corner: click it to close the outline.
    const first = points[0];
    ctx.fillStyle = '#fff';
    ctx.fillRect(first.x - 4, first.y - 4, 8, 8);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(first.x - 4, first.y - 4, 8, 8);
  }
  ctx.restore();
}

function drawTransformHandles(ctx: CanvasRenderingContext2D, session: EditorSession) {
  const geometry = transformGeometry(session);
  if (!geometry) return;
  const h = geometry.handles;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(h[0].x, h[0].y);
  for (const index of [2, 4, 6]) ctx.lineTo(h[index].x, h[index].y);
  ctx.closePath();
  if (geometry.showsRotation) {
    ctx.moveTo(h[1].x, h[1].y);
    ctx.lineTo(geometry.rotationHandle.x, geometry.rotationHandle.y);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const p of h) {
    ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
    ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
  }
  if (geometry.showsRotation) {
    const p = geometry.rotationHandle;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawGradientLine(ctx: CanvasRenderingContext2D, session: EditorSession, line: { start: Point; end: Point }) {
  ctx.save();
  if (session.gradientSettings.shape === 'Radial') {
    // Faint rim where the radial gradient reaches its end colour.
    const radius = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(line.start.x, line.start.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.moveTo(line.start.x, line.start.y);
  ctx.lineTo(line.end.x, line.end.y);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();
  const colors = session.gradientColors(false);
  for (const [point, color] of [[line.start, colors[0]], [line.end, colors[1]]] as [Point, number[]][]) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    // A checkerboard grey shows through transparent ends.
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#bfbfbf';
    ctx.fill();
    ctx.fillStyle = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3]})`;
    ctx.fill();
  }
  ctx.restore();
}

function drawCrop(ctx: CanvasRenderingContext2D, session: EditorSession, width: number, height: number) {
  const rect = cropViewRect(session);
  if (!rect) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fill('evenodd');
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  for (const fraction of [1 / 3, 2 / 3]) {
    ctx.moveTo(rect.x + rect.width * fraction, rect.y);
    ctx.lineTo(rect.x + rect.width * fraction, rect.y + rect.height);
    ctx.moveTo(rect.x, rect.y + rect.height * fraction);
    ctx.lineTo(rect.x + rect.width, rect.y + rect.height * fraction);
  }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  for (const p of cropHandles(rect)) {
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
    ctx.strokeRect(p.x - 4, p.y - 4, 8, 8);
  }
  ctx.restore();
}

function drawBrushCursor(ctx: CanvasRenderingContext2D, brush: BrushCursorState) {
  const { point, diameter } = brush;
  const r = diameter / 2;
  ctx.save();
  if (brush.preview) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = brush.previewOpacity;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(brush.preview, point.x - r, point.y - r, diameter, diameter);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (brush.hardness !== null && brush.hardness > 0) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, r * brush.hardness, 0, Math.PI * 2);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (brush.sample) {
    const m = brush.sample, reach = 7;
    ctx.beginPath();
    ctx.moveTo(m.x - reach, m.y);
    ctx.lineTo(m.x + reach, m.y);
    ctx.moveTo(m.x, m.y - reach);
    ctx.lineTo(m.x, m.y + reach);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

/** The new sample above, the colour before the drag below. */
function drawSampleRing(ctx: CanvasRenderingContext2D, ring: { point: Point; original: PaletteColor; sampled: PaletteColor }) {
  const { x, y } = ring.point;
  const radius = 58 - 15;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgb(115,115,115)';
  ctx.lineWidth = 24;
  ctx.stroke();
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(x, y, radius, Math.PI, Math.PI * 2);
  ctx.strokeStyle = cssColor(ring.sampled);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI);
  ctx.strokeStyle = cssColor(ring.original);
  ctx.stroke();
  ctx.restore();
}
