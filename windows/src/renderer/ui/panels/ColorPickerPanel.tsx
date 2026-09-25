// The colour picker (ColorPickerSheet.swift): a saturation/brightness field, a vertical hue strip, the new colour,
// RGB and hex entry, and sampling by clicking the canvas. Nothing is written to the palette until OK.
import { useEffect, useState } from 'react';
import type { EditorSession } from '../../session';
import { pickerColor } from '../../session/palette';
import { useSelect } from '../hooks';
import { Button, NumberField } from '../controls';
import { FloatingPanel } from './FloatingPanel';
import { cssColor, fromHex, hsbToRGB, toHex } from '../../model/color';

const FIELD = 256;

export function ColorPickerPanel({ session }: { session: EditorSession }) {
  const picker = useSelect(session, (s) => s.colorPicker);
  const [hexDraft, setHexDraft] = useState('');
  const [hexFocused, setHexFocused] = useState(false);
  const color = picker ? pickerColor(picker) : { red: 0, green: 0, blue: 0 };
  const hex = toHex(color);
  useEffect(() => { if (!hexFocused) setHexDraft(hex); }, [hex, hexFocused]);
  if (!picker) return null;
  const target = picker.target;
  const title = target.kind === 'palette'
    ? (target.background ? 'Color Picker (Background Color)' : 'Color Picker (Foreground Color)')
    : (target.highlights ? 'Color Picker (Gradient Map Highlights)' : 'Color Picker (Gradient Map Shadows)');
  const hsb = { hue: picker.hue, saturation: picker.saturation, brightness: picker.brightness };

  const dragIn = (event: React.PointerEvent<HTMLDivElement>, apply: (x: number, y: number) => void) => {
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const at = (e: { clientX: number; clientY: number }) => {
      const box = element.getBoundingClientRect();
      apply(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)));
    };
    at(event);
    const move = (e: PointerEvent) => at(e);
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };
  const commitHex = () => {
    const parsed = fromHex(hexDraft);
    if (parsed) session.setColorPickerRGB(parsed);
    setHexDraft(toHex(parsed ?? color));
  };
  const channel = (label: 'R' | 'G' | 'B', key: 'red' | 'green' | 'blue') => (
    <div className="picker-channel">
      <span>{label}</span>
      <NumberField value={Math.round(color[key] * 255)} min={0} max={255} width={52} label={label === 'R' ? 'Red' : label === 'G' ? 'Green' : 'Blue'}
        onChange={(v) => session.setColorPickerRGB({ ...pickerColor(session.colorPicker!), [key]: Math.round(v) / 255 })} />
    </div>
  );
  const pure = hsbToRGB({ hue: hsb.hue, saturation: 1, brightness: 1 });
  return (
    <FloatingPanel name="colorPicker" title={title} onCancel={() => session.closeColorPicker(false)} onOK={() => session.closeColorPicker(true)}
      testId="colorPicker">
      <div className="color-picker">
        <div className="sb-field" style={{ width: FIELD, height: FIELD, background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${cssColor(pure)})` }}
          aria-label="Saturation and brightness" onPointerDown={(event) => dragIn(event, (x, y) => {
            const current = session.colorPicker!;
            session.updateColorPicker({ hue: current.hue, saturation: x, brightness: 1 - y });
          })}>
          <span className="sb-marker" style={{ left: hsb.saturation * FIELD, top: (1 - hsb.brightness) * FIELD }} />
        </div>
        <div className="hue-strip" style={{ height: FIELD }} aria-label="Hue" aria-valuenow={Math.round(hsb.hue)}
          onPointerDown={(event) => dragIn(event, (_x, y) => {
            const current = session.colorPicker!;
            session.updateColorPicker({ hue: (1 - y) * 360, saturation: current.saturation, brightness: current.brightness });
          })}>
          <span className="hue-marker" style={{ top: (1 - hsb.hue / 360) * FIELD }} />
        </div>
        <div className="picker-side" style={{ height: FIELD }}>
          <div className="row top">
            <div className="picker-preview" style={{ background: cssColor(color) }} aria-label="New color" />
            <div className="column picker-buttons">
              <Button kind="primary" onClick={() => session.closeColorPicker(true)} testId="colorPickerOK">OK</Button>
              <Button onClick={() => session.closeColorPicker(false)}>Cancel</Button>
            </div>
          </div>
          <span className="spacer-v" />
          {channel('R', 'red')}
          {channel('G', 'green')}
          {channel('B', 'blue')}
          <div className="picker-channel">
            <span>#</span>
            <input className="field mono" value={hexDraft} style={{ width: 84 }} aria-label="Hex color" spellCheck={false}
              onFocus={(e) => { setHexFocused(true); e.currentTarget.select(); }}
              onBlur={() => { commitHex(); setHexFocused(false); }}
              onChange={(e) => setHexDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { commitHex(); e.currentTarget.blur(); } }} />
          </div>
          <div className="hint">Click the canvas to sample</div>
        </div>
      </div>
    </FloatingPanel>
  );
}
