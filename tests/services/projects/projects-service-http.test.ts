/**
 * @fileoverview ProjectsService against the framework's real fetch, status
 * mapping, and retry loop, with only the global `fetch` stubbed. Covers how each
 * upstream status is classified — a query the API cannot parse apart from an
 * upstream failure — how many attempts each one gets, and the call deadline
 * every request runs under.
 * @module tests/services/projects/projects-service-http.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';
import {
  CALL_DEADLINE_MS,
  isCallDeadlineExceeded,
  withCallDeadline,
} from '@/services/call-deadline.js';
import { initProjectsService, ProjectsService } from '@/services/projects/projects-service.js';
import { answerAfter, held } from '../../helpers/held-fetch.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    pipBaseUrl: 'https://api.worldbank.org/pip/v1',
    projectsBaseUrl: 'https://search.worldbank.org/api/v3',
    defaultPerPage: 50,
    clampLimits: true,
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

  it('probes an empty filtered search with only its country codes', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ total: '0', projects: {} }))
      .mockResolvedValueOnce(Response.json({ total: '834', projects: {} }));
    const service = new ProjectsService({} as never, createInMemoryStorage());
    const result = await service.searchProjects(
      { ...baseOpts, countryCodes: ['BR'], statuses: ['Active'] },
      createMockContext(),
    );

    expect(result).toMatchObject({ countryOnlyTotal: 834, projects: [], total: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const probe = new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams;
    expect(probe.get('countrycode_exact')).toBe('BR');
    expect(probe.get('rows')).toBe('0');
    expect(probe.has('status_exact')).toBe(false);
  });

  it('projects and renders published portfolio metadata, zero cost, and absent fields', async () => {
    initProjectsService({} as never, createInMemoryStorage());
    fetchMock.mockResolvedValueOnce(
      Response.json({
        total: '3',
        projects: {
          P517775: {
            id: 'P517775',
            curr_project_cost: '10000000000',
            curr_total_commitment: '5000000',
            esrc_ovrl_risk_rate: 'M',
            parentprojid: 'P180547',
          },
          P519330: { id: 'P519330', curr_project_cost: '0' },
          P510604: {
            id: 'P510604',
            countryname: 'Eastern and Southern Africa',
            borrower: 'Eastern Africa Power Pool',
            impagency: 'Eastern Africa Power Pool General Secretariat',
          },
        },
      }),
    );

    const result = await runToolContract(worldbankSearchProjects, { per_page: 3 });
    expect(result.structuredContent).toMatchObject({
      projects: [
        {
          id: 'P517775',
          projectCost: 10_000_000_000,
          totalCommitment: 5_000_000,
          esRiskRating: 'M',
          parentProjectId: 'P180547',
          borrower: null,
          implementingAgency: null,
        },
        { id: 'P519330', projectCost: 0, esRiskRating: null, parentProjectId: null },
        {
          id: 'P510604',
          countryName: 'Eastern and Southern Africa',
          borrower: 'Eastern Africa Power Pool',
          implementingAgency: 'Eastern Africa Power Pool General Secretariat',
          projectCost: null,
        },
      ],
    });
    const content = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    for (const field of [
      '**projectCost:** 10,000,000,000 USD',
      '**projectCost:** 0 USD',
      '**projectCost:** null',
      '**esRiskRating:** M',
      '**esRiskRating:** null',
      '**parentProjectId:** P180547',
      '**parentProjectId:** null',
      '**borrower:** Eastern Africa Power Pool',
      '**borrower:** null',
      '**implementingAgency:** Eastern Africa Power Pool General Secretariat',
      '**implementingAgency:** null',
    ]) {
      expect(content).toContain(field);
    }
    const fields = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('fl')?.split(',');
    expect(fields).toEqual(
      expect.arrayContaining([
        'borrower',
        'impagency',
        'curr_project_cost',
        'esrc_ovrl_risk_rate',
        'parentprojid',
      ]),
    );
  });

  it('combines portfolio filters and excludes them from the country-only probe', async () => {
    initProjectsService({} as never, createInMemoryStorage());
    fetchMock
      .mockResolvedValueOnce(Response.json({ total: '0', projects: {} }))
      .mockResolvedValueOnce(Response.json({ total: '834', projects: {} }));
    const result = await runToolContract(worldbankSearchProjects, {
      countries: 'BR',
      es_risk_rating: ['H', 'S'],
      parent_project_id: 'P176758',
    });

    expect(result.structuredContent).toMatchObject({
      projects: [],
      totalCount: 0,
      appliedFilters: { countries: 'BR', esRiskRating: 'H,S', parentProjectId: 'P176758' },
      notice: expect.stringContaining('es_risk_rating, parent_project_id narrowed'),
    });
    const content = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(content).toContain('es_risk_rating=H,S');
    expect(content).toContain('parent_project_id=P176758');
    expect(content).toContain('match 834 projects');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const search = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(search.get('countrycode_exact')).toBe('BR');
    expect(search.get('esrc_ovrl_risk_rate_exact')).toBe('H^S');
    expect(search.get('parentprojid_exact')).toBe('P176758');
    const probe = new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams;
    expect(probe.get('countrycode_exact')).toBe('BR');
    expect(probe.get('rows')).toBe('0');
    expect(probe.has('esrc_ovrl_risk_rate_exact')).toBe(false);
    expect(probe.has('parentprojid_exact')).toBe(false);
  });

  it('caps a filtered search at 1,000 rows and echoes the filters on a page past the end', async () => {
    initProjectsService({} as never, createInMemoryStorage());
    fetchMock.mockResolvedValueOnce(Response.json({ total: '1', projects: {} }));
    const result = await runToolContract(worldbankSearchProjects, {
      es_risk_rating: ['S'],
      parent_project_id: 'P176758',
      page: 2,
      per_page: 1_001,
    });
    expect(result.structuredContent).toMatchObject({
      projects: [],
      totalCount: 1,
      currentPage: 2,
      totalPages: 1,
      appliedFilters: {
        esRiskRating: 'S',
        parentProjectId: 'P176758',
        perPage: 1_000,
        requestedPerPage: 1_001,
      },
      notice: expect.stringContaining('Page 2 is past the end'),
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Page 2 is past the end') }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const search = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(search.get('rows')).toBe('1000');
    expect(search.get('os')).toBe('1000');
    expect(search.get('esrc_ovrl_risk_rate_exact')).toBe('S');
    expect(search.get('parentprojid_exact')).toBe('P176758');
  });

  it('reports an offset outside the upstream bound with its recovery hint', async () => {
    initProjectsService({} as never, createInMemoryStorage());
    const result = await runToolContract(worldbankSearchProjects, {
      parent_project_id: 'P176758',
      page: 102,
      per_page: 1_000,
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'page_out_of_range',
            recovery: { hint: expect.stringContaining('Lower the page number') },
          },
        },
      },
      content: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Lower the page number') }),
      ]),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ es_risk_rating: ['H', 'h'] }, ['es_risk_rating', 1], 'invalid_value'],
    [{ es_risk_rating: [] }, ['es_risk_rating'], 'too_small'],
    [{ parent_project_id: 'P176758^P180547' }, ['parent_project_id'], 'invalid_format'],
  ])('rejects malformed portfolio filters before querying: %j', async (input, path, code) => {
    initProjectsService({} as never, createInMemoryStorage());
    const result = await runToolContract(worldbankSearchProjects, input as never);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'invalid_arguments',
            issues: [expect.objectContaining({ path, code })],
          },
        },
      },
      content: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining(String(path[0])) }),
      ]),
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
