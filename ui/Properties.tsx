// Properties panel: edits the properties of whatever is selected (event, mark, slur, tuplet, measure) or of
// the score and its staves when nothing is. Every control calls a command from src/editor/commands.ts through `run`, so
// each change is one undo step and refusals appear as toasts.

import { signal } from '@preact/signals';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BeamMode } from '../src/beams.ts';
import { beamModes, beatPhase, beatTicks, canJoin } from '../src/beams.ts';
import type { EvAddr, Ref } from '../src/editor/addr.ts';
import { eventOf, markOf, refKey, tupletOf, voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { transposeSteps } from '../src/editor/context.ts';
import { neighborNote, syllableText } from '../src/editor/lyrics.ts';
import type { OrnamentKind } from '../src/editor/similar.ts';
import { eventsInMeasures } from '../src/editor/similar.ts';
import type { Event, Grace, MarkBody, MarkPlacement, NoteEvent, Score, Syllable } from '../src/model.ts';
import { flattenVoice, keyAt, measureLabel, measureTicks, PPQ, timeAt } from '../src/model.ts';
import { lengthStr } from '../src/textformat.ts';

import {
  chooseDots,
  flippableVoices,
  flipStem,
  flipVoices,
  lineSelection,
  moveSelectionToVoice,
  selectVoice,
  slurSelection,
  tieSelection,
} from './actions.ts';

import { Dropdown } from './Dropdown.tsx';
import { Ui } from './icons.tsx';
import { deleteSelection, evRefs, measureRefs, select, selectSimilar, tupletsAround } from './interact.ts';
import { DYNAMICS } from './Palette.tsx';
import { run, score, selection, space } from './state.ts';

/** A labeled row of controls in the Properties panel. */
function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="row">
      <span>{label}</span>
      <div class="ctl">{children}</div>
    </div>
  );
}

/** A dropdown over (value, label[, icon]) entries; a mixed selection shows an empty entry. */
function Pick<T extends string | number | boolean | undefined>({
  value,
  opts,
  onChange,
}: {
  value: T | 'mixed';
  opts: [T, string, preact.ComponentChildren?][];
  onChange: (v: T) => void;
}) {
  return (
    <Dropdown value={value} opts={opts.map(([v, label, icon]) => ({ value: v, label, icon }))} onChange={onChange} />
  );
}

/** A text input that commits its value when it loses focus or on Enter (and reverts on Escape). */
function LabelField({
  value,
  placeholder,
  title,
  narrow,
  onCommit,
}: {
  value: string;
  placeholder: string;
  title: string;
  narrow?: boolean;
  onCommit: (v: string) => void;
}) {
  return (
    <input
      type="text"
      class={narrow ? 'narrow' : undefined}
      key={value}
      value={value}
      placeholder={placeholder}
      title={title}
      onBlur={(e) => {
        const v = (e.target as HTMLInputElement).value;
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        const el = e.target as HTMLInputElement;
        if (e.key === 'Enter') el.blur();
        else if (e.key === 'Escape') {
          el.value = value;
          el.blur();
        }
      }}
    />
  );
}

/** A number input that commits a finite value on change. */
function Num({
  value,
  min,
  max,
  step,
  onChange,
  w,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (n: number) => void;
  w?: string;
}) {
  return (
    <input
      type="number"
      style={{ width: w ?? '4.5em' }}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

/** A text input that commits on change. */
function Txt({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange((e.target as HTMLInputElement).value)}
    />
  );
}

const same = <T,>(xs: T[]): T | 'mixed' => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : 'mixed');
const KEYS = Array.from({ length: 15 }, (_, i) => i - 7);

/** The name of a key signature of `n` fifths for the key pickers. */
function KEYNAME(n: number): string {
  if (n === 0) return 'C / a (no accidentals)';
  const count = Math.abs(n);
  return `${count} ${n > 0 ? 'sharp' : 'flat'}${count > 1 ? 's' : ''}`;
}

/**
 * Properties of the score as a whole: header texts, and page setup (staff space, margin, page size, multi-measure
 * rests, measure numbering).
 */
function ScoreSection() {
  const s = score.value;
  return (
    <section>
      <Group title="Header">
        <Row label="Title">
          <Txt value={s.meta.title ?? ''} onChange={(v) => run((x) => C.setMeta(x, { title: v }))} />
        </Row>
        <Row label="Subtitle">
          <Txt value={s.meta.subtitle ?? ''} onChange={(v) => run((x) => C.setMeta(x, { subtitle: v }))} />
        </Row>
        <Row label="Composer">
          <Txt value={s.meta.composer ?? ''} onChange={(v) => run((x) => C.setMeta(x, { composer: v }))} />
        </Row>
        <Row label="Footer">
          <Txt value={s.meta.rights ?? ''} onChange={(v) => run((x) => C.setMeta(x, { rights: v }))} />
        </Row>
      </Group>
      <Group title="Page">
        <Row label="Staff space">
          <Num
            value={space.value ?? s.page.staffSpace}
            step={0.05}
            min={0.8}
            max={4}
            onChange={(n) => run((x) => C.setPage(x, { staffSpace: n }))}
          />{' '}
          mm
        </Row>
        <Row label="Margin">
          <Num
            value={s.page.margin}
            step={1}
            min={0}
            max={40}
            onChange={(n) => run((x) => C.setPage(x, { margin: n }))}
          />{' '}
          mm
        </Row>
        <Row label="Page">
          <Num
            value={s.page.width}
            min={50}
            max={600}
            w="4.5em"
            onChange={(n) => run((x) => C.setPage(x, { width: n }))}
          />{' '}
          × <Num value={s.page.height} min={50} max={900} onChange={(n) => run((x) => C.setPage(x, { height: n }))} />{' '}
          mm
        </Row>
        <Row label="Multi-rests">
          <Pick
            value={!!s.page.multiRests}
            opts={[
              [false, 'off'],
              [true, 'on'],
            ]}
            onChange={(v) => run((x) => C.setMultiRests(x, v))}
          />
        </Row>
        <Row label="Labels, first">
          <Pick
            value={s.page.labelsFirst}
            opts={[
              [undefined, 'none'],
              ['full', 'full names'],
              ['abbr', 'abbreviations'],
            ]}
            onChange={(v) => run((x) => C.setStaffLabels(x, { first: v }))}
          />
        </Row>
        <Row label="Labels, others">
          <Pick
            value={s.page.labelsLater}
            opts={[
              [undefined, 'none'],
              ['full', 'full names'],
              ['abbr', 'abbreviations'],
            ]}
            onChange={(v) => run((x) => C.setStaffLabels(x, { later: v }))}
          />
        </Row>
        <Row label="Label size">
          <Num
            value={s.page.labelSize ?? 2}
            step={0.1}
            min={0.8}
            max={5}
            onChange={(n) => run((x) => C.setStaffLabels(x, { size: n === 2 ? undefined : n }))}
          />{' '}
          sp
        </Row>
        <Row label="Numbering">
          <Pick
            value={s.page.measureNumbers ?? 'system'}
            opts={[
              ['system', 'per system'],
              ['all', 'all'],
              ['none', 'none'],
            ]}
            onChange={(v) => run((x) => C.setMeasureNumbers(x, v === 'system' ? undefined : (v as 'all' | 'none')))}
          />
        </Row>
      </Group>
      <StavesSection />
    </section>
  );
}

const CLEF_OPTS: [string, { sign: 'G' | 'F' | 'C'; line: number; octave?: number }, string][] = [
  ['G2', { sign: 'G', line: 2 }, 'Treble'],
  ['F4', { sign: 'F', line: 4 }, 'Bass'],
  ['C3', { sign: 'C', line: 3 }, 'Alto'],
  ['C4', { sign: 'C', line: 4 }, 'Tenor'],
  ['G2-1', { sign: 'G', line: 2, octave: -1 }, 'Treble 8vb'],
  ['G2+1', { sign: 'G', line: 2, octave: 1 }, 'Treble 8va'],
  ['F4-1', { sign: 'F', line: 4, octave: -1 }, 'Bass 8vb'],
  ['F4+1', { sign: 'F', line: 4, octave: 1 }, 'Bass 8va'],
];

/** A string that identifies a clef for the clef picker. */
const clefKey = (c: { sign: string; line: number; octave?: number }) =>
  `${c.sign}${c.line}${c.octave ? (c.octave < 0 ? '-1' : '+1') : ''}`;

/** The staves list: names, clefs, order, instrument presets and how neighboring staves are joined. */
function StavesSection() {
  const s = score.value;
  const conn = C.connections(s);
  const [acts, setActs] = useState<string | undefined>();
  const [drag, setDrag] = useState<string | undefined>();
  const [over, setOver] = useState<number | undefined>();
  const [inst, setInst] = useState('piano');
  const clefSel = (st: Score['staves'][number]) => (
    <Dropdown
      value={clefKey(st.clef)}
      title="Clef"
      opts={CLEF_OPTS.map(([k, , label]) => ({ value: k, label }))}
      onChange={(k) => {
        const c = CLEF_OPTS.find(([q]) => q === k)?.[1];
        if (c) run((x) => C.setStaffClef(x, st.id, c));
      }}
    />
  );
  return (
    <Group title="Staves">
      <div class="staves">
        {s.staves.map((st, i) => (
          <>
            <div
              class={`staffrow${drag === st.id ? ' dragging' : ''}${over === i && drag && drag !== st.id ? ' dropto' : ''}`}
              onDragOver={(e) => {
                if (drag) {
                  e.preventDefault();
                  setOver(i);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) run((x) => C.moveStaffTo(x, drag, i));
                setDrag(undefined);
                setOver(undefined);
              }}
            >
              <span
                class="grip"
                draggable
                title="Drag to reorder"
                onDragStart={(e) => {
                  setDrag(st.id);
                  e.dataTransfer?.setData('text/plain', st.id);
                }}
                onDragEnd={() => {
                  setDrag(undefined);
                  setOver(undefined);
                }}
              >
                ⠿
              </span>
              <LabelField
                value={st.name ?? ''}
                placeholder={st.id}
                title="Full name, printed before the first system"
                onCommit={(v) => run((x) => C.setStaffName(x, st.id, v))}
              />
              <LabelField
                value={st.abbr ?? ''}
                placeholder="abbr."
                title="Abbreviation, printed before the other systems"
                narrow
                onCommit={(v) => run((x) => C.setStaffAbbr(x, st.id, v))}
              />
              {clefSel(st)}
              <button
                type="button"
                class="mini"
                title="Staff actions"
                aria-expanded={acts === st.id}
                onClick={() => setActs(acts === st.id ? undefined : st.id)}
              >
                ⋯
              </button>
            </div>
            {acts === st.id && (
              <div class="btns staffacts">
                <button type="button" onClick={() => run((c) => C.addInstrument(c, inst, i))}>
                  Insert above
                </button>
                <button type="button" onClick={() => run((c) => C.addInstrument(c, inst, i + 1))}>
                  Insert below
                </button>
                <button type="button" onClick={() => run((c) => C.duplicateStaff(c, st.id))}>
                  Duplicate
                </button>
                <button
                  type="button"
                  class="danger"
                  disabled={s.staves.length < 2}
                  onClick={() => run((c) => C.removeStaff(c, st.id))}
                >
                  Remove staff
                </button>
              </div>
            )}
            {i < s.staves.length - 1 && (
              <div class="joinrow">
                <span>joined by</span>
                <Pick
                  value={conn[i]}
                  opts={[
                    [undefined, 'none'],
                    ['brace', 'brace'],
                    ['bracket', 'bracket'],
                  ]}
                  onChange={(k) => run((x) => C.setConnection(x, i, k))}
                />
              </div>
            )}
          </>
        ))}
        <div class="btns">
          <Dropdown
            value={inst}
            title="Instrument to add (also used by Insert above/below)"
            opts={C.INSTRUMENTS.map((p) => ({ value: p.key, label: p.label }))}
            onChange={setInst}
          />
          <button type="button" onClick={() => run((x) => C.addInstrument(x, inst))}>
            Add
          </button>
        </div>
      </div>
    </Group>
  );
}

/** The lengths a measure can be given: the full one (value 0), then every sixteenth shorter, and its own if odd. */
function lengthOptions(s: Score, mi: number): { value: number; label: string }[] {
  const full = measureTicks(timeAt(s, mi));
  const unit = PPQ / 4;
  const opts = [{ value: 0, label: `Full (${lengthStr(full)})` }];
  for (let t = unit; t < full; t += unit) opts.push({ value: t, label: lengthStr(t) });
  const own = s.measures[mi].length;
  if (own !== undefined && !opts.some((o) => o.value === own)) opts.push({ value: own, label: lengthStr(own) });
  return opts;
}

/** The time and key signature that start at a measure, with a button to inherit them again. */
function MeasureSignatures({ mi, to }: { mi: number; to: number }) {
  const s = score.value;
  const m = s.measures[mi];
  const ts = timeAt(s, mi);
  const range = to > mi;
  return (
    <Group title="Signatures">
      <Row label="Time">
        <Num
          value={ts.beats}
          min={1}
          max={32}
          w="3.5em"
          onChange={(n) =>
            run((x) =>
              range ? C.setTimeSigRange(x, mi, to, { ...ts, beats: n }) : C.setTimeSig(x, mi, { ...ts, beats: n }),
            )
          }
        />{' '}
        /{' '}
        <Dropdown
          value={ts.beatType}
          opts={[1, 2, 4, 8, 16].map((b) => ({ value: b, label: String(b) }))}
          onChange={(b) =>
            run((x) =>
              range
                ? C.setTimeSigRange(x, mi, to, { ...ts, beatType: b })
                : C.setTimeSig(x, mi, { ...ts, beatType: b }),
            )
          }
        />
        {mi > 0 && m.time && (
          <button
            type="button"
            class="mini"
            title="Inherit from the previous measure"
            onClick={() => run((x) => C.setTimeSig(x, mi, undefined))}
          >
            ×
          </button>
        )}
      </Row>
      <Row label="Length">
        <Dropdown
          title="A shorter measure: a pickup (numbered 0) when it is the first one"
          value={m.length ?? 0}
          opts={lengthOptions(s, mi)}
          onChange={(len) => run((x) => C.setMeasureLength(x, mi, len || undefined))}
        />
      </Row>
      <Row label="Key">
        <Dropdown
          value={keyAt(s, mi)}
          opts={KEYS.map((k) => ({ value: k, label: KEYNAME(k) }))}
          onChange={(k) => run((x) => (range ? C.setKeySigRange(x, mi, to, k) : C.setKeySig(x, mi, k)))}
        />
        {mi > 0 && m.key !== undefined && (
          <button
            type="button"
            class="mini"
            title="Inherit from the previous measure"
            onClick={() => run((x) => C.setKeySig(x, mi, undefined))}
          >
            ×
          </button>
        )}
      </Row>
    </Group>
  );
}

/** Barline, repeat start, volta and forced break of a measure. */
function MeasureLayout({ mi, to }: { mi: number; to: number }) {
  const m = score.value.measures[mi];
  const last = score.value.measures[to];
  return (
    <Group title="Layout">
      <Row label="Barline">
        <Pick
          value={last.barline ?? 'single'}
          opts={[
            ['single', 'single', <Ui.barSingle />],
            ['double', 'double', <Ui.barDouble />],
            ['final', 'final', <Ui.barFinal />],
            ['repeat-end', 'repeat end', <Ui.barRepeatEnd />],
          ]}
          onChange={(v) => run((x) => C.setBarline(x, to, v))}
        />
      </Row>
      <Row label="Repeat start">
        <Pick
          value={m.repeatStart ? 'on' : 'off'}
          opts={[
            ['off', 'none'],
            ['on', 'start'],
          ]}
          onChange={(v) => run((x) => C.setRepeatStart(x, mi, v === 'on'))}
        />
      </Row>
      <Row label="Volta">
        <Pick
          value={m.ending?.join(',') ?? 'none'}
          opts={[
            ['none', 'none'],
            ['1', '1.'],
            ['2', '2.'],
            ['3', '3.'],
            ['1,2', '1.,2.'],
          ]}
          onChange={(v) =>
            run((x) => {
              let y = x;
              for (let k = mi; k <= to; k++) y = C.setEnding(y, k, v === 'none' ? undefined : v.split(',').map(Number));
              return y;
            })
          }
        />
      </Row>
      <Row label="Break before">
        <Pick
          value={m.breakBefore ?? 'none'}
          opts={[
            ['none', 'auto'],
            ['system', 'system'],
            ['page', 'page'],
          ]}
          onChange={(v) => run((x) => C.setBreak(x, mi, v === 'none' ? undefined : (v as 'system' | 'page')))}
        />
      </Row>
    </Group>
  );
}

/** Properties of one measure: time and key signature, barline, breaks, repeats and voltas. */
function MeasureSection({ mi, to }: { mi: number; to: number }) {
  const s = score.value;
  const m = s.measures[mi];
  if (!m || to >= s.measures.length) return null;
  return (
    <section>
      <MeasureSignatures mi={mi} to={to} />
      <MeasureLayout mi={mi} to={to} />
      <Group title="Actions">
        <div class="btns">
          <button
            type="button"
            title="Insert a measure before this one"
            onClick={() => run((x) => C.insertMeasures(x, mi))}
          >
            Add before
          </button>
          <button
            type="button"
            title="Insert a measure after this one"
            onClick={() => run((x) => C.insertMeasures(x, to + 1))}
          >
            Add after
          </button>
          <button
            type="button"
            title="Select every note and rest of these measures"
            onClick={() => select(eventsInMeasures(s, mi, to))}
          >
            Select notes
          </button>
          <button
            type="button"
            title="Replace the contents of these measures by rests; signatures, barlines and repeats stay"
            onClick={() => run((x) => C.clearMeasures(x, mi, to))}
          >
            Clear
          </button>
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
    </section>
  );
}

/** A titled group of controls. */
function SimilarButton() {
  return (
    <button type="button" title="Select similar (Ctrl+Shift+A)" onClick={() => selectSimilar()}>
      Sel. similar
    </button>
  );
}

/** Buttons that select every fermata, trill or grace-note event of the score, for the ornaments the selection has. */
function OrnamentSimilar({ evs }: { evs: Event[] }) {
  const kinds: [OrnamentKind, string, (e: Event) => boolean][] = [
    ['fermata', 'Fermatas', (e) => !!e.fermata],
    ['trill', 'Trills', (e) => e.kind === 'note' && !!e.trill],
    ['ornament', 'Mordents and turns', (e) => e.kind === 'note' && !!e.ornament],
    ['grace', 'Graces', (e) => e.kind === 'note' && !!e.graces?.length],
  ];
  const shown = kinds.filter(([, , has]) => evs.some(has));
  if (!shown.length) return null;
  return (
    <div class="seg fill">
      {shown.map(([by, label]) => (
        <button key={by} type="button" title={`Select every event with this ${by}`} onClick={() => selectSimilar(by)}>
          All {label.toLowerCase()}
        </button>
      ))}
    </div>
  );
}

/** A titled group of rows. */
function Group({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="sec">
      <div class="sh">{title}</div>
      {children}
    </div>
  );
}

/** A toggle button for a property; `on` marks it as set. */
function Tog({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
  children: preact.ComponentChildren;
}) {
  return (
    <button type="button" aria-pressed={on} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

const BEAM_MODES: [BeamMode, string, string][] = [
  ['auto', 'auto', 'The automatic rules decide whether this note is beamed to the previous one'],
  ['none', 'none', 'Not beamed to either neighbor'],
  ['break', 'start', 'Start a new beam at this note'],
  ['join', 'join', 'Continue the beam of the previous note (also across a beat)'],
];

/** The beam mode shared by the selected notes (`mixed` if they differ), the refs it applies to, why they cannot be joined to the previous note, and a selected tremolo note. */
function beamState(sc: Score, refs: Ref[]) {
  const notes = refs.flatMap((r) => {
    if (r.t !== 'ev') return [];
    const v = voiceOf(sc, r);
    return v && eventOf(sc, r)?.kind === 'note' ? [{ r, v }] : [];
  });
  if (!notes.length) return undefined;
  const cache = new Map<unknown, BeamMode[]>();
  const modes = notes.map(({ r, v }) => {
    let m = cache.get(v);
    if (!m) {
      m = beamModes(v, beatTicks(timeAt(sc, r.mi)), beatPhase(sc, r.mi));
      cache.set(v, m);
    }
    return m[r.idx];
  });
  const inTremolo = notes.find(({ r, v }) => flattenVoice(v)[r.idx]?.tremolo)?.r;
  return {
    refs: notes.map(({ r }) => r),
    mode: same(modes),
    cannotJoin: notes.map(({ r, v }) => canJoin(flattenVoice(v), r.idx)).find((w) => w),
    inTremolo,
  };
}

/** The heading of the event section: Note, Chord, Rest or a count when several events are selected. */
function eventTitle(sc: Score, refs: Extract<Ref, { t: 'ev' }>[]): string {
  const evs = refs.map((r) => eventOf(sc, r)).filter((e): e is Event => !!e);
  if (evs.length !== 1) return `${evs.length} events`;
  return evs[0].kind === 'note' ? (evs[0].pitches.length > 1 ? 'Chord' : 'Note') : 'Rest';
}

/** The verse the lyric input edits, and whether the input takes the focus when it next appears (after moving to another note). */
const lyricVerse = signal(1);

let refocusLyric = false;

/** The verse picker and the lyric box of a single selected note. */
function LyricRows({ ref0, note, sc }: { ref0: EvAddr; note: NoteEvent; sc: Score }) {
  const verse = lyricVerse.value;
  const maxVerse = Math.max(1, ...(note.lyrics ?? []).map((y) => y.verse));
  const verses = Array.from({ length: Math.min(maxVerse + 1, 8) }, (_, i) => i + 1);
  const cur = note.lyrics?.find((y) => y.verse === verse);
  return (
    <>
      <Row label="Verse">
        <Pick
          value={verse}
          opts={verses.map((v): [number, string] => [v, String(v)])}
          onChange={(v) => (lyricVerse.value = v)}
        />
      </Row>
      <Row label="Lyric">
        <LyricBox
          key={`${refKey({ t: 'ev', ...ref0 })}|${verse}|${cur ? syllableText(cur) : ''}`}
          ref0={ref0}
          verse={verse}
          cur={cur}
          sc={sc}
        />
      </Row>
    </>
  );
}

/**
 * The syllable of one note and verse. Typing is a stream: Space ends the word and moves to the next
 * note, `-` ends the syllable inside a word and moves on, `_` adds an extender and moves on, Backspace
 * in an empty box goes back one note, Enter keeps the note, Escape leaves the box. What was typed is kept
 * when the box loses focus and when it goes away (another note was selected), which is not a blur.
 * A box belongs to one note, verse and stored text (its parent keys it by them), so its props are fixed.
 */
function LyricBox({ ref0, verse, cur, sc }: { ref0: EvAddr; verse: number; cur: Syllable | undefined; sc: Score }) {
  const el = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const typed = useRef(cur ? syllableText(cur) : ''); // This is the text in the box (the element is already gone when the box is removed).
  const shown = cur ? syllableText(cur) : '';
  const commit = (joinNext: boolean, extend: boolean) => {
    if (done.current) return;
    done.current = true;
    const text = typed.current.trim();
    if (text !== shown || joinNext || extend)
      run((x) => C.setSyllable(x, ref0, verse, text ? { text, joinNext, extend } : undefined));
  };
  const keep = useRef<() => void>(undefined);
  keep.current = () => commit(false, !!cur?.extend);
  useLayoutEffect(() => {
    if (refocusLyric) {
      refocusLyric = false;
      el.current?.focus();
      el.current?.select();
    }
    return () => queueMicrotask(() => keep.current?.());
  }, []);
  const go = (to: EvAddr | undefined) => {
    if (!to) return;
    refocusLyric = true;
    select([{ t: 'ev', ...to }]);
  };
  return (
    <input
      ref={el}
      type="text"
      defaultValue={shown}
      onInput={(e) => {
        typed.current = (e.target as HTMLInputElement).value;
      }}
      placeholder="Space: next, -: hyphen"
      onBlur={() => commit(false, !!cur?.extend)}
      onKeyDown={(e) => {
        const text = (e.target as HTMLInputElement).value.trim();
        const forward = (join: boolean, extend: boolean) => {
          e.preventDefault();
          if (text) commit(join, extend);
          go(neighborNote(score.peek(), ref0, 1));
        };
        if (e.key === ' ') forward(false, false);
        else if (e.key === '-' && text) forward(true, false);
        else if (e.key === '_' && text) forward(false, true);
        else if (e.key === 'Enter') {
          e.preventDefault();
          commit(false, !!cur?.extend);
          el.current?.blur();
        } else if (e.key === 'Backspace' && !text && !(e.target as HTMLInputElement).value) {
          e.preventDefault();
          go(neighborNote(sc, ref0, -1));
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          el.current?.blur();
        }
      }}
    />
  );
}

/** The controls of one grace note: value, slash, step up and down, a tone more or less (a chord grace note) and remove. */
function GraceControls({ ref0, g, i }: { ref0: EvAddr; g: Grace; i: number }) {
  return (
    <>
      <Pick
        value={g.base}
        opts={[
          [8, '8'],
          [16, '16'],
          [32, '32'],
        ]}
        onChange={(v) => run((x) => C.updateGrace(x, ref0, i, { base: v as 8 | 16 | 32 }))}
      />
      <Tog
        on={!!g.slash}
        title="Slashed (acciaccatura)"
        onClick={() => run((x) => C.updateGrace(x, ref0, i, { slash: !g.slash }))}
      >
        /
      </Tog>
      <button type="button" title="Step up" onClick={() => run((x) => C.transposeGrace(x, ref0, i, 1))}>
        <Ui.up />
      </button>
      <button type="button" title="Step down" onClick={() => run((x) => C.transposeGrace(x, ref0, i, -1))}>
        <Ui.down />
      </button>
      <button
        type="button"
        title="Add a tone a third above (chord)"
        onClick={() => run((x) => C.addGraceTone(x, ref0, i))}
      >
        +
      </button>
      {g.pitches.length > 1 && (
        <button type="button" title="Remove the top tone" onClick={() => run((x) => C.removeGraceTone(x, ref0, i))}>
          −
        </button>
      )}
      <button type="button" title="Remove grace note" onClick={() => run((x) => C.removeGrace(x, ref0, i))}>
        ×
      </button>
    </>
  );
}

/** The grace notes of the selected note (a single one) and the button that adds one. */
function GraceRows({ ref0, note }: { ref0: EvAddr; note: NoteEvent }) {
  const graces = note.graces ?? [];
  const add = () => {
    const top = note.pitches[note.pitches.length - 1].pitch;
    run((x) => C.addGrace(x, ref0, { pitches: [{ pitch: transposeSteps(top, 1) }], base: 8, slash: true }));
  };
  return (
    <>
      {graces.map((g, i) => (
        <Row label={`Grace ${i + 1}`}>
          <GraceControls ref0={ref0} g={g} i={i} />
        </Row>
      ))}
      <div class="btns">
        <button type="button" onClick={add}>
          Add grace
        </button>
      </div>
    </>
  );
}

/** Properties of a selected grace note (clicked on the score): the same controls as in its note's panel. */
function GraceSection({ r }: { r: Extract<Ref, { t: 'grace' }> }) {
  const g = (eventOf(score.value, r) as NoteEvent | undefined)?.graces?.[r.gi];
  if (!g) return null;
  const name = g.pitches
    .map(
      (p) =>
        `${p.pitch.step.toUpperCase()}${'#'.repeat(Math.max(0, p.pitch.alter))}${'b'.repeat(Math.max(0, -p.pitch.alter))}${p.pitch.octave}`,
    )
    .join(' ');
  return (
    <section>
      <Group title="Grace note">
        <div class="ctx">
          m. {measureLabel(score.value, r.mi)} · {name}
        </div>
        <Row label="Grace">
          <GraceControls ref0={r} g={g} i={r.gi} />
        </Row>
      </Group>
    </section>
  );
}

/** What the sections of the event panel share: the selected events (`refs`, `evs`), the notes among them and a note updater. */
interface EvSel {
  sc: Score;
  refs: ReturnType<typeof evRefs>;
  evs: Event[];
  notes: NoteEvent[];
  r0: ReturnType<typeof evRefs>[number];
  beam: ReturnType<typeof beamState>;
  upd: (f: (n: NoteEvent) => void) => boolean;
}

/** The position of the selection and, for a single note, its pitches. */
function EventInfo({ ctx }: { ctx: EvSel }) {
  const { sc, notes, r0 } = ctx;
  const staffName = sc.staves.find((s) => s.id === r0.staff);
  return (
    <Group title="Info">
      <div class="ctx">
        m. {measureLabel(sc, r0.mi)} · {staffName?.name || r0.staff} · voice {r0.voice}
        {notes.length === 1 &&
          notes[0].pitches.map((p) => (
            <span class="chip">
              {p.pitch.step.toUpperCase()}
              {'#'.repeat(Math.max(0, p.pitch.alter))}
              {'b'.repeat(Math.max(0, -p.pitch.alter))}
              {p.pitch.octave}
              {p.tie ? '⁀' : ''}
            </span>
          ))}
      </div>
    </Group>
  );
}

/** Articulations, ornaments, tie, stem, beaming and the other notation switches of the selected events. */
function EventNotation({ ctx }: { ctx: EvSel }) {
  const { sc, refs, evs, notes, r0, beam, upd } = ctx;
  const art = (a: 'accent' | 'marcato' | 'staccato') => notes.length > 0 && notes.every((n) => n.art?.includes(a));
  const flag = (k: 'arpeggio') =>
    upd((n) => {
      if (notes.every((q) => q[k])) delete n[k];
      else n[k] = true;
    });
  return (
    <Group title="Notation">
      <div class="seg fill">
        {notes.length > 0 && (
          <>
            <Tog on={art('accent')} title="Accent" onClick={() => run((x) => C.toggleArticulation(x, refs, 'accent'))}>
              <Ui.accent />
            </Tog>
            <Tog
              on={art('marcato')}
              title="Marcato"
              onClick={() => run((x) => C.toggleArticulation(x, refs, 'marcato'))}
            >
              <Ui.marcato />
            </Tog>
            <Tog
              on={art('staccato')}
              title="Staccato"
              onClick={() => run((x) => C.toggleArticulation(x, refs, 'staccato'))}
            >
              <Ui.staccato />
            </Tog>
          </>
        )}
        <Tog on={evs.every((e) => e.fermata)} title="Fermata" onClick={() => run((x) => C.toggleFermata(x, refs))}>
          <Ui.fermata />
        </Tog>
      </div>
      {notes.length > 0 && (
        <div class="seg fill">
          <Tog on={notes.every((n) => n.pitches.every((p) => p.tie))} title="Tie to next (T)" onClick={tieSelection}>
            <Ui.tie />
          </Tog>
          <Tog on={notes.every((n) => n.arpeggio)} title="Arpeggio (wavy line)" onClick={() => flag('arpeggio')}>
            <Ui.arpeggio />
          </Tog>
          <Tog on={notes.every((n) => n.trill)} title="Trill" onClick={() => run((x) => C.toggleTrill(x, refs))}>
            <Ui.trill />
          </Tog>
        </div>
      )}
      <OrnamentSimilar evs={evs} />
      {notes.some((n) => n.art?.length) && (
        <Row label="Articulation">
          <Pick
            value={same(notes.map((n) => n.artSide))}
            opts={[
              [undefined, 'auto'],
              ['above', 'above'],
              ['below', 'below'],
            ]}
            onChange={(v) =>
              upd((n) => {
                if (v) n.artSide = v;
                else delete n.artSide;
              })
            }
          />
        </Row>
      )}
      <Row label="Dot">
        <Pick
          value={same(evs.map((e) => e.dur.dots))}
          opts={[
            [0, 'none'],
            [1, '·'],
            [2, '··'],
          ]}
          onChange={(n) => chooseDots(n)}
        />
      </Row>
      {evs.some((e) => e.kind === 'rest') && (
        <Row label="Rest">
          <Pick
            value={same(evs.filter((e) => e.kind === 'rest').map((e) => (e as { style: string }).style))}
            opts={[
              ['normal', 'shown'],
              ['hidden', 'hidden'],
            ]}
            onChange={(v) =>
              run((x) =>
                C.updateEvents(x, refs, (e) => {
                  if (e.kind === 'rest' && e.style !== 'measure') e.style = v as 'normal' | 'hidden';
                }),
              )
            }
          />
        </Row>
      )}
      {notes.length > 0 && (
        <>
          <Row label="Stem">
            <Pick
              value={same(notes.map((n) => n.stem))}
              opts={[
                [undefined, 'auto'],
                ['up', 'up', <Ui.up />],
                ['down', 'down', <Ui.down />],
              ]}
              onChange={(v) =>
                upd((n) => {
                  if (v) n.stem = v;
                  else delete n.stem;
                })
              }
            />
          </Row>
          {beam && (
            <Row label="Beam">
              <Dropdown
                value={beam.mode}
                opts={BEAM_MODES.map(([mode, label, title]) => ({
                  value: mode,
                  label,
                  title: mode === 'join' ? (beam.cannotJoin ?? title) : title,
                  disabled: mode === 'join' && !!beam.cannotJoin,
                }))}
                onChange={(mode) => run((x) => C.setBeamMode(x, beam.refs, mode))}
              />
            </Row>
          )}
        </>
      )}
      {evs.length > 0 && evs.every((e) => e.fermata) && (
        <Row label="Fermata">
          <Pick
            value={same(evs.map((e) => e.fermataShape))}
            opts={[
              [undefined, 'normal'],
              ['short', 'short'],
              ['long', 'long'],
            ]}
            onChange={(v) =>
              run((x) =>
                C.setFermataStyle(
                  x,
                  refs,
                  v,
                  evs.every((e) => e.fermataBelow),
                ),
              )
            }
          />
          <Pick
            value={same(evs.map((e) => !!e.fermataBelow))}
            opts={[
              [false, 'above'],
              [true, 'below'],
            ]}
            onChange={(v) => run((x) => C.setFermataStyle(x, refs, evs[0].fermataShape, v))}
          />
        </Row>
      )}
      {notes.length > 0 && (
        <Row label="Ornament">
          <Pick
            value={same(notes.map((n) => n.ornament))}
            opts={[
              [undefined, 'none'],
              ['mordent', 'mordent'],
              ['mordent-inverted', 'inverted mordent'],
              ['turn', 'turn'],
              ['turn-inverted', 'inverted turn'],
            ]}
            onChange={(v) => run((x) => C.setOrnament(x, refs, v))}
          />
        </Row>
      )}
      {notes.length > 0 && notes.every((n) => n.trill) && (
        <Row label="Trill note">
          <Pick
            value={same(notes.map((n) => n.trillAcc))}
            opts={[
              [undefined, 'whole tone'],
              [1, 'sharp'],
              [0, 'natural'],
              [-1, 'flat'],
            ]}
            onChange={(v) => run((x) => C.setTrillAcc(x, refs, v))}
          />
        </Row>
      )}
      {notes.length === 1 && refs.length === 1 && <GraceRows ref0={r0} note={notes[0]} />}
      {notes.length === 1 && refs.length === 1 && <LyricRows ref0={r0} note={notes[0]} sc={sc} />}
    </Group>
  );
}

/** Accidental display and the staff a cross-staff note is shown on. */
function EventPitch({ ctx }: { ctx: EvSel }) {
  const { sc, refs, notes, r0 } = ctx;
  const homeStaffs = new Set(refs.map((r) => r.staff));
  const nonHome = sc.staves.filter((s) => homeStaffs.size === 1 && !homeStaffs.has(s.id));
  return (
    <Group title="Pitch">
      <Row label="Accidental">
        <Pick
          value={same(notes.flatMap((n) => n.pitches.map((p) => p.acc)))}
          opts={[
            [undefined, 'auto'],
            ['force', 'show'],
            ['cautionary', '( )'],
          ]}
          onChange={(v) =>
            run((x) =>
              C.updateNotes(x, refs, (n) => {
                for (const p of n.pitches)
                  if (v) p.acc = v;
                  else delete p.acc;
              }),
            )
          }
        />
      </Row>
      {nonHome.length > 0 && (
        <Row label="Staff">
          <Pick
            value={same(notes.map((n) => n.staff ?? r0.staff))}
            opts={[
              [r0.staff, `own (${r0.staff})`],
              ...nonHome.map((s): [string, string] => [s.id, s.name ? `${s.name} (${s.id})` : s.id]),
            ]}
            onChange={(v) => run((x) => C.setStaffOf(x, refs, v === r0.staff ? undefined : v))}
          />
        </Row>
      )}
    </Group>
  );
}

/** The buttons that act on the selected events: similar, slur, line, tremolo, tuplets, stem flip and delete. */
function EventActions({ ctx }: { ctx: EvSel }) {
  const { refs, beam } = ctx;
  const tremolo = beam?.inTremolo;
  const sorted = [...refs].sort((p, q) => p.idx - q.idx);
  return (
    <Group title="Actions">
      <div class="btns">
        <SimilarButton />
        {refs.length >= 2 && (
          <button type="button" onClick={slurSelection}>
            Slur (S)
          </button>
        )}
        {refs.length === 2 && (
          <button type="button" title="Line between the two notes (they must be in one system)" onClick={lineSelection}>
            Line
          </button>
        )}
        {refs.length === 2 &&
          [1, 2, 3].map((b) => (
            <button
              type="button"
              title={`Two-note tremolo, ${b} beam${b > 1 ? 's' : ''}`}
              onClick={() => run((x) => C.makeTremolo(x, sorted[0], sorted[0].idx, sorted[1].idx, b))}
            >
              Trem {b}
            </button>
          ))}
        {tupletsAround().map((t) => (
          <button type="button" title="Select this tuplet" onClick={() => select([t.ref])}>
            {t.label}
          </button>
        ))}
        {tremolo && (
          <button type="button" title="Remove the tremolo" onClick={() => run((x) => C.ungroup(x, tremolo))}>
            Rem. tremolo
          </button>
        )}
        {flippableVoices() && (
          <button type="button" title="Exchange the two selected voices in the selected measures" onClick={flipVoices}>
            Flip voices
          </button>
        )}
        {[1, 2, 3, 4].map((n) => (
          <button
            type="button"
            title={`Move the selected notes to voice ${n} (Alt+${n}); Shift+click selects voice ${n} here (Alt+Shift+${n})`}
            onClick={(e) => (e.shiftKey ? selectVoice(n) : moveSelectionToVoice(n))}
          >
            To v{n}
          </button>
        ))}
        <button type="button" title="Flip stem (X)" onClick={flipStem}>
          Flip stem
        </button>
        <button type="button" class="danger" onClick={() => deleteSelection()}>
          Delete
        </button>
      </div>
    </Group>
  );
}

/**
 * Properties of the selected notes and rests: position, notation switches, pitch display and actions. Several
 * selected events are edited together.
 */
function EventSection() {
  const sc = score.value;
  const refs = evRefs();
  const evs = refs.map((r) => eventOf(sc, r)).filter((e): e is Event => !!e);
  if (!evs.length) return null;
  const notes = evs.filter((e): e is NoteEvent => e.kind === 'note');
  const upd = (f: (n: NoteEvent) => void) => run((x) => C.updateNotes(x, refs, f));
  const ctx: EvSel = { sc, refs, evs, notes, r0: refs[0], beam: beamState(sc, refs), upd };
  return (
    <section>
      <EventInfo ctx={ctx} />
      <EventNotation ctx={ctx} />
      {notes.length > 0 && <EventPitch ctx={ctx} />}
      <EventActions ctx={ctx} />
    </section>
  );
}

/** The name of a mark for the Properties heading. */
function markLabel(m: { type: string; of?: string; dir?: string }): string {
  return m.type === 'stop'
    ? `End of ${m.of}`
    : m.type === 'ottava'
      ? m.dir === 'up'
        ? '8va'
        : '8vb'
      : m.type[0].toUpperCase() + m.type.slice(1);
}

/** Properties of the selected marks of one type, which are edited together. */
function MarkSection({ r }: { r: Extract<Ref, { t: 'mark' }> }) {
  const m = markOf(score.value, r);
  if (!m) return null;
  // Every selected mark of the same type is edited along with the first.
  const group = selection.value.filter(
    (x): x is Extract<Ref, { t: 'mark' }> => x.t === 'mark' && markOf(score.value, x)?.type === m.type,
  );
  const upd = (patch: Partial<MarkBody>) => run((x) => C.updateMarks(x, group, patch));
  // A property that differs between the selected marks shows as mixed.
  const marks = group.flatMap((x) => markOf(score.value, x) ?? []);
  const shared = (get: (k: MarkBody) => unknown) => same(marks.map(get) as never[]) as never;
  const place = shared((k) => (k as { placement?: string }).placement) as MarkPlacement | undefined | 'mixed';
  return (
    <section>
      <Group title="Properties">
        {m.type === 'dynamic' && (
          <Row label="Dynamic">
            <Dropdown
              value={shared((k) => (k as { text?: string }).text)}
              opts={DYNAMICS.map((d) => ({ value: d, label: d }))}
              onChange={(d) => upd({ text: d } as never)}
            />
          </Row>
        )}
        {m.type === 'text' && (
          <Row label="Text">
            <Txt
              value={shared((k) => (k as { text?: string }).text) === 'mixed' ? '' : m.text}
              placeholder={shared((k) => (k as { text?: string }).text) === 'mixed' ? 'mixed' : undefined}
              onChange={(v) => upd({ text: v } as never)}
            />
          </Row>
        )}
        {m.type === 'tempo' && (
          <>
            <Row label="Beats per min">
              <Num value={m.bpm} min={10} max={600} onChange={(n) => upd({ bpm: n } as never)} />
            </Row>
            <Row label="Beat unit">
              <Pick
                value={m.unit}
                opts={[
                  [1, 'whole'],
                  [2, 'half'],
                  [4, 'quarter'],
                  [8, 'eighth'],
                  [16, '16th'],
                ]}
                onChange={(u) => upd({ unit: u } as never)}
              />
            </Row>
            <Row label="Dotted">
              <Pick
                value={m.dots}
                opts={[
                  [0, 'no'],
                  [1, 'yes'],
                ]}
                onChange={(d) => upd({ dots: d } as never)}
              />
            </Row>
          </>
        )}
        {m.type === 'hairpin' && (
          <Row label="Shape">
            <Pick
              value={shared((k) => (k as { kind?: string }).kind)}
              opts={[
                ['cresc', 'cresc.'],
                ['dim', 'dim.'],
              ]}
              onChange={(k) => upd({ kind: k } as never)}
            />
          </Row>
        )}
        {(m.type === 'dynamic' || m.type === 'hairpin' || m.type === 'text') && (
          <Row label="Placed">
            <Pick
              value={place}
              opts={
                [
                  [undefined, 'auto'],
                  ['above', 'above'],
                  ['below', 'below'],
                  ['between', 'between'],
                ] as [MarkPlacement | undefined, string][]
              }
              onChange={(p) => upd({ placement: p } as never)}
            />
          </Row>
        )}
        {m.type === 'clef' && (
          <Row label="Clef">
            <Dropdown
              value={`${m.clef.sign}${m.clef.line}`}
              opts={CLEF_OPTS.filter(([k]) => k !== 'G2-1').map(([k, , label]) => ({ value: k, label }))}
              onChange={(v) => upd({ clef: { sign: v[0] as 'G', line: Number(v[1]) } } as never)}
            />
          </Row>
        )}
        {group.length === 1 && (
          <Row label="Position">{`measure ${measureLabel(score.value, r.mi)}, ${(m.tick / 3360).toFixed(2).replace(/\.?0+$/, '')} quarters`}</Row>
        )}
      </Group>
      <Group title="Actions">
        <div class="btns">
          <SimilarButton />
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
    </section>
  );
}

/** Properties of the selected lines between notes. */
function LineSection() {
  // Every selected line is edited along with the first.
  const group = selection.value.filter((x): x is Extract<Ref, { t: 'line' }> => x.t === 'line');
  const style = same(
    group.map((g) => (eventOf(score.value, g)?.lineStart?.find((s) => s.id === g.id)?.dashed ? 'dashed' : 'solid')),
  );
  return (
    <section>
      <Group title="Properties">
        <Row label="Style">
          <Pick
            value={style}
            opts={[
              ['solid', 'solid'],
              ['dashed', 'dashed'],
            ]}
            onChange={(v) => run((x) => group.reduce((acc, g) => C.setLineDashed(acc, g, g.id, v === 'dashed'), x))}
          />
        </Row>
      </Group>
      <Group title="Actions">
        <div class="btns">
          <SimilarButton />
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
    </section>
  );
}

/** Properties of the selected ties. */
function TieSection() {
  const group = selection.value.filter((x): x is Extract<Ref, { t: 'tie' }> => x.t === 'tie');
  const side = same(
    group.map((g) => {
      const e = eventOf(score.value, g);
      return e?.kind === 'note' ? e.pitches[g.pi]?.tieSide : undefined;
    }),
  );
  return (
    <section>
      <Group title="Properties">
        <Row label="Side">
          <Pick
            value={side}
            opts={[
              [undefined, 'auto'],
              ['above', 'above'],
              ['below', 'below'],
            ]}
            onChange={(v) => run((x) => C.setTieSide(x, group, v))}
          />
        </Row>
      </Group>
      <Group title="Actions">
        <div class="btns">
          <SimilarButton />
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
    </section>
  );
}

/** Properties of the selected slurs. */
function SlurSection() {
  // Every selected slur is edited along with the first.
  const group = selection.value.filter((x): x is Extract<Ref, { t: 'slur' }> => x.t === 'slur');
  const side = same(group.map((g) => eventOf(score.value, g)?.slurStart?.find((s) => s.id === g.id)?.side));
  const shape = same(
    group.map((g) => (eventOf(score.value, g)?.slurStart?.find((s) => s.id === g.id)?.skewed ? 'skewed' : 'auto')),
  );
  return (
    <section>
      <Group title="Properties">
        <Row label="Side">
          <Pick
            value={side}
            opts={[
              [undefined, 'auto'],
              ['above', 'above'],
              ['below', 'below'],
            ]}
            onChange={(v) => run((x) => group.reduce((acc, g) => C.setSlurSide(acc, g, g.id, v), x))}
          />
        </Row>
        <Row label="Shape">
          <Pick
            value={shape}
            opts={[
              ['auto', 'auto'],
              ['skewed', 'skewed'],
            ]}
            onChange={(v) => run((x) => group.reduce((acc, g) => C.setSlurSkewed(acc, g, g.id, v === 'skewed'), x))}
          />
        </Row>
      </Group>
      <Group title="Actions">
        <div class="btns">
          <SimilarButton />
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
    </section>
  );
}

/** Properties of the selected tuplets: bracket, number or label, and placement. */
function TupletSection({ r }: { r: Extract<Ref, { t: 'tuplet' }> }) {
  const g = tupletOf(score.value, r);
  const [lab, setLab] = useState('');
  if (!g) return null;
  // Every selected tuplet is edited along with the first; differing properties show as mixed.
  const group = selection.value.filter((x): x is Extract<Ref, { t: 'tuplet' }> => x.t === 'tuplet');
  const gs = group.flatMap((x) => tupletOf(score.value, x) ?? []);
  const upd = (p: Parameters<typeof C.updateTuplet>[2]) =>
    run((x) => group.reduce((acc, t) => C.updateTuplet(acc, t, p), x));
  return (
    <section>
      <Group title="Properties">
        <Row label="Bracket">
          <Pick
            value={same(gs.map((t) => t.bracket))}
            opts={[
              [undefined, 'auto'],
              [true, 'yes'],
              [false, 'no'],
            ]}
            onChange={(v) => upd({ bracket: v })}
          />
        </Row>
        <Row label="Number">
          <Pick
            value={same(gs.map((t) => t.number ?? 'actual'))}
            opts={[
              ['actual', 'shown'],
              ['none', 'hidden'],
            ]}
            onChange={(v) => upd({ number: v === 'actual' ? undefined : 'none' })}
          />
        </Row>
        <Row label="Label">
          <Num
            value={g.label ?? g.actual}
            min={1}
            max={99}
            onChange={(n) => {
              setLab(String(n));
              upd({ label: n === g.actual ? undefined : n });
            }}
          />
        </Row>
        <Row label="Placed">
          <Pick
            value={same(gs.map((t) => t.placement))}
            opts={[
              [undefined, 'auto'],
              ['above', 'above'],
              ['below', 'below'],
            ]}
            onChange={(v) => upd({ placement: v })}
          />
        </Row>
      </Group>
      <Group title="Actions">
        <div class="btns">
          <SimilarButton />
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
      <span hidden>{lab}</span>
    </section>
  );
}

/** Whether the selection mixes kinds of elements (notes, marks of different types, slurs, ...). */
function isMixed(sc: Score, sel: Ref[]): boolean {
  const kinds = new Set(sel.map((r) => (r.t === 'mark' ? `mark:${markOf(sc, r)?.type}` : r.t)));
  return kinds.size > 1;
}

/** Tab label for what is selected (null: nothing but measures, so there is no selection tab). */
function selectionLabel(sc: Score, sel: Ref[]): string | null {
  const first = sel[0];
  const evs = sel.filter((r) => r.t === 'ev');
  if (evs.length) return eventTitle(sc, evs);
  if (!first || first.t === 'measure') return null;
  if (isMixed(sc, sel)) return 'Mixed selection';
  if (first.t === 'mark') {
    const m = markOf(sc, first);
    return m ? markLabel(m) : 'Mark';
  }
  if (first.t === 'tuplet') {
    const g = tupletOf(sc, first);
    return g ? `Tuplet ${g.actual}:${g.normal}` : 'Tuplet';
  }
  if (first.t === 'grace') return 'Grace note';
  return first.t === 'slur' ? 'Slur' : first.t === 'line' ? 'Line' : 'Tie';
}

// The tab the user clicked; forgotten whenever the selection changes so the panel follows the selection again.
const userTab = signal<string | null>(null);

selection.subscribe(() => {
  userTab.value = null;
});

/**
 * The Properties panel: shows the section that fits the selection (events, marks, slurs, lines, tuplets, a measure
 * or the score).
 */
export function Properties() {
  const sel = selection.value;
  const sc = score.value;
  const first = sel[0];
  const selLabel = selectionLabel(sc, sel);
  const mi = first ? first.mi : undefined; // Every ref kind carries its measure.
  const tabs: [string, string][] = [];
  if (selLabel) tabs.push(['sel', selLabel]);
  const picked = measureRefs();
  const rangeOnly = picked.length > 1 && sel.every((r) => r.t === 'measure');
  const lo = rangeOnly ? picked[0] : mi;
  const hi = rangeOnly ? picked[picked.length - 1] : mi;
  if (mi !== undefined && mi < sc.measures.length)
    tabs.push([
      'measure',
      hi !== lo
        ? `Measures ${measureLabel(sc, lo ?? 0)}–${measureLabel(sc, hi ?? 0)}`
        : `Measure ${measureLabel(sc, mi)}`,
    ]);
  tabs.push(['score', 'Score']);
  const want = userTab.value;
  const active = tabs.find(([id]) => id === want)?.[0] ?? tabs[0][0];
  return (
    <aside class="properties" aria-label="Properties">
      <div class="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={id === active}
            class={id === active ? 'on' : ''}
            onClick={() => (userTab.value = id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div class="insp-body">
        {active === 'sel' && isMixed(sc, sel) && (
          <section>
            <p class="ctx">Selected elements are of different types; select one type to edit its properties.</p>
          </section>
        )}
        {active === 'sel' && !isMixed(sc, sel) && (
          <>
            {sel.some((r) => r.t === 'ev') && <EventSection />}
            {first?.t === 'mark' && <MarkSection r={first} />}
            {first?.t === 'grace' && <GraceSection r={first} />}
            {first?.t === 'slur' && <SlurSection />}
            {first?.t === 'line' && <LineSection />}
            {first?.t === 'tuplet' && <TupletSection r={first} />}
            {first?.t === 'tie' && <TieSection />}
          </>
        )}
        {active === 'measure' && lo !== undefined && <MeasureSection mi={lo} to={hi ?? lo} />}
        {active === 'score' && <ScoreSection />}
      </div>
    </aside>
  );
}
