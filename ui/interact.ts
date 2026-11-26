// Pointer interaction on the score: selection, placing the note input caret, dragging, and the tools that create
// spanners and marks.
//
// A small state machine: `pointerdown` decides from the active tool and what is under the pointer
// (via the hit index) which `Drag` begins; `pointermove` updates it and the ghost overlay; `pointerup`
// turns it into a command from src/editor/commands.ts, committed as one undo step. Positions are
// converted from client pixels to page staff spaces by `locate`.

import { signal } from '@preact/signals';
import type { EvAddr, Ref } from '../src/editor/addr.ts';
import { eventOf, markOf, refKey, voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { pitchAtPos } from '../src/editor/context.ts';
import type { Box, HitIndex, Target } from '../src/editor/hit.ts';
import { eventAtX, hitTest, marquee, measureAt, measureAtStaff, posAtY, snapTick } from '../src/editor/hit.ts';
import type { OrnamentKind } from '../src/editor/similar.ts';
import { similarTo } from '../src/editor/similar.ts';
import type { MeasureGeom } from '../src/engrave/system.ts';
import type { Event, MarkBody, NoteEvent, Pitch, Score } from '../src/model.ts';
import { baseTicks, flattenVoice, lengthOf, marksOf, PPQ, STEPS } from '../src/model.ts';
import { must } from '../src/util.ts';
import { placeCaret } from './caret.ts';
import { hoverFinding } from './layers.ts';
import { measureTick, seek } from './player.ts';
import { showHelp } from './Shortcuts.tsx';

import {
  acc,
  clefArg,
  commit,
  dots,
  dur,
  dynText,
  engraved,
  exprView,
  fit,
  hit,
  realRef,
  run,
  say,
  score,
  selection,
  setTool,
  showExpression,
  tempoArg,
  textArg,
  tool,
  tupletArg,
  voice,
  zoom,
} from './state.ts';

// The overlay: ghost notes, marquee boxes and other temporary drawings that the pointer handling
// below shows on top of the engraved pages. They are not part of the score.

export type Ghost =
  | { kind: 'bar'; page: number; x: number; top: number }
  | {
      kind: 'span';
      from: { page: number; x: number; y: number };
      to: { page: number; x: number; y: number };
      bad?: boolean;
    }
  | { kind: 'rect'; page: number; box: Box }
  | { kind: 'head'; page: number; x: number; y: number; pos: number; top: number; w: number; label: string };

export const ghost = signal<Ghost | null>(null);

/** The element the pointer is over (select tool), shown in light blue as the next thing a click selects. */
export const hover = signal<Target | null>(null);

// Page geometry: zoom, scrolling and the conversion between screen pixels and page coordinates
// (staff spaces), for which the page elements of the score pane are registered here.

export const pageEls: (HTMLElement | null)[] = [];

/** Zoom by a factor. Leaving "fit" starts from the zoom the pages are shown at, not from 100%. */
export function zoomBy(f: number, at?: { x: number; y: number }): void {
  const res = engraved.peek();
  const el = pageEls[0];
  if (fit.peek() && res && el) zoom.value = el.clientWidth / (res.pages[0].width * res.staffSpace * (96 / 25.4));
  const z0 = zoom.peek();
  fit.value = false;
  zoom.value = Math.max(0.2, Math.min(4, z0 * f));
  // The pane keeps the point under the cursor in place once it has re-rendered at the new size:
  // `zoomAnchor` carries the cursor position and the zoom ratio to the pane (see `takeZoomAnchor`).
  zoomAnchor = at && zoom.peek() !== z0 ? { ...at, r: zoom.peek() / z0 } : null;
}

/** Set by `zoomBy`, consumed by the score pane after its next render. */
let zoomAnchor: { x: number; y: number; r: number } | null = null;

/** Returns the pending zoom anchor and clears it. */
export const takeZoomAnchor = () => {
  const a = zoomAnchor;
  zoomAnchor = null;
  return a;
};

export interface Where {
  page: number;
  x: number;
  y: number;
}

/** Client coordinates -> page and staff-space coordinates (the nearest page when outside all). */
export function locate(cx: number, cy: number): Where | undefined {
  const res = engraved.peek();
  if (!res) return undefined;
  let best = -1;
  let bd = Number.POSITIVE_INFINITY;
  pageEls.forEach((el, i) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  if (best < 0) return undefined;
  const r = must(pageEls[best]).getBoundingClientRect();
  const p = res.pages[best];
  return { page: best, x: ((cx - r.left) / r.width) * p.width, y: ((cy - r.top) / r.height) * p.height };
}

/** Where the object `ref` is drawn in the score pane's scroll box: the box, and the top and bottom of the object relative to the box's top. Undefined when it is not drawn. */
function placeInView(ref: Ref): { box: Element; y0: number; y1: number } | undefined {
  const key = refKey(ref);
  const res = engraved.peek();
  const t = hit.peek()?.targets.find((x) => refKey(x.ref) === key);
  const pg = t && pageEls[t.page];
  const box = pg?.closest('.scroll');
  if (!(t && res && pg && box)) return undefined;
  const k = pg.clientWidth / res.pages[t.page].width;
  const top = pg.getBoundingClientRect().top - box.getBoundingClientRect().top;
  return { box, y0: top + t.bbox.y0 * k, y1: top + t.bbox.y1 * k };
}

/** Scrolls the score pane at once so that the object `ref` is a third of the way down, or in the middle (`center`); nothing happens when it is not drawn. */
export function reveal(ref: Ref, center = false): void {
  const at = placeInView(ref);
  if (!at) return;
  const middle = center ? (at.y0 + at.y1) / 2 : at.y0;
  at.box.scrollTo({
    top: Math.max(0, at.box.scrollTop + middle - at.box.clientHeight / (center ? 2 : 3)),
    behavior: 'instant',
  });
}

/** Scrolls the score pane so that measure `mi` is in view (its system a third of the way down), at once. */
export function revealMeasure(mi: number): void {
  const res = engraved.peek();
  const g = res?.layout.measures.find((m) => m.mi === mi && m.staff === 0);
  const sys = g && res?.layout.systems.find((s) => s.sys === g.sys);
  const pg = g && pageEls[g.page];
  const box = pg?.closest('.scroll');
  if (!(res && g && sys && pg && box)) return;
  const k = pg.clientWidth / res.pages[g.page].width;
  const y = pg.getBoundingClientRect().top - box.getBoundingClientRect().top + sys.staffY[0] * k;
  box.scrollTo({ top: Math.max(0, box.scrollTop + y - box.clientHeight / 3), behavior: 'instant' });
  if (showExpression.peek()) exprView.value = { ...exprView.peek(), left: measureTick(mi) - PPQ };
}

// Small helpers shared by the pointer handling and the commands: staff ids, the
// duration currently chosen in the palette and the selection.

/** The id of the staff at index `idx`. */
const staffId = (sc: Score, idx: number) => sc.staves[idx].id;

/** The length in ticks of the duration chosen in the palette. */
const durTicks = () => baseTicks({ base: dur.value, dots: dots.value });

/** The selected grace notes. */
export const graceRefs = (): Extract<Ref, { t: 'grace' }>[] =>
  selection.value.filter((r): r is Extract<Ref, { t: 'grace' }> => r.t === 'grace');

/** The selected events. */
export const evRefs = (): Extract<Ref, { t: 'ev' }>[] =>
  selection.value.filter((r): r is Extract<Ref, { t: 'ev' }> => r.t === 'ev');

/** Selects `refs`. With `additive` each one is toggled in the current selection instead. */
export function select(refs: Ref[], additive = false): void {
  if (!additive) {
    selection.value = refs;
    return;
  }
  const m = new Map(selection.value.map((r) => [refKey(r), r]));
  for (const r of refs) {
    const k = refKey(r);
    if (m.has(k)) m.delete(k);
    else m.set(k, r);
  }
  selection.value = [...m.values()];
}

/** Index of the event that starts at `tick` in the voice, after an edit. */
export function selectEventAt(loc: { mi: number; staff: string; voice: number }, tick: number): void {
  const v = voiceOf(score.peek(), loc);
  const te = v && flattenVoice(v).find((t) => t.start === tick);
  if (te) selection.value = [{ t: 'ev', ...loc, idx: te.index }];
}

/** The preview for note input at the pointer: the bar where a click puts the caret. */
function ghostFor(w: Where): Ghost | null {
  const h = hit.peek();
  if (!h) return null;
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return null;
  const sn = snapTick(g, lengthOf(score.peek(), g.mi), w.x, durTicks());
  return { kind: 'bar', page: g.page, x: sn.x, top: g.y };
}

// The pointer state machine: press, move and release are interpreted according to the current tool
// and what is under the pointer (a drag of a head, a marquee, note input, a span being drawn, ...).
// `Drag` is the state held between the events.

type Drag =
  | { k: 'none' }
  | {
      k: 'head';
      ref: Extract<Ref, { t: 'ev' }>;
      start: Where;
      cx: number;
      cy: number;
      moved: boolean;
      target: Target;
      startTick: number;
      /** Set when a grace note of the event is dragged (`ref` is its note). */
      grace?: number;
    }
  | { k: 'marquee'; start: Where; additive: boolean; moved: boolean; base: Ref[]; click?: { mi: number; e: Modifiers } }
  | {
      k: 'span';
      tool: 'slur' | 'line' | 'cresc' | 'dim' | 'pedal' | 'trill' | '8va' | '8vb';
      start: Where;
      cx: number;
      cy: number;
      from: Extract<Ref, { t: 'ev' }>;
    }
  | { k: 'mark'; ref: Extract<Ref, { t: 'mark' }>; start: Where; cx: number; cy: number; moved: boolean };

let drag: Drag = { k: 'none' };

const MARK_TOOLS = new Set<string>(['dynamic', 'text', 'tempo', 'clef']);
type SpanTool = Extract<Drag, { k: 'span' }>['tool'];
const SPAN_TOOLS = new Set<string>(['slur', 'line', 'cresc', 'dim', 'pedal', 'trill', '8va', '8vb']);

/** Do both events lie in one system? A line between notes is drawn only then. */
export function sameSystem(h: HitIndex, a: EvAddr, b: EvAddr): boolean {
  const sys = (mi: number) => h.layout.systems.find((s) => mi >= s.a && mi <= s.b);
  const s = sys(a.mi);
  return !!s && s === sys(b.mi);
}

/** Starts dragging a span (slur, hairpin, pedal, octave shift) from the note under the pointer. */
function startSpan(e: PointerEvent, w: Where, tool: SpanTool, target: Target | undefined): void {
  if (target?.ref.t !== 'ev') {
    say(
      tool === 'slur'
        ? 'Start the slur on a note'
        : tool === 'line'
          ? 'Start the line on a note'
          : 'Start the span on a note or rest',
      true,
    );
    return;
  }
  drag = {
    k: 'span',
    tool,
    start: w,
    cx: e.clientX,
    cy: e.clientY,
    // A line may be attached to one head of a chord; the other spans always take the whole event.
    from: (tool === 'line' ? target.ref : { ...target.ref, pi: undefined }) as never,
  };
  select([target.ref]);
}

/** Turns the hit note or rest into a tuplet with the ratio chosen in the palette. */
function makeTupletAt(target: Target | undefined): void {
  if (target?.ref.t !== 'ev') {
    say('Click a note or rest to make it a tuplet', true);
    return;
  }
  const r = target.ref;
  run((s) => C.makeTuplet(s, r, tupletArg.value[0], tupletArg.value[1]));
}

/** Is the clicked ref already part of the selection (a whole-note ref counts for its chord-tone refs)? */
function isSelected(r: Ref): boolean {
  return selection.value.some(
    (s) =>
      refKey(s) === refKey(r) ||
      (s.t === 'ev' &&
        r.t === 'ev' &&
        refKey({ ...s, pi: undefined } as Ref) === refKey({ ...r, pi: undefined } as Ref) &&
        s.pi === undefined),
  );
}

/** The measure a Shift-click range grows from: the last measure clicked without Shift. */
let measureAnchor: number | undefined;

/** The measures selected, in order. */
export const measureRefs = (): number[] =>
  selection.value
    .filter((r): r is Extract<Ref, { t: 'measure' }> => r.t === 'measure')
    .map((r) => r.mi)
    .sort((a, b) => a - b);

/** Selects the measures `a` to `b` (either order) as the selection. */
function selectMeasureRange(a: number, b: number): void {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  select(Array.from({ length: hi - lo + 1 }, (_, k) => ({ t: 'measure' as const, mi: lo + k })));
}

/** The modifier keys of a pointer event. */
type Modifiers = Pick<PointerEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>;

/** A click on a measure: it becomes the selection; Shift extends from the anchor to it, Ctrl or Cmd adds or removes it. */
function selectMeasure(mi: number, e: Modifiers): void {
  if (e.shiftKey) {
    selectMeasureRange(measureAnchor ?? measureRefs()[0] ?? mi, mi);
    return;
  }
  measureAnchor = mi;
  if (e.ctrlKey || e.metaKey) select([{ t: 'measure', mi }], true);
  else select([{ t: 'measure', mi }]);
}

/**
 * Select tool. Clicking a target selects it (shift/ctrl adds); pressing on a head or mark also
 * starts a drag. Clicking empty space starts a marquee. A click on something that is already
 * part of a multi-selection keeps that selection.
 */
function pressWithSelectTool(e: PointerEvent, w: Where, h: HitIndex, target: Target | undefined): void {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (!target) {
    const g = measureAt(h.layout, w.page, w.x, w.y);
    // Extending a selection that holds anything but measures must not turn into a measure selection.
    const extendsOthers = additive && selection.value.some((r) => r.t !== 'measure');
    // The measure is selected when the press turns out to be a click, not when a marquee drag starts.
    const click =
      g && !extendsOthers
        ? { mi: g.mi, e: { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey } }
        : undefined;
    drag = { k: 'marquee', start: w, additive, moved: false, base: additive ? selection.value : [], click };
    if (!(click || additive)) select([]);
    return;
  }
  const r = target.ref;
  const already = isSelected(r);
  const onlyOther = selection.value.length === 1 && refKey(selection.value[0]) !== refKey(r);
  if (additive) select([r], true);
  else if (!already || onlyOther) select([r]);
  if (r.t === 'ev' && target.k === 'head') {
    const v = voiceOf(score.peek(), r);
    const te = v && flattenVoice(v)[r.idx];
    if (te && te.ev.kind === 'note')
      drag = { k: 'head', ref: r, start: w, cx: e.clientX, cy: e.clientY, moved: false, target, startTick: te.start };
  } else if (r.t === 'grace') {
    const ev: Extract<Ref, { t: 'ev' }> = { t: 'ev', mi: r.mi, staff: r.staff, voice: r.voice, idx: r.idx };
    const v = voiceOf(score.peek(), r);
    const te = v && flattenVoice(v)[r.idx];
    if (te)
      drag = {
        k: 'head',
        ref: ev,
        start: w,
        cx: e.clientX,
        cy: e.clientY,
        moved: false,
        target,
        startTick: te.start,
        grace: r.gi,
      };
  } else if (r.t === 'mark') drag = { k: 'mark', ref: r, start: w, cx: e.clientX, cy: e.clientY, moved: false };
}

/**
 * Pointer-down handler of the score: starts note input, a span, a mark or a tuplet, or the select tool's click,
 * drag or marquee.
 */
export function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  if (!(w && h)) return;
  const t = tool.value;
  const target = asSelected(hitTest(h, w.page, w.x, w.y));
  // In note input the hit index is the would-be score's, so a clicked note is turned back into a ref of the score.
  const real = t === 'note' && target ? realRef(target.ref) : undefined;
  if (t === 'note' && real?.t === 'ev' && eventOf(score.peek(), real)?.kind === 'note') {
    // A click on an existing note leaves input and selects it; anywhere else (also on the note about to be entered)
    // it puts the caret there.
    setTool('select');
    selection.value = [real];
  } else if (t === 'note') placeCaretAt(w);
  else if (SPAN_TOOLS.has(t)) startSpan(e, w, t as SpanTool, target);
  else if (MARK_TOOLS.has(t)) addMarkAt(w);
  else if (t === 'tuplet') makeTupletAt(target);
  else if (t === 'grace') addGraceAt(w);
  else if (e.altKey && t === 'select') {
    // Alt+click: put the playhead here.
    const g = measureAt(h.layout, w.page, w.x, w.y);
    if (g) seek(measureTick(g.mi) + snapTick(g, lengthOf(score.peek(), g.mi), w.x, PPQ / 4).tick);
  } else pressWithSelectTool(e, w, h, target);
}

/** What a click on the target selects: a single note as a whole (stem and all), a chord tone on its own. Hover shows the same. */
const ZERO: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Hover on the event a mark would hang on at the pointer (on `staff` only when given, else on the staff under it). */
function eventHover(w: Where, staff?: string, prefer = voice.value): Target | null {
  const h = hit.peek();
  if (!h) return null;
  const sc = score.peek();
  const g =
    staff === undefined
      ? measureAt(h.layout, w.page, w.x, w.y)
      : measureAtStaff(
          h.layout,
          w.page,
          w.x,
          w.y,
          sc.staves.findIndex((s) => s.id === staff),
        );
  if (!g) return null;
  const at = eventAtX(sc, g, staffId(sc, g.staff), lengthOf(sc, g.mi), w.x, prefer);
  return at ? { page: g.page, ref: { t: 'ev', ...at }, k: 'head', boxes: [], bbox: ZERO, prio: 0 } : null;
}

/** Sets the hovered target, only when it really differs from the current one. */
function setHover(t: Target | null): void {
  const cur = hover.peek();
  if (t === cur || (t && cur && t.page === cur.page && t.k === cur.k && refKey(t.ref) === refKey(cur.ref))) return;
  hover.value = t;
}

/** A line attaches to noteheads only: other parts of a note (stem, flag) are not hovered for it. */
function lineHeadOnly(t: string, tg: Target | undefined): Target | undefined {
  return t === 'line' && tg && tg.k !== 'head' ? undefined : tg;
}

/** Treats a head of a single-note event as the event itself, so that clicking it selects the event. */
function asSelected(t: Target | undefined): Target | undefined {
  if (
    t &&
    t.ref.t === 'ev' &&
    t.ref.pi !== undefined &&
    (eventOf(score.peek(), t.ref) as { pitches?: unknown[] } | undefined)?.pitches?.length === 1
  ) {
    return { ...t, ref: { ...t.ref, pi: undefined } };
  }
  return t;
}

/** Pointer-move handler of the score: moves the ghost and the hover target, and continues a drag. */
export function onPointerMove(e: PointerEvent): void {
  if (showHelp.peek()) {
    if (drag.k === 'none') {
      ghost.value = null;
      hover.value = null;
    }
    return;
  } // The shortcuts dialog covers the score.
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  hoverFinding(drag.k === 'none' ? w : undefined);
  if (!(w && h)) {
    if (drag.k === 'none') {
      ghost.value = null;
      hover.value = null;
    }
    return;
  }
  const t = tool.value;
  const ht =
    drag.k !== 'none'
      ? undefined
      : t === 'select'
        ? asSelected(hitTest(h, w.page, w.x, w.y))
        : MARK_TOOLS.has(t)
          ? (eventHover(w) ?? undefined)
          : SPAN_TOOLS.has(t)
            ? lineHeadOnly(t, asSelected(hitTest(h, w.page, w.x, w.y)))
            : undefined;
  if (drag.k !== 'mark') setHover(ht ?? null);
  if (drag.k === 'none') {
    if (t === 'note') ghost.value = ghostFor(w);
    else ghost.value = null;
    return;
  }
  continueDrag(drag, e, w, h);
}

const DRAG_THRESHOLD_PX = 4;
const MARQUEE_THRESHOLD = 0.4;

/** Whether the pointer has moved far enough from the press point for a drag to begin. */
const pastThreshold = (d: { cx: number; cy: number }, e: PointerEvent) =>
  Math.hypot(e.clientX - d.cx, e.clientY - d.cy) >= DRAG_THRESHOLD_PX;

/** The rectangle spanned by two points. */
function rectBetween(a: Where, b: Where): Box {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** The staff-measure a dragged head belongs to: the one under the pointer if in the head's measure, else the staff the head is drawn on. */
function measureForHeadDrag(
  h: HitIndex,
  w: Where,
  ref: Extract<Ref, { t: 'ev' }>,
  staff: string,
): MeasureGeom | undefined {
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (g && g.mi === ref.mi) return g;
  const idx = score.peek().staves.findIndex((s) => s.id === staff);
  return h.layout.measures.find((m) => m.mi === ref.mi && m.staff === idx);
}

/** Limits a staff position to the range that note input can reach. */
const clampPos = (pos: number) => Math.max(-9, Math.min(17, pos));

/** Shows where a dragged head would land: its staff position and the pitch name. */
function dragHeadGhost(d: Extract<Drag, { k: 'head' }>, e: PointerEvent, w: Where, h: HitIndex): void {
  if (!(d.moved || pastThreshold(d, e))) return;
  d.moved = true;
  const sc = score.peek();
  const g = measureForHeadDrag(h, w, d.ref, d.ref.staff);
  if (!g) return;
  const pos = clampPos(posAtY(g.y, w.y));
  const p = pitchAtPos(sc, staffId(sc, g.staff), d.ref.mi, d.startTick, pos, acc.value);
  ghost.value = {
    kind: 'head',
    page: g.page,
    x: d.target.bbox.x0,
    y: g.y + 4 - pos / 2,
    pos,
    top: g.y,
    w: d.target.bbox.x1 - d.target.bbox.x0,
    label: `${p.step.toUpperCase()}${'#'.repeat(Math.max(0, p.alter))}${'b'.repeat(Math.max(0, -p.alter))}${p.octave}`,
  };
}

/** Updates the ghost of the running drag. */
function continueDrag(d: Drag, e: PointerEvent, w: Where, h: HitIndex): void {
  if (d.k === 'head') dragHeadGhost(d, e, w, h);
  else if (d.k === 'marquee') {
    if (!d.moved && Math.hypot(w.x - d.start.x, w.y - d.start.y) < MARQUEE_THRESHOLD) return;
    if (!(d.moved || d.additive)) select([]);
    d.moved = true;
    if (w.page === d.start.page) ghost.value = { kind: 'rect', page: w.page, box: rectBetween(w, d.start) };
  } else if (d.k === 'span') {
    const tg = hitTest(h, w.page, w.x, w.y);
    const ok =
      tg?.ref.t === 'ev' &&
      (d.tool === 'line'
        ? tg.k === 'head' && sameSystem(h, d.from, tg.ref) && eventOf(score.peek(), tg.ref)?.kind === 'note'
        : tg.ref.staff === d.from.staff);
    ghost.value = { kind: 'span', from: d.start, to: w, bad: !ok };
    setHover((ok && tg ? asSelected(tg) : undefined) ?? null);
  } else if (d.k === 'mark') {
    if (!(d.moved || pastThreshold(d, e))) return;
    d.moved = true;
    setHover(eventHover(w, d.ref.staff, d.ref.voice));
  }
}

/** Selects what the marquee encloses, adding to the earlier selection if the drag was additive. */
function finishMarquee(d: Extract<Drag, { k: 'marquee' }>, w: Where, h: HitIndex): void {
  if (!d.moved && d.click) selectMeasure(d.click.mi, d.click.e);
  if (!d.moved || w.page !== d.start.page) return;
  const refs = marquee(h, w.page, rectBetween(w, d.start));
  selection.value = d.additive ? [...new Map([...d.base, ...refs].map((r) => [refKey(r), r])).values()] : refs;
}

/** Drops a dragged grace note on the pitch of the position: a single pitch takes it, a chord moves as a whole by the same steps. */
function finishGraceDrag(d: Extract<Drag, { k: 'head' }>, gi: number, ev: NoteEvent, w: Where, h: HitIndex): void {
  const g = measureForHeadDrag(h, w, d.ref, d.ref.staff);
  const grace = ev.graces?.[gi];
  if (!(g && grace)) return;
  const pitch = pitchAtPos(score.peek(), d.ref.staff, d.ref.mi, d.startTick, clampPos(posAtY(g.y, w.y)), acc.value);
  const stepNo = (p: Pitch) => p.octave * 7 + STEPS.indexOf(p.step);
  const ref = d.ref;
  if (grace.pitches.length === 1) run((s) => C.updateGrace(s, ref, gi, { pitches: [{ pitch }] }));
  else {
    const steps = stepNo(pitch) - stepNo(grace.pitches[0].pitch);
    if (steps) run((s) => C.transposeGrace(s, ref, gi, steps));
  }
  selection.value = [{ t: 'grace', mi: ref.mi, staff: ref.staff, voice: ref.voice, idx: ref.idx, gi }];
}

/** Drops a dragged head: onto the other staff it becomes a cross-staff note (pitch kept), else it takes the pitch of the position. */
function finishHeadDrag(d: Extract<Drag, { k: 'head' }>, w: Where, h: HitIndex): void {
  if (!d.moved) return;
  const sc = score.peek();
  const ev = eventOf(sc, d.ref);
  if (ev?.kind !== 'note') return;
  if (d.grace !== undefined) {
    finishGraceDrag(d, d.grace, ev, w, h);
    return;
  }
  const currentStaff = ev.staff ?? d.ref.staff;
  const g = measureForHeadDrag(h, w, d.ref, currentStaff);
  if (!g) return;
  const targetStaff = staffId(sc, g.staff);
  if (targetStaff !== currentStaff) {
    run((s) => C.setStaffOf(s, [d.ref], targetStaff === d.ref.staff ? undefined : targetStaff));
    return;
  }
  const pitch = pitchAtPos(sc, targetStaff, d.ref.mi, d.startTick, clampPos(posAtY(g.y, w.y)), acc.value);
  const pi = d.ref.pi ?? 0;
  run((s) => C.setPitch(s, d.ref, pi, pitch));
}

/**
 * Creates the span of the active tool (slur, line, or a span such as a hairpin) from the pressed note to the note
 * under the pointer.
 */
function finishSpan(d: Extract<Drag, { k: 'span' }>, w: Where, h: HitIndex): void {
  const tg = hitTest(h, w.page, w.x, w.y);
  if (tg?.ref.t !== 'ev') return;
  if (d.tool === 'line' && tg.k !== 'head') return;
  const to = tg.ref;
  const from = d.from;
  const kind = d.tool;
  if (kind === 'slur') run((s) => C.addSlur(s, from, to));
  else if (kind === 'line') {
    if (sameSystem(h, from, to)) run((s) => C.addLine(s, from, to));
    else say('A line joins notes of one system', true);
  } else run((s) => C.addSpanOver(s, kind, from, to));
}

/** Moves a dragged mark to the event under the pointer. */
function finishMarkMove(d: Extract<Drag, { k: 'mark' }>, w: Where, h: HitIndex): void {
  if (!d.moved) return;
  const sc = score.peek();
  const g = measureAtStaff(
    h.layout,
    w.page,
    w.x,
    w.y,
    sc.staves.findIndex((s) => s.id === d.ref.staff),
  );
  if (!g) return;
  const at = eventAtX(sc, g, d.ref.staff, lengthOf(sc, g.mi), w.x, d.ref.voice);
  if (!at || (at.mi === d.ref.mi && at.voice === d.ref.voice && at.idx === d.ref.idx)) return;
  const ref = d.ref;
  run((s) => C.moveMark(s, ref, at));
  selection.value = [];
}

/** Pointer-up handler of the score: ends the running drag. */
export function onPointerUp(e: PointerEvent): void {
  const d = drag;
  drag = { k: 'none' };
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  if (d.k === 'none' || !w || !h) return;
  ghost.value = null;
  if (d.k === 'mark') hover.value = null;
  if (d.k === 'marquee') finishMarquee(d, w, h);
  else if (d.k === 'head') finishHeadDrag(d, w, h);
  else if (d.k === 'span') finishSpan(d, w, h);
  else finishMarkMove(d, w, h);
}

/** Puts the input caret at the pointer: the staff and measure under it, the nearest column or grid position. */
function placeCaretAt(w: Where): void {
  const h = hit.peek();
  if (!h) return;
  const sc = score.peek();
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return;
  placeCaret({ mi: g.mi, staff: staffId(sc, g.staff), tick: snapTick(g, lengthOf(sc, g.mi), w.x, durTicks()).tick });
}

/** Puts a grace note in front of the note at the pointer, on the pitch of the clicked position, and selects it. */
function addGraceAt(w: Where): void {
  const h = hit.peek();
  if (!h) return;
  const sc = score.peek();
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return;
  const id = staffId(sc, g.staff);
  const at = eventAtX(sc, g, id, lengthOf(sc, g.mi), w.x, voice.value);
  if (!at) return;
  const te = flattenVoice(must(voiceOf(sc, at)))[at.idx];
  const pos = clampPos(posAtY(g.y, w.y));
  const pitch = pitchAtPos(sc, id, g.mi, te.start, pos, acc.value);
  const base = dur.value >= 8 && dur.value <= 32 ? (dur.value as 8 | 16 | 32) : 8;
  const gi = (te.ev.kind === 'note' && te.ev.graces?.length) || 0;
  if (run((s) => C.addGrace(s, at, { pitches: [{ pitch }], base, slash: true }))) {
    selection.value = [{ t: 'grace', ...at, gi }];
    acc.value = undefined;
  }
}

/**
 * Adds the dynamic, text, tempo or clef mark of the active tool to the event at the pointer, above the staff if
 * the click was in its upper half. The new mark is selected.
 */
function addMarkAt(w: Where): void {
  const h = hit.peek();
  if (!h) return;
  const sc = score.peek();
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return;
  const id = staffId(sc, g.staff);
  const at = eventAtX(sc, g, id, lengthOf(sc, g.mi), w.x, voice.value);
  if (!at) return;
  const above = w.y < g.y + 2;
  const placement = above ? { placement: 'above' as const } : {};
  const t = tool.value;
  let ok = false;
  if (t === 'dynamic') ok = run((s) => C.addMark(s, at, { type: 'dynamic', text: dynText.value, ...placement }));
  else if (t === 'text') ok = run((s) => C.addMark(s, at, { type: 'text', text: textArg.value, ...placement }));
  else if (t === 'tempo')
    ok = run((s) =>
      C.addMark(s, at, {
        type: 'tempo',
        unit: tempoArg.value.unit,
        dots: tempoArg.value.dots,
        bpm: tempoArg.value.bpm,
      }),
    );
  else if (t === 'clef') ok = run((s) => C.addMark(s, at, { type: 'clef', clef: { ...clefArg.value } }));
  if (ok) {
    const m = marksOf(score.peek().measures[g.mi].staves[id]).findLast(
      (x) => x.voice === at.voice && x.idx === at.idx && x.type === t,
    );
    if (m) selection.value = [{ t: 'mark', mi: g.mi, staff: id, voice: m.voice, idx: m.idx, k: m.k }];
  }
}

/** Double-click handler of the score: asks for new text of a text mark or new tempo of a tempo mark. */
export function onDoubleClick(e: MouseEvent): void {
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  if (!(w && h) || tool.value !== 'select') return;
  const tg = hitTest(h, w.page, w.x, w.y);
  if (tg?.ref.t !== 'mark') return;
  const ref = tg.ref;
  const m = markOf(score.peek(), ref);
  if (m?.type === 'text') {
    const v = prompt('Text', m.text);
    if (v) run((s) => C.updateMark(s, ref, { text: v } as Partial<MarkBody>));
  } else if (m?.type === 'tempo') {
    const v = Number(prompt('Beats per minute', String(m.bpm)));
    if (v > 0) run((s) => C.updateMark(s, ref, { bpm: v } as Partial<MarkBody>));
  }
}

/** The tuplets around the first selected note, innermost first, as selectable refs (a tuplet is addressed by its first event). */
export function tupletsAround(): { label: string; ref: Ref }[] {
  const r = evRefs()[0];
  const v = r && voiceOf(score.peek(), r);
  if (!v) return [];
  const flat = flattenVoice(v);
  const nest = flat[r.idx]?.tuplets.length ?? 0;
  const out: { label: string; ref: Ref }[] = [];
  for (let depth = nest - 1; depth >= 0; depth--) {
    const grp = flat[r.idx].tuplets[depth];
    const idx = flat.findIndex((te) => te.tuplets[depth] === grp);
    out.push({
      label: nest > 1 ? `Sel. tuplet ${depth + 1}` : 'Sel. tuplet',
      ref: { t: 'tuplet', mi: r.mi, staff: r.staff, voice: r.voice, idx, depth },
    });
  }
  return out;
}

// Commands that are not tied to the pointer: the keyboard shortcuts and the Properties panel call
// these too, so that every action has one implementation.

/** Select everything in the score that is like the (first) selected element: any dynamic, same hairpin kind, same duration ... */
export function selectSimilar(by?: OrnamentKind): void {
  const first = selection.peek()[0];
  if (!first) return;
  const all = similarTo(score.peek(), first, by);
  if (!all.length) {
    say('Nothing similar to select', true);
    return;
  }
  selection.value = all;
  say(`Selected ${all.length} similar`);
}

/**
 * Deletes the selection as one undoable step: events (to rests), marks, slurs, lines, tuplets, ties, or whole
 * measures when only measures are selected.
 */
export function deleteSelection(): void {
  const sel = selection.value;
  if (!sel.length) return;
  const sc = score.peek();
  let s = sc;
  try {
    const evs = sel.filter((r) => r.t === 'ev') as Extract<Ref, { t: 'ev' }>[];
    const graces = sel
      .filter((x): x is Extract<Ref, { t: 'grace' }> => x.t === 'grace')
      .sort((a, b) => a.mi - b.mi || a.idx - b.idx || b.gi - a.gi);
    for (const r of graces) s = C.removeGrace(s, r, r.gi);
    const marks = sel.filter((x): x is Extract<Ref, { t: 'mark' }> => x.t === 'mark');
    if (marks.length) s = C.removeMarks(s, marks);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'slur' }> => x.t === 'slur')) s = C.removeSlur(s, r, r.id);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'line' }> => x.t === 'line')) s = C.removeLine(s, r, r.id);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'tuplet' }> => x.t === 'tuplet')) s = C.removeTuplet(s, r);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'tie' }> => x.t === 'tie'))
      s = C.toggleTie(s, [{ ...r, pi: r.pi }]);
    // Events go after the rest, since deleting a whole voice removes it and the other refs could point into it.
    if (evs.length) s = C.deleteEvents(s, evs);
    const ms = sel
      .filter((x): x is Extract<Ref, { t: 'measure' }> => x.t === 'measure')
      .map((m) => m.mi)
      .sort((a, b) => a - b);
    if (ms.length && !evs.length && sel.length === ms.length) s = C.deleteMeasures(s, ms[0], ms[ms.length - 1]);
    commit(s);
    if (sel.every((r) => r.t !== 'ev' && r.t !== 'tuplet')) selection.value = [];
    else selection.value = sel.filter((r) => !('voice' in r) || voiceOf(s, r));
  } catch (e) {
    if (e instanceof C.EditError) say(e.message, true);
    else throw e;
  }
}

/** Abandons the running drag and its ghost. */
export const cancelDrag = (): void => {
  drag = { k: 'none' };
  ghost.value = null;
};

export type { Event };
