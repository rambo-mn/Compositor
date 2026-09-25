// The menu bar's menus and their keyboard shortcuts: the Mac app's menus (CompositorApp.swift) with Ctrl for ⌘ and
// Alt for ⌥. Menus are built fresh each time they open or a key is pressed, so every item's name and state is
// current; the shortcut table is the menus themselves.
import type { Workspace, EditorSession } from '../session';
import type { MenuItem } from './Menu';
import { separator } from './Menu';
import { ADJUSTMENT_KINDS } from '../model/adjustments';
import { FILTER_KINDS, isImageAdjustment, type FilterKind } from '../model/settings';

export type SheetKind = 'canvasSize' | 'imageSize' | 'jpegExport' | 'about' | 'shortcuts';

export interface AppActions {
  workspace: Workspace;
  openSheet(kind: SheetKind): void;
  checkForUpdates(): void;
  toggleFullScreen(): void;
}

export interface MenuDefinition { title: string; mnemonic: string; items: () => MenuItem[] }

/** Project operations need the project free (not busy, no modal edit) and the tabs not being managed. */
const canStart = (session: EditorSession, workspace: Workspace) => session.canStartProjectOperation && !workspace.isManaging;

export function buildMenus(app: AppActions): MenuDefinition[] {
  const workspace = app.workspace;
  const s = () => workspace.current;
  return [
    {
      title: 'File', mnemonic: 'f', items: () => {
        const session = s();
        const start = canStart(session, workspace);
        const hasDocument = !!session.document;
        return [
          { label: 'New Canvas…', accel: 'Ctrl+N', enabled: workspace.canSwitch, run: () => workspace.newCanvas(), testId: 'menuNewCanvas' },
          { label: 'Open Project…', accel: 'Ctrl+O', enabled: workspace.canSwitch, run: () => void workspace.open() },
          { label: 'Open Mac Project Folder…', enabled: workspace.canSwitch, run: () => void workspace.openFolder() },
          { label: 'Import Images…', enabled: !(session.levels || session.showsBusy || session.isImporting || session.showsNewDocument),
            run: () => void session.chooseImagesToImport() },
          separator,
          { label: 'Save', accel: 'Ctrl+S', enabled: hasDocument && start, run: () => void session.save() },
          { label: 'Save As…', accel: 'Ctrl+Shift+S', enabled: hasDocument && start, run: () => void session.save(true) },
          { label: 'Save As Mac Project Folder…', enabled: hasDocument && start, run: () => void session.save(true, true) },
          separator,
          { label: 'Export PNG…', accel: 'Ctrl+Shift+E', enabled: hasDocument && start, run: () => void session.exportPNG() },
          { label: 'Export JPEG…', accel: 'Ctrl+Alt+Shift+S', enabled: hasDocument && start, run: () => app.openSheet('jpegExport') },
          separator,
          { label: 'Close Project', accel: 'Ctrl+W', enabled: workspace.canSwitch, run: () => void workspace.close(session.key) },
          separator,
          { label: 'Exit', accel: 'Alt+F4', run: () => window.close() },
        ];
      },
    },
    {
      title: 'Edit', mnemonic: 'e', items: () => {
        const session = s();
        return [
          { label: session.history.canUndo ? `Undo ${session.history.undoName}` : 'Undo', accel: 'Ctrl+Z', enabled: session.canUndo,
            run: () => session.undo(), testId: 'menuUndo' },
          { label: session.history.canRedo ? `Redo ${session.history.redoName}` : 'Redo', accel: 'Ctrl+Shift+Z', enabled: session.canRedo,
            run: () => session.redo() },
          separator,
          // Cut, Copy and Paste check when chosen: what they depend on (the clipboard) isn't observed.
          { label: 'Cut', accel: 'Ctrl+X', run: () => { if (session.selection && session.canCopyPixels) void session.cutSelection(); } },
          { label: 'Copy', accel: 'Ctrl+C', run: () => { if (session.canCopyPixels) void session.copySelection(); } },
          { label: 'Copy Merged', accel: 'Ctrl+Shift+C', enabled: session.canCopyMerged, run: () => session.copyMergedSelection() },
          { label: 'Paste', accel: 'Ctrl+V', run: () => { if (session.canPaste) void session.paste(); } },
          separator,
          { label: 'Fill with Foreground Color', accel: 'Alt+Backspace', enabled: session.canEditPixels, run: () => void session.fillSelection('foreground') },
          { label: 'Fill with Background Color', accel: 'Ctrl+Backspace', enabled: session.canEditPixels, run: () => void session.fillSelection('background') },
          { label: 'Clear Selection Pixels', enabled: !!session.selection && session.canEditPixels, run: () => void session.clearSelectedPixels() },
          { label: 'Content-Aware Fill…', accel: 'Shift+Backspace', enabled: session.canContentAwareFill, run: () => session.beginFilter('Content-Aware Fill') },
        ];
      },
    },
    {
      title: 'View', mnemonic: 'v', items: () => {
        const session = s();
        const has = !!session.document;
        return [
          { label: 'Fit Canvas', accel: 'Ctrl+0', enabled: has, run: () => session.fit() },
          { label: 'Actual Pixels', accel: 'Ctrl+1', enabled: has, run: () => session.zoom(1) },
          { label: 'Zoom In', accel: 'Ctrl+=', enabled: has, run: () => session.zoom(session.viewport.zoom * 1.25) },
          { label: 'Zoom Out', accel: 'Ctrl+-', enabled: has, run: () => session.zoom(session.viewport.zoom / 1.25) },
          separator,
          { label: 'Pixel Grid (800% and above)', checked: session.showsPixelGrid, run: () => { session.showsPixelGrid = !session.showsPixelGrid; } },
          { label: 'Show Transform Controls', accel: 'Ctrl+H', checked: session.showsTransformControls, enabled: session.tool === 'move' && has,
            run: () => { session.showsTransformControls = !session.showsTransformControls; } },
          separator,
          { label: 'Full Screen', accel: 'F11', run: () => app.toggleFullScreen() },
        ];
      },
    },
    {
      title: 'Select', mnemonic: 's', items: () => {
        const session = s();
        const active = session.activeLayer;
        return [
          { label: 'All', accel: 'Ctrl+A', enabled: !!session.document, run: () => session.selectAll() },
          { label: 'Deselect', accel: 'Ctrl+D', enabled: !!session.selection && session.canEditSelection, run: () => session.deselect() },
          { label: 'Inverse', accel: 'Ctrl+Shift+I', enabled: !!session.selection && session.canEditSelection, run: () => session.invertSelection() },
          { label: 'Layer’s Pixels', enabled: !!active?.asset && session.canEditSelection, run: () => { if (session.activeLayerID) session.loadLayerSelection(session.activeLayerID); } },
          { label: 'Mask’s Black Areas', enabled: !!active?.mask && session.canEditSelection, run: () => { if (session.activeLayerID) session.loadMaskSelection(session.activeLayerID); } },
          separator,
          { label: `Expand by ${session.selectionExpandAmount} px`, enabled: session.canModifySelection, run: () => session.expandSelection(session.selectionExpandAmount) },
          { label: `Contract by ${session.selectionContractAmount} px`, enabled: session.canModifySelection, run: () => session.contractSelection(session.selectionContractAmount) },
        ];
      },
    },
    {
      title: 'Image', mnemonic: 'i', items: () => {
        const session = s();
        const colors = session.canAdjustColors && !session.hueSaturation;
        const start = !!session.document && canStart(session, workspace);
        return [
          { label: 'Curves…', accel: 'Ctrl+M', enabled: colors, run: () => session.beginFilter('Curves') },
          { label: 'Levels…', accel: 'Ctrl+L', enabled: colors, run: () => session.beginLevels() },
          { label: 'Hue/Saturation…', accel: 'Ctrl+U', enabled: session.canAdjustColors, run: () => session.beginHueSaturation() },
          ...(['Exposure', 'Gradient Map', 'Grain'] as FilterKind[]).map((kind): MenuItem => ({ label: `${kind}…`, enabled: colors, run: () => session.beginFilter(kind) })),
          { label: session.isMaskSelected ? 'Invert Mask' : 'Invert', accel: 'Ctrl+I', enabled: session.canInvert, run: () => void session.invertPixels() },
          separator,
          { label: 'Canvas Size…', accel: 'Ctrl+Alt+C', enabled: start, run: () => app.openSheet('canvasSize') },
          { label: 'Image Size…', accel: 'Ctrl+Alt+I', enabled: start, run: () => app.openSheet('imageSize') },
          separator,
          { label: 'Flip Canvas Horizontal', enabled: session.canEditLayers, run: () => session.flipCanvas(true) },
          { label: 'Flip Canvas Vertical', enabled: session.canEditLayers, run: () => session.flipCanvas(false) },
        ];
      },
    },
    {
      title: 'Filter', mnemonic: 't', items: () => {
        const session = s();
        const colors = session.canAdjustColors && !session.hueSaturation;
        return FILTER_KINDS.filter((k) => k !== 'Content-Aware Fill' && !isImageAdjustment(k))
          .map((kind): MenuItem => ({ label: `${kind}…`, enabled: colors, run: () => session.beginFilter(kind) }));
      },
    },
    {
      title: 'Layer', mnemonic: 'l', items: () => {
        const session = s();
        const active = session.activeLayer;
        const id = session.activeLayerID;
        return [
          { label: 'New Adjustment Layer', enabled: session.canEditLayers && !!session.document,
            submenu: ADJUSTMENT_KINDS.map((kind): MenuItem => ({ label: `${kind}…`, run: () => session.addAdjustment(kind) })) },
          { label: 'Edit Adjustment…', enabled: session.canEditLayers && !!active?.adjustment, run: () => { if (id) session.editAdjustmentLayer(id); } },
          separator,
          { label: session.canTransformSelection ? 'Transform Selection' : 'Transform Layer', accel: 'Ctrl+T',
            enabled: session.canTransform || session.canTransformSelection, run: () => session.transformCommand() },
          { label: session.selection ? 'Layer via Copy' : 'Duplicate Layer', accel: 'Ctrl+J',
            enabled: session.canCopyPixels || (!session.selection && session.canEditLayers && active?.isGroup === false),
            run: () => session.layerViaCopy() },
          separator,
          { label: active?.maskSourceID ? 'Release Clipping Mask' : 'Create Clipping Mask', accel: 'Ctrl+Alt+G',
            enabled: !!id && session.canToggleClippingMask(id), run: () => { if (id) session.toggleClippingMask(id); } },
          separator,
          { label: 'Group Selected Layers', accel: 'Ctrl+G', enabled: session.canEditLayers, run: () => session.groupSelectedLayers() },
          { label: 'Move Out of Folder', enabled: session.canEditLayers && !!active?.parentID, run: () => session.moveActiveLayerOutOfGroup() },
          { label: 'New Blank Layer', accel: 'Ctrl+Shift+N', enabled: session.canEditLayers, run: () => session.addBlankLayer() },
          { label: 'Rename Layer…', enabled: session.canEditLayers && !!active, run: () => { session.renamingLayerID = id; } },
          { label: active?.isVisible === false ? 'Show Layer' : 'Hide Layer', enabled: session.canEditLayers && !!active,
            run: () => { if (id) session.toggleLayerVisibility(id); } },
          separator,
          { label: 'Move Layer Up', accel: 'Ctrl+]', enabled: session.canMoveActiveLayer(1), run: () => session.moveActiveLayer(1) },
          { label: 'Move Layer Down', accel: 'Ctrl+[', enabled: session.canMoveActiveLayer(-1), run: () => session.moveActiveLayer(-1) },
          { label: session.mergeTitle, accel: 'Ctrl+E', enabled: session.canMergeLayers, run: () => session.mergeLayers() },
          separator,
          { label: 'Flip Layer Horizontal', enabled: session.canTransform, run: () => session.flipLayers(true) },
          { label: 'Flip Layer Vertical', enabled: session.canTransform, run: () => session.flipLayers(false) },
          separator,
          { label: session.isMaskSelected && active?.mask ? 'Delete Layer Mask' : session.selectedLayerIDs.size > 1 ? 'Delete Layers' : 'Delete Layer',
            enabled: session.canEditLayers && !!active, run: () => session.deleteLayerOrMask() },
        ];
      },
    },
    {
      title: 'Help', mnemonic: 'h', items: () => [
        { label: 'Keyboard Shortcuts', accel: 'F1', run: () => app.openSheet('shortcuts') },
        separator,
        { label: 'Check for Updates…', run: () => app.checkForUpdates() },
        { label: 'About Compositor', run: () => app.openSheet('about') },
      ],
    },
  ];
}

// MARK: Shortcuts

interface Accelerator { ctrl: boolean; shift: boolean; alt: boolean; key: string }

function parse(accel: string): Accelerator {
  const parts = accel.split('+');
  // "Ctrl+=" and "Ctrl+-" keep their key; "Ctrl++" never occurs.
  const key = parts.pop() || '+';
  return { ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt'), key };
}

const CODES: Record<string, string[]> = {
  '=': ['Equal', 'NumpadAdd'], '-': ['Minus', 'NumpadSubtract'], '[': ['BracketLeft'], ']': ['BracketRight'],
  Backspace: ['Backspace'], Delete: ['Delete'], F1: ['F1'], F4: ['F4'], F11: ['F11'],
};

/** Whether a key press is this shortcut. Letters follow the keyboard layout; other keys the key's position. */
export function matchesAccelerator(accel: string, e: KeyboardEvent): boolean {
  // Windows closes the window on Alt+F4 itself; the menu only shows it.
  if (accel === 'Alt+F4') return false;
  const a = parse(accel);
  if (a.ctrl !== (e.ctrlKey || e.metaKey) || a.alt !== e.altKey) return false;
  // Zooming in takes Ctrl with = or +, with or without Shift.
  if (a.key !== '=' && a.shift !== e.shiftKey) return false;
  if (/^[A-Z]$/.test(a.key)) {
    const key = e.key.length === 1 ? e.key.toUpperCase() : '';
    // The letter the layout types; where Ctrl+Alt types something else (AltGr), the key's position.
    if (/^[A-Z]$/.test(key)) return key === a.key;
    return e.code === `Key${a.key}`;
  }
  if (/^[0-9]$/.test(a.key)) return e.code === `Digit${a.key}` || e.code === `Numpad${a.key}`;
  return (CODES[a.key] ?? []).includes(e.code) || e.key === a.key;
}

/** The menu item a key press chooses, searching submenus too. */
export function findShortcut(menus: MenuDefinition[], e: KeyboardEvent): MenuItem | null {
  const search = (items: MenuItem[]): MenuItem | null => {
    for (const item of items) {
      if (item.accel && matchesAccelerator(item.accel, e)) return item;
      if (item.submenu) { const found = search(item.submenu); if (found) return found; }
    }
    return null;
  };
  for (const menu of menus) {
    const found = search(menu.items());
    if (found) return found;
  }
  // Windows' other Redo.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') {
    for (const menu of menus) {
      const redo = menu.items().find((i) => i.accel === 'Ctrl+Shift+Z');
      if (redo) return redo;
    }
  }
  return null;
}

/** Shortcuts a text field keeps for its own editing while it has focus. */
export function isTextEditingKey(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && !e.altKey && ['a', 'c', 'v', 'x', 'z', 'y'].includes(key)) return true;
  if (key === 'backspace' || key === 'delete') return true;
  if (ctrl && (key === 'arrowleft' || key === 'arrowright' || key === 'home' || key === 'end')) return true;
  return false;
}
