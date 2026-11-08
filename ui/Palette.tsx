// The tool palette of the editor: tools, durations, accidentals, dynamics and other marks that the
// user picks before clicking on the score. It only sets the signals of state.ts; interact.ts reads them.

import { chooseDots, chooseDuration, setAccidentalSel } from './actions.ts';
import { Dropdown } from './Dropdown.tsx';
import { CPS, Glyph, Icon, Label } from './icons.tsx';
import { AccidentalButtons, DurationButtons } from './pickers.tsx';
import type { Tool } from './state.ts';

import {
  acc,
  clefArg,
  dots,
  dur,
  dynText,
  tempoArg,
  textArg,
  tool,
  tupletArg,
  VOICE_COLORS,
  voice,
  voiceColors,
} from './state.ts';

export const DYNAMICS = [
  'pppp',
  'ppp',
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fff',
  'ffff',
  'sf',
  'sfz',
  'fp',
  'rfz',
  'fz',
];

const CLEFS: [string, { sign: 'G' | 'F' | 'C'; line: number; octave?: number }][] = [
  ['Treble', { sign: 'G', line: 2 }],
  ['Bass', { sign: 'F', line: 4 }],
  ['Alto', { sign: 'C', line: 3 }],
  ['Tenor', { sign: 'C', line: 4 }],
  ['Treble 8vb', { sign: 'G', line: 2, octave: -1 }],
];

const RATIOS: [number, number][] = [
  [3, 2],
  [2, 1],
  [4, 3],
  [5, 4],
  [6, 4],
  [7, 4],
  [5, 2],
  [7, 8],
];

/** A square palette button; `on` marks it as the active one. */
function Btn({
  on,
  title,
  onClick,
  children,
  color,
}: {
  on?: boolean;
  title: string;
  onClick: () => void;
  children: preact.ComponentChildren;
  color?: string;
}) {
  return (
    <button
      type="button"
      style={color ? { boxShadow: `inset 0 -4px 0 ${color}` } : undefined}
      aria-pressed={!!on}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A palette button that switches to tool `t`. */
function ToolBtn({ t, title, children }: { t: Tool; title: string; children: preact.ComponentChildren }) {
  return (
    <Btn
      on={tool.value === t}
      title={title}
      onClick={() => (tool.value = tool.value === t && t !== 'select' ? 'select' : t)}
    >
      {children}
    </Btn>
  );
}

/** The argument fields of the active tool: dynamic, tempo, text, clef and tuplet settings. */
function PaletteArgs() {
  const t = tool.value;
  return (
    <div class="args">
      {t === 'dynamic' && (
        <Dropdown
          value={dynText.value}
          opts={DYNAMICS.map((d) => ({ value: d, label: d }))}
          onChange={(d) => (dynText.value = d)}
        />
      )}
      {t === 'text' && (
        <input value={textArg.value} onInput={(e) => (textArg.value = (e.target as HTMLInputElement).value)} />
      )}
      {t === 'tempo' && (
        <label>
          ♩ ={' '}
          <input
            type="number"
            min="20"
            max="400"
            value={tempoArg.value.bpm}
            onInput={(e) =>
              (tempoArg.value = { ...tempoArg.value, bpm: Number((e.target as HTMLInputElement).value) || 120 })
            }
          />
        </label>
      )}
      {t === 'clef' && (
        <Dropdown
          value={CLEFS.findIndex(([, c]) => JSON.stringify(c) === JSON.stringify(clefArg.value))}
          opts={CLEFS.map(([n], i) => ({ value: i, label: n }))}
          onChange={(i) => (clefArg.value = CLEFS[i][1])}
        />
      )}
      {t === 'tuplet' && (
        <Dropdown
          value={tupletArg.value.join(':')}
          opts={RATIOS.map(([a, b]) => ({ value: `${a}:${b}`, label: `${a}:${b}` }))}
          onChange={(v) => {
            const [a, b] = v.split(':').map(Number);
            tupletArg.value = [a, b];
          }}
        />
      )}
    </div>
  );
}

/** The tool palette: input and selection tools, durations, accidentals, marks and spans. */
export function Palette() {
  const t = tool.value;
  return (
    <nav class="palette" aria-label="Tools">
      <h4>Tools</h4>
      <div class="grid">
        <ToolBtn t="select" title="Select (Esc)">
          <Icon.select />
        </ToolBtn>
        <ToolBtn t="note" title="Enter notes (N): click on a staff">
          <Glyph cp={CPS.quarter} />
        </ToolBtn>
        <ToolBtn t="rest" title="Enter rests (R)">
          <Icon.rest />
        </ToolBtn>
      </div>
      <h4>Duration</h4>
      <div class="grid">
        <DurationButtons value={dur.value} onPick={chooseDuration} />
        <Btn on={dots.value > 0} title="Dot (.)" onClick={() => chooseDots((dots.value + 1) % 3)}>
          {dots.value === 2 ? <Label size={26}>··</Label> : <Glyph cp={CPS.dot} cap={24} max={6} />}
        </Btn>
      </div>
      <h4>Accidental</h4>
      <div class="grid">
        <AccidentalButtons
          value={acc.value}
          onPick={(a) => {
            acc.value = acc.value === a ? undefined : a;
            setAccidentalSel(acc.value);
          }}
        />
      </div>
      <h4>Voice</h4>
      <div class="grid">
        {[1, 2, 3, 4].map((v) => (
          <Btn
            on={voice.value === v}
            title={`Voice ${v}`}
            onClick={() => (voice.value = v)}
            color={voiceColors.value ? (VOICE_COLORS[v] ?? '#555') : undefined}
          >
            <b>{v}</b>
          </Btn>
        ))}
      </div>
      <h4>Lines</h4>
      <div class="grid">
        <ToolBtn t="slur" title="Slur: drag from note to note">
          <Icon.slur />
        </ToolBtn>
        <ToolBtn t="line" title="Line between two notes (voicing): drag from note to note, within one system">
          <Icon.link />
        </ToolBtn>
        <ToolBtn t="cresc" title="Crescendo: drag from note to note">
          <Icon.cresc />
        </ToolBtn>
        <ToolBtn t="dim" title="Diminuendo: drag from note to note">
          <Icon.dim />
        </ToolBtn>
        <ToolBtn t="pedal" title="Pedal: drag from note to note">
          <Glyph cp={CPS.ped} />
        </ToolBtn>
        <ToolBtn t="trill" title="Trill line: drag from note to note">
          <Label italic>tr</Label>
        </ToolBtn>
        <ToolBtn t="8va" title="8va: drag from note to note">
          <Label italic>8va</Label>
        </ToolBtn>
        <ToolBtn t="8vb" title="8vb: drag from note to note">
          <Label italic>8vb</Label>
        </ToolBtn>
      </div>
      <h4>Marks</h4>
      <div class="grid">
        <ToolBtn t="dynamic" title="Dynamic: click a note or rest">
          <Label italic>mf</Label>
        </ToolBtn>
        <ToolBtn t="text" title="Text: click a note or rest">
          <Icon.text />
        </ToolBtn>
        <ToolBtn t="tempo" title="Tempo: click a note or rest">
          <Icon.tempo />
        </ToolBtn>
        <ToolBtn t="clef" title="Clef change: click a note or rest">
          <Glyph cp={CPS.gclef} max={28} cap={9} />
        </ToolBtn>
        <ToolBtn t="tuplet" title="Tuplet: click a note or rest">
          <Icon.tuplet />
        </ToolBtn>
      </div>
      <PaletteArgs />
      <p class="hint">{HINTS[t]}</p>
    </nav>
  );
}

const HINTS: Record<Tool, string> = {
  select: 'Click to select, drag a note up or down to change its pitch, drag a box to select several.',
  note: 'Click on a staff: the note lands where the ghost shows. Click an existing note to add or remove a chord tone. Alt replaces tuplets.',
  rest: 'Click on a staff to put a rest of the chosen duration.',
  slur: 'Drag from the first note to the last.',
  line: 'Drag from one note to another in the same system (any voice or staff).',
  cresc: 'Drag from the first note to the last.',
  dim: 'Drag from the first note to the last.',
  pedal: 'Drag from the note where the pedal goes down to the last note under it.',
  trill: 'Drag from the first note to the last to trill them with a wavy line.',
  '8va': 'Drag from the first note to the last to shift.',
  '8vb': 'Drag from the first note to the last to shift.',
  dynamic: 'Click a note or rest: the mark hangs on it (above the staff centre puts it above).',
  text: 'Click a note or rest to hang the text on it.',
  tempo: 'Click a note or rest to hang the tempo on it.',
  clef: 'Click a note or rest: the clef changes from it.',
  tuplet: 'Click a note or rest: it becomes a tuplet of that length.',
};
