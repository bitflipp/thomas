// The client of the analysis worker: asks for the playability findings and the span a piece needs without
// blocking the page, and falls back to solving on the main thread where workers are not available.
//
// Requests are numbered by the caller, which ignores answers that are not the latest (the score changed
// meanwhile). The worker is created on first use.

import type { Analysis, PedalMode, PlayOptions } from '../src/analysis/playability.ts';
import { analyzePlayability, requiredSpan } from '../src/analysis/playability.ts';
import type { Score } from '../src/model.ts';

/** What the page asks the worker for. */
export type Request =
  | { id: number; type: 'findings'; score: Score; options: PlayOptions }
  | { id: number; type: 'span'; score: Score; pedal: PedalMode };

/** What the worker answers. */
export type Response =
  | { id: number; type: 'findings'; analysis: Analysis }
  | { id: number; type: 'span'; span: number | null };

let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, (r: Response) => void>();

/** The worker, created on first use; null when the browser cannot run one (then the work is done here). */
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Response>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => {
      // The worker could not be started: answer what is pending from here, and keep solving here.
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Posts a request and resolves with its answer; without a worker the answer is computed at once. */
function ask(make: (id: number) => Request): Promise<Response> {
  const id = nextId++;
  const req = make(id);
  const w = getWorker();
  if (!w)
    return Promise.resolve(
      req.type === 'findings'
        ? { id, type: 'findings', analysis: analyzePlayability(req.score, req.options) }
        : { id, type: 'span', span: requiredSpan(req.score, req.pedal) },
    );
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage(req);
  });
}

/** The playability findings of the score and the hand of every note. */
export async function analyze(score: Score, options: PlayOptions): Promise<Analysis> {
  const r = await ask((id) => ({ id, type: 'findings', score, options }));
  return r.type === 'findings' ? r.analysis : { findings: [], hands: [], fingers: [] };
}

/** The span the score needs, in semitones, or null when no span helps. */
export async function spanNeeded(score: Score, pedal: PedalMode): Promise<number | null> {
  const r = await ask((id) => ({ id, type: 'span', score, pedal }));
  return r.type === 'span' ? r.span : null;
}
