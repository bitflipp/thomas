// Score -> a plain list of sounding notes for tools that compare a rendition with the score
// (Pianizer's "Compare with score"). Built on buildSequence, so ties, ornaments, tremolo and
// arpeggio are already expanded and the velocity is the one the dynamics give.
//
// Ticks are converted to `ticksPerBeat` (480, Pianizer's resolution), measure starts are listed so
// the other side can line measures up, and exact duplicate unisons (same start and pitch, e.g. two
// voices sharing a note) are merged into one note, the way MuseScore exports them.

import type { Score } from '../model.ts';
import { PPQ } from '../model.ts';
import { buildSequence } from './sequence.ts';

export interface ExportedNotes {
  format: 'thomas-notes';
  version: 1;
  ticksPerBeat: number;
  totalTicks: number;
  /** Start tick of each measure. */
  measures: number[];
  notes: { pitch: number; startTick: number; endTick: number; velocity: number }[];
}

export function exportNotes(score: Score, ticksPerBeat = 480): ExportedNotes {
  const seq = buildSequence(score);
  const toTick = (t: number) => Math.round((t / PPQ) * ticksPerBeat);

  const open = new Map<string, { start: number; vel: number }[]>();
  const merged = new Map<string, { pitch: number; startTick: number; endTick: number; velocity: number }>();
  for (const m of seq.msgs) {
    const [status, pitch, vel] = m.bytes;
    const kind = status & 0xf0;
    if (kind !== 0x90 && kind !== 0x80) continue;
    const key = `${status & 15}:${pitch}`;
    const tick = toTick(seq.secToTick(m.sec));
    if (kind === 0x90 && vel > 0) {
      const q = open.get(key) ?? [];
      q.push({ start: tick, vel });
      open.set(key, q);
      continue;
    }
    const on = open.get(key)?.shift();
    if (!on) continue;
    const id = `${on.start}:${pitch}`;
    const prev = merged.get(id);
    if (prev) {
      prev.endTick = Math.max(prev.endTick, tick);
      prev.velocity = Math.max(prev.velocity, on.vel);
    } else merged.set(id, { pitch, startTick: on.start, endTick: tick, velocity: on.vel });
  }

  const notes = [...merged.values()].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  return {
    format: 'thomas-notes',
    version: 1,
    ticksPerBeat,
    totalTicks: toTick(seq.totalTicks),
    measures: seq.measureStart.map(toTick),
    notes,
  };
}
