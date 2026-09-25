// React bindings for the editor's observable state (the session and the workspace). Components read what they
// need through `useSelect`, so a brush stroke or a drag re-renders only what shows the values it changes.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Observable } from '../session/observable';

/** One level deep: arrays element by element, plain objects key by key. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** Re-renders whenever `source` changes. */
export function useObserved<T extends Observable>(source: T): T {
  useSyncExternalStore(source.subscribe, () => source.version);
  return source;
}

/** Re-renders only when what `select` reads from `source` changes (compared one level deep). */
export function useSelect<T extends Observable, R>(source: T, select: (source: T) => R): R {
  const cache = useRef<{ source: T; version: number; select: (source: T) => R; value: R } | null>(null);
  const getSnapshot = (): R => {
    const current = cache.current;
    if (current && current.source === source && current.version === source.version && current.select === select) return current.value;
    const value = select(source);
    if (current && current.source === source && shallowEqual(current.value, value)) {
      cache.current = { source, version: source.version, select, value: current.value };
      return current.value;
    }
    cache.current = { source, version: source.version, select, value };
    return value;
  };
  return useSyncExternalStore(source.subscribe, getSnapshot);
}

/** A value that follows `value` except while the user is typing into the field that shows it. */
export function useDraft(value: string, editing: boolean): [string, (text: string) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  return [draft, setDraft];
}

/** Hands keyboard focus back to the window, so a tool's key works straight away after using a control. */
export function releaseFocus(): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) active.blur();
}

/** Whether keys typed now go to a text field (which keeps its own editing keys). */
export function isTyping(target: EventTarget | null = document.activeElement): boolean {
  const element = target as HTMLElement | null;
  if (!element || element === document.body) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(element.type);
  }
  return element instanceof HTMLSelectElement;
}
