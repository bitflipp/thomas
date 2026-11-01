import { render } from 'preact';
import { initFonts } from './fonts.ts';
import { loadText, restore, showText, ready, NEW_SCORE_TEXT } from './state.ts';
import { App } from './App.tsx';
import * as state from './state.ts';
import * as interact from './interact.ts';

const examples = import.meta.glob('../examples/tango.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

initFonts().then(() => {
  ready.value = true;
  const saved = restore();
  if (!(saved && loadText(saved, 'score.txt'))) loadText(Object.values(examples)[0] ?? NEW_SCORE_TEXT, 'tango.txt');
  if (location.hash === '#text') showText.value = true;
  if (import.meta.env.DEV) Object.assign(window, { __t: { ...state, interact } }); // handles for scripted tests
  render(<App />, document.getElementById('app')!);
});
