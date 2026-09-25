/**
 * @fileoverview ProjectsService against the framework's real fetch, status
 * mapping, and retry loop, with only the global `fetch` stubbed. Covers how each
 * upstream status is classified — a query the API cannot parse apart from an
 * upstream failure — and how many attempts each one gets.
 * @module tests/services/projects/projects-service-http.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsService } from '@/services/projects/projects-service.js';

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
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status });
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
