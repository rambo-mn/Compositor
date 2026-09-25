// Drop-down and context menus: the menu bar's menus, the Layers panel's row menu and its adjustment menu. Items
// show their shortcut, a check mark, or a submenu; the arrow keys, Enter and Escape work while one is open.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronRight } from 'lucide-react';

export interface MenuItem {
  label?: string;
  accel?: string;
  enabled?: boolean;
  checked?: boolean;
  run?: () => void;
  submenu?: MenuItem[];
  separator?: boolean;
  testId?: string;
}

export const separator: MenuItem = { separator: true };

const actionable = (item: MenuItem) => !item.separator && item.enabled !== false && (!!item.run || !!item.submenu);

/** A list of menu items. `onClose` is called once an item is chosen or the menu is dismissed; `onSide` lets the
 *  menu bar move to the next menu with Left and Right. */
export function MenuList(props: {
  items: MenuItem[]; onClose: () => void; style?: CSSProperties; onSide?: (direction: -1 | 1) => void; keyboard?: boolean;
  depth?: number; testId?: string; onHighlight?: (item: MenuItem | null) => void; initialHighlight?: number;
}) {
  const [highlight, setHighlightIndex] = useState(props.initialHighlight ?? -1);
  const setHighlight = (index: number) => {
    setHighlightIndex(index);
    props.onHighlight?.(props.items[index] ?? null);
  };
  const [openSub, setOpenSub] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const [subTop, setSubTop] = useState(0);
  const depth = props.depth ?? 0;

  const choose = (item: MenuItem) => {
    if (!actionable(item) || item.submenu) return;
    props.onClose();
    // After the menu has gone, so whatever the item opens (a rename field, a dialog) keeps its focus.
    setTimeout(() => item.run?.(), 0);
  };

  useEffect(() => {
    if (props.keyboard === false) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      // A submenu that is open handles the keys itself.
      if (openSub >= 0) return;
      const step = (direction: 1 | -1) => {
        const count = props.items.length;
        let index = highlight;
        for (let i = 0; i < count; i++) {
          index = (index + direction + count) % count;
          if (actionable(props.items[index])) { setHighlight(index); return; }
        }
      };
      if (event.key === 'ArrowDown') step(1);
      else if (event.key === 'ArrowUp') step(-1);
      else if (event.key === 'ArrowRight') {
        const item = props.items[highlight];
        if (item?.submenu && actionable(item)) { openSubmenu(highlight); }
        else if (props.onSide) props.onSide(1);
        else return;
      } else if (event.key === 'ArrowLeft') {
        if (depth > 0) props.onClose();
        else if (props.onSide) props.onSide(-1);
        else return;
      } else if (event.key === 'Enter' || event.key === ' ') {
        const item = props.items[highlight];
        if (item?.submenu && actionable(item)) openSubmenu(highlight);
        else if (item) choose(item);
      } else if (event.key === 'Escape') props.onClose();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const openSubmenu = (index: number) => {
    const row = list.current?.children[index] as HTMLElement | undefined;
    setSubTop(row ? row.offsetTop - 4 : 0);
    setOpenSub(index);
    setHighlight(index);
  };

  return (
    <div className="menu" ref={list} style={props.style} role="menu" data-testid={props.testId}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      {props.items.map((item, index) => {
        if (item.separator) return <div key={index} className="menu-separator" />;
        const enabled = actionable(item);
        return (
          <div key={index} role="menuitem" aria-disabled={!enabled} data-testid={item.testId}
            className={`menu-item${enabled ? '' : ' disabled'}${index === highlight ? ' highlight' : ''}`}
            onMouseEnter={() => {
              setHighlight(index);
              if (item.submenu && enabled) openSubmenu(index); else setOpenSub(-1);
            }}
            onMouseUp={(event) => { if (event.button === 0) choose(item); }}>
            <span className="menu-check">{item.checked ? <Check size={13} /> : null}</span>
            <span className="menu-label">{item.label}</span>
            {item.accel ? <span className="menu-accel">{item.accel}</span> : null}
            {item.submenu ? <ChevronRight size={13} className="menu-arrow" /> : null}
            {item.submenu && openSub === index && enabled ? (
              <MenuList items={item.submenu} depth={depth + 1} style={{ position: 'absolute', left: '100%', top: subTop }}
                onClose={() => { setOpenSub(-1); }} keyboard
                onSide={undefined} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A menu shown at a point (a right-click, or under a button), kept inside the window. */
export function PopupMenu(props: {
  x: number; y: number; items: MenuItem[]; onClose: () => void; testId?: string; onHighlight?: (item: MenuItem | null) => void;
  initialHighlight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.x, top: props.y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(4, Math.min(props.x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(props.y, window.innerHeight - box.height - 4)),
    });
  }, [props.x, props.y]);
  useEffect(() => {
    const close = () => props.onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  });
  return (
    <div className="popup-layer" ref={ref} style={{ left: position.left, top: position.top }}>
      <MenuList items={props.items} onClose={props.onClose} testId={props.testId} onHighlight={props.onHighlight}
        initialHighlight={props.initialHighlight} />
    </div>
  );
}
