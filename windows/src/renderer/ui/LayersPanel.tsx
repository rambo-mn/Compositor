// The Layers panel (LayersPanel, NativeLayerList, LayerAppearanceControls and BlendModePicker in the Mac app): blend
// mode and opacity for the active layer, the layer list with canvas-framed thumbnails, folders, masks and clipping,
// and the footer's buttons.
//
// In the list: click selects, Ctrl-click adds or removes a row, Shift-click selects a run; drag to reorder or into
// a folder, Alt-drag to duplicate; Alt-click the bottom of a row to clip it to the layer below; Ctrl-click a
// thumbnail to select its pixels (Ctrl-Shift adds, Ctrl-Alt subtracts); Shift-click a mask to turn it off or on;
// Alt-drag a mask onto another row to copy it; drag across the eyes to show or hide several layers.
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, ChevronRight, Contrast, Eye, EyeOff, FolderPlus, Link, SquarePlus, Trash2, Layers as LayersIcon } from 'lucide-react';
import type { EditorSession } from '../session';
import type { HierarchyEntry, Layer } from '../model/document';
import { BLEND_MODES, hierarchyEntries, maskTransform } from '../model/document';
import { ADJUSTMENT_KINDS } from '../model/adjustments';
import type { SelectionMode } from '../model/selection';
import { useSelect } from './hooks';
import { Button, NumberField, Slider } from './controls';
import { PopupMenu, type MenuItem } from './Menu';
import { AdjustmentIcon, FolderIcon } from './icons';
import { drawCanvasThumbnail, fittedSize } from './thumbnails';
import { LAYER_MIME, setLayerDrag } from './drops';
import { CURSORS, clippingCursor } from './canvas/cursors';

const MASK_MIME = 'application/x-compositor-mask';
export const PANEL_WIDTHS: [number, number] = [202, 352];

export function LayersPanel({ session, width }: { session: EditorSession; width: number }) {
  const s = useSelect(session, (x) => ({
    layers: x.document?.layers ?? null, collapsed: x.collapsedGroupIDs, selected: x.selectedLayerIDs, active: x.activeLayerID,
    masked: x.isMaskSelected, canEdit: x.canEditLayers, renaming: x.renamingLayerID, busy: x.showsBusy || x.isImporting,
    canvasWidth: x.document?.width ?? 1, canvasHeight: x.document?.height ?? 1, hasDocument: !!x.document,
    canEditMask: x.canEditMask, activeHasMask: !!x.activeLayer?.mask, hasSelection: !!x.selection, hasActive: !!x.activeLayer,
  }));
  const rows = useMemo(() => (s.layers ? hierarchyEntries(s.layers, true, s.collapsed) : []), [s.layers, s.collapsed]);
  const names = useMemo(() => new Map((s.layers ?? []).map((l) => [l.id, l.name])), [s.layers]);
  const [adjustmentMenu, setAdjustmentMenu] = useState<{ x: number; y: number } | null>(null);
  const deleteLabel = s.masked ? 'Delete layer mask' : s.selected.size > 1 ? 'Delete selected layers' : 'Delete selected layer';
  return (
    <div className="layers-panel" style={{ width }} data-testid="layersPanel">
      <div className="panel-header">
        <span className="panel-title">Layers</span>
        <span className="layer-count" data-testid="layerCount">{s.layers?.length ?? 0}</span>
      </div>
      <LayerAppearanceControls session={session} />
      {rows.length ? (
        <LayerList session={session} rows={rows} names={names} state={s} />
      ) : (
        <div className="layers-empty">
          <LayersIcon size={26} strokeWidth={1.2} />
          <div className="layers-empty-title">No layers yet</div>
          <div className="layers-empty-text">{s.hasDocument ? 'Import an image or add a blank layer.' : 'Create a canvas or import an image.'}</div>
        </div>
      )}
      <div className="panel-footer">
        <Button kind="icon" title="New blank layer (Ctrl+Shift+N)" label="New blank layer" disabled={!s.canEdit} onClick={() => session.addBlankLayer()} testId="addBlankLayer">
          <SquarePlus size={16} />
        </Button>
        <Button kind="icon" title="Group selected layers (Ctrl+G)" label="New folder" disabled={!s.canEdit} onClick={() => session.groupSelectedLayers()}>
          <FolderPlus size={16} />
        </Button>
        <Button kind="icon" title={s.hasSelection ? 'Add layer mask (the selection stays visible)' : 'Add layer mask'} label="Add layer mask"
          disabled={!s.canEditMask || s.activeHasMask} onClick={() => session.addMask()} testId="addLayerMask">
          <MaskIcon />
        </Button>
        <span onMouseDown={(event) => {
          if (!s.canEdit) return;
          event.preventDefault();
          event.stopPropagation();
          const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
          setAdjustmentMenu({ x: box.left, y: box.top - 8 - ADJUSTMENT_KINDS.length * 26 });
        }}>
          <Button kind="icon" title="New adjustment layer" label="New adjustment layer" disabled={!s.canEdit}><Contrast size={16} /></Button>
        </span>
        <span className="spacer" />
        <Button kind="icon" title={deleteLabel} label={deleteLabel} disabled={!s.canEdit || !s.hasActive} onClick={() => session.deleteLayerOrMask()} testId="deleteLayer">
          <Trash2 size={16} />
        </Button>
      </div>
      {adjustmentMenu ? (
        <PopupMenu x={adjustmentMenu.x} y={adjustmentMenu.y} onClose={() => setAdjustmentMenu(null)}
          items={ADJUSTMENT_KINDS.map((kind): MenuItem => ({ label: kind, run: () => session.addAdjustment(kind) }))} />
      ) : null}
    </div>
  );
}

/** Photoshop's mask button: a rectangle with a round hole. */
function MaskIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
      <rect x={1.5} y={3} width={13} height={10} rx={1.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path fillRule="evenodd" fill="currentColor" d="M3.5 5h9v6h-9z M8 6.2a1.8 1.8 0 1 0 0.001 0z" />
    </svg>
  );
}

// MARK: Blend and opacity

function LayerAppearanceControls({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    id: x.activeLayerID, mode: x.activeLayer?.blendMode ?? 'Normal', opacity: x.activeLayer?.opacity ?? 1, enabled: x.canEditAppearance,
  }));
  const [menu, setMenu] = useState<{ x: number; y: number; layer: string | null } | null>(null);
  useEffect(() => () => session.finishOpacityEdit(), [session, s.id]);
  return (
    <div className={`appearance${s.enabled ? '' : ' disabled'}`}>
      <div className="appearance-row">
        <span className="caption">Blend</span>
        <button type="button" className="select blend-button" disabled={!s.enabled} aria-label="Blend mode" data-testid="blendMode"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!s.enabled) return;
            const box = event.currentTarget.getBoundingClientRect();
            const index = BLEND_MODES.indexOf(s.mode);
            setMenu({ x: box.left, y: box.top - 4 - index * 26, layer: session.activeLayerID });
          }}>{s.mode}</button>
      </div>
      <div className="appearance-row">
        <span className="caption">Opacity</span>
        <Slider value={s.opacity} min={0} max={1} width="100%" disabled={!s.enabled} label="Layer opacity"
          onBegin={() => session.beginOpacityEdit()} onEnd={() => session.finishOpacityEdit()} onChange={(v) => session.setLayerOpacity(v)} />
        <NumberField value={Math.round(s.opacity * 100)} min={0} max={100} width={44} suffix="%" disabled={!s.enabled} label="Opacity percent"
          testId="layerOpacity" onChange={(v) => { if (session.activeLayerID === s.id) session.setLayerOpacity(v / 100); }} />
      </div>
      {menu ? (
        <PopupMenu x={menu.x} y={Math.max(4, menu.y)} initialHighlight={BLEND_MODES.indexOf(s.mode)}
          onClose={() => { session.previewBlendMode(null, null); setMenu(null); }}
          // Hovering a mode previews it on the canvas, as the Mac's menu does.
          onHighlight={(item) => {
            const mode = BLEND_MODES.find((m) => m === item?.label) ?? null;
            if (mode) session.previewBlendMode(mode, menu.layer);
          }}
          items={BLEND_MODES.map((mode): MenuItem => ({
            label: mode, checked: mode === s.mode,
            run: () => { if (session.activeLayerID === menu.layer) session.setLayerBlendMode(mode); },
          }))} />
      ) : null}
    </div>
  );
}

// MARK: The list

interface ListState {
  selected: ReadonlySet<string>; active: string | null; masked: boolean; canEdit: boolean; renaming: string | null; busy: boolean;
  canvasWidth: number; canvasHeight: number;
}

type DropTarget = { index: number; into: boolean } | null;

function LayerList({ session, rows, names, state }: { session: EditorSession; rows: HierarchyEntry[]; names: Map<string, string>; state: ListState }) {
  const list = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<DropTarget>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; layer: Layer } | null>(null);
  const pressedOnMask = useRef(false);
  const hover = useRef<{ element: HTMLElement; x: number; y: number } | null>(null);

  // The pointer over the list follows Alt (clipping, duplicating) and Ctrl (loading a selection) as they change.
  useEffect(() => {
    const refresh = (event: KeyboardEvent) => {
      const current = hover.current;
      if (current) updateCursor(current.element, current.x, current.y, event.altKey, event.ctrlKey);
    };
    window.addEventListener('keydown', refresh);
    window.addEventListener('keyup', refresh);
    return () => { window.removeEventListener('keydown', refresh); window.removeEventListener('keyup', refresh); };
  });

  const rowAt = (element: EventTarget | null): { index: number; row: HTMLElement } | null => {
    const row = (element as HTMLElement | null)?.closest?.('[data-row]') as HTMLElement | null;
    if (!row) return null;
    return { index: Number(row.dataset.row), row };
  };

  const inClippingZone = (row: HTMLElement, y: number) => {
    const box = row.getBoundingClientRect();
    return y >= box.bottom - box.height / 4;
  };

  function updateCursor(target: HTMLElement, x: number, y: number, alt: boolean, ctrl: boolean) {
    const found = rowAt(target);
    const listElement = list.current;
    if (!listElement) return;
    let cursor = '';
    if (found) {
      const layer = rows[found.index]?.layer;
      const onMask = !!target.closest('.thumb-mask');
      const onThumb = !!target.closest('.thumb');
      if (alt && !ctrl && layer) {
        if (onMask) cursor = state.canEdit ? CURSORS.duplicate : '';
        else if (inClippingZone(found.row, y)) cursor = session.canToggleClippingMask(layer.id) ? clippingCursor(!!layer.maskSourceID) : '';
        else cursor = state.canEdit && !layer.isGroup ? CURSORS.duplicate : '';
      } else if (ctrl && onThumb) cursor = CURSORS.loadSelection;
    }
    listElement.style.cursor = cursor;
  }

  const selectionMode = (event: { shiftKey: boolean; altKey: boolean }): SelectionMode =>
    event.altKey ? 'Subtract' : event.shiftKey ? 'Add' : 'New';

  const onRowMouseDown = (event: ReactMouseEvent, index: number) => {
    if (event.button !== 0) return;
    const layer = rows[index].layer;
    const target = event.target as HTMLElement;
    pressedOnMask.current = !!target.closest('.thumb-mask');
    if (target.closest('.row-control') || target.closest('input')) return;
    const onThumb = target.closest('.thumb') as HTMLElement | null;
    // Alt-click on the bottom of a row makes or releases a clipping mask; elsewhere it selects, so an Alt-drag
    // can drop a duplicate.
    if (event.altKey && !event.ctrlKey && !pressedOnMask.current && inClippingZone(event.currentTarget as HTMLElement, event.clientY)) {
      event.preventDefault();
      session.toggleClippingMask(layer.id);
      return;
    }
    if (onThumb && event.ctrlKey) {
      event.preventDefault();
      // Ctrl-click on a thumbnail loads a selection; elsewhere in the row it multi-selects.
      if (onThumb.classList.contains('thumb-mask')) session.loadMaskSelection(layer.id, selectionMode(event));
      else session.loadLayerSelection(layer.id, selectionMode(event));
      return;
    }
    if (onThumb?.classList.contains('thumb-mask') && event.shiftKey) {
      event.preventDefault();
      session.selectLayerTarget(layer.id, true);
      session.toggleLayerMask();
      return;
    }
    if (onThumb && !event.shiftKey && !event.altKey) {
      session.selectLayerTarget(layer.id, onThumb.classList.contains('thumb-mask'));
      return;
    }
    if (event.ctrlKey) {
      const next = new Set(state.selected);
      if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
      session.selectLayers(next, next.has(layer.id) ? layer.id : state.active);
      return;
    }
    if (event.shiftKey) {
      const anchor = rows.findIndex((r) => r.layer.id === state.active);
      const [from, to] = anchor < 0 ? [index, index] : [Math.min(anchor, index), Math.max(anchor, index)];
      session.selectLayers(new Set(rows.slice(from, to + 1).map((r) => r.layer.id)), layer.id);
      return;
    }
    // Several selected, pressed on one of them: they stay selected so they can be dragged together.
    if (!(state.selected.size > 1 && state.selected.has(layer.id))) session.selectLayers(new Set([layer.id]), layer.id);
  };

  const onRowClick = (event: ReactMouseEvent, index: number) => {
    const layer = rows[index].layer;
    const target = event.target as HTMLElement;
    if (event.ctrlKey || event.shiftKey || event.altKey || target.closest('.row-control, .thumb, input')) return;
    if (state.selected.size > 1 && state.selected.has(layer.id)) { session.selectLayers(new Set([layer.id]), layer.id); return; }
    // A click on a row's name targets the layer itself, even when its mask was selected, so transforming then
    // moves layer and mask together.
    if (state.masked && state.selected.size === 1 && state.selected.has(layer.id)) {
      session.commitTransform();
      session.selectLayerTarget(layer.id, false);
    }
  };

  const onRowDoubleClick = (event: ReactMouseEvent, index: number) => {
    const layer = rows[index].layer;
    if (!session.canEditLayers || (event.target as HTMLElement).closest('.row-control, input')) return;
    if (layer.adjustment) { session.editAdjustmentLayer(layer.id); return; }
    session.activeLayerID = layer.id;
    session.renamingLayerID = layer.id;
  };

  // MARK: Dragging rows

  /** Every layer being dragged, in list order, leaving out what a dragged folder carries along. */
  const draggedIDs = (anchor: string): string[] => {
    const dragged = state.selected.has(anchor) ? new Set(state.selected) : new Set([anchor]);
    const carried = new Set<string>();
    for (const id of dragged) for (const d of session.descendantIDs(id)) carried.add(d);
    return rows.map((r) => r.layer.id).filter((id) => dragged.has(id) && !carried.has(id));
  };
  const dragging = useRef<string[] | null>(null);

  const onDragStart = (event: DragEvent, index: number) => {
    const layer = rows[index].layer;
    if (pressedOnMask.current && event.altKey && layer.mask) {
      event.dataTransfer.setData(MASK_MIME, layer.id);
      event.dataTransfer.effectAllowed = 'copy';
      dragging.current = null;
      return;
    }
    if (!session.canEditLayers) { event.preventDefault(); return; }
    dragging.current = draggedIDs(layer.id);
    // Other projects' tabs and canvases take the layer too.
    event.dataTransfer.setData(LAYER_MIME, JSON.stringify({ source: session.key, id: layer.id }));
    event.dataTransfer.effectAllowed = 'copyMove';
    setLayerDrag({ source: session.key, id: layer.id });
  };

  const dropFor = (event: DragEvent): DropTarget => {
    const found = rowAt(event.target);
    if (!found) return { index: rows.length, into: false };
    const box = found.row.getBoundingClientRect();
    const fraction = (event.clientY - box.top) / box.height;
    const layer = rows[found.index].layer;
    if (layer.isGroup && fraction > 0.25 && fraction < 0.75) return { index: found.index, into: true };
    return { index: fraction < 0.5 ? found.index : found.index + 1, into: false };
  };

  const validDrop = (event: DragEvent, target: DropTarget): boolean => {
    const ids = dragging.current;
    if (!ids?.length || !target || !session.canEditLayers) return false;
    const copying = event.altKey;
    if (copying && ids.some((id) => session.layer(id)?.isGroup !== false)) return false;
    const parent = target.into ? rows[target.index].layer.id : (rows[target.index]?.layer.parentID ?? null);
    return ids.every((id) => session.canPlaceLayer(id, parent));
  };

  const maskSource = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(MASK_MIME);

  const onDragOver = (event: DragEvent) => {
    if (maskSource(event)) {
      const found = rowAt(event.target);
      event.preventDefault();
      event.dataTransfer.dropEffect = found ? 'copy' : 'none';
      setDrop(found ? { index: found.index, into: true } : null);
      return;
    }
    if (!dragging.current) return;
    const target = dropFor(event);
    if (!validDrop(event, target)) { setDrop(null); event.dataTransfer.dropEffect = 'none'; return; }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
    setDrop(target);
  };

  const onDrop = (event: DragEvent) => {
    setDrop(null);
    if (maskSource(event)) {
      event.preventDefault();
      event.stopPropagation();
      const source = event.dataTransfer.getData(MASK_MIME);
      const found = rowAt(event.target);
      const target = found ? rows[found.index].layer.id : null;
      if (source && target && session.canCopyMask(source, target)) session.copyMask(source, target);
      return;
    }
    const ids = dragging.current;
    const target = dropFor(event);
    if (!ids || !validDrop(event, target) || !target) return;
    event.preventDefault();
    event.stopPropagation();
    const copying = event.altKey;
    // Where the drop lands is worked out once: each layer placed shifts the rows beneath it.
    let parent: string | null, above: string | null, atBottom: boolean;
    if (target.into) { parent = rows[target.index].layer.id; above = null; atBottom = false; }
    else if (target.index >= rows.length) { parent = null; above = null; atBottom = true; }
    else { const t = rows[target.index].layer; parent = t.parentID; above = t.id; atBottom = false; }
    // Dropped above a layer (or at the very bottom) the last one placed ends up nearest it, so they go in from the
    // top down; dropped into a folder each lands on top, so they go in from the bottom up.
    const order = target.into ? ids.slice().reverse() : ids;
    session.beginEdit(copying ? (ids.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer') : (ids.length > 1 ? 'Move Layers' : 'Move Layer'));
    let placed = false;
    for (const id of order) {
      const done = copying ? session.duplicateLayer(id, parent, above, atBottom) : session.placeLayer(id, parent, above, atBottom);
      placed = done || placed;
    }
    // The layers that moved stay selected, so they can be dragged on as a group.
    if (placed && !copying) session.selectLayers(new Set(ids), ids[0]);
    session.endEdit();
  };

  const onDragEnd = () => { dragging.current = null; setDrop(null); setLayerDrag(null); };

  const contextItems = (layer: Layer): MenuItem[] => {
    const selectImage = () => session.selectLayerTarget(layer.id, false);
    const canEdit = session.canEditLayers;
    return [
      { label: 'Rename…', enabled: canEdit, run: () => { session.activeLayerID = layer.id; session.renamingLayerID = layer.id; } },
      { label: layer.isVisible ? 'Hide Layer' : 'Show Layer', enabled: canEdit, run: () => session.toggleLayerVisibility(layer.id) },
      { separator: true },
      { label: 'Add White Mask', enabled: canEdit && !layer.mask, run: () => { selectImage(); session.addMask(true); } },
      { label: 'Add Black Mask', enabled: canEdit && !layer.mask, run: () => { selectImage(); session.addMask(false); } },
      { label: layer.mask?.isEnabled === false ? 'Enable Mask' : 'Disable Mask', enabled: canEdit && !!layer.mask, run: () => { selectImage(); session.toggleLayerMask(); } },
      { label: 'Delete Mask', enabled: canEdit && !!layer.mask, run: () => { selectImage(); session.deleteLayerMask(); } },
      { label: 'Release Clipping Mask', enabled: canEdit && !!layer.maskSourceID, run: () => session.removeLiveMask(layer.id) },
      { separator: true },
      { label: 'Move Out of Folder', enabled: canEdit && !!layer.parentID, run: () => { session.selectLayer(layer.id); session.moveActiveLayerOutOfGroup(); } },
      { label: layer.isGroup ? 'Delete Folder' : 'Delete Layer', enabled: canEdit, run: () => {
        if (session.selectedLayerIDs.size > 1 && session.selectedLayerIDs.has(layer.id)) session.deleteSelectedLayers();
        else session.deleteLayer(layer.id);
      } },
    ];
  };

  // Up and Down move through the rows when the list has focus (the Move tool's arrows move the layer instead).
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || session.tool === 'move' || event.ctrlKey || event.altKey) return;
    const index = rows.findIndex((r) => r.layer.id === state.active);
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowUp' ? -1 : 1)))];
    if (next) { session.selectLayers(new Set([next.layer.id]), next.layer.id); event.preventDefault(); }
  };

  return (
    <div className="layers-list" ref={list} tabIndex={0} data-testid="layersList" onKeyDown={onKeyDown}
      onDragOver={onDragOver} onDrop={onDrop} onDragLeave={(event) => { if (!list.current?.contains(event.relatedTarget as Node)) setDrop(null); }}
      onMouseMove={(event) => {
        hover.current = { element: event.target as HTMLElement, x: event.clientX, y: event.clientY };
        updateCursor(event.target as HTMLElement, event.clientX, event.clientY, event.altKey, event.ctrlKey);
      }}
      onMouseLeave={() => { hover.current = null; if (list.current) list.current.style.cursor = ''; }}>
      {rows.map((entry, index) => (
        <LayerRow key={entry.layer.id} session={session} entry={entry} index={index}
          selected={state.selected.has(entry.layer.id)}
          target={state.active === entry.layer.id && state.selected.size === 1 ? (state.masked ? 'mask' : 'image') : null}
          enabled={state.canEdit} busy={state.busy} renaming={state.renaming === entry.layer.id}
          canvasWidth={state.canvasWidth} canvasHeight={state.canvasHeight}
          sourceName={entry.layer.maskSourceID ? names.get(entry.layer.maskSourceID) ?? 'Missing source' : null}
          dropBefore={!!drop && !drop.into && drop.index === index}
          dropInto={!!drop && drop.into && drop.index === index}
          onMouseDown={onRowMouseDown} onClick={onRowClick} onDoubleClick={onRowDoubleClick}
          onDragStart={onDragStart} onDragEnd={onDragEnd}
          onContextMenu={(event, layer) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, layer }); }} />
      ))}
      <div className={`drop-end${drop && !drop.into && drop.index === rows.length ? ' active' : ''}`} />
      {menu ? <PopupMenu x={menu.x} y={menu.y} items={contextItems(menu.layer)} onClose={() => setMenu(null)} testId="layerContextMenu" /> : null}
    </div>
  );
}

// MARK: A row

interface RowProps {
  session: EditorSession; entry: HierarchyEntry; index: number; selected: boolean; target: 'image' | 'mask' | null;
  enabled: boolean; busy: boolean; renaming: boolean; canvasWidth: number; canvasHeight: number; sourceName: string | null;
  dropBefore: boolean; dropInto: boolean;
  onMouseDown: (event: ReactMouseEvent, index: number) => void;
  onClick: (event: ReactMouseEvent, index: number) => void;
  onDoubleClick: (event: ReactMouseEvent, index: number) => void;
  onDragStart: (event: DragEvent, index: number) => void;
  onDragEnd: () => void;
  onContextMenu: (event: ReactMouseEvent, layer: Layer) => void;
}

const LayerRow = memo(function LayerRow(props: RowProps) {
  const { session, entry, index } = props;
  const layer = entry.layer;
  const framed = !layer.adjustment && !layer.isGroup;
  const clipped = !!layer.maskSourceID;
  // A folder steps its contents in by the same distance a clipping mask does; the two add up.
  const indent = Math.min(entry.depth, 8) * 24 + (clipped ? 24 : 0);
  const canvas = { width: props.canvasWidth, height: props.canvasHeight };
  const details = clipped ? `Clipped to ${props.sourceName}` : layer.adjustment ? 'Adjustment · Double-click to edit'
    : layer.isGroup ? 'Folder' : `${Math.round(layer.transform.size.width)} × ${Math.round(layer.transform.size.height)} px`;
  const collapsed = useSelect(session, (s) => s.collapsedGroupIDs.has(layer.id));
  return (
    <div className={`layer-row${props.selected ? ' selected' : ''}${entry.visible ? '' : ' hidden-layer'}${props.dropBefore ? ' drop-before' : ''}${props.dropInto ? ' drop-into' : ''}`}
      data-row={index} data-layer-id={layer.id} data-testid="layerRow" draggable={props.enabled && !props.renaming}
      title={clipped ? `Clipping mask based on ${props.sourceName}. Alt-click the bottom of its row to release.` : undefined}
      onMouseDown={(event) => props.onMouseDown(event, index)} onClick={(event) => props.onClick(event, index)}
      onDoubleClick={(event) => props.onDoubleClick(event, index)}
      onDragStart={(event) => props.onDragStart(event, index)} onDragEnd={props.onDragEnd}
      onContextMenu={(event) => props.onContextMenu(event, layer)}>
      <EyeButton session={session} layer={layer} enabled={props.enabled} />
      <span style={{ width: indent, flex: 'none' }} />
      <span className="row-control disclosure-slot">
        {layer.isGroup ? (
          <button type="button" className="disclosure" disabled={!props.enabled} aria-label="Expand or collapse folder"
            onMouseDown={(event) => event.preventDefault()} onClick={() => session.toggleGroupExpansion(layer.id)}>
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : null}
      </span>
      <span className="thumb-slot">
        {framed ? (
          <span className={`thumb thumb-image${props.target === 'image' ? ' target' : ''}`} title="Select image pixels · Ctrl-click to select its pixels (Ctrl-Shift adds, Ctrl-Alt subtracts)">
            <ThumbCanvas session={session} layer={layer} canvas={canvas} box={36} mask={false} />
          </span>
        ) : (
          <span className={`thumb thumb-icon${props.target === 'image' ? ' target' : ''}`}>
            {layer.adjustment ? <AdjustmentIcon kind={layer.adjustment.kind} /> : <FolderIcon />}
          </span>
        )}
      </span>
      {layer.mask ? (
        <>
          {framed ? (
            <button type="button" className="row-control link-button" disabled={props.busy}
              aria-label={layer.mask.isLinked ? `Unlink mask: ${layer.name}` : `Link mask: ${layer.name}`}
              title={layer.mask.isLinked ? 'Unlink layer and mask to move or transform them separately' : 'Link layer and mask so they move together'}
              onMouseDown={(event) => event.preventDefault()} onClick={() => session.toggleMaskLink(layer.id)}>
              {layer.mask.isLinked ? <Link size={10} style={{ transform: 'rotate(-45deg)' }} /> : null}
            </button>
          ) : <span style={{ width: 5 }} />}
          <span className="thumb-slot mask-slot">
            <span className={`thumb thumb-mask${props.target === 'mask' ? ' target' : ''}`}
              title="Select layer mask · Shift-click to turn it off or on · Ctrl-click to select its black areas (Ctrl-Shift adds, Ctrl-Alt subtracts) · Alt-drag onto another layer to copy it">
              <ThumbCanvas session={session} layer={layer} canvas={canvas} box={30} mask />
              {layer.mask.isEnabled ? null : <span className="mask-off" aria-label="Mask turned off">╱</span>}
            </span>
          </span>
        </>
      ) : null}
      <span className="row-text">
        {props.renaming ? <RenameField session={session} layer={layer} /> : (
          <span className="row-name">{(clipped ? '↳ ' : '') + layer.name}</span>
        )}
        <span className="row-details">{details}</span>
      </span>
    </div>
  );
});

function ThumbCanvas({ session, layer, canvas, box, mask }: {
  session: EditorSession; layer: Layer; canvas: { width: number; height: number }; box: number; mask: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raster = mask ? layer.mask?.asset.image ?? null : layer.asset?.image ?? null;
  const transform = mask ? maskTransform(layer) : layer.transform;
  const size = fittedSize(canvas, box);
  useEffect(() => {
    if (ref.current) drawCanvasThumbnail(ref.current, session.gpu, raster, transform, canvas, box, mask);
  }, [session.gpu, raster, transform, canvas.width, canvas.height, box, mask]);
  return <canvas ref={ref} style={{ width: size.width, height: size.height }} />;
}

/** The eye: pressing shows or hides the layer; dragging down the list gives every eye passed over the same state. */
function EyeButton({ session, layer, enabled }: { session: EditorSession; layer: Layer; enabled: boolean }) {
  return (
    <button type="button" className="row-control eye" disabled={!enabled} aria-label={`${layer.isVisible ? 'Hide' : 'Show'} ${layer.name}`}
      data-testid="layerVisibility"
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const visible = session.beginVisibilitySwipe(layer.id);
        if (visible === null) return;
        const element = event.currentTarget;
        element.setPointerCapture(event.pointerId);
        const move = (e: PointerEvent) => {
          const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-layer-id]') as HTMLElement | null;
          if (row?.dataset.layerId) session.setVisibilityInSwipe(row.dataset.layerId, visible);
        };
        const up = () => {
          element.removeEventListener('pointermove', move);
          element.removeEventListener('pointerup', up);
          element.removeEventListener('lostpointercapture', up);
          session.endVisibilitySwipe();
        };
        element.addEventListener('pointermove', move);
        element.addEventListener('pointerup', up);
        element.addEventListener('lostpointercapture', up);
      }}>
      {layer.isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
    </button>
  );
}

/** The layer's name typed in its row: Enter keeps it, Escape leaves it as it was, as does clicking away. */
function RenameField({ session, layer }: { session: EditorSession; layer: Layer }) {
  const [text, setText] = useState(layer.name);
  const done = useRef(false);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep) session.renameLayer(layer.id, text);
    if (session.renamingLayerID === layer.id) session.renamingLayerID = null;
    (document.querySelector('.layers-list') as HTMLElement | null)?.focus();
  };
  return (
    <input className="field rename-field" value={text} autoFocus aria-label="Layer name" data-testid="renameField"
      onFocus={(event) => event.currentTarget.select()} onChange={(event) => setText(event.target.value)}
      onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
        event.stopPropagation();
      }}
      onBlur={() => finish(true)} />
  );
}
