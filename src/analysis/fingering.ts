// Fingering of one hand: the cheapest finger for every key, and where even that is awkward.
//
// This is the second half of the playability check (`playability.ts` decides which hand plays which key; this
// module takes the keys of one hand step by step). It follows the idea of Parncutt and others: a Viterbi search
// over the ways of putting the fingers 1 to 5 on the keys of each step, with the cost of a way made of rules
// pianists know. A chord must keep its fingers in the order of the keys and within the reach of each pair of
// fingers; a single note after a single note is judged by the pair rule (stretching outward is natural,
// crossing the thumb under or a finger over costs, a hand that has to change position costs more the faster it
// is, the thumb and little finger on a black key cost). Chords followed by chords only pay for how far the hand
// moves. Nothing is a hard error here (the hands are, in `playability.ts`): what comes out are the fingers of
// the cheapest path, and the places where its cost is high, each with the reason.
//
// Not modeled: the shape of the hand (rotation, arm weight), finger substitution on a held key, and a pivot of
// the hand around the thumb in broken chords.

/** A key of a hand at one step, in ascending pitch. */
export interface FKey {
  midi: number;
  /** Whether the key is struck at this step (else it is held over from the step before). */
  attack: boolean;
  /** The index of the same key in the hand's previous step when it is held over, else -1. */
  held: number;
}

/** The keys of one hand at one attack time. */
export interface FStep {
  /** The time of the attack in seconds. */
  sec: number;
  keys: FKey[];
  /** Whether the hand starts afresh here (it did nothing at the step before, or the music could not be followed). */
  fresh: boolean;
}

/** A place where the cheapest fingering still costs a lot. */
export interface FIssue {
  step: number;
  cost: number;
  /** The reason that weighs most, as a short phrase such as "thumb on a black key". */
  why: string;
}

export interface Fingered {
  /** The finger of each key at each step, in the order of `FStep.keys`; empty where the step has no fingering. */
  fingers: number[][];
  issues: FIssue[];
}

/** A cost with its reason. */
interface Part {
  cost: number;
  why: string;
}

/** The widest span in semitones between two fingers (the lower number first) for a hand that reaches 14 semitones from thumb to little finger. */
const REACH: Record<string, number> = {
  '1,2': 9,
  '1,3': 11,
  '1,4': 13,
  '1,5': 14,
  '2,3': 5,
  '2,4': 8,
  '2,5': 10,
  '3,4': 4,
  '3,5': 7,
  '4,5': 5,
};

/** The cost of a step or move from which on it is reported. */
const ISSUE_COST = 2.5;

/** The time in seconds below which hand movements cost extra. */
const FAST = 0.15;

/** The black keys of an octave, by pitch class. */
const BLACK = new Set([1, 3, 6, 8, 10]);

const isBlack = (midi: number): boolean => BLACK.has(((midi % 12) + 12) % 12);

/** The ways to choose `k` of the fingers 1 to 5, each in ascending order. */
const COMBOS: number[][][] = [[[]], [], [], [], [], []];

for (let k = 1; k <= 5; k++) {
  const out: number[][] = [];
  const walk = (from: number, acc: number[]) => {
    if (acc.length === k) out.push(acc);
    else for (let f = from; f <= 5; f++) walk(f + 1, [...acc, f]);
  };
  walk(1, []);
  COMBOS[k] = out;
}

/** The fingers of the keys of a step for a way of choosing them: ascending with pitch in the right hand, descending in the left. */
function assign(combo: number[], hand: 'L' | 'R'): number[] {
  return hand === 'R' ? combo : [...combo].reverse();
}

/** The cost of the fingers on the keys of one step: fingers out of reach of one another, fingers crowded together, and the weak fingers on black keys. */
function chordCost(keys: FKey[], fingers: number[], scale: number): Part | null {
  let cost = 0;
  let why = '';
  let worst = 0;
  const add = (c: number, w: string) => {
    cost += c;
    if (c > worst) {
      worst = c;
      why = w;
    }
  };
  for (let i = 0; i < keys.length; i++) {
    const f = fingers[i];
    if (isBlack(keys[i].midi)) {
      // In a chord or octave the hand is set and the thumb on a black key is ordinary; in a line it is a place to avoid.
      if (f === 1) add(keys.length > 1 ? 0.3 : 1, 'thumb on a black key');
      else if (f === 5) add(0.3, 'little finger on a black key');
    }
    if (f === 4) add(0.3, 'fourth finger');
    // Fingers are spread as the keys are: a wide interval wants far-apart fingers (a fifth the thumb and little finger), a narrow one neighbors.
    if (i + 1 < keys.length)
      cost += 0.1 * Math.abs(Math.abs(fingers[i + 1] - f) - (keys[i + 1].midi - keys[i].midi) / 1.8);
    for (let j = i + 1; j < keys.length; j++) {
      const g = fingers[j];
      const a = Math.min(f, g);
      const b = Math.max(f, g);
      const reach = (REACH[`${a},${b}`] ?? 0) * scale;
      const d = Math.abs(keys[j].midi - keys[i].midi);
      if (d > reach) return null;
      const comfort = reach - 2;
      if (d > comfort) add(0.6 * (d - comfort) ** 2, 'stretch between fingers');
      if (b - a > 1 && d < b - a) add(0.5 * (b - a - d), 'fingers crowded together');
    }
  }
  return { cost, why };
}

/** The cost of the move of a hand from one single note to the next with fingers `f1` and `f2`, `sec` seconds apart; `dir` is 1 for the right hand and -1 for the left, `limit` the span of the hand. */
function pairCost(p1: number, f1: number, p2: number, f2: number, sec: number, dir: number, limit: number): Part {
  const d = (p2 - p1) * dir;
  const size = Math.abs(d);
  // A move beyond the span of the hand is a leap, which the check of the hands judges by the time it has; no finger rule applies.
  if (size > limit) return { cost: 0.5, why: 'leap' };
  const hurry = 1 + (Math.max(0, FAST - sec) / FAST) * 1.5;
  if (size === 0) return { cost: f1 === f2 ? (sec < 0.09 ? 2 : 0) : 0.3, why: 'fast repeated finger' };
  // The same finger on two different keys is a slide, fine over a semitone and rare over a tone; over more it is a jump of the whole hand, which no legato figure uses.
  if (f1 === f2)
    return {
      cost: (size <= 1 ? 0.5 : size === 2 ? 1.5 : 3 + 0.3 * size) * hurry,
      why: 'same finger on different keys',
    };
  const outward = d > 0;
  if (outward === f2 > f1) {
    // The fingers go the way the notes go: only the stretch counts, and fingers far apart on close notes.
    const gap = Math.abs(f2 - f1);
    const reach = REACH[`${Math.min(f1, f2)},${Math.max(f1, f2)}`] ?? 0;
    if (size > reach) return { cost: 6 * hurry, why: 'change of hand position' };
    if (size < gap) return { cost: 0.5 * (gap - size), why: 'fingers crowded together' };
    return { cost: 0, why: '' };
  }
  // The fingers go against the way the notes go: the thumb has to pass under a finger, or a finger over the thumb.
  const thumb = outward ? f2 === 1 : f1 === 1;
  const other = outward ? f1 : f2;
  if (!thumb) return { cost: 6 * hurry, why: 'change of hand position' };
  const onBlack = isBlack(outward ? p2 : p1) ? 1 : 0;
  // The thumb under the third or fourth finger, or those over the thumb, is the crossing of every scale: it costs
  // the same at any speed. Under the index finger or the little finger it is hard, and harder the faster it goes.
  if (other === 3 || other === 4) return { cost: 1.5 + onBlack, why: 'thumb crossing' };
  return { cost: ((other === 5 ? 4 : 2) + onBlack) * hurry, why: 'thumb crossing' };
}

/** The cost of the move between two steps that are not both single notes: a little for how far the hand moves (the speed of a long move is judged by the check of the hands). */
function shiftCost(a: FKey[], b: FKey[]): Part {
  const mean = (ks: FKey[]) => ks.reduce((s, k) => s + k.midi, 0) / ks.length;
  const shift = Math.abs(mean(b) - mean(a));
  return { cost: Math.min(0.5, 0.15 * Math.max(0, shift - 5)), why: 'change of hand position' };
}

/** One way of fingering a step, with its cost so far and the way back. */
interface Way {
  fingers: number[];
  cost: number;
  prev: number;
  /** The cost of this step and the move into it, with the reason that weighs most. */
  own: Part;
}

/** Fingers the keys of one hand step by step; `maxSpan` is the widest span of the hand (the reach of the finger pairs scales with it). */
export function fingerHand(steps: FStep[], hand: 'L' | 'R', maxSpan: number): Fingered {
  const scale = maxSpan / 14;
  const dir = hand === 'R' ? 1 : -1;
  const all: Way[][] = [];
  const issues: FIssue[] = [];
  const fingers: number[][] = steps.map(() => []);
  let before: Way[] = [];
  steps.forEach((step, k) => {
    const ways: Way[] = [];
    for (const combo of COMBOS[step.keys.length] ?? []) {
      const f = assign(combo, hand);
      const here = chordCost(step.keys, f, scale);
      if (!here) continue;
      if (step.fresh || !before.length) {
        ways.push({ fingers: f, cost: here.cost, prev: -1, own: here });
        continue;
      }
      const last = steps[k - 1];
      let best: Way | undefined;
      for (let bi = 0; bi < before.length; bi++) {
        const a = before[bi];
        if (step.keys.some((key, i) => key.held >= 0 && a.fingers[key.held] !== f[i])) continue;
        const move =
          last.keys.length === 1 && step.keys.length === 1
            ? pairCost(last.keys[0].midi, a.fingers[0], step.keys[0].midi, f[0], step.sec - last.sec, dir, maxSpan)
            : shiftCost(last.keys, step.keys);
        const cost = a.cost + here.cost + move.cost;
        if (!best || cost < best.cost) {
          const dominant = move.cost > here.cost ? move : here;
          best = { fingers: f, cost, prev: bi, own: { cost: here.cost + move.cost, why: dominant.why } };
        }
      }
      if (best) ways.push(best);
    }
    if (!ways.length) {
      // No way to finger this step (out of reach for every finger pair, or held fingers in the way): say so and start afresh.
      issues.push({ step: k, cost: Number.POSITIVE_INFINITY, why: 'no comfortable fingering' });
      all.push([]);
      before = [];
      return;
    }
    all.push(ways);
    before = ways;
  });
  let idx = -2;
  for (let k = steps.length - 1; k >= 0; k--) {
    if (!all[k].length) {
      idx = -2;
      continue;
    }
    if (idx === -2) idx = all[k].reduce((best, w, i) => (w.cost < all[k][best].cost ? i : best), 0);
    const way = all[k][idx];
    fingers[k] = way.fingers;
    if (way.own.cost >= ISSUE_COST) issues.push({ step: k, cost: way.own.cost, why: way.own.why });
    idx = way.prev;
    if (idx === -1) idx = -2;
  }
  return { fingers, issues: issues.sort((a, b) => a.step - b.step) };
}
