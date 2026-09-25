// The small controls the bars, panels and dialogs are built from: buttons that don't take keyboard focus from
// the canvas, number fields that step with the arrow keys (Shift for ten), sliders, segmented pickers and swatches.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { releaseFocus } from './hooks';
import type { PaletteColor } from '../model/color';
import { cssColor } from '../model/color';

type ButtonKind = 'default' | 'primary' | 'plain' | 'icon';

export function Button(props: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; kind?: ButtonKind; active?: boolean;
  className?: string; style?: CSSProperties; label?: string; testId?: string;
}) {
  const { kind = 'default' } = props;
  return (
    <button type="button" className={`btn btn-${kind}${props.active ? ' active' : ''}${props.className ? ' ' + props.className : ''}`}
      disabled={props.disabled} title={props.title} aria-label={props.label} style={props.style} data-testid={props.testId}
      aria-pressed={props.active === undefined ? undefined : props.active}
      // Clicking a button leaves keyboard focus where it was, so tool keys and Space keep working on the canvas.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onClick?.()}>
      {props.children}
    </button>
  );
}

export function Toggle(props: { label: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; title?: string; testId?: string }) {
  return (
    <label className={`toggle${props.disabled ? ' disabled' : ''}`} title={props.title} onMouseDown={(event) => event.preventDefault()}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} data-testid={props.testId} tabIndex={-1}
        onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

export interface Choice<T> { value: T; label: ReactNode; title?: string }

export function Segmented<T>(props: { options: Choice<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean; title?: string; label?: string }) {
  return (
    <div className={`segmented${props.disabled ? ' disabled' : ''}`} role="radiogroup" title={props.title} aria-label={props.label}>
      {props.options.map((option, index) => (
        <button key={index} type="button" role="radio" aria-checked={Object.is(option.value, props.value)}
          className={Object.is(option.value, props.value) ? 'selected' : ''} disabled={props.disabled} title={option.title}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>(props: {
  options: Choice<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean; title?: string; width?: number; label?: string; testId?: string;
}) {
  const index = props.options.findIndex((o) => Object.is(o.value, props.value));
  return (
    <select className="select" value={index} disabled={props.disabled} title={props.title} aria-label={props.label} data-testid={props.testId}
      style={props.width ? { width: props.width } : undefined}
      onChange={(event) => {
        const option = props.options[Number(event.target.value)];
        if (option) props.onChange(option.value);
        event.target.blur();
      }}>
      {props.options.map((option, i) => <option key={i} value={i}>{typeof option.label === 'string' ? option.label : String(option.value)}</option>)}
    </select>
  );
}

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/** No trailing zeros on a whole number; otherwise up to `decimals` places. */
export function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = round(value, decimals);
  if (Math.abs(rounded - Math.round(rounded)) < 10 ** -(decimals + 1)) return String(Math.round(rounded));
  return rounded.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

function parseNumber(text: string): number | null {
  const cleaned = text.trim().replace(/[%°]|px$/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** A number typed in a field. Enter or leaving the field applies it (or every keystroke, with `live`); Up and
 *  Down step it by `step` (ten times with Shift); Escape puts back the value shown before. */
export function NumberField(props: {
  value: number; onChange: (value: number) => void; decimals?: number; step?: number; min?: number; max?: number;
  width?: number; suffix?: string; label?: string; title?: string; disabled?: boolean; live?: boolean; testId?: string;
  onFocusChange?: (focused: boolean) => void; align?: 'left' | 'right';
}) {
  const decimals = props.decimals ?? 0;
  const [focused, setFocused] = useState(false);
  const shown = formatNumber(props.value, decimals);
  const [text, setText] = useState(shown);
  const reverted = useRef(false);
  useEffect(() => { if (!focused) setText(shown); }, [shown, focused]);
  const clamp = (value: number) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, value));
  const apply = (raw: string) => {
    const value = parseNumber(raw);
    if (value === null) return false;
    props.onChange(clamp(value));
    return true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      apply(text);
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      reverted.current = true;
      setText(shown);
      event.currentTarget.blur();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const base = parseNumber(text) ?? props.value;
      const amount = (props.step ?? 1) * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
      const next = clamp(round(base + amount, Math.max(decimals, 4)));
      props.onChange(next);
      setText(formatNumber(next, decimals));
    }
  };
  const input = (
    <input className="field" type="text" inputMode="decimal" value={text} disabled={props.disabled}
      aria-label={props.label} title={props.title} data-testid={props.testId} spellCheck={false}
      style={{ width: props.width ?? 56, textAlign: props.align ?? 'right' }}
      onFocus={(event) => { setFocused(true); reverted.current = false; props.onFocusChange?.(true); event.currentTarget.select(); }}
      onBlur={() => {
        if (!reverted.current && !apply(text)) setText(shown);
        reverted.current = false;
        setFocused(false);
        props.onFocusChange?.(false);
      }}
      onChange={(event) => {
        setText(event.target.value);
        if (props.live) apply(event.target.value);
      }}
      onKeyDown={onKeyDown} />
  );
  if (!props.suffix) return input;
  return <span className="unit-field">{input}<span className="unit">{props.suffix}</span></span>;
}

/** A slider; `log` gives the small values used most most of its travel. `onBegin`/`onEnd` bracket a drag. */
export function Slider(props: {
  value: number; min: number; max: number; onChange: (value: number) => void; step?: number; width?: number | string;
  disabled?: boolean; log?: boolean; onBegin?: () => void; onEnd?: () => void; label?: string; title?: string; testId?: string;
}) {
  const toSlider = (v: number) => (props.log ? Math.log(v) : v);
  const fromSlider = (v: number) => (props.log ? Math.exp(v) : v);
  const lo = toSlider(props.min), hi = toSlider(props.max);
  const dragging = useRef(false);
  const end = () => { if (dragging.current) { dragging.current = false; props.onEnd?.(); } };
  return (
    <input type="range" className="slider" min={lo} max={hi} step={props.step ?? (hi - lo) / 1000}
      value={toSlider(Math.min(props.max, Math.max(props.min, props.value)))} disabled={props.disabled}
      aria-label={props.label} title={props.title} data-testid={props.testId} tabIndex={-1}
      style={{ width: props.width ?? 100 }}
      onPointerDown={() => { dragging.current = true; props.onBegin?.(); }}
      onPointerUp={end} onLostPointerCapture={end} onBlur={end}
      onChange={(event) => props.onChange(fromSlider(Number(event.target.value)))}
      onMouseUp={() => releaseFocus()} />
  );
}

/** A colour swatch button, outlined white inside black so it reads against any colour. */
export function Swatch(props: { color: PaletteColor; onClick?: () => void; disabled?: boolean; title?: string; width?: number; height?: number; label?: string; radius?: number }) {
  return (
    <button type="button" className="swatch" disabled={props.disabled} title={props.title} aria-label={props.label ?? props.title}
      style={{ width: props.width ?? 34, height: props.height ?? 18, background: cssColor(props.color), borderRadius: props.radius ?? 4 }}
      onMouseDown={(event) => event.preventDefault()} onClick={() => props.onClick?.()} />
  );
}

export function Divider(props: { vertical?: boolean }) {
  return <div className={props.vertical ? 'divider-v' : 'divider'} />;
}

export function Spinner(props: { size?: number }) {
  return <span className="spinner" style={{ width: props.size ?? 12, height: props.size ?? 12 }} />;
}
