// Entry point: load the music font, restore the last document (or an empty score), mount the app.
// The engraver needs the font before its first run, so nothing renders until `initFonts` resolves.

import { render } from 'preact';

import { must } from '../src/util.ts';
import { App } from './App.tsx';
import { initFonts } from './fonts.ts';
import * as interact from './interact.ts';
import * as midiin from './midiin.ts';
import { hasRealPaths } from './native.ts';
import * as state from './state.ts';
import { fileName, filePath, loadText, NEW_SCORE_TEXT, ready, restore, restoreFile, showText } from './state.ts';

initFonts().then(() => {
  ready.value = true;
  const saved = restore();
  const file = restoreFile();
  if (saved && loadText(saved, file?.name ?? 'score.txt')) {
    // The restored score belongs to the file it was last saved to, so Save writes there again.
    if (file && hasRealPaths) {
      filePath.value = file.path;
      fileName.value = file.name;
    }
  } else loadText(NEW_SCORE_TEXT, 'untitled.txt');
  if (location.hash === '#text') showText.value = true;
  if (import.meta.env.DEV) Object.assign(window, { __t: { ...state, interact, midiin } }); // These are handles for scripted tests.
  render(<App />, must(document.getElementById('app')));
});
