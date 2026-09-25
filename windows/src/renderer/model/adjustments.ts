// Color adjustment settings and their math: Levels, Curves, Exposure, Gradient Map, Grain and Hue/Saturation.
// Ports of Levels.swift, LevelsAutomatic.swift, Curves.swift, ImageAdjustments.swift, HueSaturation.swift and
// LayerAdjustment.swift. JSON forms match the Mac app's Codable output so projects open on both.

export const clampValue = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

// MARK: Levels

export type LevelsChannel = 'RGB' | 'Red' | 'Green' | 'Blue';
export const LEVELS_CHANNELS: LevelsChannel[] = ['RGB', 'Red', 'Green', 'Blue'];
export const channelIndex = (channel: LevelsChannel) => LEVELS_CHANNELS.indexOf(channel);

export interface LevelRange { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }
export const defaultLevelRange = (): LevelRange => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 });

export function normalizedRange(r: LevelRange): LevelRange {
  const black = clampValue(r.black, 0, 254, 0);
  return {
    black,
    white: clampValue(r.white, black + 1, 255, 255),
    gamma: clampValue(r.gamma, 0.1, 9.99, 1),
    outputBlack: clampValue(r.outputBlack, 0, 255, 0),
    outputWhite: clampValue(r.outputWhite, 0, 255, 255),
  };
}

export function rangesEqual(a: LevelRange, b: LevelRange): boolean {
  return a.black === b.black && a.gamma === b.gamma && a.white === b.white && a.outputBlack === b.outputBlack && a.outputWhite === b.outputWhite;
}

export function applyRange(r: LevelRange, value: number): number {
  const s = normalizedRange(r);
  const input = Math.min(1, Math.max(0, (value * 255 - s.black) / (s.white - s.black)));
  return (s.outputBlack + Math.pow(input, 1 / s.gamma) * (s.outputWhite - s.outputBlack)) / 255;
}

export interface LevelsSettings { channel: LevelsChannel; ranges: LevelRange[] }
export const defaultLevels = (): LevelsSettings => ({ channel: 'RGB', ranges: [0, 1, 2, 3].map(defaultLevelRange) });

export function currentRange(s: LevelsSettings): LevelRange { return s.ranges[channelIndex(s.channel)]; }
export function withCurrentRange(s: LevelsSettings, range: LevelRange): LevelsSettings {
  const ranges = s.ranges.slice();
  ranges[channelIndex(s.channel)] = normalizedRange(range);
  return { ...s, ranges };
}
export function levelsIsIdentity(s: LevelsSettings): boolean {
  return s.ranges.every((r) => rangesEqual(normalizedRange(r), defaultLevelRange()));
}
/** Individual channels, followed by the composite RGB adjustment. */
export function levelsApply(s: LevelsSettings, value: number, channel: LevelsChannel): number {
  return applyRange(s.ranges[0], applyRange(s.ranges[channelIndex(channel)], value));
}
/** Output (0–1) per input byte for red, green and blue, 768 floats. */
export function levelsTables(s: LevelsSettings): Float32Array {
  const tables = new Float32Array(768);
  (['Red', 'Green', 'Blue'] as LevelsChannel[]).forEach((channel, c) => {
    for (let i = 0; i < 256; i++) tables[c * 256 + i] = levelsApply(s, i / 255, channel);
  });
  return tables;
}

/** Display-only vertical scaling: linear bins, with isolated spikes capped so they don't flatten the rest. */
export function histogramScale(bins: number[]): number {
  const positive = bins.filter((b) => Number.isFinite(b) && b > 0);
  const peak = positive.length ? Math.max(...positive) : 0;
  if (!(peak > 0)) return 0;
  const interior = bins.slice(1, -1).filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
  if (interior.length === 0) return peak;
  const typical = interior[Math.floor((interior.length - 1) * 0.95)];
  return Math.min(peak, typical * 4);
}

export type LevelsSample = 'Black' | 'Gray' | 'White';
export const LEVELS_SAMPLES: LevelsSample[] = ['Black', 'Gray', 'White'];
export type LevelsAuto = 'Contrast' | 'Color' | 'Color + neutral midtones';
export const LEVELS_AUTOS: LevelsAuto[] = ['Contrast', 'Color', 'Color + neutral midtones'];

export function autoLevels(mode: LevelsAuto, histogram: number[][]): LevelsSettings {
  const result = defaultLevels();
  const endpoints = (bins: number[]): [number, number] | null => {
    const total = bins.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return null;
    let sum = 0, low = 0, high = 255;
    for (let i = 0; i < 256; i++) { sum += bins[i]; if (sum > total * 0.001) { low = i; break; } }
    sum = 0;
    for (let i = 255; i >= 0; i--) { sum += bins[i]; if (sum > total * 0.001) { high = i; break; } }
    return low < high ? [low, high] : null;
  };
  if (mode === 'Contrast') {
    const limits = histogram.slice(1).map(endpoints).filter((e): e is [number, number] => !!e);
    if (limits.length) {
      const low = Math.min(...limits.map((l) => l[0])), high = Math.max(...limits.map((l) => l[1]));
      if (low < high) result.ranges[0] = { ...defaultLevelRange(), black: low, white: high };
    }
  } else {
    for (let c = 1; c <= 3; c++) {
      const e = endpoints(histogram[c]);
      if (!e) continue;
      const range: LevelRange = { ...defaultLevelRange(), black: e[0], white: e[1] };
      if (mode === 'Color + neutral midtones') {
        const total = histogram[c].reduce((a, b) => a + b, 0);
        const mean = histogram[c].reduce((acc, count, index) => acc + applyRange(range, index / 255) * count, 0) / total;
        if (mean > 0 && mean < 1) range.gamma = Math.min(9.99, Math.max(0.1, Math.log(mean) / Math.log(0.5)));
      }
      result.ranges[c] = range;
    }
  }
  return result;
}

/** Eyedropper calibration from an unpremultiplied RGB sample (0–1): all three channels together. */
export function levelsSampling(s: LevelsSettings, rgb: number[], mode: LevelsSample): LevelsSettings {
  const ranges = s.ranges.map((r) => ({ ...r }));
  ranges[0] = defaultLevelRange();
  for (let c = 1; c <= 3; c++) {
    const range = { ...ranges[c] };
    const v = rgb[c - 1] * 255;
    if (mode === 'Black') range.black = Math.min(range.white - 1, Math.max(0, v));
    else if (mode === 'White') range.white = Math.max(range.black + 1, Math.min(255, v));
    else {
      const fraction = (v - range.black) / (range.white - range.black);
      if (!(fraction > 0 && fraction < 1)) continue;
      range.gamma = Math.log(fraction) / Math.log(0.5);
    }
    range.outputBlack = 0;
    range.outputWhite = 255;
    ranges[c] = normalizedRange(range);
  }
  return { ...s, ranges };
}

// MARK: Curves

export interface CurvePoint { x: number; y: number }
export interface CurvesSettings { channel: LevelsChannel; channels: CurvePoint[][] }
export const identityCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];
export const defaultCurves = (): CurvesSettings => ({ channel: 'RGB', channels: [0, 1, 2, 3].map(identityCurve) });

export function curvesIsValid(s: CurvesSettings): boolean {
  return s.channels.length === 4 && s.channels.every((points) =>
    points.length >= 2 && points.length <= 32 && points[0].x === 0 && points[points.length - 1].x === 255
    && points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 255 && p.y >= 0 && p.y <= 255)
    && points.every((p, i) => i === 0 || points[i - 1].x < p.x));
}

/** Shape-preserving cubic Hermite interpolation avoids overshoot between handles. */
export function curveValue(s: CurvesSettings, x: number, channel: number): number {
  const p = s.channels[channel];
  let last = 0;
  for (let j = 0; j < p.length; j++) if (p[j].x <= x) last = j;
  const i = Math.min(p.length - 2, Math.max(0, last));
  const d: number[] = [];
  for (let j = 0; j < p.length - 1; j++) d.push((p[j + 1].y - p[j].y) / (p[j + 1].x - p[j].x));
  const slope = (j: number): number => {
    if (j === 0) return d[0];
    if (j === p.length - 1) return d[d.length - 1];
    if (d[j - 1] * d[j] <= 0) return 0;
    return 2 / (1 / d[j - 1] + 1 / d[j]);
  };
  const h = p[i + 1].x - p[i].x, t = Math.min(1, Math.max(0, (x - p[i].x) / h));
  const y = (2 * t * t * t - 3 * t * t + 1) * p[i].y + (t * t * t - 2 * t * t + t) * h * slope(i)
    + (-2 * t * t * t + 3 * t * t) * p[i + 1].y + (t * t * t - t * t) * h * slope(i + 1);
  return Math.min(255, Math.max(0, y));
}

/** Per-channel output (0–1) tables: each channel's curve, then the RGB curve. */
export function curvesTables(s: CurvesSettings): Float32Array {
  const tables = new Float32Array(768);
  for (let channel = 1; channel <= 3; channel++) {
    for (let i = 0; i < 256; i++) tables[(channel - 1) * 256 + i] = curveValue(s, curveValue(s, i, channel), 0) / 255;
  }
  return tables;
}

export function curvesIsIdentity(s: CurvesSettings): boolean {
  return s.channels.every((points) => points.length === 2 && points[0].y === 0 && points[1].y === 255);
}

// MARK: Exposure

export interface ExposureSettings { exposure: number; offset: number; gamma: number }
export const EXPOSURE_RANGE = [-20, 20] as const;
export const OFFSET_RANGE = [-0.5, 0.5] as const;
export const GAMMA_RANGE = [0.01, 9.99] as const;
export const defaultExposure = (): ExposureSettings => ({ exposure: 0, offset: 0, gamma: 1 });
export function exposureIsValid(s: ExposureSettings): boolean {
  return s.exposure >= -20 && s.exposure <= 20 && s.offset >= -0.5 && s.offset <= 0.5 && s.gamma >= 0.01 && s.gamma <= 9.99;
}
export function normalizedExposure(s: ExposureSettings): ExposureSettings {
  return { exposure: clampValue(s.exposure, -20, 20, 0), offset: clampValue(s.offset, -0.5, 0.5, 0), gamma: clampValue(s.gamma, 0.01, 9.99, 1) };
}
export function exposureIsIdentity(s: ExposureSettings): boolean { return s.exposure === 0 && s.offset === 0 && s.gamma === 1; }
/** One channel's output (0–1) per input byte, decoded to linear light and encoded back. */
export function exposureTable(s: ExposureSettings): Float32Array {
  const scale = Math.pow(2, s.exposure);
  const table = new Float32Array(256);
  for (let index = 0; index < 256; index++) {
    const encoded = index / 255;
    let linear = encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
    linear = Math.pow(Math.max(0, linear * scale + s.offset), 1 / s.gamma);
    const output = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    table[index] = Math.min(1, Math.max(0, output));
  }
  return table;
}
export function exposureTables(s: ExposureSettings): Float32Array {
  const one = exposureTable(s);
  const tables = new Float32Array(768);
  tables.set(one, 0); tables.set(one, 256); tables.set(one, 512);
  return tables;
}

// MARK: Gradient Map

export interface AdjustmentColor { red: number; green: number; blue: number }
export function colorIsValid(c: AdjustmentColor): boolean {
  return [c.red, c.green, c.blue].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
}
export function clampedColor(c: AdjustmentColor): AdjustmentColor {
  return { red: clampValue(c.red, 0, 1, 0), green: clampValue(c.green, 0, 1, 0), blue: clampValue(c.blue, 0, 1, 0) };
}
export interface GradientMapSettings { shadows: AdjustmentColor; highlights: AdjustmentColor; reversed: boolean }
export const defaultGradientMap = (): GradientMapSettings => ({
  shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false,
});
export function gradientMapEnds(s: GradientMapSettings): { dark: AdjustmentColor; light: AdjustmentColor } {
  return s.reversed ? { dark: s.highlights, light: s.shadows } : { dark: s.shadows, light: s.highlights };
}
/** 256 × 3 straight sRGB bytes, darkest first. */
export function gradientMapTable(s: GradientMapSettings): Uint8Array {
  const { dark, light } = gradientMapEnds(s);
  const table = new Uint8Array(768);
  for (let index = 0; index < 256; index++) {
    const t = index / 255;
    const values = [dark.red + (light.red - dark.red) * t, dark.green + (light.green - dark.green) * t, dark.blue + (light.blue - dark.blue) * t];
    for (let k = 0; k < 3; k++) table[index * 3 + k] = Math.min(255, Math.max(0, Math.round(values[k] * 255)));
  }
  return table;
}

// MARK: Grain

export interface GrainSettings { amount: number; size: number; roughness: number; seed: number }
export const defaultGrain = (): GrainSettings => ({ amount: 25, size: 1.5, roughness: 50, seed: 0 });
export function grainIsValid(s: GrainSettings): boolean {
  return s.amount >= 0 && s.amount <= 100 && s.size >= 0.5 && s.size <= 20 && s.roughness >= 0 && s.roughness <= 100;
}
export function normalizedGrain(s: GrainSettings): GrainSettings {
  return { ...s, amount: clampValue(s.amount, 0, 100, 25), size: clampValue(s.size, 0.5, 20, 1.5), roughness: clampValue(s.roughness, 0, 100, 50) };
}
export const randomSeed = () => (Math.random() * 0x100000000) >>> 0;

// MARK: Hue/Saturation

export type ColorRange = 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas';
export const COLOR_RANGES_ALL: ColorRange[] = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];
export const COLOR_RANGES: ColorRange[] = COLOR_RANGES_ALL.filter((r) => r !== 'Master');

export interface HueBand { falloffStart: number; rangeStart: number; rangeEnd: number; falloffEnd: number }

export function defaultBand(range: ColorRange): HueBand {
  switch (range) {
    case 'Master': return { falloffStart: 0, rangeStart: 0, rangeEnd: 360, falloffEnd: 360 };
    case 'Reds': return { falloffStart: 315, rangeStart: 345, rangeEnd: 15, falloffEnd: 45 };
    case 'Yellows': return { falloffStart: 15, rangeStart: 45, rangeEnd: 75, falloffEnd: 105 };
    case 'Greens': return { falloffStart: 75, rangeStart: 105, rangeEnd: 135, falloffEnd: 165 };
    case 'Cyans': return { falloffStart: 135, rangeStart: 165, rangeEnd: 195, falloffEnd: 225 };
    case 'Blues': return { falloffStart: 195, rangeStart: 225, rangeEnd: 255, falloffEnd: 285 };
    case 'Magentas': return { falloffStart: 255, rangeStart: 285, rangeEnd: 315, falloffEnd: 345 };
  }
}

/** Degrees from `from` forward to `to`, always 0…360. */
export function forward(from: number, to: number): number {
  const delta = (to - from) % 360;
  return delta < 0 ? delta + 360 : delta;
}
const wrap360 = (value: number) => { const r = value % 360; return r < 0 ? r + 360 : r; };

export function bandWeight(b: HueBand, hue: number): number {
  const span = forward(b.falloffStart, b.falloffEnd);
  if (!(span > 0)) return 1;
  const position = forward(b.falloffStart, hue);
  if (position > span) return 0;
  const rampIn = forward(b.falloffStart, b.rangeStart);
  const plateauEnd = forward(b.falloffStart, b.rangeEnd);
  if (position < rampIn) return rampIn > 0 ? position / rampIn : 1;
  if (position <= plateauEnd) return 1;
  const rampOut = span - plateauEnd;
  return rampOut > 0 ? (span - position) / rampOut : 1;
}

export const bandHandles = (b: HueBand) => [b.falloffStart, b.rangeStart, b.rangeEnd, b.falloffEnd];

export function bandCentered(b: HueBand, hue: number): HueBand {
  const core = forward(b.rangeStart, b.rangeEnd);
  const leading = forward(b.falloffStart, b.rangeStart);
  const trailing = forward(b.rangeEnd, b.falloffEnd);
  const start = wrap360(hue - core / 2);
  return { falloffStart: wrap360(start - leading), rangeStart: start, rangeEnd: wrap360(start + core), falloffEnd: wrap360(start + core + trailing) };
}

function normalizeBand(b: HueBand): HueBand {
  const result = { falloffStart: wrap360(b.falloffStart), rangeStart: wrap360(b.rangeStart), rangeEnd: wrap360(b.rangeEnd), falloffEnd: wrap360(b.falloffEnd) };
  if (forward(result.falloffStart, result.falloffEnd) > 350) result.falloffEnd = wrap360(result.falloffStart + 350);
  return result;
}

/** Widens the band so this hue is fully inside it, moving whichever edge is nearer. */
export function bandIncluding(b: HueBand, hue: number): HueBand {
  if (bandWeight(b, hue) >= 1) return b;
  const shoulderIn = forward(b.falloffStart, b.rangeStart);
  const shoulderOut = forward(b.rangeEnd, b.falloffEnd);
  const beforeStart = forward(hue, b.rangeStart);
  const afterEnd = forward(b.rangeEnd, hue);
  const next = { ...b };
  if (beforeStart <= afterEnd) { next.rangeStart = hue; next.falloffStart = hue - shoulderIn; }
  else { next.rangeEnd = hue; next.falloffEnd = hue + shoulderOut; }
  return normalizeBand(next);
}

/** Narrows the band so this hue falls outside it entirely, shoulder included. */
export function bandExcluding(b: HueBand, hue: number): HueBand {
  if (bandWeight(b, hue) <= 0) return b;
  const shoulderIn = forward(b.falloffStart, b.rangeStart);
  const shoulderOut = forward(b.rangeEnd, b.falloffEnd);
  const fromStart = forward(b.falloffStart, hue);
  const toEnd = forward(hue, b.falloffEnd);
  const next = { ...b };
  if (fromStart <= toEnd) { next.falloffStart = hue + 1; next.rangeStart = hue + 1 + shoulderIn; }
  else { next.falloffEnd = hue - 1; next.rangeEnd = hue - 1 - shoulderOut; }
  return normalizeBand(next);
}

/** Moves one handle, keeping the four in order and the band under a full circle. */
export function bandWithHandle(b: HueBand, index: number, degrees: number): HueBand {
  const value = ((degrees % 360) + 360) % 360;
  const updated = { ...b };
  if (index === 0) updated.falloffStart = value;
  else if (index === 1) updated.rangeStart = value;
  else if (index === 2) updated.rangeEnd = value;
  else updated.falloffEnd = value;
  const span = forward(updated.falloffStart, updated.falloffEnd);
  const toStart = forward(updated.falloffStart, updated.rangeStart);
  const toEnd = forward(updated.falloffStart, updated.rangeEnd);
  if (!(span > 1 && span <= 350 && toStart <= toEnd && toEnd <= span)) return b;
  return updated;
}

export interface RangeAdjustment { hue: number; saturation: number; lightness: number }
const zeroAdjustment = (): RangeAdjustment => ({ hue: 0, saturation: 0, lightness: 0 });
const isZero = (a: RangeAdjustment) => a.hue === 0 && a.saturation === 0 && a.lightness === 0;

export interface HueSaturationSettings {
  range: ColorRange;
  colorize: boolean;
  invertRange: boolean;
  adjustments: Partial<Record<ColorRange, RangeAdjustment>>;
  bands: Record<ColorRange, HueBand>;
}

export function makeHueSaturation(hue = 0, saturation = 0, lightness = 0, colorize = false, range: ColorRange = 'Master'): HueSaturationSettings {
  const bands = {} as Record<ColorRange, HueBand>;
  for (const r of COLOR_RANGES_ALL) bands[r] = defaultBand(r);
  return { range, colorize, invertRange: false, adjustments: { [range]: { hue, saturation, lightness } }, bands };
}
export const colorizeStart = () => makeHueSaturation(0, 25, 0, true);

export const hsHue = (s: HueSaturationSettings) => s.adjustments[s.range]?.hue ?? 0;
export const hsSaturation = (s: HueSaturationSettings) => s.adjustments[s.range]?.saturation ?? 0;
export const hsLightness = (s: HueSaturationSettings) => s.adjustments[s.range]?.lightness ?? 0;
export function hsWith(s: HueSaturationSettings, key: keyof RangeAdjustment, value: number, range = s.range): HueSaturationSettings {
  const current = s.adjustments[range] ?? zeroAdjustment();
  return { ...s, adjustments: { ...s.adjustments, [range]: { ...current, [key]: value } } };
}
export const hsBand = (s: HueSaturationSettings) => s.bands[s.range] ?? defaultBand(s.range);
export function hsWithBand(s: HueSaturationSettings, band: HueBand): HueSaturationSettings {
  return { ...s, bands: { ...s.bands, [s.range]: band } };
}
export function hsIsIdentity(s: HueSaturationSettings): boolean {
  return !s.colorize && Object.values(s.adjustments).every((a) => !a || isZero(a));
}
/** How much a range applies to one hue: Master everywhere, others through their band. */
export function hsWeight(s: HueSaturationSettings, range: ColorRange, hue: number): number {
  if (range === 'Master') return 1;
  const weight = bandWeight(s.bands[range] ?? defaultBand(range), hue);
  return s.invertRange && range === s.range ? 1 - weight : weight;
}

export interface HueResponse { shift: number; saturation: number; lightness: number }

/** How much every range shifts a given hue, sampled once per degree (0…360). */
export function hueResponse(s: HueSaturationSettings): HueResponse[] {
  const result: HueResponse[] = [];
  for (let degree = 0; degree <= 360; degree++) {
    const response = { shift: 0, saturation: 0, lightness: 0 };
    for (const range of COLOR_RANGES_ALL) {
      const a = s.adjustments[range];
      if (!a || isZero(a)) continue;
      const weight = hsWeight(s, range, degree);
      if (!(weight > 0)) continue;
      response.shift += a.hue * weight;
      response.saturation += a.saturation * weight;
      response.lightness += a.lightness * weight;
    }
    result.push(response);
  }
  return result;
}

export function toHSL(red: number, green: number, blue: number): [number, number, number] {
  const high = Math.max(red, green, blue), low = Math.min(red, green, blue);
  const lightness = (high + low) / 2;
  const delta = high - low;
  if (!(delta > 0)) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (high === red) hue = (green - blue) / delta;
  else if (high === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return [hue, Math.min(1, saturation), lightness];
}

export function fromHSL(hue: number, saturation: number, lightness: number): [number, number, number] {
  if (!(saturation > 0)) return [lightness, lightness, lightness];
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = lightness - chroma / 2;
  let r: number, g: number, b: number;
  switch (Math.trunc(sector)) {
    case 0: [r, g, b] = [chroma, second, 0]; break;
    case 1: [r, g, b] = [second, chroma, 0]; break;
    case 2: [r, g, b] = [0, chroma, second]; break;
    case 3: [r, g, b] = [0, second, chroma]; break;
    case 4: [r, g, b] = [second, 0, chroma]; break;
    default: [r, g, b] = [chroma, 0, second];
  }
  const c = (v: number) => Math.min(1, Math.max(0, v + base));
  return [c(r), c(g), c(b)];
}

export function hsAdjust(red: number, green: number, blue: number, s: HueSaturationSettings, response?: HueResponse[]): [number, number, number] {
  let [hue, saturation, lightness] = toHSL(red, green, blue);
  let lightnessAmount = 0;
  if (s.colorize) {
    hue = hsHue(s) % 360;
    saturation = Math.min(1, Math.max(0, hsSaturation(s) / 100));
    lightnessAmount = hsLightness(s) / 100;
  } else {
    const table = response ?? hueResponse(s);
    const sampled = table[Math.min(table.length - 1, Math.max(0, Math.round(hue)))];
    lightnessAmount = sampled.lightness / 100;
    hue = (hue + sampled.shift) % 360;
    if (hue < 0) hue += 360;
    saturation = Math.min(1, Math.max(0, saturation * (1 + sampled.saturation / 100)));
  }
  const amount = Math.min(1, Math.max(-1, lightnessAmount));
  lightness = amount >= 0 ? lightness + (1 - lightness) * amount : lightness * (1 + amount);
  return fromHSL(hue, saturation, Math.min(1, Math.max(0, lightness)));
}

/** 33 points per axis: fast to build, smooth enough. */
export const CUBE_DIMENSION = 33;

/** RGB lookup cube (red fastest, then green, then blue), 3 floats per entry. */
export function hueSaturationCube(s: HueSaturationSettings): Float32Array {
  const n = CUBE_DIMENSION, step = n - 1;
  const response = hueResponse(s);
  const values = new Float32Array(n * n * n * 3);
  let index = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const color = hsAdjust(r / step, g / step, b / step, s, response);
        values[index] = color[0]; values[index + 1] = color[1]; values[index + 2] = color[2];
        index += 3;
      }
    }
  }
  return values;
}

/** The hue a spectrum swatch becomes, for the "after" bar. */
export function shiftedHue(hue: number, s: HueSaturationSettings): number {
  let shift = 0;
  for (const range of COLOR_RANGES_ALL) {
    const a = s.adjustments[range];
    if (!a || a.hue === 0) continue;
    shift += a.hue * hsWeight(s, range, hue);
  }
  const shifted = (hue + shift) % 360;
  return shifted < 0 ? shifted + 360 : shifted;
}

// MARK: Adjustment layers

export type AdjustmentKind = 'Hue/Saturation' | 'Levels' | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain';
export const ADJUSTMENT_KINDS: AdjustmentKind[] = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain'];

export interface LayerAdjustment {
  kind: AdjustmentKind;
  hue: number;
  saturation: number;
  lightness: number;
  colorize: boolean;
  hsvSettings: HueSaturationSettings | null;
  levels: LevelsSettings;
  curves: CurvesSettings;
  exposureSettings: ExposureSettings | null;
  gradientMapSettings: GradientMapSettings | null;
  grainSettings: GrainSettings | null;
}

export function makeAdjustment(kind: AdjustmentKind): LayerAdjustment {
  return { kind, hue: 0, saturation: 0, lightness: 0, colorize: false, hsvSettings: null, levels: defaultLevels(),
    curves: defaultCurves(), exposureSettings: null, gradientMapSettings: null, grainSettings: null };
}
export const resolvedHSV = (a: LayerAdjustment) => a.hsvSettings ?? makeHueSaturation(a.hue, a.saturation, a.lightness, a.colorize);
export const adjustmentExposure = (a: LayerAdjustment) => a.exposureSettings ?? defaultExposure();
export const adjustmentGradientMap = (a: LayerAdjustment) => a.gradientMapSettings ?? defaultGradientMap();
export const adjustmentGrain = (a: LayerAdjustment) => a.grainSettings ?? defaultGrain();

export function adjustmentIsValid(a: LayerAdjustment): boolean {
  const hsv = resolvedHSV(a);
  const finite = (v: number, limit: number) => Number.isFinite(v) && Math.abs(v) <= limit;
  return finite(a.hue, 360) && finite(a.saturation, 100) && finite(a.lightness, 100)
    && Object.values(hsv.adjustments).every((x) => !x || (finite(x.hue, 360) && finite(x.saturation, 100) && finite(x.lightness, 100)))
    && Object.values(hsv.bands).every((b) => bandHandles(b).every(Number.isFinite))
    && a.levels.ranges.length === 4 && a.levels.ranges.every((r) => rangesEqual(r, normalizedRange(r)))
    && curvesIsValid(a.curves) && exposureIsValid(adjustmentExposure(a))
    && colorIsValid(adjustmentGradientMap(a).shadows) && colorIsValid(adjustmentGradientMap(a).highlights)
    && grainIsValid(adjustmentGrain(a));
}

/** The panel that edits an adjustment kind (Levels and Hue/Saturation have their own). */
export function filterKindFor(kind: AdjustmentKind): 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain' | null {
  switch (kind) {
    case 'Curves': case 'Exposure': case 'Gradient Map': case 'Grain': return kind;
    default: return null;
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// MARK: JSON (Mac Codable compatible)

/** Swift encodes dictionaries with enum keys as [key, value, key, value, …]. */
function encodeEnumDictionary<V>(dictionary: Partial<Record<string, V>>, encodeValue: (v: V) => unknown): unknown[] {
  const result: unknown[] = [];
  for (const [key, value] of Object.entries(dictionary)) {
    if (value === undefined) continue;
    result.push(key, encodeValue(value as V));
  }
  return result;
}
function decodeEnumDictionary<V>(value: unknown, decodeValue: (v: unknown) => V): Record<string, V> {
  const result: Record<string, V> = {};
  if (Array.isArray(value)) {
    for (let i = 0; i + 1 < value.length; i += 2) result[String(value[i])] = decodeValue(value[i + 1]);
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) result[key] = decodeValue(v);
  }
  return result;
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown) => v === true;
function requireKeys(o: unknown, keys: string[]): Record<string, unknown> {
  if (!o || typeof o !== 'object') throw new Error('invalid');
  for (const key of keys) if (!(key in (o as object))) throw new Error(`missing ${key}`);
  return o as Record<string, unknown>;
}

function decodeRange(v: unknown): RangeAdjustment {
  const o = requireKeys(v, ['hue', 'saturation', 'lightness']);
  return { hue: num(o.hue), saturation: num(o.saturation), lightness: num(o.lightness) };
}
function decodeBand(v: unknown): HueBand {
  const o = requireKeys(v, ['falloffStart', 'rangeStart', 'rangeEnd', 'falloffEnd']);
  return { falloffStart: num(o.falloffStart), rangeStart: num(o.rangeStart), rangeEnd: num(o.rangeEnd), falloffEnd: num(o.falloffEnd) };
}

export function encodeHueSaturation(s: HueSaturationSettings): unknown {
  return {
    range: s.range, colorize: s.colorize, invertRange: s.invertRange,
    adjustments: encodeEnumDictionary(s.adjustments, (a) => ({ hue: a.hue, saturation: a.saturation, lightness: a.lightness })),
    bands: encodeEnumDictionary(s.bands, (b) => ({ falloffStart: b.falloffStart, rangeStart: b.rangeStart, rangeEnd: b.rangeEnd, falloffEnd: b.falloffEnd })),
  };
}
export function decodeHueSaturation(v: unknown): HueSaturationSettings {
  const o = requireKeys(v, ['range', 'colorize', 'invertRange', 'adjustments', 'bands']);
  const base = makeHueSaturation();
  const range = COLOR_RANGES_ALL.includes(o.range as ColorRange) ? o.range as ColorRange : 'Master';
  const adjustments = decodeEnumDictionary(o.adjustments, decodeRange);
  const bands = decodeEnumDictionary(o.bands, decodeBand);
  const result: HueSaturationSettings = { ...base, range, colorize: bool(o.colorize), invertRange: bool(o.invertRange), adjustments: {} };
  for (const r of COLOR_RANGES_ALL) {
    if (adjustments[r]) result.adjustments[r] = adjustments[r];
    if (bands[r]) result.bands[r] = bands[r];
  }
  return result;
}

const encodeLevelRange = (r: LevelRange) => ({ black: r.black, gamma: r.gamma, white: r.white, outputBlack: r.outputBlack, outputWhite: r.outputWhite });
function decodeLevelRange(v: unknown): LevelRange {
  const o = requireKeys(v, ['black', 'gamma', 'white', 'outputBlack', 'outputWhite']);
  return { black: num(o.black), gamma: num(o.gamma, 1), white: num(o.white, 255), outputBlack: num(o.outputBlack), outputWhite: num(o.outputWhite, 255) };
}
function decodeChannel(v: unknown): LevelsChannel {
  return LEVELS_CHANNELS.includes(v as LevelsChannel) ? v as LevelsChannel : 'RGB';
}
export function encodeLevels(s: LevelsSettings): unknown { return { channel: s.channel, ranges: s.ranges.map(encodeLevelRange) }; }
export function decodeLevels(v: unknown): LevelsSettings {
  const o = requireKeys(v, ['channel', 'ranges']);
  if (!Array.isArray(o.ranges)) throw new Error('invalid levels');
  return { channel: decodeChannel(o.channel), ranges: o.ranges.map(decodeLevelRange) };
}
export function encodeCurves(s: CurvesSettings): unknown {
  return { channel: s.channel, channels: s.channels.map((points) => points.map((p) => ({ x: p.x, y: p.y }))) };
}
export function decodeCurves(v: unknown): CurvesSettings {
  const o = requireKeys(v, ['channel', 'channels']);
  if (!Array.isArray(o.channels)) throw new Error('invalid curves');
  return {
    channel: decodeChannel(o.channel),
    channels: o.channels.map((points) => {
      if (!Array.isArray(points)) throw new Error('invalid curves');
      return points.map((p) => { const q = requireKeys(p, ['x', 'y']); return { x: num(q.x), y: num(q.y) }; });
    }),
  };
}
const encodeColor = (c: AdjustmentColor) => ({ red: c.red, green: c.green, blue: c.blue });
function decodeColor(v: unknown): AdjustmentColor {
  const o = requireKeys(v, ['red', 'green', 'blue']);
  return { red: num(o.red), green: num(o.green), blue: num(o.blue) };
}

export function encodeAdjustment(a: LayerAdjustment): unknown {
  const result: Record<string, unknown> = {
    kind: a.kind, hue: a.hue, saturation: a.saturation, lightness: a.lightness, colorize: a.colorize,
    levels: encodeLevels(a.levels), curves: encodeCurves(a.curves),
  };
  if (a.hsvSettings) result.hsvSettings = encodeHueSaturation(a.hsvSettings);
  if (a.exposureSettings) result.exposureSettings = { ...a.exposureSettings };
  if (a.gradientMapSettings) {
    result.gradientMapSettings = { shadows: encodeColor(a.gradientMapSettings.shadows),
      highlights: encodeColor(a.gradientMapSettings.highlights), reversed: a.gradientMapSettings.reversed };
  }
  if (a.grainSettings) result.grainSettings = { ...a.grainSettings };
  return result;
}

export function decodeAdjustment(v: unknown): LayerAdjustment {
  const o = requireKeys(v, ['kind', 'hue', 'saturation', 'lightness', 'colorize', 'levels', 'curves']);
  if (!ADJUSTMENT_KINDS.includes(o.kind as AdjustmentKind)) throw new Error('invalid adjustment kind');
  const result = makeAdjustment(o.kind as AdjustmentKind);
  result.hue = num(o.hue); result.saturation = num(o.saturation); result.lightness = num(o.lightness);
  result.colorize = bool(o.colorize);
  result.levels = decodeLevels(o.levels);
  result.curves = decodeCurves(o.curves);
  if (o.hsvSettings != null) result.hsvSettings = decodeHueSaturation(o.hsvSettings);
  if (o.exposureSettings != null) {
    const e = requireKeys(o.exposureSettings, ['exposure', 'offset', 'gamma']);
    result.exposureSettings = { exposure: num(e.exposure), offset: num(e.offset), gamma: num(e.gamma, 1) };
  }
  if (o.gradientMapSettings != null) {
    const g = requireKeys(o.gradientMapSettings, ['shadows', 'highlights', 'reversed']);
    result.gradientMapSettings = { shadows: decodeColor(g.shadows), highlights: decodeColor(g.highlights), reversed: bool(g.reversed) };
  }
  if (o.grainSettings != null) {
    const g = requireKeys(o.grainSettings, ['amount', 'size', 'roughness', 'seed']);
    result.grainSettings = { amount: num(g.amount), size: num(g.size, 1.5), roughness: num(g.roughness), seed: num(g.seed) >>> 0 };
  }
  return result;
}
