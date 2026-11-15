// The overview strip under the score: the whole piece as one thin bar per measure (width by length, height by
// the number of notes), with the visible part of the score as a frame. A click or drag on it scrolls the score
// there. It marks tempo marks, key and time changes, repeats, parallels, the selection and the playhead, and
// holds the "go to measure" box (Ctrl+G).
//
// Everything is computed from the score and from the engraver's layout (`Layout.systems`), so the strip needs no
// drawing of its own and stays cheap on a long piece. It only scrolls the score pane; it changes nothing else.

import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Engraved } from '../src/engrave/system.ts';
import type { MarkBody, Score } from '../src/model.ts';
import { flattenVoice, marksOf } from '../src/model.ts';
import { measureStarts } from '../src/playback/sequence.ts';
import { pageToSvg } from '../src/render.ts';
import { must } from '../src/util.ts';
import { pageEls, revealMeasure, select } from './interact.ts';
import { playMeasure } from './player.ts';
import { engraved, parallels, score, selection, zoom } from './state.ts';

/** Whether the "go to measure" prompt is open. */
const gotoOpen = signal(false);

/** Opens the "go to measure" prompt (Ctrl+G). */
export function focusGoto(): void {
  gotoOpen.value = true;
}

/** The prompt for a measure number: Enter selects that measure and scrolls to it, Escape or a click outside closes it. */
function GotoPrompt({ count }: { count: number }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const close = () => {
    gotoOpen.value = false;
  };
  const go = () => {
    const n = Number.parseInt(text, 10);
    if (!(n >= 1 && count)) return;
    const mi = Math.min(n, count) - 1;
    select([{ t: 'measure', mi }]);
    revealMeasure(mi);
    close();
  };
  return (
    <div class="modal" onPointerDown={close}>
      <form
        class="card prompt"
        aria-label="Go to measure"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <h3>Go to measure</h3>
        <input
          ref={input}
          type="text"
          inputMode="numeric"
          placeholder={`1–${count}`}
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
        />
        <div class="row">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" disabled={!text}>
            Go
          </button>
        </div>
      </form>
    </div>
  );
}

/** What the strip shows of one measure. */
interface Bar {
  /** Start and length in ticks. */
  start: number;
  len: number;
  /** The number of notes in all voices. */
  notes: number;
}

/** A thing worth finding again, named at a measure: a tempo or text mark, a signature change, a repeat or a volta. */
interface Landmark {
  mi: number;
  kind: 'tempo' | 'sig' | 'repeat' | 'text';
  label: string;
}

/** The bars of the score and its total length in ticks. */
function barsOf(sc: Score): { bars: Bar[]; total: number } {
  const { measureStart, total } = measureStarts(sc);
  const bars = sc.measures.map((m, mi): Bar => {
    let notes = 0;
    for (const sm of Object.values(m.staves))
      for (const v of sm.voices) for (const t of flattenVoice(v)) if (t.ev.kind === 'note') notes++;
    const start = measureStart[mi];
    return { start, len: (measureStart[mi + 1] ?? total) - start, notes };
  });
  return { bars, total };
}

/** The label of a tempo mark: its text, else the beat unit and the speed (such as "♩=96"). */
function tempoLabel(k: Extract<MarkBody, { type: 'tempo' }>): string {
  if (k.text) return k.text;
  const unit = k.unit === 4 ? '♩' : k.unit === 8 ? '♪' : `1/${k.unit}`;
  return `${unit}${'.'.repeat(k.dots)}=${k.bpm}`;
}

/** A key signature as a short text: "C", "2♯", "3♭". */
const keyLabel = (n: number): string => (n > 0 ? `${n}♯` : n < 0 ? `${-n}♭` : 'C');

/** The landmarks of the score in order, each with a short label. */
function landmarksOf(sc: Score): Landmark[] {
  const out: Landmark[] = [];
  sc.measures.forEach((m, mi) => {
    const prev = sc.measures[mi - 1];
    const seen = new Set<string>();
    for (const sm of Object.values(m.staves))
      for (const k of marksOf(sm)) {
        const label = k.type === 'tempo' ? tempoLabel(k) : k.type === 'text' ? k.text : '';
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push({ mi, kind: k.type === 'tempo' ? 'tempo' : 'text', label });
      }
    if (mi > 0 && (m.time || m.key !== undefined)) {
      const parts = [m.time && `${m.time.beats}/${m.time.beatType}`, m.key !== undefined && keyLabel(m.key)];
      out.push({ mi, kind: 'sig', label: parts.filter(Boolean).join(' ') });
    }
    if (m.repeatStart) out.push({ mi, kind: 'repeat', label: '|:' });
    if (m.ending && m.ending.join() !== prev?.ending?.join())
      out.push({ mi, kind: 'repeat', label: `${m.ending.join(',')}.` });
    if (m.barline === 'repeat-end') out.push({ mi, kind: 'repeat', label: ':|' });
  });
  return out;
}

/** The width in pixels that a label takes (there are no font metrics here, so an estimate). */
const labelWidth = (label: string): number => label.length * 6.5 + 10;

/** The measure at fraction `f` (0 to 1) of the piece's length. */
function measureAtFraction(bars: Bar[], total: number, f: number): number {
  const t = Math.min(total - 1, Math.max(0, f * total));
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The first and last measure of the systems that are at least partly visible in the score pane. */
function visibleMeasures(): { a: number; b: number } | null {
  const res = engraved.peek();
  const box = pageEls[0]?.closest('.scroll');
  if (!(res && box)) return null;
  const br = box.getBoundingClientRect();
  let a = Number.POSITIVE_INFINITY;
  let b = -1;
  for (const s of res.layout.systems) {
    const pg = pageEls[s.page];
    if (!pg) continue;
    const k = pg.clientWidth / res.pages[s.page].width;
    const top = pg.getBoundingClientRect().top + (s.staffY[0] - 2) * k;
    const bottom = pg.getBoundingClientRect().top + (s.staffY[s.staffY.length - 1] + 6) * k;
    if (bottom > br.top && top < br.bottom) {
      a = Math.min(a, s.a);
      b = Math.max(b, s.b);
    }
  }
  return b < 0 ? null : { a, b };
}

/** The SVG of each system's primitives as last drawn, by the primitives' array: an unchanged system keeps its array across edits (see `Engraved.placed`), so its picture is kept too. */
const previewCache = new WeakMap<object, { crop: Crop; svg: string }>();

/** The region of a page (staff spaces) that a preview shows. */
type Crop = { x: number; y: number; w: number; h: number };

/** The picture of system `i` of `res`, cropped to the system with some room for the marks above and below, and the region it shows. */
function systemPreview(res: Engraved, i: number): { crop: Crop; svg: string } {
  const prims = res.placed[i].prims;
  const hit = previewCache.get(prims);
  if (hit) return hit;
  const g = res.layout.systems[i];
  const page = res.pages[g.page];
  const crop = {
    x: Math.max(0, g.x0 - 3),
    y: Math.max(0, g.staffY[0] - 9),
    w: Math.min(page.width, g.x1 + 1) - Math.max(0, g.x0 - 3),
    h: g.staffY[g.staffY.length - 1] + 13 - Math.max(0, g.staffY[0] - 9),
  };
  const made = { crop, svg: pageToSvg({ ...page, prims }, res.staffSpace, { crop }) };
  previewCache.set(prims, made);
  return made;
}

/** The popover over the strip with the system of measure `mi` (the measure marked), the system before it above and the one after it below. */
function Preview({ res, mi, x, label }: { res: Engraved; mi: number; x: number; label: string }) {
  const i = res.layout.systems.findIndex((s) => s.a <= mi && mi <= s.b);
  if (i < 0) return null;
  const shown = [i - 1, i, i + 1]
    .filter((k) => k >= 0 && k < res.layout.systems.length)
    .map((k) => ({ k, ...systemPreview(res, k) }));
  // All systems are drawn at one scale: a narrower one (such as a short last system) is drawn narrower.
  const widest = Math.max(...shown.map((p) => p.crop.w));
  const g = res.layout.measures.find((m) => m.mi === mi && m.staff === 0);
  const strip = document.querySelector('.overview .strip')?.getBoundingClientRect();
  const w = Math.min(560, innerWidth - 16);
  return (
    <div
      class="preview"
      style={{
        width: `${w}px`,
        left: `${Math.max(8, Math.min(innerWidth - w - 8, x - w / 2))}px`,
        bottom: `${innerHeight - (strip?.top ?? innerHeight) + 8}px`,
      }}
    >
      {shown.map(({ k, crop, svg }) => (
        <div class="pic" style={{ width: `${(crop.w / widest) * 100}%` }}>
          <div dangerouslySetInnerHTML={{ __html: svg }} />
          {k === i && g && (
            <div
              class="at"
              style={{ left: `${((g.x0 - crop.x) / crop.w) * 100}%`, width: `${((g.x1 - g.x0) / crop.w) * 100}%` }}
            />
          )}
        </div>
      ))}
      <div class="cap">{`${label} · system ${i + 1} · page ${res.layout.systems[i].page + 1}`}</div>
    </div>
  );
}

/** The strip with the "go to measure" box. */
export function Overview() {
  const sc = score.value;
  const res = engraved.value;
  const z = zoom.value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sc` is the score the bars are computed from.
  const { bars, total } = useMemo(() => barsOf(sc), [sc]);
  const maxNotes = Math.max(1, ...bars.map((b) => b.notes));
  const strip = useRef<HTMLDivElement>(null);
  const [hov, setHov] = useState<{ mi: number; x: number } | null>(null);
  const [view, setView] = useState<{ a: number; b: number } | null>(null);
  // Where each system and page starts, from the layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `res` holds the layout read inside.
  const starts = useMemo(() => {
    const sys = new Map<number, string>();
    const pg = new Set<number>();
    let last = -1;
    for (const s of res?.layout.systems ?? []) {
      if (s.page !== last) pg.add(s.a);
      sys.set(s.a, s.page !== last && s.page > 0 ? `p${s.page + 1} · ${s.a + 1}` : `${s.a + 1}`);
      last = s.page;
    }
    return { sys, pg };
  }, [res]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sc` is the score the landmarks are read from.
  const lands = useMemo(() => landmarksOf(sc), [sc]);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = must(strip.current);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    setWidth(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The numbers of the systems' first measures along the top, those without room left out.
  const rulerEnds = { x: Number.NEGATIVE_INFINITY };
  const ruler = [...starts.sys].filter(([mi, label]) => {
    const x = (bars[mi].start / total) * width;
    if (x < rulerEnds.x + 2 || x + labelWidth(label) > width) return false;
    rulerEnds.x = x + labelWidth(label);
    return true;
  });
  // The visible part follows the scrolling of the score pane, its resizing and every new engraving.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `res` and `z` are what moves the pages.
  useEffect(() => {
    const box = pageEls[0]?.closest('.scroll');
    if (!box) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView(visibleMeasures()));
    };
    update();
    box.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(box);
    return () => {
      cancelAnimationFrame(raf);
      box.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [res, z]);

  const selected = new Set<number>();
  for (const r of selection.value) if ('mi' in r) selected.add(r.mi);
  const warn = new Set(parallels.value.map((g) => g.mi));
  const playing = playMeasure.value;
  const pct = (t: number) => `${(t / total) * 100}%`;

  /** The measure under the pointer, or -1 for an empty piece. */
  const measureAt = (e: PointerEvent): number => {
    const r = must(strip.current).getBoundingClientRect();
    return bars.length ? measureAtFraction(bars, total, (e.clientX - r.left) / r.width) : -1;
  };
  const scrub = (e: PointerEvent) => {
    const mi = measureAt(e);
    if (mi >= 0) revealMeasure(mi);
  };
  return (
    <div class="overview">
      <div
        class="strip"
        ref={strip}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => {
          const mi = measureAt(e);
          // While dragging, the score itself shows the place; the preview would only get in the way.
          setHov(mi >= 0 && !(e.buttons & 1) ? { mi, x: e.clientX } : null);
          if (e.buttons & 1) scrub(e);
        }}
        onPointerLeave={() => setHov(null)}
      >
        {bars.map((b, mi) => (
          <div
            class={`bar${starts.pg.has(mi) ? ' pg' : starts.sys.has(mi) ? ' sys' : ''}${selected.has(mi) ? ' sel' : ''}${warn.has(mi) ? ' warn' : ''}`}
            style={{ left: pct(b.start), width: pct(b.len) }}
          >
            <i style={{ height: `${(b.notes / maxNotes) * 100}%` }} />
          </div>
        ))}
        {ruler.map(([mi, label]) => (
          <span class="num" style={{ left: pct(bars[mi].start) }}>
            {label}
          </span>
        ))}
        {lands.map((l) => (
          <div class={`mark ${l.kind}`} style={{ left: pct(bars[l.mi].start) }} />
        ))}
        {view && bars[view.a] && bars[view.b] && (
          <div
            class="view"
            style={{
              left: pct(bars[view.a].start),
              width: pct(bars[view.b].start + bars[view.b].len - bars[view.a].start),
            }}
          />
        )}
        {playing !== null && bars[playing] && <div class="play" style={{ left: pct(bars[playing].start) }} />}
      </div>
      {hov && res && (
        <Preview
          res={res}
          mi={hov.mi}
          x={hov.x}
          label={[`Measure ${hov.mi + 1}`, ...lands.filter((l) => l.mi === hov.mi).map((l) => l.label)].join(' · ')}
        />
      )}
      {gotoOpen.value && <GotoPrompt count={bars.length} />}
    </div>
  );
}
