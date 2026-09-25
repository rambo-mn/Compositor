// Opening, saving, importing and exporting for one project (ProjectController.swift and EditorSession+Projects.swift).
import { EditorSession } from './session';
import { extend } from './observable';
import type { Point } from '../model/geometry';
import type { CanvasDocument } from '../model/document';
import { asset } from '../model/document';
import { Raster, premultiply, unpremultiply } from '../raster/raster';
import { decodeImageBytes, encodeJPEG, encodePNG, sniffFormat } from '../io/codecs';
import { ProjectContents, projectFiles, readProject, unzipProject, zipProject } from '../io/project';
import { plainScene } from './scene';

export const PROJECT_FILTER = { name: 'Compositor Project', extensions: ['comp'] };
export const IMAGE_FILTER = { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'webp', 'bmp', 'gif'] };

export const baseName = (file: string) => file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
const bridge = () => {
  const api = window.compositor;
  if (!api) throw new Error('This feature needs the Compositor desktop app.');
  return api;
};

/** Reads a project from a .comp file (ZIP) or a Mac folder package. */
export async function loadProjectFile(path: string): Promise<ProjectContents> {
  const api = bridge();
  const info = await api.stat(path);
  if (!info.exists) throw new Error('The project could not be found.');
  const files = info.isDirectory ? await api.readPackage(path) : unzipProject(await api.readFile(path));
  return readProject(files);
}

const project = {
  get title(): string {
    const s = this as unknown as EditorSession;
    return s.projectPath ? baseName(s.projectPath) : s.defaultName;
  },

  /** Called only after the whole project has been validated and loaded. */
  installProject(this: EditorSession, contents: ProjectContents, path: string, folder: boolean): void {
    this.collapsedGroupIDs = new Set();
    this.isMaskSelected = false;
    this.cancelCrop();
    this.transformEdit = null;
    this.document = contents.document;
    this.activeLayerID = contents.activeLayerID;
    this.projectPath = path;
    this.projectIsFolder = folder;
    this.renamingLayerID = null;
    this.history.reset();
    this.viewport.fit({ width: contents.document.width, height: contents.document.height });
    this.viewportChanged();
  },

  clearProject(this: EditorSession): void {
    this.collapsedGroupIDs = new Set();
    this.isMaskSelected = false;
    this.cancelCrop();
    this.transformEdit = null;
    this.document = null;
    this.activeLayerID = null;
    this.renamingLayerID = null;
    this.projectPath = null;
    this.history.reset();
  },

  createNewProject(this: EditorSession, width: number, height: number): void {
    if (this.isProjectBusy || this.isImporting || !(width >= 1 && width <= 30_000 && height >= 1 && height <= 30_000)) return;
    this.clearProject();
    this.createDocument(width, height, true);
  },

  // MARK: Import

  /** Adds images as layers (the first image of an empty project sets the canvas size), one undo step per batch. */
  async importImages(this: EditorSession, files: { path?: string; name: string; bytes?: Uint8Array }[], point: Point | null = null): Promise<void> {
    if (!files.length) return;
    if (this.brushStroke) await this.finishBrush();
    this.cancelCrop();
    this.commitTransform();
    await this.waitForProjectAccess();
    this.isImporting = true;
    const failures: string[] = [];
    this.beginEdit('Import Images');
    try {
      for (const file of files) {
        try {
          const bytes = file.bytes ?? await bridge().readFile(file.path!);
          if (!sniffFormat(bytes)) throw new Error('Choose a JPEG, PNG, HEIC, TIFF, WebP, BMP or GIF image.');
          const used = this.document?.layers.reduce((total, l) => total + (l.asset ? l.asset.image.width * l.asset.image.height : 0), 0) ?? 0;
          const decoded = await decodeImageBytes(bytes, 100_000_000 - used);
          premultiply(decoded.data);
          const raster = Raster.fromData(decoded.width, decoded.height, 4, decoded.data);
          // No document: the first image sets the canvas, wherever it was dropped.
          this.insert(asset(raster, baseName(file.name)), this.document ? point : null);
        } catch (error) {
          failures.push(`${file.name}: ${(error as Error).message}`);
        }
      }
    } finally {
      this.endEdit();
      this.isImporting = false;
    }
    if (failures.length) this.importError = [this.importError, ...failures].filter(Boolean).join('\n\n');
  },

  /** File > Place / Import: asks for images. */
  async chooseImagesToImport(this: EditorSession): Promise<void> {
    const paths = await bridge().openDialog({ title: 'Import Images', filters: [IMAGE_FILTER, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile', 'multiSelections'] });
    if (!paths?.length) return;
    await this.importImages(paths.map((path) => ({ path, name: path })));
  },

  // MARK: Save

  /** Saves to the project's file, asking where for a new project (or always, with `asNew`). `folder` saves a
   *  Mac-style folder package. Returns whether it was saved. */
  async save(this: EditorSession, asNew = false, folder: boolean | null = null): Promise<boolean> {
    const document = this.document;
    if (!document || !this.canStartProjectOperation) return false;
    this.cancelCrop();
    this.commitTransform();
    let destination = asNew || folder !== null ? null : this.projectPath;
    let asFolder = folder ?? this.projectIsFolder;
    if (!destination) {
      const suggested = (this.projectPath ? baseName(this.projectPath) : this.title) + '.comp';
      const chosen = await bridge().saveDialog({ title: asNew ? 'Save Project As' : 'Save Project', filters: [PROJECT_FILTER], defaultPath: suggested });
      if (!chosen) return false;
      destination = chosen.toLowerCase().endsWith('.comp') ? chosen : chosen + '.comp';
      asFolder = folder ?? false;
    }
    try {
      await this.whileBusy(async () => {
        const files = projectFiles(document, this.activeLayerID);
        if (asFolder) await bridge().writePackage(destination!, files);
        else await bridge().writeFile(destination!, zipProject(files));
      });
      this.projectPath = destination;
      this.projectIsFolder = asFolder;
      this.history.markSaved();
      return true;
    } catch (error) {
      await this.showError('Couldn’t save the project', error);
      return false;
    }
  },

  async showError(this: EditorSession, title: string, error: unknown): Promise<void> {
    await this.ask(title, error instanceof Error ? error.message : String(error), ['OK'], 0);
  },

  /** Asks to save unsaved changes. Resolves true to go on (saved or discarded), false to stop. */
  async confirmDiscard(this: EditorSession): Promise<boolean> {
    if (!this.isModified || !this.document) return true;
    const choice = await this.ask(`Save changes to ${this.projectPath ? baseName(this.projectPath) + '.comp' : this.title}?`,
      'Your changes will be lost if you don’t save them.', ['Save', 'Cancel', 'Don’t Save'], 1);
    if (choice === 0) return this.save();
    return choice === 2;
  },

  // MARK: Export

  /** The document flattened as saved (every visible layer), premultiplied RGBA. */
  renderFlattened(this: EditorSession): Uint8Array {
    const document = this.document!;
    if (document.width * document.height > 100_000_000) throw new Error('Image export supports canvases up to 100 megapixels and 30,000 pixels per side.');
    return this.gpu!.renderRegion(plainScene(document), { x: 0, y: 0, width: document.width, height: document.height });
  },

  async exportPNG(this: EditorSession): Promise<void> {
    const document = this.document;
    if (!document || !this.canStartProjectOperation) return;
    this.cancelCrop();
    this.commitTransform();
    const path = await bridge().saveDialog({ title: 'Export PNG', filters: [{ name: 'PNG Image', extensions: ['png'] }],
      defaultPath: `${this.title}.png` });
    if (!path) return;
    try {
      await this.whileBusy(async () => {
        const pixels = this.renderFlattened();
        unpremultiply(pixels);
        await bridge().writeFile(path, encodePNG(pixels, document.width, document.height, 4, document.resolution));
      });
    } catch (error) { await this.showError('Couldn’t export PNG', error); }
  },

  /** Encodes the flattened document as JPEG (for the export dialog's preview and size). */
  async encodeJPEGExport(this: EditorSession, quality: number, background: [number, number, number]): Promise<Uint8Array> {
    const document = this.document!;
    const pixels = this.renderFlattened();
    unpremultiply(pixels);
    return encodeJPEG(pixels, document.width, document.height, quality, background, document.resolution);
  },

  async saveJPEG(this: EditorSession, data: Uint8Array): Promise<void> {
    const path = await bridge().saveDialog({ title: 'Export JPEG', filters: [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }],
      defaultPath: `${this.title}.jpg` });
    if (!path) return;
    try { await bridge().writeFile(path, data); }
    catch (error) { await this.showError('Couldn’t export JPEG', error); }
  },
};

type Project = typeof project;
declare module './session' {
  interface EditorSession extends Project {}
}
extend(EditorSession, project);

export type { CanvasDocument };
