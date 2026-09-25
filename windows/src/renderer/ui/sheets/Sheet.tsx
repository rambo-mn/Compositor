// A modal dialog over the window (the Mac's sheets and alerts): the editor dims behind it and takes no input until
// it closes. Enter chooses the default button and Escape Cancel.
import { useEffect, useRef, type ReactNode } from 'react';

interface SheetKeys { ok: (() => void) | null; cancel: (() => void) | null }
const stack: SheetKeys[] = [];

/** The open dialog (the latest), which takes Enter and Escape and blocks every other shortcut. */
export function topSheet(): SheetKeys | null { return stack[stack.length - 1] ?? null; }

export function Sheet(props: { children: ReactNode; onOK?: (() => void) | null; onCancel?: (() => void) | null; width?: number; testId?: string; label?: string }) {
  const keys = useRef<SheetKeys>({ ok: props.onOK ?? null, cancel: props.onCancel ?? null });
  keys.current.ok = props.onOK ?? null;
  keys.current.cancel = props.onCancel ?? null;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const entry = keys.current;
    stack.push(entry);
    // Focus moves into the dialog (its first field, else the dialog itself), away from the canvas.
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=checkbox]):not([type=range]), select');
    if (first) { first.focus(); if (first instanceof HTMLInputElement) first.select(); }
    else box.current?.focus();
    return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); };
  }, []);
  return (
    <div className="sheet-backdrop">
      <div className="sheet" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.label} data-testid={props.testId}
        style={{ width: props.width }}>
        {props.children}
      </div>
    </div>
  );
}
