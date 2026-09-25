// Remove Background's segmentation model (ISNet, "isnet-general-use", as the rembg project distributes it). The Mac
// app uses Apple's Vision framework, which Windows doesn't have. Installers carry the model; a copy of Compositor
// without it (run from source, or a portable build) downloads it once into the profile folder on first use.
import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MODEL = {
  name: 'isnet-general-use.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  size: 178_648_008,
  sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
};

export const downloadedModelPath = () => path.join(app.getPath('userData'), 'models', MODEL.name);

/** Where the model is, bundled with the app or downloaded earlier; null when it isn't on this computer yet. */
export function modelFile(resourcesRoot: string): string | null {
  const bundled = path.join(resourcesRoot, 'models', MODEL.name);
  if (existsSync(bundled)) return bundled;
  const downloaded = downloadedModelPath();
  return existsSync(downloaded) ? downloaded : null;
}

let download: Promise<void> | null = null;

/** Downloads the model into the profile folder, reporting progress; checks its size and SHA-256 before keeping it. */
export function downloadModel(progress: (received: number, total: number) => void): Promise<void> {
  download ??= (async () => {
    const target = downloadedModelPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.part`;
    const response = await net.fetch(MODEL.url);
    if (!response.ok || !response.body) throw new Error(`The background-removal model couldn’t be downloaded (HTTP ${response.status}).`);
    const total = Number(response.headers.get('content-length')) || MODEL.size;
    const hash = createHash('sha256');
    const file = createWriteStream(partial);
    let received = 0, lastReport = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()));
        const now = Date.now();
        if (now - lastReport > 150) { lastReport = now; progress(received, total); }
      }
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())));
    } catch (error) {
      file.destroy();
      await fs.rm(partial, { force: true });
      throw error;
    }
    progress(received, total);
    if (received !== MODEL.size || hash.digest('hex') !== MODEL.sha256) {
      await fs.rm(partial, { force: true });
      throw new Error('The downloaded background-removal model was damaged. Please try again.');
    }
    await fs.rename(partial, target);
  })().finally(() => { download = null; });
  return download;
}
