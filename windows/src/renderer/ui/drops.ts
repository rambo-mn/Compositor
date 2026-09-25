// What can be dropped on the window, the tabs and the canvas: files from Explorer (or images dragged from a
// browser), and layers dragged out of a project's Layers panel into another project.
import type { IncomingFile } from '../session/workspace';

export const LAYER_MIME = 'application/x-compositor-layer';

/** The layer being dragged from a Layers panel, while the drag lasts (drop targets can't read its data until the
 *  drop, but need to know where it came from before). */
export let layerDrag: { source: number; id: string } | null = null;
export function setLayerDrag(value: { source: number; id: string } | null): void { layerDrag = value; }

/** Whether a drag carries files or a layer. */
export function carriesPayload(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = Array.from(transfer.types);
  return types.includes('Files') || types.includes(LAYER_MIME);
}

export function carriesLayer(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types).includes(LAYER_MIME);
}

/** The dropped files: by path when they are files on disk, else (an image dragged from a web page) their bytes. */
export async function incomingFiles(transfer: DataTransfer): Promise<IncomingFile[]> {
  const files: IncomingFile[] = [];
  for (const file of Array.from(transfer.files)) {
    const path = window.compositor?.pathForFile(file) ?? null;
    if (path) files.push({ path, name: file.name || path });
    else files.push({ name: file.name || 'Image', bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return files;
}

/** The layer a drop carries. */
export function droppedLayer(transfer: DataTransfer): { source: number; id: string } | null {
  try {
    const value = JSON.parse(transfer.getData(LAYER_MIME)) as { source: number; id: string };
    return typeof value?.source === 'number' && typeof value.id === 'string' ? value : null;
  } catch { return null; }
}
