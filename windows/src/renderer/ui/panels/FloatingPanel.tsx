// A movable, non-modal panel for tool dialogs (FloatingPanel.swift): it never dims the editor, opens centred on the
// canvas the first time, and reopens wherever it was last left while the app runs. Its close button cancels.
// Enter chooses OK and Escape Cancel, whether focus is in the panel or on the canvas.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

const positions = new Map<string, { left: number; top: number }>();

interface PanelKeys { name: string; ok: () => void; cancel: () => void }
const stack: PanelKeys[] = [];

/** The open panel (the latest opened) takes Enter and Escape. */
export function topPanel(): PanelKeys | null { return stack[stack.length - 1] ?? null; }

export function FloatingPanel(props: {
  name: string; title: string; onCancel: () => void; onOK: () => void; children: ReactNode; width?: number; testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => positions.get(props.name) ?? null);
  const keys = useRef<PanelKeys>({ name: props.name, ok: props.onOK, cancel: props.onCancel });
  keys.current.ok = props.onOK;
  keys.current.cancel = props.onCancel;

  useEffect(() => {
    const entry = keys.current;
    stack.push(entry);
    return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); };
  }, []);

  useLayoutEffect(() => {
    if (position) return;
    const panel = ref.current?.getBoundingClientRect();
    const canvas = document.querySelector('.canvas-area')?.getBoundingClientRect();
    const area = canvas ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const width = panel?.width ?? 400, height = panel?.height ?? 300;
    const next = { left: Math.max(8, area.left + (area.width - width) / 2), top: Math.max(48, area.top + (area.height - height) / 2) };
    positions.set(props.name, next);
    setPosition(next);
  }, [position, props.name]);

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, left: position?.left ?? 0, top: position?.top ?? 0 };
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const box = ref.current?.getBoundingClientRect();
      const next = {
        left: Math.min(window.innerWidth - 60, Math.max(-(box?.width ?? 0) + 60, start.left + e.clientX - start.x)),
        top: Math.min(window.innerHeight - 30, Math.max(0, start.top + e.clientY - start.y)),
      };
      positions.set(props.name, next);
      setPosition(next);
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };

  return (
    <div className="floating-panel" ref={ref} role="dialog" aria-label={props.title} data-testid={props.testId}
      style={{ left: position?.left ?? -10000, top: position?.top ?? 0, width: props.width }}>
      <div className="floating-title" onPointerDown={startDrag}>
        <span>{props.title}</span>
        <button type="button" className="panel-close" aria-label="Close" onMouseDown={(e) => e.preventDefault()} onClick={props.onCancel}>
          <X size={13} />
        </button>
      </div>
      <div className="floating-body">{props.children}</div>
    </div>
  );
}
