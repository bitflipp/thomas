// Pointer interaction on the score: selection, note input, dragging, and the tools that create spanners and marks.
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
import { similarTo } from '../src/editor/similar.ts';
import { eventAtTick } from '../src/editor/voice.ts';
import type { MeasureGeom } from '../src/engrave/system.ts';
import type { Event, MarkBody, Score } from '../src/model.ts';
import { baseTicks, flattenVoice, marksOf, measureTicks, PPQ, timeAt } from '../src/model.ts';
import { must } from '../src/util.ts';
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
  fit,
  hit,
  run,
  say,
  score,
  selection,
  tempoArg,
  textArg,
  tool,
  tupletArg,
  voice,
  zoom,
} from './state.ts';

// ---------------------------------------------------------------- what is drawn on top of the pages

export type Ghost =
  | {
      kind: 'note';
      page: number;
      x: number;
      y: number;
      pos: number;
      top: number;
      bad: boolean;
      label: string;
      base: number;
      acc?: number;
      rest?: boolean;
    }
  | { kind: 'bar'; page: number; x: number; top: number; bad: boolean; label?: string }
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

// ---------------------------------------------------------------- page geometry

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
export let zoomAnchor: { x: number; y: number; r: number } | null = null;
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

// ---------------------------------------------------------------- helpers

const staffId = (sc: Score, idx: number) => sc.staves[idx].id;
const lenOf = (sc: Score, mi: number) => measureTicks(timeAt(sc, mi));
const durTicks = () => baseTicks({ base: dur.value, dots: dots.value });
export const evRefs = (): (EvAddr & { pi?: number })[] =>
  selection.value.filter((r): r is Extract<Ref, { t: 'ev' }> => r.t === 'ev');

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
function selectEventAt(loc: { mi: number; staff: string; voice: number }, tick: number): void {
  const v = voiceOf(score.peek(), loc);
  const te = v && flattenVoice(v).find((t) => t.start === tick);
  if (te) selection.value = [{ t: 'ev', ...loc, idx: te.index }];
}

function ghostFor(w: Where, alt: boolean): Ghost | null {
  const h = hit.peek();
  if (!h) return null;
  const sc = score.peek();
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return null;
  const len = lenOf(sc, g.mi);
  const dT = durTicks();
  const sn = snapTick(g, len, w.x, dT);
  const id = staffId(sc, g.staff);
  const v = sc.measures[g.mi].staves[id]?.voices.find((x) => x.id === voice.value);
  const at = v ? eventAtTick(v.items, sn.tick) : undefined;
  const bad = sn.tick + dT > len && !at?.inTuplet;
  void alt;
  if (tool.value === 'rest') return { kind: 'bar', page: g.page, x: sn.x, top: g.y, bad, label: 'rest' };
  const pos = Math.max(-9, Math.min(17, posAtY(g.y, w.y)));
  const p = pitchAtPos(sc, id, g.mi, sn.tick, pos, acc.value);
  const label = `${p.step.toUpperCase()}${p.alter > 0 ? '#'.repeat(p.alter) : p.alter < 0 ? 'b'.repeat(-p.alter) : ''}${p.octave}`;
  return {
    kind: 'note',
    page: g.page,
    x: sn.x,
    y: g.y + 4 - pos / 2,
    pos,
    top: g.y,
    bad,
    label,
    base: dur.value,
    acc: p.alter !== 0 || acc.value !== undefined ? p.alter : undefined,
  };
}

// ---------------------------------------------------------------- pointer state machine

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
    }
  | { k: 'marquee'; start: Where; additive: boolean; moved: boolean; base: Ref[] }
  | {
      k: 'span';
      tool: 'slur' | 'cresc' | 'dim' | 'pedal' | '8va' | '8vb';
      start: Where;
      cx: number;
      cy: number;
      from: Extract<Ref, { t: 'ev' }>;
    }
  | { k: 'mark'; ref: Extract<Ref, { t: 'mark' }>; start: Where; cx: number; cy: number; moved: boolean };
let drag: Drag = { k: 'none' };

const MARK_TOOLS = new Set<string>(['dynamic', 'text', 'tempo', 'clef']);
type SpanTool = Extract<Drag, { k: 'span' }>['tool'];
const SPAN_TOOLS = new Set<string>(['slur', 'cresc', 'dim', 'pedal', '8va', '8vb']);

/** Starts dragging a span (slur, hairpin, pedal, octave shift) from the note under the pointer. */
function startSpan(e: PointerEvent, w: Where, tool: SpanTool, target: Target | undefined): void {
  if (target?.ref.t !== 'ev') {
    say(tool === 'slur' ? 'Start the slur on a note' : 'Start the line on a note or rest', true);
    return;
  }
  drag = {
    k: 'span',
    tool,
    start: w,
    cx: e.clientX,
    cy: e.clientY,
    from: { ...target.ref, pi: undefined } as never,
  };
  select([target.ref]);
}

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

/**
 * Select tool. Clicking a target selects it (shift/ctrl adds); pressing on a head or mark also
 * starts a drag. Clicking empty space starts a marquee. A click on something that is already
 * part of a multi-selection keeps that selection.
 */
function pressWithSelectTool(e: PointerEvent, w: Where, h: HitIndex, target: Target | undefined): void {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (!target) {
    const g = measureAt(h.layout, w.page, w.x, w.y);
    drag = { k: 'marquee', start: w, additive, moved: false, base: additive ? selection.value : [] };
    if (g) select([{ t: 'measure', mi: g.mi }], false);
    else if (!additive) select([]);
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
  } else if (r.t === 'mark') drag = { k: 'mark', ref: r, start: w, cx: e.clientX, cy: e.clientY, moved: false };
}

export function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  if (!(w && h)) return;
  const t = tool.value;
  const target = asSelected(hitTest(h, w.page, w.x, w.y));
  if (t === 'note' || t === 'rest') enter(w, e.altKey);
  else if (SPAN_TOOLS.has(t)) startSpan(e, w, t as SpanTool, target);
  else if (MARK_TOOLS.has(t)) addMarkAt(w);
  else if (t === 'tuplet') makeTupletAt(target);
  else if (e.altKey && t === 'select') {
    // Alt+click: put the playhead here
    const g = measureAt(h.layout, w.page, w.x, w.y);
    if (g) seek(measureTick(g.mi) + snapTick(g, lenOf(score.peek(), g.mi), w.x, PPQ / 4).tick);
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
  const at = eventAtX(sc, g, staffId(sc, g.staff), lenOf(sc, g.mi), w.x, prefer);
  return at ? { page: g.page, ref: { t: 'ev', ...at }, k: 'head', boxes: [], bbox: ZERO, prio: 0 } : null;
}
function setHover(t: Target | null): void {
  const cur = hover.peek();
  if (t === cur || (t && cur && t.page === cur.page && t.k === cur.k && refKey(t.ref) === refKey(cur.ref))) return;
  hover.value = t;
}

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

export function onPointerMove(e: PointerEvent): void {
  if (showHelp.peek()) {
    if (drag.k === 'none') {
      ghost.value = null;
      hover.value = null;
    }
    return;
  } // the shortcuts dialog covers the score
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
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
          : undefined;
  if (drag.k !== 'mark') setHover(ht ?? null);
  if (drag.k === 'none') {
    if (t === 'note' || t === 'rest') ghost.value = ghostFor(w, e.altKey);
    else ghost.value = null;
    return;
  }
  continueDrag(drag, e, w, h);
}

const DRAG_THRESHOLD_PX = 4;
const MARQUEE_THRESHOLD = 0.4;
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

function continueDrag(d: Drag, e: PointerEvent, w: Where, h: HitIndex): void {
  if (d.k === 'head') dragHeadGhost(d, e, w, h);
  else if (d.k === 'marquee') {
    if (!d.moved && Math.hypot(w.x - d.start.x, w.y - d.start.y) < MARQUEE_THRESHOLD) return;
    d.moved = true;
    if (w.page === d.start.page) ghost.value = { kind: 'rect', page: w.page, box: rectBetween(w, d.start) };
  } else if (d.k === 'span') {
    const tg = hitTest(h, w.page, w.x, w.y);
    ghost.value = { kind: 'span', from: d.start, to: w, bad: !(tg?.ref.t === 'ev' && tg.ref.staff === d.from.staff) };
  } else if (d.k === 'mark') {
    if (!(d.moved || pastThreshold(d, e))) return;
    d.moved = true;
    setHover(eventHover(w, d.ref.staff, d.ref.voice));
  }
}

function finishMarquee(d: Extract<Drag, { k: 'marquee' }>, w: Where, h: HitIndex): void {
  if (!d.moved || w.page !== d.start.page) return;
  const refs = marquee(h, w.page, rectBetween(w, d.start));
  selection.value = d.additive ? [...new Map([...d.base, ...refs].map((r) => [refKey(r), r])).values()] : refs;
}

/** Drops a dragged head: onto the other staff it becomes a cross-staff note (pitch kept), else it takes the pitch of the position. */
function finishHeadDrag(d: Extract<Drag, { k: 'head' }>, w: Where, h: HitIndex): void {
  if (!d.moved) return;
  const sc = score.peek();
  const ev = eventOf(sc, d.ref);
  if (ev?.kind !== 'note') return;
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

function finishSpan(d: Extract<Drag, { k: 'span' }>, w: Where, h: HitIndex): void {
  const tg = hitTest(h, w.page, w.x, w.y);
  if (tg?.ref.t !== 'ev') return;
  const to = tg.ref;
  const from = d.from;
  const kind = d.tool;
  if (kind === 'slur') run((s) => C.addSlur(s, from, to));
  else run((s) => C.addSpanOver(s, kind, from, to));
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
  const at = eventAtX(sc, g, d.ref.staff, lenOf(sc, g.mi), w.x, d.ref.voice);
  if (!at || (at.mi === d.ref.mi && at.voice === d.ref.voice && at.idx === d.ref.idx)) return;
  const ref = d.ref;
  run((s) => C.moveMark(s, ref, at));
  selection.value = [];
}

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

function enter(w: Where, alt: boolean): void {
  const h = hit.peek();
  if (!h) return;
  const sc = score.peek();
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return;
  const id = staffId(sc, g.staff);
  const loc = { mi: g.mi, staff: id, voice: voice.value };
  const d = { base: dur.value, dots: dots.value };
  const sn = snapTick(g, lenOf(sc, g.mi), w.x, durTicks());
  if (tool.value === 'rest') {
    if (run((s) => C.enterRest(s, loc, sn.tick, d, !alt))) selectEventAt(loc, sn.tick);
    return;
  }
  const pos = Math.max(-9, Math.min(17, posAtY(g.y, w.y)));
  const pitch = pitchAtPos(sc, id, g.mi, sn.tick, pos, acc.value);
  const v = voiceOf(sc, loc);
  const at = v ? eventAtTick(v.items, sn.tick) : undefined;
  const chord = !!(
    at &&
    at.start === sn.tick &&
    at.ev.kind === 'note' &&
    at.ev.dur.base === d.base &&
    at.ev.dur.dots === d.dots
  );
  if (run((s) => C.enterNote(s, loc, sn.tick, d, pitch, { chord, descend: !alt }))) {
    selectEventAt(loc, sn.tick);
    acc.value = undefined;
  } // an accidental applies to one note
}

function addMarkAt(w: Where): void {
  const h = hit.peek();
  if (!h) return;
  const sc = score.peek();
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return;
  const id = staffId(sc, g.staff);
  const at = eventAtX(sc, g, id, lenOf(sc, g.mi), w.x, voice.value);
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
      label: nest > 1 ? `Select tuplet (level ${depth + 1})` : 'Select tuplet',
      ref: { t: 'tuplet', mi: r.mi, staff: r.staff, voice: r.voice, idx, depth },
    });
  }
  return out;
}

// ---------------------------------------------------------------- commands shared with the keyboard and inspector

/** Select everything in the score that is like the (first) selected element: any dynamic, same hairpin kind, same duration ... */
export function selectSimilar(): void {
  const first = selection.peek()[0];
  if (!first) return;
  const all = similarTo(score.peek(), first);
  if (!all.length) {
    say('Nothing similar to select', true);
    return;
  }
  selection.value = all;
  say(`Selected ${all.length} similar`);
}

export function deleteSelection(): void {
  const sel = selection.value;
  if (!sel.length) return;
  const sc = score.peek();
  let s = sc;
  try {
    const evs = sel.filter((r) => r.t === 'ev') as Extract<Ref, { t: 'ev' }>[];
    if (evs.length) s = C.deleteEvents(s, evs);
    const marks = sel.filter((x): x is Extract<Ref, { t: 'mark' }> => x.t === 'mark');
    if (marks.length) s = C.removeMarks(s, marks);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'slur' }> => x.t === 'slur')) s = C.removeSlur(s, r, r.id);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'tuplet' }> => x.t === 'tuplet')) s = C.removeTuplet(s, r);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'tie' }> => x.t === 'tie'))
      s = C.toggleTie(s, [{ ...r, pi: r.pi }]);
    const ms = sel
      .filter((x): x is Extract<Ref, { t: 'measure' }> => x.t === 'measure')
      .map((m) => m.mi)
      .sort((a, b) => a - b);
    if (ms.length && !evs.length && sel.length === ms.length) s = C.deleteMeasures(s, ms[0], ms[ms.length - 1]);
    commit(s);
    if (sel.every((r) => r.t !== 'ev' && r.t !== 'tuplet')) selection.value = [];
  } catch (e) {
    if (e instanceof C.EditError) say(e.message, true);
    else throw e;
  }
}

export const cancelDrag = (): void => {
  drag = { k: 'none' };
  ghost.value = null;
};
void eventOf;
void clefArg;

export type { Event };
