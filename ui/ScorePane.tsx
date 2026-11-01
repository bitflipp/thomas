import { effect } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { pageToSvg } from '../src/render.ts';
import { loadSmufl } from '../src/smufl.ts';
import { refKey, type Ref } from '../src/editor/addr.ts';
import { dependentNotes, noteBoxes, primRef, type HitIndex } from '../src/editor/hit.ts';
import type { Engraved } from '../src/engrave/system.ts';
import type { Page, Prim } from '../src/engrave/scene.ts';
import { findCollisions } from '../src/engrave/collide.ts';
import { engraved, hit, selection, zoom, fit, tool, score, showCollisions, voiceColors, VOICE_COLORS } from './state.ts';
import { playhead, playing } from './player.ts';
import { zoomBy, takeZoomAnchor, ghost, hover, pageEls, onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onContextMenu, cancelDrag, type Ghost } from './interact.ts';

const MM_PX = 96 / 25.4;
const SEL = '#2f6fed';
const HOVER = '#6b9af0'; // the selection colour, lighter

function GhostSvg({ g, page }: { g: Ghost | null; page: number }) {
  if (!g) return null;
  const sm = loadSmufl();
  if (g.kind === 'note' && g.page === page) {
    const col = g.bad ? '#d33' : SEL;
    const ledgers: number[] = [];
    for (let p = -2; p >= g.pos; p -= 2) ledgers.push(p);
    for (let p = 10; p <= g.pos; p += 2) ledgers.push(p);
    const accGlyph = g.acc === undefined ? null : ['accidentalDoubleFlat', 'accidentalFlat', 'accidentalNatural', 'accidentalSharp', 'accidentalDoubleSharp'][g.acc + 2];
    const head = g.base === 1 ? 'noteheadWhole' : g.base === 2 ? 'noteheadHalf' : 'noteheadBlack';
    return (
      <g opacity="0.75" fill={col} stroke={col}>
        {ledgers.map((p) => <line x1={g.x - 0.4} x2={g.x + 1.6} y1={g.top + 4 - p / 2} y2={g.top + 4 - p / 2} stroke-width="0.16" />)}
        <path d={sm.path(head)} transform={`translate(${g.x} ${g.y})`} stroke="none" />
        {accGlyph && <path d={sm.path(accGlyph)} transform={`translate(${g.x - 1.2} ${g.y})`} stroke="none" />}
        <text x={g.x + 1.9} y={g.y - 0.9} font-size="1.5" stroke="none" font-family="system-ui, sans-serif">{g.label}</text>
      </g>
    );
  }
  if (g.kind === 'head' && g.page === page) {
    return (
      <g opacity="0.8" fill={SEL} stroke={SEL}>
        <path d={sm.path('noteheadBlack')} transform={`translate(${g.x} ${g.y})`} stroke="none" />
        <text x={g.x + g.w + 0.6} y={g.y - 0.9} font-size="1.5" stroke="none" font-family="system-ui, sans-serif">{g.label}</text>
      </g>
    );
  }
  if (g.kind === 'bar' && g.page === page) return <g><line x1={g.x} x2={g.x} y1={g.top - 1} y2={g.top + 5} stroke={g.bad ? '#d33' : SEL} stroke-width="0.25" opacity="0.8" />{g.label && <text x={g.x + 0.5} y={g.top - 1.2} font-size="1.4" fill={g.bad ? '#d33' : SEL} font-family="system-ui, sans-serif">{g.label}</text>}</g>;
  if (g.kind === 'span') {
    const col = g.bad ? '#d33' : SEL;
    const a = g.from, b = g.to;
    return (
      <g stroke={col} fill={col} opacity="0.8">
        {a.page === page && b.page === page && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke-width="0.3" stroke-dasharray="0.8 0.5" />}
        {a.page === page && <circle cx={a.x} cy={a.y} r="0.5" stroke="none" />}
        {b.page === page && <circle cx={b.x} cy={b.y} r="0.5" stroke="none" />}
      </g>
    );
  }
  if (g.kind === 'rect' && g.page === page) return <rect x={g.box.x0} y={g.box.y0} width={g.box.x1 - g.box.x0} height={g.box.y1 - g.box.y0} fill={SEL} fill-opacity="0.12" stroke={SEL} stroke-width="0.12" />;
  return null;
}

/** One page: its SVG is only generated while it is near the viewport, and again only when something on it changed. */
function PageView({ i, res, h, sig, keys, cssW, cursor }: { i: number; res: Engraved; h: HitIndex; sig: string; keys: Set<string>; cssW: number; cursor: string }) {
  const el = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(i < 2);
  useEffect(() => {
    const e = el.current!;
    const io = new IntersectionObserver((en) => setNear(en[0].isIntersecting), { rootMargin: '1800px 0px' });
    io.observe(e);
    return () => io.disconnect();
  }, []);
  const p = res.pages[i];
  const svg = useMemo(() => {
    if (!near) return '';
    const colorFor = (q: Prim): string | undefined => {
      if (!q.r) return undefined;
      const r = primRef(h.index, q);
      if (!r) return undefined;
      if (keys.size && q.k !== 'beam') {
        if (r.t === 'ev') {
          if (keys.has(refKey({ ...r, pi: undefined } as Ref))) return SEL;
          if (r.pi !== undefined && keys.has(refKey(r))) return SEL;
        } else if (keys.has(refKey(r))) return SEL;
      }
      if (voiceColors.value && (r.t === 'ev' || r.t === 'tie' || r.t === 'slur' || r.t === 'tuplet')) return VOICE_COLORS[r.voice];
      return undefined;
    };
    return pageToSvg(p, res.staffSpace, { color: colorFor, index: true }).replace(/^<\?xml[^>]*>\s*/, '');
  }, [res, h, sig, near, voiceColors.value]);
  // the hovered element is recoloured in place, like a selected one but lighter (no new SVG per pointer move)
  const wrap = useRef<HTMLDivElement | null>(null);
  const hov = hover.value;
  const hovered = useMemo(() => {
    if (!hov || hov.page !== i || !near) return [];
    const key = refKey(hov.ref), curve = hov.k === 'slur' || hov.k === 'tie';
    const out: number[] = [];
    p.prims.forEach((q, n) => {
      if (!q.k || q.k === 'beam' || !q.r || (curve && q.k !== hov.k)) return;
      const r = primRef(h.index, q);
      // like a selection: an event without a head index covers all its heads too
      if (r && (refKey(r) === key || (hov.ref.t === 'ev' && hov.ref.pi === undefined && r.t === 'ev' && refKey({ ...r, pi: undefined } as Ref) === key))) out.push(n);
    });
    return out;
  }, [hov, h, p, i, near]);
  useEffect(() => {
    const root = wrap.current;
    if (!root || !hovered.length) return;
    const undo: (() => void)[] = [];
    for (const n of hovered) {
      const el = root.querySelector<SVGElement>(`[data-p="${n}"]`);
      if (!el || el.getAttribute('fill') === SEL || el.getAttribute('stroke') === SEL) continue; // selected: keep its colour
      const prop = el.tagName === 'line' ? 'stroke' : 'fill', old = el.style.getPropertyValue(prop);
      el.style.setProperty(prop, HOVER);
      undo.push(() => el.style.setProperty(prop, old));
    }
    return () => undo.forEach((f) => f());
  }, [hovered, svg]);
  const collisions = useMemo(() => (showCollisions.value && near ? findCollisionsOn(p, i) : []), [res, showCollisions.value, near]);
  const bands = selection.value.filter((r) => r.t === 'measure') as Extract<Ref, { t: 'measure' }>[];
  return (
    <div class="page" ref={(e) => { el.current = e; pageEls[i] = e; }} style={{ width: `${cssW}px`, height: near ? undefined : `${(cssW * p.height) / p.width}px`, cursor }} onPointerDown={onPointerDown} onDblClick={onDoubleClick}>
      <div class="svgwrap" ref={wrap} dangerouslySetInnerHTML={{ __html: svg }} />
      <svg class="overlay" viewBox={`0 0 ${p.width} ${p.height}`}>
        {bands.map((b) => {
          const gs = res.layout.measures.filter((m) => m.mi === b.mi && m.page === i);
          if (!gs.length) return null;
          const top = Math.min(...gs.map((m) => m.y)) - 1.2, bot = Math.max(...gs.map((m) => m.y)) + 5.2;
          return <rect x={gs[0].x0} y={top} width={gs[0].x1 - gs[0].x0} height={bot - top} fill={SEL} fill-opacity="0.09" />;
        })}
        {collisions.map((c) => <rect x={c.x} y={c.y} width={c.w} height={c.h} fill="none" stroke="#d33" stroke-width="0.12" />)}
        <NotesSvg page={i} h={h} />
        <GhostSvg g={ghost.value} page={i} />
        <PlayheadSvg page={i} />
      </svg>
    </div>
  );
}

/** Notes that the selected slurs, ties and tuplets belong to. */
function NotesSvg({ page, h }: { page: number; h: HitIndex }) {
  const sel = selection.value, sc = score.value;
  const boxes = useMemo(() => {
    const want = new Set<string>();
    for (const r of sel) for (const a of dependentNotes(sc, r)) want.add(`${a.mi}:${a.staff}:${a.voice}:${a.idx}`);
    if (!want.size) return [];
    return noteBoxes(h, page, [...want].map((k) => { const [mi, staff, voice, idx] = k.split(':'); return { mi: Number(mi), staff, voice: Number(voice), idx: Number(idx) }; }));
  }, [sel, sc, h, page]);
  const pad = 0.25;
  return <g pointer-events="none">{boxes.map((b) => <rect x={b.x0 - pad} y={b.y0 - pad} width={b.x1 - b.x0 + 2 * pad} height={b.y1 - b.y0 + 2 * pad} rx="0.4" fill="#f59f00" fill-opacity="0.3" stroke="#f08c00" stroke-width="0.12" />)}</g>;
}

function PlayheadSvg({ page }: { page: number }) {
  const p = playhead.value;
  if (!p || p.page !== page) return null;
  return <line class="playhead" x1={p.x} x2={p.x} y1={p.y0} y2={p.y1} stroke="#e8590c" stroke-width="0.22" stroke-linecap="round" />;
}

function findCollisionsOn(p: Page, i: number) {
  return findCollisions([p]).map((c) => ({ ...c, page: i + 1 }));
}

export function ScorePane() {
  const res = engraved.value;
  const h = hit.value;
  const sel = selection.value;
  const z = zoom.value;
  const box = useRef<HTMLDivElement>(null);
  const [paneW, setPaneW] = useState(0); // measured pane width: the first render happens before the pane exists
  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setPaneW(el.clientWidth));
    setPaneW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const a = takeZoomAnchor(), el = box.current, pg = pageEls[0];
    if (!a || !el || !pg) return;
    // content coordinate under the cursor scales about the pages' origin (the pane's padding stays fixed)
    const b = el.getBoundingClientRect(), p = pg.getBoundingClientRect();
    const cx = a.x - b.left, cy = a.y - b.top;
    const padX = p.left - b.left + el.scrollLeft, padY = p.top - b.top + el.scrollTop;
    el.scrollLeft = (el.scrollLeft + cx - padX) * a.r + padX - cx;
    el.scrollTop = (el.scrollTop + cy - padY) * a.r + padY - cy;
  }, [z]);
  useEffect(() => {
    const move = (e: PointerEvent) => onPointerMove(e), up = (e: PointerEvent) => onPointerUp(e);
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    addEventListener('blur', cancelDrag);
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('blur', cancelDrag); };
  }, []);
  useEffect(() => {
    const el = box.current!;
    const w = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX, y: e.clientY }); } };
    el.addEventListener('wheel', w, { passive: false });
    return () => el.removeEventListener('wheel', w);
  }, []);

  // while playing, keep the system under the playhead in view
  useEffect(() => effect(() => {
    const p = playhead.value, r = engraved.peek(), el = box.current;
    if (!p || !r || !el || !playing.value) return;
    const pg = pageEls[p.page];
    if (!pg) return;
    const k = pg.clientWidth / r.pages[p.page].width;
    const y0 = pg.offsetTop + p.y0 * k, y1 = pg.offsetTop + p.y1 * k;
    if (y0 < el.scrollTop + 8 || y1 > el.scrollTop + el.clientHeight - 8) el.scrollTo({ top: Math.max(0, y0 - 40), behavior: 'smooth' });
  }), []);

  const keys = useMemo(() => new Set(sel.map(refKey)), [sel]);
  // which selected objects are drawn on which page: a page is redrawn only when its own part of the selection changes
  const sigs = useMemo(() => {
    const out: string[] = [];
    if (!h) return out;
    const per = new Map<number, string[]>();
    if (keys.size) for (const t of h.targets) {
      const k = refKey(t.ref);
      if (keys.has(k) || (t.ref.t === 'ev' && keys.has(refKey({ ...t.ref, pi: undefined } as Ref)))) (per.get(t.page) ?? per.set(t.page, []).get(t.page)!).push(k);
    }
    for (const [pg, ks] of per) out[pg] = ks.sort().join('|');
    return out;
  }, [h, keys]);
  if (!res || !h) return <div class="scroll" ref={box} />;
  const cssW = (pw: number) => (fit.value ? Math.max(200, (paneW || 800) - 48) * z : pw * res.staffSpace * MM_PX * z);
  const cursor = tool.value === 'select' ? 'default' : 'crosshair';
  return (
    <div class="scroll" ref={box} onContextMenu={onContextMenu}>
      {res.pages.map((p, i) => <PageView key={i} i={i} res={res} h={h} sig={sigs[i] ?? ''} keys={keys} cssW={cssW(p.width)} cursor={cursor} />)}
    </div>
  );
}
void score;
