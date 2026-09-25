// The window's open projects, one per tab (ProjectWorkspace.swift): new canvases, opening projects (a project
// already open is switched to rather than opened twice), closing with a save prompt, files dropped or opened from
// Explorer, and layers dragged from one project's Layers panel into another.
import { Observable } from './observable';
import { EditorSession } from './session';
import { baseName, loadProjectFile, PROJECT_FILTER } from './project';
import type { Point } from '../model/geometry';
import type { Layer } from '../model/document';
import { makeDocument, newID } from '../model/document';
import type { GPU } from '../gpu/service';
import type { Workers } from '../workers/pool';

export interface IncomingFile { path?: string; name: string; bytes?: Uint8Array }

const isProject = (name: string) => name.toLowerCase().endsWith('.comp');

export class Workspace extends Observable {
  tabs: EditorSession[] = [];
  selectedKey = 0;
  isManaging = false;
  private nextNumber = 2;
  private unsubscribers = new Map<EditorSession, () => void>();

  constructor(private readonly gpu: GPU | null, private readonly workers: Workers | null) {
    super();
    const first = this.makeSession('Untitled');
    this.tabs = [first];
    this.selectedKey = first.key;
  }

  private makeSession(name: string): EditorSession {
    const session = new EditorSession(this.gpu, this.workers);
    session.defaultName = name;
    // A tab's title and modified state show in the tab strip.
    this.unsubscribers.set(session, session.subscribe(() => this.changed()));
    return session;
  }

  get current(): EditorSession { return this.tabs.find((t) => t.key === this.selectedKey) ?? this.tabs[0]; }

  get canSwitch(): boolean {
    const s = this.current;
    return !this.isManaging && s.canStartProjectOperation && !s.hueSaturation && !s.filterEdit && !s.gradientEdit && !s.pixelMove && !s.colorPicker;
  }

  addTab(reuseEmpty = true): EditorSession {
    if (reuseEmpty && this.tabs.length === 1 && !this.current.document) return this.current;
    const tab = this.makeSession(`Untitled ${this.nextNumber++}`);
    this.tabs = [...this.tabs, tab];
    this.selectedKey = tab.key;
    this.changed();
    return tab;
  }

  select(key: number): void {
    if (key === this.selectedKey || !this.canSwitch || !this.tabs.some((t) => t.key === key)) return;
    this.current.commitTransform();
    this.selectedKey = key;
    this.changed();
  }

  /** File > New Canvas: a fresh tab showing the new-canvas choices. */
  newCanvas(): void {
    if (!this.canSwitch) return;
    this.current.commitTransform();
    const tab = this.addTab(true);
    tab.showsNewDocument = true;
  }

  /** Opens projects (asking which without `paths`); a project already open is switched to. */
  async open(paths?: string[]): Promise<boolean> {
    if (!this.canSwitch) return false;
    this.isManaging = true;
    try {
      let list = paths ?? [];
      if (!list.length) {
        const chosen = await window.compositor?.openDialog({ title: 'Open Project', filters: [PROJECT_FILTER],
          properties: ['openFile', 'multiSelections'] });
        if (!chosen?.length) return false;
        list = chosen;
      }
      let opened = false;
      for (const path of list) opened = (await this.loadProject(path)) || opened;
      return opened;
    } finally {
      this.isManaging = false;
      this.changed();
    }
  }

  /** Opens a Mac project folder (File > Open Project Folder…). */
  async openFolder(): Promise<boolean> {
    const chosen = await window.compositor?.openDialog({ title: 'Open Project Folder', properties: ['openDirectory'] });
    if (!chosen?.length) return false;
    return this.open(chosen);
  }

  private async loadProject(path: string): Promise<boolean> {
    const normalized = path.replace(/[\\/]+$/, '').toLowerCase();
    const existing = this.tabs.find((t) => t.projectPath?.replace(/[\\/]+$/, '').toLowerCase() === normalized);
    if (existing) { this.selectedKey = existing.key; this.changed(); return true; }
    // Loaded into a detached session, so a failed open never leaves a broken tab.
    const tab = this.makeSession(baseName(path));
    try {
      const info = await window.compositor?.stat(path);
      const contents = await loadProjectFile(path);
      tab.installProject(contents, path, !!info?.isDirectory);
    } catch (error) {
      await this.current.showError('Couldn’t open the project', error);
      this.unsubscribers.get(tab)?.();
      return false;
    }
    if (this.tabs.length === 1 && !this.current.document && !this.current.showsNewDocument) this.tabs = [];
    this.tabs = [...this.tabs, tab];
    this.selectedKey = tab.key;
    this.changed();
    return true;
  }

  async close(key: number): Promise<void> {
    const tab = this.tabs.find((t) => t.key === key);
    if (!this.canSwitch || !tab) return;
    this.isManaging = true;
    try {
      if (!(await tab.confirmDiscard())) return;
      this.removeTab(key);
    } finally {
      this.isManaging = false;
      this.changed();
    }
  }

  removeTab(key: number): void {
    const index = this.tabs.findIndex((t) => t.key === key);
    if (index < 0) return;
    const [removed] = this.tabs.splice(index, 1);
    this.unsubscribers.get(removed)?.();
    this.unsubscribers.delete(removed);
    this.tabs = [...this.tabs];
    if (!this.tabs.length) this.addTab(false);
    else if (this.selectedKey === key) this.selectedKey = this.tabs[Math.min(index, this.tabs.length - 1)].key;
    this.changed();
  }

  /** Asks about every unsaved project, the one on screen first. */
  async confirmQuit(): Promise<boolean> {
    if (!this.canSwitch) return false;
    this.isManaging = true;
    try {
      const order = [this.current, ...this.tabs.filter((t) => t !== this.current)];
      for (const tab of order) {
        this.selectedKey = tab.key;
        this.changed();
        if (!(await tab.confirmDiscard())) return false;
      }
      return true;
    } finally {
      this.isManaging = false;
    }
  }

  /** Files dropped or opened from Explorer: projects open in tabs; images go into `destination` (a tab key) or,
   *  without one, each into a new tab. */
  async receive(files: IncomingFile[], destination: number | null = null, point: Point | null = null): Promise<void> {
    while (!this.canSwitch) await new Promise((r) => setTimeout(r, 30));
    for (const file of files) {
      if (isProject(file.name) && file.path) { await this.open([file.path]); continue; }
      let tab: EditorSession | undefined;
      if (destination !== null) tab = this.tabs.find((t) => t.key === destination);
      else tab = this.addTab(true);
      if (!tab) continue;
      this.selectedKey = tab.key;
      this.changed();
      tab.showsNewDocument = false;
      await tab.importImages([file], point);
    }
  }

  /** A layer (with its contents) dragged from another tab's Layers panel into `destination` (or a new tab):
   *  copied centred on `point`; clipping links to layers left behind are baked in. */
  async copyLayer(sourceKey: number, id: string, destination: number | null, point: Point | null = null): Promise<void> {
    const source = this.tabs.find((t) => t.key === sourceKey);
    const document = source?.document;
    if (!this.canSwitch || !source || !document || !source.canEditLayers) return;
    if (destination === sourceKey) return;
    const target = destination !== null ? this.tabs.find((t) => t.key === destination) : this.addTab(false);
    if (!target || !(target.document === null || target.canEditLayers)) return;
    const included = new Set([id, ...source.descendantIDs(id)]);
    let copied: Layer[] = document.layers.filter((l) => included.has(l.id));
    const used = target.document?.layers.reduce((t, l) => t + (l.asset ? l.asset.image.width * l.asset.image.height : 0), 0) ?? 0;
    const added = copied.reduce((t, l) => t + (l.asset ? l.asset.image.width * l.asset.image.height : 0), 0);
    if (used + added > 100_000_000) { target.importError = 'The copied layers exceed this project’s 100-megapixel limit.'; return; }
    copied = copied.map((l) => {
      if (!l.maskSourceID || included.has(l.maskSourceID)) return l;
      if (l.adjustment) return { ...l, maskSourceID: null };
      const baked = source.bakeLiveMask(l.id);
      return { ...l, asset: baked ?? l.asset, maskSourceID: null };
    });
    const mapping = new Map(copied.map((l) => [l.id, newID()]));
    const size = target.document ? { width: target.document.width, height: target.document.height } : { width: document.width, height: document.height };
    const anchorLayer = copied.find((l) => l.id === id);
    const anchor = anchorLayer
      ? { x: anchorLayer.transform.origin.x + anchorLayer.transform.size.width / 2, y: anchorLayer.transform.origin.y + anchorLayer.transform.size.height / 2 }
      : { x: document.width / 2, y: document.height / 2 };
    const center = point ?? { x: size.width / 2, y: size.height / 2 };
    const dx = center.x - anchor.x, dy = center.y - anchor.y;
    const layers = copied.map((l): Layer => ({
      ...l, id: mapping.get(l.id)!, transform: { ...l.transform, origin: { x: l.transform.origin.x + dx, y: l.transform.origin.y + dy } },
      mask: l.mask ? { ...l.mask, placement: l.mask.placement ? { ...l.mask.placement, origin: { x: l.mask.placement.origin.x + dx, y: l.mask.placement.origin.y + dy } } : null } : null,
      parentID: l.parentID ? mapping.get(l.parentID) ?? null : null,
      maskSourceID: l.maskSourceID ? mapping.get(l.maskSourceID) ?? null : null,
    }));
    target.beginEdit('Copy Layers from Project');
    if (!target.document) {
      target.document = makeDocument(size.width, size.height);
      target.viewport.fit(size);
      target.viewportChanged();
    }
    target.updateDocument((d) => { d.layers.push(...(layers as never[])); });
    target.activeLayerID = mapping.get(id) ?? null;
    target.endEdit();
    this.selectedKey = target.key;
    this.changed();
  }
}
