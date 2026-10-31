import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseText } from '../src/textformat.ts';
import { engrave } from '../src/engrave/system.ts';
import { findCollisions, describe } from '../src/engrave/collide.ts';

// Known engraver limitations on the reference piece: "kindA x kindB" (sorted) -> how many are tolerated.
// Fix one, lower the number; nothing outside this table may collide (allowlist: src/engrave/collide.ts).
const KNOWN: Record<string, number> = {
  'acc x tie': 1,
  'ledger x tie': 1,
};

test('the reference piece has no collisions outside the allowlist', () => {
  const score = parseText(readFileSync(new URL('../examples/gewitter.txt', import.meta.url), 'utf8'));
  const cs = findCollisions(engrave(score, { respectBreaks: true, measureNumbers: 'system' }).pages);
  const seen = new Map<string, string[]>();
  for (const c of cs) {
    const k = [c.a.k, c.b.k].sort().join(' x ');
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k)!.push(describe(c));
  }
  const bad: string[] = [];
  for (const [k, list] of seen) if (list.length > (KNOWN[k] ?? 0)) bad.push(...list);
  assert.deepEqual(bad, []);
});

test('collision policy: overlapping unrelated elements are reported, allowlisted pairs are not', () => {
  const pages = [{ width: 10, height: 10, prims: [
    { t: 'line' as const, x1: 1, y1: 0, x2: 1, y2: 5, w: 0.12, k: 'stem' as const, o: 1 },
    { t: 'line' as const, x1: 0, y1: 2, x2: 3, y2: 2, w: 0.16, k: 'ledger' as const, o: 2 }, // ledger x stem: allowed
    { t: 'line' as const, x1: 0, y1: 2.05, x2: 3, y2: 2.05, w: 0.16, k: 'ledger' as const, o: 3 }, // ledger x ledger: not allowed
  ] }];
  const cs = findCollisions(pages);
  assert.deepEqual(cs.map((c) => [c.a.k, c.b.k].sort().join(' x ')), ['ledger x ledger']);
});
