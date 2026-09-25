// Undo history. Snapshots are whole documents; they share immutable rasters (and those share tiles), so an
// entry costs only what changed. Bounded by entry count and by the bytes kept alive only by history.
// A port of DocumentHistory.swift.
import type { CanvasDocument } from './document';
import { documentsEqual } from './document';

export interface HistorySnapshot {
  document: CanvasDocument | null;
  activeLayerID: string | null;
  revision: number;
}

interface Entry { name: string; before: HistorySnapshot; after: HistorySnapshot }

let nextRevision = 1;

export class DocumentHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private revision = nextRevision++;
  private savedRevision: number | null;
  private pending: HistorySnapshot | null = null;
  private pendingName = 'Edit';
  private depth = 0;
  readonly entryLimit: number;
  readonly retainedByteLimit: number;
  /** Called whenever what the history can do changes (for menus). */
  onChange: (() => void) | null = null;

  constructor(entryLimit = 100, retainedByteLimit = 256 * 1024 * 1024) {
    this.entryLimit = Math.max(0, entryLimit);
    this.retainedByteLimit = Math.max(0, retainedByteLimit);
    this.savedRevision = this.revision;
  }

  get canUndo(): boolean { return this.depth === 0 && this.past.length > 0; }
  get canRedo(): boolean { return this.depth === 0 && this.future.length > 0; }
  get undoName(): string { return this.past[this.past.length - 1]?.name ?? ''; }
  get redoName(): string { return this.future[this.future.length - 1]?.name ?? ''; }
  get isModified(): boolean { return this.revision !== this.savedRevision; }
  get undoCount(): number { return this.past.length; }
  get isOpen(): boolean { return this.depth > 0; }

  markSaved(): void { this.savedRevision = this.revision; this.onChange?.(); }

  reset(): void {
    this.past = [];
    this.future = [];
    this.pending = null;
    this.depth = 0;
    this.revision = nextRevision++;
    this.savedRevision = this.revision;
    this.onChange?.();
  }

  /** Nestable: only the outermost begin/end pair records an entry. */
  begin(name: string, document: CanvasDocument | null, activeLayerID: string | null): void {
    if (this.depth === 0) {
      this.pending = { document, activeLayerID, revision: this.revision };
      this.pendingName = name;
    }
    this.depth += 1;
  }

  end(document: CanvasDocument | null, activeLayerID: string | null): void {
    if (this.depth <= 0) return;
    this.depth -= 1;
    if (this.depth !== 0 || !this.pending) return;
    const before = this.pending;
    this.pending = null;
    // Selecting, navigating and no-op edits keep redo history.
    if (documentsEqual(before.document, document)) { this.onChange?.(); return; }
    this.revision = nextRevision++;
    this.past.push({ name: this.pendingName, before, after: { document, activeLayerID, revision: this.revision } });
    this.future = [];
    this.trim(document);
    this.onChange?.();
  }

  undo(): HistorySnapshot | null {
    if (!this.canUndo) return null;
    const entry = this.past.pop()!;
    this.future.push(entry);
    this.revision = entry.before.revision;
    this.trim(entry.before.document);
    this.onChange?.();
    return entry.before;
  }

  redo(): HistorySnapshot | null {
    if (!this.canRedo) return null;
    const entry = this.future.pop()!;
    this.past.push(entry);
    this.revision = entry.after.revision;
    this.trim(entry.after.document);
    this.onChange?.();
    return entry.after;
  }

  /** Bytes retained only by history, excluding pixels in the live document. */
  retainedBytes(current: CanvasDocument | null): number {
    const live = new Set<Uint8Array>();
    const addDocument = (doc: CanvasDocument | null, into: Set<Uint8Array>, seenRasters: Set<unknown>) => {
      for (const layer of doc?.layers ?? []) {
        for (const raster of [layer.asset?.image, layer.mask?.asset.image]) {
          if (!raster || seenRasters.has(raster)) continue;
          seenRasters.add(raster);
          for (const tile of raster.tiles) if (tile) into.add(tile);
        }
      }
    };
    addDocument(current, live, new Set());
    const retained = new Set<Uint8Array>();
    const seen = new Set<unknown>();
    for (const entry of [...this.past, ...this.future]) {
      addDocument(entry.before.document, retained, seen);
      addDocument(entry.after.document, retained, seen);
    }
    let bytes = 0;
    for (const tile of retained) if (!live.has(tile)) bytes += tile.byteLength;
    return bytes;
  }

  private trim(current: CanvasDocument | null): void {
    while (this.past.length + this.future.length > this.entryLimit || this.retainedBytes(current) > this.retainedByteLimit) {
      if (this.past.length) this.past.shift();
      else if (this.future.length) this.future.shift();
      else break;
    }
  }
}
