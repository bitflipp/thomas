// The tool palette of the editor: tools, durations, accidentals, dynamics and other marks that the
// user picks before clicking on the score. It only sets the signals of state.ts; interact.ts reads them.

import { effect, signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { BaseDur } from '../src/model.ts';

import {
  chooseAccidental,
  chooseDots,
  chooseDuration,
  editsSelection,
  selectedAlter,
  shownDuration,
} from './actions.ts';

import { CPS, Glyph, Icon, Label } from './icons.tsx';
import { AccidentalButtons, DurationButtons } from './pickers.tsx';
import type { Tool } from './state.ts';

import {
  acc,
  clefArg,
  dynText,
  setTool,
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
  ['Treble 8va', { sign: 'G', line: 2, octave: 1 }],
  ['Treble 8vb', { sign: 'G', line: 2, octave: -1 }],
];

/** The beat units of a tempo mark with the glyph of each. */
const TEMPO_UNITS: [BaseDur, number][] = [
  [1, CPS.whole],
  [2, CPS.half],
  [4, CPS.quarter],
  [8, CPS.eighth],
  [16, CPS.sixteenth],
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
  tool: toolId,
}: {
  tool?: Tool;
  on?: boolean;
  title: string;
  onClick: (e: MouseEvent) => void;
  children: preact.ComponentChildren;
  color?: string;
}) {
  return (
    <button
      type="button"
      style={color ? { boxShadow: `inset 0 -4px 0 ${color}` } : undefined}
      aria-pressed={!!on}
      data-tool={toolId}
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
      tool={t}
      title={title}
      onClick={(e) => {
        if (tool.value === t && ARG_TOOLS.includes(t)) popupAt.value = { x: e.clientX, y: e.clientY };
        else setTool(tool.value === t && t !== 'select' ? 'select' : t);
      }}
    >
      {children}
    </Btn>
  );
}

/** The tools that have settings, which are picked in a popup at the pointer. */
const ARG_TOOLS: Tool[] = ['dynamic', 'text', 'tempo', 'clef', 'tuplet'];

/** Where the popup with the settings of the active tool is showing (the pointer's position), or null when closed. */
const popupAt = signal<{ x: number; y: number } | null>(null);

/** The last known pointer position, where a popup opened from the keyboard appears. */
const pointer = { x: 0, y: 0 };

if (typeof document !== 'undefined')
  document.addEventListener(
    'pointermove',
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    },
    true,
  );

effect(() => {
  popupAt.value = ARG_TOOLS.includes(tool.value) ? { ...pointer } : null;
});

/** One choice of a popup: a button that is marked when it is the current value. */
function Choice({ on, onPick, children }: { on: boolean; onPick: () => void; children: preact.ComponentChildren }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        onPick();
        popupAt.value = null;
      }}
    >
      {children}
    </button>
  );
}

/** The settings of the active tool (dynamic, text, tempo, clef or tuplet) as a popup at the pointer. */
function ToolPopup() {
  const t = tool.value;
  const at = popupAt.value;
  const ref = useRef<HTMLDivElement>(null);
  const shown = at !== null;
  const x = at?.x;
  const y = at?.y;
  // The popup opens with its corner at the pointer and is moved back into the window when it would run out of it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!(el && x !== undefined && y !== undefined)) return;
    el.style.left = `${Math.max(4, Math.min(x, innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, innerHeight - el.offsetHeight - 4))}px`;
  }, [x, y]);
  // A press anywhere else closes it.
  useEffect(() => {
    if (!shown) return;
    ref.current?.querySelector('input')?.select();
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) popupAt.value = null;
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [shown]);
  if (!at) return null;
  const close = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.stopPropagation();
      popupAt.value = null;
    }
  };
  return (
    <div class="toolpopup" ref={ref} style={{ left: `${at.x}px`, top: `${at.y}px` }} role="dialog">
      {t === 'dynamic' && (
        <div class="choices dyn">
          {DYNAMICS.map((d) => (
            <Choice on={dynText.value === d} onPick={() => (dynText.value = d)}>
              <i>{d}</i>
            </Choice>
          ))}
        </div>
      )}
      {t === 'text' && (
        <input
          value={textArg.value}
          onKeyDown={close}
          onInput={(e) => (textArg.value = (e.target as HTMLInputElement).value)}
        />
      )}
      {t === 'tempo' && (
        <div class="tempoargs">
          <div class="choices units">
            {TEMPO_UNITS.map(([u, cp]) => (
              <button
                type="button"
                aria-pressed={tempoArg.value.unit === u}
                title={`Beat unit 1/${u}`}
                onClick={() => (tempoArg.value = { ...tempoArg.value, unit: u })}
              >
                <Glyph cp={cp} max={30} cap={12} />
              </button>
            ))}
            <button
              type="button"
              aria-pressed={tempoArg.value.dots > 0}
              title="Dotted"
              onClick={() => (tempoArg.value = { ...tempoArg.value, dots: tempoArg.value.dots ? 0 : 1 })}
            >
              <Glyph cp={CPS.dot} cap={24} max={9} />
            </button>
          </div>
          <label>
            =
            <input
              type="number"
              min="20"
              max="400"
              value={tempoArg.value.bpm}
              onKeyDown={close}
              onInput={(e) =>
                (tempoArg.value = { ...tempoArg.value, bpm: Number((e.target as HTMLInputElement).value) || 120 })
              }
            />
          </label>
        </div>
      )}
      {t === 'clef' && (
        <div class="choices list">
          {CLEFS.map(([n, c]) => (
            <Choice on={JSON.stringify(c) === JSON.stringify(clefArg.value)} onPick={() => (clefArg.value = c)}>
              {n}
            </Choice>
          ))}
        </div>
      )}
      {t === 'tuplet' && (
        <div class="choices dyn">
          {RATIOS.map(([a, b]) => (
            <Choice on={tupletArg.value.join(':') === `${a}:${b}`} onPick={() => (tupletArg.value = [a, b])}>
              {a}:{b}
            </Choice>
          ))}
        </div>
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
      <h4>{editsSelection() ? 'Duration of selection' : 'Duration of next note'}</h4>
      <div class="grid">
        <DurationButtons value={shownDuration().base} onPick={chooseDuration} />
        <Btn on={shownDuration().dots > 0} title="Dot (.)" onClick={() => chooseDots((shownDuration().dots + 1) % 3)}>
          {shownDuration().dots === 2 ? <Label size={26}>··</Label> : <Glyph cp={CPS.dot} cap={24} max={9} />}
        </Btn>
      </div>
      <h4>Accidental</h4>
      <div class="grid">
        <AccidentalButtons value={editsSelection() ? selectedAlter() : acc.value} onPick={chooseAccidental} />
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
      <ToolPopup key={tool.value} />
    </nav>
  );
}
