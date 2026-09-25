// Where the document sits in the canvas view. Document: pixels, top-left origin. View: CSS pixels. Zoom 1 shows
// one document pixel per screen (device) pixel, as the Mac app's does. A port of CanvasViewport.swift; the
// document's corner is kept on a whole device pixel so 100% is exactly sharp.
import type { Point, Rect, Size } from './geometry';

export const ZOOM_RANGE: [number, number] = [0.001, 32];

export class CanvasViewport {
  viewWidth = 0;
  viewHeight = 0;
  backingScale = 1;
  zoom = 1;
  panX = 0;
  panY = 0;
  followsFit = true;

  copy(): CanvasViewport {
    const v = new CanvasViewport();
    Object.assign(v, this);
    return v;
  }

  equals(other: CanvasViewport): boolean {
    return this.viewWidth === other.viewWidth && this.viewHeight === other.viewHeight && this.backingScale === other.backingScale
      && this.zoom === other.zoom && this.panX === other.panX && this.panY === other.panY && this.followsFit === other.followsFit;
  }

  /** View (CSS) pixels per document pixel. */
  get pointsPerPixel(): number { return this.zoom / this.backingScale; }

  get center(): Point { return { x: this.viewWidth / 2, y: this.viewHeight / 2 }; }

  documentRect(size: Size): Rect {
    const scale = this.pointsPerPixel;
    const width = size.width * scale, height = size.height * scale;
    const snap = (v: number) => Math.round(v * this.backingScale) / this.backingScale;
    return {
      x: snap(this.center.x - width / 2 + this.panX),
      y: snap(this.center.y - height / 2 + this.panY),
      width, height,
    };
  }

  documentPoint(point: Point, documentSize: Size): Point {
    const origin = this.documentRect(documentSize);
    return { x: (point.x - origin.x) / this.pointsPerPixel, y: (point.y - origin.y) / this.pointsPerPixel };
  }

  viewPoint(point: Point, documentSize: Size): Point {
    const origin = this.documentRect(documentSize);
    return { x: origin.x + point.x * this.pointsPerPixel, y: origin.y + point.y * this.pointsPerPixel };
  }

  fit(documentSize: Size): void {
    if (!(this.viewWidth > 0) || !(this.viewHeight > 0)) { this.followsFit = true; return; }
    this.zoom = clampZoom(Math.min(Math.max(1, this.viewWidth - 96) / documentSize.width,
      Math.max(1, this.viewHeight - 96) / documentSize.height) * this.backingScale);
    this.panX = 0;
    this.panY = 0;
    this.followsFit = true;
  }

  /** Keeps the centre document point when the view or display changes. */
  resize(width: number, height: number, backingScale: number, documentSize: Size | null): void {
    const oldScale = this.pointsPerPixel;
    this.viewWidth = width;
    this.viewHeight = height;
    this.backingScale = Math.max(1, backingScale);
    if (this.followsFit && documentSize) {
      this.fit(documentSize);
    } else {
      const ratio = this.pointsPerPixel / oldScale;
      this.panX *= ratio;
      this.panY *= ratio;
    }
  }

  setZoom(value: number, anchor: Point, documentSize: Size): void {
    if (!Number.isFinite(value)) return;
    const pixel = this.documentPoint(anchor, documentSize);
    this.zoom = clampZoom(value);
    const moved = this.viewPoint(pixel, documentSize);
    this.panX += anchor.x - moved.x;
    this.panY += anchor.y - moved.y;
    this.followsFit = false;
  }

  translate(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.followsFit = false;
  }
}

export function clampZoom(value: number): number { return Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], value)); }
