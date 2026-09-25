// GPU compositor checks, run inside the Electron page by the end-to-end tests (tests/e2e/gl.spec.ts): each case
// renders a small scene and compares it with the same math done on the CPU.
import { GLContext } from '../gl/context';
import { Compositor, Scene, SceneLayer, SceneImage } from '../gl/compositor';
import { Raster, TILE_SIZE } from '../raster/raster';
import { Affine, makeTranslation, concat, makeRotation, makeScale } from '../model/geometry';
import { LayerAdjustment, makeAdjustment, defaultLevelRange, makeHueSaturation, hueSaturationCube, CUBE_DIMENSION, gradientMapTable, levelsTables } from '../model/adjustments';
import { levelsApply, grainApply, colorCubeApply, gradientMapApply } from '../raster/kernels/adjust';
import type { LayerBlendMode } from '../model/document';
import { BLEND_MODES } from '../model/document';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Premultiplied RGBA with random colours; alpha random or opaque. */
function randomPixels(width: number, height: number, seed: number, opaque = false): Uint8Array {
  const random = rng(seed);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = opaque ? 255 : Math.floor(random() * 256);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.floor(random() * (a + 1));
    data[i * 4 + 3] = a;
  }
  return data;
}

function solid(width: number, height: number, rgba: number[]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return data;
}

function image(raster: Raster, gridToDocument: Affine = makeTranslation(0, 0), sampling: SceneImage['sampling'] = 'High quality'): SceneImage {
  return { raster, width: raster.width, height: raster.height, gridToDocument, sampling };
}

function layer(id: string, img: SceneImage | null, fields: Partial<SceneLayer> = {}): SceneLayer {
  return { id, parentID: null, isGroup: false, isVisible: true, image: img, opacity: 1, blendMode: 'Normal', mask: null,
    maskSourceID: null, adjustment: null, ...fields };
}

interface Result { name: string; ok: boolean; detail: string }

function compare(name: string, actual: Uint8Array, expected: Uint8Array, tolerance: number): Result {
  if (actual.length !== expected.length) return { name, ok: false, detail: `length ${actual.length} vs ${expected.length}` };
  let worst = 0, at = -1, count = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > tolerance) count++;
    if (d > worst) { worst = d; at = i; }
  }
  const detail = worst > tolerance
    ? `max diff ${worst} at byte ${at} (pixel ${Math.floor(at / 4)} channel ${at % 4}): got ${actual[at]} expected ${expected[at]}; ${count} bytes over`
    : `max diff ${worst}`;
  return { name, ok: worst <= tolerance, detail };
}

// CPU references.

function blendReference(mode: LayerBlendMode, src: number[], dst: number[]): number[] {
  const as = src[3] / 255, ab = dst[3] / 255;
  const s = src.map((v) => v / 255), d = dst.map((v) => v / 255);
  if (mode === 'Normal') return [0, 1, 2, 3].map((k) => Math.round((s[k] + d[k] * (1 - as)) * 255));
  if (as <= 0) return dst.slice();
  const cs = [0, 1, 2].map((k) => Math.min(1, s[k] / as));
  const cb = [0, 1, 2].map((k) => (ab > 0 ? Math.min(1, d[k] / ab) : 0));
  const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const clipColor = (c: number[]) => {
    const l = lum(c), n = Math.min(...c), x = Math.max(...c);
    let r = c.slice();
    if (n < 0) r = r.map((v) => l + (v - l) * l / Math.max(l - n, 1e-6));
    if (x > 1) r = r.map((v) => l + (v - l) * (1 - l) / Math.max(x - l, 1e-6));
    return r;
  };
  const setLum = (c: number[], l: number) => clipColor(c.map((v) => v + l - lum(c)));
  const sat = (c: number[]) => Math.max(...c) - Math.min(...c);
  const setSat = (c: number[], value: number) => {
    const mx = Math.max(...c), mn = Math.min(...c);
    return mx > mn ? c.map((v) => (v - mn) * value / (mx - mn)) : [0, 0, 0];
  };
  let b: number[];
  switch (mode) {
    case 'Multiply': b = cb.map((v, k) => v * cs[k]); break;
    case 'Screen': b = cb.map((v, k) => v + cs[k] - v * cs[k]); break;
    case 'Overlay': b = cb.map((v, k) => (v <= 0.5 ? 2 * v * cs[k] : 1 - 2 * (1 - v) * (1 - cs[k]))); break;
    case 'Darken': b = cb.map((v, k) => Math.min(v, cs[k])); break;
    case 'Lighten': b = cb.map((v, k) => Math.max(v, cs[k])); break;
    case 'Difference': b = cb.map((v, k) => Math.abs(v - cs[k])); break;
    case 'Color Dodge': b = cb.map((v, k) => (v <= 0 ? 0 : cs[k] >= 1 ? 1 : Math.min(1, v / (1 - cs[k])))); break;
    case 'Color Burn': b = cb.map((v, k) => (v >= 1 ? 1 : cs[k] <= 0 ? 0 : 1 - Math.min(1, (1 - v) / cs[k]))); break;
    case 'Hue': b = setLum(setSat(cs, sat(cb)), lum(cb)); break;
    case 'Saturation': b = setLum(setSat(cb, sat(cs)), lum(cb)); break;
    case 'Color': b = setLum(cs, lum(cb)); break;
    case 'Luminosity': b = setLum(cb, lum(cs)); break;
    default: b = cs;
  }
  b = b.map((v) => Math.min(1, Math.max(0, v)));
  const ao = as + ab * (1 - as);
  const out = [0, 1, 2].map((k) => Math.round(Math.min(ao, Math.max(0, s[k] * (1 - ab) + d[k] * (1 - as) + as * ab * b[k])) * 255));
  out.push(Math.round(ao * 255));
  return out;
}

function compositeReference(bottom: Uint8Array, top: Uint8Array, mode: LayerBlendMode, opacity = 1, mask: Uint8Array | null = null): Uint8Array {
  const out = new Uint8Array(bottom.length);
  for (let i = 0; i < bottom.length / 4; i++) {
    const f = opacity * (mask ? mask[i] / 255 : 1);
    const src = [0, 1, 2, 3].map((k) => top[i * 4 + k] * f);
    const dst = [0, 1, 2, 3].map((k) => bottom[i * 4 + k]);
    out.set(blendReference(mode, src, dst), i * 4);
  }
  return out;
}

export async function run(): Promise<Result[]> {
  const canvas = new OffscreenCanvas(16, 16);
  const ctx = new GLContext(canvas);
  const compositor = new Compositor(ctx);
  const results: Result[] = [];
  const check = (name: string, body: () => Result) => {
    try { results.push(body()); } catch (error) { results.push({ name, ok: false, detail: String((error as Error)?.stack ?? error) }); }
  };
  const renderScene = (scene: Scene, rect = { x: 0, y: 0, width: scene.width, height: scene.height }) => compositor.renderRegion(scene, rect);

  check('single layer spanning several GL tiles is exact', () => {
    const w = 2600, h = 700;
    const data = randomPixels(w, h, 1);
    const raster = Raster.fromData(w, h, 4, data);
    return compare('single layer spanning several GL tiles is exact', renderScene({ width: w, height: h, layers: [layer('a', image(raster))] }), data, 0);
  });

  check('offset layer lands on whole pixels', () => {
    const data = randomPixels(300, 200, 2);
    const raster = Raster.fromData(300, 200, 4, data);
    const out = renderScene({ width: 400, height: 300, layers: [layer('a', image(raster, makeTranslation(37, 11)))] });
    const expected = new Uint8Array(400 * 300 * 4);
    for (let y = 0; y < 200; y++) expected.set(data.subarray(y * 1200, (y + 1) * 1200), ((y + 11) * 400 + 37) * 4);
    return compare('offset layer lands on whole pixels', out, expected, 0);
  });

  for (const mode of BLEND_MODES) {
    check(`blend ${mode}`, () => {
      const w = 64, h = 64;
      const bottom = randomPixels(w, h, 10), top = randomPixels(w, h, 11);
      const scene: Scene = { width: w, height: h, layers: [
        layer('b', image(Raster.fromData(w, h, 4, bottom))),
        layer('t', image(Raster.fromData(w, h, 4, top)), { blendMode: mode, opacity: 0.8 }),
      ] };
      return compare(`blend ${mode}`, renderScene(scene), compositeReference(bottom, top, mode, 0.8), 2);
    });
  }

  check('layer mask', () => {
    const w = 300, h = 90;
    const bottom = randomPixels(w, h, 20, true), top = randomPixels(w, h, 21);
    const maskData = new Uint8Array(w * h);
    const random = rng(22);
    for (let i = 0; i < maskData.length; i++) maskData[i] = Math.floor(random() * 256);
    const scene: Scene = { width: w, height: h, layers: [
      layer('b', image(Raster.fromData(w, h, 4, bottom))),
      layer('t', image(Raster.fromData(w, h, 4, top)), { mask: { image: image(Raster.fromData(w, h, 1, maskData)), outside: 'clamp' } }),
    ] };
    return compare('layer mask', renderScene(scene), compositeReference(bottom, top, 'Normal', 1, maskData), 1);
  });

  check('folder mask clips the layers inside', () => {
    const w = 120, h = 80;
    const top = randomPixels(w, h, 30);
    const maskData = new Uint8Array(w * h);
    for (let i = 0; i < maskData.length; i++) maskData[i] = (i * 7) % 256;
    const scene: Scene = { width: w, height: h, layers: [
      layer('folder', null, { isGroup: true, mask: { image: image(Raster.fromData(w, h, 1, maskData)), outside: 0 } }),
      layer('t', image(Raster.fromData(w, h, 4, top)), { parentID: 'folder' }),
    ] };
    return compare('folder mask clips the layers inside', renderScene(scene), compositeReference(new Uint8Array(w * h * 4), top, 'Normal', 1, maskData), 1);
  });

  check('clipping stack', () => {
    const w = 96, h = 64;
    const base = randomPixels(w, h, 40), child = randomPixels(w, h, 41), below = randomPixels(w, h, 42, true);
    const scene: Scene = { width: w, height: h, layers: [
      layer('below', image(Raster.fromData(w, h, 4, below))),
      layer('base', image(Raster.fromData(w, h, 4, base))),
      layer('child', image(Raster.fromData(w, h, 4, child)), { maskSourceID: 'base', blendMode: 'Multiply' }),
    ] };
    // Group: base, made opaque; child multiplied over it; the base's alpha restored; then over `below`.
    const expected = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = base[i * 4 + 3];
      const opaque = [0, 1, 2].map((k) => (a ? Math.min(255, Math.floor((base[i * 4 + k] * 255 + (a >> 1)) / a)) : 0));
      const blended = blendReference('Multiply', [0, 1, 2, 3].map((k) => child[i * 4 + k]), [...opaque, 255]);
      const restored = [0, 1, 2].map((k) => Math.floor((blended[k] * a + 127) / 255));
      expected.set(blendReference('Normal', [...restored, a], [0, 1, 2, 3].map((k) => below[i * 4 + k])), i * 4);
    }
    return compare('clipping stack', renderScene(scene), expected, 2);
  });

  const adjustmentCase = (name: string, adjustment: LayerAdjustment, reference: (pixels: Uint8Array, w: number, h: number) => void, tolerance: number) => {
    check(name, () => {
      const w = 200, h = 120;
      const pixels = randomPixels(w, h, 50);
      const scene: Scene = { width: w, height: h, layers: [
        layer('p', image(Raster.fromData(w, h, 4, pixels))),
        layer('adj', null, { adjustment }),
      ] };
      const expected = pixels.slice();
      reference(expected, w, h);
      return compare(name, renderScene(scene), expected, tolerance);
    });
  };

  const levels = makeAdjustment('Levels');
  levels.levels.ranges[0] = { ...defaultLevelRange(), black: 30, white: 220, gamma: 1.4 };
  levels.levels.ranges[2] = { ...defaultLevelRange(), outputBlack: 20 };
  adjustmentCase('levels adjustment', levels, (p, w, h) => levelsApply(p, w * h, levelsTables(levels.levels)), 1);

  const hsl = makeAdjustment('Hue/Saturation');
  hsl.hsvSettings = makeHueSaturation(40, 30, -10);
  adjustmentCase('hue/saturation adjustment', hsl, (p) => colorCubeApply(p, hueSaturationCube(hsl.hsvSettings!), CUBE_DIMENSION), 3);

  const gradient = makeAdjustment('Gradient Map');
  gradient.gradientMapSettings = { shadows: { red: 0.1, green: 0.2, blue: 0.5 }, highlights: { red: 1, green: 0.9, blue: 0.3 }, reversed: false };
  adjustmentCase('gradient map adjustment', gradient, (p, w, h) => gradientMapApply(p, w, h, gradientMapTable(gradient.gradientMapSettings!)), 1);

  const grain = makeAdjustment('Grain');
  grain.grainSettings = { amount: 60, size: 2.5, roughness: 40, seed: 12345 };
  adjustmentCase('grain adjustment', grain, (p, w, h) => grainApply(p, w, h, 60, 2.5, 40, 12345, 0, 0, 1), 2);

  check('patching a raster that shares tiles', () => {
    const w = 1500, h = 600;
    const data = randomPixels(w, h, 60);
    const a = Raster.fromData(w, h, 4, data);
    renderScene({ width: w, height: h, layers: [layer('a', image(a))] });
    const changes = new Map<number, Uint8Array | null>();
    changes.set(3, randomPixels(TILE_SIZE, TILE_SIZE, 61));
    changes.set(a.cols + 4, null);
    const b = a.withTiles(changes);
    const out = renderScene({ width: w, height: h, layers: [layer('a', image(b))] });
    const adopted = compositor.images.has(b) && !compositor.images.has(a);
    const result = compare('patching a raster that shares tiles', out, b.toData(), 0);
    return adopted ? result : { ...result, ok: false, detail: `${result.detail}; textures were not reused` };
  });

  check('rotated tiled layer has no seams', () => {
    const w = 2300, h = 400;
    const raster = Raster.fromData(w, h, 4, solid(w, h, [200, 100, 50, 255]));
    const t = concat(concat(makeTranslation(-w / 2, -h / 2), makeRotation(0.5)), makeTranslation(700, 500));
    const out = renderScene({ width: 1400, height: 1000, layers: [layer('r', image(raster, t))] });
    // Every pixel whose neighbourhood is well inside the rotated rectangle is exactly the colour.
    const inverse = (x: number, y: number) => {
      const dx = x - 700, dy = y - 500, c = Math.cos(0.5), s = Math.sin(0.5);
      return { u: dx * c + dy * s + w / 2, v: -dx * s + dy * c + h / 2 };
    };
    let bad = 0, checked = 0;
    const samples: string[] = [];
    for (let y = 0; y < 1000; y += 3) for (let x = 0; x < 1400; x += 3) {
      const { u, v } = inverse(x + 0.5, y + 0.5);
      if (u < 3 || v < 3 || u > w - 3 || v > h - 3) continue;
      checked++;
      const p = (y * 1400 + x) * 4;
      if (Math.abs(out[p] - 200) > 1 || Math.abs(out[p + 1] - 100) > 1 || Math.abs(out[p + 2] - 50) > 1 || out[p + 3] !== 255) {
        bad++;
        if (samples.length < 8) samples.push(`(${x},${y}) grid (${u.toFixed(2)},${v.toFixed(2)}) = ${Array.from(out.subarray(p, p + 4))}`);
      }
    }
    return { name: 'rotated tiled layer has no seams', ok: bad === 0 && checked > 1000, detail: `${bad} of ${checked} interior pixels wrong ${samples.join(' ')}` };
  });

  check('zoomed-out view uses sharp reductions without seams', () => {
    const w = 3000, h = 2100;
    const raster = Raster.fromData(w, h, 4, solid(w, h, [10, 200, 90, 255]));
    const target = ctx.createTarget(300, 210);
    compositor.render({ width: w, height: h, layers: [layer('z', image(raster))] }, target, makeScale(0.1, 0.1));
    const out = ctx.read(target);
    ctx.destroyTarget(target);
    let bad = 0;
    const samples: string[] = [];
    for (let y = 2; y < 208; y++) for (let x = 2; x < 298; x++) {
      const p = (y * 300 + x) * 4;
      if (Math.abs(out[p] - 10) > 1 || Math.abs(out[p + 1] - 200) > 1 || Math.abs(out[p + 2] - 90) > 1 || out[p + 3] !== 255) {
        bad++;
        if (samples.length < 12) samples.push(`(${x},${y})=${Array.from(out.subarray(p, p + 4))}`);
      }
    }
    return { name: 'zoomed-out view uses sharp reductions without seams', ok: bad === 0, detail: `${bad} wrong pixels ${samples.join(' ')}` };
  });

  check('clipping mask with a hidden base still clips', () => {
    const w = 80, h = 60;
    const base = randomPixels(w, h, 70), child = randomPixels(w, h, 71);
    const scene: Scene = { width: w, height: h, layers: [
      layer('base', image(Raster.fromData(w, h, 4, base)), { isVisible: false }),
      layer('child', image(Raster.fromData(w, h, 4, child)), { maskSourceID: 'base' }),
    ] };
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = base[i * 4 + 3];
    return compare('clipping mask with a hidden base still clips', renderScene(scene), compositeReference(new Uint8Array(w * h * 4), child, 'Normal', 1, alpha), 1);
  });

  compositor.dispose();
  compositor.images.clear();
  return results;
}
