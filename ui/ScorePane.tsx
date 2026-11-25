// The score view: the engraved pages as SVG, with overlays for ghosts (note input preview, marquee,
// drag feedback), the playhead, hover and selection highlights.
//
// Re-engraving happens in state.ts; this pane only draws its result. To stay fast on a big piece, SVG is
// generated only for pages near the viewport, and again only when the page's own part of the selection
// changed; hover and selection recolor primitives in place instead of regenerating the SVG.

import { effect } from '@preact/signals';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Ref } from '../src/editor/addr.ts';
import { refKey } from '../src/editor/addr.ts';
import type { HitIndex } from '../src/editor/hit.ts';
import { dependentNotes, noteBoxes, primRef } from '../src/editor/hit.ts';
import type { Prim } from '../src/engrave/scene.ts';
import type { Engraved } from '../src/engrave/system.ts';
import { pageToSvg } from '../src/render.ts';
import { loadSmufl } from '../src/smufl.ts';
import { must } from '../src/util.ts';
import { caretGeom, slurFrom } from './caret.ts';
import type { Ghost } from './interact.ts';

import {
  cancelDrag,
  ghost,
  hover,
  onDoubleClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  pageEls,
  reveal,
  takeZoomAnchor,
  zoomBy,
} from './interact.ts';

import { hoverShape, LAYER_COLORS, layerNotes, shapeById, shapeParts, wheelFinding } from './layers.ts';
import { playhead, playing } from './player.ts';

import {
  caret,
  engraved,
  entering,
  fit,
  hit,
  printing,
  score,
  selection,
  showExpression,
  shownZoom,
  tool,
  VOICE_COLORS,
  voice,
  voiceColors,
  zoom,
} from './state.ts';

const MM_PX = 96 / 25.4;
const SEL = '#2f6fed';
const GHOST = '#c4c4c4'; // A hidden rest is drawn faintly in the editor only.
const HOVER = '#6b9af0'; // This is the selection color, but lighter.

type GhostOf<K extends Ghost['kind']> = Extract<Ghost, { kind: K }>;

const BAD = '#d33';
const GHOST_FONT = 'system-ui, sans-serif';

const _ACCIDENTAL_GLYPHS = [
  'accidentalDoubleFlat',
  'accidentalFlat',
  'accidentalNatural',
  'accidentalSharp',
  'accidentalDoubleSharp',
];

/** A head being dragged to another pitch. */
function HeadGhost({ g }: { g: GhostOf<'head'> }) {
  return (
    <g opacity="0.8" fill={SEL} stroke={SEL}>
      <path d={loadSmufl().path('noteheadBlack')} transform={`translate(${g.x} ${g.y})`} stroke="none" />
      <text x={g.x + g.w + 0.6} y={g.y - 0.9} font-size="1.5" stroke="none" font-family={GHOST_FONT}>
        {g.label}
      </text>
    </g>
  );
}

/** A barline being placed. */
function BarGhost({ g }: { g: GhostOf<'bar'> }) {
  const col = g.bad ? BAD : SEL;
  return (
    <g>
      <line x1={g.x} x2={g.x} y1={g.top - 1} y2={g.top + 5} stroke={col} stroke-width="0.25" opacity="0.8" />
      {g.label && (
        <text x={g.x + 0.5} y={g.top - 1.2} font-size="1.4" fill={col} font-family={GHOST_FONT}>
          {g.label}
        </text>
      )}
    </g>
  );
}

/** The input caret on page `page`: a bar through its staff with the input voice, shown while notes are entered. */
function CaretSvg({ page }: { page: number }) {
  const c = caret.value;
  if (!(c && entering())) return null;
  const at = caretGeom(c);
  if (!at || at.page !== page) return null;
  return (
    <g>
      <rect x={at.x - 0.15} y={at.y - 0.8} width="0.3" height="5.6" fill={SEL} opacity="0.85" />
      <text x={at.x + 0.4} y={at.y - 1} font-size="1.4" fill={SEL} font-family={GHOST_FONT}>
        {slurFrom.value ? `${voice.value} slur` : voice.value}
      </text>
    </g>
  );
}

/** A span (slur, hairpin, ...) being dragged out; either end may be on another page. */
function SpanGhost({ g, page }: { g: GhostOf<'span'>; page: number }) {
  const col = g.bad ? BAD : SEL;
  const { from: a, to: b } = g;
  return (
    <g stroke={col} fill={col} opacity="0.8">
      {a.page === page && b.page === page && (
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke-width="0.3" stroke-dasharray="0.8 0.5" />
      )}
      {a.page === page && <circle cx={a.x} cy={a.y} r="0.5" stroke="none" />}
      {b.page === page && <circle cx={b.x} cy={b.y} r="0.5" stroke="none" />}
    </g>
  );
}

/** The marquee rectangle while it is dragged. */
function RectGhost({ g }: { g: GhostOf<'rect'> }) {
  return (
    <rect
      x={g.box.x0}
      y={g.box.y0}
      width={g.box.x1 - g.box.x0}
      height={g.box.y1 - g.box.y0}
      fill={SEL}
      fill-opacity="0.12"
      stroke={SEL}
      stroke-width="0.12"
    />
  );
}

/** The overlay for the current ghost (note input preview, marquee, span) on page `page`. */
function GhostSvg({ g, page }: { g: Ghost | null; page: number }) {
  if (!g) return null;
  if (g.kind === 'span') return <SpanGhost g={g} page={page} />;
  if (g.page !== page) return null;
  switch (g.kind) {
    case 'head':
      return <HeadGhost g={g} />;
    case 'bar':
      return <BarGhost g={g} />;
    case 'rect':
      return <RectGhost g={g} />;
    default:
      return null;
  }
}

/** One page: its SVG is only generated while it is near the viewport, and again only when something on it changed. */
function PageView({
  i,
  res,
  h,
  sig,
  keys,
  cssW,
  cursor,
}: {
  i: number;
  res: Engraved;
  h: HitIndex;
  sig: string;
  keys: Set<string>;
  cssW: number;
  cursor: string;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const [nearView, setNear] = useState(i < 2);
  const near = nearView || printing.value;
  useEffect(() => {
    const e = must(el.current);
    const io = new IntersectionObserver((en) => setNear(en[0].isIntersecting), { rootMargin: '1800px 0px' });
    io.observe(e);
    return () => io.disconnect();
  }, []);
  const p = res.pages[i];
  const warn = layerNotes.value;
  const svg = useMemo(() => {
    if (!near) return '';
    const colorFor = (q: Prim): string | undefined => {
      if (!q.r || printing.value) return undefined; // Print output is plain black, so it has no selection or voice colors.
      const r = primRef(h.index, q);
      if (!r) return undefined;
      if (keys.size && q.k !== 'beam') {
        if (r.t === 'ev') {
          if (keys.has(refKey({ ...r, pi: undefined } as Ref))) return SEL;
          if (r.pi !== undefined && keys.has(refKey(r))) return SEL;
        } else if (keys.has(refKey(r))) return SEL;
      }
      if (warn.heads.size && r.t === 'ev' && q.k !== 'beam' && !q.ghost) {
        const k = refKey(r);
        const whole = warn.wholeEvents.get(k);
        if (r.pi === undefined && whole) {
          // The stem and flags of a note whose head is selected are selected too, not warned.
          for (const sk of keys) if (sk.startsWith(`${k}:`)) return SEL;
          return whole;
        }
        const head = r.pi !== undefined ? warn.heads.get(k) : undefined;
        if (head) return head;
      }
      if (q.ghost) return GHOST;
      if (voiceColors.value && (r.t === 'ev' || r.t === 'tie' || r.t === 'slur' || r.t === 'line' || r.t === 'tuplet'))
        return VOICE_COLORS[r.voice];
      return undefined;
    };
    return pageToSvg(p, res.staffSpace, { color: colorFor, index: true, ghosts: !printing.value }).replace(
      /^<\?xml[^>]*>\s*/,
      '',
    );
  }, [res, h, sig, near, voiceColors.value, printing.value, warn]);
  // The hovered element is recolored in place, like a selected one but lighter. Generating
  // new SVG on every pointer move would be far too slow, so only the matching primitives change.
  const wrap = useRef<HTMLDivElement | null>(null);
  const hov = hover.value;
  const hovered = useMemo(() => {
    if (!hov || hov.page !== i || !near) return [];
    const key = refKey(hov.ref);
    const curve = hov.k === 'slur' || hov.k === 'tie' || hov.k === 'link';
    const out: number[] = [];
    p.prims.forEach((q, n) => {
      if (!q.k || q.k === 'beam' || !q.r || (curve && q.k !== hov.k)) return;
      const r = primRef(h.index, q);
      // Like a selection: an event without a head index covers all its heads too, since
      // the whole note is what a click on it would select.
      if (
        r &&
        (refKey(r) === key ||
          (hov.ref.t === 'ev' &&
            hov.ref.pi === undefined &&
            r.t === 'ev' &&
            refKey({ ...r, pi: undefined } as Ref) === key))
      )
        out.push(n);
    });
    return out;
  }, [hov, h, p, i, near]);
  useEffect(() => {
    const root = wrap.current;
    if (!(root && hovered.length)) return;
    const undo: (() => void)[] = [];
    for (const n of hovered) {
      const el = root.querySelector<SVGElement>(`[data-p="${n}"]`);
      if (!el || el.getAttribute('fill') === SEL || el.getAttribute('stroke') === SEL) continue; // A selected element keeps its color.
      if (el.getAttribute('fill') === '#fff') continue; // A white mask (the disc behind a circled tuplet number) stays white.
      const prop = el.tagName === 'line' ? 'stroke' : 'fill';
      const old = el.style.getPropertyValue(prop);
      el.style.setProperty(prop, HOVER);
      undo.push(() => el.style.setProperty(prop, old));
    }
    return () => {
      for (const f of undo) f();
    };
  }, [hovered, svg]);
  // While an outline is hovered, the flagged notes that do not belong to it fall back to black, so that the notes of the
  // outline stand out of a dense stack. Like the hover recoloring, this changes the generated SVG in place.
  const hs = hoverShape.value;
  useEffect(() => {
    const root = wrap.current;
    const sh = hs ? shapeById(hs) : undefined;
    if (!(root && sh && near)) return;
    const keep = new Set<string>();
    for (const r of sh)
      if (r.t === 'ev') {
        keep.add(refKey(r));
        keep.add(refKey({ ...r, pi: undefined }));
      }
    const flagged = new Set(Object.values(LAYER_COLORS));
    const undo: (() => void)[] = [];
    for (const el of root.querySelectorAll<SVGElement>('[data-p]')) {
      const prop = el.tagName === 'line' ? 'stroke' : 'fill';
      const c = el.getAttribute(prop);
      if (!(c && flagged.has(c))) continue;
      const q = p.prims[Number(el.dataset.p)];
      const r = q && primRef(h.index, q);
      if (!r || keep.has(refKey(r))) continue;
      const old = el.style.getPropertyValue(prop);
      el.style.setProperty(prop, '#000');
      undo.push(() => el.style.setProperty(prop, old));
    }
    return () => {
      for (const f of undo) f();
    };
  }, [hs, svg, p, h, near]);
  const bands = selection.value.filter((r) => r.t === 'measure') as Extract<Ref, { t: 'measure' }>[];
  return (
    <div
      class="page"
      ref={(e) => {
        el.current = e;
        pageEls[i] = e;
      }}
      style={{ width: `${cssW}px`, height: near ? undefined : `${(cssW * p.height) / p.width}px`, cursor }}
      onPointerDown={onPointerDown}
      onDblClick={onDoubleClick}
    >
      <div class="svgwrap" ref={wrap} dangerouslySetInnerHTML={{ __html: svg }} />
      <svg aria-hidden="true" class="overlay" viewBox={`0 0 ${p.width} ${p.height}`}>
        {bands.map((b) => {
          const gs = res.layout.measures.filter((m) => m.mi === b.mi && m.page === i);
          if (!gs.length) return null;
          const top = Math.min(...gs.map((m) => m.y)) - 1.2;
          const bot = Math.max(...gs.map((m) => m.y)) + 5.2;
          return (
            <rect x={gs[0].x0} y={top} width={gs[0].x1 - gs[0].x0} height={bot - top} fill={SEL} fill-opacity="0.09" />
          );
        })}
        <NotesSvg page={i} h={h} />
        <FindingsSvg page={i} />
        <CaretSvg page={i} />
        <GhostSvg g={ghost.value} page={i} />
        <PlayheadSvg page={i} />
      </svg>
    </div>
  );
}

/** Notes that the selected slurs, ties and tuplets belong to. */
function NotesSvg({ page, h }: { page: number; h: HitIndex }) {
  const sel = selection.value;
  const sc = score.value;
  const boxes = useMemo(() => {
    const want = sel.flatMap((r) => dependentNotes(sc, r));
    return want.length ? noteBoxes(h, page, want) : [];
  }, [sel, sc, h, page]);
  const pad = 0.25;
  return (
    <g pointer-events="none">
      {boxes.map((b) => (
        <rect
          x={b.x0 - pad}
          y={b.y0 - pad}
          width={b.x1 - b.x0 + 2 * pad}
          height={b.y1 - b.y0 + 2 * pad}
          fill="#f59f00"
          fill-opacity="0.3"
          stroke="#f08c00"
          stroke-width="0.12"
        />
      ))}
    </g>
  );
}

/** The outlines of the findings on page `page`: a translucent quadrilateral through the four heads of each interval, so that findings stack where they overlap. The one under the pointer is drawn last, stronger, and the others fade. */
function FindingsSvg({ page }: { page: number }) {
  const hs = hoverShape.value;
  const parts = shapeParts.value.filter((s) => s.page === page);
  if (!parts.length) return null;
  const ordered = hs ? [...parts.filter((s) => s.id !== hs), ...parts.filter((s) => s.id === hs)] : parts;
  return (
    <g pointer-events="none" stroke-linejoin="round">
      {ordered.map((s) => {
        const col = LAYER_COLORS[s.severity];
        const on = s.id === hs;
        return (
          <polygon
            points={s.pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill={col}
            fill-opacity={on ? 0.3 : hs ? 0.04 : 0.1}
            stroke={col}
            stroke-width={on ? 0.25 : 0.12}
            stroke-opacity={hs && !on ? 0.4 : 1}
          />
        );
      })}
    </g>
  );
}

/** The playhead line on page `page`, if playback is there. */
function PlayheadSvg({ page }: { page: number }) {
  const p = playhead.value;
  if (!p || p.page !== page) return null;
  return (
    <line
      class="playhead"
      x1={p.x}
      x2={p.x}
      y1={p.y0}
      y2={p.y1}
      stroke="#e8590c"
      stroke-width="0.22"
      stroke-linecap="round"
    />
  );
}

/**
 * The pane with all pages: SVG per page (generated only near the viewport), overlays, zoom and fit, and the
 * pointer handlers.
 */
export function ScorePane() {
  const res = engraved.value;
  const h = hit.value;
  const sel = selection.value;
  const z = zoom.value;
  const box = useRef<HTMLDivElement>(null);
  const [paneW, setPaneW] = useState(0); // This is the measured pane width; the first render happens before the pane exists.
  useEffect(() => {
    const el = must(box.current);
    const ro = new ResizeObserver(() => setPaneW(el.clientWidth));
    setPaneW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Coming back from the Expression pane, the score is scrolled so that the selection is in the middle.
  const expressionOpen = showExpression.value;
  useLayoutEffect(() => {
    if (expressionOpen) return;
    const first = selection.peek()[0];
    if (first) reveal(first, true);
  }, [expressionOpen]);
  useEffect(() => {
    // Panning: dragging with the right button scrolls the pane.
    const el = must(box.current);
    const down = (e: PointerEvent) => {
      if (e.button !== 2) return;
      e.preventDefault();
      let x = e.clientX;
      let y = e.clientY;
      el.classList.add('panning');
      const move = (m: PointerEvent) => {
        el.scrollLeft -= m.clientX - x;
        el.scrollTop -= m.clientY - y;
        x = m.clientX;
        y = m.clientY;
      };
      const up = () => {
        el.classList.remove('panning');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    el.addEventListener('pointerdown', down);
    return () => el.removeEventListener('pointerdown', down);
  }, []);
  useLayoutEffect(() => {
    const a = takeZoomAnchor();
    const el = box.current;
    const pg = pageEls[0];
    if (!(a && el && pg)) return;
    // The content coordinate under the cursor scales about the pages' origin, while the pane's
    // padding stays fixed; solve for the scroll offset that keeps that coordinate under the cursor.
    const b = el.getBoundingClientRect();
    const p = pg.getBoundingClientRect();
    const cx = a.x - b.left;
    const cy = a.y - b.top;
    const padX = p.left - b.left + el.scrollLeft;
    const padY = p.top - b.top + el.scrollTop;
    el.scrollLeft = (el.scrollLeft + cx - padX) * a.r + padX - cx;
    el.scrollTop = (el.scrollTop + cy - padY) * a.r + padY - cy;
  }, [z]);
  useEffect(() => {
    const move = (e: PointerEvent) => onPointerMove(e);
    const up = (e: PointerEvent) => onPointerUp(e);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('blur', cancelDrag);
    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('blur', cancelDrag);
    };
  }, []);
  useEffect(() => {
    const el = must(box.current);
    const w = (e: WheelEvent) => {
      if (e.altKey && wheelFinding((e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : 1), e.timeStamp)) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX, y: e.clientY });
      }
    };
    el.addEventListener('wheel', w, { passive: false });
    return () => el.removeEventListener('wheel', w);
  }, []);

  // While playing, keep the system under the playhead in view: scroll only when it leaves the
  // visible area, so that the page does not jump on every frame.
  useEffect(
    () =>
      effect(() => {
        const p = playhead.value;
        const r = engraved.peek();
        const el = box.current;
        if (!(p && r && el && playing.value)) return;
        const pg = pageEls[p.page];
        if (!pg) return;
        const k = pg.clientWidth / r.pages[p.page].width;
        const y0 = pg.offsetTop + p.y0 * k;
        const y1 = pg.offsetTop + p.y1 * k;
        if (y0 < el.scrollTop + 8 || y1 > el.scrollTop + el.clientHeight - 8)
          el.scrollTo({ top: Math.max(0, y0 - 40), behavior: 'smooth' });
      }),
    [],
  );

  const keys = useMemo(() => new Set(sel.map(refKey)), [sel]);
  // Which selected objects are drawn on which page. Each page gets a signature of its own part
  // of the selection, so a page is regenerated only when that signature changes.
  const sigs = useMemo(() => {
    const out: string[] = [];
    if (!h) return out;
    const per = new Map<number, string[]>();
    if (keys.size)
      for (const t of h.targets) {
        const k = refKey(t.ref);
        if (keys.has(k) || (t.ref.t === 'ev' && keys.has(refKey({ ...t.ref, pi: undefined } as Ref))))
          (per.get(t.page) ?? must(per.set(t.page, []).get(t.page))).push(k);
      }
    for (const [pg, ks] of per) out[pg] = ks.sort().join('|');
    return out;
  }, [h, keys]);
  const fitted =
    res && fit.value ? (Math.max(200, (paneW || 800) - 48) * z) / (res.pages[0].width * res.staffSpace * MM_PX) : null;
  useEffect(() => {
    shownZoom.value = fitted ?? zoom.peek();
  }, [fitted]);
  if (!(res && h)) return <div class="scroll" ref={box} />;
  const cssW = (pw: number) => (fit.value ? Math.max(200, (paneW || 800) - 48) * z : pw * res.staffSpace * MM_PX * z);
  const cursor = tool.value === 'select' ? 'default' : 'crosshair';
  return (
    <div class="scroll" ref={box} onContextMenu={(e) => e.preventDefault()}>
      {res.pages.map((p, i) => (
        <PageView key={i} i={i} res={res} h={h} sig={sigs[i] ?? ''} keys={keys} cssW={cssW(p.width)} cursor={cursor} />
      ))}
    </div>
  );
}
