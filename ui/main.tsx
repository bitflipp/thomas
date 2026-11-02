// Entry point: load the music font, restore the last document (or the bundled example), mount the app.
// The engraver needs the font before its first run, so nothing renders until `initFonts` resolves.
import { render } from 'preact';
import { must } from '../src/util.ts';
import { App } from './App.tsx';
import { initFonts } from './fonts.ts';
import * as interact from './interact.ts';
import * as state from './state.ts';
import { loadText, NEW_SCORE_TEXT, ready, restore, showText } from './state.ts';

const examples = import.meta.glob('../examples/tango.txt', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

initFonts().then(() => {
  ready.value = true;
  const saved = restore();
  if (!(saved && loadText(saved, 'score.txt'))) loadText(Object.values(examples)[0] ?? NEW_SCORE_TEXT, 'tango.txt');
  if (location.hash === '#text') showText.value = true;
  if (import.meta.env.DEV) Object.assign(window, { __t: { ...state, interact } }); // handles for scripted tests
  render(<App />, must(document.getElementById('app')));
});
