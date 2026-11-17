// The analysis worker: runs the playability solver off the main thread (see `analysis.ts` for the client).
//
// The page posts a request with the score and the options; the worker answers with the same id. Nothing here
// keeps state between requests, so a stale request is simply answered and ignored by the client.

import { analyzePlayability, requiredSpan } from '../src/analysis/playability.ts';
import type { Request, Response } from './analysis.ts';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(m: Response): void;
};

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'findings')
    scope.postMessage({ id: m.id, type: 'findings', analysis: analyzePlayability(m.score, m.options) });
  else scope.postMessage({ id: m.id, type: 'span', span: requiredSpan(m.score, m.pedal) });
};
