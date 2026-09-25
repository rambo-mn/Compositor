// The pixel kernels a worker can run, with their inputs and outputs. Pure functions of plain data, so the same
// code runs in a worker or (in tests) directly.
import { gaussianBlur, motionBlur } from '../raster/kernels/blur';
import {
  noiseAdd, lensDistort, levelsApply, colorCubeApply, gradientMapApply, grainApply, invertRGBA, invertGray,
  levelsHistogram, blendThroughCoverage, clampPremultiplied,
} from '../raster/kernels/adjust';
import { contentFill } from '../raster/kernels/contentFill';
import { spotHeal } from '../raster/kernels/heal';
import { wandMask, wandTrace } from '../raster/kernels/wand';

export interface TaskPayloads {
  gaussianBlur: { data: Uint8Array; width: number; height: number; channels: number; sigma: number; clampEdges: boolean };
  motionBlur: { data: Uint8Array; width: number; height: number; sigma: number; angle: number };
  addNoise: { data: Uint8Array; width: number; height: number; amount: number; gaussian: boolean; monochromatic: boolean; seed: number };
  lens: { data: Uint8Array; width: number; height: number; k: number };
  tables: { data: Uint8Array; tables: Float32Array };
  cube: { data: Uint8Array; cube: Float32Array; dimension: number };
  gradientMap: { data: Uint8Array; width: number; height: number; table: Uint8Array };
  grain: { data: Uint8Array; width: number; height: number; amount: number; size: number; roughness: number; seed: number;
    originX: number; originY: number; unitsPerPixel: number };
  invert: { data: Uint8Array; channels: number };
  /** Blends `adjusted` over `original` through `coverage` (a selection on the image's grid). */
  blend: { adjusted: Uint8Array; original: Uint8Array; coverage: Uint8Array; channels: number };
  contentFill: { data: Uint8Array; mask: Uint8Array; width: number; height: number };
  heal: { data: Uint8Array; coverage: Uint8Array; width: number; height: number; opacity: number; mode: number; seed: number };
  wand: { data: Uint8Array; width: number; height: number; x: number; y: number; radius: number; tolerance: number; contiguous: boolean };
  histogram: { data: Uint8Array; coverage: Uint8Array | null };
  trace: { mask: Uint8Array; width: number; height: number };
}

export interface TaskResults {
  gaussianBlur: Uint8Array;
  motionBlur: Uint8Array;
  addNoise: Uint8Array;
  lens: Uint8Array;
  tables: Uint8Array;
  cube: Uint8Array;
  gradientMap: Uint8Array;
  grain: Uint8Array;
  invert: Uint8Array;
  blend: Uint8Array;
  contentFill: { data: Uint8Array; ok: boolean };
  heal: Uint8Array;
  /** Outline loops, or null when nothing matched. */
  wand: Float64Array[] | null;
  histogram: Float64Array;
  trace: Float64Array[];
}

export type TaskName = keyof TaskPayloads;

/** Runs a task; returns the result and the buffers to transfer back. */
export function runTask<T extends TaskName>(task: T, payload: TaskPayloads[T]): { result: TaskResults[T]; transfer: Transferable[] } {
  const p = payload as never as Record<string, unknown>;
  const done = <R>(result: R, transfer: Transferable[] = []) => ({ result: result as never as TaskResults[T], transfer });
  switch (task) {
    case 'gaussianBlur': {
      const { data, width, height, channels, sigma, clampEdges } = p as TaskPayloads['gaussianBlur'];
      const out = gaussianBlur(data, width, height, channels, sigma, clampEdges);
      return done(out, [out.buffer]);
    }
    case 'motionBlur': {
      const { data, width, height, sigma, angle } = p as TaskPayloads['motionBlur'];
      const out = motionBlur(data, width, height, sigma, angle);
      return done(out, [out.buffer]);
    }
    case 'addNoise': {
      const { data, width, height, amount, gaussian, monochromatic, seed } = p as TaskPayloads['addNoise'];
      noiseAdd(data, width, height, amount, gaussian, monochromatic, seed);
      return done(data, [data.buffer]);
    }
    case 'lens': {
      const { data, width, height, k } = p as TaskPayloads['lens'];
      const out = lensDistort(data, width, height, k);
      return done(out, [out.buffer]);
    }
    case 'tables': {
      const { data, tables } = p as TaskPayloads['tables'];
      levelsApply(data, data.length / 4, tables);
      return done(data, [data.buffer]);
    }
    case 'cube': {
      const { data, cube, dimension } = p as TaskPayloads['cube'];
      colorCubeApply(data, cube, dimension);
      return done(data, [data.buffer]);
    }
    case 'gradientMap': {
      const { data, width, height, table } = p as TaskPayloads['gradientMap'];
      gradientMapApply(data, width, height, table);
      return done(data, [data.buffer]);
    }
    case 'grain': {
      const g = p as TaskPayloads['grain'];
      grainApply(g.data, g.width, g.height, g.amount, g.size, g.roughness, g.seed, g.originX, g.originY, g.unitsPerPixel);
      return done(g.data, [g.data.buffer]);
    }
    case 'invert': {
      const { data, channels } = p as TaskPayloads['invert'];
      if (channels === 4) invertRGBA(data); else invertGray(data);
      return done(data, [data.buffer]);
    }
    case 'blend': {
      const { adjusted, original, coverage, channels } = p as TaskPayloads['blend'];
      const out = blendThroughCoverage(adjusted, original, coverage, channels);
      if (channels === 4) clampPremultiplied(out);
      return done(out, [out.buffer]);
    }
    case 'contentFill': {
      const { data, mask, width, height } = p as TaskPayloads['contentFill'];
      const ok = contentFill(data, mask, width, height);
      return done({ data, ok }, [data.buffer]);
    }
    case 'heal': {
      const h = p as TaskPayloads['heal'];
      spotHeal(h.data, h.coverage, h.width, h.height, h.opacity, h.mode, h.seed);
      return done(h.data, [h.data.buffer]);
    }
    case 'wand': {
      const w = p as TaskPayloads['wand'];
      const mask = new Uint8Array(w.width * w.height);
      const count = wandMask(w.data, w.width, w.height, w.x, w.y, w.radius, w.tolerance, w.contiguous, mask);
      if (!count) return done(null);
      const loops = wandTrace(mask, w.width, w.height);
      return done(loops, loops.map((l) => l.buffer));
    }
    case 'histogram': {
      const { data, coverage } = p as TaskPayloads['histogram'];
      const bins = new Float64Array(1024);
      levelsHistogram(data, coverage, data.length / 4, bins);
      return done(bins, [bins.buffer]);
    }
    case 'trace': {
      const { mask, width, height } = p as TaskPayloads['trace'];
      const loops = wandTrace(mask, width, height);
      return done(loops, loops.map((l) => l.buffer));
    }
  }
  throw new Error(`Unknown task ${String(task)}`);
}
