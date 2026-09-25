// Alerts (the session's questions and errors), About and the keyboard shortcut reference.
import { useEffect, useState } from 'react';
import type { AlertRequest } from '../../session/session';
import { Button } from '../controls';
import { Sheet } from './Sheet';

/** A question or an error: its buttons left to right, the first the default (Enter), `cancel` for Escape. */
export function AlertSheet({ alert }: { alert: AlertRequest }) {
  const cancel = alert.cancel ?? alert.buttons.length - 1;
  return (
    <Sheet onOK={() => alert.resolve(0)} onCancel={() => alert.resolve(cancel)} width={420} testId="alert" label={alert.title}>
      <div className="alert-body">
        <img src="assets/icon.png" alt="" className="alert-icon" />
        <div className="column">
          <h3>{alert.title}</h3>
          {alert.message ? <p className="alert-message">{alert.message}</p> : null}
        </div>
      </div>
      {/* Windows' order: the default first, Cancel last. */}
      <div className="sheet-buttons">
        <span className="spacer" />
        <Button kind="primary" onClick={() => alert.resolve(0)} testId="alertButton0">{alert.buttons[0]}</Button>
        {alert.buttons.map((title, index) => index === 0 || index === cancel ? null : (
          <Button key={title} onClick={() => alert.resolve(index)} testId={`alertButton${index}`}>{title}</Button>
        ))}
        {cancel > 0 ? <Button onClick={() => alert.resolve(cancel)} testId={`alertButton${cancel}`}>{alert.buttons[cancel]}</Button> : null}
      </div>
    </Sheet>
  );
}

/** A plain message with OK (import, brush and crop errors). */
export function MessageSheet({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return <AlertSheet alert={{ title, message, buttons: ['OK'], cancel: 0, resolve: () => onClose() }} />;
}

export function AboutSheet({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState('');
  useEffect(() => { void window.compositor?.version().then(setVersion); }, []);
  return (
    <Sheet onOK={onClose} onCancel={onClose} width={380} testId="about" label="About Compositor">
      <div className="about">
        <img src="assets/icon.png" alt="" width={72} height={72} />
        <h2>Compositor</h2>
        <div className="hint">Version {version || '—'} for Windows</div>
        <p>A free image editor for compositing and retouching: layers, masks, selections, brushes, adjustments and filters.</p>
        <Button kind="plain" onClick={() => void window.compositor?.openExternal('https://github.com/rambo-mn/Compositor')}>github.com/rambo-mn/Compositor</Button>
      </div>
      <div className="sheet-buttons"><span className="spacer" /><Button kind="primary" onClick={onClose}>OK</Button></div>
    </Sheet>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['Tools', [
    ['V', 'Move / Transform'], ['M', 'Marquee (Rectangle / Ellipse)'], ['L', 'Lasso (Freehand / Polygonal)'], ['W', 'Magic Wand'],
    ['C', 'Crop'], ['B', 'Brush'], ['E', 'Eraser'], ['J', 'Spot Healing Brush'], ['S', 'Clone Stamp'], ['R', 'Smear (Liquify, Blur, Smudge)'],
    ['G', 'Gradient'], ['U', 'Shape · Shift+U switches Rectangle / Ellipse'], ['I', 'Eyedropper'], ['H', 'Hand'], ['Z', 'Zoom'], ['A', 'No tool'],
  ]],
  ['Painting', [
    ['[  ]', 'Brush size smaller / larger'], ['Shift+[  ]', 'Brush softer / harder'], ['1 … 9, 0', 'Opacity 10–90%, 100% (type two digits for e.g. 45%)'],
    ['Right-drag', 'Resize the brush; with Shift, change its hardness'], ['Shift-click', 'Paint a straight line from the last stroke'],
    ['Shift while painting', 'Keep the stroke horizontal or vertical'], ['Alt-click', 'Clone Stamp: set the source · other brushes: pick a color'],
    ['X', 'Swap foreground and background'], ['D', 'Default colors'], ['Esc', 'Cancel the stroke'],
  ]],
  ['Selections', [
    ['Shift-drag', 'Add to the selection'], ['Alt-drag', 'Subtract from the selection'], ['Shift (again, mid-drag)', 'Square or circle'],
    ['Drag inside', 'Move the selection outline'], ['Ctrl-drag inside', 'Cut and move the selected pixels'], ['Ctrl+Alt-drag inside', 'Copy and move the selected pixels'],
    ['Arrows', 'Nudge the selection (Shift: 10 px)'], ['Ctrl+Arrows', 'Nudge the selected pixels'], ['Delete', 'Clear the selected pixels'],
    ['Alt+Backspace / Ctrl+Backspace', 'Fill with the foreground / background color'], ['Shift+Backspace', 'Content-Aware Fill'],
    ['Ctrl+A / Ctrl+D / Ctrl+Shift+I', 'Select all / Deselect / Inverse'],
  ]],
  ['Move and transform', [
    ['Drag', 'Move the layer; handles resize, the circle rotates'], ['Shift', 'Keep proportions (or unlock them), 15° rotation steps, one axis'],
    ['Alt-drag', 'Duplicate the layer · Alt on a handle scales about the centre'], ['Ctrl-drag a handle', 'Distort (perspective)'],
    ['Ctrl-click', 'Pick the layer under the pointer'], ['Ctrl while dragging', 'Move without snapping'], ['Arrows', 'Nudge (Shift: 10 px)'],
    ['Enter / Esc', 'Apply / cancel'], ['Ctrl+T', 'Transform'], ['Ctrl+H', 'Show or hide the transform controls'],
  ]],
  ['View', [
    ['Space-drag, middle-drag', 'Pan'], ['Mouse wheel', 'Scroll (Shift: sideways)'], ['Ctrl+wheel, Alt+wheel, pinch', 'Zoom'],
    ['Ctrl+0 / Ctrl+1', 'Fit / Actual pixels'], ['Ctrl+= / Ctrl+-', 'Zoom in / out'], ['F11', 'Full screen'],
  ]],
  ['Layers', [
    ['Ctrl+Shift+N', 'New blank layer'], ['Ctrl+J', 'Duplicate layer / Layer via Copy'], ['Ctrl+G', 'Group into a folder'], ['Ctrl+E', 'Merge'],
    ['Ctrl+] / Ctrl+[', 'Move layer up / down'], ['Ctrl+Alt+G', 'Create / release clipping mask'], ['Shift++ / Shift+-', 'Next / previous blend mode'],
    ['Alt-click row bottom', 'Clip to the layer below'], ['Ctrl-click thumbnail', 'Select its pixels'], ['Shift-click mask', 'Turn the mask off / on'],
  ]],
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onOK={onClose} onCancel={onClose} width={720} testId="shortcuts" label="Keyboard Shortcuts">
      <h2>Keyboard Shortcuts</h2>
      <div className="shortcuts">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group}>
            <h4>{group}</h4>
            <table><tbody>
              {rows.map(([keys, action]) => <tr key={keys + action}><td className="keys">{keys}</td><td>{action}</td></tr>)}
            </tbody></table>
          </section>
        ))}
      </div>
      <div className="sheet-buttons"><span className="spacer" /><Button kind="primary" onClick={onClose}>Close</Button></div>
    </Sheet>
  );
}
