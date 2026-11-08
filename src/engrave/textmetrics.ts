// Text widths. The renderer has no font to measure with, so the widths of the characters of the
// font it asks for (Liberation Serif, which has the metrics of Times) are tabulated here for spacing
// and for the collision check.

/** Advance widths of Liberation Serif (as Times), per 1000 em, for the characters of lyrics and labels: `character` then width. */
const TABLE =
  'a444 b500 c444 d500 e444 f333 g500 h500 i278 j278 k500 l278 m778 n500 o500 p500 q500 r333 s389 t278 u500 v500 w722 x500 y500 z444 ' +
  'A722 B667 C667 D722 E611 F556 G722 H722 I333 J389 K722 L611 M889 N722 O722 P556 Q722 R667 S556 T611 U722 V722 W944 X722 Y722 Z611 ' +
  ',250 .250 ;278 :278 !333 ?444 \'333 ’333 -333 "408 (333 )333';

const ADVANCE = new Map<string, number>([
  [' ', 250],
  ...TABLE.split(' ').map((e): [string, number] => [e[0], Number(e.slice(1))]),
]);

/** The width of `text` at font size `size`: letters by their advance (an accented letter like its base letter, anything else like an "o"). */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text.normalize('NFD')) {
    if (/\p{M}/u.test(ch)) continue;
    w += /\d/.test(ch) ? 500 : (ADVANCE.get(ch) ?? 500);
  }
  return (w / 1000) * size;
}
