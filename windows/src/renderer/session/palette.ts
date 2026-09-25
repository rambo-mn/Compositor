// Foreground and background colours, the colour picker, and sampling colours from the canvas. A port of the
// session half of ColorPalette.swift.
import { EditorSession, ColorPickerState } from './session';
import { extend } from './observable';
import { BLACK, PaletteColor, WHITE, colorsEqual, hsbFromRGB, hsbSettingRGB, hsbToRGB, quantized } from '../model/color';
import type { Point } from '../model/geometry';
import { liveScene } from './scene';

export function pickerColor(state: ColorPickerState): PaletteColor {
  return quantized(hsbToRGB({ hue: state.hue, saturation: state.saturation, brightness: state.brightness }));
}

const palette = {
  get foregroundColor(): PaletteColor {
    const s = (this as unknown as EditorSession).brushSettings;
    return { red: s.red, green: s.green, blue: s.blue };
  },
  set foregroundColor(value: PaletteColor) {
    const session = this as unknown as EditorSession;
    session.brushSettings = { ...session.brushSettings, red: value.red, green: value.green, blue: value.blue };
  },

  get canEditPalette(): boolean {
    const s = this as unknown as EditorSession;
    return !s.isProjectBusy && !s.brushStroke;
  },

  /** On a mask the palette is black and white. */
  paletteColor(this: EditorSession, background: boolean): PaletteColor {
    if (this.isMaskSelected) return (background ? !this.maskPaintWhite : this.maskPaintWhite) ? WHITE : BLACK;
    return background ? this.backgroundColor : this.foregroundColor;
  },

  setPaletteColor(this: EditorSession, color: PaletteColor, background: boolean): void {
    if (!this.canEditPalette) return;
    if (this.isMaskSelected) {
      const white = colorsEqual(color, WHITE);
      this.maskPaintWhite = background ? !white : white;
    } else if (background) this.backgroundColor = color;
    else this.foregroundColor = color;
  },

  swapPaletteColors(this: EditorSession): void {
    if (!this.canEditPalette) return;
    if (this.isMaskSelected) { this.maskPaintWhite = !this.maskPaintWhite; return; }
    const old = this.foregroundColor;
    this.foregroundColor = this.backgroundColor;
    this.backgroundColor = old;
  },

  resetPaletteColors(this: EditorSession): void {
    if (!this.canEditPalette) return;
    if (this.isMaskSelected) { this.maskPaintWhite = false; return; }
    this.foregroundColor = BLACK;
    this.backgroundColor = WHITE;
  },

  openColorPicker(this: EditorSession, background: boolean): void {
    if (!this.canEditPalette || this.isMaskSelected) return;
    const original = this.paletteColor(background);
    this.colorPicker = { target: { kind: 'palette', background }, original, ...hsbFromRGB(original) };
  },

  /** The picker's working colour changed (hue, saturation, brightness). */
  updateColorPicker(this: EditorSession, hsb: { hue: number; saturation: number; brightness: number }): void {
    const picker = this.colorPicker;
    if (!picker) return;
    this.colorPicker = { ...picker, ...hsb };
    this.previewGradientMapColor();
  },

  setColorPickerRGB(this: EditorSession, color: PaletteColor): void {
    const picker = this.colorPicker;
    if (!picker) return;
    this.updateColorPicker(hsbSettingRGB({ hue: picker.hue, saturation: picker.saturation, brightness: picker.brightness }, color));
  },

  closeColorPicker(this: EditorSession, commit: boolean): void {
    const picker = this.colorPicker;
    if (picker) {
      const color = pickerColor(picker);
      if (picker.target.kind === 'palette') {
        if (commit && !this.isMaskSelected) this.setPaletteColor(color, picker.target.background);
      } else {
        // The end has been previewing the working colour; Cancel puts the original back.
        this.setGradientMapColor(commit ? color : picker.original, picker.target.highlights);
      }
    }
    this.colorPicker = null;
  },

  /** Opens the colour picker on one end of the Gradient Map being edited. */
  openGradientMapColorPicker(this: EditorSession, highlights: boolean): void {
    const edit = this.filterEdit;
    if (!this.canEditPalette || this.colorPicker || !edit || edit.kind !== 'Gradient Map' || edit.committing) return;
    const value = highlights ? edit.settings.gradientMap.highlights : edit.settings.gradientMap.shadows;
    const original = { red: value.red, green: value.green, blue: value.blue };
    this.colorPicker = { target: { kind: 'gradientMap', highlights }, original, ...hsbFromRGB(original) };
  },

  /** While the picker is open on a Gradient Map end, the gradient (and canvas) follow its working colour. */
  previewGradientMapColor(this: EditorSession): void {
    const picker = this.colorPicker;
    if (!picker || picker.target.kind !== 'gradientMap') return;
    this.setGradientMapColor(pickerColor(picker), picker.target.highlights);
  },

  setGradientMapColor(this: EditorSession, color: PaletteColor, highlights: boolean): void {
    const edit = this.filterEdit;
    if (!edit || edit.kind !== 'Gradient Map' || edit.committing) return;
    const gradientMap = { ...edit.settings.gradientMap, [highlights ? 'highlights' : 'shadows']: { red: color.red, green: color.green, blue: color.blue } };
    this.updateFilter({ ...edit.settings, gradientMap }, edit.preview);
  },

  /** Loads the canvas colour under a document point into the open picker. */
  sampleIntoColorPicker(this: EditorSession, point: Point): void {
    const color = this.colorPicker ? this.sampleCompositeColor(point) : null;
    if (color) this.setColorPickerRGB(color);
  },

  /** The composited colour of the visible layers at one document pixel, as shown on the canvas; null outside the
   *  canvas or over fully transparent pixels. */
  sampleCompositeColor(this: EditorSession, point: Point): PaletteColor | null {
    const document = this.document, gpu = this.gpu;
    if (!document || !gpu || !(point.x >= 0 && point.y >= 0 && point.x < document.width && point.y < document.height)) return null;
    const pixel = gpu.renderRegion(liveScene(this, document), { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 });
    const alpha = pixel[3];
    if (!alpha) return null;
    const channel = (v: number) => Math.round(Math.min(alpha, v) / alpha * 255) / 255;
    return { red: channel(pixel[0]), green: channel(pixel[1]), blue: channel(pixel[2]) };
  },
};

type Palette = typeof palette;
declare module './session' {
  interface EditorSession extends Palette {}
}
extend(EditorSession, palette);
