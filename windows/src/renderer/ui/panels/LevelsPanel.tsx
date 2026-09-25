// Levels (LevelsSheet.swift): the layer's histogram, input black / gamma / white and output levels by handle or
// number, per channel; eyedroppers that set black, grey or white from the layer; automatic levels; Preview.
import { useEffect, useRef } from 'react';
import { Pipette } from 'lucide-react';
import type { EditorSession } from '../../session';
import { useSelect } from '../hooks';
import { Button, NumberField, Select, Spinner, Toggle } from '../controls';
import { FloatingPanel } from './FloatingPanel';
import {
  LEVELS_AUTOS, LEVELS_CHANNELS, LEVELS_SAMPLES, LevelRange, channelIndex, currentRange, defaultLevels, histogramScale, withCurrentRange,
} from '../../model/adjustments';

export function LevelsPanel({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    settings: x.levels?.settings ?? defaultLevels(), preview: x.levels?.preview ?? true, sample: x.levels?.sampleMode ?? null,
    histogram: x.levels?.histogram ?? null, ready: x.levels?.histogramReady ?? false, committing: x.levels?.committing ?? false,
    adjusting: !!x.adjustmentOriginal, selection: !!x.selection,
  }));
  const range = currentRange(s.settings);
  const update = (change: (r: LevelRange) => LevelRange) => {
    const edit = session.levels;
    if (!edit) return;
    session.updateLevels(withCurrentRange(edit.settings, change({ ...currentRange(edit.settings) })), edit.preview);
  };
  return (
    <FloatingPanel name="levels" title="Levels" onCancel={() => session.cancelLevels()} onOK={() => void session.commitLevels()} testId="levelsPanel">
      <div className={`panel-content${s.committing ? ' disabled' : ''}`} style={{ width: 392 }}>
        <Select options={LEVELS_CHANNELS.map((c) => ({ value: c, label: c }))} value={s.settings.channel} width={180} label="Channel"
          onChange={(channel) => { const edit = session.levels; if (edit) session.updateLevels({ ...edit.settings, channel }, edit.preview); }} />
        <div className="levels-graph">
          <Histogram bins={s.histogram?.[channelIndex(s.settings.channel)] ?? null} channel={s.settings.channel} />
          {!s.ready ? <span className="histogram-loading">Loading histogram…</span> : null}
          <Handles output={false} range={range} update={update} />
        </div>
        <div className="row-between">
          <LabeledNumber label="Input black" value={range.black} decimals={0} onChange={(v) => update((r) => ({ ...r, black: v }))} />
          <LabeledNumber label="Gamma" value={range.gamma} decimals={2} step={0.01} onChange={(v) => update((r) => ({ ...r, gamma: v }))} />
          <LabeledNumber label="Input white" value={range.white} decimals={0} onChange={(v) => update((r) => ({ ...r, white: v }))} />
        </div>
        <div className="levels-output">
          <div className="output-ramp" />
          <Handles output range={range} update={update} />
        </div>
        <div className="row-between">
          <LabeledNumber label="Output black" value={range.outputBlack} decimals={0} onChange={(v) => update((r) => ({ ...r, outputBlack: v }))} />
          <LabeledNumber label="Output white" value={range.outputWhite} decimals={0} onChange={(v) => update((r) => ({ ...r, outputWhite: v }))} />
        </div>
        <div className="row">
          <span className="caption">Sample</span>
          {LEVELS_SAMPLES.map((mode) => (
            <Button key={mode} active={s.sample === mode} onClick={() => session.setLevelsSampleMode(s.sample === mode ? null : mode)}>
              <Pipette size={12} /> {mode}
            </Button>
          ))}
        </div>
        {s.sample ? <div className="hint">Click the original layer to set {s.sample.toLowerCase()}. Click the eyedropper again to stop.</div> : null}
        <div className="column">
          <span className="caption">Auto</span>
          <div className="row">
            {LEVELS_AUTOS.map((mode) => <Button key={mode} disabled={!s.ready} onClick={() => session.autoLevels(mode)}>{mode}</Button>)}
          </div>
        </div>
        <div className="row">
          <Toggle label="Preview" checked={s.preview} title="Alt+P" onChange={(v) => { const edit = session.levels; if (edit) session.updateLevels(edit.settings, v); }} />
          <span className="spacer" />
          <Button onClick={() => { session.setLevelsSampleMode(null); const edit = session.levels; if (edit) session.updateLevels(defaultLevels(), edit.preview); }}>Reset</Button>
        </div>
        <div className="hint">{s.adjusting ? 'Underlying pixels · alpha-weighted histogram' : s.selection ? 'Original pixels · selection and alpha-weighted histogram' : 'Original pixels · alpha-weighted histogram'}</div>
        <div className="panel-buttons">
          <Button onClick={() => session.cancelLevels()}>Cancel</Button>
          <span className="spacer" />
          {s.committing ? <Spinner /> : null}
          <Button kind="primary" onClick={() => void session.commitLevels()} testId="levelsOK">OK</Button>
        </div>
      </div>
    </FloatingPanel>
  );
}

function LabeledNumber(props: { label: string; value: number; decimals: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="stacked">
      <span className="caption">{props.label}</span>
      <NumberField value={props.value} decimals={props.decimals} step={props.step} width={80} onChange={props.onChange}
        testId={`levels${props.label.replace(/ /g, '')}`} label={props.label} />
    </label>
  );
}

/** A linear histogram with automatic vertical scaling: tall spikes may reach past the top. */
function Histogram({ bins, channel }: { bins: number[] | null; channel: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * dpr, height = canvas.clientHeight * dpr;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    if (!bins) return;
    const peak = histogramScale(bins);
    if (!(peak > 0)) return;
    ctx.fillStyle = channel === 'Red' ? '#e5484d' : channel === 'Green' ? '#46a758' : channel === 'Blue' ? '#3e7bfa' : '#9a9a9a';
    for (let i = 0; i < 256; i++) {
      const h = height * Math.min(1, Math.max(0, bins[i] / peak));
      ctx.fillRect(i * width / 256, height - h, width / 256 + 0.1 * dpr, h);
    }
  }, [bins, channel]);
  return <canvas className="histogram" ref={ref} aria-label={`Original ${channel} histogram`}
    title="Linear histogram with automatic vertical scaling. Tall spikes may extend beyond the graph; all tones from 0 to 255 remain included." />;
}

/** The triangles under the histogram (black, gamma, white) or under the output ramp (black, white). */
function Handles({ output, range, update }: { output: boolean; range: LevelRange; update: (change: (r: LevelRange) => LevelRange) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gammaPosition = range.black + (range.white - range.black) * 0.5 ** range.gamma;
  const positions = output ? [range.outputBlack, range.outputWhite] : [range.black, gammaPosition, range.white];
  const names = output ? ['Output black', 'Output white'] : ['Input black', 'Gamma', 'Input white'];
  const drag = (index: number, clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const x = Math.min(255, Math.max(0, (clientX - box.left) / box.width * 255));
    update((r) => {
      if (output) {
        if (index === 0) r.outputBlack = Math.round(x); else r.outputWhite = Math.round(x);
      } else if (index === 0) r.black = Math.min(r.white - 1, Math.round(x));
      else if (index === 2) r.white = Math.max(r.black + 1, Math.round(x));
      else {
        const fraction = Math.min(0.999, Math.max(0.001, (x - r.black) / (r.white - r.black)));
        r.gamma = Math.log(fraction) / Math.log(0.5);
      }
      return r;
    });
  };
  return (
    <div className="level-handles" ref={ref}>
      {positions.map((position, index) => (
        <span key={index} className={`level-handle ${index === 0 ? 'black' : index === positions.length - 1 ? 'white' : 'gray'}`}
          style={{ left: `${position / 255 * 100}%` }} aria-label={names[index]} role="slider" aria-valuenow={Math.round(position)}
          onPointerDown={(event) => {
            event.preventDefault();
            const element = event.currentTarget;
            element.setPointerCapture(event.pointerId);
            drag(index, event.clientX);
            const move = (e: PointerEvent) => drag(index, e.clientX);
            const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
            element.addEventListener('pointermove', move);
            element.addEventListener('pointerup', up);
          }} />
      ))}
    </div>
  );
}
