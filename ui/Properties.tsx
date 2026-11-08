// Properties panel: edits the properties of whatever is selected (event, mark, slur, tuplet, measure) or of
// the score and its staves when nothing is. Every control calls a command from src/editor/commands.ts through `run`, so
// each change is one undo step and refusals appear as toasts.

import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { BeamMode } from '../src/beams.ts';
import { beamModes, beatTicks, canJoin } from '../src/beams.ts';
import type { EvAddr, Ref } from '../src/editor/addr.ts';
import { eventOf, markOf, tupletOf, voiceOf } from '../src/editor/addr.ts';
import * as C from '../src/editor/commands.ts';
import { transposeSteps } from '../src/editor/context.ts';
import type { Event, MarkBody, MarkPlacement, NoteEvent, Score } from '../src/model.ts';
import { flattenVoice, keyAt, timeAt } from '../src/model.ts';
import { chooseDots, flipStem, lineSelection, slurSelection, tieSelection } from './actions.ts';
import { Dropdown } from './Dropdown.tsx';
import { Ui } from './icons.tsx';
import { deleteSelection, evRefs, select, selectSimilar, tupletsAround } from './interact.ts';
import { DYNAMICS } from './Palette.tsx';
import { run, score, selection, space } from './state.ts';

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
];

const clefKey = (c: { sign: string; line: number; octave?: number }) => `${c.sign}${c.line}${c.octave ? '-1' : ''}`;

function StavesSection() {
  const s = score.value;
  const conn = C.connections(s);
  const [editing, setEditing] = useState<string | undefined>();
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
                <button type="button" onClick={() => setEditing(st.id)}>
                  Rename
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
          <Dropdown
            value={ts.beatType}
            opts={[1, 2, 4, 8, 16].map((b) => ({ value: b, label: String(b) }))}
            onChange={(b) => run((x) => C.setTimeSig(x, mi, { ...ts, beatType: b }))}
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
        <Row label="Key">
          <Dropdown
            value={keyAt(s, mi)}
            opts={KEYS.map((k) => ({ value: k, label: KEYNAME(k) }))}
            onChange={(k) => run((x) => C.setKeySig(x, mi, k))}
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
      <Group title="Layout">
        <Row label="Barline">
          <Pick
            value={m.barline ?? 'single'}
            opts={[
              ['single', 'single', <Ui.barSingle />],
              ['double', 'double', <Ui.barDouble />],
              ['final', 'final', <Ui.barFinal />],
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
            onClick={() => run((x) => C.insertMeasures(x, mi + 1))}
          >
            Add after
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
    <button type="button" title="Select similar (Ctrl+Shift+A)" onClick={selectSimilar}>
      Sel. similar
    </button>
  );
}

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

const BEAM_MODES: [BeamMode, string, string][] = [
  ['auto', 'auto', 'The automatic rules decide whether this note is beamed to the previous one'],
  ['none', 'none', 'Not beamed to either neighbour'],
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
      m = beamModes(v, beatTicks(timeAt(sc, r.mi)));
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

function eventTitle(sc: Score, refs: Ref[]): string {
  const evs = refs.map((r) => eventOf(sc, r)).filter((e): e is Event => !!e);
  if (evs.length !== 1) return `${evs.length} events`;
  return evs[0].kind === 'note' ? (evs[0].pitches.length > 1 ? 'Chord' : 'Note') : 'Rest';
}

/** The grace notes of a single selected note: value, slash, step up/down and removal for each, and a button to add one. */
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
          <button type="button" title="Remove grace note" onClick={() => run((x) => C.removeGrace(x, ref0, i))}>
            ×
          </button>
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
  const flag = (k: 'arpeggio') =>
    upd((n) => {
      if (notes.every((q) => q[k])) delete n[k];
      else n[k] = true;
    });
  const beam = beamState(sc, refs);
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
      <Group id="notation" title="Notation">
        <div class="seg fill">
          {notes.length > 0 && (
            <>
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
      </Group>
      {notes.length > 0 && (
        <Group id="pitch" title="Pitch">
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
      )}
      <Group title="Actions">
        <div class="btns">
          <SimilarButton />
          {refs.length >= 2 && (
            <button type="button" onClick={slurSelection}>
              Slur (S)
            </button>
          )}
          {refs.length === 2 && (
            <button
              type="button"
              title="Line between the two notes (they must be in one system)"
              onClick={lineSelection}
            >
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
          {beam?.inTremolo && (
            <button type="button" title="Remove the tremolo" onClick={() => run((x) => C.ungroup(x, beam.inTremolo))}>
              No tremolo
            </button>
          )}
          {tupletsAround().map((t) => (
            <button type="button" title="Select this tuplet" onClick={() => select([t.ref])}>
              {t.label}
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
          <Row label="Position">{`measure ${r.mi + 1}, ${(m.tick / 3360).toFixed(2).replace(/\.?0+$/, '')} quarters`}</Row>
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

function SlurSection() {
  // Every selected slur is edited along with the first.
  const group = selection.value.filter((x): x is Extract<Ref, { t: 'slur' }> => x.t === 'slur');
  const side = same(group.map((g) => eventOf(score.value, g)?.slurStart?.find((s) => s.id === g.id)?.side));
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
  const kinds = new Set(
    sel.map((r) =>
      r.t === 'mark' ? `mark:${markOf(sc, r)?.type}` : r.t === 'ev' ? `ev:${eventOf(sc, r)?.kind}` : r.t,
    ),
  );
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
  return first.t === 'slur' ? 'Slur' : first.t === 'line' ? 'Line' : 'Tie';
}

// The tab the user clicked; forgotten whenever the selection changes so the panel follows the selection again.
const userTab = signal<string | null>(null);

selection.subscribe(() => {
  userTab.value = null;
});

export function Properties() {
  const sel = selection.value;
  const sc = score.value;
  const first = sel[0];
  const selLabel = selectionLabel(sc, sel);
  const mi = first ? first.mi : undefined; // Every ref kind carries its measure.
  const tabs: [string, string][] = [];
  if (selLabel) tabs.push(['sel', selLabel]);
  if (mi !== undefined && mi < sc.measures.length) tabs.push(['measure', `Measure ${mi + 1}`]);
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
            {first?.t === 'slur' && <SlurSection />}
            {first?.t === 'line' && <LineSection />}
            {first?.t === 'tuplet' && <TupletSection r={first} />}
            {first?.t === 'tie' && (
              <section>
                <Group title="Actions">
                  <div class="btns">
                    <SimilarButton />
                    <button type="button" class="danger" onClick={() => deleteSelection()}>
                      Delete
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
