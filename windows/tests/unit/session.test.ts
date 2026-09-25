import { describe, expect, it } from 'vitest';
import { EditorSession } from '../../src/renderer/session';
import { Raster } from '../../src/renderer/raster/raster';
import { asset } from '../../src/renderer/model/document';
import { SelectionPath } from '../../src/renderer/model/selection';
import { decodeManifest, encodeManifest, manifestFor, projectFiles, readProject, unzipProject, zipProject } from '../../src/renderer/io/project';
import { strFromU8 } from 'fflate';
import { makeAdjustment } from '../../src/renderer/model/adjustments';

function solidRaster(width: number, height: number, rgba: number[]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromData(width, height, 4, data);
}

describe('editor session', () => {
  it('creates a canvas with a blank layer and undoes it', () => {
    const session = new EditorSession();
    session.createDocument(400, 300, true);
    expect(session.document?.width).toBe(400);
    expect(session.document?.layers).toHaveLength(1);
    expect(session.activeLayer?.name).toBe('Layer 1');
    session.addBlankLayer();
    expect(session.document?.layers.map((l) => l.name)).toEqual(['Layer 1', 'Layer 2']);
    expect(session.history.undoName).toBe('New Blank Layer');
    session.undo();
    expect(session.document?.layers).toHaveLength(1);
    session.redo();
    expect(session.document?.layers).toHaveLength(2);
  });

  it('imports an image as a centred layer and makes the first image set the canvas', () => {
    const session = new EditorSession();
    session.insert(asset(solidRaster(50, 40, [255, 0, 0, 255]), 'Red'));
    expect(session.document?.width).toBe(50);
    session.insert(asset(solidRaster(10, 10, [0, 0, 255, 255]), 'Blue'));
    const blue = session.activeLayer!;
    expect(blue.transform.origin).toEqual({ x: 20, y: 15 });
  });

  it('combines selections and treats an explicit empty selection as touching nothing', () => {
    const session = new EditorSession();
    session.createDocument(100, 100, true);
    session.applySelection(SelectionPath.rect({ x: 10, y: 10, width: 20, height: 20 }), 'New', 'Marquee');
    session.applySelection(SelectionPath.rect({ x: 20, y: 20, width: 20, height: 20 }), 'Add', 'Marquee');
    const bounds = session.selection!.path.bounds!;
    expect(bounds).toEqual({ x: 10, y: 10, width: 30, height: 30 });
    session.applySelection(SelectionPath.rect({ x: 0, y: 0, width: 100, height: 100 }), 'Subtract', 'Marquee');
    expect(session.selection?.path.isEmpty).toBe(true);
    expect(session.canPaint).toBe(false);
    session.deselect();
    expect(session.selection).toBeNull();
    session.selectAll();
    session.invertSelection();
    expect(session.selection?.path.isEmpty).toBe(true);
  });

  it('groups layers, clips a layer to the one below and releases the clip when moved away', () => {
    const session = new EditorSession();
    session.createDocument(64, 64, true);
    session.addBlankLayer();
    session.addBlankLayer();
    const [a, b, c] = session.document!.layers.map((l) => l.id);
    session.selectLayer(c);
    session.toggleClippingMask(c);
    expect(session.layer(c)?.maskSourceID).toBe(b);
    session.selectLayer(b);
    session.toggleClippingMask(b);
    session.selectLayer(c);
    // c clips to b's base (a) once b is clipped to a: toggling b made b clip to a, c still clips to b.
    expect(session.layer(b)?.maskSourceID).toBe(a);
    session.placeLayer(c, null, null, true);
    expect(session.layer(c)?.maskSourceID).toBeNull();
    session.selectLayers(new Set([a, b]), b);
    session.groupSelectedLayers();
    const folder = session.activeLayer!;
    expect(folder.isGroup).toBe(true);
    expect(session.layer(a)?.parentID).toBe(folder.id);
    expect(session.layer(b)?.parentID).toBe(folder.id);
  });

  it('adds masks from nothing and from a selection', () => {
    const session = new EditorSession();
    session.insert(asset(solidRaster(20, 10, [0, 255, 0, 255]), 'Green'));
    session.addLayerMask(false);
    expect(session.activeLayer?.mask?.asset.image.pixel(0, 0)).toEqual([0]);
    expect(session.isMaskSelected).toBe(true);
    session.deleteLayerMask();
    session.applySelection(SelectionPath.rect({ x: 0, y: 0, width: 10, height: 10 }), 'New', 'Marquee');
    session.addMask(true);
    const mask = session.activeLayer!.mask!.asset.image;
    expect(mask.width).toBe(20);
    expect(mask.pixel(2, 2)).toEqual([0]);
    expect(mask.pixel(15, 5)).toEqual([255]);
    expect(session.selection).toBeNull();
  });

  it('flips a layer about its middle and the canvas about its centre', () => {
    const session = new EditorSession();
    session.createDocument(100, 50);
    session.insert(asset(solidRaster(20, 10, [1, 2, 3, 255]), 'A'), { x: 20, y: 10 });
    session.flipLayers(true);
    expect(session.activeLayer?.transform.flipX).toBe(true);
    expect(session.activeLayer?.transform.origin.x).toBe(10);
    session.flipCanvas(true);
    expect(session.activeLayer?.transform.flipX).toBe(false);
    expect(session.activeLayer?.transform.origin.x).toBe(70);
  });

  it('changes opacity and blend mode as undoable steps and cycles blend modes', () => {
    const session = new EditorSession();
    session.createDocument(10, 10, true);
    session.setLayerOpacity(0.25);
    expect(session.activeLayer?.opacity).toBe(0.25);
    session.cycleBlendMode(true);
    expect(session.activeLayer?.blendMode).toBe('Multiply');
    session.cycleBlendMode(false);
    session.cycleBlendMode(false);
    expect(session.activeLayer?.blendMode).toBe('Luminosity');
    session.undo();
    session.undo();
    session.undo();
    expect(session.activeLayer?.blendMode).toBe('Normal');
  });

  it('types opacity digits the Photoshop way', () => {
    const session = new EditorSession();
    session.createDocument(10, 10, true);
    session.selectTool('brush');
    session.typeOpacityDigit(4, 100);
    expect(session.brushSettings.opacity).toBe(0.4);
    session.typeOpacityDigit(5, 100.2);
    expect(session.brushSettings.opacity).toBe(0.45);
    session.typeOpacityDigit(0, 105);
    expect(session.brushSettings.opacity).toBe(1);
  });

  it('paints a brush stroke into a blank layer as one undo step', () => {
    const session = new EditorSession();
    session.createDocument(200, 100, true);
    session.selectTool('brush');
    session.brushSettings = { ...session.brushSettings, diameter: 20, hardness: 1, red: 1, green: 0, blue: 0 };
    session.beginBrush({ x: 50, y: 50 });
    session.continueBrush({ x: 100, y: 50 });
    session.continueBrush({ x: 150, y: 50 });
    session.finishBrushImmediately();
    const layer = session.activeLayer!;
    expect(layer.asset).not.toBeNull();
    const image = layer.asset!.image;
    // The layer holds what was painted, placed where it was painted.
    const local = { x: 100 - layer.transform.origin.x, y: 50 - layer.transform.origin.y };
    expect(image.pixel(Math.floor(local.x), Math.floor(local.y))).toEqual([255, 0, 0, 255]);
    expect(session.history.undoName).toBe('Brush Stroke');
    session.undo();
    expect(session.activeLayer?.asset).toBeNull();
  });

  it('switches brush tips between tool families', () => {
    const session = new EditorSession();
    session.createDocument(10, 10, true);
    session.selectTool('brush');
    session.brushSettings = { ...session.brushSettings, diameter: 12, hardness: 1 };
    session.selectTool('cloneStamp');
    expect(session.brushSettings.diameter).toBe(40);
    expect(session.brushSettings.hardness).toBe(0);
    session.selectTool('brush');
    expect(session.brushSettings.diameter).toBe(12);
  });
});

describe('project format', () => {
  it('writes the manifest the Mac app reads, and reads it back', () => {
    const session = new EditorSession();
    session.createDocument(64, 48, true);
    session.insert(asset(solidRaster(8, 8, [128, 64, 32, 255]), 'Brown'));
    session.addLayerMask(true);
    session.addAdjustment('Levels');
    const document = session.document!;
    const manifest = manifestFor(document, session.activeLayerID);
    const json = JSON.parse(strFromU8(encodeManifest(manifest)));
    expect(json.format).toBe('com.compositor.project');
    expect(json.version).toBe(7);
    expect(json.colorSpace).toBe('sRGB');
    expect(json.layers[1].transform.origin).toEqual([28, 20]);
    expect(json.layers[1].transform.size).toEqual([8, 8]);
    expect(json.layers[1].maskFile).toBe(`${document.layers[1].id}.mask.png`);
    expect(json.layers[1].maskEnabled).toBe(true);
    expect(json.layers[1].maskLinked).toBe(true);
    expect(json.layers[0].imageFile).toBeUndefined();
    expect(json.layers[2].adjustment.kind).toBe('Levels');
    // Keys sorted as the Mac's encoder sorts them.
    expect(Object.keys(json)).toEqual([...Object.keys(json)].sort());
    const decoded = decodeManifest(json);
    expect(decoded.layers).toHaveLength(3);
    expect(decoded.layers[1].transform).toEqual(document.layers[1].transform);
  });

  it('round-trips a project through a .comp file', async () => {
    const session = new EditorSession();
    session.createDocument(32, 32, true);
    session.insert(asset(solidRaster(16, 16, [100, 50, 25, 128]), 'Half'));
    session.addLayerMask(false);
    const files = projectFiles(session.document!, session.activeLayerID);
    const zipped = zipProject(files);
    const contents = await readProject(unzipProject(zipped));
    expect(contents.document.id).toBe(session.document!.id);
    const layer = contents.document.layers[1];
    expect(layer.asset?.image.pixel(3, 3)).toEqual([100, 50, 25, 128]);
    expect(layer.mask?.asset.image.pixel(0, 0)).toEqual([0]);
    expect(contents.activeLayerID).toBe(session.activeLayerID);
  });

  it('refuses versions it does not know and damaged metadata', () => {
    expect(() => decodeManifest({ format: 'com.compositor.project', version: 8 })).toThrow(/version 8/);
    expect(() => decodeManifest({ format: 'other', version: 7 })).toThrow(/not a valid/);
    expect(() => decodeManifest({ format: 'com.compositor.project', version: 7, colorSpace: 'sRGB', documentID: 'x', width: 10, height: 10, layers: [] })).toThrow();
  });

  it('keeps adjustment layers valid', () => {
    const adjustment = makeAdjustment('Grain');
    expect(adjustment.kind).toBe('Grain');
  });
});
