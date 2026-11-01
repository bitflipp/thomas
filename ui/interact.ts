// Pointer interaction on the score: selection, note input, dragging, and the tools that create spanners and marks.
import { signal } from '@preact/signals';
import { PPQ, baseTicks, flattenVoice, measureTicks, timeAt, type Event, type Mark, type Score } from '../src/model.ts';
import { eventAtTick } from '../src/editor/voice.ts';
import { pitchAtPos } from '../src/editor/context.ts';
import * as C from '../src/editor/commands.ts';
import { eventOf, markOf, refKey, voiceOf, type EvAddr, type Ref } from '../src/editor/addr.ts';
import { hitTest, marquee, measureAt, measureAtStaff, posAtY, snapTick, type Box, type Target } from '../src/editor/hit.ts';
import type { MeasureGeom } from '../src/engrave/system.ts';
import {
  score, hit, engraved, selection, tool, dur, dots, acc, voice, dynText, clefArg, tupletArg, tempoArg, textArg, run, say, commit,
} from './state.ts';

// ---------------------------------------------------------------- what is drawn on top of the pages

export type Ghost =
  | { kind: 'note'; page: number; x: number; y: number; pos: number; top: number; bad: boolean; label: string; base: number; acc?: number; rest?: boolean }
  | { kind: 'bar'; page: number; x: number; top: number; bad: boolean; label?: string }
  | { kind: 'span'; from: { page: number; x: number; y: number }; to: { page: number; x: number; y: number }; bad?: boolean }
  | { kind: 'rect'; page: number; box: Box }
  | { kind: 'head'; page: number; x: number; y: number; pos: number; top: number; w: number; label: string };
export const ghost = signal<Ghost | null>(null);

export interface Menu { x: number; y: number; items: { label: string; run: () => void; danger?: boolean; sep?: boolean }[] }
export const menu = signal<Menu | null>(null);

// ---------------------------------------------------------------- page geometry

export const pageEls: (HTMLElement | null)[] = [];

export interface Where { page: number; x: number; y: number }
/** Client coordinates -> page and staff-space coordinates (the nearest page when outside all). */
export function locate(cx: number, cy: number): Where | undefined {
  const res = engraved.peek();
  if (!res) return undefined;
  let best = -1, bd = Infinity;
  pageEls.forEach((el, i) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
    if (d < bd) { bd = d; best = i; }
  });
  if (best < 0) return undefined;
  const r = pageEls[best]!.getBoundingClientRect(), p = res.pages[best];
  return { page: best, x: ((cx - r.left) / r.width) * p.width, y: ((cy - r.top) / r.height) * p.height };
}

// ---------------------------------------------------------------- helpers

const staffId = (sc: Score, idx: number) => sc.staves[idx].id;
const lenOf = (sc: Score, mi: number) => measureTicks(timeAt(sc, mi));
const durTicks = () => baseTicks({ base: dur.value, dots: dots.value });
export const evRefs = (): (EvAddr & { pi?: number })[] => selection.value.filter((r): r is Extract<Ref, { t: 'ev' }> => r.t === 'ev');

export function select(refs: Ref[], additive = false): void {
  if (!additive) { selection.value = refs; return; }
  const m = new Map(selection.value.map((r) => [refKey(r), r]));
  for (const r of refs) { const k = refKey(r); if (m.has(k)) m.delete(k); else m.set(k, r); }
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
  return { kind: 'note', page: g.page, x: sn.x, y: g.y + 4 - pos / 2, pos, top: g.y, bad, label, base: dur.value, acc: p.alter !== 0 || acc.value !== undefined ? p.alter : undefined };
}

// ---------------------------------------------------------------- pointer state machine

type Drag =
  | { k: 'none' }
  | { k: 'head'; ref: Extract<Ref, { t: 'ev' }>; start: Where; cx: number; cy: number; moved: boolean; target: Target; startTick: number }
  | { k: 'marquee'; start: Where; additive: boolean; moved: boolean; base: Ref[] }
  | { k: 'span'; tool: 'slur' | 'cresc' | 'dim' | 'pedal' | '8va' | '8vb'; start: Where; cx: number; cy: number; from?: Extract<Ref, { t: 'ev' }>; geom?: MeasureGeom; tick?: number }
  | { k: 'mark'; ref: Extract<Ref, { t: 'mark' }>; start: Where; cx: number; cy: number; moved: boolean };
let drag: Drag = { k: 'none' };

export function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  menu.value = null;
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  if (!w || !h) return;
  const t = tool.value;
  const alt = e.altKey;
  const target = hitTest(h, w.page, w.x, w.y);
  if (target && target.ref.t === 'ev' && target.ref.pi !== undefined && (eventOf(score.peek(), target.ref) as { pitches?: unknown[] } | undefined)?.pitches?.length === 1) {
    target.ref = { ...target.ref, pi: undefined }; // a single note is selected as a whole, a chord tone on its own
  }
  if (t === 'note' || t === 'rest') { enter(w, alt); return; }
  if (t === 'slur') {
    if (target?.ref.t === 'ev') { drag = { k: 'span', tool: 'slur', start: w, cx: e.clientX, cy: e.clientY, from: { ...target.ref, pi: undefined } as never }; select([target.ref]); }
    else say('Start the slur on a note', true);
    return;
  }
  if (t === 'cresc' || t === 'dim' || t === 'pedal' || t === '8va' || t === '8vb') {
    const g = measureAt(h.layout, w.page, w.x, w.y);
    if (!g) return;
    const sn = snapTick(g, lenOf(score.peek(), g.mi), w.x, PPQ / 2);
    drag = { k: 'span', tool: t, start: w, cx: e.clientX, cy: e.clientY, geom: g, tick: sn.tick };
    ghost.value = { kind: 'span', from: { page: g.page, x: sn.x, y: g.y + 2 }, to: { page: g.page, x: sn.x, y: g.y + 2 } };
    return;
  }
  if (t === 'dynamic' || t === 'text' || t === 'tempo' || t === 'clef') { addMarkAt(w); return; }
  if (t === 'tuplet') {
    if (target?.ref.t === 'ev') { const r = target.ref; run((s) => C.makeTuplet(s, r, tupletArg.value[0], tupletArg.value[1])); }
    else say('Click a note or rest to make it a tuplet', true);
    return;
  }
  // select tool
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (target) {
    const r = target.ref;
    const already = selection.value.some((s) => refKey(s) === refKey(r) || (s.t === 'ev' && r.t === 'ev' && refKey({ ...s, pi: undefined } as Ref) === refKey({ ...r, pi: undefined } as Ref) && s.pi === undefined));
    if (additive) select([r], true);
    else if (!already || selection.value.length > 1 && !already) select([r]);
    else if (selection.value.length === 1 && refKey(selection.value[0]) !== refKey(r)) select([r]);
    if (r.t === 'ev' && target.k === 'head') {
      const v = voiceOf(score.peek(), r), te = v && flattenVoice(v)[r.idx];
      if (te && te.ev.kind === 'note') drag = { k: 'head', ref: r, start: w, cx: e.clientX, cy: e.clientY, moved: false, target, startTick: te.start };
    } else if (r.t === 'mark') drag = { k: 'mark', ref: r, start: w, cx: e.clientX, cy: e.clientY, moved: false };
    return;
  }
  const g = measureAt(h.layout, w.page, w.x, w.y);
  drag = { k: 'marquee', start: w, additive, moved: false, base: additive ? selection.value : [] };
  if (g) select([{ t: 'measure', mi: g.mi }], false); else if (!additive) select([]);
}

export function onPointerMove(e: PointerEvent): void {
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  if (!w || !h) { if (drag.k === 'none') ghost.value = null; return; }
  const t = tool.value;
  if (drag.k === 'none') {
    if (t === 'note' || t === 'rest') ghost.value = ghostFor(w, e.altKey);
    else if (t === 'dynamic' || t === 'text' || t === 'tempo' || t === 'clef') {
      const g = measureAt(h.layout, w.page, w.x, w.y);
      ghost.value = g ? { kind: 'bar', page: g.page, x: snapTick(g, lenOf(score.peek(), g.mi), w.x, PPQ / 4).x, top: g.y, bad: false } : null;
    } else ghost.value = null;
    return;
  }
  const d = drag;
  if (d.k === 'head') {
    if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 4) return;
    d.moved = true;
    const sc = score.peek();
    const g = measureAt(h.layout, w.page, w.x, w.y);
    const home = h.layout.measures.find((m) => m.mi === d.ref.mi && m.staff === sc.staves.findIndex((s) => s.id === d.ref.staff));
    const useG = g && g.mi === d.ref.mi ? g : home;
    if (!useG) return;
    const pos = Math.max(-9, Math.min(17, posAtY(useG.y, w.y)));
    const p = pitchAtPos(sc, staffId(sc, useG.staff), d.ref.mi, d.startTick, pos, acc.value);
    ghost.value = { kind: 'head', page: useG.page, x: d.target.bbox.x0, y: useG.y + 4 - pos / 2, pos, top: useG.y, w: d.target.bbox.x1 - d.target.bbox.x0, label: `${p.step.toUpperCase()}${'#'.repeat(Math.max(0, p.alter))}${'b'.repeat(Math.max(0, -p.alter))}${p.octave}` };
  } else if (d.k === 'marquee') {
    if (!d.moved && Math.hypot(w.x - d.start.x, w.y - d.start.y) < 0.4) return;
    d.moved = true;
    if (w.page === d.start.page) ghost.value = { kind: 'rect', page: w.page, box: { x0: Math.min(w.x, d.start.x), y0: Math.min(w.y, d.start.y), x1: Math.max(w.x, d.start.x), y1: Math.max(w.y, d.start.y) } };
  } else if (d.k === 'span') {
    if (d.tool === 'slur') {
      const tg = hitTest(h, w.page, w.x, w.y);
      ghost.value = { kind: 'span', from: d.start, to: w, bad: !(tg?.ref.t === 'ev') };
    } else if (d.geom) {
      const sc = score.peek();
      const g = measureAtStaff(h.layout, w.page, w.x, w.y, d.geom.staff);
      if (!g) return;
      const sn = snapTick(g, lenOf(sc, g.mi), w.x, PPQ / 2);
      const s0 = snapTick(d.geom, lenOf(sc, d.geom.mi), d.start.x, PPQ / 2);
      const after = g.mi > d.geom.mi || (g.mi === d.geom.mi && sn.tick > (d.tick ?? 0));
      ghost.value = { kind: 'span', from: { page: d.geom.page, x: s0.x, y: d.geom.y + 2 }, to: { page: g.page, x: sn.x, y: g.y + 2 }, bad: !after };
    }
  } else if (d.k === 'mark') {
    if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 4) return;
    d.moved = true;
    const g = measureAtStaff(h.layout, w.page, w.x, w.y, score.peek().staves.findIndex((s) => s.id === d.ref.staff));
    if (g) ghost.value = { kind: 'bar', page: g.page, x: snapTick(g, lenOf(score.peek(), g.mi), w.x, PPQ / 4).x, top: g.y, bad: false };
  }
}

export function onPointerUp(e: PointerEvent): void {
  const d = drag;
  drag = { k: 'none' };
  const w = locate(e.clientX, e.clientY);
  const h = hit.peek();
  if (d.k === 'none' || !w || !h) return;
  ghost.value = null;
  const sc = score.peek();
  if (d.k === 'marquee') {
    if (!d.moved || w.page !== d.start.page) return;
    const box = { x0: Math.min(w.x, d.start.x), y0: Math.min(w.y, d.start.y), x1: Math.max(w.x, d.start.x), y1: Math.max(w.y, d.start.y) };
    const refs = marquee(h, w.page, box);
    selection.value = d.additive ? [...new Map([...d.base, ...refs].map((r) => [refKey(r), r])).values()] : refs;
  } else if (d.k === 'head') {
    if (!d.moved) { return; }
    const g = measureAt(h.layout, w.page, w.x, w.y);
    const homeIdx = sc.staves.findIndex((s) => s.id === d.ref.staff);
    const ev = eventOf(sc, d.ref);
    if (!ev || ev.kind !== 'note') return;
    const curStaffId = ev.staff ?? d.ref.staff;
    const targetG = g && g.mi === d.ref.mi ? g : h.layout.measures.find((m) => m.mi === d.ref.mi && m.staff === sc.staves.findIndex((s) => s.id === curStaffId));
    if (!targetG) return;
    const tid = staffId(sc, targetG.staff);
    const pos = Math.max(-9, Math.min(17, posAtY(targetG.y, w.y)));
    if (tid !== curStaffId) { // moved to the other staff: cross-staff, pitch kept
      run((s) => C.setStaffOf(s, [d.ref], tid === d.ref.staff ? undefined : tid));
      return;
    }
    void homeIdx;
    const p = pitchAtPos(sc, tid, d.ref.mi, d.startTick, pos, acc.value);
    const pi = d.ref.pi ?? 0;
    run((s) => C.setPitch(s, d.ref, pi, p));
  } else if (d.k === 'span') {
    if (d.tool === 'slur') {
      const tg = hitTest(h, w.page, w.x, w.y);
      if (tg?.ref.t === 'ev' && d.from) { const to = tg.ref, from = d.from; run((s) => C.addSlur(s, from, to)); }
      return;
    }
    if (!d.geom) return;
    const g = measureAtStaff(h.layout, w.page, w.x, w.y, d.geom.staff);
    if (!g) return;
    const a = { mi: d.geom.mi, tick: d.tick ?? 0 }, sn = snapTick(g, lenOf(sc, g.mi), w.x, PPQ / 2);
    const b = { mi: g.mi, tick: sn.tick };
    const id = staffId(sc, d.geom.staff);
    const kind = d.tool;
    run((s) => C.addSpan(s, id, kind, a, b));
  } else if (d.k === 'mark') {
    if (!d.moved) return;
    const g = measureAtStaff(h.layout, w.page, w.x, w.y, sc.staves.findIndex((s) => s.id === d.ref.staff));
    if (!g) return;
    const sn = snapTick(g, lenOf(sc, g.mi), w.x, PPQ / 4);
    if (g.mi === d.ref.mi && sn.tick === markOf(sc, d.ref)?.tick) return;
    const ref = d.ref;
    run((s) => C.moveMark(s, ref, g.mi, sn.tick));
    selection.value = [];
  }
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
  if (tool.value === 'rest') { if (run((s) => C.enterRest(s, loc, sn.tick, d, !alt))) selectEventAt(loc, sn.tick); return; }
  const pos = Math.max(-9, Math.min(17, posAtY(g.y, w.y)));
  const pitch = pitchAtPos(sc, id, g.mi, sn.tick, pos, acc.value);
  const v = voiceOf(sc, loc);
  const at = v ? eventAtTick(v.items, sn.tick) : undefined;
  const chord = !!(at && at.start === sn.tick && at.ev.kind === 'note' && at.ev.dur.base === d.base && at.ev.dur.dots === d.dots);
  if (run((s) => C.enterNote(s, loc, sn.tick, d, pitch, { chord, descend: !alt }))) { selectEventAt(loc, sn.tick); acc.value = undefined; } // an accidental applies to one note
}

function addMarkAt(w: Where): void {
  const h = hit.peek();
  if (!h) return;
  const sc = score.peek();
  const g = measureAt(h.layout, w.page, w.x, w.y);
  if (!g) return;
  const id = staffId(sc, g.staff);
  const sn = snapTick(g, lenOf(sc, g.mi), w.x, PPQ / 4);
  const above = w.y < g.y + 2;
  const placement = above ? ({ placement: 'above' as const }) : {};
  const t = tool.value;
  let ok = false;
  if (t === 'dynamic') ok = run((s) => C.addMark(s, id, g.mi, sn.tick, { type: 'dynamic', text: dynText.value, ...placement }));
  else if (t === 'text') ok = run((s) => C.addMark(s, id, g.mi, sn.tick, { type: 'text', text: textArg.value, ...placement }));
  else if (t === 'tempo') ok = run((s) => C.addMark(s, id, g.mi, sn.tick, { type: 'tempo', unit: tempoArg.value.unit, dots: tempoArg.value.dots, bpm: tempoArg.value.bpm }));
  else if (t === 'clef') ok = run((s) => C.addMark(s, id, g.mi, sn.tick, { type: 'clef', clef: { ...clefArg.value } }));
  if (ok) {
    const m = score.peek().measures[g.mi].staves[id].marks.findIndex((x: Mark) => x.tick === sn.tick && x.type === t);
    if (m >= 0) selection.value = [{ t: 'mark', mi: g.mi, staff: id, i: m }];
  }
}

export function onDoubleClick(e: MouseEvent): void {
  const w = locate(e.clientX, e.clientY), h = hit.peek();
  if (!w || !h || tool.value !== 'select') return;
  const tg = hitTest(h, w.page, w.x, w.y);
  if (tg?.ref.t !== 'mark') return;
  const ref = tg.ref, m = markOf(score.peek(), ref);
  if (m?.type === 'text') { const v = prompt('Text', m.text); if (v) run((s) => C.updateMark(s, ref, { text: v } as Partial<Mark>)); }
  else if (m?.type === 'tempo') { const v = Number(prompt('Beats per minute', String(m.bpm))); if (v > 0) run((s) => C.updateMark(s, ref, { bpm: v } as Partial<Mark>)); }
}

export function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  const w = locate(e.clientX, e.clientY), h = hit.peek();
  if (!w || !h) return;
  const sc = score.peek();
  const tg = hitTest(h, w.page, w.x, w.y);
  const g = measureAt(h.layout, w.page, w.x, w.y);
  const items: Menu['items'] = [];
  if (tg) {
    if (!selection.value.some((s) => refKey(s) === refKey(tg.ref))) select([tg.ref]);
    const r = tg.ref;
    if (r.t === 'ev') {
      items.push({ label: 'Delete', run: () => deleteSelection(), danger: true });
      items.push({ label: 'Tie', run: () => run((s) => C.toggleTie(s, evRefs())) });
      items.push({ label: 'Stem up', run: () => run((s) => C.updateEvents(s, evRefs(), (x) => { x.stem = 'up'; })) });
      items.push({ label: 'Stem down', run: () => run((s) => C.updateEvents(s, evRefs(), (x) => { x.stem = 'down'; })) });
      items.push({ label: 'Stem automatic', run: () => run((s) => C.updateEvents(s, evRefs(), (x) => { delete x.stem; })) });
    } else if (r.t === 'mark') items.push({ label: 'Delete', run: () => deleteSelection(), danger: true });
    else if (r.t === 'slur') items.push({ label: 'Delete slur', run: () => deleteSelection(), danger: true });
    else if (r.t === 'tuplet') { items.push({ label: 'Remove tuplet', run: () => deleteSelection(), danger: true }); }
  }
  if (g) {
    const mi = g.mi, m = sc.measures[mi];
    if (items.length) items.push({ label: '', run: () => {}, sep: true });
    items.push({ label: `Insert measure before ${mi + 1}`, run: () => run((s) => C.insertMeasures(s, mi)) });
    items.push({ label: `Insert measure after ${mi + 1}`, run: () => run((s) => C.insertMeasures(s, mi + 1)) });
    items.push({ label: `Delete measure ${mi + 1}`, run: () => run((s) => C.deleteMeasures(s, mi, mi)), danger: true });
    items.push({ label: m.breakBefore === 'system' ? 'Remove system break' : 'System break before', run: () => run((s) => C.setBreak(s, mi, m.breakBefore === 'system' ? undefined : 'system')) });
    items.push({ label: m.breakBefore === 'page' ? 'Remove page break' : 'Page break before', run: () => run((s) => C.setBreak(s, mi, m.breakBefore === 'page' ? undefined : 'page')) });
  }
  if (items.length) menu.value = { x: e.clientX, y: e.clientY, items };
}

// ---------------------------------------------------------------- commands shared with the keyboard and inspector

export function deleteSelection(): void {
  const sel = selection.value;
  if (!sel.length) return;
  const sc = score.peek();
  let s = sc;
  try {
    const evs = sel.filter((r) => r.t === 'ev') as Extract<Ref, { t: 'ev' }>[];
    if (evs.length) s = C.deleteEvents(s, evs);
    // marks: highest index first so indices stay valid
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'mark' }> => x.t === 'mark').sort((a, b) => b.mi - a.mi || b.i - a.i)) s = C.removeMark(s, r);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'slur' }> => x.t === 'slur')) s = C.removeSlur(s, r, r.id);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'tuplet' }> => x.t === 'tuplet')) s = C.removeTuplet(s, r);
    for (const r of sel.filter((x): x is Extract<Ref, { t: 'tie' }> => x.t === 'tie')) s = C.toggleTie(s, [{ ...r, pi: r.pi }]);
    const ms = sel.filter((x): x is Extract<Ref, { t: 'measure' }> => x.t === 'measure').map((m) => m.mi).sort((a, b) => a - b);
    if (ms.length && !evs.length && sel.length === ms.length) s = C.deleteMeasures(s, ms[0], ms[ms.length - 1]);
    commit(s);
    if (sel.every((r) => r.t !== 'ev' && r.t !== 'tuplet')) selection.value = [];
  } catch (e) { if (e instanceof C.EditError) say(e.message, true); else throw e; }
}

export const cancelDrag = (): void => { drag = { k: 'none' }; ghost.value = null; };
void eventOf; void clefArg;
export type { Event };
