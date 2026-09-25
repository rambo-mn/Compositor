// Remove Background's subject mask from a segmentation model (ISNet, "isnet-general-use") run with ONNX Runtime,
// on the GPU through WebGPU where the computer has it and on the processor otherwise. It stands in for Apple's
// Vision subject lifting, which the Mac app uses. The model is loaded once, when first needed; a copy of the app
// without it downloads it first (about 170 MB), which the filter panel shows.
import type { InferenceSession } from 'onnxruntime-web/webgpu';
import type { Raster } from '../raster/raster';
import { unpremultiply } from '../raster/raster';
import { Observable } from '../session/observable';

const MODEL_NAME = 'isnet-general-use.onnx';
/** The model's square input. */
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];

export class NoSubjectError extends Error {
  constructor() { super('No foreground subject was detected in this layer. Try an image with a more distinct subject.'); }
}

/** What the model is doing, for the filter panel: fetching it, loading it, or running it. */
class ModelState extends Observable {
  phase: 'idle' | 'downloading' | 'loading' | 'running' = 'idle';
  received = 0;
  total = 0;
  set(phase: ModelState['phase'], received = 0, total = 0): void {
    this.phase = phase;
    this.received = received;
    this.total = total;
    this.changed();
  }
}
export const modelState = new ModelState();

type ORT = typeof import('onnxruntime-web/webgpu');
let runtime: Promise<{ ort: ORT; session: InferenceSession }> | null = null;

async function ensureModel(): Promise<string> {
  const bridge = window.compositor;
  if (!bridge) throw new Error('Remove Background needs the Compositor desktop app.');
  const status = await bridge.modelStatus();
  if (!status.available) {
    modelState.set('downloading', 0, status.size);
    const stop = bridge.onModelProgress(({ received, total }) => modelState.set('downloading', received, total));
    try { await bridge.downloadModel(); } finally { stop(); }
  }
  return new URL(`models/${MODEL_NAME}`, location.href).href;
}

function load(): Promise<{ ort: ORT; session: InferenceSession }> {
  runtime ??= (async () => {
    const url = await ensureModel();
    modelState.set('loading');
    const ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = new URL('ort/', location.href).href;
    // Threads need cross-origin isolation, which the app's pages have.
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1;
    const model = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const gpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
    let session: InferenceSession;
    try {
      session = await ort.InferenceSession.create(model, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' });
    } catch (error) {
      if (!gpu) throw error;
      session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
    return { ort, session };
  })();
  runtime.catch(() => { runtime = null; });
  return runtime;
}

/** Straight RGBA (alpha ignored) drawn at `width` × `height` with smoothing. */
function resized(rgba: Uint8ClampedArray, width: number, height: number, toWidth: number, toHeight: number): Uint8ClampedArray {
  const source = new OffscreenCanvas(width, height);
  source.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  const target = new OffscreenCanvas(toWidth, toHeight);
  const context = target.getContext('2d')!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, toWidth, toHeight);
  return context.getImageData(0, 0, toWidth, toHeight).data;
}

/** White over the subject, black over the background, the size of `image`: one byte per pixel. */
export async function runSegmentation(image: Raster): Promise<Uint8Array> {
  const { ort, session } = await load();
  modelState.set('running');
  try {
    const { width, height } = image;
    // The layer's colours as they are, opaque (the model reads RGB, as rembg gives it).
    const straight = image.toData();
    unpremultiply(straight);
    const rgba = new Uint8ClampedArray(straight.buffer as ArrayBuffer, straight.byteOffset, straight.length);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const small = resized(rgba, width, height, SIZE, SIZE);
    let peak = 1;
    for (let i = 0; i < small.length; i += 4) peak = Math.max(peak, small[i], small[i + 1], small[i + 2]);
    const plane = SIZE * SIZE;
    const input = new Float32Array(3 * plane);
    for (let p = 0; p < plane; p++) {
      for (let c = 0; c < 3; c++) input[c * plane + p] = small[p * 4 + c] / peak - MEAN[c];
    }
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
    const outputs = await session.run(feeds);
    const prediction = outputs[session.outputNames[0]].data as Float32Array;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < plane; i++) { lo = Math.min(lo, prediction[i]); hi = Math.max(hi, prediction[i]); }
    // A flat prediction found nothing to keep.
    if (!(hi - lo > 1e-4) || hi < 0.2) throw new NoSubjectError();
    const gray = new Uint8ClampedArray(plane * 4);
    for (let i = 0; i < plane; i++) {
      const v = Math.round((prediction[i] - lo) / (hi - lo) * 255);
      gray[i * 4] = gray[i * 4 + 1] = gray[i * 4 + 2] = v;
      gray[i * 4 + 3] = 255;
    }
    const full = resized(gray, SIZE, SIZE, width, height);
    const mask = new Uint8Array(width * height);
    let solid = false;
    for (let i = 0; i < mask.length; i++) {
      const v = full[i * 4];
      mask[i] = v;
      if (v > 127) solid = true;
    }
    if (!solid) throw new NoSubjectError();
    return mask;
  } finally {
    modelState.set('idle');
  }
}
