// Bundles the Electron main process, the preload script, the renderer (React + WebGL editor) and its worker
// into dist/. `--watch` rebuilds on change; `--production` minifies.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'renderer'), { recursive: true });

const shared = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
};

const builds = [
  // Electron's main process and the preload bridge run in Node.
  { ...shared, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(dist, 'main/main.js'),
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] },
  { ...shared, entryPoints: [path.join(root, 'src/main/preload.ts')], outfile: path.join(dist, 'main/preload.js'),
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] },
  // The editor itself.
  { ...shared, entryPoints: { app: path.join(root, 'src/renderer/index.tsx') }, outdir: path.join(dist, 'renderer'),
    platform: 'browser', format: 'esm', target: 'chrome140', jsx: 'automatic',
    loader: { '.wasm': 'file', '.svg': 'text' }, assetNames: 'assets/[name]-[hash]' },
  // Heavy pixel work runs off the main thread.
  { ...shared, entryPoints: { worker: path.join(root, 'src/renderer/workers/worker.ts') }, outdir: path.join(dist, 'renderer'),
    platform: 'browser', format: 'esm', target: 'chrome140' },
];

async function copyStatic() {
  await cp(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));
  await cp(path.join(root, 'src/renderer/assets'), path.join(dist, 'renderer/assets'), { recursive: true });
  // ONNX Runtime loads its WebAssembly next to the page.
  const ort = path.join(root, 'node_modules/onnxruntime-web/dist');
  await mkdir(path.join(dist, 'renderer/ort'), { recursive: true });
  for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs',
                      'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
    if (existsSync(path.join(ort, file))) await cp(path.join(ort, file), path.join(dist, 'renderer/ort', file));
  }
}

if (watch) {
  for (const options of builds) {
    const context = await esbuild.context(options);
    await context.watch();
  }
  await copyStatic();
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await copyStatic();
}
