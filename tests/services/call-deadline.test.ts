/**
 * @fileoverview Seam tests for the per-call deadline and the caller's wait on a
 * shared load. Requests run through the framework's real `withRetry` and
 * `fetchWithTimeout` over a stubbed global `fetch`, under fake `setTimeout` and
 * `Date`, so every bound under test is the code's own: the fetch fake never times
 * out by itself, it only answers when told or rejects when its signal aborts.
 * @module tests/services/call-deadline.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_DEADLINE_MS,
  type CallAttempt,
  callDeadlineExceeded,
  callDeadlineRemainingMs,
  isCallDeadlineExceeded,
  retryWithinCallDeadline,
  withCallDeadline,
  withoutCallDeadline,
} from '@/services/call-deadline.js';
import { awaitSharedLoad, sharedLoadContext } from '@/services/shared-load.js';
import { answerAfter, held } from '../helpers/held-fetch.js';

const URL = 'https://api.worldbank.org/v2/country/BRA/indicator/NY.GDP.MKTP.CD?format=json';
const BODY = [{ page: 1, pages: 1 }, [{ value: 1 }]];

const fetchMock = vi.fn<typeof fetch>();

const ok = () => Response.json(BODY);
const status = (code: number) => () => new Response('upstream failure', { status: code });

/** One Indicators API read through the helper, recording each attempt's handle. */
function read(ctx: Context, handles: CallAttempt[] = []) {
  return retryWithinCallDeadline(
    ctx,
    'indicators',
    async (handle) => {
      handles.push(handle);
      const response = await fetchWithTimeout(
        URL,
        handle.timeoutMs,
        ctx as Context & Record<string, unknown>,
        { signal: handle.signal },
      );
      return (await response.json()) as unknown;
    },
    { attemptTimeoutMs: 15_000, baseDelayMs: 1000 },
  );
}

/** Track a promise's settlement without letting a rejection go unobserved. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unplanned fetch'));
  vi.stubGlobal('fetch', fetchMock);
  // Jitter off: each backoff is exactly baseDelayMs × 2^attempt.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('withCallDeadline', () => {
  it('starts a deadline of CALL_DEADLINE_MS without touching the caller context', () => {
    const ctx = createMockContext();
    const call = withCallDeadline(ctx);
    expect(CALL_DEADLINE_MS).toBe(50_000);
    expect(callDeadlineRemainingMs(call)).toBe(50_000);
    expect(callDeadlineRemainingMs(ctx)).toBeUndefined();
    expect(call.signal).toBe(ctx.signal);
    expect(call.log).toBe(ctx.log);
  });

  it('keeps the earlier instant when a deadline is started again', () => {
    const call = withCallDeadline(createMockContext());
    vi.advanceTimersByTime(10_000);
    const again = withCallDeadline(call);
    expect(again).toBe(call);
    expect(callDeadlineRemainingMs(again)).toBe(40_000);
    vi.advanceTimersByTime(45_000);
    expect(callDeadlineRemainingMs(again)).toBe(0);
  });

  it('is dropped by withoutCallDeadline and by a shared load context, which gets its own signal', () => {
    const call = withCallDeadline(createMockContext());
    expect(callDeadlineRemainingMs(withoutCallDeadline(call))).toBeUndefined();
    const shared = sharedLoadContext(call, 255_000);
    expect(callDeadlineRemainingMs(shared)).toBeUndefined();
    expect(shared.signal).not.toBe(call.signal);
    expect(shared.log).toBe(call.log);
    // A deadline started on the shared context is a fresh one, not the caller's.
    vi.advanceTimersByTime(30_000);
    expect(callDeadlineRemainingMs(withCallDeadline(shared))).toBe(50_000);
  });
});

describe('callDeadlineExceeded', () => {
  it.each([
    ['indicators', 'World Bank Indicators API', /Repeat the same call unchanged.*cache/],
    [
      'pip',
      'World Bank Poverty and Inequality Platform (PIP) API',
      /keeps the PIP request running.*answers the repeat/,
    ],
    ['projects', 'World Bank Projects API', /Retry the call shortly, or narrow the request/],
  ] as const)(
    'is a retryable Timeout naming %s, its budget, and its recovery',
    (upstream, name, hint) => {
      const cause = new Error('underlying');
      const error = callDeadlineExceeded(upstream, cause);
      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.message).toBe(
        `The ${name} did not complete the request within the call's 50 s deadline.`,
      );
      expect(error.data).toMatchObject({
        reason: 'upstream_timeout',
        retryable: true,
        budgetMs: 50_000,
        recovery: { hint: expect.stringMatching(hint) },
      });
      expect(error.cause).toBe(cause);
      expect(isCallDeadlineExceeded(error)).toBe(true);
    },
  );

  it('is told apart from the retry ladder’s own expiry and other timeouts', () => {
    expect(isCallDeadlineExceeded(timeout('ladder', { reason: 'retry_deadline_exceeded' }))).toBe(
      false,
    );
    expect(
      isCallDeadlineExceeded(timeout('fetch timed out', { errorSource: 'FetchTimeout' })),
    ).toBe(false);
    expect(isCallDeadlineExceeded(timeout('ran out', { reason: 'upstream_timeout' }))).toBe(false);
    expect(isCallDeadlineExceeded(new Error('upstream_timeout'))).toBe(false);
  });
});

describe('retryWithinCallDeadline on a caller path', () => {
  it('holds one attempt open to the deadline and expires there as upstream_timeout', async () => {
    let inFlight: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      inFlight = init?.signal ?? undefined;
      return held(init);
    });
    const handles: CallAttempt[] = [];
    const outcome = track(read(withCallDeadline(createMockContext()), handles));

    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout', budgetMs: 50_000, retryable: true },
    });
    expect((outcome.error as McpError).cause).toMatchObject({
      data: { reason: 'retry_deadline_exceeded' },
    });
    expect(handles.map((h) => h.timeoutMs)).toEqual([50_000]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inFlight?.aborted).toBe(true);
    expect(inFlight?.reason).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serves a first attempt that answers after 40 s', async () => {
    fetchMock.mockImplementation((_url, init) => answerAfter(40_000, ok, init));
    const outcome = track(read(withCallDeadline(createMockContext())));

    await vi.advanceTimersByTimeAsync(40_000);

    expect(outcome.value).toEqual(BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles a read that answers at once without advancing time, leaving no timer', async () => {
    fetchMock.mockImplementation(async () => ok());
    await expect(read(withCallDeadline(createMockContext()))).resolves.toEqual(BODY);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries an early failure inside the deadline, giving the retry what is left', async () => {
    fetchMock
      .mockImplementationOnce((_url, init) => answerAfter(10_000, status(500), init))
      .mockImplementationOnce(async () => ok());
    const handles: CallAttempt[] = [];
    const outcome = track(read(withCallDeadline(createMockContext()), handles));

    await vi.advanceTimersByTimeAsync(11_000);

    expect(outcome.value).toEqual(BODY);
    // 10 s for the 500, then the 1 s backoff: 39 s left for the retry.
    expect(handles.map((h) => h.timeoutMs)).toEqual([50_000, 39_000]);
  });

  it('retries the HTML "Request Error" style 5xx and labels an exhausted ladder with the upstream', async () => {
    fetchMock.mockImplementation(async () => status(503)());
    const outcome = track(read(withCallDeadline(createMockContext())));

    await vi.advanceTimersByTimeAsync(7_000);

    expect(outcome.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryAttempts: 4, operation: 'World Bank Indicators API request', status: 503 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['mid-backoff, at the deadline', 49_000, 50_000],
    ['before a backoff that would outlast it', 49_500, 49_500],
  ])('expires %s as upstream_timeout', async (_label, failAt, settleAt) => {
    fetchMock.mockImplementationOnce((_url, init) => answerAfter(failAt, status(503), init));
    const outcome = track(read(withCallDeadline(createMockContext())));

    await vi.advanceTimersByTimeAsync(settleAt - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.error).toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when a call starts a request with 1 ms or less left', async () => {
    const call = withCallDeadline(createMockContext());
    vi.advanceTimersByTime(CALL_DEADLINE_MS - 1);

    await expect(read(call)).rejects.toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends no retry when the backoff leaves 1 ms', async () => {
    // Fails with 1,001 ms left; the 1,000 ms backoff leaves the retry 1 ms.
    fetchMock.mockImplementationOnce((_url, init) => answerAfter(48_999, status(503), init));
    const outcome = track(read(withCallDeadline(createMockContext())));

    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);

    expect(outcome.error).toMatchObject({ data: { reason: 'upstream_timeout' } });
    // Thrown by the attempt itself, not re-wrapped from the ladder's own expiry.
    expect((outcome.error as McpError).cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the typed expiry untouched when the last attempt would start with 1 ms left', async () => {
    const call = withCallDeadline(createMockContext());
    vi.advanceTimersByTime(42_999);
    // Three 503s at once, then backoffs of 1, 2, and 4 s (jitter pinned at its midpoint):
    // 4,001 ms are left before the 4 s backoff, so it sleeps, and the fourth and last
    // attempt would start with 1 ms left.
    fetchMock.mockImplementation(async () => status(503)());
    const outcome = track(read(call));

    await vi.advanceTimersByTimeAsync(7_000);

    expect(outcome.error).toBeInstanceOf(McpError);
    const error = outcome.error as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe(
      "The World Bank Indicators API did not complete the request within the call's 50 s deadline.",
    );
    // No retryAttempts or operation: the ladder never treated the expiry as an exhausted retry.
    expect(error.data).toEqual({
      reason: 'upstream_timeout',
      retryable: true,
      budgetMs: 50_000,
      recovery: { hint: expect.stringMatching(/Repeat the same call unchanged/) },
    });
    expect(error.cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a caller abort during an attempt as cancellation, reaching the in-flight fetch', async () => {
    const caller = new AbortController();
    const reason = new Error('client went away');
    let inFlight: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      inFlight = init?.signal ?? undefined;
      const pending = held(init);
      caller.abort(reason);
      return pending;
    });

    const outcome = track(read(withCallDeadline(createMockContext({ signal: caller.signal }))));
    await vi.advanceTimersByTimeAsync(0);

    expect(inFlight?.reason).toBe(reason);
    expect(outcome.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(isCallDeadlineExceeded(outcome.error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a caller abort during a backoff as cancellation', async () => {
    const caller = new AbortController();
    const reason = new Error('client went away');
    fetchMock.mockImplementationOnce(async () => status(503)());

    const outcome = track(read(withCallDeadline(createMockContext({ signal: caller.signal }))));
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.settled).toBe(false);
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.error).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a caller abort as cancellation once the deadline is spent too', async () => {
    const caller = new AbortController();
    const call = withCallDeadline(createMockContext({ signal: caller.signal }));
    vi.advanceTimersByTime(CALL_DEADLINE_MS);
    caller.abort(new Error('client went away'));
    fetchMock.mockImplementation((_url, init) => held(init));

    await expect(read(call)).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });
});

describe('retryWithinCallDeadline inside a shared load (no call deadline)', () => {
  it('gives every attempt the fixed attempt timeout and runs past 50 s on its own bound', async () => {
    fetchMock.mockImplementation((_url, init) => held(init));
    const handles: CallAttempt[] = [];
    const outcome = track(read(createMockContext(), handles));

    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS + 1);
    expect(outcome.settled).toBe(false);
    // Four 15 s attempts and 1 + 2 + 4 s of backoff.
    await vi.advanceTimersByTimeAsync(67_000 - CALL_DEADLINE_MS - 2);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        errorSource: 'FetchTimeout',
        retryAttempts: 4,
        operation: 'World Bank Indicators API request',
      },
    });
    expect(handles.map((h) => h.timeoutMs)).toEqual([15_000, 15_000, 15_000, 15_000]);
  });
});

describe('awaitSharedLoad', () => {
  it('ends the wait at the call deadline with the upstream’s expiry while the load runs on', async () => {
    const load = Promise.withResolvers<string>();
    const outcome = track(
      awaitSharedLoad(load.promise, withCallDeadline(createMockContext()), 'pip'),
    );

    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringContaining('World Bank Poverty and Inequality Platform (PIP) API'),
      data: { reason: 'upstream_timeout' },
    });
    expect(vi.getTimerCount()).toBe(0);
    load.resolve('listing');
    await expect(load.promise).resolves.toBe('listing');
  });

  it('settles with the load and clears its timer', async () => {
    const load = Promise.withResolvers<string>();
    const outcome = track(
      awaitSharedLoad(load.promise, withCallDeadline(createMockContext()), 'indicators'),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    load.resolve('listing');
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.value).toBe('listing');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the wait with the caller’s abort reason, ahead of the deadline', async () => {
    const caller = new AbortController();
    const reason = new Error('client went away');
    const load = Promise.withResolvers<string>();
    const outcome = track(
      awaitSharedLoad(
        load.promise,
        withCallDeadline(createMockContext({ signal: caller.signal })),
        'indicators',
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.error).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets an abort that came first win over a spent deadline', async () => {
    const caller = new AbortController();
    const reason = new Error('client went away');
    const call = withCallDeadline(createMockContext({ signal: caller.signal }));
    vi.advanceTimersByTime(CALL_DEADLINE_MS);
    caller.abort(reason);

    await expect(awaitSharedLoad(new Promise(() => {}), call, 'indicators')).rejects.toBe(reason);
  });

  it('waits past 50 s when the context carries no call deadline', async () => {
    const caller = new AbortController();
    const load = Promise.withResolvers<string>();
    const outcome = track(
      awaitSharedLoad(load.promise, createMockContext({ signal: caller.signal }), 'indicators'),
    );
    await vi.advanceTimersByTimeAsync(2 * CALL_DEADLINE_MS);
    expect(outcome.settled).toBe(false);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.error).toBe(caller.signal.reason);
  });
});
