// The tool rail down the left of the window and the foreground/background swatches under it
// (ContentView.toolRail and ColorPaletteControls.swift).
import { useState } from 'react';
import { ArrowLeftRight, RotateCcw } from 'lucide-react';
import type { EditorSession } from '../session';
import { RAIL_TOOLS, toolLabel } from '../model/settings';
import { cssColor, BLACK, WHITE } from '../model/color';
import { useSelect } from './hooks';
import { ToolIcon } from './icons';
import { PopupMenu } from './Menu';

export function ToolRail({ session }: { session: EditorSession }) {
  const state = useSelect(session, (s) => ({
    tool: s.tool, erase: s.brushMode === 'Erase', ellipse: s.marqueeKind === 'Ellipse', polygonal: s.lassoKind === 'Polygonal',
  }));
  return (
    <div className="tool-rail" data-testid="toolRail">
      <div className="tool-list">
        {RAIL_TOOLS.map((tool) => (
          <button key={tool} type="button" className={`tool-button${state.tool === tool ? ' selected' : ''}`} title={toolLabel(tool)}
            aria-label={toolLabel(tool)} aria-pressed={state.tool === tool} data-testid={`tool-${tool}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => session.selectTool(tool)}>
            <ToolIcon tool={tool} erase={state.erase} marqueeEllipse={state.ellipse} polygonal={state.polygonal} />
          </button>
        ))}
        <ColorPaletteControls session={session} />
      </div>
    </div>
  );
}

/** Foreground over background, a swap arrow and a reset. With a mask selected they are black and white only. */
function ColorPaletteControls({ session }: { session: EditorSession }) {
  const state = useSelect(session, (s) => ({
    foreground: s.paletteColor(false), background: s.paletteColor(true), masked: s.isMaskSelected, enabled: s.canEditPalette,
  }));
  const [maskMenu, setMaskMenu] = useState<{ x: number; y: number; background: boolean } | null>(null);
  const click = (background: boolean, event: React.MouseEvent) => {
    if (state.masked) {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setMaskMenu({ x: box.right + 4, y: box.top, background });
    } else session.openColorPicker(background);
  };
  const swatch = (background: boolean) => (
    <button type="button" className={`palette-swatch ${background ? 'background' : 'foreground'}`} disabled={!state.enabled}
      title={background ? 'Background color' : 'Foreground color'} aria-label={background ? 'Background color' : 'Foreground color'}
      style={{ background: cssColor(background ? state.background : state.foreground) }}
      data-testid={background ? 'backgroundSwatch' : 'foregroundSwatch'}
      onMouseDown={(event) => event.preventDefault()} onClick={(event) => click(background, event)} />
  );
  return (
    <div className="palette">
      {swatch(true)}
      {swatch(false)}
      <button type="button" className="palette-swap" title="Swap foreground and background (X)" aria-label="Swap colors" disabled={!state.enabled}
        onMouseDown={(event) => event.preventDefault()} onClick={() => session.swapPaletteColors()}>
        <ArrowLeftRight size={10} style={{ transform: 'rotate(-45deg)' }} />
      </button>
      <button type="button" className="palette-reset" title="Default colors (D)" aria-label="Default colors" disabled={!state.enabled}
        onMouseDown={(event) => event.preventDefault()} onClick={() => session.resetPaletteColors()}>
        <RotateCcw size={9} />
      </button>
      {maskMenu ? (
        <PopupMenu x={maskMenu.x} y={maskMenu.y} onClose={() => setMaskMenu(null)} items={[
          { label: maskMenu.background ? 'Mask background:' : 'Mask foreground:', enabled: false },
          { label: 'Black · Hide', run: () => session.setPaletteColor(BLACK, maskMenu.background) },
          { label: 'White · Reveal', run: () => session.setPaletteColor(WHITE, maskMenu.background) },
        ]} />
      ) : null}
    </div>
  );
}
