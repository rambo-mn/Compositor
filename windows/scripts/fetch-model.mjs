// Downloads Remove Background's segmentation model into resources/models, where installers pick it up, and checks
// its size and SHA-256. Does nothing when a good copy is already there. Usage: node scripts/fetch-model.mjs
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MODEL = {
  name: 'isnet-general-use.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  size: 178_648_008,
  sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'resources', 'models');
const target = path.join(folder, MODEL.name);

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

if (existsSync(target) && (await stat(target)).size === MODEL.size && (await sha256(target)) === MODEL.sha256) {
  console.log(`${MODEL.name} is already in resources/models.`);
  process.exit(0);
}
await mkdir(folder, { recursive: true });
console.log(`Downloading ${MODEL.name} (${Math.round(MODEL.size / 1048576)} MB)…`);
const response = await fetch(MODEL.url);
if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
const partial = `${target}.part`;
await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
if ((await stat(partial)).size !== MODEL.size || (await sha256(partial)) !== MODEL.sha256) {
  await rm(partial, { force: true });
  throw new Error('The downloaded model does not match its expected size and checksum.');
}
await rename(partial, target);
console.log(`Saved resources/models/${MODEL.name}.`);
