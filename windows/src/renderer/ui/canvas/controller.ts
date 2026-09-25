// The canvas's input handling, a port of CanvasView (EditorCanvas.swift): every tool's presses and drags, the
// pointer for each tool and modifier, panning and zooming, and the canvas's keys. Command on the Mac is Ctrl here
// and Option is Alt, as in Photoshop for Windows; the Mac's Control (drag without snapping) is Ctrl pressed during
// a drag. It draws the document with the WebGL compositor and the handles, ants and brush circle on a 2D overlay.
import type { EditorSession } from '../../session';
import type { GPU } from '../../gpu/service';
import type { Point } from '../../model/geometry';
import type { PaletteColor } from '../../model/color';
import { isBrushTool, isSelectionTool } from '../../model/settings';
import { renderLayers, effectiveVisibleIDs } from '../../model/document';
import { SNAP_DISTANCE, TransformDrag, dragCorners, dragUpdated, roundedTransform, transformContains, DragMode } from '../../model/transform';
import { CropDrag, CropDragMode, CropSnap, cropDragUpdated, cropSnapApply, cropValid } from '../../model/crop';
import { selectionsEqual, type SelectionMode } from '../../model/selection';
import { pickerColor } from '../../session/palette';
import { displayScene, imageOn, liveScene } from '../../session/scene';
import { singleLayerScene } from '../../session/selection';
import { falloff } from '../../raster/brush';
import { unpremultiply } from '../../raster/raster';
import { CURSORS, CROP_CURSORS, clippingCursor, resizeCursor, selectionCursor, wandCursor, type SelectionIcon } from './cursors';
import { cropResizeRegions, hitTransform, rectContains, transformGeometry } from './geometry';
import { drawOverlay, type BrushCursorState, type OverlayState } from './overlay';

export { clippingCursor };

interface Flags { shift: boolean; alt: boolean; ctrl: boolean }
const flagsOf = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey?: boolean }): Flags =>
  ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || !!e.metaKey });

/** Shift keeps a gradient line to 45° steps. */
function snapped45(point: Point, anchor: Point): Point {
  const dx = point.x - anchor.x, dy = point.y - anchor.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length };
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export class CanvasController {
  readonly session: EditorSession;
  private readonly gpu: GPU | null;
  private host: HTMLElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private overlayContext: CanvasRenderingContext2D | null = null;
  private frameRequest = 0;
  private sceneDirty = true;
  private unsubscribe: (() => void) | null = null;
  private lastFocusRequest = 0;
  private resizeObserver: ResizeObserver | null = null;
  private detachEvents: (() => void) | null = null;

  // Keys held.
  private spaceHeld = false;
  private altHeld = false;
  private shiftHeld = false;
  private ctrlHeld = false;
  /** Where the pointer is over the canvas (view coordinates), for the brush circle and cursor updates. */
  private pointer: Point | null = null;
  private hover: Point | null = null;
  private lastDragPoint: Point | null = null;
  private middlePan = false;
  private leftDown = false;
  private rightDown = false;
  private brushAxisAnchor: Point | null = null;
  private brushAxisHorizontal: boolean | null = null;
  private brushLastPixel: Point | null = null;
  private transformDrag: TransformDrag | null = null;
  private transformPressCtrl = false;
  private dragCursor: string | null = null;
  private cropDrag: CropDrag | null = null;
  private cropSnap: CropSnap | null = null;
  private hueTargetStart: Point | null = null;
  private samplingColor = false;
  private samplingOriginal: PaletteColor = { red: 0, green: 0, blue: 0 };
  private ring: OverlayState['ring'] = null;
  private gradientDrag: 'start' | 'end' | null = null;
  private selectionDragStart: Point | null = null;
  private pixelDragStart: Point | null = null;
  private duplicatesTransformOnDrag = false;
  private marqueeConstrainArmed = true;
  private marqueeDragPixel: Point | null = null;
  private autoscrollTimer = 0;
  private autoscrollPoint: Point | null = null;
  private zoomDrag: { start: Point; zoom: number; moved: boolean } | null = null;
  private brushTipDrag: { start: Point; diameter: number; hardness: number; hardnessShown: boolean } | null = null;
  private antsPhase = 0;
  private antsTimer = 0;
  private lastClick = { time: 0, x: 0, y: 0, count: 0 };
  private clonePreviewCache: { key: string; image: HTMLCanvasElement | null } | null = null;

  constructor(session: EditorSession, gpu: GPU | null) {
    this.session = session;
    this.gpu = gpu;
    this.lastFocusRequest = session.canvasFocusRequest;
  }

  // MARK: Mounting

  attach(host: HTMLElement, overlay: HTMLCanvasElement): void {
    this.host = host;
    this.overlay = overlay;
    this.overlayContext = overlay.getContext('2d');
    if (this.gpu) host.insertBefore(this.gpu.canvas, overlay);
    this.unsubscribe = this.session.subscribe(() => this.sessionChanged());
    this.resizeObserver = new ResizeObserver(() => this.syncGeometry());
    this.resizeObserver.observe(host);
    this.detachEvents = this.bindEvents(host);
    this.syncGeometry();
    this.sessionChanged();
  }

  detach(): void {
    this.resign();
    this.unsubscribe?.();
    this.resizeObserver?.disconnect();
    this.detachEvents?.();
    cancelAnimationFrame(this.frameRequest);
    clearInterval(this.antsTimer);
    clearInterval(this.autoscrollTimer);
    this.antsTimer = 0;
    if (this.gpu && this.gpu.canvas.parentElement === this.host) this.host?.removeChild(this.gpu.canvas);
    this.host = null;
    this.overlay = null;
  }

  private bindEvents(host: HTMLElement): () => void {
    const point = (e: MouseEvent): Point => {
      const box = host.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) {
        this.leftDown = true;
        host.setPointerCapture(e.pointerId);
        const now = performance.now(), p = point(e);
        const repeat = now - this.lastClick.time < 500 && Math.hypot(p.x - this.lastClick.x, p.y - this.lastClick.y) < 5;
        this.lastClick = { time: now, x: p.x, y: p.y, count: repeat ? this.lastClick.count + 1 : 1 };
        this.mouseDown(p, e, this.lastClick.count);
      } else if (e.button === 2) {
        if (this.rightMouseDown(point(e), e)) { this.rightDown = true; host.setPointerCapture(e.pointerId); }
      } else if (e.button === 1 && this.session.document) {
        // The middle button pans, as it does in most Windows image editors.
        e.preventDefault();
        this.middlePan = true;
        this.lastDragPoint = point(e);
        host.setPointerCapture(e.pointerId);
        this.refreshCursor();
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = point(e);
      this.hover = p;
      if (this.leftDown) {
        // Brushes and freehand outlines take every sample the pointer made, not one per frame.
        const events = (this.session.brushStroke || this.session.warpStroke || this.session.lassoDraft?.kind === 'Freehand')
          && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        if (events.length > 1) for (const sample of events) this.mouseDragged(point(sample), sample);
        else this.mouseDragged(p, e);
      } else if (this.rightDown) this.rightMouseDragged(p, e);
      else if (this.middlePan) this.pan(p);
      else this.mouseMoved(p, e);
    };
    const onUp = (e: PointerEvent) => {
      const p = point(e);
      if (e.button === 0 && this.leftDown) { this.leftDown = false; this.mouseUp(p, e); }
      else if (e.button === 2 && this.rightDown) { this.rightDown = false; this.rightMouseUp(p); }
      else if (e.button === 1 && this.middlePan) { this.middlePan = false; this.lastDragPoint = null; this.refreshCursor(); }
    };
    const onLost = (e: PointerEvent) => {
      // Capture lost mid-drag (the window lost focus): end the drag where it was.
      const p = this.hover ?? point(e);
      if (this.leftDown) { this.leftDown = false; this.mouseUp(p, e); }
      if (this.rightDown) { this.rightDown = false; this.rightMouseUp(p); }
      if (this.middlePan) { this.middlePan = false; this.lastDragPoint = null; }
    };
    const onLeave = () => {
      this.hover = null;
      if (this.leftDown || this.rightDown) return;
      this.pointer = null;
      this.requestOverlay();
    };
    const onEnter = (e: PointerEvent) => { this.hover = point(e); this.mouseMoved(point(e), e); };
    const onWheel = (e: WheelEvent) => this.scrollWheel(point(e), e);
    const onContext = (e: MouseEvent) => e.preventDefault();
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('lostpointercapture', onLost);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('pointerenter', onEnter);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('contextmenu', onContext);
    return () => {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('lostpointercapture', onLost);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('pointerenter', onEnter);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('contextmenu', onContext);
    };
  }

  /** The canvas's size and the display's scale, so 100% stays one document pixel per screen pixel. */
  private syncGeometry(): void {
    const host = this.host;
    if (!host) return;
    const width = host.clientWidth, height = host.clientHeight, scale = window.devicePixelRatio || 1;
    const viewport = this.session.viewport;
    if (viewport.viewWidth === width && viewport.viewHeight === height && viewport.backingScale === scale) return;
    const document = this.session.document;
    viewport.resize(width, height, scale, document ? { width: document.width, height: document.height } : null);
    this.session.viewportChanged();
  }

  // MARK: Drawing

  private sessionChanged(): void {
    const s = this.session;
    if (s.canvasFocusRequest !== this.lastFocusRequest) {
      this.lastFocusRequest = s.canvasFocusRequest;
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && !active.closest('.floating-panel, .sheet')) active.blur();
    }
    this.sceneDirty = true;
    this.updateAntsTimer();
    this.refreshCursor();
    this.requestFrame();
  }

  private requestFrame(): void {
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.draw();
    });
  }

  private requestOverlay(): void { this.requestFrame(); }

  private draw(): void {
    if (!this.host) return;
    // A display-scale change (dragging the window to another monitor) arrives without a resize.
    if ((window.devicePixelRatio || 1) !== this.session.viewport.backingScale) this.syncGeometry();
    const s = this.session;
    if (this.sceneDirty && this.gpu) {
      this.sceneDirty = false;
      const document = s.document;
      let bounds: { x: number; y: number; width: number; height: number } | undefined;
      if (document && s.tool === 'crop' && s.cropRect) {
        // The crop frame can reach past the canvas; what lies out there shows while cropping.
        const r = s.cropRect;
        const x0 = Math.min(0, r.x), y0 = Math.min(0, r.y);
        bounds = { x: x0, y: y0, width: Math.max(document.width, r.x + r.width) - x0, height: Math.max(document.height, r.y + r.height) - y0 };
      }
      try {
        this.gpu.view.render(document ? displayScene(s) : null, s.viewport, { pixelGrid: s.showsPixelGrid, bounds });
      } catch (error) {
        console.error('Canvas render failed', error);
      }
    }
    const overlay = this.overlay, ctx = this.overlayContext;
    if (!overlay || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = this.host.clientWidth, height = this.host.clientHeight;
    const deviceWidth = Math.max(1, Math.round(width * dpr)), deviceHeight = Math.max(1, Math.round(height * dpr));
    if (overlay.width !== deviceWidth || overlay.height !== deviceHeight) {
      overlay.width = deviceWidth;
      overlay.height = deviceHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlay(ctx, s, { antsPhase: this.antsPhase, brush: this.brushState(), ring: this.ring }, width, height);
  }

  /** Marching ants animate only while a visible selection exists. */
  private updateAntsTimer(): void {
    const selection = this.session.displayedSelection;
    const active = !!selection && !selection.path.isEmpty && !!this.host;
    if (active && !this.antsTimer) {
      this.antsTimer = window.setInterval(() => {
        this.antsPhase = (this.antsPhase + 1) % 8;
        this.requestOverlay();
      }, 120);
    } else if (!active && this.antsTimer) {
      clearInterval(this.antsTimer);
      this.antsTimer = 0;
    }
  }

  // MARK: The brush circle

  private get palettePicking(): boolean {
    const s = this.session;
    return s.tool === 'eyedropper' || (this.altHeld && (s.tool === 'brush' || s.tool === 'spotHealing' || s.tool === 'gradient')
      && !s.brushStroke && this.gradientDrag === null);
  }

  private get picking(): boolean {
    const s = this.session;
    return this.palettePicking || !!s.colorPicker || s.hueSampleMode !== null || (s.levels?.sampleMode ?? null) !== null;
  }

  private brushState(): BrushCursorState | null {
    const s = this.session, document = s.document;
    const point = this.brushTipDrag?.start ?? this.pointer;
    if (!document || !point || !isBrushTool(s.tool) || this.spaceHeld || this.picking) return null;
    const settings = s.brushStroke?.settings ?? s.brushSettings;
    const diameter = settings.diameter;
    const size = { width: document.width, height: document.height };
    let sample: Point | null = null;
    let preview: HTMLCanvasElement | null = null;
    if (s.tool === 'cloneStamp') {
      const pixel = s.viewport.documentPoint(point, size);
      const source = s.cloneSamplePoint(pixel);
      if (source) sample = s.viewport.viewPoint(source, size);
      const offset = !s.brushStroke && !this.altHeld ? s.cloneStrokeOffset(pixel) : null;
      if (offset) preview = this.clonePreview({ x: pixel.x + offset.width, y: pixel.y + offset.height }, diameter);
    }
    return {
      point, diameter: Math.max(1, diameter * s.viewport.pointsPerPixel), sample, preview, previewOpacity: s.brushSettings.opacity,
      hardness: this.brushTipDrag?.hardnessShown ? s.brushSettings.hardness : null,
    };
  }

  /** What a Clone Stamp click would copy into the brush circle: the source around `center` (document pixels),
   *  rendered for just that area at screen resolution and shaped by the brush tip, reused until anything changes. */
  private clonePreview(center: Point, diameter: number): HTMLCanvasElement | null {
    const s = this.session, doc = s.document, gpu = this.gpu;
    if (!doc || !gpu || !(diameter > 0)) return null;
    const scale = s.viewport.pointsPerPixel * s.viewport.backingScale;
    const layer = s.activeLayer;
    const key = [center.x, center.y, diameter, scale, s.brushRevision, s.history.undoCount, s.cloneSettings.sampleAllLayers,
      s.activeLayerID, s.brushSettings.hardness, doc.id].join('|');
    if (this.clonePreviewCache?.key === key) return this.clonePreviewCache.image;
    const side = Math.min(1024, Math.max(1, Math.ceil(diameter * scale)));
    let image: HTMLCanvasElement | null = null;
    try {
      const scene = s.cloneSettings.sampleAllLayers ? liveScene(s, doc)
        : layer?.asset ? singleLayerScene(doc.width, doc.height, imageOn(layer.asset.image, s.displayedTransform(layer))) : null;
      if (scene) {
        const k = side / diameter;
        const pixels = gpu.renderMapped(scene, side, side, { a: k, b: 0, c: 0, d: k, tx: -(center.x - diameter / 2) * k, ty: -(center.y - diameter / 2) * k });
        unpremultiply(pixels);
        // Keep only what one click lays down, so soft brushes preview softly.
        const hardness = s.brushSettings.hardness;
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            const rho = Math.hypot((x + 0.5) / side * 2 - 1, (y + 0.5) / side * 2 - 1);
            const coverage = rho >= 1 ? 0 : hardness >= 1 || rho <= hardness ? 1 : falloff((rho - hardness) / (1 - hardness));
            const i = (y * side + x) * 4 + 3;
            pixels[i] = Math.round(pixels[i] * coverage);
          }
        }
        image = document.createElement('canvas');
        image.width = side;
        image.height = side;
        image.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.length), side, side), 0, 0);
      }
    } catch { image = null; }
    this.clonePreviewCache = { key, image };
    return image;
  }

  // MARK: Pointers

  private setCursor(cursor: string): void {
    if (this.host && this.host.style.cursor !== cursor) this.host.style.cursor = cursor;
  }

  /** Re-applies the cursor for wherever the pointer is. */
  refreshCursor(): void {
    if (!this.host) return;
    this.setCursor(this.cursorAt(this.hover, { shift: this.shiftHeld, alt: this.altHeld, ctrl: this.ctrlHeld }));
  }

  private cursorAt(point: Point | null, flags: Flags): string {
    const s = this.session;
    if (this.dragCursor) return this.dragCursor;
    if (this.lastDragPoint) return CURSORS.closedHand;
    if (!s.document) return CURSORS.arrow;
    if (this.picking) return CURSORS.eyedropper;
    if (s.hueTargeting) return CURSORS.resizeLeftRight;
    if (isSelectionTool(s.tool) && !this.spaceHeld) return this.lassoCursor(flags, point);
    // Clone Stamp with a source: the circle, its preview and the source cross stand in for the pointer.
    if (s.tool === 'cloneStamp' && s.cloneSource && !this.altHeld && !this.spaceHeld) return CURSORS.hidden;
    if (this.spaceHeld || s.tool === 'hand') return CURSORS.openHand;
    if (s.tool === 'move') return point ? this.transformCursor(point, flags) : CURSORS.arrow;
    if (s.tool === 'idle') return CURSORS.arrow;
    if (s.tool === 'zoom') return this.altHeld ? CURSORS.zoomOut : CURSORS.zoomIn;
    if (s.tool === 'crop' && point) {
      const region = cropResizeRegions(s).find((r) => rectContains(r.rect, point));
      if (region) return CROP_CURSORS[region.index];
    }
    return CURSORS.crosshair;
  }

  /** In New mode over the selection, the move-selection pointer; otherwise the badged crosshair. Over the selection,
   *  Ctrl shows the scissors (cut and move its pixels) and Ctrl-Alt the copy pointer. */
  private lassoCursor(flags: Flags, point: Point | null): string {
    const s = this.session;
    const mode = s.lassoCursorMode(flags.shift, flags.alt);
    if (this.selectionDragStart) return CURSORS.moveSelection;
    if (this.pixelDragStart) return s.pixelMove?.duplicate ? CURSORS.duplicate : CURSORS.movePixels;
    if ((flags.ctrl || mode === 'New') && point && s.document && s.canMoveSelection(this.documentPoint(point))) {
      return flags.ctrl ? (flags.alt ? CURSORS.duplicate : CURSORS.movePixels) : CURSORS.moveSelection;
    }
    if (s.tool === 'wand') return wandCursor(mode);
    const icon: SelectionIcon = s.tool === 'marquee'
      ? (s.marqueeKind === 'Ellipse' ? 'ellipseMarquee' : 'rectangleMarquee')
      : (s.lassoKind === 'Polygonal' ? 'polygonalLasso' : 'freehandLasso');
    return selectionCursor(icon, mode);
  }

  /** The Move tool's pointer: over anything a drag would move, Alt shows the copy pointer. */
  private transformCursor(point: Point, flags: Flags): string {
    const s = this.session;
    if (this.spaceHeld) return CURSORS.openHand;
    if (s.isProjectBusy || s.isImporting) return CURSORS.arrow;
    const geometry = transformGeometry(s);
    const hit = geometry ? hitTransform(geometry, point) : null;
    if (!hit || !geometry) {
      if (!this.transformPressLayer(this.documentPoint(point), flags.ctrl)) return CURSORS.arrow;
      return flags.alt ? CURSORS.duplicate : CURSORS.move;
    }
    switch (hit.kind) {
      case 'resize': return s.transformEdit?.corners || flags.ctrl ? CURSORS.distort : resizeCursor(geometry.handles, hit.index);
      case 'rotate': return CURSORS.rotation;
      case 'move': return flags.alt ? CURSORS.duplicate : CURSORS.move;
      case 'distort': return CURSORS.distort;
    }
  }

  private documentPoint(point: Point): Point {
    const document = this.session.document!;
    return this.session.viewport.documentPoint(point, { width: document.width, height: document.height });
  }

  private viewPoint(point: Point): Point {
    const document = this.session.document!;
    return this.session.viewport.viewPoint(point, { width: document.width, height: document.height });
  }

  /** The layer a press that misses the transform handles drags, and whether it was picked from under the pointer.
   *  Ctrl picks the layer under the pointer; otherwise the active layer, unless Auto Select finds another layer
   *  under a press outside it. A press on empty canvas still drags the active layer. */
  private transformPressLayer(pixel: Point, ctrl: boolean): { id: string; picked: boolean } | null {
    const s = this.session, document = s.document;
    if (!(s.canEditLayers || s.transformEdit) || !document) return null;
    const underPointer = renderLayers(document).slice().reverse().find((l) => l.asset && transformContains(l.transform, pixel))?.id ?? null;
    const visible = effectiveVisibleIDs(document);
    const layer = s.activeLayer;
    const active = layer && layer.asset && !layer.isGroup && visible.has(layer.id) ? layer : null;
    const picks = !s.transformEdit;
    if (ctrl && picks && underPointer) return { id: underPointer, picked: true };
    // Several layers selected, or a folder: a press inside their box drags them all, and so does one outside it
    // unless Auto Select finds a layer there.
    if (s.transformsAsGroup && s.activeLayerID) {
      const box = s.transformEdit?.draft ?? s.groupTransformBox;
      if ((box && transformContains(box, pixel)) || !(picks && s.transformAutoSelect) || !underPointer) return { id: s.activeLayerID, picked: false };
    }
    if (active && transformContains(s.editedTransform(active), pixel)) return { id: active.id, picked: false };
    if (picks && (s.transformAutoSelect || ctrl) && underPointer) return { id: underPointer, picked: true };
    return active ? { id: active.id, picked: false } : null;
  }

  // MARK: Mouse

  private mouseMoved(point: Point, e: MouseEvent): void {
    this.altHeld = e.altKey;
    this.shiftHeld = e.shiftKey;
    this.ctrlHeld = e.ctrlKey;
    const s = this.session;
    if (isSelectionTool(s.tool) && !this.picking) {
      // Keys may have changed while the app was in the background.
      s.updateHeldSelectionKeys(e.shiftKey, e.altKey);
      if (s.lassoDraft?.kind === 'Polygonal' && s.document) s.moveLassoCursor(this.documentPoint(point));
    }
    this.pointer = point;
    this.refreshCursor();
    this.requestOverlay();
  }

  private mouseDown(point: Point, e: PointerEvent, clickCount: number): void {
    this.altHeld = e.altKey;
    this.shiftHeld = e.shiftKey;
    this.ctrlHeld = e.ctrlKey;
    // A press on the canvas takes keyboard focus from any field.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !active.closest('.floating-panel')) active.blur();
    const s = this.session;
    if (!s.document || s.isProjectBusy || s.isImporting) return;
    const flags = flagsOf(e);
    if (s.levels && s.levels.sampleMode !== null && !this.spaceHeld) {
      s.sampleLevels(this.documentPoint(point));
      return;
    }
    if (s.levels && !this.spaceHeld && s.tool !== 'hand' && s.tool !== 'zoom') return;
    if (this.picking && !this.spaceHeld) {
      if (s.colorPicker || (this.palettePicking && s.hueSampleMode === null)) {
        this.samplingOriginal = s.colorPicker ? pickerColor(s.colorPicker) : s.foregroundColor;
        this.samplingColor = true;
        this.sampleColor(point);
      } else {
        s.sampleHueRange(this.documentPoint(point));
      }
      return;
    }
    if (s.hueTargeting && !this.spaceHeld) {
      if (s.beginHueTargeting(this.documentPoint(point))) {
        this.hueTargetStart = point;
        this.dragCursor = CURSORS.resizeLeftRight;
        this.refreshCursor();
      }
      return;
    }
    if (this.spaceHeld || s.tool === 'hand') {
      this.lastDragPoint = point;
      this.refreshCursor();
    } else if (isBrushTool(s.tool)) {
      const pixel = this.documentPoint(point);
      // Alt-click with Clone Stamp sets where it copies from (with the other brushes it samples a colour).
      if (s.tool === 'cloneStamp' && flags.alt) {
        s.setCloneSource(pixel);
        this.requestOverlay();
        this.refreshCursor();
        return;
      }
      this.pointer = point;
      // Shift paints a straight line on from where the last stroke ended, as in Photoshop.
      const from = flags.shift ? s.shiftLineStart() : null;
      if (from) {
        s.beginBrush(from);
        s.continueBrush(pixel);
      } else {
        s.beginBrush(pixel);
      }
      this.brushAxisAnchor = flags.shift ? pixel : null;
      this.brushAxisHorizontal = null;
      this.brushLastPixel = pixel;
    } else if (isSelectionTool(s.tool)) {
      this.lassoMouseDown(point, flags, clickCount);
      this.refreshCursor();
    } else if (s.tool === 'gradient') {
      this.beginGradientDrag(point);
    } else if (s.tool === 'shape') {
      s.beginShape(this.documentPoint(point));
    } else if (s.tool === 'crop') {
      this.beginCropDrag(point);
    } else if (s.tool === 'move') {
      this.beginTransformDrag(point, flags);
    } else if (s.tool === 'zoom') {
      this.zoomDrag = { start: point, zoom: s.viewport.zoom, moved: false };
    }
  }

  private mouseDragged(point: Point, e: MouseEvent): void {
    const s = this.session;
    const flags = flagsOf(e);
    this.hover = point;
    if (this.zoomDrag) {
      const drag = this.zoomDrag;
      const dx = point.x - drag.start.x;
      if (Math.abs(dx) >= 3) drag.moved = true;
      // Right zooms in, left out: doubling for every 100 points dragged.
      if (drag.moved) s.zoom(drag.zoom * 2 ** (dx / 100), drag.start);
      return;
    }
    if (this.samplingColor) { this.sampleColor(point); return; }
    if (this.hueTargetStart) {
      s.dragHueTargeting(point.x - this.hueTargetStart.x, flags.ctrl);
      return;
    }
    if (this.pixelDragStart && s.document) {
      const pixel = this.documentPoint(point);
      s.movePixels({ width: pixel.x - this.pixelDragStart.x, height: pixel.y - this.pixelDragStart.y });
      this.refreshCursor();
      return;
    }
    if (this.selectionDragStart) {
      this.dragSelection(point, flags.shift);
      this.updateAutoscroll(point);
      return;
    }
    const draft = s.lassoDraft;
    if (isSelectionTool(s.tool) && !this.lastDragPoint && draft && s.document) {
      const pixel = this.documentPoint(point);
      if (draft.kind === 'Freehand') s.extendLasso(pixel);
      else if (draft.kind === 'Polygonal') s.moveLassoCursor(pixel);
      else {
        this.dragMarqueeDraft(pixel, flags.shift);
        this.updateAutoscroll(point);
      }
      return;
    }
    if (s.shapeDraft && !this.lastDragPoint && s.document) {
      // Unlike the Marquee, Alt has no other job here, so it draws from the centre as in Photoshop.
      s.dragShape(this.documentPoint(point), flags.shift, flags.alt);
      return;
    }
    const edit = s.gradientEdit;
    if (this.gradientDrag && edit && s.document) {
      let pixel = this.documentPoint(point);
      if (flags.shift) pixel = snapped45(pixel, this.gradientDrag === 'start' ? edit.end : edit.start);
      s.moveGradient(this.gradientDrag === 'start' ? pixel : null, this.gradientDrag === 'end' ? pixel : null);
      return;
    }
    this.pointer = point;
    this.requestOverlay();
    if ((s.brushStroke || s.warpStroke) && !s.isProjectBusy && s.document) {
      s.continueBrush(this.lockedBrushPixel(this.documentPoint(point), flags.shift));
      return;
    }
    if (this.cropDrag && s.tool === 'crop' && !s.isProjectBusy && s.document) {
      this.dragCrop(this.cropDrag, point, flags);
      return;
    }
    const drag = this.transformDrag;
    if (drag && s.document) {
      const pixel = this.documentPoint(point);
      if (this.duplicatesTransformOnDrag) {
        this.duplicatesTransformOnDrag = false;
        s.beginDuplicateTransform();
      }
      const corners = dragCorners(drag, pixel, flags.shift);
      if (corners) {
        s.previewCorners(corners);
      } else {
        // Dragging, scaling and rotating land on whole pixels and whole degrees; typed values stay exact.
        let draft = roundedTransform(dragUpdated(drag, pixel, s.locksTransformRatio, flags.shift, flags.alt));
        // Moving snaps to the canvas and the other layers; Ctrl pressed during the drag moves freely.
        const freely = flags.ctrl && !this.transformPressCtrl;
        if (drag.mode.kind === 'move' && !freely) {
          const group = s.transformEdit?.group;
          const moving = group ? new Set(group.originals.keys()) : new Set(s.transformEdit ? [s.transformEdit.layerID] : []);
          draft = s.snappedMove(draft, moving, SNAP_DISTANCE / Math.max(s.viewport.pointsPerPixel, 0.0001));
        } else if (s.snapGuides.xs.length || s.snapGuides.ys.length) {
          s.snapGuides = { xs: [], ys: [] };
        }
        s.previewTransform(draft);
      }
      return;
    }
    if (this.lastDragPoint) this.pan(point);
  }

  private pan(point: Point): void {
    const last = this.lastDragPoint;
    if (!last) return;
    this.session.viewport.translate(point.x - last.x, point.y - last.y);
    this.session.viewportChanged();
    this.lastDragPoint = point;
  }

  /** Shift keeps a stroke straight, horizontal or vertical, from wherever it was pressed; letting go carries on
   *  freehand. The axis is settled by the first few pixels of movement, so it doesn't flip mid-line. */
  private lockedBrushPixel(pixel: Point, shift: boolean): Point {
    let result = pixel;
    if (shift) {
      const anchor = this.brushAxisAnchor ?? this.brushLastPixel ?? pixel;
      if (!this.brushAxisAnchor) { this.brushAxisAnchor = anchor; this.brushAxisHorizontal = null; }
      if (this.brushAxisHorizontal === null && Math.hypot(pixel.x - anchor.x, pixel.y - anchor.y) >= 3) {
        this.brushAxisHorizontal = Math.abs(pixel.x - anchor.x) >= Math.abs(pixel.y - anchor.y);
      }
      if (this.brushAxisHorizontal !== null) {
        result = this.brushAxisHorizontal ? { x: pixel.x, y: anchor.y } : { x: anchor.x, y: pixel.y };
      } else {
        result = anchor;
      }
    } else {
      this.brushAxisAnchor = null;
      this.brushAxisHorizontal = null;
    }
    this.brushLastPixel = result;
    return result;
  }

  private mouseUp(point: Point, e: MouseEvent): void {
    const s = this.session;
    this.stopAutoscroll();
    if (this.zoomDrag) {
      const drag = this.zoomDrag;
      this.zoomDrag = null;
      if (!drag.moved) s.zoom(s.viewport.zoom * (e.altKey ? 0.5 : 2), drag.start);
      return;
    }
    if (s.snapGuides.xs.length || s.snapGuides.ys.length) s.snapGuides = { xs: [], ys: [] };
    if (this.samplingColor) {
      this.samplingColor = false;
      this.ring = null;
      this.requestOverlay();
      return;
    }
    if ((s.brushStroke || s.warpStroke) && !s.isProjectBusy) {
      if (s.document) s.continueBrush(this.lockedBrushPixel(this.documentPoint(point), e.shiftKey));
      s.finishBrushImmediately();
    }
    if (this.gradientDrag) {
      this.gradientDrag = null;
      s.endGradientDrag();
    }
    if (s.shapeDraft) s.finishShape();
    if (this.hueTargetStart) {
      this.hueTargetStart = null;
      this.dragCursor = null;
      s.endHueTargeting();
    }
    if (this.pixelDragStart) {
      this.pixelDragStart = null;
      void s.finishPixelMove().then(() => this.refreshCursor());
    }
    if (this.selectionDragStart) {
      const start = this.selectionDragStart;
      this.selectionDragStart = null;
      const moved = !selectionsEqual(s.selectionMoveOrigin, s.selection);
      s.endSelectionMove();
      if (!moved && s.tool === 'wand') {
        // The wand's click inside the selection selects afresh from that pixel.
        void s.magicWand(start, 'New').then(() => this.refreshCursor());
      } else if (!moved) {
        // A click without a drag deselects, as anywhere else with the lasso.
        s.deselect();
      }
    }
    if (isSelectionTool(s.tool) && s.lassoDraft && s.lassoDraft.kind !== 'Polygonal') s.finishLasso();
    this.cropDrag = null;
    this.cropSnap = null;
    if (this.transformDrag) {
      this.duplicatesTransformOnDrag = false;
      this.transformDrag = null;
      if (s.transformEdit?.persistent === false) s.commitTransform();
    }
    this.lastDragPoint = null;
    this.dragCursor = null;
    this.refreshCursor();
  }

  /** Right-drag with a brush tool: left and right resize the brush from its size at the press, or with Shift change
   *  its hardness. The circle stays where the press was. */
  private rightMouseDown(point: Point, e: MouseEvent): boolean {
    const s = this.session;
    if (!isBrushTool(s.tool) || s.brushStroke || s.warpStroke || this.spaceHeld || !s.document) return false;
    this.brushTipDrag = { start: point, diameter: s.brushSettings.diameter, hardness: s.brushSettings.hardness, hardnessShown: e.shiftKey };
    this.pointer = point;
    this.requestOverlay();
    return true;
  }

  private rightMouseDragged(point: Point, e: MouseEvent): void {
    const drag = this.brushTipDrag;
    if (!drag) return;
    const s = this.session;
    drag.hardnessShown = e.shiftKey;
    const dx = point.x - drag.start.x;
    if (e.shiftKey) {
      // The full range across 200 points.
      s.brushSettings = { ...s.brushSettings, hardness: Math.min(1, Math.max(0, drag.hardness + dx / 200)), diameter: drag.diameter };
    } else {
      // The circle's edge follows the pointer: each point moved widens the radius by a point on screen.
      const perPixel = Math.max(0.0001, s.viewport.pointsPerPixel);
      s.brushSettings = { ...s.brushSettings, diameter: Math.min(2000, Math.max(1, Math.round(drag.diameter + 2 * dx / perPixel))), hardness: drag.hardness };
    }
    this.pointer = drag.start;
    this.requestOverlay();
  }

  private rightMouseUp(point: Point): void {
    if (!this.brushTipDrag) return;
    this.brushTipDrag = null;
    this.pointer = point;
    this.requestOverlay();
  }

  private scrollWheel(point: Point, e: WheelEvent): void {
    const s = this.session;
    if (this.transformDrag || this.cropDrag || s.brushStroke || s.warpStroke || !s.document) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.session.viewport.viewHeight : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    // Ctrl (or a touchpad pinch, which arrives as Ctrl) or Alt with the wheel zooms about the pointer; the wheel
    // alone scrolls, Shift sideways.
    if (e.ctrlKey || e.altKey) {
      s.zoom(s.viewport.zoom * Math.exp(-(dy || dx) * 0.0025), point);
    } else {
      s.viewport.translate(-dx, -dy);
      s.viewportChanged();
    }
  }

  // MARK: Keys

  /** Shift, Alt and Ctrl going down or up: the pointer, the lasso's mode and a drag's shape follow at once. */
  modifiersChanged(e: KeyboardEvent): void {
    this.altHeld = e.altKey;
    this.shiftHeld = e.shiftKey;
    this.ctrlHeld = e.ctrlKey;
    const s = this.session;
    // A Marquee drag reshapes as Shift goes down or up, without waiting for the pointer to move.
    const kind = s.lassoDraft?.kind;
    if (this.marqueeDragPixel && (kind === 'Rectangle' || kind === 'Ellipse')) this.dragMarqueeDraft(this.marqueeDragPixel, e.shiftKey);
    // So does a crop drag as Alt (symmetry) or Ctrl (no snapping) changes.
    if (this.cropDrag && s.tool === 'crop' && s.document && this.hover) this.dragCrop(this.cropDrag, this.hover, flagsOf(e));
    s.updateHeldSelectionKeys(e.shiftKey, e.altKey);
    this.refreshCursor();
    this.requestOverlay();
  }

  /** Keys for the canvas, wherever focus is but a text field. Returns whether the key was used. */
  keyDown(e: KeyboardEvent): boolean {
    const s = this.session;
    this.altHeld = e.altKey;
    this.shiftHeld = e.shiftKey;
    this.ctrlHeld = e.ctrlKey;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key;
    const erase = key === 'Backspace' || key === 'Delete';
    const arrow = ARROWS[key];
    if (erase && e.shiftKey && plain) {
      if (s.canContentAwareFill) s.beginFilter('Content-Aware Fill');
      return true;
    }
    const levels = s.levels;
    if (levels) {
      if (key === 'Escape') { s.cancelLevels(); return true; }
      if (key === 'Enter') { void s.commitLevels(); return true; }
      if (key.toLowerCase() === 'p' && e.altKey) { s.updateLevels(levels.settings, !levels.preview); return true; }
      if (key !== ' ') return false;
    }
    if (s.brushStroke || s.warpStroke) {
      if (key === 'Escape' && !s.isProjectBusy) { s.cancelBrush(); this.leftDown = false; }
      return true;
    }
    if (s.lassoDraft && (key === 'Escape' || key === 'Enter' || erase)) {
      if (key === 'Escape') s.cancelLasso();
      else if (key === 'Enter') s.finishLasso();
      else s.removeLastLassoPoint();
      this.refreshCursor();
      return true;
    }
    if (s.shapeDraft && key === 'Escape') { s.cancelShape(); return true; }
    if (s.gradientEdit && key === 'Escape') { this.gradientDrag = null; s.cancelGradient(); return true; }
    if (s.gradientEdit && key === 'Enter') { this.gradientDrag = null; void s.commitGradient(); return true; }
    if (s.tool === 'crop' && key === 'Escape') { this.cropDrag = null; s.cancelCrop(); return true; }
    if (s.tool === 'crop' && key === 'Enter') { this.cropDrag = null; void s.commitCrop(); return true; }
    if (key === 'Escape' && s.transformEdit) { this.transformDrag = null; s.cancelTransform(); return true; }
    if (key === 'Enter' && s.transformEdit) { this.transformDrag = null; s.commitTransform(); return true; }
    const hasSelection = !!s.selection && !s.selection.path.isEmpty;
    if (arrow && hasSelection && !s.lassoDraft && e.ctrlKey && !e.altKey) {
      // Ctrl-arrow moves the selected pixels in any tool; Shift for 10 px.
      const step = e.shiftKey ? 10 : 1;
      void s.nudgePixels(arrow[0] * step, arrow[1] * step);
      return true;
    }
    if (arrow && isSelectionTool(s.tool) && !s.lassoDraft && hasSelection && plain) {
      const step = e.shiftKey ? 10 : 1;
      s.nudgeSelection(arrow[0] * step, arrow[1] * step);
      return true;
    }
    if (arrow && s.tool === 'move' && plain) {
      const step = e.shiftKey ? 10 : 1;
      s.nudgeLayer(arrow[0] * step, arrow[1] * step);
      return true;
    }
    if (erase && plain) { s.deleteKeyPressed(); return true; }
    if (key === ' ') {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.refreshCursor();
        this.requestOverlay();
      }
      return true;
    }
    if (!plain) return false;
    return this.toolKey(e);
  }

  /** The tool and palette letters, digits for opacity and brackets for the brush (also used by the Layers panel). */
  toolKey(e: KeyboardEvent): boolean {
    const s = this.session;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case 'x': s.swapPaletteColors(); return true;
      case 'd': s.resetPaletteColors(); return true;
      case 'b': s.selectTool('brush'); s.brushMode = 'Paint'; return true;
      case 'e': s.selectTool('brush'); s.brushMode = 'Erase'; return true;
      case 'j': s.selectTool('spotHealing'); return true;
      case 's': s.selectTool('cloneStamp'); return true;
      case 'g': s.selectTool('gradient'); return true;
      case 'u':
        if (e.shiftKey && s.tool === 'shape') s.toggleShapeKind(); else s.selectTool('shape');
        return true;
      case 'i': s.selectTool('eyedropper'); return true;
      // M (Shift or not) chooses the Marquee; holding it doesn't flicker.
      case 'm': if (!e.repeat) s.pressMarqueeKey(); return true;
      case 'w': s.selectTool('wand'); return true;
      case 'l': if (!e.repeat) s.pressLassoKey(); return true;
      case 'a': s.selectTool('idle'); return true;
      case 'r': s.selectTool('blur'); return true;
      case 'c': s.selectTool('crop'); return true;
      case 'v': s.selectTool('move'); return true;
      case 'h': s.selectTool('hand'); return true;
      case 'z': s.selectTool('zoom'); return true;
    }
    if (/^[0-9]$/.test(key) && s.usesOpacityKeys) { s.typeOpacityDigit(Number(key)); return true; }
    if (isBrushTool(s.tool)) {
      // Shift turns [ and ] into { and } on US keyboards; the physical key is what counts.
      if (e.code === 'BracketLeft' || key === '[' || key === '{') {
        if (e.shiftKey) s.changeBrushHardness(false); else s.changeBrushSize(false);
        return true;
      }
      if (e.code === 'BracketRight' || key === ']' || key === '}') {
        if (e.shiftKey) s.changeBrushHardness(true); else s.changeBrushSize(true);
        return true;
      }
    }
    return false;
  }

  keyUp(e: KeyboardEvent): void {
    if (e.key === ' ' && this.spaceHeld) {
      this.spaceHeld = false;
      this.refreshCursor();
      this.requestOverlay();
    }
  }

  /** The window lost focus: keys held then are let go without us hearing. */
  windowBlurred(): void {
    this.spaceHeld = false;
    this.altHeld = false;
    this.shiftHeld = false;
    this.ctrlHeld = false;
    this.refreshCursor();
  }

  /** Focus moved into a text field: anything half-done on the canvas is dropped (resignFirstResponder). */
  resign(): void {
    const s = this.session;
    if (!s.isProjectBusy) s.cancelBrush();
    this.pointer = null;
    this.cropDrag = null;
    this.gradientDrag = null;
    s.cancelShape();
    if (s.lassoDraft && s.lassoDraft.kind !== 'Polygonal') s.cancelLasso();
    if (this.selectionDragStart) { this.selectionDragStart = null; s.endSelectionMove(); }
    if (this.pixelDragStart) { this.pixelDragStart = null; s.cancelPixelMove(); }
    const drag = this.transformDrag;
    if (drag) {
      this.duplicatesTransformOnDrag = false;
      s.previewTransform(drag.original);
      if (s.transformEdit?.persistent === false) s.cancelTransform();
      this.transformDrag = null;
    }
    this.spaceHeld = false;
    this.lastDragPoint = null;
    this.leftDown = false;
    this.dragCursor = null;
  }

  // MARK: Tools

  private sampleColor(point: Point): void {
    const s = this.session;
    if (!s.document) return;
    const pixel = this.documentPoint(point);
    if (s.colorPicker) s.sampleIntoColorPicker(pixel);
    else if (s.canEditPalette) {
      const color = s.sampleCompositeColor(pixel);
      if (color) s.foregroundColor = color;
    }
    const sampled = s.colorPicker ? pickerColor(s.colorPicker) : s.foregroundColor;
    this.ring = s.showsSampleRing ? { point, original: this.samplingOriginal, sampled } : null;
    this.requestOverlay();
  }

  /** Freehand starts an outline to drag. Polygonal adds a corner per click and closes on a click near the first
   *  corner or a double-click. Modifiers at the first click pick the mode: Shift adds, Alt subtracts. */
  private lassoMouseDown(point: Point, flags: Flags, clickCount: number): void {
    const s = this.session;
    if (!s.document) return;
    // A Shift held at the press means Add; for the Marquee it squares only once pressed afresh.
    this.marqueeConstrainArmed = !flags.shift;
    this.marqueeDragPixel = null;
    const pixel = this.documentPoint(point);
    const draft = s.lassoDraft;
    if (!draft || draft.kind !== 'Polygonal') {
      // Ctrl-drag inside the selection cuts and moves its pixels (Photoshop's temporary Move tool).
      if (flags.ctrl && s.canMoveSelection(pixel)) {
        if (s.beginPixelMove(flags.alt)) this.pixelDragStart = pixel;
        return;
      }
      const mode: SelectionMode = s.selectionMode(flags.shift, flags.alt);
      // In New mode, dragging inside the selection moves its outline instead of drawing.
      if (mode === 'New' && s.canMoveSelection(pixel) && s.beginSelectionMove()) {
        this.selectionDragStart = pixel;
        return;
      }
      if (s.tool === 'wand') {
        void s.magicWand(pixel, mode).then(() => this.refreshCursor());
        return;
      }
      s.beginLasso(pixel, mode);
      return;
    }
    const first = this.viewPoint(draft.points[0]);
    if (clickCount >= 2 || (draft.points.length >= 3 && Math.hypot(point.x - first.x, point.y - first.y) <= 8)) s.finishLasso();
    else s.extendLasso(pixel);
  }

  /** Reshapes the Marquee draft. Shift squares the box, except a Shift already held when the drag began (which chose
   *  Add) until it has been let go and pressed again, as in Photoshop. */
  private dragMarqueeDraft(pixel: Point, shift: boolean): void {
    if (!shift) this.marqueeConstrainArmed = true;
    this.marqueeDragPixel = pixel;
    this.session.dragMarquee(pixel, this.marqueeConstrainArmed && shift, false);
  }

  /** Moves a dragged selection so the pixel grabbed sits under `point`; Shift keeps it on one axis. */
  private dragSelection(point: Point, shift: boolean): void {
    const start = this.selectionDragStart;
    if (!start || !this.session.document) return;
    const pixel = this.documentPoint(point);
    let dx = pixel.x - start.x, dy = pixel.y - start.y;
    if (shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    this.session.moveSelection({ width: dx, height: dy });
  }

  /** While a Marquee (or a moved selection) is dragged against or past the canvas edge, pans toward the pointer. */
  private autoscrollDelta(point: Point): { x: number; y: number } {
    const width = this.host?.clientWidth ?? 0, height = this.host?.clientHeight ?? 0, margin = 12;
    const speed = (past: number) => (past <= 0 ? 0 : Math.min(40, 2 + past * 0.4));
    const left = speed(margin - point.x), right = speed(point.x - (width - margin));
    const top = speed(margin - point.y), bottom = speed(point.y - (height - margin));
    return { x: left - right, y: top - bottom };
  }

  private updateAutoscroll(point: Point): void {
    this.autoscrollPoint = point;
    const delta = this.autoscrollDelta(point);
    if (delta.x === 0 && delta.y === 0) { this.stopAutoscroll(); return; }
    if (this.autoscrollTimer) return;
    this.autoscrollTimer = window.setInterval(() => this.stepAutoscroll(), 1000 / 60);
  }

  private stepAutoscroll(): void {
    const s = this.session;
    const marquee = s.lassoDraft?.kind === 'Rectangle' || s.lassoDraft?.kind === 'Ellipse';
    const point = this.autoscrollPoint;
    if (!point || !s.document || !(marquee || this.selectionDragStart)) { this.stopAutoscroll(); return; }
    const delta = this.autoscrollDelta(point);
    if (delta.x === 0 && delta.y === 0) { this.stopAutoscroll(); return; }
    s.viewport.translate(delta.x, delta.y);
    s.viewportChanged();
    // The pointer hasn't moved, but the document has under it: the box's corner, or the moved selection, follows.
    if (this.selectionDragStart) this.dragSelection(point, this.shiftHeld);
    else this.dragMarqueeDraft(this.documentPoint(point), this.shiftHeld);
  }

  private stopAutoscroll(): void {
    clearInterval(this.autoscrollTimer);
    this.autoscrollTimer = 0;
    this.autoscrollPoint = null;
  }

  /** Grabs an existing endpoint, or starts a new line at the pointer. */
  private beginGradientDrag(point: Point): void {
    const s = this.session;
    if (!s.document) return;
    const edit = s.gradientEdit;
    if (edit && Math.hypot(edit.end.x - edit.start.x, edit.end.y - edit.start.y) >= 0.5) {
      const start = this.viewPoint(edit.start), end = this.viewPoint(edit.end);
      if (Math.hypot(point.x - end.x, point.y - end.y) <= 10) { this.gradientDrag = 'end'; return; }
      if (Math.hypot(point.x - start.x, point.y - start.y) <= 10) { this.gradientDrag = 'start'; return; }
    }
    s.beginGradient(this.documentPoint(point));
    this.gradientDrag = s.gradientEdit ? 'end' : null;
  }

  private beginCropDrag(point: Point): void {
    const s = this.session, document = s.document;
    if (!document) return;
    const pixel = this.documentPoint(point);
    const rect = s.visibleCropRect ?? { x: pixel.x, y: pixel.y, width: 0, height: 0 };
    const region = cropResizeRegions(s).find((r) => rectContains(r.rect, point));
    const whole = rect.x === 0 && rect.y === 0 && rect.width === document.width && rect.height === document.height;
    let mode: CropDragMode;
    if (region) mode = { kind: 'resize', index: region.index };
    else if (s.cropRect && rectContains(s.cropRect, pixel) && !whole) mode = { kind: 'move' };
    else { mode = { kind: 'create' }; s.cropRect = null; }
    this.cropDrag = { start: pixel, original: rect, mode };
    const targets = s.cropSnapTargets();
    this.cropSnap = { xs: targets.xs, ys: targets.ys, tolerance: 8 / Math.max(s.viewport.pointsPerPixel, 0.0001) };
    this.dragCursor = region ? CROP_CURSORS[region.index] : mode.kind === 'move' ? CURSORS.move : CURSORS.crosshair;
    this.refreshCursor();
  }

  /** Reshapes the crop frame: Alt keeps its centre fixed, and edges snap to nearby layer and canvas edges unless Ctrl
   *  is held. */
  private dragCrop(drag: CropDrag, point: Point, flags: Flags): void {
    const s = this.session;
    const pixel = this.documentPoint(point);
    let next = cropDragUpdated(drag, pixel, s.cropRatio, flags.alt);
    if (this.cropSnap && !flags.ctrl) next = cropSnapApply(this.cropSnap, next, drag, pixel, s.cropRatio, flags.alt);
    if (cropValid(next)) s.cropRect = next;
  }

  private beginTransformDrag(point: Point, flags: Flags): void {
    const s = this.session;
    if (!(s.canEditLayers || s.transformEdit) || !s.document) return;
    const pixel = this.documentPoint(point);
    const geometry = transformGeometry(s);
    let mode: DragMode | null = geometry ? hitTransform(geometry, point) : null;
    if (!mode) {
      const target = this.transformPressLayer(pixel, flags.ctrl);
      if (target) {
        if (target.picked) s.selectLayer(target.id);
        mode = { kind: 'move' };
      }
    }
    if (!mode) return;
    this.duplicatesTransformOnDrag = mode.kind === 'move' && flags.alt;
    if (!s.transformEdit) s.beginTransform(false);
    // Ctrl-dragging a handle distorts, as in Photoshop; once distorted, handles keep distorting.
    if (mode.kind === 'resize' && (flags.ctrl || s.transformEdit?.corners)) {
      s.beginDistort();
      if (s.transformEdit?.corners) mode = { kind: 'distort', index: mode.index };
    }
    const transform = s.transformEdit?.draft;
    if (!transform) return;
    this.transformDrag = { original: transform, start: pixel, mode, originalCorners: s.transformEdit?.corners ?? null };
    this.transformPressCtrl = flags.ctrl;
    switch (mode.kind) {
      case 'resize': this.dragCursor = geometry ? resizeCursor(geometry.handles, mode.index) : CURSORS.arrow; break;
      case 'rotate': this.dragCursor = CURSORS.rotation; break;
      case 'move': this.dragCursor = this.duplicatesTransformOnDrag ? CURSORS.duplicate : CURSORS.move; break;
      case 'distort': this.dragCursor = CURSORS.distort; break;
    }
    this.refreshCursor();
  }
}
