// Hue/Saturation (HueSaturationSheet.swift): Master or one colour range, hue, saturation and lightness, the range's
// band on two spectrum bars, eyedroppers that set the band from the image, the targeted adjustment (drag on the
// image), Colorize and Preview.
import { useEffect, useRef } from 'react';
import { Hand, Pipette, Plus, Minus } from 'lucide-react';
import type { EditorSession } from '../../session';
import { useSelect } from '../hooks';
import { Button, NumberField, Select, Slider, Toggle } from '../controls';
import { FloatingPanel } from './FloatingPanel';
import {
  COLOR_RANGES_ALL, HueSaturationSettings, bandHandles, bandWithHandle, colorizeStart, hsBand, hsHue, hsLightness, hsSaturation,
  hsWith, hsWithBand, makeHueSaturation, shiftedHue, type RangeAdjustment,
} from '../../model/adjustments';

type SampleMode = 'replace' | 'add' | 'remove';
const SAMPLE_MODES: { mode: SampleMode; help: string }[] = [
  { mode: 'replace', help: 'Set the color range from a color you click in the image' },
  { mode: 'add', help: 'Widen the color range to include a color you click' },
  { mode: 'remove', help: 'Narrow the color range to leave out a color you click' },
];

export function HueSaturationPanel({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    settings: x.hueSaturation?.settings ?? makeHueSaturation(), preview: x.hueSaturation?.preview ?? true,
    sample: x.hueSampleMode, targeting: x.hueTargeting, limited: !x.adjustmentOriginal && !!x.selection,
  }));
  const current = s.settings;
  const update = (settings: HueSaturationSettings) => session.updateHueSaturation(settings, session.hueSaturation?.preview ?? true);
  const showsSpectrum = current.range !== 'Master' && !current.colorize;
  const slider = (title: string, key: keyof RangeAdjustment, value: number, min: number, max: number, unit: string) => (
    <div className="slider-row">
      <span className="slider-label">{title}</span>
      <Slider value={value} min={min} max={max} width="100%" label={title} onChange={(v) => update(hsWith(session.hueSaturation!.settings, key, Math.round(v)))} />
      <NumberField value={value} min={min} max={max} width={48} suffix={unit} label={title} testId={`hs${title}`}
        onChange={(v) => update(hsWith(session.hueSaturation!.settings, key, v))} />
    </div>
  );
  return (
    <FloatingPanel name="hueSaturation" title="Hue/Saturation" onCancel={() => session.cancelHueSaturation()}
      onOK={() => void session.commitHueSaturation()} testId="hueSaturationPanel">
      <div className="panel-content" style={{ width: 412 }}>
        <div className="row">
          <Select options={COLOR_RANGES_ALL.map((r) => ({ value: r, label: r }))} value={current.range} width={160} label="Range"
            disabled={current.colorize} onChange={(range) => update({ ...session.hueSaturation!.settings, range })} />
          <span className="spacer" />
          {showsSpectrum ? SAMPLE_MODES.map(({ mode, help }) => (
            <Button key={mode} kind="icon" active={s.sample === mode} title={help} label={`${mode} color`}
              onClick={() => { session.hueTargeting = false; session.hueSampleMode = s.sample === mode ? null : mode; }}>
              <span className="badged"><Pipette size={14} />{mode === 'add' ? <Plus size={8} className="badge" /> : mode === 'remove' ? <Minus size={8} className="badge" /> : null}</span>
            </Button>
          )) : null}
          {!current.colorize ? (
            <Button kind="icon" active={s.targeting} label="Targeted adjustment"
              title="Targeted adjustment: drag on the image to change that color's saturation, or its hue with Ctrl held"
              onClick={() => { session.hueSampleMode = null; session.hueTargeting = !session.hueTargeting; }}>
              <Hand size={14} />
            </Button>
          ) : null}
        </div>
        {slider('Hue', 'hue', hsHue(current), current.colorize ? 0 : -180, current.colorize ? 360 : 180, '°')}
        {slider('Saturation', 'saturation', hsSaturation(current), current.colorize ? 0 : -100, 100, '')}
        {slider('Lightness', 'lightness', hsLightness(current), -100, 100, '')}
        {showsSpectrum ? <>
          <SpectrumEditor settings={current} onChange={update} />
          <Toggle label="Apply outside this range instead" checked={current.invertRange}
            onChange={(v) => update({ ...session.hueSaturation!.settings, invertRange: v })} />
        </> : null}
        <div className="row">
          <Toggle label="Colorize" checked={current.colorize} testId="hsColorize"
            // Photoshop starts colorizing at hue 0, saturation 25.
            onChange={(v) => update(v ? colorizeStart() : makeHueSaturation())} />
          <Toggle label="Preview" checked={s.preview} onChange={(v) => session.updateHueSaturation(session.hueSaturation!.settings, v)} />
          <Button onClick={() => update(current.colorize ? colorizeStart() : makeHueSaturation())}>Reset</Button>
          <span className="spacer" />
        </div>
        {s.limited ? <div className="hint">Limited to the selection</div> : null}
        <div className="panel-buttons">
          <Button onClick={() => session.cancelHueSaturation()}>Cancel</Button>
          <span className="spacer" />
          <Button kind="primary" onClick={() => void session.commitHueSaturation()} testId="hueSaturationOK">OK</Button>
        </div>
      </div>
    </FloatingPanel>
  );
}

/** Photoshop's two spectrum bars: the hues as they are, the handles for the range's band, and the hues as the
 *  adjustment leaves them. Outer marks are the falloff shoulders; inner bars the full-strength range. */
function SpectrumEditor({ settings, onChange }: { settings: HueSaturationSettings; onChange: (s: HueSaturationSettings) => void }) {
  const band = hsBand(settings);
  const handles = bandHandles(band);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const degreesAt = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * 360;
  };
  const nearest = (degrees: number) => {
    const distances = handles.map((h) => { const gap = Math.abs(h - degrees) % 360; return Math.min(gap, 360 - gap); });
    return distances.indexOf(Math.min(...distances));
  };
  return (
    <div className="spectrum">
      <SpectrumBar settings={settings} after={false} />
      <div className="spectrum-handles" ref={track}
        onPointerDown={(event) => {
          event.preventDefault();
          const element = event.currentTarget;
          element.setPointerCapture(event.pointerId);
          const degrees = degreesAt(event.clientX);
          dragging.current = nearest(degrees);
          onChange(hsWithBand(settings, bandWithHandle(band, dragging.current, degrees)));
          let latest = settings;
          const move = (e: PointerEvent) => {
            if (dragging.current === null) return;
            latest = hsWithBand(latest, bandWithHandle(hsBand(latest), dragging.current, degreesAt(e.clientX)));
            onChange(latest);
          };
          const up = () => { dragging.current = null; element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
          element.addEventListener('pointermove', move);
          element.addEventListener('pointerup', up);
        }}>
        {handles.map((degrees, index) => (
          <span key={index} className={index === 1 || index === 2 ? 'band-inner' : 'band-outer'} style={{ left: `${degrees / 360 * 100}%` }} />
        ))}
      </div>
      <SpectrumBar settings={settings} after />
      <div className="hint mono">{handles.map((h) => `${Math.round(h)}°`).join('   ')}</div>
    </div>
  );
}

function SpectrumBar({ settings, after }: { settings: HueSaturationSettings; after: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const slices = 72;
    canvas.width = slices;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    for (let slice = 0; slice < slices; slice++) {
      const hue = slice / slices * 360;
      const shown = after ? shiftedHue(hue, settings) : hue;
      ctx.fillStyle = `hsl(${shown}, 100%, 50%)`;
      ctx.fillRect(slice, 0, 1, 1);
    }
  }, [settings, after]);
  return <canvas className="spectrum-bar" ref={ref} />;
}
