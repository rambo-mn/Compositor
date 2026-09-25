// The editor window (ContentView.swift and the app's menus): title bar with menus and tabs, the tool's option bar,
// the tool rail, the canvas, the Layers panel and the status bar; floating panels for adjustments and colour; and
// the dialogs. It routes the keyboard: dialogs first, then open menus, panels' Enter and Escape, menu shortcuts,
// and finally the canvas's own keys.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { EditorSession, Workspace } from '../session';
import type { GPU } from '../gpu/service';
import { useSelect, isTyping } from './hooks';
import { buildMenus, findShortcut, isTextEditingKey, type SheetKind } from './commands';
import { TitleBar, type MenuBarHandle } from './TitleBar';
import { OptionBar } from './OptionBars';
import { ToolRail } from './ToolRail';
import { LayersPanel, PANEL_WIDTHS } from './LayersPanel';
import { StatusBar } from './StatusBar';
import { CanvasController } from './canvas/controller';
import { Welcome } from './sheets/Welcome';
import { topSheet } from './sheets/Sheet';
import { AboutSheet, AlertSheet, MessageSheet, ShortcutsSheet } from './sheets/InfoSheets';
import { CanvasSizeSheet, ImageSizeSheet, JPEGExportSheet } from './sheets/DocumentSheets';
import { topPanel } from './panels/FloatingPanel';
import { LevelsPanel } from './panels/LevelsPanel';
import { HueSaturationPanel } from './panels/HueSaturationPanel';
import { FilterPanel } from './panels/FilterPanel';
import { ColorPickerPanel } from './panels/ColorPickerPanel';
import { carriesLayer, carriesPayload, droppedLayer, incomingFiles, layerDrag } from './drops';

const WIDTH_KEY = 'layersPanelWidth';

export function App({ workspace, gpu }: { workspace: Workspace; gpu: GPU | null }) {
  const session = useSelect(workspace, (w) => w.current);
  const managing = useSelect(workspace, (w) => w.isManaging);
  const controller = useRef<CanvasController | null>(null);
  const menuBar = useRef<MenuBarHandle>(null);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => {
    try { const v = Number(localStorage.getItem(WIDTH_KEY)); return v >= PANEL_WIDTHS[0] && v <= PANEL_WIDTHS[1] ? v : 252; } catch { return 252; }
  });

  const openSheet = useCallback((kind: SheetKind) => {
    const current = workspace.current;
    if (kind === 'canvasSize' || kind === 'imageSize' || kind === 'jpegExport') {
      if (!current.document || !current.canStartProjectOperation || workspace.isManaging) return;
      current.cancelCrop();
      current.commitTransform();
    }
    setSheet(kind);
  }, [workspace]);

  const checkForUpdates = useCallback(async () => {
    const result = await window.compositor?.checkForUpdates();
    const current = workspace.current;
    if (!result) return;
    if (result.status === 'development') await current.ask('Updates', 'Updates are checked in installed copies of Compositor. This copy is running from source.', ['OK'], 0);
    else if (result.status === 'current') await current.ask('You’re up to date', `Compositor ${result.version ?? ''} is the newest version.`, ['OK'], 0);
    else if (result.status === 'error') await current.ask('Couldn’t check for updates', result.message ?? 'The update server could not be reached.', ['OK'], 0);
  }, [workspace]);

  const menus = useMemo(() => buildMenus({
    workspace, openSheet, checkForUpdates: () => void checkForUpdates(),
    toggleFullScreen: () => window.compositor?.toggleFullScreen(),
  }), [workspace, openSheet, checkForUpdates]);

  // MARK: Keys

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const current = workspace.current;
      const canvas = controller.current;
      // A dialog takes Enter and Escape, and no other shortcut works behind it.
      const dialog = topSheet();
      if (dialog) {
        if (e.key === 'Escape' && dialog.cancel) { e.preventDefault(); dialog.cancel(); }
        else if (e.key === 'Enter' && dialog.ok && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          // After the field being typed in has applied its value.
          const ok = dialog.ok;
          setTimeout(ok, 0);
        }
        return;
      }
      if (menuBar.current?.isOpen() || e.defaultPrevented) return;
      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') {
        canvas?.modifiersChanged(e);
        // Alt alone must not move focus to the (hidden) system menu.
        if (e.key === 'Alt') e.preventDefault();
        return;
      }
      const typing = isTyping(e.target);
      // Alt and a menu's letter opens it (except Alt+P, which toggles Levels' preview).
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.length === 1 && !(current.levels && e.key.toLowerCase() === 'p')) {
        const index = menus.findIndex((m) => m.mnemonic === e.key.toLowerCase());
        if (index >= 0) { e.preventDefault(); menuBar.current?.open(index); return; }
      }
      // An open panel (Levels, Hue/Saturation, a filter, the colour picker) takes Enter and Escape.
      const panel = topPanel();
      if (panel && (e.key === 'Enter' || e.key === 'Escape') && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLButtonElement)) {
        const inPanel = !!(e.target as HTMLElement | null)?.closest?.('.floating-panel');
        if (inPanel || !typing) {
          e.preventDefault();
          const run = e.key === 'Enter' ? panel.ok : panel.cancel;
          setTimeout(run, 0);
          return;
        }
      }
      const item = findShortcut(menus, e);
      if (item) {
        // Text fields keep their own editing keys.
        if (typing && isTextEditingKey(e)) return;
        e.preventDefault();
        if (item.enabled !== false && item.run) item.run();
        return;
      }
      if (typing) return;
      // Shift with + or − steps the active layer's blend mode, with any tool.
      if (e.shiftKey && !e.ctrlKey && !e.altKey && ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'].includes(e.code)) {
        e.preventDefault();
        current.cycleBlendMode(e.code === 'Equal' || e.code === 'NumpadAdd');
        return;
      }
      if (canvas?.keyDown(e)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const canvas = controller.current;
      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') {
        canvas?.modifiersChanged(e);
        if (e.key === 'Alt') e.preventDefault();
      } else canvas?.keyUp(e);
    };
    const onBlur = () => controller.current?.windowBlurred();
    const onFocusIn = (e: FocusEvent) => {
      // Typing in a field drops anything half-done on the canvas, as the Mac's canvas does when it loses focus.
      if (isTyping(e.target) && !(e.target as HTMLElement).closest('.floating-panel')) controller.current?.resign();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [workspace, menus]);

  // MARK: The window's title (shown in the taskbar)

  const title = useSelect(session, (s) => `${s.title}${s.isModified && s.document ? ' •' : ''}`);
  useEffect(() => {
    window.compositor?.setTitle(`${title} – Compositor`);
    document.title = `${title} – Compositor`;
  }, [title]);

  // MARK: Dropping files and layers

  const canvasArea = useRef<HTMLDivElement>(null);
  const [dropTargeted, setDropTargeted] = useState(false);
  const acceptsDrop = (event: DragEvent) => {
    const current = workspace.current;
    if (!carriesPayload(event.dataTransfer) || !workspace.canSwitch) return false;
    if (current.levels || current.isProjectBusy || current.renamingLayerID !== null) return false;
    // A layer dragged from this project's own panel has nowhere to go on its own canvas.
    if (carriesLayer(event.dataTransfer) && (event.altKey || layerDrag?.source === current.key)) return false;
    return true;
  };
  const dropPoint = (event: DragEvent) => {
    const current = workspace.current, area = canvasArea.current?.getBoundingClientRect(), document = current.document;
    if (!area || !document) return null;
    const x = event.clientX - area.left, y = event.clientY - area.top;
    if (x < 0 || y < 0 || x > area.width || y > area.height) return null;
    return current.viewport.documentPoint({ x, y }, { width: document.width, height: document.height });
  };
  const onDragOver = (event: DragEvent) => {
    if (!carriesPayload(event.dataTransfer)) return;
    event.preventDefault();
    const accepted = acceptsDrop(event);
    event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
    setDropTargeted(accepted);
  };
  const onDrop = (event: DragEvent) => {
    setDropTargeted(false);
    if (!carriesPayload(event.dataTransfer)) return;
    event.preventDefault();
    if (!acceptsDrop(event)) return;
    const current = workspace.current;
    const point = dropPoint(event);
    const layer = droppedLayer(event.dataTransfer);
    if (layer) { void workspace.copyLayer(layer.source, layer.id, current.key, point); return; }
    void incomingFiles(event.dataTransfer).then((files) => workspace.receive(files, current.key, point));
  };

  const onController = useCallback((value: CanvasController | null) => { controller.current = value; }, []);

  return (
    <div className="app" onDragOver={onDragOver} onDrop={onDrop}
      onDragLeave={(event) => { if (!event.relatedTarget) setDropTargeted(false); }}>
      <TitleBar workspace={workspace} menus={menus} menuRef={menuBar} />
      <div className={`app-body${managing ? ' managing' : ''}`}>
        <OptionBar session={session} />
        <div className="main-row">
          <ToolRail session={session} />
          <div className="canvas-area" ref={canvasArea}>
            <CanvasView key={session.key} session={session} gpu={gpu} onController={onController} />
            <WelcomeIfEmpty session={session} workspace={workspace} />
            {dropTargeted ? <div className="drop-highlight" /> : null}
          </div>
          <ResizeEdge width={panelWidth} onChange={(w) => { setPanelWidth(w); try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* per session */ } }} />
          <LayersPanel session={session} width={panelWidth} />
        </div>
        <StatusBar session={session} />
      </div>
      <Panels session={session} />
      <Dialogs session={session} sheet={sheet} closeSheet={() => setSheet(null)} />
    </div>
  );
}

function CanvasView({ session, gpu, onController }: { session: EditorSession; gpu: GPU | null; onController: (c: CanvasController | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const controller = new CanvasController(session, gpu);
    controller.attach(host.current!, overlay.current!);
    onController(controller);
    return () => { onController(null); controller.detach(); };
  }, [session, gpu, onController]);
  return (
    <div className="canvas-host" ref={host} data-testid="editorCanvas" role="img" aria-label="Canvas">
      <canvas className="canvas-overlay" ref={overlay} />
    </div>
  );
}

function WelcomeIfEmpty({ session, workspace }: { session: EditorSession; workspace: Workspace }) {
  const empty = useSelect(session, (s) => !s.document);
  return empty ? <Welcome key={session.key} session={session} workspace={workspace} /> : null;
}

/** The Layers panel's left edge: drag left to widen it, right to narrow it. */
function ResizeEdge({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  return (
    <div className="resize-edge" title="Drag to resize the panel"
      onPointerDown={(event) => {
        event.preventDefault();
        const element = event.currentTarget;
        element.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, width };
        const move = (e: PointerEvent) => onChange(Math.min(PANEL_WIDTHS[1], Math.max(PANEL_WIDTHS[0], Math.round(start.width - (e.clientX - start.x)))));
        const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
        element.addEventListener('pointermove', move);
        element.addEventListener('pointerup', up);
      }} />
  );
}

function Panels({ session }: { session: EditorSession }) {
  const open = useSelect(session, (s) => ({ levels: !!s.levels, hue: !!s.hueSaturation, filter: !!s.filterEdit, picker: !!s.colorPicker }));
  return (
    <>
      {open.levels ? <LevelsPanel session={session} /> : null}
      {open.hue ? <HueSaturationPanel session={session} /> : null}
      {open.filter ? <FilterPanel session={session} /> : null}
      {open.picker ? <ColorPickerPanel session={session} /> : null}
    </>
  );
}

function Dialogs({ session, sheet, closeSheet }: { session: EditorSession; sheet: SheetKind | null; closeSheet: () => void }) {
  const s = useSelect(session, (x) => ({
    alert: x.alert, importError: x.importError, brushError: x.brushError, cropError: x.cropError, hasDocument: !!x.document,
  }));
  if (s.alert) return <AlertSheet alert={s.alert} />;
  if (s.importError) return <MessageSheet title="Import couldn’t finish" message={s.importError} onClose={() => { session.importError = null; }} />;
  if (s.brushError) return <MessageSheet title="Couldn’t paint" message={s.brushError} onClose={() => { session.brushError = null; }} />;
  if (s.cropError) return <MessageSheet title="Couldn’t crop" message={s.cropError} onClose={() => { session.cropError = null; }} />;
  switch (sheet) {
    case 'canvasSize': return s.hasDocument ? <CanvasSizeSheet session={session} onClose={closeSheet} /> : null;
    case 'imageSize': return s.hasDocument ? <ImageSizeSheet session={session} onClose={closeSheet} /> : null;
    case 'jpegExport': return s.hasDocument ? <JPEGExportSheet session={session} onClose={closeSheet} /> : null;
    case 'about': return <AboutSheet onClose={closeSheet} />;
    case 'shortcuts': return <ShortcutsSheet onClose={closeSheet} />;
    default: return null;
  }
}
