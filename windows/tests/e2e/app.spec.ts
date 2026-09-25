// The app as a person uses it: the built editor launched with Electron, driven by mouse and keyboard.
// Run with `npm run e2e` (it builds first). Uses software WebGL, so it runs on machines without a GPU.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'compositor-e2e-'));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Win = any;

test.beforeAll(async () => {
  fs.writeFileSync(path.join(folder, 'window-state.json'), JSON.stringify({ width: 1400, height: 900, maximized: false }));
  app = await electron.launch({
    args: [root, '--no-sandbox'],
    env: { ...process.env, COMPOSITOR_TEST: '1', COMPOSITOR_USER_DATA: folder },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('welcome')).toBeVisible();
});

test.afterAll(async () => {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
});

test.afterEach(() => {
  expect(errors, 'no errors in the page').toEqual([]);
});

/** A fresh tab with an image imported as its first layer (setting the canvas size). */
async function newProjectWithImage(width = 800, height = 600): Promise<void> {
  await page.evaluate(async ([w, h]) => {
    const workspace = (window as Win).compositorWorkspace;
    workspace.newCanvas();
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    const gradient = g.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#1d4ed8');
    gradient.addColorStop(1, '#f97316');
    g.fillStyle = gradient;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#16a34a';
    g.beginPath();
    g.arc(w / 2, h / 2, Math.min(w, h) / 4, 0, Math.PI * 2);
    g.fill();
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    await workspace.current.importImages([{ name: 'photo.png', bytes }]);
  }, [width, height]);
}

/** Reads the current project's session in the page (`read` is sent as source, so it can't use outer variables). */
const session = <T>(read: (s: Win) => T): Promise<T> =>
  page.evaluate(`(${read.toString()})(window.compositorWorkspace.current)`) as Promise<T>;
const current = () => page.evaluate(() => {
  const s = (window as Win).compositorWorkspace.current;
  return {
    layers: (s.document?.layers ?? []).map((l: Win) => l.name) as string[],
    undo: s.history.undoName as string,
    selection: !!s.selection,
    size: s.document ? [s.document.width, s.document.height] : null,
    active: s.activeLayer?.name as string | undefined,
  };
});

/** Screen position of a document point. */
async function onCanvas(x: number, y: number) {
  const box = (await page.getByTestId('editorCanvas').boundingBox())!;
  const origin = await page.evaluate(() => {
    const s = (window as Win).compositorWorkspace.current;
    const r = s.viewport.documentRect({ width: s.document.width, height: s.document.height });
    return { x: r.x, y: r.y, scale: s.viewport.pointsPerPixel };
  });
  return { x: box.x + origin.x + x * origin.scale, y: box.y + origin.y + y * origin.scale };
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
  await page.mouse.up();
}

test('the GPU compositor matches the reference pixels', async () => {
  const results = await page.evaluate(async () => {
    const module = await import(new URL('gltest.js', location.href).href);
    return module.run() as Promise<{ name: string; ok: boolean; detail: string }[]>;
  });
  const failed = results.filter((r) => !r.ok);
  expect(failed, failed.map((f) => `${f.name}: ${f.detail}`).join('\n')).toEqual([]);
  expect(results.length).toBeGreaterThan(20);
});

test('a new canvas, a brush stroke, undo and redo', async () => {
  await page.getByTestId('createCanvas').click();
  expect((await current()).size).toEqual([1920, 1080]);
  await page.keyboard.press('b');
  await drag(await onCanvas(400, 400), await onCanvas(1400, 600));
  let state = await current();
  expect(state.undo).toBe('Brush Stroke');
  const painted = await session((s) => !!s.activeLayer.asset);
  expect(painted).toBe(true);
  await page.keyboard.press('Control+z');
  expect(await session((s) => s.activeLayer.asset)).toBeNull();
  await page.keyboard.press('Control+Shift+z');
  state = await current();
  expect(state.undo).toBe('Brush Stroke');
});

test('selections, Layer via Copy, adjustments, filters and moving', async () => {
  await newProjectWithImage();
  await page.keyboard.press('m');
  await drag(await onCanvas(250, 150), await onCanvas(550, 450));
  expect((await current()).selection).toBe(true);
  await page.keyboard.press('Control+j');
  expect((await current()).layers).toEqual(['photo', 'Layer 1']);
  await page.keyboard.press('Control+l');
  await expect(page.getByTestId('levelsPanel')).toBeVisible();
  await page.getByTestId('levelsInputblack').fill('40');
  await page.getByTestId('levelsInputblack').press('Tab');
  await page.getByTestId('levelsOK').click();
  await expect(page.getByTestId('levelsPanel')).toBeHidden();
  await expect.poll(async () => (await current()).undo).toBe('Levels');
  await page.keyboard.press('Control+u');
  await page.getByTestId('hsHue').fill('90');
  await page.getByTestId('hsHue').press('Tab');
  await page.getByTestId('hueSaturationOK').click();
  await expect.poll(async () => (await current()).undo).toBe('Hue/Saturation');
  await page.getByTestId('menu-Filter').click();
  await page.getByText('Gaussian Blur…').click();
  await page.getByTestId('filterRadius').fill('4');
  await page.getByTestId('filterRadius').press('Tab');
  await page.getByTestId('filterOK').click();
  await expect.poll(async () => (await current()).undo).toBe('Gaussian Blur');
  await page.keyboard.press('v');
  const before = await session((s) => ({ ...s.activeLayer.transform.origin }));
  await drag(await onCanvas(400, 300), await onCanvas(460, 330));
  const after = await session((s) => ({ ...s.activeLayer.transform.origin }));
  expect(after.x).toBeGreaterThan(before.x);
  expect((await current()).undo).toBe('Transform Layer');
});

test('masks, clipping, folders and the Layers panel', async () => {
  await newProjectWithImage(400, 300);
  await page.getByTestId('addLayerMask').click();
  expect(await session((s) => !!s.activeLayer.mask)).toBe(true);
  await page.getByTestId('addBlankLayer').click();
  await page.keyboard.press('Control+Alt+g');
  expect(await session((s) => !!s.activeLayer.maskSourceID)).toBe(true);
  await page.keyboard.press('Control+g');
  expect(await session((s) => s.activeLayer.isGroup)).toBe(true);
  await expect(page.getByTestId('layerRow')).toHaveCount(3);
  // Hide and show a layer with its eye.
  await page.getByTestId('layerVisibility').last().click();
  expect(await session((s) => s.history.undoName)).toMatch(/Hide Layer|Show Layer/);
  // Rename by double-clicking.
  await page.getByTestId('layerRow').last().dblclick();
  await page.getByTestId('renameField').fill('Background');
  await page.getByTestId('renameField').press('Enter');
  expect((await current()).layers).toContain('Background');
});

test('saving and reopening projects, as a .comp file and as a Mac folder', async () => {
  await newProjectWithImage(320, 240);
  const file = path.join(folder, 'test.comp');
  const packageFolder = path.join(folder, 'Mac Project.comp');
  await page.evaluate(async ([a, b]) => {
    const s = (window as Win).compositorWorkspace.current;
    s.projectPath = a; s.projectIsFolder = false;
    if (!(await s.save())) throw new Error('save failed');
    s.projectPath = b; s.projectIsFolder = true;
    if (!(await s.save())) throw new Error('package save failed');
    s.projectPath = null;
  }, [file, packageFolder]);
  expect(fs.statSync(file).size).toBeGreaterThan(1000);
  expect(fs.existsSync(path.join(packageFolder, 'manifest.json'))).toBe(true);
  for (const project of [file, packageFolder]) {
    await page.evaluate((p) => (window as Win).compositorWorkspace.open([p]), project);
    const state = await current();
    expect(state.layers).toEqual(['photo']);
    expect(state.size).toEqual([320, 240]);
  }
});

test('Canvas Size, Image Size and the JPEG export preview', async () => {
  await newProjectWithImage(320, 240);
  await page.keyboard.press('Control+Alt+c');
  await page.getByTestId('canvasWidth').fill('400');
  await page.getByTestId('canvasWidth').press('Tab');
  await page.getByTestId('canvasSizeOK').click();
  expect((await current()).size).toEqual([400, 240]);
  await page.keyboard.press('Control+Alt+i');
  await page.getByTestId('imageWidth').fill('200');
  await page.getByTestId('imageWidth').press('Enter');
  await expect.poll(async () => (await current()).size).toEqual([200, 120]);
  await page.keyboard.press('Control+Alt+Shift+s');
  await expect(page.getByTestId('jpegExportOK')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jpegExportSheet')).toBeHidden();
});

test('closing a changed project asks to save it', async () => {
  await newProjectWithImage(100, 100);
  await page.keyboard.press('Control+w');
  await expect(page.getByTestId('alert')).toBeVisible();
  await expect(page.getByTestId('alert')).toContainText('Save changes');
  await page.getByTestId('alertButton2').click();
  await expect(page.getByTestId('alert')).toBeHidden();
});

test('Remove Background hides the backdrop behind a mask', async () => {
  test.skip(!fs.existsSync(path.join(root, 'resources', 'models', 'isnet-general-use.onnx')), 'run npm run fetch-model first');
  await page.evaluate(async () => {
    const workspace = (window as Win).compositorWorkspace;
    workspace.newCanvas();
    const c = new OffscreenCanvas(640, 480);
    const g = c.getContext('2d')!;
    g.fillStyle = '#9ca3af';
    g.fillRect(0, 0, 640, 480);
    const ball = g.createRadialGradient(290, 200, 20, 320, 250, 150);
    ball.addColorStop(0, '#fca5a5');
    ball.addColorStop(1, '#991b1b');
    g.fillStyle = ball;
    g.beginPath();
    g.arc(320, 250, 140, 0, Math.PI * 2);
    g.fill();
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    await workspace.current.importImages([{ name: 'ball.png', bytes }]);
  });
  await page.getByTestId('menu-Filter').click();
  await page.getByText('Remove Background…').click();
  await expect(page.getByTestId('filterOK')).toBeEnabled({ timeout: 150_000 });
  await page.getByTestId('filterOK').click();
  await expect.poll(async () => (await current()).undo, { timeout: 60_000 }).toBe('Remove Background');
  const mask = await session((s) => { const m = s.activeLayer.mask.asset.image; return [m.pixel(320, 250)[0], m.pixel(8, 8)[0]]; });
  expect(mask[0]).toBeGreaterThan(200);
  expect(mask[1]).toBeLessThan(50);
});
