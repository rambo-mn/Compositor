// Raster coverage turned into a selection outline along exact pixel edges (MaskTracing.swift): a mask's dark
// (< 50% gray) pixels, or an image's at-least-50%-opaque pixels. Reuses the Magic Wand's boundary walker.
import { Raster } from '../raster';
import { wandTrace } from './wand';

/** Loops around a mask's pixels darker than 50% gray. */
export function traceDarkPixels(mask: Raster): Float64Array[] {
  const data = mask.toData();
  const selected = new Uint8Array(mask.width * mask.height);
  for (let i = 0; i < selected.length; i++) selected[i] = data[i] < 128 ? 1 : 0;
  return wandTrace(selected, mask.width, mask.height);
}

/** Loops around an image's pixels that are at least 50% opaque. */
export function traceOpaquePixels(image: Raster): Float64Array[] {
  const data = image.toData();
  const selected = new Uint8Array(image.width * image.height);
  for (let i = 0; i < selected.length; i++) selected[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  return wandTrace(selected, image.width, image.height);
}
