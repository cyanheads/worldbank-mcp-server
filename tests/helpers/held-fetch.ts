/**
 * @fileoverview tests/helpers/held-fetch.ts — Fetch fakes for call-deadline
 * tests: they never time out by themselves, so whatever settles a held request
 * is the code under test.
 * @module tests/helpers/held-fetch
 */

/** A fetch that never answers, rejecting with its signal's reason once that aborts. */
export function held(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** A fetch answered with `response` after `ms` of fake time, unless its signal aborts first. */
export function answerAfter(
  ms: number,
  response: () => Response,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init?.signal;
    const timer = setTimeout(() => resolve(response()), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
