// The canvas's pointers, drawn as the Mac app draws them (EditorCanvas.swift): black shapes outlined in white so
// they read on any image, as SVG cursors. Standard pointers (crosshair, grab, resize arrows) use CSS names.
import type { SelectionMode } from '../../model/selection';

const cursor = (svg: string, size: number, hotX: number, hotY: number, fallback = 'default') =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${svg}</svg>`,
  )}") ${hotX} ${hotY}, ${fallback}`;

/** Draws `shape` (SVG elements using `stroke`/`fill` placeholders) as a white outline under black. */
const outlined = (paths: string, width = 1.2, outline = 3.2) =>
  `<g fill="none" stroke="#fff" stroke-width="${outline}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`
  + `<g fill="none" stroke="#000" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;

// The pointer arrow, tip at the origin (y down), about the system arrow's size.
const ARROW = [[0, 0], [0, 16.5], [3.9, 12.8], [6.6, 19], [9.2, 17.9], [6.6, 11.8], [11.8, 11.8]];
const arrowPath = (dx: number, dy: number) => `M${ARROW.map(([x, y]) => `${x + dx},${y + dy}`).join('L')}Z`;
const arrow = (dx: number, dy: number, fill: string, outline: string) =>
  `<path d="${arrowPath(dx, dy)}" fill="${fill}" stroke="${outline}" stroke-width="1.1" stroke-linejoin="round"/>`;
const TIP = { x: 4, y: 3 };
const shadow = `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="0.8" flood-opacity="0.35"/></filter></defs>`;

/** Four arrows around a centre: the Move tool's badge. */
function fourArrows(cx: number, cy: number, reach = 6.5, shaft = 0.75, head = 2, headLength = 2.5): string {
  const arm: [number, number][] = [[-shaft, -reach + headLength], [-head, -reach + headLength], [0, -reach],
    [head, -reach + headLength], [shaft, -reach + headLength], [shaft, -shaft]];
  const points: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    for (let [x, y] of arm) {
      for (let t = 0; t < turn; t++) [x, y] = [-y, x];
      points.push(`${(cx + x).toFixed(2)},${(cy + y).toFixed(2)}`);
    }
  }
  return `<path d="M${points.join('L')}Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke"/>`;
}

const dashedBox = (x: number, y: number, w = 8, h = 6) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#fff" stroke-width="2.5"/>`
  + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#000" stroke-width="1" stroke-dasharray="2 1.5"/>`;

export const CURSORS = {
  arrow: 'default',
  hidden: 'none',
  crosshair: 'crosshair',
  openHand: 'grab',
  closedHand: 'grabbing',
  resizeLeftRight: 'ew-resize',
  move: cursor(shadow + `<g filter="url(#s)">${arrow(TIP.x, TIP.y, '#000', '#fff')}</g>` + fourArrows(TIP.x + 14.5, TIP.y + 17.5), 32, TIP.x, TIP.y),
  duplicate: cursor(shadow + `<g filter="url(#s)">${arrow(TIP.x + 5, TIP.y + 5, '#fff', '#000')}${arrow(TIP.x, TIP.y, '#000', '#fff')}</g>`, 32, TIP.x, TIP.y, 'copy'),
  distort: cursor(shadow + `<g filter="url(#s)">${arrow(TIP.x, TIP.y, '#fff', '#000')}</g>`, 32, TIP.x, TIP.y),
  moveSelection: cursor(shadow + `<g filter="url(#s)">${arrow(TIP.x, TIP.y, '#000', '#fff')}</g>` + dashedBox(TIP.x + 9.5, TIP.y + 13.5), 32, TIP.x, TIP.y, 'move'),
  loadSelection: cursor(shadow + `<g filter="url(#s)">${arrow(TIP.x, TIP.y, '#fff', '#000')}</g>` + dashedBox(TIP.x + 11.5, TIP.y + 14.5), 32, TIP.x, TIP.y, 'pointer'),
  movePixels: cursor(shadow + `<g filter="url(#s)">${arrow(TIP.x, TIP.y, '#000', '#fff')}</g>`
    + outlined(`<circle cx="${TIP.x + 11}" cy="${TIP.y + 21}" r="1.8"/><circle cx="${TIP.x + 17}" cy="${TIP.y + 21}" r="1.8"/>`
      + `<path d="M${TIP.x + 12.2},${TIP.y + 19.6}L${TIP.x + 18.5},${TIP.y + 12}M${TIP.x + 15.8},${TIP.y + 19.6}L${TIP.x + 9.5},${TIP.y + 12}"/>`, 1.1, 3), 32, TIP.x, TIP.y, 'move'),
  rotation: cursor(outlined('<path d="M5.5 9.5a7 7 0 0 1 12-2.5"/><path d="M18.5 14.5a7 7 0 0 1-12 2.5"/>'
    + '<path d="M18 3.5v4h-4"/><path d="M6 20.5v-4h4"/>', 1.6, 4), 24, 12, 12, 'crosshair'),
  eyedropper: cursor(outlined('<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/>'
    + '<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>', 1.5, 4), 24, 2, 22, 'crosshair'),
  zoomIn: cursor('<circle cx="10" cy="10" r="6.5" fill="#fff"/>' + outlined('<circle cx="10" cy="10" r="7"/><path d="m21 21-6-6"/><path d="M10 7v6"/><path d="M7 10h6"/>', 1.6, 4), 24, 10, 10, 'zoom-in'),
  zoomOut: cursor('<circle cx="10" cy="10" r="6.5" fill="#fff"/>' + outlined('<circle cx="10" cy="10" r="7"/><path d="m21 21-6-6"/><path d="M7 10h6"/>', 1.6, 4), 24, 10, 10, 'zoom-out'),
};

// MARK: Selection tools

export type SelectionIcon = 'freehandLasso' | 'polygonalLasso' | 'rectangleMarquee' | 'ellipseMarquee';

function selectionIcon(icon: SelectionIcon, x: number, y: number, size: number): string {
  const u = size / 18;
  const p = (px: number, py: number) => `${(x + px * u).toFixed(2)},${(y + py * u).toFixed(2)}`;
  switch (icon) {
    case 'polygonalLasso':
      return outlined(`<path d="M${[p(1.2, 7), p(4, 2.4), p(11.8, 1.8), p(16.8, 5.2), p(15.6, 10.4), p(7, 11.6)].join('L')}Z"/>`
        + `<path d="M${[p(8.9, 10.9), p(13.3, 10.5), p(11.6, 14.5)].join('L')}Z"/><path d="M${p(11.6, 14.5)}L${p(12.9, 17.3)}"/>`, 1.2, 3);
    case 'freehandLasso':
      return outlined(`<ellipse cx="${x + 9 * u}" cy="${y + 6.5 * u}" rx="${7.5 * u}" ry="${5 * u}"/>`
        + `<path d="M${p(9.5, 11.4)}C${p(9, 13.5)} ${p(12, 14)} ${p(11.5, 17.5)}"/>`, 1.2, 3);
    case 'rectangleMarquee':
      return `<rect x="${x + 1}" y="${y + 2}" width="${size - 2}" height="${size - 4}" fill="none" stroke="#fff" stroke-width="3"/>`
        + `<rect x="${x + 1}" y="${y + 2}" width="${size - 2}" height="${size - 4}" fill="none" stroke="#000" stroke-width="1.2" stroke-dasharray="2.5 1.5"/>`;
    case 'ellipseMarquee':
      return `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 - 1}" fill="none" stroke="#fff" stroke-width="3"/>`
        + `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 - 1}" fill="none" stroke="#000" stroke-width="1.2" stroke-dasharray="2.5 1.5"/>`;
  }
}

function modeBadge(mode: SelectionMode, cx: number, cy: number): string {
  if (mode === 'New') return '';
  const lines = `<path d="M${cx - 3},${cy}H${cx + 3}"/>` + (mode === 'Add' ? `<path d="M${cx},${cy - 3}V${cy + 3}"/>` : '');
  return outlined(lines, 1.2, 3.2);
}

const crosshair = (hx: number, hy: number) => outlined(`<path d="M${hx - 7},${hy}H${hx + 7}M${hx},${hy - 7}V${hy + 7}"/>`, 1, 3);

const selectionCache = new Map<string, string>();

/** Crosshair with the tool's icon beneath and right of it, and "+" (add) or "−" (subtract) beside the icon. */
export function selectionCursor(icon: SelectionIcon, mode: SelectionMode): string {
  const key = icon + mode;
  let value = selectionCache.get(key);
  if (!value) {
    const hx = 9, hy = 9;
    const box = { x: hx + 5, y: hy + 5, size: 12 };
    value = cursor(crosshair(hx, hy) + selectionIcon(icon, box.x, box.y, box.size) + modeBadge(mode, box.x + box.size + 5, box.y + box.size / 2),
      36, hx, hy, 'crosshair');
    selectionCache.set(key, value);
  }
  return value;
}

/** A wand whose sparkle is the hot spot, with the same "+" / "−" badges. */
export function wandCursor(mode: SelectionMode): string {
  const key = 'wand' + mode;
  let value = selectionCache.get(key);
  if (!value) {
    const h = 7;
    const stick = `<path d="M${h + 6},${h + 6}L${h + 20},${h + 20}"/>`;
    let marks = '';
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) marks += `<path d="M${h + dx * 2.5},${h + dy * 2.5}L${h + dx * 6},${h + dy * 6}"/>`;
    if (mode !== 'New') {
      const cx = h + 17, cy = h + 5;
      marks += `<path d="M${cx - 3},${cy}H${cx + 3}"/>` + (mode === 'Add' ? `<path d="M${cx},${cy - 3}V${cy + 3}"/>` : '');
    }
    const svg = `<g fill="none" stroke="#fff" stroke-linecap="round"><g stroke-width="5">${stick}</g><g stroke-width="3.2">${marks}</g></g>`
      + `<g fill="none" stroke="#000" stroke-linecap="round"><g stroke-width="2.4">${stick}</g><g stroke-width="1.2">${marks}</g></g>`;
    value = cursor(svg, 32, h, h, 'crosshair');
    selectionCache.set(key, value);
  }
  return value;
}

/** Option-click on the bottom of a layer row: makes (or releases) a clipping mask. */
export function clippingCursor(releasing: boolean): string {
  const box = `<rect x="12" y="13" width="12" height="9" rx="1.5"/>`;
  const sign = releasing ? '<path d="M21 9.5h5"/>' : '<path d="M21 9.5h5M23.5 7v5"/>';
  return cursor(outlined(`<path d="M4 3v7a3 3 0 0 0 3 3h3"/><path d="m8 10.5 2.5 2.5L8 15.5"/>${box}${sign}`, 1.4, 3.6), 30, 3, 3, 'pointer');
}

/** The CSS resize cursor for a transform handle, turned with the box (TransformOverlayGeometry.resizeCursor). */
export function resizeCursor(handles: { x: number; y: number }[], index: number): string {
  const angle = Math.atan2(handles[2].y - handles[0].y, handles[2].x - handles[0].x);
  const offsets = [Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, 0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, 0];
  const direction = ((Math.round((angle + offsets[index]) / (Math.PI / 4)) % 4) + 4) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][direction];
}

/** The crop frame's handles, top-left clockwise. */
export const CROP_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
