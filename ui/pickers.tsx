// Pickers shared by the tool palette and the Properties panel, so duration and accidental look the same
// everywhere. They render bare buttons; the container (`.grid` in the palette, `.seg` in the panel) styles them.
import type { BaseDur } from '../src/model.ts';
import { CPS, Glyph } from './icons.tsx';

export const DURS: [BaseDur, number, string][] = [
  [1, CPS.whole, '1'],
  [2, CPS.half, '2'],
  [4, CPS.quarter, '3'],
  [8, CPS.eighth, '4'],
  [16, CPS.sixteenth, '5'],
  [32, CPS.thirty2, '6'],
  [64, CPS.sixty4, '7'],
];
export const ACCS: [number, number, string][] = [
  [-2, CPS.dflat, 'Double flat'],
  [-1, CPS.flat, 'Flat'],
  [0, CPS.natural, 'Natural'],
  [1, CPS.sharp, 'Sharp'],
  [2, CPS.dsharp, 'Double sharp'],
];

export function DurationButtons({
  value,
  onPick,
}: {
  value: BaseDur | 'mixed' | undefined;
  onPick: (b: BaseDur) => void;
}) {
  return (
    <>
      {DURS.map(([b, cp, k]) => (
        <button
          type="button"
          aria-pressed={value === b}
          title={`${b === 1 ? 'Whole' : `1/${b}`} (${k})`}
          onClick={() => onPick(b)}
        >
          <Glyph cp={cp} />
        </button>
      ))}
    </>
  );
}

export function AccidentalButtons({
  value,
  onPick,
}: {
  value: number | 'mixed' | undefined;
  onPick: (a: number) => void;
}) {
  return (
    <>
      {ACCS.map(([a, cp, name]) => (
        <button type="button" aria-pressed={value === a} title={name} onClick={() => onPick(a)}>
          <Glyph cp={cp} max={22} cap={10} />
        </button>
      ))}
    </>
  );
}
