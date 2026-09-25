// The canvas on screen: the document composited for the current viewport and drawn over the checkerboard. Below
// 200% layers are drawn straight at screen resolution; from 200% the visible document pixels are composited at
// 1:1 and enlarged without smoothing, so each document pixel is a crisp square (EditorCanvas.draw). The pixel grid
// appears from 800%.
import { GLContext, Target } from './context';
import { Compositor, Scene } from './compositor';
import { PRESENT_FRAGMENT } from './shaders';
import type { CanvasViewport } from '../model/viewport';

export const CRISP_ZOOM = 2;
export const PIXEL_GRID_ZOOM = 8;

export interface PresentOptions {
  pixelGrid: boolean;
  /** The document area to show (document pixels); the whole canvas unless the crop frame reaches past it. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  ctx: GLContext;
  compositor: Compositor;
  private docTarget: Target | null = null;
  lost = false;
  onRestored: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = new GLContext(canvas);
    this.compositor = new Compositor(this.ctx);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.ctx = new GLContext(canvas);
      this.compositor = new Compositor(this.ctx);
      this.docTarget = null;
      this.lost = false;
      this.onRestored?.();
    });
  }

  /** Draws `scene` as `viewport` shows it (nothing but the background without a scene). */
  render(scene: Scene | null, viewport: CanvasViewport, options: PresentOptions): void {
    if (this.lost) return;
    const dpr = viewport.backingScale;
    const deviceWidth = Math.max(1, Math.round(viewport.viewWidth * dpr));
    const deviceHeight = Math.max(1, Math.round(viewport.viewHeight * dpr));
    if (this.canvas.width !== deviceWidth || this.canvas.height !== deviceHeight) {
      this.canvas.width = deviceWidth;
      this.canvas.height = deviceHeight;
    }
    const ctx = this.ctx, gl = ctx.gl;
    const program = ctx.program('present', PRESENT_FRAGMENT);
    if (!scene) {
      ctx.use(program, null, deviceWidth, deviceHeight, true);
      this.presentUniforms(program, deviceWidth, deviceHeight, null, null, null, false, dpr, false, 1);
      ctx.drawRect(0, 0, deviceWidth, deviceHeight);
      return;
    }
    const size = { width: scene.width, height: scene.height };
    const bounds = options.bounds ?? { x: 0, y: 0, width: size.width, height: size.height };
    const rect = viewport.documentRect(size);
    const zoom = viewport.zoom;
    // Device pixels: where document pixel (0, 0) lands, and the area shown (the checkerboard and layers).
    const origin = { x: rect.x * dpr, y: rect.y * dpr };
    const canvasRect = { x: origin.x + bounds.x * zoom, y: origin.y + bounds.y * zoom, width: bounds.width * zoom, height: bounds.height * zoom };
    const visible = {
      x: Math.max(0, Math.floor(canvasRect.x)), y: Math.max(0, Math.floor(canvasRect.y)),
      x1: Math.min(deviceWidth, Math.ceil(canvasRect.x + canvasRect.width)), y1: Math.min(deviceHeight, Math.ceil(canvasRect.y + canvasRect.height)),
    };
    let docRect: { x: number; y: number; width: number; height: number } | null = null;
    let nearest = false;
    if (visible.x1 > visible.x && visible.y1 > visible.y) {
      if (zoom >= CRISP_ZOOM) {
        // The document pixels on screen, composited 1:1.
        const x0 = Math.max(bounds.x, Math.floor((visible.x - origin.x) / zoom));
        const y0 = Math.max(bounds.y, Math.floor((visible.y - origin.y) / zoom));
        const x1 = Math.min(bounds.x + bounds.width, Math.ceil((visible.x1 - origin.x) / zoom));
        const y1 = Math.min(bounds.y + bounds.height, Math.ceil((visible.y1 - origin.y) / zoom));
        const target = this.targetOfSize(x1 - x0, y1 - y0);
        this.compositor.render(scene, target, { a: 1, b: 0, c: 0, d: 1, tx: -x0, ty: -y0 });
        docRect = { x: origin.x + x0 * zoom, y: origin.y + y0 * zoom, width: (x1 - x0) * zoom, height: (y1 - y0) * zoom };
        nearest = true;
      } else {
        const width = visible.x1 - visible.x, height = visible.y1 - visible.y;
        const target = this.targetOfSize(width, height);
        this.compositor.render(scene, target, { a: zoom, b: 0, c: 0, d: zoom, tx: origin.x - visible.x, ty: origin.y - visible.y });
        docRect = { x: visible.x, y: visible.y, width, height };
      }
    }
    ctx.use(program, null, deviceWidth, deviceHeight, true);
    gl.disable(gl.BLEND);
    this.presentUniforms(program, deviceWidth, deviceHeight, canvasRect, docRect, this.docTarget, nearest, dpr,
      options.pixelGrid && zoom >= PIXEL_GRID_ZOOM, zoom);
    ctx.drawRect(0, 0, deviceWidth, deviceHeight);
  }

  private targetOfSize(width: number, height: number): Target {
    const w = Math.max(1, width), h = Math.max(1, height);
    if (!this.docTarget || this.docTarget.width !== w || this.docTarget.height !== h) {
      if (this.docTarget) this.ctx.destroyTarget(this.docTarget);
      this.docTarget = this.ctx.createTarget(w, h);
      const gl = this.ctx.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.docTarget.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    return this.docTarget;
  }

  private presentUniforms(program: WebGLProgram, width: number, height: number,
                          canvasRect: { x: number; y: number; width: number; height: number } | null,
                          docRect: { x: number; y: number; width: number; height: number } | null, doc: Target | null,
                          nearest: boolean, dpr: number, grid: boolean, zoom: number): void {
    const ctx = this.ctx, gl = ctx.gl;
    const u = (name: string) => ctx.uniform(program, name);
    gl.uniform2f(u('u_screenSize'), width, height);
    const c = canvasRect ?? { x: -10, y: -10, width: 0, height: 0 };
    gl.uniform4f(u('u_canvas'), c.x, c.y, c.width, c.height);
    const hasDoc = !!(doc && docRect);
    gl.uniform1i(u('u_hasDoc'), hasDoc ? 1 : 0);
    ctx.bindTexture(0, doc ? doc.texture : null);
    gl.uniform1i(u('u_doc'), 0);
    if (hasDoc) {
      gl.uniform4f(u('u_docRect'), docRect!.x, docRect!.y, docRect!.width, docRect!.height);
      gl.uniform2f(u('u_docSize'), doc!.width, doc!.height);
    }
    gl.uniform1i(u('u_nearest'), nearest ? 1 : 0);
    gl.uniform1f(u('u_checker'), 10 * dpr);
    gl.uniform1f(u('u_dpr'), dpr);
    gl.uniform1i(u('u_grid'), grid ? 1 : 0);
    gl.uniform1f(u('u_devicePerPixel'), zoom);
    gl.uniform4f(u('u_background'), 0.105, 0.105, 0.105, 1);
  }

  /** The composite of `scene`'s region `rect` at 1:1, premultiplied RGBA rows top to bottom. */
  readRegion(scene: Scene, rect: { x: number; y: number; width: number; height: number }): Uint8Array {
    return this.compositor.renderRegion(scene, rect);
  }
}
