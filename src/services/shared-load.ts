/**
 * @fileoverview Loads shared by concurrent requests. A reference listing is
 * fetched once and awaited by every request that needs it, so the fetch must
 * not run under any one request's `AbortSignal` or call deadline: one caller
 * cancelling or running out of time would fail every other caller waiting on the
 * same load. The load runs under a signal of its own, bounded by a timeout, and
 * each caller waits on it only until its own signal aborts or its call deadline
 * passes — after which the load still completes and caches for the next call.
 * @module services/shared-load
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  callDeadlineExceeded,
  callDeadlineRemainingMs,
  type Upstream,
  withoutCallDeadline,
} from '@/services/call-deadline.js';

/**
 * The context a shared load runs under: the starting caller's logger and
 * identifiers, with no call deadline and a signal that belongs to no caller and
 * aborts only when `timeoutMs` elapses.
 */
export function sharedLoadContext(ctx: Context, timeoutMs: number): Context {
  return { ...withoutCallDeadline(ctx), signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Settle as `shared` does, or reject with the caller's abort reason as soon as
 * `signal` aborts. The shared load carries on for its other waiters, and its
 * outcome is always observed, so a load every caller abandoned never surfaces
 * as an unhandled rejection. {@link awaitSharedLoad} composes the call deadline
 * into `signal`.
 */
function untilAborted<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * A caller's wait on a shared load: settle as `shared` does, or reject as soon as
 * the caller's signal aborts (with its reason) or the call deadline `ctx` carries
 * passes (with `upstream`'s {@link callDeadlineExceeded}) — the caller's abort
 * winning a tie. Only the wait ends; the load runs on under its own bound.
 */
export function awaitSharedLoad<T>(
  shared: Promise<T>,
  ctx: Context,
  upstream: Upstream,
): Promise<T> {
  const remainingMs = callDeadlineRemainingMs(ctx);
  if (remainingMs === undefined) return untilAborted(shared, ctx.signal);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(callDeadlineExceeded(upstream)), remainingMs);
  return untilAborted(shared, AbortSignal.any([ctx.signal, deadline.signal])).finally(() =>
    clearTimeout(timer),
  );
}
