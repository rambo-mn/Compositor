// Remove Background's subject mask. The model's own mask is kept for each layer image while the panel is open, so
// moving a slider only redoes the refining (as the Mac's SubjectRemoval caches Vision's mask).
import type { Raster } from '../raster/raster';

const cache = new WeakMap<Raster, Promise<Uint8Array>>();

/** White over the subject, black over the background, the size of `image`: one byte per pixel. */
export function segmentSubject(image: Raster): Promise<Uint8Array> {
  let mask = cache.get(image);
  if (!mask) {
    mask = import('./model').then(({ runSegmentation }) => runSegmentation(image));
    cache.set(image, mask);
    // A failure isn't kept: the next try runs the model again.
    mask.catch(() => { if (cache.get(image) === mask) cache.delete(image); });
  }
  // Callers may change what they get; each has its own copy.
  return mask.then((m) => m.slice());
}
