// Palette colors and the color picker's HSB model. A port of ColorPalette.swift's value types.

export interface PaletteColor { red: number; green: number; blue: number }

export const BLACK: PaletteColor = Object.freeze({ red: 0, green: 0, blue: 0 });
export const WHITE: PaletteColor = Object.freeze({ red: 1, green: 1, blue: 1 });

export function colorsEqual(a: PaletteColor, b: PaletteColor): boolean {
  return a.red === b.red && a.green === b.green && a.blue === b.blue;
}

/** Snaps to the 8-bit values that painting and export actually store. */
export function quantized(c: PaletteColor): PaletteColor {
  return { red: Math.round(c.red * 255) / 255, green: Math.round(c.green * 255) / 255, blue: Math.round(c.blue * 255) / 255 };
}

export function toHex(c: PaletteColor): string {
  const h = (v: number) => Math.round(v * 255).toString(16).toUpperCase().padStart(2, '0');
  return h(c.red) + h(c.green) + h(c.blue);
}

/** Accepts RRGGBB or shorthand RGB, with or without a leading #. */
export function fromHex(text: string): PaletteColor | null {
  let value = text.trim();
  if (value.startsWith('#')) value = value.slice(1);
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  return { red: ((n >> 16) & 0xff) / 255, green: ((n >> 8) & 0xff) / 255, blue: (n & 0xff) / 255 };
}

export function cssColor(c: PaletteColor, alpha = 1): string {
  const v = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return alpha >= 1 ? `rgb(${v(c.red)}, ${v(c.green)}, ${v(c.blue)})` : `rgba(${v(c.red)}, ${v(c.green)}, ${v(c.blue)}, ${alpha})`;
}

/** Hue in degrees, saturation and brightness 0…1. The picker's source of truth, so hue survives grays and black. */
export interface PickerHSB { hue: number; saturation: number; brightness: number }

export function hsbToRGB(hsb: PickerHSB): PaletteColor {
  const h = (((hsb.hue % 360) + 360) % 360) / 60;
  const c = hsb.brightness * hsb.saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = hsb.brightness - c;
  let r: number, g: number, b: number;
  switch (Math.trunc(h)) {
    case 0: [r, g, b] = [c, x, 0]; break;
    case 1: [r, g, b] = [x, c, 0]; break;
    case 2: [r, g, b] = [0, c, x]; break;
    case 3: [r, g, b] = [0, x, c]; break;
    case 4: [r, g, b] = [x, 0, c]; break;
    default: [r, g, b] = [c, 0, x];
  }
  return { red: r + m, green: g + m, blue: b + m };
}

/** Updates from RGB while keeping the previous hue for grays and the previous saturation for black. */
export function hsbSettingRGB(previous: PickerHSB, color: PaletteColor): PickerHSB {
  const high = Math.max(color.red, color.green, color.blue);
  const low = Math.min(color.red, color.green, color.blue);
  const delta = high - low;
  const result = { ...previous, brightness: high };
  if (high > 0) result.saturation = delta / high;
  if (!(delta > 0)) return result;
  let h: number;
  if (high === color.red) h = (color.green - color.blue) / delta;
  else if (high === color.green) h = (color.blue - color.red) / delta + 2;
  else h = (color.red - color.green) / delta + 4;
  h *= 60;
  result.hue = h < 0 ? h + 360 : h;
  return result;
}

export function hsbFromRGB(color: PaletteColor): PickerHSB {
  return hsbSettingRGB({ hue: 0, saturation: 0, brightness: 0 }, color);
}
