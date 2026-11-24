// The Expression pane under the score: how the piece is played, as opposed to how it is written. A roll shows every sounding
// note where it is heard (shifted attacks included) with its velocity as brightness; below it one lane at a time holds the
// velocity, shift or gate of each note (a stem to drag) or one of the performance curves (tempo, sustain, una corda: points
// and regions to draw). The notes are selected here and in the score alike, and the toolbar acts on that selection. All
// expression editing is done here; the state, the pointer handling and the actions are in expression.ts, the drawing of the
// canvas in exprDraw.ts.

import { effect } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RampShape } from '../src/editor/expression.ts';
import { RAMP_SHAPES } from '../src/editor/expression.ts';
import { must } from '../src/util.ts';
import type { DropdownOpt } from './Dropdown.tsx';
import { Dropdown } from './Dropdown.tsx';
import type { Frame } from './exprDraw.ts';
import { paint, RAMP_GRADIENT, readColors, velocityColor } from './exprDraw.ts';
import * as E from './expression.ts';
import { reveal } from './interact.ts';
import { playing, playTick } from './player.ts';
import { exprView, selection, showHints } from './state.ts';

/** A labeled number field. It shows `'mixed'` (an empty box) when the selected notes differ, and commits on Enter or when it loses focus. */
function Field({
  label,
  title,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  title: string;
  value: number | 'mixed' | undefined;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <label class="xf" title={title}>
      <span>{label}</span>
      <input
        type="number"
        key={String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value === 'mixed' || value === undefined ? '' : value}
        placeholder={value === 'mixed' ? 'mixed' : '–'}
        onChange={(e) => {
          const text = (e.target as HTMLInputElement).value;
          const n = Number(text);
          if (text !== '' && Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

/** A small group of buttons that change a value by fixed amounts. */
function Steps({
  steps,
  label,
  disabled,
  onStep,
}: {
  steps: number[];
  label: string;
  disabled: boolean;
  onStep: (d: number) => void;
}) {
  return (
    <div class="seg">
      {steps.map((d) => (
        <button
          type="button"
          disabled={disabled}
          title={`${label} ${d > 0 ? '+' : '−'}${Math.abs(d)}`}
          onClick={() => onStep(d)}
        >
          {d > 0 ? '+' : '−'}
          {Math.abs(d)}
        </button>
      ))}
    </div>
  );
}

const SHAPES: { value: RampShape; label: string; title: string }[] = [
  { value: 'linear', label: 'Linear', title: 'Evenly from the first to the last note' },
  { value: 'ease-in', label: 'Ease in', title: 'Slowly at first, then faster' },
  { value: 'ease-out', label: 'Ease out', title: 'Quickly at first, then slower' },
  { value: 's-curve', label: 'S-curve', title: 'Slowly at both ends' },
];

const ROLL_DIRS: DropdownOpt<'up' | 'down'>[] = [
  { value: 'up', label: 'Up from lowest' },
  { value: 'down', label: 'Down from highest' },
];

const ROLL_ANCHORS: DropdownOpt<'first' | 'last'>[] = [
  { value: 'first', label: 'First on the beat' },
  { value: 'last', label: 'Last on the beat' },
];

/** The velocity presets of the tools, grouped by the dynamic they stand for (loud to soft, as in Pianizer). */
const VEL_GROUPS: [string, number[]][] = [
  ['ff', [110, 115, 120]],
  ['f', [95, 100, 105]],
  ['mf', [75, 80, 85, 90]],
  ['mp', [55, 60, 65, 70]],
  ['p', [35, 40, 45, 50]],
  ['pp', [20, 25, 30]],
  ['ppp', [5, 10, 15]],
];

/** The changes the delta tool offers. */
const DELTAS = [-10, -5, -1, 1, 5, 10];

type Tool = 'set' | 'curve' | 'delta';

/** The grid of velocity buttons, each in its velocity's color; `from` marks the first pick of a ramp. */
function VelocityGrid({ from, onPick }: { from?: number; onPick: (v: number) => void }) {
  return (
    <div class="vgrid">
      {VEL_GROUPS.map(([name, values]) => (
        <>
          <span class="vlab">{name}</span>
          {[0, 1, 2, 3].map((i) => {
            const v = values[i];
            if (v === undefined) return <span />;
            const c = velocityColor(v);
            return (
              <button
                type="button"
                class={from === v ? 'on' : ''}
                style={{ background: c.css, color: c.light > 0.6 ? '#1d1d22' : '#ffffff' }}
                onClick={() => onPick(v)}
              >
                {v}
              </button>
            );
          })}
        </>
      ))}
    </div>
  );
}

/** A small plot of a ramp shape, sampled from the shape's own function so it is always what the shape does. */
function ShapeGlyph({ shape }: { shape: RampShape }) {
  const ease = RAMP_SHAPES[shape];
  const pts = Array.from({ length: 25 }, (_, k) => {
    const t = k / 24;
    return `${k ? 'L' : 'M'}${(2 + t * 26).toFixed(2)} ${(16 - ease(t) * 14).toFixed(2)}`;
  });
  return (
    <svg viewBox="0 0 30 18" width="30" height="18" aria-hidden="true">
      <path d="M2 2 L2 16 L28 16" fill="none" stroke="currentColor" opacity="0.35" />
      <path d={pts.join(' ')} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

/** Where a tool window opens: under its button, or at a point (the pointer, when a key opened it). */
type Place = { anchor: HTMLElement; point?: undefined } | { point: { x: number; y: number }; anchor?: undefined };

/** The last place the pointer was seen, so that a key can open a tool window under it. */
const pointer = { x: 200, y: 200 };

/** The help text at the bottom of a tool window; for the ramp it follows the step the person is at. */
const toolHelp = (tool: Tool, first: number | undefined): string => {
  switch (tool) {
    case 'set':
      return 'Note velocity: click a value to give every selected note exactly that velocity (1–127). The buttons are grouped by the dynamic they stand for, from ff at the top to ppp at the bottom. Escape closes the window without a change.';
    case 'curve':
      return first === undefined
        ? 'Ramp, step 1 of 2: choose a shape above (how the change is spread over time), then click the velocity the first selected note should get. The selected notes are ordered by their onset.'
        : `Ramp, step 2 of 2: the first note gets ${first}. Click the velocity the last selected note should get; the notes between follow the chosen shape. Picking ${first} again does nothing, Escape cancels.`;
    case 'delta':
      return 'Velocity delta: raise or lower the velocity of every selected note by a fixed amount, keeping the differences between them. Notes without a velocity of their own start from the one their dynamic gives. Escape closes the window without a change.';
  }
};

/** The window of the open tool: it opens under its button or at the pointer and closes on a pick, Escape or a click elsewhere. */
function ToolWindow({ tool, place, onClose }: { tool: Tool; place: Place; onClose: () => void }) {
  const { anchor, point } = place;
  const box = useRef<HTMLDivElement>(null);
  const [first, setFirst] = useState<number | undefined>();
  const [at, setAt] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (point) {
      // The pointer lands inside the window, near its top left corner, so that a pick is a short move.
      const left = Math.max(8, Math.min(point.x - 16, innerWidth - el.offsetWidth - 8));
      const top = Math.max(8, Math.min(point.y - 16, innerHeight - el.offsetHeight - 8));
      setAt({ left, top });
      return;
    }
    const r = must(anchor).getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8));
    const top = r.bottom + 2 + el.offsetHeight > innerHeight - 8 ? r.top - 2 - el.offsetHeight : r.bottom + 2;
    setAt({ left, top: Math.max(8, top) });
  }, [anchor, point]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!(box.current?.contains(e.target as Node) || anchor?.contains(e.target as Node))) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [anchor, onClose]);
  return (
    <div ref={box} class="vtool" role="dialog" style={{ left: `${at.left}px`, top: `${at.top}px` }}>
      {tool === 'set' && (
        <VelocityGrid
          onPick={(v) => {
            E.setVelocity(v);
            onClose();
          }}
        />
      )}
      {tool === 'curve' && (
        <>
          <div class="vshapes">
            {SHAPES.map((s) => (
              <button
                type="button"
                class={E.rampShape.value === s.value ? 'on' : ''}
                title={s.title}
                onClick={() => (E.rampShape.value = s.value)}
              >
                <ShapeGlyph shape={s.value} />
                {s.label}
              </button>
            ))}
          </div>
          <VelocityGrid
            from={first}
            onPick={(v) => {
              if (first === undefined) setFirst(v);
              else if (v !== first) {
                E.applyRamp(first, v);
                onClose();
              }
            }}
          />
        </>
      )}
      {tool === 'delta' && (
        <div class="vshapes">
          {DELTAS.map((d) => (
            <button
              type="button"
              onClick={() => {
                E.nudgeVelocity(d);
                onClose();
              }}
            >
              {d > 0 ? `+${d}` : `−${-d}`}
            </button>
          ))}
        </div>
      )}
      {showHints.value && <p class="vhelp">{toolHelp(tool, first)}</p>}
    </div>
  );
}

/** The controls of the velocity lane: the three tools (1, 2, 3 on the canvas) and the exact value. */
function VelocityBar({ none }: { none: boolean }) {
  const [open, setOpen] = useState<({ tool: Tool } & Place) | null>(null);
  const tools: { tool: Tool; key: string; label: string; title: string }[] = [
    {
      tool: 'set',
      key: '1',
      label: 'Set',
      title: 'Give the selected notes one velocity, picked from the dynamics (1)',
    },
    {
      tool: 'curve',
      key: '2',
      label: 'Ramp',
      title: 'Shape the velocities along a ramp: pick its shape, then the start and the end (2)',
    },
    {
      tool: 'delta',
      key: '3',
      label: 'Delta',
      title: 'Raise or lower the velocities of the selected notes by a fixed amount (3)',
    },
  ];
  // The keys 1, 2 and 3 open the tools (as in Pianizer) wherever the focus is in the Expression view, also with a tool
  // window open (it then switches to that tool), except while a text field is being typed in.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = tools.find((x) => x.key === e.key);
      const target = e.target as HTMLElement;
      if (!t || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!none) setOpen(open?.tool === t.tool ? null : { tool: t.tool, point: { x: pointer.x, y: pointer.y } });
    };
    const move = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointermove', move, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointermove', move, true);
    };
  });
  return (
    <>
      <div class="seg">
        {tools.map((t) => (
          <button
            type="button"
            data-tool={t.tool}
            disabled={none}
            aria-pressed={open?.tool === t.tool}
            title={t.title}
            onClick={(e) =>
              setOpen(open?.tool === t.tool ? null : { tool: t.tool, anchor: e.currentTarget as HTMLElement })
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {open && (
        <ToolWindow
          key={open.tool}
          tool={open.tool}
          place={open}
          onClose={() => {
            setOpen(null);
            document.querySelector<HTMLElement>('.expression canvas')?.focus();
          }}
        />
      )}
      <Field
        label="Velocity"
        title="The velocity of the selected notes (1–127). Notes without one follow the dynamics."
        value={E.sharedValue('vel')}
        min={1}
        max={127}
        disabled={none}
        onChange={E.setVelocity}
      />
      <span class="xramp" title="The colors of the notes in the roll: soft (blue) to loud (red), 1 to 127">
        <i style={{ background: RAMP_GRADIENT }} />
      </span>
    </>
  );
}

/** The controls of the shift lane: set, nudge, roll a chord. */
function ShiftBar({ none }: { none: boolean }) {
  return (
    <>
      <Field
        label="Shift"
        title="Milliseconds the selected notes are struck later (negative: earlier) than written"
        value={E.sharedValue('shift')}
        min={-2000}
        max={2000}
        disabled={none}
        onChange={E.setShift}
      />
      <Steps steps={[-10, -1, 1, 10]} label="Shift" disabled={none} onStep={E.nudgeShift} />
      <span class="sep" />
      <span class="lbl">Roll</span>
      <Dropdown
        title="Which note of the chord is struck first"
        value={E.rollDir.value}
        opts={ROLL_DIRS}
        onChange={(v) => (E.rollDir.value = v)}
      />
      <Field
        label="over"
        title="Milliseconds from the first note of the chord to the last"
        value={E.rollSpan.value}
        min={1}
        max={2000}
        onChange={(n) => (E.rollSpan.value = n)}
      />
      <Dropdown
        title="Which note stays on the beat"
        value={E.rollAnchor.value}
        opts={ROLL_ANCHORS}
        onChange={(v) => (E.rollAnchor.value = v)}
      />
      <button
        type="button"
        disabled={none}
        title="Spread the attacks of each chord among the selected notes over this time"
        onClick={E.applyRoll}
      >
        Roll
      </button>
    </>
  );
}

/** The controls of the gate lane. */
function GateBar({ none }: { none: boolean }) {
  return (
    <>
      <Field
        label="Gate"
        title="How long the selected notes sound, as a factor of the length the notation gives (below 1 shorter, above 1 held on)"
        value={E.sharedValue('gate')}
        min={0.05}
        max={4}
        step={0.05}
        disabled={none}
        onChange={E.setGate}
      />
      <Steps steps={[-0.1, -0.05, 0.05, 0.1]} label="Gate" disabled={none} onStep={E.nudgeGate} />
    </>
  );
}

/** The hints of the lanes that hold curves. */
const CURVE_HINTS: Record<'tempo' | 'sustain' | 'soft', string> = {
  tempo:
    'Click to add a point, drag to move it (Alt: any value, not only the usual ones), Delete removes it. 100% is the notated tempo.',
  sustain:
    'Click to add a point, drag to move it (Alt: any value, not only the usual ones), Delete removes it. The pedal is up before the first point.',
  soft: 'Drag to put the soft pedal down, drag an edge or the body of a region to change it, Delete removes it.',
};

/** The controls of a curve lane: the value of the selected point, and clearing the lane. */
function CurveBar({ which }: { which: 'tempo' | 'sustain' | 'soft' }) {
  const value = E.pointValue();
  return (
    <>
      {which !== 'soft' && (
        <Field
          label="Point"
          title="The value of the selected point"
          value={
            value === undefined
              ? undefined
              : which === 'tempo'
                ? Math.round(value * 1000) / 10
                : Math.round(value * 100)
          }
          min={which === 'tempo' ? 10 : 0}
          max={which === 'tempo' ? 1000 : 100}
          disabled={value === undefined}
          onChange={(n) => E.setPointValue(n / (which === 'tempo' ? 100 : 100))}
        />
      )}
      {showHints.value && <span class="hint">{CURVE_HINTS[which]}</span>}
    </>
  );
}

/** The row of controls for the open lane. */
function LaneBar() {
  const l = E.lane.value;
  const none = E.selected.value.size === 0;
  const curve = l === 'tempo' || l === 'sustain' || l === 'soft';
  return (
    <div class="xbar">
      {l === 'velocity' && <VelocityBar none={none} />}
      {l === 'shift' && <ShiftBar none={none} />}
      {l === 'gate' && <GateBar none={none} />}
      {curve && <CurveBar which={l} />}
      <span class="grow" />
      {curve ? (
        <button type="button" class="danger" title="Remove everything in this lane" onClick={E.clearLane}>
          Clear
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={none}
            title={`Take ${l === 'velocity' ? 'the velocity' : l === 'shift' ? 'the shift' : 'the gate'} off the selected notes (Delete); the notation decides again. ${none ? 'No notes are selected.' : `${E.selected.value.size} selected.`}`}
            onClick={() => E.resetHeads()}
          >
            Reset
          </button>
          <button
            type="button"
            disabled={none}
            title="Take velocity, shift and gate all off the selected notes"
            onClick={() => E.resetHeads(true)}
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}

/** The tabs of the lanes. */
function Head() {
  return (
    <div class="tabs" role="tablist">
      {E.LANES.map((l) => (
        <button
          type="button"
          role="tab"
          aria-selected={E.lane.value === l.id}
          class={E.lane.value === l.id ? 'on' : ''}
          title={l.title}
          onClick={() => {
            E.lane.value = l.id;
            E.pointSel.value = null;
          }}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** The frame the canvas paints now; reading it subscribes the caller to everything the picture depends on. */
function frameOf(g: E.Geo): Frame {
  const playingNow = playing.value;
  const tick = playTick.value;
  return {
    g,
    view: exprView.value,
    roll: E.roll.value,
    stems: E.stems.value,
    measures: E.measures.value,
    curves: E.curves.value,
    lane: E.lane.value,
    scale: E.laneScale(),
    selected: E.selected.value,
    hover: E.hover.value,
    pointSel: E.pointSel.value,
    marquee: E.marquee.value,
    playTick: playingNow || tick > 0 ? tick : null,
  };
}

/** The Expression pane. */
export function Expression() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const inside = useRef(false);
  const g = useMemo(() => E.geo(size.w, size.h), [size.w, size.h]);

  // The canvas follows the size of its box.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    setSize({ w: el.clientWidth, h: el.clientHeight });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The picture is repainted, one frame at a time, whenever anything it shows changes.
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!(cv && ctx && size.w)) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    let colors = readColors();
    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    let raf = 0;
    const draw = () => {
      cancelAnimationFrame(raf);
      const f = frameOf(g);
      raf = requestAnimationFrame(() => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paint(ctx, f, colors, E.LANES.find((l) => l.id === f.lane)?.label ?? '');
      });
    };
    const recolor = () => {
      colors = readColors();
      draw();
    };
    theme.addEventListener('change', recolor);
    const stop = effect(draw);
    return () => {
      stop();
      theme.removeEventListener('change', recolor);
      cancelAnimationFrame(raf);
    };
  }, [g, size.w, size.h]);

  // The view follows the playhead and a selection made in the score.
  useEffect(
    () =>
      effect(() => {
        const tick = playTick.value;
        if (playing.peek()) E.reveal(tick, size.w);
      }),
    [size.w],
  );
  useEffect(
    () =>
      effect(() => {
        void selection.value;
        const spot = E.selectionSpot();
        if (!spot) return;
        // A selection made here centers the score on the notes, one made in the score centers this view on them; both at once, without easing.
        if (inside.current) reveal(spot.ref, true);
        else E.centerOn(g, spot);
      }),
    [g],
  );

  // The roll is first scrolled to the middle of the music's pitches.
  useEffect(
    () =>
      effect(() => {
        void E.roll.value;
        E.placeView(g);
      }),
    [g],
  );

  /** The pointer's place in the canvas. */
  const at = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = canvas.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const tip = E.tip.value;
  return (
    <section class="expression" aria-label="Expression">
      <Head />
      <LaneBar />
      <div class="xcanvas" ref={wrap}>
        <canvas
          ref={canvas}
          tabIndex={0}
          style={{ width: `${size.w}px`, height: `${size.h}px`, cursor: E.cursor.value }}
          aria-label="Expression lanes"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            canvas.current?.focus({ preventScroll: true });
            const { x, y } = at(e);
            inside.current = true;
            if (E.onDown(g, x, y, e.button, e.shiftKey || e.ctrlKey || e.metaKey, e.altKey)) {
              canvas.current?.setPointerCapture(e.pointerId);
              e.preventDefault();
            }
          }}
          onPointerMove={(e) => {
            const { x, y } = at(e);
            E.onMove(g, x, y, e.buttons, e.altKey, e.altKey);
          }}
          onPointerUp={(e) => {
            const { x, y } = at(e);
            E.onUp(g, x, y);
            inside.current = false;
          }}
          onPointerCancel={() => {
            E.cancel();
            inside.current = false;
          }}
          onPointerLeave={E.onLeave}
          onWheel={(e) => {
            e.preventDefault();
            const { x } = at(e);
            if (e.ctrlKey || e.metaKey) E.zoomAt(Math.exp(-e.deltaY * 0.0015), x);
            else if (e.altKey) E.scrollBy(g, e.deltaY || e.deltaX);
            else E.panBy(e.deltaX || e.deltaY);
          }}
          onKeyDown={(e) => {
            if (E.onKey(e)) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        />
        {tip && (
          <div
            class="xtip"
            style={
              tip.x > size.w / 2
                ? { right: `${size.w - tip.x + E.SP2}px`, top: `${tip.y + E.SP2}px` }
                : { left: `${tip.x + E.SP2}px`, top: `${tip.y + E.SP2}px` }
            }
          >
            {tip.text}
          </div>
        )}
      </div>
    </section>
  );
}
