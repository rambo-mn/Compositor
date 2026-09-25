// The bar under the title bar with the current tool's options (TransformInspector, BrushControls, LassoControls,
// GradientControls, ShapeControls, NavigationToolHeader and CropControls in the Mac app).
import { Link } from 'lucide-react';
import type { EditorSession } from '../session';
import { useSelect } from './hooks';
import { Button, NumberField, Segmented, Select, Slider, Swatch, Toggle, Divider, formatNumber } from './controls';
import { BLUR_MODES, BRUSH_MODES, GRADIENT_SHAPES, GRADIENT_STYLES, SPOT_HEALING_MODES, WAND_SAMPLE_TITLES, isBrushTool, isSelectionTool } from '../model/settings';
import type { WandSampleSize } from '../model/settings';
import { LAYER_SAMPLINGS, LayerTransform, makeTransform, scalePercent, scaledToPercent } from '../model/transform';
import { layerPixelSize, SHAPE_KINDS } from '../model/document';
import { LASSO_CHOICES, MARQUEE_CHOICES, SELECTION_MODES } from '../model/selection';
import { CROP_RATIOS } from '../model/crop';

export function OptionBar({ session }: { session: EditorSession }) {
  const tool = useSelect(session, (s) => s.tool);
  let bar: React.ReactNode;
  if (tool === 'move') bar = <TransformInspector session={session} />;
  else if (isBrushTool(tool)) bar = <BrushControls session={session} />;
  else if (isSelectionTool(tool)) bar = <LassoControls session={session} />;
  else if (tool === 'gradient') bar = <GradientControls session={session} />;
  else if (tool === 'shape') bar = <ShapeControls session={session} />;
  else if (tool === 'eyedropper') bar = <EyedropperBar session={session} />;
  else if (tool === 'hand' || tool === 'zoom') bar = <NavigationToolHeader session={session} />;
  else if (tool === 'crop') bar = <CropControls session={session} />;
  // No tool (A) keeps the bar, so the canvas doesn't jump.
  else bar = <div className="option-bar"><span className="bar-title">Select a tool</span></div>;
  return <div className="option-bar-host" data-testid="optionBar">{bar}</div>;
}

// MARK: Move

function TransformInspector({ session }: { session: EditorSession }) {
  const state = useSelect(session, (s) => {
    const layer = s.activeLayer;
    const value: LayerTransform = s.transformEdit?.draft ?? (layer ? s.editedTransform(layer) : makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }));
    return {
      value, mask: s.transformTargetsMask, autoSelect: s.transformAutoSelect, controls: s.showsTransformControls,
      locked: s.locksTransformRatio, editing: !!s.transformEdit, distorted: !!s.transformEdit?.corners,
      enabled: s.canTransform || !!s.transformEdit, pixelSize: s.transformPixelSize ?? (layer ? layerPixelSize(layer) : value.size),
      layerID: s.activeLayerID,
    };
  });
  const value = state.value;
  const change = (update: (t: LayerTransform) => LayerTransform | null) => {
    if (!session.transformEdit) session.beginTransform();
    const draft = session.transformEdit?.draft;
    if (!draft) return;
    const next = update({ ...draft, origin: { ...draft.origin }, size: { ...draft.size } });
    if (next) session.previewTransform(next);
  };
  const resize = (number: number, width: boolean) => change((t) => {
    if (!(number >= 1)) return null;
    if (width) {
      if (session.locksTransformRatio) t.size.height *= number / t.size.width;
      t.size.width = number;
    } else {
      if (session.locksTransformRatio) t.size.width *= number / t.size.height;
      t.size.height = number;
    }
    return t;
  });
  // Numbers describe an ordinary transform; while distorted, the handles are the controls.
  const disabled = !state.enabled || state.distorted;
  return (
    <div className="option-bar" key={state.layerID ?? 'none'}>
      <span className="bar-title">{state.mask ? 'Transform Mask' : 'Transform'}</span>
      <Toggle label="Auto Select" checked={state.autoSelect} onChange={(v) => { session.transformAutoSelect = v; }} testId="transformAutoSelect"
        title="Select layers by clicking the canvas. When off, hold Ctrl to select a layer." />
      <Toggle label="Show Controls" checked={state.controls} onChange={(v) => { session.showsTransformControls = v; }}
        title="Show the transform box and handles (Ctrl+H). When hidden, drag anywhere to move the layer." />
      <div className="bar-scroll">
        <Field label="X"><NumberField value={value.origin.x} decimals={2} live disabled={disabled} width={62} testId="transformX"
          onChange={(v) => change((t) => { t.origin.x = v; return t; })} /></Field>
        <Field label="Y"><NumberField value={value.origin.y} decimals={2} live disabled={disabled} width={62} testId="transformY"
          onChange={(v) => change((t) => { t.origin.y = v; return t; })} /></Field>
        <Field label="W"><NumberField value={value.size.width} decimals={2} live disabled={disabled} width={62} testId="transformW"
          onChange={(v) => resize(v, true)} /></Field>
        <Field label="H"><NumberField value={value.size.height} decimals={2} live disabled={disabled} width={62} testId="transformH"
          onChange={(v) => resize(v, false)} /></Field>
        <Button kind="icon" active={state.locked} title="Lock aspect ratio" label="Lock aspect ratio" disabled={disabled}
          onClick={() => { session.locksTransformRatio = !session.locksTransformRatio; }}><Link size={14} /></Button>
        <Field label="Scale"><NumberField value={scalePercent(value, state.pixelSize)} decimals={2} live suffix="%" disabled={disabled} width={62}
          title="Scale width and height together, about the center"
          onChange={(v) => change((t) => (v > 0 ? scaledToPercent(t, v, state.pixelSize) : null))} /></Field>
        <Field label="°"><NumberField value={value.rotation} decimals={2} live disabled={disabled} width={56}
          onChange={(v) => change((t) => { t.rotation = v % 360; return t; })} /></Field>
        <Field label="Sampling"><Select options={LAYER_SAMPLINGS.map((v) => ({ value: v, label: v }))} value={value.sampling} disabled={disabled}
          onChange={(v) => change((t) => { t.sampling = v; return t; })} /></Field>
        <Button disabled={disabled} onClick={() => change((t) => { t.flipX = !t.flipX; return t; })}>Flip H</Button>
        <Button disabled={disabled} onClick={() => change((t) => { t.flipY = !t.flipY; return t; })}>Flip V</Button>
      </div>
      <Button disabled={!state.editing} onClick={() => session.cancelTransform()}>Cancel</Button>
      <Button kind="primary" disabled={!state.editing} onClick={() => session.commitTransform()} testId="applyTransform">Apply</Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <span className="labeled"><span className="caption">{label}</span>{children}</span>;
}

// MARK: Brushes

function BrushControls({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    tool: x.tool, brushMode: x.brushMode, blurMode: x.blurMode, healing: x.spotHealingMode, clone: x.cloneSettings,
    settings: x.brushSettings, masked: x.isMaskSelected, maskWhite: x.maskPaintWhite, foreground: x.foregroundColor,
    canPalette: x.canEditPalette, source: !!x.cloneSource, busy: x.showsBusy,
  }));
  const title = s.tool === 'spotHealing' ? 'Spot Healing' : s.tool === 'cloneStamp' ? 'Clone Stamp' : s.tool === 'blur' ? 'Smear'
    : s.brushMode === 'Erase' ? 'Eraser' : 'Brush';
  const set = (change: Partial<typeof s.settings>) => { session.brushSettings = { ...session.brushSettings, ...change }; };
  return (
    <div className={`option-bar${s.busy ? ' disabled' : ''}`}>
      <span className="bar-title">{title}</span>
      {s.tool === 'brush' ? <Segmented options={BRUSH_MODES.map((v) => ({ value: v, label: v }))} value={s.brushMode}
        onChange={(v) => { session.brushMode = v; }} title="Paint with the foreground color (B), or erase pixels away (E)" /> : null}
      {s.tool === 'blur' ? <Segmented options={BLUR_MODES.map((v) => ({ value: v, label: v }))} value={s.blurMode}
        onChange={(v) => { session.blurMode = v; }} title="Liquify pushes pixels · Blur softens · Smudge drags color along" /> : null}
      {s.tool === 'spotHealing' ? <Segmented options={SPOT_HEALING_MODES.map((v) => ({ value: v, label: v }))} value={s.healing}
        onChange={(v) => { session.spotHealingMode = v; }} label="Type" /> : null}
      {s.tool === 'cloneStamp' ? <>
        <Toggle label="Aligned" checked={s.clone.aligned} onChange={(v) => { session.cloneSettings = { ...session.cloneSettings, aligned: v }; }}
          title="Keep the source moving with the brush between strokes; off starts every stroke at the source point" />
        <Segmented options={[{ value: false, label: 'This Layer' }, { value: true, label: 'All Layers' }]} value={s.clone.sampleAllLayers}
          onChange={(v) => { session.cloneSettings = { ...session.cloneSettings, sampleAllLayers: v }; }}
          title="Copy from the active layer only, or from every visible layer as shown" />
      </> : null}
      <span className="caption-text">Size</span>
      <NumberField value={s.settings.diameter} min={1} max={2000} width={48} suffix="px" label="Size" testId="brushSize"
        onChange={(v) => set({ diameter: Math.round(v) })} title="[ and ] change the size" />
      <span className="caption-text">Hardness</span>
      <Slider value={s.settings.hardness} min={0} max={1} onChange={(v) => set({ hardness: v })} label="Hardness" />
      <NumberField value={s.settings.hardness * 100} min={0} max={100} width={42} suffix="%" label="Hardness percent"
        onChange={(v) => set({ hardness: v / 100 })} title="Shift+[ and Shift+] change the hardness" />
      <span className="caption-text">{s.tool === 'blur' ? 'Strength' : 'Opacity'}</span>
      <Slider value={s.settings.opacity} min={0.01} max={1} onChange={(v) => set({ opacity: v })} label="Opacity" />
      <NumberField value={s.settings.opacity * 100} min={1} max={100} width={42} suffix="%" label="Opacity percent" testId="brushOpacity"
        onChange={(v) => set({ opacity: v / 100 })} title="Press 1–9 for 10–90%, 0 for 100%" />
      {s.masked ? (
        <Select options={[{ value: 0, label: 'Black · Hide' }, { value: 1, label: 'White · Reveal' }]} value={s.maskWhite ? 1 : 0}
          onChange={(v) => { session.maskPaintWhite = v === 1; }} label="Paint" width={140} />
      ) : s.tool !== 'cloneStamp' && s.tool !== 'blur' ? (
        <span className="labeled"><span className="caption-text">Color</span>
          <Swatch color={s.foreground} disabled={!s.canPalette} title="Foreground color" onClick={() => session.openColorPicker(false)} />
        </span>
      ) : null}
      <span className="spacer" />
      {s.tool === 'cloneStamp' && !s.source ? <span className="secondary">Alt-click to set the source</span> : null}
      {s.masked ? <span className="secondary">Mask</span> : null}
    </div>
  );
}

// MARK: Selection tools

function LassoControls({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    tool: x.tool, marquee: x.marqueeKind, lasso: x.lassoKind, mode: x.displayedSelectionMode, wand: x.wandSettings,
    antialias: x.selectionAntialiased, expand: x.selectionExpandAmount, contract: x.selectionContractAmount,
    canModify: x.canModifySelection, selection: x.selection ? (x.selection.path.isEmpty ? 'empty' : 'some') : null,
    canEdit: x.canEditSelection, disabled: x.showsBusy || !x.document,
  }));
  return (
    <div className={`option-bar${s.disabled ? ' disabled' : ''}`}>
      <span className="bar-title">{s.tool === 'marquee' ? 'Marquee' : s.tool === 'wand' ? 'Magic Wand' : 'Lasso'}</span>
      {s.tool === 'marquee' ? <Segmented options={MARQUEE_CHOICES.map((v) => ({ value: v, label: v }))} value={s.marquee}
        onChange={(v) => { session.cancelLasso(); session.marqueeKind = v; }} title="Draw rectangles or ellipses" /> : null}
      {s.tool === 'lasso' ? <Segmented options={LASSO_CHOICES.map((v) => ({ value: v, label: v }))} value={s.lasso}
        onChange={(v) => { session.cancelLasso(); session.lassoKind = v; }} title="Freehand draws as you drag; Polygonal clicks corners" /> : null}
      {/* Shows a held Shift or Alt (or an outline's mode) live; clicking sets the choice. */}
      <Segmented options={SELECTION_MODES.map((v) => ({ value: v, label: v }))} value={s.mode}
        onChange={(v) => { session.selectionModeChoice = v; }} title="Hold Shift to add or Alt to subtract for one outline" />
      {s.tool === 'wand' ? <>
        <span className="labeled" title="How far each color channel (0–255) can differ from the clicked color and still be selected">
          <span className="caption-text">Tolerance</span>
          <NumberField value={s.wand.tolerance} min={0} max={255} width={44} label="Tolerance"
            onChange={(v) => { session.wandSettings = { ...session.wandSettings, tolerance: Math.round(v) }; }} />
        </span>
        <Select options={WAND_SAMPLE_TITLES.map((title, i) => ({ value: i as WandSampleSize, label: title }))} value={s.wand.sampleSize}
          onChange={(v) => { session.wandSettings = { ...session.wandSettings, sampleSize: v }; }}
          title="Match the clicked pixel, or the average of the pixels around it" />
        <Segmented options={[{ value: false, label: 'This Layer' }, { value: true, label: 'All Layers' }]} value={s.wand.sampleAllLayers}
          onChange={(v) => { session.wandSettings = { ...session.wandSettings, sampleAllLayers: v }; }}
          title="Read colors from the active layer only, or from every visible layer as shown" />
        <Toggle label="Contiguous" checked={s.wand.contiguous} onChange={(v) => { session.wandSettings = { ...session.wandSettings, contiguous: v }; }}
          title="Select only similar pixels connected to the one you click; off selects them everywhere" />
      </> : null}
      {/* Rectangles snap to whole pixels, so smoothing doesn't apply (as in Photoshop); ellipses curve. */}
      {s.tool === 'lasso' || s.tool === 'wand' || (s.tool === 'marquee' && s.marquee === 'Ellipse') ? (
        <Toggle label="Anti-alias" checked={s.antialias} onChange={(v) => { session.selectionAntialiased = v; }}
          title="Smooth selection edges; turn off for hard pixel edges" />
      ) : null}
      <Divider vertical />
      <span className="labeled" title="Expand the selection by this many pixels">
        <Button disabled={!s.canModify} onClick={() => session.expandSelection(session.selectionExpandAmount)}>Expand</Button>
        <NumberField value={s.expand} min={1} max={500} width={40} suffix="px" disabled={!s.canModify} label="Expand amount"
          onChange={(v) => { session.selectionExpandAmount = Math.round(v); }} />
      </span>
      <span className="labeled" title="Contract the selection by this many pixels">
        <Button disabled={!s.canModify} onClick={() => session.contractSelection(session.selectionContractAmount)}>Contract</Button>
        <NumberField value={s.contract} min={1} max={500} width={40} suffix="px" disabled={!s.canModify} label="Contract amount"
          onChange={(v) => { session.selectionContractAmount = Math.round(v); }} />
      </span>
      <span className="spacer" />
      {s.selection === 'empty' ? <span className="secondary">Empty selection</span> : null}
      {s.selection ? <Button disabled={!s.canEdit} onClick={() => session.deselect()}>Deselect</Button> : null}
    </div>
  );
}

// MARK: Gradient, Shape, Eyedropper

function GradientControls({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({
    settings: x.gradientSettings, masked: x.isMaskSelected, editing: !!x.gradientEdit, colors: x.gradientColors(false),
    disabled: x.showsBusy || !x.document,
  }));
  const set = (change: Partial<typeof s.settings>) => { session.gradientSettings = { ...session.gradientSettings, ...change }; };
  const css = (c: number[]) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
  return (
    <div className={`option-bar${s.disabled ? ' disabled' : ''}`}>
      <span className="bar-title">Gradient</span>
      <Segmented options={GRADIENT_SHAPES.map((v) => ({ value: v, label: v }))} value={s.settings.shape} onChange={(v) => set({ shape: v })}
        title="Linear runs along the line; Radial spreads out from the start point" />
      <span className="gradient-swatch checker" aria-hidden="true">
        <span style={{ background: `linear-gradient(to right, ${css(s.colors[0])}, ${css(s.colors[1])})` }} />
      </span>
      <Select options={GRADIENT_STYLES.map((v) => ({ value: v, label: v }))} value={s.settings.style} onChange={(v) => set({ style: v })} label="Colors" />
      <Toggle label="Reverse" checked={s.settings.reversed} onChange={(v) => set({ reversed: v })} />
      <span className="caption-text">Opacity</span>
      <Slider value={s.settings.opacity} min={0.01} max={1} onChange={(v) => set({ opacity: v })} label="Opacity" />
      <NumberField value={s.settings.opacity * 100} min={1} max={100} width={42} suffix="%" label="Opacity percent"
        onChange={(v) => set({ opacity: v / 100 })} title="Press 1–9 for 10–90%, 0 for 100%" />
      <span className="spacer" />
      {s.masked ? <span className="secondary">Mask</span> : null}
      {s.editing ? <>
        <Button onClick={() => session.cancelGradient()}>Cancel</Button>
        <Button kind="primary" onClick={() => void session.commitGradient()}>Apply</Button>
      </> : null}
    </div>
  );
}

function ShapeControls({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({ kind: x.shapeKind, radius: x.shapeCornerRadius, color: x.foregroundColor, disabled: x.showsBusy || !x.document }));
  return (
    <div className={`option-bar${s.disabled ? ' disabled' : ''}`}>
      <span className="bar-title">Shape</span>
      <Segmented options={SHAPE_KINDS.map((v) => ({ value: v, label: v }))} value={s.kind}
        onChange={(v) => { session.cancelShape(); session.shapeKind = v; }} title="Shift+U switches between Rectangle and Ellipse" />
      {s.kind === 'Rectangle' ? (
        <span className="labeled" title="Round the rectangle's corners by this many pixels; 0 keeps them square">
          <span className="caption-text">Radius</span>
          <Slider value={Math.min(200, s.radius)} min={0} max={200} onChange={(v) => { session.shapeCornerRadius = Math.round(v); }} label="Corner radius" />
          <NumberField value={s.radius} min={0} max={5000} width={48} suffix="px" label="Corner radius pixels"
            onChange={(v) => { session.shapeCornerRadius = v; }} />
        </span>
      ) : null}
      <span className="labeled" title="Shapes fill with the foreground color; click to change it">
        <span className="caption-text">Fill</span>
        <Swatch color={s.color} width={36} radius={3} onClick={() => session.openColorPicker(false)} title="Fill color" />
      </span>
      <span className="spacer" />
    </div>
  );
}

function EyedropperBar({ session }: { session: EditorSession }) {
  const ring = useSelect(session, (s) => s.showsSampleRing);
  return (
    <div className="option-bar">
      <span className="bar-title">Eyedropper</span>
      <Toggle label="Sample Ring" checked={ring} onChange={(v) => { session.showsSampleRing = v; }} />
      <span className="spacer" />
    </div>
  );
}

// MARK: Hand and Zoom, Crop

function NavigationToolHeader({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({ tool: x.tool, zoom: x.viewport.zoom, enabled: !!x.document && !x.showsBusy }));
  return (
    <div className="option-bar">
      <span className="bar-title">{s.tool === 'hand' ? 'Pan' : 'Zoom'}</span>
      {s.tool === 'zoom' ? (
        <NumberField value={s.zoom * 100} decimals={2} min={0.1} max={3200} width={72} suffix="%" disabled={!s.enabled} label="Zoom percentage"
          title="Zoom percentage (0.1–3200%). Press Enter to apply." testId="zoomField"
          onChange={(v) => { if (!session.isProjectBusy) session.zoom(v / 100); }} />
      ) : null}
      <span className="spacer" />
    </div>
  );
}

function CropControls({ session }: { session: EditorSession }) {
  const s = useSelect(session, (x) => ({ ratio: x.cropRatioChoice, rect: x.cropRect, disabled: x.showsBusy || !x.document }));
  return (
    <div className={`option-bar${s.disabled ? ' disabled' : ''}`}>
      <span className="bar-title">Crop</span>
      <Select options={CROP_RATIOS.map((v) => ({ value: v as string, label: v }))} value={s.ratio} width={120} label="Ratio"
        onChange={(v) => { session.cropRatioChoice = v; session.changeCropRatio(); }} />
      {s.rect ? <span className="mono">{formatNumber(Math.trunc(s.rect.width), 0)} × {formatNumber(Math.trunc(s.rect.height), 0)} px</span> : null}
      <span className="spacer" />
      <Button disabled={!s.rect} onClick={() => session.cancelCrop()}>Cancel</Button>
      <Button kind="primary" disabled={!s.rect} onClick={() => void session.commitCrop()} testId="applyCrop">Apply Crop</Button>
    </div>
  );
}
