// The bar along the bottom (ContentView.statusBar): zoom, canvas size and colour, and either what the app is busy
// with or how to use the current tool.
import type { EditorSession } from '../session';
import { useSelect } from './hooks';
import { Spinner } from './controls';

function hint(s: EditorSession): string {
  switch (s.tool) {
    case 'marquee':
      return s.marqueeKind === 'Ellipse'
        ? 'Drag an ellipse · Shift add · Alt subtract · Shift again mid-drag circle · Drag inside to move · Delete clears · Ctrl+D deselect'
        : 'Drag a rectangle · Shift add · Alt subtract · Shift again mid-drag square · Drag inside to move · Ctrl-drag moves pixels · Delete clears · Ctrl+D deselect';
    case 'wand': return 'Click to select similar colors · Shift add · Alt subtract · Drag inside to move · Ctrl-drag moves pixels · Delete clears · Ctrl+D deselect';
    case 'lasso':
      return s.lassoKind === 'Freehand'
        ? 'Drag to select · Drag inside to move · Shift add · Alt subtract · Delete clears · Alt+Backspace / Ctrl+Backspace fill · Ctrl+D deselect'
        : 'Click corners · Click the start, double-click or Enter to close · Backspace removes a corner · Esc cancels';
    case 'brush': return `${s.brushMode === 'Erase' ? 'Drag to erase' : 'Drag to paint'} · [ ] size · Shift+[ ] hardness · 1–0 opacity · Esc cancel · Space to pan`;
    case 'blur': return `${s.blurMode === 'Blur' ? 'Drag to soften' : s.blurMode === 'Smudge' ? 'Drag to smudge' : 'Drag to push pixels'} · [ ] size · Shift+[ ] hardness · 1–0 strength · Space to pan`;
    case 'cloneStamp': return 'Alt-click to set the source · Drag to clone · [ ] size · Shift+[ ] hardness · 1–0 opacity · Space to pan';
    case 'spotHealing': return 'Drag over blemishes to heal · [ ] size · Shift+[ ] hardness · Esc cancel · Space to pan';
    case 'shape': return `Drag to draw a shape on a new layer · Shift ${s.shapeKind === 'Rectangle' ? 'square' : 'circle'} · Alt from center · Shift+U ${s.shapeKind === 'Rectangle' ? 'ellipse' : 'rectangle'} · Esc cancel · Space to pan`;
    case 'gradient': return 'Drag to draw · Drag the ends to adjust · Shift 45° · 1–0 opacity · Enter apply · Esc cancel';
    case 'crop': return 'Drag to crop · Enter apply · Esc cancel · Space to pan';
    case 'move': return 'Drag to move · Handles to resize · Circle to rotate · 1–0 layer opacity · Space to pan';
    case 'hand': return 'Drag to pan · Ctrl+wheel or pinch to zoom';
    case 'idle': return 'No tool selected · Press a tool’s key to pick one · Space to pan';
    case 'eyedropper': return 'Click or drag to pick the foreground color from the canvas';
    case 'zoom': return 'Click to zoom in · Alt-click to zoom out · Drag right or left to zoom smoothly · Space to pan';
  }
}

export function StatusBar({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    zoom: x.viewport.zoom, width: x.document?.width ?? 0, height: x.document?.height ?? 0, hasDocument: !!x.document,
    busy: x.showsBusy, importing: x.isImporting, hint: hint(x),
  }));
  const zoom = s.zoom * 100;
  return (
    <div className="status-bar">
      {s.hasDocument ? <>
        <span className="status-zoom" data-testid="zoomStatus">{+zoom.toFixed(1)}%</span>
        <span data-testid="canvasDimensions">{s.width} × {s.height} px</span>
        <span>sRGB · Transparent</span>
      </> : <span>Ready when you are</span>}
      <span className="spacer" />
      {s.busy ? <><Spinner size={10} /><span>Working…</span></>
        : s.importing ? <><Spinner size={10} /><span>Importing images…</span></>
        : <span className="status-hint">{s.hint}</span>}
    </div>
  );
}
