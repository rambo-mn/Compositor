// Tool and layer icons. Most are Lucide's (the Mac app uses SF Symbols); the gradient and polygonal lasso are drawn
// here, as the Mac app draws its own.
import type { ReactNode } from 'react';
import {
  Bandage, ChartSpline, CircleDashed, CircleDot, Contrast, Crop, Droplet, Eraser, Folder, Grid3x3, Hand, Lasso, Move, Paintbrush,
  Palette, Pipette, Search, Shapes, SlidersHorizontal, SquareDashed, Stamp, WandSparkles,
} from 'lucide-react';
import type { NavigationTool } from '../model/settings';
import type { AdjustmentKind } from '../model/adjustments';

/** A one-colour dithered fade from empty to solid (Floyd–Steinberg), so it reads as a gradient beside the others. */
const GRADIENT_PATTERN: boolean[][] = (() => {
  const size = 16;
  const ramp = Array.from({ length: size }, () => Array.from({ length: size }, (_, x) => x / (size - 1)));
  const result = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = ramp[y][x] >= 0.5;
      result[y][x] = on;
      const error = ramp[y][x] - (on ? 1 : 0);
      if (x + 1 < size) ramp[y][x + 1] += error * 7 / 16;
      if (y + 1 >= size) continue;
      if (x > 0) ramp[y + 1][x - 1] += error * 3 / 16;
      ramp[y + 1][x] += error * 5 / 16;
      if (x + 1 < size) ramp[y + 1][x + 1] += error / 16;
    }
  }
  return result;
})();

export function GradientToolIcon({ size = 18 }: { size?: number }) {
  const cells: ReactNode[] = [];
  GRADIENT_PATTERN.forEach((row, y) => row.forEach((on, x) => { if (on) cells.push(<rect key={`${x}-${y}`} x={1 + x} y={1 + y} width={1} height={1} />); }));
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <clipPath id="gradient-tool-clip"><rect x={1} y={1} width={16} height={16} rx={3.5} /></clipPath>
      <g clipPath="url(#gradient-tool-clip)">{cells}</g>
      <rect x={1} y={1} width={16} height={16} rx={3.5} fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
}

/** The lasso's loop and rope drawn as straight segments. */
export function PolygonalLassoToolIcon({ size = 18 }: { size?: number }) {
  const p = (x: number, y: number) => `${x},${y}`;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={`M${[p(1.2, 7), p(4, 2.4), p(11.8, 1.8), p(16.8, 5.2), p(15.6, 10.4), p(7, 11.6)].join('L')}Z`} />
      <path d={`M${[p(8.9, 10.9), p(13.3, 10.5), p(11.6, 14.5)].join('L')}Z`} />
      <path d={`M${p(11.6, 14.5)}L${p(12.9, 17.3)}`} />
    </svg>
  );
}

export function ToolIcon({ tool, erase, marqueeEllipse, polygonal, size = 18 }: {
  tool: NavigationTool; erase?: boolean; marqueeEllipse?: boolean; polygonal?: boolean; size?: number;
}) {
  const props = { size, strokeWidth: 1.7 };
  switch (tool) {
    case 'move': return <Move {...props} />;
    case 'marquee': return marqueeEllipse ? <CircleDashed {...props} /> : <SquareDashed {...props} />;
    case 'lasso': return polygonal ? <PolygonalLassoToolIcon size={size} /> : <Lasso {...props} />;
    case 'wand': return <WandSparkles {...props} />;
    case 'crop': return <Crop {...props} />;
    case 'brush': return erase ? <Eraser {...props} /> : <Paintbrush {...props} />;
    case 'spotHealing': return <Bandage {...props} />;
    case 'cloneStamp': return <Stamp {...props} />;
    case 'blur': return <Droplet {...props} />;
    case 'gradient': return <GradientToolIcon size={size} />;
    case 'shape': return <Shapes {...props} />;
    case 'eyedropper': return <Pipette {...props} />;
    case 'hand': return <Hand {...props} />;
    case 'zoom': return <Search {...props} />;
    default: return null;
  }
}

/** Adjustment layers' and folders' thumbnails. */
export function AdjustmentIcon({ kind, size = 20 }: { kind: AdjustmentKind; size?: number }) {
  const props = { size, strokeWidth: 1.6 };
  switch (kind) {
    case 'Curves': return <ChartSpline {...props} />;
    case 'Levels': return <SlidersHorizontal {...props} />;
    case 'Hue/Saturation': return <Contrast {...props} />;
    case 'Exposure': return <CircleDot {...props} />;
    case 'Gradient Map': return <Palette {...props} />;
    case 'Grain': return <Grid3x3 {...props} />;
  }
}

export function FolderIcon({ size = 24 }: { size?: number }) {
  return <Folder size={size} strokeWidth={1.5} />;
}
