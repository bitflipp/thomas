// Small helpers shared by all layers; they depend on nothing else in the project.

/** Returns `v`, or throws when an invariant ("this is always there") turns out to be false. */
export function must<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`internal error: missing ${what}`);
  return v;
}

/** Rounds `v` to three decimals and formats it as short text, for SVG attributes and path data. */
export function round3(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
