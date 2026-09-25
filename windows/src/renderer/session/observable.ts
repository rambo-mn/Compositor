// Change notification for the editor session. Swift's @Observable tracks every property; here every plain field
// of a session becomes an accessor that reports assignments, and listeners hear about them once per microtask.
// State is treated as immutable (documents, settings and sets are replaced, never mutated in place), so an
// assignment is the only way anything changes.

export class Observable {
  // True private fields, so observeFields never turns the notifier's own state into observed properties.
  #listeners = new Set<() => void>();
  #scheduled = false;
  version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  changed(): void {
    this.version += 1;
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      for (const listener of [...this.#listeners]) listener();
    });
  }
}

/** Turns every own enumerable data property of `target` (except `skip`) into an accessor that calls `changed`
 *  when a different value is assigned. Call at the end of the constructor. */
export function observeFields(target: Observable, skip: ReadonlySet<string> = new Set()): void {
  for (const key of Object.keys(target)) {
    if (skip.has(key) || key === 'version') continue;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value === 'function') continue;
    let value = descriptor.value;
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        if (Object.is(next, value)) return;
        value = next;
        target.changed();
      },
    });
  }
}

/** Adds the methods and accessors of `source` to `target`'s prototype (Swift's extensions). */
export function extend<T extends object>(target: { prototype: T }, source: object): void {
  Object.defineProperties(target.prototype, Object.getOwnPropertyDescriptors(source));
}
