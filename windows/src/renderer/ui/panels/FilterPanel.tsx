// The open filter's panel (FilterSheet.swift): its settings, Preview, and Cancel / OK. Covers the Image menu's
// Curves, Exposure, Gradient Map and Grain, the Filter menu, Content-Aware Fill and Remove Background.
import { useEffect, useRef, useState } from 'react';
import type { EditorSession } from '../../session';
import { useSelect } from '../hooks';
import { Button, NumberField, Segmented, Select, Slider, Spinner, Toggle } from '../controls';
import { FloatingPanel } from './FloatingPanel';
import { defaultFilterSettings, isAutomaticFilter, type FilterSettings } from '../../model/settings';
import {
  CurvesSettings, EXPOSURE_RANGE, GAMMA_RANGE, GradientMapSettings, LEVELS_CHANNELS, OFFSET_RANGE, channelIndex, curveValue,
  gradientMapEnds, identityCurve, type AdjustmentColor, type CurvePoint,
} from '../../model/adjustments';
import { cssColor } from '../../model/color';

export function FilterPanel({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    kind: x.filterEdit?.kind ?? 'Gaussian Blur', settings: x.filterEdit?.settings ?? defaultFilterSettings(), preview: x.filterEdit?.preview ?? true,
    error: x.filterEdit?.previewError ?? null, preparing: x.filterEdit?.preparing ?? false, committing: x.filterEdit?.committing ?? false,
    limited: !x.adjustmentOriginal && !!x.selection,
  }));
  const settings = s.settings;
  const update = (change: (value: FilterSettings) => FilterSettings) => {
    const edit = session.filterEdit;
    if (edit) session.updateFilter(change(edit.settings), edit.preview);
  };
  /** A slider plus an exact field; logarithmic sliders give the small values used most most of the travel. */
  const control = (title: string, value: number, set: (s: FilterSettings, v: number) => FilterSettings,
                   range: readonly [number, number], unit: string, decimals: number, log = false, help?: string) => {
    const step = 10 ** decimals;
    return (
      <div className="slider-row" title={help}>
        <span className="slider-label">{title}</span>
        <Slider value={value} min={range[0]} max={range[1]} log={log} width="100%" label={title}
          onChange={(v) => update((x) => set(x, Math.round(v * step) / step))} />
        <NumberField value={value} decimals={decimals} min={range[0]} max={range[1]} width={60} suffix={unit} label={title}
          testId={`filter${title.replace(/ /g, '')}`} onChange={(v) => update((x) => set(x, v))} />
      </div>
    );
  };
  let body: React.ReactNode;
  switch (s.kind) {
    case 'Curves':
      body = <CurvesControls settings={settings.curves} onChange={(curves) => update((x) => ({ ...x, curves }))} />;
      break;
    case 'Exposure':
      body = <>
        {control('Exposure', settings.exposure.exposure, (x, v) => ({ ...x, exposure: { ...x.exposure, exposure: v } }), EXPOSURE_RANGE, '', 2)}
        {control('Offset', settings.exposure.offset, (x, v) => ({ ...x, exposure: { ...x.exposure, offset: v } }), OFFSET_RANGE, '', 4)}
        {control('Gamma', settings.exposure.gamma, (x, v) => ({ ...x, exposure: { ...x.exposure, gamma: v } }), GAMMA_RANGE, '', 2, true)}
      </>;
      break;
    case 'Gradient Map':
      body = <GradientMapControls settings={settings.gradientMap} onChange={(gradientMap) => update((x) => ({ ...x, gradientMap }))}
        pick={(highlights) => session.openGradientMapColorPicker(highlights)} />;
      break;
    case 'Grain':
      body = <>
        {control('Amount', settings.grain.amount, (x, v) => ({ ...x, grain: { ...x.grain, amount: v } }), [0, 100], '', 0)}
        {control('Size', settings.grain.size, (x, v) => ({ ...x, grain: { ...x.grain, size: v } }), [0.5, 20], 'px', 1, true)}
        {control('Roughness', settings.grain.roughness, (x, v) => ({ ...x, grain: { ...x.grain, roughness: v } }), [0, 100], '', 0)}
      </>;
      break;
    case 'Remove Background':
      body = <>
        <p className="panel-text">Hide the background behind a layer mask, keeping the foreground subjects. The pixels stay, so the background can be painted back at any time.</p>
        <Segmented options={[{ value: 'Basic' as const, label: 'Basic' }, { value: 'Advanced' as const, label: 'Advanced' }]} value={settings.backgroundQuality}
          onChange={(v) => update((x) => ({ ...x, backgroundQuality: v }))} title="Basic is quick; Advanced refines the mask against the layer's own detail, for hair and fur" />
        {settings.backgroundQuality === 'Advanced' ? <>
          {control('Refine', settings.refineEdges, (x, v) => ({ ...x, refineEdges: v }), [0, 40], 'px', 0, false, 'Pull the mask onto the image’s own edges, which recovers hair and fur')}
          {control('Contrast', settings.matteContrast, (x, v) => ({ ...x, matteContrast: v }), [0, 100], '%', 0, false, 'Clear the haze that leaves background showing through thin areas')}
          {control('Shift Edge', settings.shiftEdge, (x, v) => ({ ...x, shiftEdge: v }), [-10, 10], 'px', 0, false, 'Shrink the mask to drop the rim of background color around the subject, or grow it')}
        </> : null}
      </>;
      break;
    case 'Content-Aware Fill':
      body = <p className="panel-text">Fill the selection using surrounding pixels from this layer.</p>;
      break;
    case 'Gaussian Blur':
      body = control('Radius', settings.radius, (x, v) => ({ ...x, radius: v }), [0.1, 250], 'px', 1, true);
      break;
    case 'Motion Blur':
      body = <>
        {control('Angle', settings.angle, (x, v) => ({ ...x, angle: v }), [-90, 90], '°', 0)}
        {control('Distance', settings.distance, (x, v) => ({ ...x, distance: v }), [1, 2000], 'px', 0, true)}
      </>;
      break;
    case 'Add Noise':
      body = <>
        {control('Amount', settings.amount, (x, v) => ({ ...x, amount: v }), [0.1, 400], '%', 1, true)}
        <Segmented options={[{ value: false, label: 'Uniform' }, { value: true, label: 'Gaussian' }]} value={settings.gaussian}
          onChange={(v) => update((x) => ({ ...x, gaussian: v }))} label="Distribution" />
        <Toggle label="Monochromatic" checked={settings.monochromatic} onChange={(v) => update((x) => ({ ...x, monochromatic: v }))} />
      </>;
      break;
    case 'Lens Correction':
      body = <>
        {control('Remove Distortion', settings.distortion, (x, v) => ({ ...x, distortion: v }), [-100, 100], '', 0)}
        <p className="hint">Positive straightens lines that bow outward (barrel); negative, lines that bow inward (pincushion).</p>
      </>;
      break;
  }
  const automatic = isAutomaticFilter(s.kind);
  return (
    <FloatingPanel name="filter" title={s.kind} onCancel={() => session.cancelFilter()} testId="filterPanel"
      onOK={() => { if (!(automatic && (s.preparing || s.error))) void session.commitFilter(); }}>
      <div className={`panel-content${s.committing ? ' disabled' : ''}`} style={{ width: s.kind === 'Curves' ? 360 : 332 }}>
        {body}
        <Toggle label="Preview" checked={s.preview} onChange={(v) => { const edit = session.filterEdit; if (edit) session.updateFilter(edit.settings, v); }} />
        {s.error ? <div className="warning">{s.error}</div> : null}
        {s.limited ? <div className="hint">Limited to the selection</div> : null}
        <div className="panel-buttons">
          <Button onClick={() => session.cancelFilter()}>Cancel</Button>
          <span className="spacer" />
          {/* While the preview is being worked out OK waits, so the panel says what it is waiting for. */}
          {s.committing || s.preparing ? <><Spinner /><span className="hint">{s.committing ? 'Applying…' : 'Working…'}</span></> : null}
          <Button kind="primary" disabled={automatic && (s.preparing || !!s.error)} onClick={() => void session.commitFilter()} testId="filterOK">OK</Button>
        </div>
      </div>
    </FloatingPanel>
  );
}

// MARK: Curves

export function CurvesControls({ settings, onChange }: { settings: CurvesSettings; onChange: (s: CurvesSettings) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const channel = channelIndex(settings.channel);
  const points = settings.channels[channel];
  const latest = useRef(settings);
  latest.current = settings;
  useEffect(() => { setSelected(null); }, [settings.channel]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const f = i / 4;
      ctx.moveTo(f * width, 0); ctx.lineTo(f * width, height);
      ctx.moveTo(0, f * height); ctx.lineTo(width, f * height);
    }
    ctx.stroke();
    const position = (p: CurvePoint) => ({ x: p.x / 255 * width, y: (1 - p.y / 255) * height });
    ctx.beginPath();
    for (let x = 0; x <= 255; x++) {
      const p = position({ x, y: curveValue(settings, x, channel) });
      if (x === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    points.forEach((point, i) => {
      const p = position(point);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = selected === i ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f8cff' : '#fff';
      ctx.fill();
    });
  }, [settings, channel, points, selected]);

  const setPoints = (next: CurvePoint[]) => {
    const channels = latest.current.channels.map((c, i) => (i === channel ? next : c));
    onChange({ ...latest.current, channels });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    const locate = (e: { clientX: number; clientY: number }) => {
      const box = canvas.getBoundingClientRect();
      return {
        x: Math.min(255, Math.max(0, (e.clientX - box.left) / box.width * 255)),
        y: Math.min(255, Math.max(0, 255 - (e.clientY - box.top) / box.height * 255)),
      };
    };
    let dragging: number | null = null;
    const apply = (e: { clientX: number; clientY: number }) => {
      const { x, y } = locate(e);
      const p = latest.current.channels[channel].map((q) => ({ ...q }));
      if (dragging === null) {
        let nearest = -1, distance = Infinity;
        p.forEach((q, i) => { const d = Math.hypot(q.x - x, q.y - y); if (d < distance) { distance = d; nearest = i; } });
        if (nearest >= 0 && distance < 14) dragging = nearest;
        else if (p.length < 32 && x > 1 && x < 254 && p.every((q) => Math.abs(q.x - x) > 1)) {
          p.push({ x, y });
          p.sort((a, b) => a.x - b.x);
          dragging = p.findIndex((q) => q.x === x);
        }
      }
      if (dragging === null || dragging < 0 || dragging >= p.length) return;
      setSelected(dragging);
      p[dragging].y = y;
      if (dragging > 0 && dragging < p.length - 1) p[dragging].x = Math.min(p[dragging + 1].x - 1, Math.max(p[dragging - 1].x + 1, x));
      setPoints(p);
    };
    apply(event);
    const move = (e: PointerEvent) => apply(e);
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  };

  const removable = selected !== null && selected > 0 && selected < points.length - 1;
  return (
    <div className="curves">
      <Select options={LEVELS_CHANNELS.map((c) => ({ value: c, label: c }))} value={settings.channel} label="Channel"
        onChange={(value) => onChange({ ...settings, channel: value })} />
      <canvas className="curves-graph" ref={ref} onPointerDown={onPointerDown} data-testid="curvesGraph" />
      <div className="hint">Click to add a point. Drag to adjust.</div>
      <div className="row">
        {selected !== null && points[selected] ? <span className="mono">Input {Math.round(points[selected].x)} · Output {Math.round(points[selected].y)}</span> : null}
        <span className="spacer" />
        <Button disabled={!removable} onClick={() => { if (removable) { setPoints(points.filter((_, i) => i !== selected)); setSelected(null); } }}>Remove point</Button>
      </div>
      <div className="row">
        <Button onClick={() => { setPoints(identityCurve()); setSelected(null); }}>Reset curve</Button>
      </div>
    </div>
  );
}

// MARK: Gradient Map

function GradientMapControls({ settings, onChange, pick }: {
  settings: GradientMapSettings; onChange: (s: GradientMapSettings) => void; pick: (highlights: boolean) => void;
}) {
  const ends = gradientMapEnds(settings);
  const color = (c: AdjustmentColor) => cssColor({ red: c.red, green: c.green, blue: c.blue });
  const swatch = (title: string, value: AdjustmentColor, highlights: boolean) => (
    <span className="labeled">
      <button type="button" className="palette-swatch inline" aria-label={`${title} color`} title={`Choose the ${title.toLowerCase()} color`}
        style={{ background: color(value) }} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(highlights)} />
      <span>{title}</span>
    </span>
  );
  return (
    <div className="column">
      <div className="gradient-map-bar" style={{ background: `linear-gradient(to right, ${color(ends.dark)}, ${color(ends.light)})` }} />
      <div className="row">
        {swatch('Shadows', settings.shadows, false)}
        {swatch('Highlights', settings.highlights, true)}
        <span className="spacer" />
      </div>
      <Toggle label="Reverse" checked={settings.reversed} onChange={(v) => onChange({ ...settings, reversed: v })} />
    </div>
  );
}
