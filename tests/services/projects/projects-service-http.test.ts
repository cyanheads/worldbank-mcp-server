/**
 * @fileoverview ProjectsService against the framework's real fetch, status
 * mapping, and retry loop, with only the global `fetch` stubbed. Covers how each
 * upstream status is classified — a query the API cannot parse apart from an
 * upstream failure — how many attempts each one gets, and the call deadline
 * every request runs under.
 * @module tests/services/projects/projects-service-http.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_DEADLINE_MS,
  isCallDeadlineExceeded,
  withCallDeadline,
} from '@/services/call-deadline.js';
import { ProjectsService } from '@/services/projects/projects-service.js';
import { answerAfter, held } from '../../helpers/held-fetch.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    pipBaseUrl: 'https://api.worldbank.org/pip/v1',
    projectsBaseUrl: 'https://search.worldbank.org/api/v3',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

const fetchMock = vi.fn<typeof fetch>();

/** Answer every Projects request with `status`, and count the attempts. */
function serveStatus(status: number, headers: Record<string, string> = {}) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://search.worldbank.org/api/v3/projects?')) {
      throw new Error(`unmocked fetch: ${url}`);
    }
    return new Response(
      '{"Debug":true,"error":"400 - Invalid","RequestUrl":"https://itsdt-externalsearchapi-prod.search.windows.net/indexes/projects-dl-index/docs/search"}',
      { status, headers: { 'content-type': 'application/json', ...headers } },
    );
  });
}

const baseOpts = {
  countryCodes: [] as string[],
  statuses: [] as string[],
  regions: [] as string[],
  financialTypes: [] as string[],
  includeAbstract: false,
  includeThemes: false,
  page: 1,
  perPage: 10,
};

/**
 * Run a search to rejection, stepping the fake clock through the retry
 * backoff so a four-attempt ladder settles without sleeping for real.
 */
async function rejection(opts: Parameters<ProjectsService['searchProjects']>[0]) {
  const service = new ProjectsService({} as never, createInMemoryStorage());
  let settled = false;
  const outcome = service.searchProjects(opts, createMockContext()).then(
    () => {
      settled = true;
      throw new Error('expected the search to fail');
    },
    (error: unknown) => {
      settled = true;
      return error as { code: number; message: string; data: Record<string, unknown> };
    },
  );
  while (!settled) await vi.advanceTimersByTimeAsync(500);
  return outcome;
}

describe('ProjectsService over the real fetch and retry path', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports an HTTP 400 on a search carrying query as invalid_query, attempted once', async () => {
    serveStatus(400);
    const error = await rejection({ ...baseOpts, query: 'water [' });

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_query', status: 400, retryable: false });
    expect(error.message).toMatch(/could not parse the query "water \["/);
    // The body names the search cluster behind the API; it stays out.
    expect(error.message).not.toMatch(/search\.windows\.net|projects-dl-index/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an HTTP 400 on a search without query as upstream_unavailable, attempted once', async () => {
    serveStatus(400);
    const error = await rejection({ ...baseOpts, countryCodes: ['BR'] });

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 400,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 408, 500, 502, 503, 504])(
    'retries an HTTP %i as upstream_unavailable, query or not, without marking it unretryable',
    async (status) => {
      serveStatus(status);
      const error = await rejection({ ...baseOpts, query: 'water' });

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_unavailable',
        status,
        operation: 'World Bank Projects API request',
      });
      expect(error.data).not.toHaveProperty('retryable');
      // The framework's default budget: one attempt plus three retries.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    },
  );

  it('forwards an upstream Retry-After, so the retry waits the window it names', async () => {
    serveStatus(429, { 'retry-after': '7' });
    const error = await rejection({ ...baseOpts, query: 'water' });

    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryAfter: '7' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([403, 404, 501])(
    'does not retry an HTTP %i the framework treats as settled, and never calls it a query error',
    async (status) => {
      serveStatus(status);
      const error = await rejection({ ...baseOpts, query: 'water' });

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_unavailable',
        status,
        retryable: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

// ─── Call deadline ────────────────────────────────────────────────────────────

/** Track a promise's settlement without letting a rejection go unobserved. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const emptyPage = () =>
  Response.json({ rows: 0, os: '0', page: '1', total: '0', projects: {}, facets: {} });

/**
 * The deadline mechanism itself is tabled in tests/services/call-deadline.test.ts;
 * these prove the Projects service runs every request it makes under it.
 */
describe('ProjectsService under the call deadline', () => {
  const service = () => new ProjectsService({} as never, createInMemoryStorage());

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
    // Jitter off: each backoff is exactly baseDelayMs × 2^attempt.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('holds a stalled request open to the 50 s deadline and expires there as upstream_timeout', async () => {
    let inFlight: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      inFlight = init?.signal ?? undefined;
      return held(init);
    });
    const outcome = track(
      service().searchProjects({ ...baseOpts, query: 'water' }, createMockContext()),
    );

    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringContaining('World Bank Projects API'),
      data: {
        reason: 'upstream_timeout',
        retryable: true,
        budgetMs: 50_000,
        recovery: { hint: expect.stringContaining('narrow the request') },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inFlight?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a 5xx inside the deadline, giving the retry only what is left', async () => {
    fetchMock
      .mockImplementationOnce((_url, init) =>
        answerAfter(30_000, () => new Response('busy', { status: 503 }), init),
      )
      .mockImplementationOnce((_url, init) => held(init));
    const outcome = track(
      service().searchProjects({ ...baseOpts, query: 'water' }, createMockContext()),
    );

    // 30 s for the 503 and a 1 s backoff leave the retry 19 s, not a fresh budget.
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
    expect(outcome.settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.error).toMatchObject({ data: { reason: 'upstream_timeout' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('spends the same deadline on the zero-hit country probe and keeps the empty result when the probe runs out of it', async () => {
    fetchMock
      .mockImplementationOnce((_url, init) => answerAfter(45_000, emptyPage, init))
      .mockImplementationOnce((_url, init) => held(init));
    const outcome = track(
      service().searchProjects(
        { ...baseOpts, countryCodes: ['BR'], statuses: ['Pipeline'] },
        createMockContext(),
      ),
    );

    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.value).toMatchObject({ projects: [], total: 0, countryOnlyTotal: null });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('rows')).toBe('0');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a caller abort during the request as cancellation, reaching the in-flight fetch', async () => {
    const caller = new AbortController();
    const reason = new Error('client went away');
    let inFlight: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      inFlight = init?.signal ?? undefined;
      const pending = held(init);
      caller.abort(reason);
      return pending;
    });
    const outcome = track(
      service().searchProjects(
        { ...baseOpts, query: 'water' },
        createMockContext({ signal: caller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(inFlight?.reason).toBe(reason);
    expect(outcome.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(isCallDeadlineExceeded(outcome.error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the call reaches the Projects API with 1 ms or less left', async () => {
    const call = withCallDeadline(createMockContext());
    vi.advanceTimersByTime(CALL_DEADLINE_MS - 1);

    await expect(
      service().searchProjects({ ...baseOpts, query: 'water' }, call),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
