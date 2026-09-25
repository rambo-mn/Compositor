// Remove Background's subject mask, from a segmentation model run with ONNX Runtime (implemented in segmentation
// support; see model.ts).
import type { Raster } from '../raster/raster';

/** White over the subject, black over the background, the size of `image`: one byte per pixel. */
export async function segmentSubject(image: Raster): Promise<Uint8Array> {
  const { runSegmentation } = await import('./model');
  return runSegmentation(image);
}
