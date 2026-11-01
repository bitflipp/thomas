// Inspector: edits the properties of whatever is selected (event, mark, slur, tuplet, measure) or of
// the score and its staves when nothing is. Every control calls a command from src/editor/commands.ts through `run`, so
// each change is one undo step and refusals appear as toasts.
import { useState } from 'preact/hooks';
import { timeAt, keyAt, flattenVoice, type Event, type MarkBody, type NoteEvent } from '../src/model.ts';
import * as C from '../src/editor/commands.ts';
import { eventOf, markOf, tupletOf, voiceOf, type Ref } from '../src/editor/addr.ts';
import { score, selection, run, space, dur, dots } from './state.ts';
import { chooseDuration, chooseDots, nudge, flipStem, slurSelection, tieSelection } from './actions.ts';
import { deleteSelection, evRefs } from './interact.ts';
import { DYNAMICS } from './Palette.tsx';

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) { return <div class="row"><span>{label}</span><div class="ctl">{children}</div></div>; }
function Seg<T extends string | number | boolean | undefined>({ value, opts, onChange }: { value: T | 'mixed'; opts: [T, string][]; onChange: (v: T) => void }) {
  return <div class="seg">{opts.map(([v, l]) => <button aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>;
}
function Num({ value, min, max, step, onChange, w }: { value: number; min?: number; max?: number; step?: number; onChange: (n: number) => void; w?: string }) {
  return <input type="number" style={{ width: w ?? '4.5em' }} min={min} max={max} step={step} value={value} onChange={(e) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) onChange(n); }} />;
}
function Txt({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange((e.target as HTMLInputElement).value)} />;
}
const same = <T,>(xs: T[]): T | 'mixed' => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : 'mixed');
const KEYS = Array.from({ length: 15 }, (_, i) => i - 7);
const KEYNAME = (n: number) => (n === 0 ? 'C / a (no accidentals)' : n > 0 ? `${n} sharp${n > 1 ? 's' : ''}` : `${-n} flat${n < -1 ? 's' : ''}`);

function ScoreSection() {
  const s = score.value;
  return (
    <section>
      <h3>Score</h3>
      <Row label="Title"><Txt value={s.meta.title ?? ''} onChange={(v) => run((x) => C.setMeta(x, { title: v }))} /></Row>
      <Row label="Subtitle"><Txt value={s.meta.subtitle ?? ''} onChange={(v) => run((x) => C.setMeta(x, { subtitle: v }))} /></Row>
      <Row label="Composer"><Txt value={s.meta.composer ?? ''} onChange={(v) => run((x) => C.setMeta(x, { composer: v }))} /></Row>
      <Row label="Footer"><Txt value={s.meta.rights ?? ''} onChange={(v) => run((x) => C.setMeta(x, { rights: v }))} /></Row>
      <Row label="Staff space"><Num value={space.value ?? s.page.staffSpace} step={0.05} min={0.8} max={4} onChange={(n) => run((x) => C.setPage(x, { staffSpace: n }))} /> mm</Row>
      <Row label="Margin"><Num value={s.page.margin} step={1} min={0} max={40} onChange={(n) => run((x) => C.setPage(x, { margin: n }))} /> mm</Row>
      <Row label="Page"><Num value={s.page.width} min={50} max={600} w="4.5em" onChange={(n) => run((x) => C.setPage(x, { width: n }))} /> × <Num value={s.page.height} min={50} max={900} onChange={(n) => run((x) => C.setPage(x, { height: n }))} /> mm</Row>
      <Row label="Bar numbers"><Seg value={s.page.measureNumbers ?? 'system'} opts={[['system', 'per system'], ['all', 'all'], ['none', 'none']]} onChange={(v) => run((x) => C.setMeasureNumbers(x, v === 'system' ? undefined : (v as 'all' | 'none')))} /></Row>
      <StavesSection />
    </section>
  );
}

const CLEF_OPTS: [string, { sign: 'G' | 'F' | 'C'; line: number; octave?: number }][] = [
  ['G2', { sign: 'G', line: 2 }], ['F4', { sign: 'F', line: 4 }], ['C3', { sign: 'C', line: 3 }], ['C4', { sign: 'C', line: 4 }], ['G2-1', { sign: 'G', line: 2, octave: -1 }],
];
const clefKey = (c: { sign: string; line: number; octave?: number }) => `${c.sign}${c.line}${c.octave ? '-1' : ''}`;

function StavesSection() {
  const s = score.value;
  const conn = C.connections(s);
  const [newClef, setNewClef] = useState('G2');
  return (
    <section class="staves">
      <h3>Staves</h3>
      {s.staves.map((st, i) => (
        <>
          <div class="staffrow">
            <input type="text" value={st.name ?? ''} placeholder={st.id} title="Instrument name (kept in the file; not drawn yet)" onChange={(e) => run((x) => C.setStaffName(x, st.id, (e.target as HTMLInputElement).value))} />
            <select value={clefKey(st.clef)} title="Clef" onChange={(e) => { const c = CLEF_OPTS.find(([k]) => k === (e.target as HTMLSelectElement).value)?.[1]; if (c) run((x) => C.setStaffClef(x, st.id, c)); }}>
              <option value="G2">Treble</option><option value="F4">Bass</option><option value="C3">Alto</option><option value="C4">Tenor</option><option value="G2-1">Treble 8vb</option>
            </select>
            <button class="mini" disabled={i === 0} title="Move up" onClick={() => run((x) => C.moveStaff(x, st.id, -1))}>↑</button>
            <button class="mini" disabled={i === s.staves.length - 1} title="Move down" onClick={() => run((x) => C.moveStaff(x, st.id, 1))}>↓</button>
            <button class="mini danger" disabled={s.staves.length === 1} title="Remove this staff and everything on it" onClick={() => { if (confirm(`Remove staff "${st.name || st.id}" and all its music?`)) run((x) => C.removeStaff(x, st.id)); }}>×</button>
          </div>
          {i < s.staves.length - 1 && (
            <div class="joinrow">
              <span>joined by</span>
              <Seg value={conn[i]} opts={[[undefined, 'nothing'], ['brace', 'brace'], ['bracket', 'bracket']]} onChange={(k) => run((x) => C.setConnection(x, i, k))} />
            </div>
          )}
        </>
      ))}
      <div class="btns">
        <select value={newClef} onChange={(e) => setNewClef((e.target as HTMLSelectElement).value)}><option value="G2">Treble</option><option value="F4">Bass</option><option value="C3">Alto</option><option value="C4">Tenor</option></select>
        <button onClick={() => { const c = CLEF_OPTS.find(([k]) => k === newClef)![1]; run((x) => C.addStaff(x, { clef: c })); }}>Add staff</button>
      </div>
    </section>
  );
}

function MeasureSection({ mi }: { mi: number }) {
  const s = score.value, m = s.measures[mi];
  if (!m) return null;
  const ts = timeAt(s, mi);
  return (
    <section>
      <h3>Measure {mi + 1}</h3>
      <Row label="Time"><Num value={ts.beats} min={1} max={32} w="3.5em" onChange={(n) => run((x) => C.setTimeSig(x, mi, { ...ts, beats: n }))} /> / <select value={ts.beatType} onChange={(e) => run((x) => C.setTimeSig(x, mi, { ...ts, beatType: Number((e.target as HTMLSelectElement).value) }))}>{[1, 2, 4, 8, 16].map((b) => <option>{b}</option>)}</select>
        {mi > 0 && m.time && <button class="mini" title="Inherit from the previous measure" onClick={() => run((x) => C.setTimeSig(x, mi, undefined))}>×</button>}</Row>
      <Row label="Key"><select value={keyAt(s, mi)} onChange={(e) => run((x) => C.setKeySig(x, mi, Number((e.target as HTMLSelectElement).value)))}>{KEYS.map((k) => <option value={k}>{KEYNAME(k)}</option>)}</select>
        {mi > 0 && m.key !== undefined && <button class="mini" title="Inherit from the previous measure" onClick={() => run((x) => C.setKeySig(x, mi, undefined))}>×</button>}</Row>
      <Row label="Barline"><Seg value={m.barline ?? 'single'} opts={[['single', '│'], ['double', '║'], ['final', '𝄂']]} onChange={(v) => run((x) => C.setBarline(x, mi, v))} /></Row>
      <Row label="Break before"><Seg value={m.breakBefore ?? 'none'} opts={[['none', 'auto'], ['system', 'system'], ['page', 'page']]} onChange={(v) => run((x) => C.setBreak(x, mi, v === 'none' ? undefined : (v as 'system' | 'page')))} /></Row>
      <div class="btns">
        <button onClick={() => run((x) => C.insertMeasures(x, mi))}>Insert before</button>
        <button onClick={() => run((x) => C.insertMeasures(x, mi + 1))}>Insert after</button>
        <button class="danger" onClick={() => deleteSelection()}>Delete</button>
      </div>
    </section>
  );
}

function EventSection() {
  const sc = score.value;
  const refs = evRefs();
  const evs = refs.map((r) => eventOf(sc, r)).filter((e): e is Event => !!e);
  if (!evs.length) return null;
  const notes = evs.filter((e): e is NoteEvent => e.kind === 'note');
  const title = evs.length === 1 ? (evs[0].kind === 'note' ? (notes[0].pitches.length > 1 ? 'Chord' : 'Note') : 'Rest') : `${evs.length} events`;
  const r0 = refs[0];
  const homeStaffs = new Set(refs.map((r) => r.staff));
  const nonHome = sc.staves.filter((s) => homeStaffs.size === 1 && !homeStaffs.has(s.id));
  const art = (a: 'accent' | 'marcato' | 'staccato') => notes.length > 0 && notes.every((n) => n.art?.includes(a));
  return (
    <section>
      <h3>{title}</h3>
      <Row label="Duration">
        <div class="seg">{([1, 2, 4, 8, 16, 32, 64] as const).map((b) => <button aria-pressed={same(evs.map((e) => e.dur.base)) === b} onClick={() => chooseDuration(b)}>{b === 1 ? '1' : `1/${b}`}</button>)}</div>
      </Row>
      <Row label="Dots"><Seg value={same(evs.map((e) => e.dur.dots))} opts={[[0, 'none'], [1, '·'], [2, '··']]} onChange={(n) => chooseDots(n)} /></Row>
      {notes.length > 0 && <>
        <Row label="Pitch">
          <button title="Semitone up (↑)" onClick={() => nudge(1)}>♯↑</button><button title="Semitone down (↓)" onClick={() => nudge(-1)}>♭↓</button>
          <button title="Octave up (Ctrl ↑)" onClick={() => nudge(12)}>8va↑</button><button title="Octave down (Ctrl ↓)" onClick={() => nudge(-12)}>8vb↓</button>
          <button title="Letter name up (Shift ↑)" onClick={() => nudge(undefined, 1)}>step↑</button><button title="Letter name down (Shift ↓)" onClick={() => nudge(undefined, -1)}>step↓</button>
        </Row>
        {notes.length === 1 && <Row label="Notes">{notes[0].pitches.map((p, i) => <span class="chip">{p.pitch.step.toUpperCase()}{'#'.repeat(Math.max(0, p.pitch.alter))}{'b'.repeat(Math.max(0, -p.pitch.alter))}{p.pitch.octave}{p.tie ? '⁀' : ''}{i < notes[0].pitches.length - 1 ? '' : ''}</span>)}</Row>}
        <Row label="Accidental"><Seg value={same(notes.flatMap((n) => n.pitches.map((p) => p.acc)))} opts={[[undefined, 'auto'], ['force', 'show'], ['cautionary', '( )']]} onChange={(v) => run((x) => C.updateNotes(x, refs, (n) => { for (const p of n.pitches) if (v) p.acc = v; else delete p.acc; }))} /></Row>
        <Row label="Tie"><button aria-pressed={notes.every((n) => n.pitches.every((p) => p.tie))} onClick={tieSelection}>Tie to next (T)</button></Row>
        <Row label="Stem"><Seg value={same(notes.map((n) => n.stem))} opts={[[undefined, 'auto'], ['up', '↑'], ['down', '↓']]} onChange={(v) => run((x) => C.updateNotes(x, refs, (n) => { if (v) n.stem = v; else delete n.stem; }))} /></Row>
        <Row label="Articulation">
          <button aria-pressed={art('accent')} onClick={() => run((x) => C.toggleArticulation(x, refs, 'accent'))}>&gt;</button>
          <button aria-pressed={art('marcato')} onClick={() => run((x) => C.toggleArticulation(x, refs, 'marcato'))}>^</button>
          <button aria-pressed={art('staccato')} onClick={() => run((x) => C.toggleArticulation(x, refs, 'staccato'))}>·</button>
        </Row>
        {notes.some((n) => n.art?.length) && <Row label="Placed"><Seg value={same(notes.map((n) => n.artSide))} opts={[[undefined, 'auto'], ['above', 'above'], ['below', 'below']]} onChange={(v) => run((x) => C.updateNotes(x, refs, (n) => { if (v) n.artSide = v; else delete n.artSide; }))} /></Row>}
        <Row label="Arpeggio"><button aria-pressed={notes.every((n) => n.arpeggio)} onClick={() => run((x) => C.updateNotes(x, refs, (n) => { if (notes.every((q) => q.arpeggio)) delete n.arpeggio; else n.arpeggio = true; }))}>Wavy line</button></Row>
        <Row label="Beam"><button aria-pressed={notes.some((n) => n.noBeam)} onClick={() => run((x) => C.updateNotes(x, refs, (n) => { if (notes.some((q) => q.noBeam)) delete n.noBeam; else n.noBeam = true; }))}>Not beamed</button></Row>
        {nonHome.length > 0 && <Row label="Staff"><Seg value={same(notes.map((n) => n.staff ?? r0.staff))} opts={[[r0.staff, `own (${r0.staff})`], ...nonHome.map((s): [string, string] => [s.id, s.id])]} onChange={(v) => run((x) => C.setStaffOf(x, refs, v === r0.staff ? undefined : v))} /></Row>}
      </>}
      {evs.some((e) => e.kind === 'rest') && <Row label="Rest"><Seg value={same(evs.filter((e) => e.kind === 'rest').map((e) => (e as { style: string }).style))} opts={[['normal', 'shown'], ['hidden', 'hidden']]} onChange={(v) => run((x) => C.updateEvents(x, refs, (e) => { if (e.kind === 'rest' && e.style !== 'measure') e.style = v as 'normal' | 'hidden'; }))} /></Row>}
      {refs.length >= 2 && <div class="btns"><button onClick={slurSelection}>Slur over selection (S)</button></div>}
      {notes.length > 0 && <Row label="Grouping">
        {refs.length >= 2 && <button title="Beam the selected notes together" onClick={() => { const a = [...refs].sort((p, q) => p.idx - q.idx); run((x) => C.makeBeam(x, a[0], a[0].idx, a[a.length - 1].idx)); }}>Beam</button>}
        {refs.length === 2 && [1, 2, 3].map((b) => <button title={`Two-note tremolo, ${b} beam${b > 1 ? 's' : ''}`} onClick={() => { const a = [...refs].sort((p, q) => p.idx - q.idx); run((x) => C.makeTremolo(x, a[0], a[0].idx, a[1].idx, b)); }}>Trem {b}</button>)}
        <button title="Dissolve the beam group or tremolo" onClick={() => run((x) => refs.reduce((sc, r) => { try { return C.ungroup(sc, r); } catch { return sc; } }, x))}>Ungroup</button>
      </Row>}
      <div class="btns"><button onClick={flipStem}>Flip stem (X)</button><button class="danger" onClick={() => deleteSelection()}>Delete</button></div>
    </section>
  );
}

function MarkSection({ r }: { r: Extract<Ref, { t: 'mark' }> }) {
  const m = markOf(score.value, r);
  if (!m) return null;
  const upd = (patch: Partial<MarkBody>) => run((x) => C.updateMark(x, r, patch));
  const place = (m as { placement?: 'above' | 'below' }).placement;
  const label = m.type === 'stop' ? `End of ${m.of}` : m.type === 'ottava' ? (m.dir === 'up' ? '8va' : '8vb') : m.type[0].toUpperCase() + m.type.slice(1);
  return (
    <section>
      <h3>{label}</h3>
      {m.type === 'dynamic' && <Row label="Dynamic"><select value={m.text} onChange={(e) => upd({ text: (e.target as HTMLSelectElement).value } as never)}>{DYNAMICS.map((d) => <option>{d}</option>)}</select></Row>}
      {m.type === 'text' && <Row label="Text"><Txt value={m.text} onChange={(v) => upd({ text: v } as never)} /></Row>}
      {m.type === 'tempo' && <>
        <Row label="Beats per min"><Num value={m.bpm} min={10} max={600} onChange={(n) => upd({ bpm: n } as never)} /></Row>
        <Row label="Beat unit"><Seg value={m.unit} opts={[[2, 'half'], [4, 'quarter'], [8, 'eighth']]} onChange={(u) => upd({ unit: u } as never)} /></Row>
        <Row label="Dotted"><Seg value={m.dots} opts={[[0, 'no'], [1, 'yes']]} onChange={(d) => upd({ dots: d } as never)} /></Row>
      </>}
      {m.type === 'hairpin' && <Row label="Shape"><Seg value={m.kind} opts={[['cresc', 'cresc.'], ['dim', 'dim.']]} onChange={(k) => upd({ kind: k } as never)} /></Row>}
      {(m.type === 'dynamic' || m.type === 'hairpin' || m.type === 'text') && <Row label="Placed"><Seg value={place} opts={[[undefined, 'auto'], ['above', 'above'], ['below', 'below']]} onChange={(p) => upd({ placement: p } as never)} /></Row>}
      {m.type === 'clef' && <Row label="Clef"><select value={`${m.clef.sign}${m.clef.line}`} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; upd({ clef: { sign: v[0] as 'G', line: Number(v[1]) } } as never); }}><option value="G2">Treble</option><option value="F4">Bass</option><option value="C3">Alto</option><option value="C4">Tenor</option></select></Row>}
      <Row label="Position">{`measure ${r.mi + 1}, ${(m.tick / 3360).toFixed(2).replace(/\.?0+$/, '')} quarters`}</Row>
      <div class="btns"><button class="danger" onClick={() => deleteSelection()}>Delete</button></div>
    </section>
  );
}

function SlurSection({ r }: { r: Extract<Ref, { t: 'slur' }> }) {
  const e = eventOf(score.value, r);
  const sl = e?.slurStart?.find((s) => s.id === r.id);
  return (
    <section>
      <h3>Slur</h3>
      <Row label="Side"><Seg value={sl?.side} opts={[[undefined, 'auto'], ['above', 'above'], ['below', 'below']]} onChange={(v) => run((x) => C.setSlurSide(x, r, r.id, v))} /></Row>
      <div class="btns"><button class="danger" onClick={() => deleteSelection()}>Delete slur</button></div>
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
      <h3>Tuplet {g.actual}:{g.normal}</h3>
      <Row label="Bracket"><Seg value={g.bracket} opts={[[undefined, 'auto'], [true, 'yes'], [false, 'no']]} onChange={(v) => upd({ bracket: v })} /></Row>
      <Row label="Number"><Seg value={g.number ?? 'actual'} opts={[['actual', 'shown'], ['none', 'hidden']]} onChange={(v) => upd({ number: v === 'actual' ? undefined : 'none' })} /></Row>
      <Row label="Label"><Num value={g.label ?? g.actual} min={1} max={99} onChange={(n) => { setLab(String(n)); upd({ label: n === g.actual ? undefined : n }); }} /></Row>
      <Row label="Placed"><Seg value={g.placement} opts={[[undefined, 'auto'], ['above', 'above'], ['below', 'below']]} onChange={(v) => upd({ placement: v })} /></Row>
      <div class="btns"><button class="danger" onClick={() => deleteSelection()}>Remove tuplet</button></div>
      <span hidden>{lab}</span>
    </section>
  );
}

export function Inspector() {
  const sel = selection.value;
  const first = sel[0];
  const evs = sel.filter((r) => r.t === 'ev');
  const measure = sel.find((r): r is Extract<Ref, { t: 'measure' }> => r.t === 'measure');
  void voiceOf; void flattenVoice; void dur; void dots;
  return (
    <aside class="inspector" aria-label="Properties">
      {evs.length > 0 && <EventSection />}
      {first?.t === 'mark' && <MarkSection r={first} />}
      {first?.t === 'slur' && <SlurSection r={first} />}
      {first?.t === 'tuplet' && <TupletSection r={first} />}
      {first?.t === 'tie' && <section><h3>Tie</h3><div class="btns"><button class="danger" onClick={() => deleteSelection()}>Remove tie</button></div></section>}
      {measure && <MeasureSection mi={measure.mi} />}
      {!sel.length || (!evs.length && first.t !== 'mark' && first.t !== 'slur' && first.t !== 'tuplet' && first.t !== 'tie') ? <ScoreSection /> : null}
    </aside>
  );
}
