// Inspector: edits the properties of whatever is selected (event, mark, slur, tuplet, measure) or of
// the score and its staves when nothing is. Every control calls a command from src/editor/commands.ts through `run`, so
// each change is one undo step and refusals appear as toasts.

import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { Ref } from '../src/editor/addr.ts';
import { eventOf, markOf, tupletOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import type { Event, MarkBody, NoteEvent, Score } from '../src/model.ts';
import { keyAt, timeAt } from '../src/model.ts';
import {
  chooseDots,
  chooseDuration,
  flipStem,
  nudge,
  setAccidentalSel,
  slurSelection,
  tieSelection,
} from './actions.ts';
import { Ui } from './icons.tsx';
import { deleteSelection, evRefs, menu } from './interact.ts';
import { DYNAMICS } from './Palette.tsx';
import { AccidentalButtons, DurationButtons } from './pickers.tsx';
import { run, score, selection, space } from './state.ts';

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="row">
      <span>{label}</span>
      <div class="ctl">{children}</div>
    </div>
  );
}
/** A dropdown over (value, label) pairs; a mixed selection shows an empty entry. */
function Pick<T extends string | number | boolean | undefined>({
  value,
  opts,
  onChange,
}: {
  value: T | 'mixed';
  opts: [T, string][];
  onChange: (v: T) => void;
}) {
  const i = opts.findIndex(([v]) => v === value);
  return (
    <select value={i} onChange={(e) => onChange(opts[Number((e.target as HTMLSelectElement).value)][0])}>
      {i < 0 && <option value={-1}></option>}
      {opts.map(([, l], k) => (
        <option value={k}>{l}</option>
      ))}
    </select>
  );
}
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
const KEYNAME = (n: number) =>
  n === 0 ? 'C / a (no accidentals)' : n > 0 ? `${n} sharp${n > 1 ? 's' : ''}` : `${-n} flat${n < -1 ? 's' : ''}`;

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
        <Row label="Bar numbers">
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

const CLEF_OPTS: [string, { sign: 'G' | 'F' | 'C'; line: number; octave?: number }][] = [
  ['G2', { sign: 'G', line: 2 }],
  ['F4', { sign: 'F', line: 4 }],
  ['C3', { sign: 'C', line: 3 }],
  ['C4', { sign: 'C', line: 4 }],
  ['G2-1', { sign: 'G', line: 2, octave: -1 }],
];
const clefKey = (c: { sign: string; line: number; octave?: number }) => `${c.sign}${c.line}${c.octave ? '-1' : ''}`;

function StavesSection() {
  const s = score.value;
  const conn = C.connections(s);
  const [editing, setEditing] = useState<string | undefined>();
  const [drag, setDrag] = useState<string | undefined>();
  const [over, setOver] = useState<number | undefined>();
  const [inst, setInst] = useState('piano');
  const clefSel = (st: Score['staves'][number]) => (
    <select
      value={clefKey(st.clef)}
      title="Clef"
      onChange={(e) => {
        const c = CLEF_OPTS.find(([k]) => k === (e.target as HTMLSelectElement).value)?.[1];
        if (c) run((x) => C.setStaffClef(x, st.id, c));
      }}
    >
      <option value="G2">Treble</option>
      <option value="F4">Bass</option>
      <option value="C3">Alto</option>
      <option value="C4">Tenor</option>
      <option value="G2-1">Treble 8vb</option>
    </select>
  );
  const openMenu = (x: number, y: number, st: Score['staves'][number], i: number) => {
    menu.value = {
      x,
      y,
      items: [
        { label: 'Insert above', run: () => run((c) => C.addInstrument(c, inst, i)) },
        { label: 'Insert below', run: () => run((c) => C.addInstrument(c, inst, i + 1)) },
        { label: 'Duplicate', run: () => run((c) => C.duplicateStaff(c, st.id)) },
        { label: 'Rename', run: () => setEditing(st.id) },
        { sep: true, label: '', run: () => undefined },
        {
          label: 'Remove staff',
          danger: true,
          run: () => {
            if (s.staves.length > 1) run((c) => C.removeStaff(c, st.id));
          },
        },
      ],
    };
  };
  return (
    <Group title="Staves">
      <div class="staves">
        {s.staves.map((st, i) => (
          <>
            <div
              class={`staffrow${drag === st.id ? ' dragging' : ''}${over === i && drag && drag !== st.id ? ' dropto' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, st, i);
              }}
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
              {editing === st.id ? (
                <input
                  type="text"
                  autofocus
                  value={st.name ?? ''}
                  placeholder={st.id}
                  onBlur={(e) => {
                    setEditing(undefined);
                    const v = (e.target as HTMLInputElement).value;
                    if (v !== (st.name ?? '')) run((x) => C.setStaffName(x, st.id, v));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    else if (e.key === 'Escape') {
                      setEditing(undefined);
                    }
                  }}
                />
              ) : (
                <span
                  class={`sname${st.name ? '' : ' empty'}`}
                  title="Click to rename (the name is kept in the file; not drawn yet)"
                  onClick={() => setEditing(st.id)}
                >
                  {st.name || st.id}
                </span>
              )}
              {clefSel(st)}
              <button
                type="button"
                class="mini"
                title="Staff actions (or right-click the row)"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openMenu(r.left, r.bottom + 2, st, i);
                }}
              >
                ⋯
              </button>
            </div>
            {i < s.staves.length - 1 && (
              <div class="joinrow">
                <span>joined by</span>
                <Pick
                  value={conn[i]}
                  opts={[
                    [undefined, 'nothing'],
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
          <select
            value={inst}
            title="Instrument to add (also used by Insert above/below)"
            onChange={(e) => setInst((e.target as HTMLSelectElement).value)}
          >
            {C.INSTRUMENTS.map((p) => (
              <option value={p.key}>{p.label}</option>
            ))}
          </select>
          <button type="button" onClick={() => run((x) => C.addInstrument(x, inst))}>
            Add
          </button>
        </div>
      </div>
    </Group>
  );
}

function MeasureSection({ mi }: { mi: number }) {
  const s = score.value;
  const m = s.measures[mi];
  if (!m) return null;
  const ts = timeAt(s, mi);
  return (
    <section>
      <Group title="Signatures">
        <Row label="Time">
          <Num
            value={ts.beats}
            min={1}
            max={32}
            w="3.5em"
            onChange={(n) => run((x) => C.setTimeSig(x, mi, { ...ts, beats: n }))}
          />{' '}
          /{' '}
          <select
            value={ts.beatType}
            onChange={(e) =>
              run((x) => C.setTimeSig(x, mi, { ...ts, beatType: Number((e.target as HTMLSelectElement).value) }))
            }
          >
            {[1, 2, 4, 8, 16].map((b) => (
              <option>{b}</option>
            ))}
          </select>
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
        <Row label="Key">
          <select
            value={keyAt(s, mi)}
            onChange={(e) => run((x) => C.setKeySig(x, mi, Number((e.target as HTMLSelectElement).value)))}
          >
            {KEYS.map((k) => (
              <option value={k}>{KEYNAME(k)}</option>
            ))}
          </select>
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
      <Group title="Layout">
        <Row label="Barline">
          <Pick
            value={m.barline ?? 'single'}
            opts={[
              ['single', '│'],
              ['double', '║'],
              ['final', '𝄂'],
            ]}
            onChange={(v) => run((x) => C.setBarline(x, mi, v))}
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
      <Group title="Actions">
        <div class="btns">
          <button type="button" onClick={() => run((x) => C.insertMeasures(x, mi))}>
            Insert before
          </button>
          <button type="button" onClick={() => run((x) => C.insertMeasures(x, mi + 1))}>
            Insert after
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
function Group({ title, children }: { id?: string; title: string; children: preact.ComponentChildren }) {
  return (
    <div class="sec">
      <div class="sh">{title}</div>
      {children}
    </div>
  );
}
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

function eventTitle(sc: Score, refs: Ref[]): string {
  const evs = refs.map((r) => eventOf(sc, r)).filter((e): e is Event => !!e);
  if (evs.length !== 1) return `${evs.length} events`;
  return evs[0].kind === 'note' ? (evs[0].pitches.length > 1 ? 'Chord' : 'Note') : 'Rest';
}

function EventSection() {
  const sc = score.value;
  const refs = evRefs();
  const evs = refs.map((r) => eventOf(sc, r)).filter((e): e is Event => !!e);
  if (!evs.length) return null;
  const notes = evs.filter((e): e is NoteEvent => e.kind === 'note');
  const r0 = refs[0];
  const homeStaffs = new Set(refs.map((r) => r.staff));
  const nonHome = sc.staves.filter((s) => homeStaffs.size === 1 && !homeStaffs.has(s.id));
  const art = (a: 'accent' | 'marcato' | 'staccato') => notes.length > 0 && notes.every((n) => n.art?.includes(a));
  const staffName = sc.staves.find((s) => s.id === r0.staff);
  const sorted = [...refs].sort((p, q) => p.idx - q.idx);
  const upd = (f: (n: NoteEvent) => void) => run((x) => C.updateNotes(x, refs, f));
  const flag = (k: 'arpeggio' | 'noBeam', all: boolean) =>
    upd((n) => {
      if (all ? notes.every((q) => q[k]) : notes.some((q) => q[k])) delete n[k];
      else n[k] = true;
    });
  return (
    <section>
      <Group title="Info">
        <div class="ctx">
          m. {r0.mi + 1} · {staffName?.name || r0.staff} · voice {r0.voice}
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
      <Group id="rhythm" title="Rhythm">
        <div class="seg fill big">
          <DurationButtons value={same(evs.map((e) => e.dur.base))} onPick={chooseDuration} />
        </div>
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
                ['normal', 'rest shown'],
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
      </Group>
      {notes.length > 0 && (
        <>
          <Group id="pitch" title="Pitch">
            <div class="seg fill">
              <button type="button" title="Semitone up (↑)" onClick={() => nudge(1)}>
                <Ui.up /> Semitone
              </button>
              <button type="button" title="Octave up (Ctrl ↑)" onClick={() => nudge(12)}>
                <Ui.up /> Octave
              </button>
              <button type="button" title="Letter name up (Shift ↑)" onClick={() => nudge(undefined, 1)}>
                <Ui.up /> Step
              </button>
            </div>
            <div class="seg fill">
              <button type="button" title="Semitone down (↓)" onClick={() => nudge(-1)}>
                <Ui.down /> Semitone
              </button>
              <button type="button" title="Octave down (Ctrl ↓)" onClick={() => nudge(-12)}>
                <Ui.down /> Octave
              </button>
              <button type="button" title="Letter name down (Shift ↓)" onClick={() => nudge(undefined, -1)}>
                <Ui.down /> Step
              </button>
            </div>
            <div class="seg fill big">
              <AccidentalButtons
                value={same(notes.flatMap((n) => n.pitches.map((p) => p.pitch.alter)))}
                onPick={setAccidentalSel}
              />
            </div>
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
          <Group id="notation" title="Notation">
            <div class="seg fill">
              <Tog
                on={art('accent')}
                title="Accent"
                onClick={() => run((x) => C.toggleArticulation(x, refs, 'accent'))}
              >
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
              <Tog
                on={notes.every((n) => n.pitches.every((p) => p.tie))}
                title="Tie to next (T)"
                onClick={tieSelection}
              >
                <Ui.tie />
              </Tog>
              <Tog
                on={notes.every((n) => n.arpeggio)}
                title="Arpeggio (wavy line)"
                onClick={() => flag('arpeggio', true)}
              >
                <Ui.arpeggio />
              </Tog>
              <Tog on={notes.some((n) => n.noBeam)} title="Do not beam" onClick={() => flag('noBeam', false)}>
                <Ui.noBeam />
              </Tog>
            </div>
            <Row label="Stem">
              <Pick
                value={same(notes.map((n) => n.stem))}
                opts={[
                  [undefined, 'auto'],
                  ['up', '↑'],
                  ['down', '↓'],
                ]}
                onChange={(v) =>
                  upd((n) => {
                    if (v) n.stem = v;
                    else delete n.stem;
                  })
                }
              />
            </Row>
            {notes.some((n) => n.art?.length) && (
              <Row label="Articulation">
                <Pick
                  value={same(notes.map((n) => n.artSide))}
                  opts={[
                    [undefined, 'auto'],
                    ['above', '▲'],
                    ['below', '▼'],
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
          </Group>
        </>
      )}
      <Group title="Actions">
        <div class="btns">
          {refs.length >= 2 && (
            <button type="button" onClick={slurSelection}>
              Slur (S)
            </button>
          )}
          {refs.length >= 2 && (
            <button
              type="button"
              title="Beam the selected notes together"
              onClick={() => run((x) => C.makeBeam(x, sorted[0], sorted[0].idx, sorted[sorted.length - 1].idx))}
            >
              Beam
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
          <button
            type="button"
            title="Dissolve the beam group or tremolo"
            onClick={() =>
              run((x) =>
                refs.reduce((s2, r) => {
                  try {
                    return C.ungroup(s2, r);
                  } catch {
                    return s2;
                  }
                }, x),
              )
            }
          >
            Ungroup
          </button>
          <button type="button" onClick={flipStem}>
            Flip stem (X)
          </button>
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
    </section>
  );
}

function markLabel(m: { type: string; of?: string; dir?: string }): string {
  return m.type === 'stop'
    ? `End of ${m.of}`
    : m.type === 'ottava'
      ? m.dir === 'up'
        ? '8va'
        : '8vb'
      : m.type[0].toUpperCase() + m.type.slice(1);
}

function MarkSection({ r }: { r: Extract<Ref, { t: 'mark' }> }) {
  const m = markOf(score.value, r);
  if (!m) return null;
  const upd = (patch: Partial<MarkBody>) => run((x) => C.updateMark(x, r, patch));
  const place = (m as { placement?: 'above' | 'below' }).placement;
  return (
    <section>
      <Group title="Properties">
        {m.type === 'dynamic' && (
          <Row label="Dynamic">
            <select value={m.text} onChange={(e) => upd({ text: (e.target as HTMLSelectElement).value } as never)}>
              {DYNAMICS.map((d) => (
                <option>{d}</option>
              ))}
            </select>
          </Row>
        )}
        {m.type === 'text' && (
          <Row label="Text">
            <Txt value={m.text} onChange={(v) => upd({ text: v } as never)} />
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
                  [2, 'half'],
                  [4, 'quarter'],
                  [8, 'eighth'],
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
              value={m.kind}
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
              opts={[
                [undefined, 'auto'],
                ['above', 'above'],
                ['below', 'below'],
              ]}
              onChange={(p) => upd({ placement: p } as never)}
            />
          </Row>
        )}
        {m.type === 'clef' && (
          <Row label="Clef">
            <select
              value={`${m.clef.sign}${m.clef.line}`}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                upd({ clef: { sign: v[0] as 'G', line: Number(v[1]) } } as never);
              }}
            >
              <option value="G2">Treble</option>
              <option value="F4">Bass</option>
              <option value="C3">Alto</option>
              <option value="C4">Tenor</option>
            </select>
          </Row>
        )}
        <Row label="Position">{`measure ${r.mi + 1}, ${(m.tick / 3360).toFixed(2).replace(/\.?0+$/, '')} quarters`}</Row>
      </Group>
      <Group title="Actions">
        <div class="btns">
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete
          </button>
        </div>
      </Group>
    </section>
  );
}

function SlurSection({ r }: { r: Extract<Ref, { t: 'slur' }> }) {
  const e = eventOf(score.value, r);
  const sl = e?.slurStart?.find((s) => s.id === r.id);
  return (
    <section>
      <Group title="Properties">
        <Row label="Side">
          <Pick
            value={sl?.side}
            opts={[
              [undefined, 'auto'],
              ['above', 'above'],
              ['below', 'below'],
            ]}
            onChange={(v) => run((x) => C.setSlurSide(x, r, r.id, v))}
          />
        </Row>
      </Group>
      <Group title="Actions">
        <div class="btns">
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Delete slur
          </button>
        </div>
      </Group>
    </section>
  );
}

function TupletSection({ r }: { r: Extract<Ref, { t: 'tuplet' }> }) {
  const g = tupletOf(score.value, r);
  const [lab, setLab] = useState('');
  if (!g) return null;
  const upd = (p: Parameters<typeof C.updateTuplet>[2]) => run((x) => C.updateTuplet(x, r, p));
  return (
    <section>
      <Group title="Properties">
        <Row label="Bracket">
          <Pick
            value={g.bracket}
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
            value={g.number ?? 'actual'}
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
            value={g.placement}
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
          <button type="button" class="danger" onClick={() => deleteSelection()}>
            Remove tuplet
          </button>
        </div>
      </Group>
      <span hidden>{lab}</span>
    </section>
  );
}

/** Tab label for what is selected (null: nothing but measures, so there is no selection tab). */
function selectionLabel(sc: Score, sel: Ref[]): string | null {
  const first = sel[0];
  const evs = sel.filter((r) => r.t === 'ev');
  if (evs.length) return eventTitle(sc, evs);
  if (!first || first.t === 'measure') return null;
  if (first.t === 'mark') {
    const m = markOf(sc, first);
    return m ? markLabel(m) : 'Mark';
  }
  if (first.t === 'tuplet') {
    const g = tupletOf(sc, first);
    return g ? `Tuplet ${g.actual}:${g.normal}` : 'Tuplet';
  }
  return first.t === 'slur' ? 'Slur' : 'Tie';
}

// The tab the user clicked; forgotten whenever the selection changes so the panel follows the selection again.
const userTab = signal<string | null>(null);
selection.subscribe(() => {
  userTab.value = null;
});

export function Inspector() {
  const sel = selection.value;
  const sc = score.value;
  const first = sel[0];
  const selLabel = selectionLabel(sc, sel);
  const mi = first ? first.mi : undefined; // every ref kind carries its measure
  const tabs: [string, string][] = [];
  if (selLabel) tabs.push(['sel', selLabel]);
  if (mi !== undefined && mi < sc.measures.length) tabs.push(['measure', `Measure ${mi + 1}`]);
  tabs.push(['score', 'Score']);
  const want = userTab.value;
  const active = tabs.find(([id]) => id === want)?.[0] ?? tabs[0][0];
  return (
    <aside class="inspector" aria-label="Properties">
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
        {active === 'sel' && (
          <>
            {sel.some((r) => r.t === 'ev') && <EventSection />}
            {first?.t === 'mark' && <MarkSection r={first} />}
            {first?.t === 'slur' && <SlurSection r={first} />}
            {first?.t === 'tuplet' && <TupletSection r={first} />}
            {first?.t === 'tie' && (
              <section>
                <Group title="Actions">
                  <div class="btns">
                    <button type="button" class="danger" onClick={() => deleteSelection()}>
                      Remove tie
                    </button>
                  </div>
                </Group>
              </section>
            )}
          </>
        )}
        {active === 'measure' && mi !== undefined && <MeasureSection mi={mi} />}
        {active === 'score' && <ScoreSection />}
      </div>
    </aside>
  );
}
