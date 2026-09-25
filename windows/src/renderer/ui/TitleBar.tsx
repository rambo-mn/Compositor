// The window's top bar (the Mac window's menu bar and toolbar together): the menus, New, the project tabs and the
// zoom buttons, with Windows' own minimize, maximize and close buttons at the right.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type DragEvent } from 'react';
import { Plus, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Workspace, EditorSession } from '../session';
import { useSelect } from './hooks';
import { MenuList } from './Menu';
import type { MenuDefinition } from './commands';
import { Button } from './controls';
import { carriesLayer, carriesPayload, droppedLayer, incomingFiles, layerDrag } from './drops';

/** Copied next to the page by the build. */
const iconURL = 'assets/icon.png';

export interface MenuBarHandle { open(index: number): void; close(): void; isOpen(): boolean }

export const MenuBar = forwardRef<MenuBarHandle, { menus: MenuDefinition[] }>(function MenuBar({ menus }, ref) {
  const [open, setOpen] = useState(-1);
  const [, setVersion] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ open: (index) => setOpen(index), close: () => setOpen(-1), isOpen: () => open >= 0 }), [open]);
  useEffect(() => {
    if (open < 0) return;
    const close = (event: MouseEvent) => { if (!bar.current?.contains(event.target as Node)) setOpen(-1); };
    const blur = () => setOpen(-1);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', blur);
    // Item names and states are read as the menu opens; refresh them if something changes while it is open.
    const timer = setInterval(() => setVersion((v) => v + 1), 250);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', blur); clearInterval(timer); };
  }, [open]);
  return (
    <div className="menubar" ref={bar} role="menubar">
      {menus.map((menu, index) => (
        <div key={menu.title} className="menubar-entry">
          <button type="button" className={`menubar-title${open === index ? ' open' : ''}`} data-testid={`menu-${menu.title}`}
            onMouseDown={(event) => { event.preventDefault(); setOpen(open === index ? -1 : index); }}
            onMouseEnter={() => { if (open >= 0 && open !== index) setOpen(index); }}>
            {menu.title}
          </button>
          {open === index ? (
            <MenuList items={menu.items()} onClose={() => setOpen(-1)} style={{ position: 'absolute', top: '100%', left: 0 }}
              onSide={(direction) => setOpen((open + direction + menus.length) % menus.length)} />
          ) : null}
        </div>
      ))}
    </div>
  );
});

function dropTarget(workspace: Workspace, destination: number | null, setTargeted: (value: boolean) => void) {
  const accepts = (event: DragEvent) => {
    if (!carriesPayload(event.dataTransfer) || !workspace.canSwitch) return false;
    if (carriesLayer(event.dataTransfer)) {
      // Alt-dragging a layer duplicates it inside the Layers panel; it isn't a drag to another project.
      if (event.altKey) return false;
      if (layerDrag && destination !== null && layerDrag.source === destination) return false;
    }
    return true;
  };
  return {
    onDragEnter: (event: DragEvent) => { if (accepts(event)) { event.preventDefault(); setTargeted(true); } },
    onDragOver: (event: DragEvent) => {
      if (!accepts(event)) { event.dataTransfer.dropEffect = 'none'; setTargeted(false); return; }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setTargeted(true);
    },
    onDragLeave: () => setTargeted(false),
    onDrop: (event: DragEvent) => {
      setTargeted(false);
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const layer = droppedLayer(event.dataTransfer);
      if (layer) { void workspace.copyLayer(layer.source, layer.id, destination); return; }
      void incomingFiles(event.dataTransfer).then((files) => workspace.receive(files, destination));
    },
  };
}

function ProjectTab({ workspace, tab }: { workspace: Workspace; tab: EditorSession }) {
  const state = useSelect(tab, (t) => ({ title: t.title, modified: t.isModified && !!t.document }));
  const shared = useSelect(workspace, (w) => ({ active: w.selectedKey === tab.key, canSwitch: w.canSwitch }));
  const [targeted, setTargeted] = useState(false);
  return (
    <div className={`tab${shared.active ? ' active' : ''}${targeted ? ' targeted' : ''}`} title={targeted ? `Add to ${state.title}` : state.title}
      data-testid="projectTab" {...dropTarget(workspace, tab.key, setTargeted)}>
      <button type="button" className="tab-title" disabled={!shared.canSwitch && !shared.active}
        onMouseDown={(event) => event.preventDefault()} onClick={() => workspace.select(tab.key)}>
        {state.modified ? <span className="tab-dot" aria-label="Unsaved changes" /> : null}
        <span className="tab-name">{state.title}</span>
      </button>
      <button type="button" className="tab-close" title={`Close ${state.title}`} aria-label={`Close ${state.title}`}
        disabled={!shared.canSwitch} onMouseDown={(event) => event.preventDefault()} onClick={() => void workspace.close(tab.key)}>
        <X size={11} strokeWidth={2.5} />
      </button>
    </div>
  );
}

function NewTabSlot({ workspace }: { workspace: Workspace }) {
  const [targeted, setTargeted] = useState(false);
  return (
    <div className={`tab-new-slot${targeted ? ' targeted' : ''}`} title="Drop to open in a new canvas" {...dropTarget(workspace, null, setTargeted)}>
      <Plus size={12} /> New
    </div>
  );
}

export function ProjectTabs({ workspace }: { workspace: Workspace }) {
  const tabs = useSelect(workspace, (w) => w.tabs);
  const selected = useSelect(workspace, (w) => w.selectedKey);
  const [dragging, setDragging] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    // Shows the "New" drop slot while anything droppable is dragged over the window.
    let depth = 0;
    const enter = (event: globalThis.DragEvent) => { if (carriesPayload(event.dataTransfer)) { depth++; setDragging(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    const end = () => { depth = 0; setDragging(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    };
  }, []);
  useEffect(() => {
    const element = strip.current?.querySelector('.tab.active');
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, tabs.length]);
  return (
    <div className={`tabs${scrolled ? ' scrolled' : ''}`} ref={strip} aria-label="Project tabs"
      onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 1)}
      onWheel={(event) => { if (strip.current && event.deltaY) strip.current.scrollLeft += event.deltaY; }}>
      {tabs.map((tab) => <ProjectTab key={tab.key} workspace={workspace} tab={tab} />)}
      {dragging ? <NewTabSlot workspace={workspace} /> : null}
    </div>
  );
}

export function TitleBar(props: { workspace: Workspace; menus: MenuDefinition[]; menuRef: React.Ref<MenuBarHandle> }) {
  const { workspace } = props;
  const session = useSelect(workspace, (w) => w.current);
  const state = useSelect(session, (s) => ({
    hasDocument: !!s.document, busy: s.isImporting || s.showsBusy || !!s.levels, zoom: s.viewport.zoom,
  }));
  const canSwitch = useSelect(workspace, (w) => w.canSwitch);
  const [newTargeted, setNewTargeted] = useState(false);
  return (
    <div className="titlebar">
      <img className="titlebar-icon" src={iconURL} alt="" draggable={false} />
      <MenuBar ref={props.menuRef} menus={props.menus} />
      <div className={`new-canvas-button${newTargeted ? ' targeted' : ''}`} {...dropTarget(workspace, null, setNewTargeted)}>
        <Button kind="icon" title="New canvas (Ctrl+N) · Drop images here for new tabs" label="New canvas"
          disabled={!canSwitch || state.busy} onClick={() => workspace.newCanvas()} testId="newCanvasToolbar">
          <Plus size={16} />
        </Button>
      </div>
      <ProjectTabs workspace={workspace} />
      <div className="titlebar-actions">
        <Button kind="plain" title="Fit canvas in window (Ctrl+0)" disabled={!state.hasDocument} onClick={() => session.fit()} testId="fitCanvas">Fit</Button>
        <Button kind="plain" title="Actual pixels (Ctrl+1)" disabled={!state.hasDocument} onClick={() => session.zoom(1)} testId="actualPixels">100%</Button>
        <Button kind="icon" title="Zoom in (Ctrl++)" label="Zoom in" disabled={!state.hasDocument} onClick={() => session.zoom(session.viewport.zoom * 1.25)}>
          <ZoomIn size={16} />
        </Button>
        <Button kind="icon" title="Zoom out (Ctrl+−)" label="Zoom out" disabled={!state.hasDocument} onClick={() => session.zoom(session.viewport.zoom / 1.25)}>
          <ZoomOut size={16} />
        </Button>
      </div>
      <div className="window-controls-space" />
    </div>
  );
}
