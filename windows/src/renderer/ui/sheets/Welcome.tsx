// What an empty project shows in place of the canvas (NewCanvasSheet.swift): a new canvas's size (the clipboard
// image's, when there is one), opening a project, or importing an image.
import { useEffect, useRef, useState } from 'react';
import { X as Times } from 'lucide-react';
import type { EditorSession, Workspace } from '../../session';
import { validDimension } from '../../model/document';
import { Button } from '../controls';
import { useSelect } from '../hooks';

/** The first project at launch keeps the standard size; later new canvases suggest the clipboard image's. */
let firstWelcome = true;

/** The size of the image on the system clipboard, read from its PNG header. */
async function clipboardDimensions(): Promise<{ width: number; height: number } | null> {
  try {
    const png = await window.compositor?.readClipboardImage();
    if (!png || png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return null;
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const width = view.getUint32(16), height = view.getUint32(20);
    return validDimension(String(width)) && validDimension(String(height)) ? { width, height } : null;
  } catch { return null; }
}

export function Welcome({ session, workspace }: { session: EditorSession; workspace: Workspace }) {
  const [width, setWidth] = useState('1920');
  const [height, setHeight] = useState('1080');
  const widthField = useRef<HTMLInputElement>(null);
  const valid = validDimension(width) !== null && validDimension(height) !== null;
  const busy = useSelect(session, (s) => s.isImporting || s.showsBusy);
  useEffect(() => {
    const skip = firstWelcome;
    firstWelcome = false;
    if (!skip) {
      void clipboardDimensions().then((size) => {
        if (size) { setWidth(String(size.width)); setHeight(String(size.height)); }
      });
    }
    widthField.current?.focus();
    widthField.current?.select();
  }, []);
  const create = () => {
    const w = validDimension(width), h = validDimension(height);
    if (w !== null && h !== null) session.createNewProject(w, h);
  };
  const dimension = (title: string, value: string, set: (v: string) => void, ref?: React.Ref<HTMLInputElement>) => (
    <label className="welcome-dimension">
      <span className="welcome-label">{title}</span>
      <span className="welcome-input">
        <input ref={ref} value={value} onChange={(e) => set(e.target.value)} aria-label={title} data-testid={`${title.toLowerCase()}Input`}
          inputMode="numeric" spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } else if (e.key === 'Escape') e.currentTarget.blur(); }} />
        <span className="hint">px</span>
      </span>
    </label>
  );
  return (
    <div className="welcome" data-testid="welcome">
      <div className={`welcome-card${busy ? ' disabled' : ''}`}>
        <div>
          <h1>New canvas</h1>
          <div className="hint">A blank space for your next composition.</div>
        </div>
        <div className="welcome-dimensions">
          {dimension('Width', width, setWidth, widthField)}
          <Times size={16} className="welcome-times" />
          {dimension('Height', height, setHeight)}
        </div>
        <div className={valid ? 'hint' : 'warning'}>{valid ? 'Transparent canvas · sRGB' : 'Enter whole numbers from 1 to 30,000 pixels.'}</div>
        <div className="row">
          <Button onClick={() => void workspace.open()}>Open project</Button>
          <Button onClick={() => void session.chooseImagesToImport()}>Import image</Button>
          <span className="spacer" />
          <Button kind="primary" disabled={!valid} onClick={create} testId="createCanvas">Create canvas</Button>
        </div>
        <div className="hint welcome-tip">Tip: drop images or .comp projects anywhere in this window to open them.</div>
      </div>
    </div>
  );
}
