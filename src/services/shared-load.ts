/**
 * @fileoverview Loads shared by concurrent requests. A reference listing is
 * fetched once and awaited by every request that needs it, so the fetch must
 * not run under any one request's `AbortSignal`: one caller cancelling would
 * fail every other caller waiting on the same load. The load runs under a
 * signal of its own, bounded by a timeout, and each caller waits on it only
 * until its own signal aborts.
 * @module services/shared-load
 */

import type { Context } from '@cyanheads/mcp-ts-core';

/**
 * The context a shared load runs under: the starting caller's logger and
 * identifiers, with a signal that belongs to no caller and aborts only when
 * `timeoutMs` elapses.
 */
export function sharedLoadContext(ctx: Context, timeoutMs: number): Context {
  return { ...ctx, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Settle as `shared` does, or reject with the caller's abort reason as soon as
 * `signal` aborts. The shared load carries on for its other waiters, and its
 * outcome is always observed, so a load every caller abandoned never surfaces
 * as an unhandled rejection.
 */
export function untilAborted<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
