// The tool palette of the editor: tools, durations, accidentals, dynamics and other marks that the
// user picks before clicking on the score. It only sets the signals of state.ts; interact.ts reads them.

import { chooseAccidental, chooseDots, chooseDuration, selectedAlter } from './actions.ts';
import { Dropdown } from './Dropdown.tsx';
import { CPS, Glyph, Icon, Label } from './icons.tsx';
import { evRefs } from './interact.ts';
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
          {dots.value === 2 ? <Label size={26}>··</Label> : <Glyph cp={CPS.dot} cap={24} max={9} />}
        </Btn>
      </div>
      <h4>Accidental</h4>
      <div class="grid">
        <AccidentalButtons value={evRefs().length ? selectedAlter() : acc.value} onPick={chooseAccidental} />
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
        <ToolBtn t="grace" title="Grace note: click on the staff in front of a note">
          <Label italic>gr</Label>
        </ToolBtn>
      </div>
      <PaletteArgs />
    </nav>
  );
}
