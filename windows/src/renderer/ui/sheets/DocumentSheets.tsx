// Canvas Size, Image Size and Export JPEG (CanvasSizeSheet, ImageSizeSheet and JPEGExportSheet in the Mac app).
import { useEffect, useRef, useState } from 'react';
import { Circle, CircleDot } from 'lucide-react';
import type { EditorSession } from '../../session';
import { Button, NumberField, Select, Slider, Spinner, Toggle } from '../controls';
import { Sheet } from './Sheet';
import {
  CANVAS_UNITS, CanvasSizeDraft, CanvasUnit, canvasDraftDisplayed, canvasDraftSet, canvasDraftValid, makeCanvasSizeDraft,
  type CanvasExtensionColor,
} from '../../model/crop';
import { LAYER_SAMPLINGS, type LayerSampling } from '../../model/transform';
import { fromHex, toHex } from '../../model/color';
import { encodeJPEG } from '../../io/codecs';
import { unpremultiply } from '../../raster/raster';

/** Like the Mac's memory byte counts: "8.3 MB". */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const ANCHORS = ['Top left', 'Top center', 'Top right', 'Middle left', 'Center', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'];
const EXTENSIONS = ['Transparent', 'Foreground', 'Background', 'Black', 'White', 'Custom'];

export function CanvasSizeSheet({ session, onClose }: { session: EditorSession; onClose: () => void }) {
  const document = session.document!;
  const [draft, setDraft] = useState<CanvasSizeDraft>(() => makeCanvasSizeDraft(document.width, document.height, document.resolution));
  const [anchor, setAnchor] = useState(4);
  const [extension, setExtension] = useState('Transparent');
  const [custom, setCustom] = useState('#FFFFFF');
  const valid = canvasDraftValid(draft);
  const width = Math.round(draft.width), height = Math.round(draft.height);
  const fill = (): CanvasExtensionColor | null => {
    switch (extension) {
      case 'Transparent': return null;
      case 'Black': return { red: 0, green: 0, blue: 0 };
      case 'White': return { red: 1, green: 1, blue: 1 };
      case 'Foreground': return { ...session.foregroundColor };
      case 'Background': return { ...session.backgroundColor };
      default: return fromHex(custom) ?? { red: 1, green: 1, blue: 1 };
    }
  };
  const ok = () => {
    if (!valid) return;
    session.resizeCanvasTo({ width, height, anchor, fill: fill(), contentOffset: null });
    onClose();
  };
  return (
    <Sheet onOK={ok} onCancel={onClose} width={450} testId="canvasSizeSheet" label="Canvas Size">
      <h2>Canvas Size</h2>
      <div>Current: {draft.originalWidth} × {draft.originalHeight} pixels</div>
      <div className="hint">{formatBytes(draft.originalWidth * draft.originalHeight * 4)} uncompressed RGBA canvas</div>
      <div className="divider" />
      <div className="form-row"><span>Units</span>
        <Select options={CANVAS_UNITS.map((u) => ({ value: u, label: u }))} value={draft.unit} onChange={(unit: CanvasUnit) => setDraft({ ...draft, unit })} />
      </div>
      <div className="form-row"><span>Width</span>
        <NumberField value={canvasDraftDisplayed(draft, true)} decimals={3} width={120} align="left" label="Width" testId="canvasWidth"
          onChange={(v) => setDraft((d) => canvasDraftSet(d, v, true))} />
      </div>
      <div className="form-row"><span>Height</span>
        <NumberField value={canvasDraftDisplayed(draft, false)} decimals={3} width={120} align="left" label="Height" testId="canvasHeight"
          onChange={(v) => setDraft((d) => canvasDraftSet(d, v, false))} />
      </div>
      <Toggle label="Relative to current dimensions" checked={draft.relative} onChange={(relative) => setDraft({ ...draft, relative })} />
      <Toggle label="Lock original aspect ratio" checked={draft.locked}
        onChange={(locked) => setDraft((d) => { const next = { ...d, locked }; return locked ? canvasDraftSet(next, canvasDraftDisplayed(next, true), true) : next; })} />
      {valid
        ? <div className="hint">New: {width} × {height} pixels · {formatBytes(width * height * 4)} uncompressed</div>
        : <div className="warning">Final dimensions must be 1–30,000 pixels per side.</div>}
      <div className="row top">
        <div className="column">
          <span>Anchor</span>
          <div className="anchor-grid">
            {ANCHORS.map((name, index) => (
              <button key={name} type="button" className={`anchor-cell${index === anchor ? ' selected' : ''}`} title={name} aria-label={name}
                aria-pressed={index === anchor} onMouseDown={(e) => e.preventDefault()} onClick={() => setAnchor(index)}>
                {index === anchor ? <CircleDot size={14} /> : <Circle size={14} />}
              </button>
            ))}
          </div>
        </div>
        <div className="column" style={{ paddingTop: 22 }}>
          <strong>{ANCHORS[anchor]}</strong>
          <span className="hint">Keeps this point fixed. Artwork is not scaled; cropped content remains outside the canvas.</span>
        </div>
      </div>
      <div className="form-row"><span>Canvas extension</span>
        <Select options={EXTENSIONS.map((e) => ({ value: e, label: e }))} value={extension} onChange={setExtension} />
        {extension === 'Custom' ? <input type="color" className="color-input" value={custom.toLowerCase()} aria-label="Extension color"
          onChange={(e) => setCustom(e.target.value.toUpperCase())} /> : null}
      </div>
      <div className="sheet-buttons">
        <Button onClick={onClose}>Cancel</Button>
        <span className="spacer" />
        <Button kind="primary" disabled={!valid} onClick={ok} testId="canvasSizeOK">OK</Button>
      </div>
    </Sheet>
  );
}

export function ImageSizeSheet({ session, onClose }: { session: EditorSession; onClose: () => void }) {
  const document = session.document!;
  const [width, setWidth] = useState(document.width);
  const [height, setHeight] = useState(document.height);
  const [resolution, setResolution] = useState(document.resolution);
  const [locked, setLocked] = useState(true);
  const [resample, setResample] = useState(true);
  const [unit, setUnit] = useState('Pixels');
  const [sampling, setSampling] = useState<LayerSampling>('High quality');
  const valid = [width, height, resolution].every(Number.isFinite) && resolution >= 1 && resolution <= 9600
    && Math.round(width) >= 1 && Math.round(width) <= 30_000 && Math.round(height) >= 1 && Math.round(height) <= 30_000
    && (!resample || Math.round(width) * Math.round(height) <= 100_000_000);
  const display = (pixels: number, original: number) => {
    switch (unit) {
      case 'Percent': return pixels / original * 100;
      case 'Inches': return pixels / resolution;
      case 'Centimeters': return pixels / resolution * 2.54;
      default: return pixels;
    }
  };
  const setDimension = (value: number, isWidth: boolean) => {
    if (!(Number.isFinite(value) && value > 0)) return;
    if (!resample) {
      setResolution((isWidth ? width : height) / value * (unit === 'Centimeters' ? 2.54 : 1));
      return;
    }
    const original = isWidth ? document.width : document.height;
    const pixels = unit === 'Percent' ? value / 100 * original : unit === 'Inches' ? value * resolution : unit === 'Centimeters' ? value / 2.54 * resolution : value;
    if (isWidth) {
      if (locked) setHeight(pixels * height / width);
      setWidth(pixels);
    } else {
      if (locked) setWidth(pixels * width / height);
      setHeight(pixels);
    }
  };
  const changeResolution = (next: number) => {
    if (resample && (unit === 'Inches' || unit === 'Centimeters') && resolution > 0 && next > 0 && Number.isFinite(next)) {
      setWidth((w) => w * next / resolution);
      setHeight((h) => h * next / resolution);
    }
    setResolution(next);
  };
  const ok = () => {
    if (!valid) return;
    void session.resizeImageTo(Math.round(width), Math.round(height), resolution, sampling);
    onClose();
  };
  const units = ['Pixels', 'Percent', 'Inches', 'Centimeters'].filter((u) => resample || (u !== 'Pixels' && u !== 'Percent'));
  return (
    <Sheet onOK={ok} onCancel={onClose} width={430} testId="imageSizeSheet" label="Image Size">
      <h2>Image Size</h2>
      <div className="hint">Current: {document.width} × {document.height} pixels</div>
      <div className="form-row"><span>Units</span><Select options={units.map((u) => ({ value: u, label: u }))} value={unit} onChange={setUnit} /></div>
      <div className="form-row"><span>Width</span>
        <NumberField value={display(width, document.width)} decimals={3} width={120} align="left" label="Width" testId="imageWidth" onChange={(v) => setDimension(v, true)} />
      </div>
      <div className="form-row"><span>Height</span>
        <NumberField value={display(height, document.height)} decimals={3} width={120} align="left" label="Height" testId="imageHeight" onChange={(v) => setDimension(v, false)} />
      </div>
      <Toggle label="Lock aspect ratio" checked={locked} disabled={!resample} onChange={setLocked} />
      <div className="form-row"><span>Resolution</span>
        <NumberField value={resolution} decimals={3} width={90} align="left" label="Resolution" onChange={changeResolution} />
        <span className="hint">pixels/inch</span>
      </div>
      <Toggle label="Resample" checked={resample} onChange={(enabled) => {
        setResample(enabled);
        if (!enabled) {
          setWidth(document.width);
          setHeight(document.height);
          setLocked(true);
          if (unit === 'Pixels' || unit === 'Percent') setUnit('Inches');
        }
      }} />
      {resample ? <>
        <div className="form-row"><span>Sampling</span>
          <Select options={LAYER_SAMPLINGS.map((v) => ({ value: v, label: v }))} value={sampling} onChange={setSampling} />
        </div>
        <div className="hint">Resizes layer pixels and applies existing transforms. Undo restores the originals.</div>
      </> : <div className="hint">Only print dimensions and resolution change. Pixels stay unchanged.</div>}
      <div className={valid ? 'hint' : 'warning'}>
        {valid ? `Result: ${Math.round(width)} × ${Math.round(height)} pixels` : 'Use 1–30,000 pixels per side, up to 100 megapixels, and 1–9,600 pixels/inch.'}
      </div>
      <div className="sheet-buttons">
        <Button onClick={onClose}>Cancel</Button>
        <span className="spacer" />
        <Button kind="primary" disabled={!valid} onClick={ok} testId="imageSizeOK">Resize</Button>
      </div>
    </Sheet>
  );
}

const QUALITY_KEY = 'jpegExportQuality';

function savedQuality(): number {
  try {
    const value = Number(localStorage.getItem(QUALITY_KEY));
    return localStorage.getItem(QUALITY_KEY) !== null && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.9;
  } catch { return 0.9; }
}

export function JPEGExportSheet({ session, onClose }: { session: EditorSession; onClose: () => void }) {
  const document = session.document!;
  const [quality, setQuality] = useState(savedQuality);
  const [matte, setMatte] = useState('#FFFFFF');
  const [result, setResult] = useState<{ data: Uint8Array; url: string; key: string } | null>(null);
  // The document flattened once; each quality or matte change only re-encodes it.
  const [flattened] = useState(() => {
    try {
      const flat = session.renderFlattened();
      unpremultiply(flat);
      return { pixels: flat, error: null as string | null };
    } catch (e) { return { pixels: null, error: (e as Error).message }; }
  });
  const pixels = flattened.pixels;
  const [error, setError] = useState<string | null>(flattened.error);
  const key = `${quality.toFixed(2)}|${matte}`;
  const request = useRef(0);
  useEffect(() => {
    if (!pixels) return;
    const id = ++request.current;
    setError(null);
    const timer = setTimeout(() => {
      const color = fromHex(matte) ?? { red: 1, green: 1, blue: 1 };
      encodeJPEG(pixels, document.width, document.height, quality, [color.red, color.green, color.blue], document.resolution)
        .then((data) => {
          if (id !== request.current) return;
          setResult((previous) => {
            if (previous) URL.revokeObjectURL(previous.url);
            return { data, url: URL.createObjectURL(new Blob([data.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })), key };
          });
        })
        .catch((e) => { if (id === request.current) setError((e as Error).message); });
    }, 200);
    return () => clearTimeout(timer);
  }, [pixels, quality, matte]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  const ready = !!result && result.key === key && !error;
  const exportFile = () => {
    if (!ready || !result) return;
    try { localStorage.setItem(QUALITY_KEY, String(quality)); } catch { /* not remembered */ }
    const data = result.data;
    onClose();
    void session.saveJPEG(data);
  };
  return (
    <Sheet onOK={exportFile} onCancel={onClose} testId="jpegExportSheet" label="Export JPEG">
      <h2>Export JPEG</h2>
      <div className="jpeg-preview">
        {result ? <img src={result.url} alt="JPEG preview" /> : null}
        {!ready && !error ? <div className="preview-busy"><Spinner size={18} /></div> : null}
      </div>
      <div className="form-row"><span>Quality</span>
        <Slider value={quality} min={0} max={1} step={0.01} width="100%" onChange={(v) => setQuality(Math.round(v * 100) / 100)} label="Quality" testId="jpegQuality" />
        <span className="mono" style={{ width: 45, textAlign: 'right' }}>{Math.round(quality * 100)}%</span>
      </div>
      <div className="form-row"><span>Background for transparency</span>
        <input type="color" className="color-input" value={matte.toLowerCase()} aria-label="Background for transparency" onChange={(e) => setMatte(toHex(fromHex(e.target.value)!))} />
      </div>
      <div className="hint">{document.width} × {document.height} px · sRGB</div>
      <div className="sheet-buttons">
        {error ? <span className="error">{error}</span>
          : ready && result ? <span>{formatBytes(result.data.length)} <span className="hint">· encoded preview, fitted to window</span></span>
          : <span className="hint">Updating preview…</span>}
        <span className="spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={!ready} onClick={exportFile} testId="jpegExportOK">Export…</Button>
      </div>
    </Sheet>
  );
}
