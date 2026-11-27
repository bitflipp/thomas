// The MIDI port choosers of the toolbar: a button (Play, MIDI in) joined to a ▾ that opens a popover with the ports as
// radio buttons. A right click on the main button opens it too. Opening asks for MIDI access (`onOpen`), so the list
// is there before anything was played; the toolbar itself never changes when ports come and go.

import { useEffect, useState } from 'preact/hooks';

/** A split button: `children` is the main button, the ▾ beside it opens the list of `ports` under `heading`. */
export function PortMenu({
  children,
  heading,
  ports,
  value,
  onPick,
  onOpen,
  empty,
}: {
  children: preact.ComponentChildren;
  heading: string;
  ports: { id: string; name: string }[];
  value: string | null;
  onPick: (id: string) => void;
  onOpen: () => void;
  empty: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!(e.target as Element).closest?.('.portmenu.open')) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', esc, true);
    return () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const show = () => {
    if (!open) onOpen();
    setOpen(!open);
  };
  return (
    <div
      class={`portmenu seg${open ? ' open' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!open) show();
      }}
    >
      {children}
      <button type="button" class="more" title={heading} aria-haspopup="menu" aria-expanded={open} onClick={show}>
        ▾
      </button>
      {open && (
        <div class="popover" role="menu">
          <div class="heading">{heading}</div>
          {ports.length === 0 && <div class="muted">{empty}</div>}
          {ports.map((p) => (
            <label key={p.id}>
              <input
                type="radio"
                checked={p.id === value}
                onChange={() => {
                  setOpen(false);
                  onPick(p.id);
                }}
              />{' '}
              {p.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
