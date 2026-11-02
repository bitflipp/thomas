/** Returns `v`, or throws when an invariant ("this is always there") turns out to be false. */
export function must<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`internal error: missing ${what}`);
  return v;
}
