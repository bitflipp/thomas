// The Expression pane under the score: how the piece is played, as opposed to how it is written. A roll shows every sounding
// note where it is heard (shifted attacks included) with its velocity as brightness; below it one lane at a time holds the
// velocity, shift or gate of each note (a stem to drag) or one of the performance curves (tempo, sustain, una corda: points
// and regions to draw). The notes are selected here and in the score alike, and the toolbar acts on that selection. All
// expression editing is done here; the state, the pointer handling and the actions are in expression.ts, the drawing of the
// canvas in exprDraw.ts.

import { effect } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RampShape } from '../src/editor/expression.ts';
import type { DropdownOpt } from './Dropdown.tsx';
import { Dropdown } from './Dropdown.tsx';
import type { Frame } from './exprDraw.ts';
import { paint, readColors } from './exprDraw.ts';
import * as E from './expression.ts';
import { Ui } from './icons.tsx';
import { playing, playTick } from './player.ts';
import { exprView, selection } from './state.ts';

/** The zoom the view starts at, to show the zoom as a percentage of it. */
const BASE_PPQ = 56;

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

/** The controls of the velocity lane: set, nudge, ramp, reset. */
function VelocityBar({ none }: { none: boolean }) {
  return (
    <>
      <Field
        label="Velocity"
        title="The velocity of the selected notes (1–127). Notes without one follow the dynamics."
        value={E.sharedValue('vel')}
        min={1}
        max={127}
        disabled={none}
        onChange={E.setVelocity}
      />
      <Steps steps={[-10, -1, 1, 10]} label="Velocity" disabled={none} onStep={E.nudgeVelocity} />
      <span class="sep" />
      <span class="lbl">Ramp</span>
      <Field
        label="from"
        title="Velocity at the first attack of the selection"
        value={E.rampFrom.value}
        min={1}
        max={127}
        onChange={(n) => (E.rampFrom.value = n)}
      />
      <Field
        label="to"
        title="Velocity at the last attack of the selection"
        value={E.rampTo.value}
        min={1}
        max={127}
        onChange={(n) => (E.rampTo.value = n)}
      />
      <Dropdown
        title="How the velocity changes along the passage"
        value={E.rampShape.value}
        opts={SHAPES}
        onChange={(v) => (E.rampShape.value = v)}
      />
      <button
        type="button"
        disabled={none}
        title="Give the selected notes velocities along the ramp, by where they start"
        onClick={E.applyRamp}
      >
        Apply
      </button>
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
  tempo: 'Click to add a point, drag to move it (Alt: no snapping), Delete removes it. 100% is the notated tempo.',
  sustain:
    'Click to add a point, drag to move it (Alt: no snapping), Delete removes it. The pedal is up before the first point.',
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
      <span class="hint">{CURVE_HINTS[which]}</span>
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
            title="Take velocity, shift and gate off the selected notes"
            onClick={() => E.resetHeads(true)}
          >
            Reset all
          </button>
        </>
      )}
    </div>
  );
}

/** The tabs of the lanes, the snap grid and the zoom. */
function Head({ width }: { width: number }) {
  const v = exprView.value;
  return (
    <div class="xhead">
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
      <span class="grow" />
      <Dropdown
        title="Snap grid for curve points and regions (Alt while dragging: none)"
        value={E.snap.value}
        opts={E.SNAPS.map((s) => ({ value: s.value, label: `Snap ${s.label}` }))}
        onChange={(n) => (E.snap.value = n)}
      />
      <div class="seg">
        <button type="button" class="icon" title="Zoom out" onClick={() => E.zoomAt(1 / 1.25, width / 2)}>
          <Ui.minus />
        </button>
        <span class="val">{Math.round((v.ppq / BASE_PPQ) * 100)}%</span>
        <button type="button" class="icon" title="Zoom in" onClick={() => E.zoomAt(1.25, width / 2)}>
          <Ui.plus />
        </button>
        <button type="button" title="Show the whole piece" onClick={() => E.fitAll(width)}>
          Fit
        </button>
      </div>
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
        const tick = E.selectionTick();
        if (!inside.current && tick !== undefined) E.reveal(tick, size.w);
      }),
    [size.w],
  );

  /** The pointer's place in the canvas. */
  const at = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = canvas.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const tip = E.tip.value;
  return (
    <section class="expression" aria-label="Expression">
      <Head width={size.w} />
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
                ? { right: `${size.w - tip.x + 12}px`, top: `${tip.y + 14}px` }
                : { left: `${tip.x + 12}px`, top: `${tip.y + 14}px` }
            }
          >
            {tip.text}
          </div>
        )}
      </div>
    </section>
  );
}
