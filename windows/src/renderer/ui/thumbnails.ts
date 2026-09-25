// Layers-panel thumbnails framed by the whole canvas, as Photoshop shows them (CanvasThumbnail.swift): a layer's
// pixels (or its mask) drawn where they sit on a canvas-shaped picture, whatever the layer's own bounds.
import type { GPU } from '../gpu/service';
import type { Raster } from '../raster/raster';
import type { LayerTransform } from '../model/transform';
import { pixelToDocument } from '../model/transform';

/** Pixels per CSS pixel in the pictures, so they stay sharp on high-DPI displays. */
export const BACKING = 2;

const canvases = new WeakMap<ImageData, HTMLCanvasElement>();
const tones = new WeakMap<ImageData, number>();

function thumbnail(gpu: GPU, raster: Raster): ImageData { return gpu.thumbnail(raster, 96); }

function asCanvas(data: ImageData): HTMLCanvasElement {
  let canvas = canvases.get(data);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    canvas.getContext('2d')!.putImageData(data, 0, 0);
    canvases.set(data, canvas);
  }
  return canvas;
}

/** The canvas's aspect ratio fitted inside a square slot `box` wide, in whole pixels. */
export function fittedSize(canvas: { width: number; height: number }, box: number): { width: number; height: number } {
  if (!(canvas.width > 0 && canvas.height > 0)) return { width: box, height: box };
  const scale = box / Math.max(canvas.width, canvas.height);
  return { width: Math.max(1, Math.round(canvas.width * scale)), height: Math.max(1, Math.round(canvas.height * scale)) };
}

/** The mean grey (0–1) of a mask thumbnail's outermost pixels: outside its layer a mask has no effect, so its edge
 *  tone carries on to the canvas edges (a reveal-all mask reads all white, a hide-all mask all black). */
function edgeTone(data: ImageData): number {
  const cached = tones.get(data);
  if (cached !== undefined) return cached;
  let total = 0, count = 0;
  for (let y = 0; y < data.height; y++) {
    const edgeRow = y === 0 || y === data.height - 1;
    for (let x = 0; x < data.width; x++) {
      if (!edgeRow && x !== 0 && x !== data.width - 1) continue;
      total += data.data[(y * data.width + x) * 4];
      count++;
    }
  }
  const tone = count ? total / count / 255 : 1;
  tones.set(data, tone);
  return tone;
}

/** Draws a layer's (or mask's) thumbnail into `target`, sized for a canvas `canvasSize` in a `box`-wide slot. */
export function drawCanvasThumbnail(target: HTMLCanvasElement, gpu: GPU | null, raster: Raster | null, transform: LayerTransform,
                                    canvasSize: { width: number; height: number }, box: number, mask: boolean): void {
  const size = fittedSize(canvasSize, box);
  const width = size.width * BACKING, height = size.height * BACKING;
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const data = gpu && raster ? safely(() => thumbnail(gpu, raster)) : null;
  if (mask) {
    const tone = data ? Math.round(edgeTone(data) * 255) : 255;
    ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = 'rgb(56,56,56)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgb(82,82,82)';
    const tile = 6 * BACKING;
    for (let row = 0; row * tile < height; row++) {
      for (let column = 0; column * tile < width; column++) {
        if ((row + column) % 2 === 0) ctx.fillRect(column * tile, row * tile, tile, tile);
      }
    }
  }
  if (!data) return;
  const source = asCanvas(data);
  const k = width / canvasSize.width;
  const m = pixelToDocument(transform, source.width, source.height);
  ctx.setTransform(m.a * k, m.b * k, m.c * k, m.d * k, m.tx * k, m.ty * k);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function safely<T>(run: () => T): T | null {
  try { return run(); } catch { return null; }
}
