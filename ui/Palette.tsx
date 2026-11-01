import type { BaseDur } from '../src/model.ts';
import { Glyph, Label, CPS, Icon } from './icons.tsx';
import { voiceColors, VOICE_COLORS, tool, dur, dots, acc, voice, dynText, clefArg, tupletArg, tempoArg, textArg, type Tool } from './state.ts';
import { chooseDuration, chooseDots, setAccidentalSel } from './actions.ts';

const DURS: [BaseDur, number, string][] = [[1, CPS.whole, '1'], [2, CPS.half, '2'], [4, CPS.quarter, '3'], [8, CPS.eighth, '4'], [16, CPS.sixteenth, '5'], [32, CPS.thirty2, '6'], [64, CPS.sixty4, '7']];
const ACCS: [number, number, string][] = [[-2, CPS.dflat, 'Double flat'], [-1, CPS.flat, 'Flat'], [0, CPS.natural, 'Natural'], [1, CPS.sharp, 'Sharp'], [2, CPS.dsharp, 'Double sharp']];
export const DYNAMICS = ['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'sf', 'sfz', 'fp', 'rfz', 'fz'];
const CLEFS: [string, { sign: 'G' | 'F' | 'C'; line: number; octave?: number }][] = [
  ['Treble', { sign: 'G', line: 2 }], ['Bass', { sign: 'F', line: 4 }], ['Alto', { sign: 'C', line: 3 }], ['Tenor', { sign: 'C', line: 4 }], ['Treble 8vb', { sign: 'G', line: 2, octave: -1 }],
];
const RATIOS: [number, number][] = [[3, 2], [2, 1], [4, 3], [5, 4], [6, 4], [7, 4], [5, 2], [7, 8]];

function Btn({ on, title, onClick, children, wide, color }: { on?: boolean; title: string; onClick: () => void; children: preact.ComponentChildren; wide?: boolean; color?: string }) {
  return <button class={`pbtn${wide ? ' wide' : ''}`} style={color ? { boxShadow: `inset 0 -4px 0 ${color}` } : undefined} aria-pressed={!!on} title={title} onClick={onClick}>{children}</button>;
}

function ToolBtn({ t, title, children }: { t: Tool; title: string; children: preact.ComponentChildren }) {
  return <Btn on={tool.value === t} title={title} onClick={() => (tool.value = tool.value === t && t !== 'select' ? 'select' : t)}>{children}</Btn>;
}

export function Palette() {
  const t = tool.value;
  return (
    <nav class="palette" aria-label="Tools">
      <h4>Tools</h4>
      <div class="grid">
        <ToolBtn t="select" title="Select (Esc)"><Icon.select /></ToolBtn>
        <ToolBtn t="note" title="Enter notes (N): click on a staff"><Glyph cp={CPS.quarter} /></ToolBtn>
        <ToolBtn t="rest" title="Enter rests (R)"><Icon.rest /></ToolBtn>
      </div>
      <h4>Duration</h4>
      <div class="grid">
        {DURS.map(([b, cp, k]) => <Btn on={dur.value === b} title={`${b === 1 ? 'Whole' : `1/${b}`} (${k})`} onClick={() => chooseDuration(b)}><Glyph cp={cp} /></Btn>)}
        <Btn on={dots.value > 0} title="Dot (.)" onClick={() => chooseDots((dots.value + 1) % 3)}>
          {dots.value === 2 ? <Label size={26}>··</Label> : <Glyph cp={CPS.dot} cap={24} max={6} />}
        </Btn>
      </div>
      <h4>Accidental</h4>
      <div class="grid">
        {ACCS.map(([a, cp, name]) => <Btn on={acc.value === a} title={name} onClick={() => { acc.value = acc.value === a ? undefined : a; setAccidentalSel(acc.value); }}><Glyph cp={cp} max={22} cap={10} /></Btn>)}
      </div>
      <h4>Voice</h4>
      <div class="grid">
        {[1, 2, 3, 4].map((v) => <Btn on={voice.value === v} title={`Voice ${v}`} onClick={() => (voice.value = v)} color={voiceColors.value ? VOICE_COLORS[v] ?? '#555' : undefined}><b>{v}</b></Btn>)}
      </div>
      <h4>Lines</h4>
      <div class="grid">
        <ToolBtn t="slur" title="Slur: drag from note to note"><Icon.slur /></ToolBtn>
        <ToolBtn t="cresc" title="Crescendo: drag from note to note"><Icon.cresc /></ToolBtn>
        <ToolBtn t="dim" title="Diminuendo: drag from note to note"><Icon.dim /></ToolBtn>
        <ToolBtn t="pedal" title="Pedal: drag from note to note"><Glyph cp={CPS.ped} /></ToolBtn>
        <ToolBtn t="8va" title="8va: drag from note to note"><Label italic>8va</Label></ToolBtn>
        <ToolBtn t="8vb" title="8vb: drag from note to note"><Label italic>8vb</Label></ToolBtn>
      </div>
      <h4>Marks</h4>
      <div class="grid">
        <ToolBtn t="dynamic" title="Dynamic: click a position"><Label italic>mf</Label></ToolBtn>
        <ToolBtn t="text" title="Text: click a position"><Icon.text /></ToolBtn>
        <ToolBtn t="tempo" title="Tempo: click a position"><Icon.tempo /></ToolBtn>
        <ToolBtn t="clef" title="Clef change: click a position"><Glyph cp={CPS.gclef} max={28} cap={9} /></ToolBtn>
        <ToolBtn t="tuplet" title="Tuplet: click a note or rest"><Icon.tuplet /></ToolBtn>
      </div>
      <div class="args">
        {t === 'dynamic' && <select value={dynText.value} onChange={(e) => (dynText.value = (e.target as HTMLSelectElement).value)}>{DYNAMICS.map((d) => <option>{d}</option>)}</select>}
        {t === 'text' && <input value={textArg.value} onInput={(e) => (textArg.value = (e.target as HTMLInputElement).value)} />}
        {t === 'tempo' && <label>♩ = <input type="number" min="20" max="400" value={tempoArg.value.bpm} onInput={(e) => (tempoArg.value = { ...tempoArg.value, bpm: Number((e.target as HTMLInputElement).value) || 120 })} /></label>}
        {t === 'clef' && <select value={CLEFS.findIndex(([, c]) => JSON.stringify(c) === JSON.stringify(clefArg.value))} onChange={(e) => (clefArg.value = CLEFS[Number((e.target as HTMLSelectElement).value)][1])}>{CLEFS.map(([n], i) => <option value={i}>{n}</option>)}</select>}
        {t === 'tuplet' && <select value={tupletArg.value.join(':')} onChange={(e) => { const [a, b] = (e.target as HTMLSelectElement).value.split(':').map(Number); tupletArg.value = [a, b]; }}>{RATIOS.map(([a, b]) => <option>{a}:{b}</option>)}</select>}
      </div>
      <p class="hint">{HINTS[t]}</p>
    </nav>
  );
}

const HINTS: Record<Tool, string> = {
  select: 'Click to select, drag a note up or down to change its pitch, drag a box to select several. Right-click for more.',
  note: 'Click on a staff: the note lands where the ghost shows. Click an existing note to add or remove a chord tone. Alt replaces tuplets.',
  rest: 'Click on a staff to put a rest of the chosen duration.',
  slur: 'Drag from the first note to the last.',
  cresc: 'Drag from the first note to the last.', dim: 'Drag from the first note to the last.', pedal: 'Drag from the note where the pedal goes down to the last note under it.',
  '8va': 'Drag from the first note to the last to shift.', '8vb': 'Drag from the first note to the last to shift.',
  dynamic: 'Click a position (above the staff centre puts it above).', text: 'Click a position.', tempo: 'Click a position.', clef: 'Click a position.',
  tuplet: 'Click a note or rest: it becomes a tuplet of that length.',
};
