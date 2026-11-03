// Feeds the engraver its font in the browser. In Node, smufl.ts reads the font from node_modules
// itself; the browser has no file system, so Vite serves the files as URLs and they are fetched here
// once at startup, before the first engraving.

import fontUrl from '../fonts/leland/Leland.otf?url';
import metaUrl from '../fonts/leland/leland_metadata.json?url';
import { setSmuflSource } from '../src/smufl.ts';

export async function initFonts(): Promise<void> {
  const [buf, meta] = await Promise.all([
    fetch(fontUrl).then((r) => r.arrayBuffer()),
    fetch(metaUrl).then((r) => r.json()),
  ]);
  setSmuflSource(buf, meta);
}
