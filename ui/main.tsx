// Entry point: load the music font, restore the last document (or an empty score), mount the app.
// The engraver needs the font before its first run, so nothing renders until `initFonts` resolves.

import { render } from 'preact';

import { must } from '../src/util.ts';
import { App } from './App.tsx';
import { initFonts } from './fonts.ts';
import * as interact from './interact.ts';
import * as state from './state.ts';
import { loadText, NEW_SCORE_TEXT, ready, restore, showText } from './state.ts';

initFonts().then(() => {
  ready.value = true;
  const saved = restore();
  if (!(saved && loadText(saved, 'score.txt'))) loadText(NEW_SCORE_TEXT, 'untitled.txt');
  if (location.hash === '#text') showText.value = true;
  if (import.meta.env.DEV) Object.assign(window, { __t: { ...state, interact } }); // These are handles for scripted tests.
  render(<App />, must(document.getElementById('app')));
});
