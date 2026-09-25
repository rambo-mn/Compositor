// Tools and their settings. Ports NavigationTool (EditorSession.swift), BrushSettings (BrushStroke.swift), tool
// modes (SmudgeLiquify.swift), CloneSettings, WandSettings, GradientSettings and FilterSettings.
import {
  CurvesSettings, ExposureSettings, GradientMapSettings, GrainSettings, defaultCurves, defaultExposure,
  defaultGradientMap, defaultGrain, normalizedExposure, normalizedGrain, clampValue, clampedColor,
} from './adjustments';

export type NavigationTool = 'move' | 'marquee' | 'lasso' | 'wand' | 'crop' | 'brush' | 'spotHealing' | 'cloneStamp'
  | 'blur' | 'gradient' | 'shape' | 'eyedropper' | 'hand' | 'zoom' | 'idle';

/** The tool rail's order (No tool, A, isn't on the rail). */
export const RAIL_TOOLS: NavigationTool[] = ['move', 'marquee', 'lasso', 'wand', 'crop', 'brush', 'spotHealing',
  'cloneStamp', 'blur', 'gradient', 'shape', 'eyedropper', 'hand', 'zoom'];

export const isBrushTool = (t: NavigationTool) => t === 'brush' || t === 'spotHealing' || t === 'cloneStamp' || t === 'blur';
export const isSelectionTool = (t: NavigationTool) => t === 'marquee' || t === 'lasso' || t === 'wand';

export function toolLabel(t: NavigationTool): string {
  switch (t) {
    case 'eyedropper': return 'Eyedropper (I)';
    case 'marquee': return 'Marquee (M)';
    case 'lasso': return 'Lasso (L)';
    case 'wand': return 'Magic Wand (W)';
    case 'brush': return 'Brush (B) · Eraser (E)';
    case 'spotHealing': return 'Spot Healing Brush (J)';
    case 'cloneStamp': return 'Clone Stamp (S) · Alt-click sets the source';
    case 'blur': return 'Smear (R)';
    case 'gradient': return 'Gradient (G)';
    case 'shape': return 'Shape (U) · Shift+U switches Rectangle/Ellipse';
    case 'crop': return 'Crop (C)';
    case 'move': return 'Move / Transform (V)';
    case 'hand': return 'Hand (H)';
    case 'zoom': return 'Zoom (Z)';
    case 'idle': return 'No tool (A)';
  }
}

export type SpotHealingMode = 'Content-Aware' | 'Create Texture' | 'Proximity Match';
export const SPOT_HEALING_MODES: SpotHealingMode[] = ['Content-Aware', 'Create Texture', 'Proximity Match'];

export type BrushToolMode = 'Paint' | 'Erase';
export const BRUSH_MODES: BrushToolMode[] = ['Paint', 'Erase'];

export type BlurToolMode = 'Liquify' | 'Blur' | 'Smudge';
export const BLUR_MODES: BlurToolMode[] = ['Liquify', 'Blur', 'Smudge'];

export interface BrushSettings {
  diameter: number;
  hardness: number;
  red: number;
  green: number;
  blue: number;
  /** Caps the whole stroke: overlapping dabs never exceed it. */
  opacity: number;
  erasing: boolean;
  healing: boolean;
  healingMode: SpotHealingMode;
}

export const defaultBrushSettings = (): BrushSettings => ({
  diameter: 40, hardness: 1, red: 0, green: 0, blue: 0, opacity: 1, erasing: false, healing: false, healingMode: 'Content-Aware',
});

export interface CloneSettings {
  /** The source moves with the brush and keeps its offset between strokes. */
  aligned: boolean;
  /** Copy from every visible layer as shown rather than the active layer alone. */
  sampleAllLayers: boolean;
}

export type WandSampleSize = 0 | 1 | 2;
export const WAND_SAMPLE_TITLES = ['Point Sample', '3 by 3 Average', '5 by 5 Average'];

export interface WandSettings {
  /** How far (0–255) each channel may differ from the sampled color and still be selected. */
  tolerance: number;
  /** Pixels either side of the click averaged into the color to match. */
  sampleSize: WandSampleSize;
  contiguous: boolean;
  sampleAllLayers: boolean;
}

export const defaultWandSettings = (): WandSettings => ({ tolerance: 32, sampleSize: 0, contiguous: true, sampleAllLayers: false });

export type GradientStyle = 'Foreground to Background' | 'Foreground to Transparent';
export const GRADIENT_STYLES: GradientStyle[] = ['Foreground to Background', 'Foreground to Transparent'];
export type GradientShape = 'Linear' | 'Radial';
export const GRADIENT_SHAPES: GradientShape[] = ['Linear', 'Radial'];

export interface GradientSettings { shape: GradientShape; style: GradientStyle; reversed: boolean; opacity: number }
export const defaultGradientSettings = (): GradientSettings => ({ shape: 'Linear', style: 'Foreground to Transparent', reversed: false, opacity: 1 });

export type FilterKind = 'Gaussian Blur' | 'Motion Blur' | 'Add Noise' | 'Lens Correction' | 'Remove Background'
  | 'Content-Aware Fill' | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain';
export const FILTER_KINDS: FilterKind[] = ['Gaussian Blur', 'Motion Blur', 'Add Noise', 'Lens Correction', 'Remove Background',
  'Content-Aware Fill', 'Curves', 'Exposure', 'Gradient Map', 'Grain'];
export const isAutomaticFilter = (k: FilterKind) => k === 'Content-Aware Fill' || k === 'Remove Background';
/** Color adjustments live in the Image menu (and as adjustment layers), not under Filter. */
export const isImageAdjustment = (k: FilterKind) => k === 'Curves' || k === 'Exposure' || k === 'Gradient Map' || k === 'Grain';

export type BackgroundQuality = 'Basic' | 'Advanced';

export interface FilterSettings {
  /** Gaussian Blur radius in layer pixels (the blur's standard deviation), 0.1–250. */
  radius: number;
  /** Motion Blur direction in degrees, counterclockwise from horizontal, −90–90. */
  angle: number;
  /** Motion Blur streak length in layer pixels, 1–2000. */
  distance: number;
  /** Add Noise strength as a percentage, 0.1–400. */
  amount: number;
  gaussian: boolean;
  monochromatic: boolean;
  /** Lens Correction's Remove Distortion, −100–100. */
  distortion: number;
  curves: CurvesSettings;
  exposure: ExposureSettings;
  gradientMap: GradientMapSettings;
  grain: GrainSettings;
  backgroundQuality: BackgroundQuality;
  refineEdges: number;
  matteContrast: number;
  shiftEdge: number;
}

export const defaultFilterSettings = (): FilterSettings => ({
  radius: 1, angle: 0, distance: 10, amount: 10, gaussian: false, monochromatic: false, distortion: 0,
  curves: defaultCurves(), exposure: defaultExposure(), gradientMap: defaultGradientMap(), grain: defaultGrain(),
  backgroundQuality: 'Basic', refineEdges: 12, matteContrast: 25, shiftEdge: 0,
});

export function normalizedFilterSettings(s: FilterSettings): FilterSettings {
  return {
    ...s,
    radius: clampValue(s.radius, 0.1, 250, 1),
    angle: clampValue(s.angle, -90, 90, 0),
    distance: clampValue(s.distance, 1, 2000, 10),
    amount: clampValue(s.amount, 0.1, 400, 10),
    distortion: clampValue(s.distortion, -100, 100, 0),
    refineEdges: clampValue(s.refineEdges, 0, 40, 12),
    matteContrast: clampValue(s.matteContrast, 0, 100, 25),
    shiftEdge: clampValue(s.shiftEdge, -10, 10, 0),
    exposure: normalizedExposure(s.exposure),
    gradientMap: { ...s.gradientMap, shadows: clampedColor(s.gradientMap.shadows), highlights: clampedColor(s.gradientMap.highlights) },
    grain: normalizedGrain(s.grain),
  };
}
