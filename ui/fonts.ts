// Feed the engraver its font in the browser (the Node build reads it from node_modules).
import { setSmuflSource } from '../src/smufl.ts';
import fontUrl from '../node_modules/@vexflow-fonts/bravura/bravura.otf?url';
import metaUrl from '../node_modules/@vexflow-fonts/bravura/metadata.json?url';

export async function initFonts(): Promise<void> {
  const [buf, meta] = await Promise.all([fetch(fontUrl).then((r) => r.arrayBuffer()), fetch(metaUrl).then((r) => r.json())]);
  setSmuflSource(buf, meta);
}
