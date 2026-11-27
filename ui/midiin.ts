// MIDI keyboard input: each key pressed enters a note at the cursor, which is the selected event (or the start of the
// score when nothing is selected) and moves on to the next position. Keys pressed together (within `CHORD_MS`) make a
// chord. The device is opened on request, the editing itself is `src/editor/stepentry.ts`.

import { signal } from '@preact/signals';
import { voiceOf } from '../src/editor/addr.ts';
import type { Cursor } from '../src/editor/stepentry.ts';
import { advanceCursor, enterMidi } from '../src/editor/stepentry.ts';
import { flattenVoice } from '../src/model.ts';
import { selectEventAt } from './interact.ts';
import { preview } from './player.ts';
import { dots, dur, run, say, score, selection, voice } from './state.ts';

export const midiInPorts = signal<{ id: string; name: string }[]>([]);

/** The input in use; null: MIDI input is off. */
export const midiIn = signal<string | null>(null);

/** Keys pressed within this many milliseconds of each other form one chord. */
const CHORD_MS = 90;

let access: MIDIAccess | null = null;

/** The note entered last, for chords: where it went and when. */
let last: { at: Cursor; time: number } | undefined;

/** The cursor: the first selected event, else the start of the score on the first staff. */
function cursorNow(): Cursor {
  const sc = score.peek();
  const r = selection.peek().find((x) => x.t === 'ev' || x.t === 'grace');
  if (r) {
    const te = flattenVoice(voiceOf(sc, r) ?? { id: 0, items: [] })[r.idx];
    if (te) return { mi: r.mi, staff: r.staff, voice: r.voice, tick: te.start };
  }
  return { mi: 0, staff: sc.staves[0].id, voice: voice.peek(), tick: 0 };
}

/** Enters one key press (MIDI key `midi`) and moves the selection to the next position; a key within the chord window joins the previous note. */
function noteOn(midi: number, now = performance.now()): void {
  const d = { base: dur.peek(), dots: dots.peek() };
  const chord = !!last && now - last.time < CHORD_MS;
  const cur = chord && last ? last.at : cursorNow();
  let next: Cursor | undefined;
  const ok = run((s) => {
    const entered = enterMidi(s, cur, d, midi, chord);
    if (chord) return entered;
    const moved = advanceCursor(entered, cur, d);
    next = moved.cursor;
    return moved.score;
  });
  if (!ok) return;
  preview(midi);
  if (!chord) last = { at: cur, time: now };
  if (next) selectEventAt(next, next.tick);
}

/** Handles one MIDI message from the keyboard: only note-on with a velocity counts. */
function onMessage(e: MIDIMessageEvent): void {
  const [status, key, vel] = e.data ?? [];
  if ((status & 0xf0) === 0x90 && vel > 0) noteOn(key);
}

/** Listens to input `id` only (or to none). */
function listen(id: string | null): void {
  if (!access) return;
  for (const inp of access.inputs.values()) inp.onmidimessage = inp.id === id ? onMessage : null;
}

/** Reads the available inputs, keeping the chosen one or picking the first that is not a "through" port. */
function refresh(): void {
  if (!access) return;
  const ins = [...access.inputs.values()];
  midiInPorts.value = ins.map((i) => ({ id: i.id, name: i.name ?? i.id }));
  if (midiIn.peek() && !ins.some((i) => i.id === midiIn.peek()))
    midiIn.value = (ins.find((i) => !/through/i.test(i.name ?? '')) ?? ins[0])?.id ?? null;
  listen(midiIn.peek());
}

/** Asks for MIDI access on first use (the browser prompts) and reads the inputs; false (explained in the status line) when there is no access. */
async function open(): Promise<boolean> {
  if (!access) {
    if (!navigator.requestMIDIAccess) {
      say('This browser has no Web MIDI support', true);
      return false;
    }
    try {
      access = await navigator.requestMIDIAccess();
    } catch {
      say('MIDI access was refused', true);
      return false;
    }
    access.onstatechange = () => refresh();
  }
  refresh();
  return true;
}

/** Reads the MIDI inputs into `midiInPorts` (asking for access the first time), for the input menu; input stays off. */
export function listInputs(): void {
  void open();
}

/** Switches MIDI input on (asking for access the first time) with input `id`, the default input when omitted, or off with `null`. */
export async function chooseInput(id?: string | null): Promise<void> {
  if (id === null) {
    midiIn.value = null;
    listen(null);
    return;
  }
  if (!((await open()) && access)) return;
  const ins = [...access.inputs.values()];
  const pick = ins.find((i) => i.id === id) ?? ins.find((i) => !/through/i.test(i.name ?? '')) ?? ins[0];
  if (!pick) {
    say('No MIDI input found. Plug in a keyboard and try again.', true);
    return;
  }
  midiIn.value = pick.id;
  refresh();
  say(`MIDI input: ${pick.name ?? pick.id}. Select where to start, then play.`);
}
