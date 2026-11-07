// The one dropdown control (there are no native selects in the UI). Entries can carry SVG icons and a tooltip, and
// can be disabled. It behaves like a select: click or ArrowUp/Down to open, arrows to move, Enter or Space to pick,
// Esc or a click elsewhere to close. The list is `position: fixed`, so scrolling panels do not clip it.

import { useEffect, useRef, useState } from 'preact/hooks';

import { must } from '../src/util.ts';

/** One entry of a dropdown: its value, the text (and optional icon) shown for it, and whether it can be picked. */
export type DropdownOpt<T> = {
  value: T;
  label: string;
  icon?: preact.ComponentChildren;
  title?: string;
  disabled?: boolean;
};

type Place = { x: number; w: number; top?: number; bottom?: number; max: number };

/** A select-like control over `opts`; the button shows the entry whose value equals `value`. */
export function Dropdown<T>({
  value,
  opts,
  onChange,
  title,
}: {
  /** The current value, or `'mixed'` for a selection whose members differ (the button then shows no entry). */
  value: T | 'mixed';
  opts: DropdownOpt<T>[];
  onChange: (v: T) => void;
  title?: string;
}) {
  const cur = opts.findIndex((o) => o.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [at, setAt] = useState<Place>({ x: 0, w: 0, top: 0, max: 300 });
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!((e.target as Element).closest('.dd-list') || btn.current?.contains(e.target as Node))) setOpen(false);
    };
    const close = (e: Event) => {
      if (!(e.target as Element | Document).contains?.(list.current) || e.target === list.current) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', () => setOpen(false));
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const show = () => {
    const r = must(btn.current).getBoundingClientRect();
    const below = innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const want = opts.length * 26 + 8;
    const up = below < Math.min(want, 160) && above > below;
    setAt(
      up
        ? { x: r.left, w: r.width, bottom: innerHeight - r.top + 2, max: Math.min(want, above) }
        : { x: r.left, w: r.width, top: r.bottom + 2, max: Math.min(want, below) },
    );
    setActive(Math.max(cur, 0));
    setOpen(true);
  };
  const pick = (k: number) => {
    if (opts[k].disabled) return;
    setOpen(false);
    if (k !== cur) onChange(opts[k].value);
  };
  const move = (from: number, step: number) => {
    for (let n = 1; n <= opts.length; n++) {
      const k = (from + step * n + opts.length * n) % opts.length;
      if (!opts[k].disabled) return k;
    }
    return from;
  };
  const key = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step) {
      e.preventDefault();
      if (!open) show();
      else setActive((a) => move(a, step));
    } else if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      pick(active);
    } else if (open && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  const o = opts[cur];
  return (
    <>
      <button
        ref={btn}
        type="button"
        class="dd"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={key}
      >
        <span class="dd-val">
          {o ? o.icon : null}
          {o ? o.label : ''}
        </span>
      </button>
      {open && (
        <div
          ref={list}
          class="dd-list"
          role="listbox"
          style={{
            left: `${at.x}px`,
            top: at.top === undefined ? undefined : `${at.top}px`,
            bottom: at.bottom === undefined ? undefined : `${at.bottom}px`,
            minWidth: `${at.w}px`,
            maxHeight: `${at.max}px`,
          }}
        >
          {opts.map((p, k) => (
            <div
              role="option"
              tabIndex={-1}
              aria-selected={k === cur}
              aria-disabled={p.disabled}
              title={p.title}
              class={k === active && !p.disabled ? 'on' : ''}
              onPointerEnter={() => !p.disabled && setActive(k)}
              onClick={() => pick(k)}
            >
              {p.icon}
              {p.label}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
