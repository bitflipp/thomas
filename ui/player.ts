// Playback: Web MIDI output, a look-ahead scheduler, and the playhead position (absolute ticks, kept across stops).
//
// The score is turned into a timed message list once (src/playback/sequence.ts). A timer then
// sends every message due within the next LOOKAHEAD seconds with an exact `timestamp`, so that
// timing comes from the MIDI stack rather than from setInterval jitter. There is no built-in synth:
// sound comes from whichever Web MIDI output the user picked.
import { computed, effect, signal } from '@preact/signals';
import { xOfTick } from '../src/editor/hit.ts';
import { buildSequence } from '../src/playback/sequence.ts';
import { must } from '../src/util.ts';
import { docId, engraved, say, score } from './state.ts';

export const playing = signal(false);
/** Where playback resumes, and where the playhead is drawn. Absolute ticks from the start of the score. */
export const playTick = signal(0);
export const midiPorts = signal<{ id: string; name: string }[]>([]);
export const midiOut = signal<string | null>(null);

const LOOKAHEAD = 0.12;
const LEAD_IN = 0.06;
const POLL_MS = 25;
let access: MIDIAccess | null = null;
let seq = buildSequence(score.peek());
let timer: ReturnType<typeof setInterval> | undefined;
let raf = 0;
/** Wall clock (ms) at which score time `sec0` (seconds) is heard; `next` is the index of the next message to send. */
let wall0 = 0;
let sec0 = 0;
let next = 0;
let sounding = false;

try {
  midiOut.value = localStorage.getItem('thomas.midiOut');
} catch {
  /* storage unavailable */
}
midiOut.subscribe((id) => {
  try {
    id ? localStorage.setItem('thomas.midiOut', id) : localStorage.removeItem('thomas.midiOut');
  } catch {
    /* ignore */
  }
});

function refreshPorts(): void {
  if (!access) return;
  const outs = [...access.outputs.values()];
  midiPorts.value = outs.map((o) => ({ id: o.id, name: o.name ?? o.id }));
  if (!outs.some((o) => o.id === midiOut.peek())) {
    midiOut.value = (outs.find((o) => !/through/i.test(o.name ?? '')) ?? outs[0])?.id ?? null;
  }
}

/** Asks for MIDI access on first use (the browser prompts), and returns the chosen output or explains in the status line why there is none. */
async function connect(): Promise<MIDIOutput | null> {
  if (!access) {
    if (!navigator.requestMIDIAccess) {
      say('This browser has no Web MIDI support', true);
      return null;
    }
    try {
      access = await navigator.requestMIDIAccess();
    } catch {
      say('MIDI access was refused', true);
      return null;
    }
    access.onstatechange = () => refreshPorts();
  }
  refreshPorts();
  const out = midiOut.peek() ? access.outputs.get(must(midiOut.peek())) : undefined;
  if (!out) say('No MIDI output found. Start a synthesizer (e.g. FluidSynth) and try again.', true);
  return out ?? null;
}

const outPort = (): MIDIOutput | undefined =>
  access && midiOut.peek() ? access.outputs.get(must(midiOut.peek())) : undefined;
const nowSec = (): number => sec0 + (performance.now() - wall0) / 1000;

/** Releases the sustain pedal (CC64) and stops all notes (CC123) on every channel, so a stop never leaves hanging notes. */
function silence(): void {
  const out = outPort();
  if (!(out && sounding)) return;
  for (const ch of seq.channels) {
    out.send([0xb0 | ch, 64, 0]);
    out.send([0xb0 | ch, 123, 0]);
  }
  sounding = false;
}

/** Sends every message due within the look-ahead window, each stamped with the wall-clock time at which it should sound. */
function pump(): void {
  const out = outPort();
  if (!out) {
    stop();
    return;
  }
  const horizon = nowSec() + LOOKAHEAD;
  while (next < seq.msgs.length && seq.msgs[next].sec < horizon) {
    const m = seq.msgs[next++];
    out.send(m.bytes, wall0 + (m.sec - sec0) * 1000);
    sounding = true;
  }
}

/** Index of the first message at or after `sec` (binary search; the messages are sorted by time). */
function firstMsgAt(sec: number): number {
  let lo = 0;
  let hi = seq.msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seq.msgs[mid].sec < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Animation loop: moves the playhead along with the sound, and ends playback shortly after the last message. */
function frame(): void {
  if (!playing.peek()) return;
  const sec = nowSec();
  const last = seq.msgs.length ? seq.msgs[seq.msgs.length - 1].sec : 0;
  if (sec > last + 0.25) {
    // Played to the end: the next start is from the top (`stop` would otherwise keep the position
    // at the last note and playing would end immediately again).
    stop();
    playTick.value = 0;
    return;
  }
  playTick.value = Math.min(seq.totalTicks, Math.max(0, seq.secToTick(sec)));
  raf = requestAnimationFrame(frame);
}

/** Start sounding from `playTick` (fresh sequence; also used to carry on after an edit). */
function begin(): void {
  sec0 = seq.tickToSec(playTick.peek());
  wall0 = performance.now() + LEAD_IN * 1000;
  next = firstMsgAt(sec0 - 1e-9);
  playing.value = true;
  clearInterval(timer);
  timer = setInterval(pump, POLL_MS);
  pump();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}

export async function play(): Promise<void> {
  if (playing.peek()) return;
  if (!(await connect())) return;
  seq = buildSequence(score.peek());
  if (playTick.peek() >= seq.totalTicks) playTick.value = 0;
  begin();
}

export function stop(): void {
  if (!playing.peek()) return;
  playTick.value = Math.min(seq.totalTicks, Math.max(0, seq.secToTick(nowSec())));
  clearInterval(timer);
  cancelAnimationFrame(raf);
  playing.value = false;
  silence();
}

export function toggle(): void {
  if (playing.peek()) stop();
  else void play();
}
export function rewind(): void {
  if (playing.peek()) {
    stop();
  }
  playTick.value = 0;
}
export function seek(tick: number): void {
  const was = playing.peek();
  if (was) {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    silence();
  }
  playTick.value = Math.max(0, Math.min(seq.totalTicks, tick));
  if (was) begin();
}
export function chooseOutput(id: string): void {
  const was = playing.peek();
  if (was) stop();
  midiOut.value = id;
  if (was) void play();
}

/** An edit while playing: rebuild the sequence and carry on from the same place; otherwise just keep the position valid. */
effect(() => {
  const s = score.value;
  const was = playing.peek();
  const tick = was ? seq.secToTick(nowSec()) : playTick.peek();
  if (was) {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    silence();
  }
  seq = buildSequence(s);
  playTick.value = Math.max(0, Math.min(seq.totalTicks, tick));
  if (was) begin();
});

/** A new document starts from the top. */
docId.subscribe(() => {
  if (playing.peek()) stop();
  playTick.value = 0;
});

export interface Playhead {
  page: number;
  x: number;
  y0: number;
  y1: number;
}
/** Where the playhead is drawn: on the first staff's measure, from the top of the system to the bottom. */
export const playhead = computed<Playhead | null>(() => {
  const res = engraved.value;
  const tick = playTick.value;
  if (!res || (!playing.value && tick === 0)) return null;
  const starts = seq.measureStart;
  let mi = starts.length - 1;
  while (mi > 0 && starts[mi] > tick) mi--;
  const g = res.layout.measures.find((m) => m.mi === mi && m.staff === 0);
  const sys = g && res.layout.systems.find((s) => s.sys === g.sys);
  if (!(g && sys)) return null;
  const len = (starts[mi + 1] ?? seq.totalTicks) - starts[mi];
  return {
    page: g.page,
    x: xOfTick(g, len, Math.min(len, tick - starts[mi])),
    y0: sys.staffY[0] - 0.5,
    y1: sys.staffY[sys.staffY.length - 1] + 4.5,
  };
});
/** Absolute tick at which measure `mi` starts. */
export const measureTick = (mi: number): number => seq.measureStart[mi] ?? 0;
