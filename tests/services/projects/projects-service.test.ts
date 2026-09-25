/**
 * @fileoverview Tests for ProjectsService — normalization of the ID-keyed
 * response object into rows, offset pagination and the row ceiling upstream
 * silently enforces, caret-joined multi-value filters, the zero-hit country
 * probe, and classification of upstream failures without leaking their bodies.
 * @module tests/services/projects/projects-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── fetchWithTimeout mock ────────────────────────────────────────────────────
// Hoisted so the mock is in place before the service module resolves the dep.
// The real status classification and retry loop are covered against a stubbed
// global fetch in projects-service-http.test.ts.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

const CONFIG = {
  apiBaseUrl: 'https://api.worldbank.org/v2',
  pipBaseUrl: 'https://api.worldbank.org/pip/v1',
  projectsBaseUrl: 'https://search.worldbank.org/api/v3',
  defaultPerPage: 50,
  catalogCacheTtlMs: 60_000,
};

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue(CONFIG),
}));

// ─── Raw payload helpers ──────────────────────────────────────────────────────

/** One project record as the endpoint publishes it under the requested `fl` list. */
function rawProject(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    proj_id: id,
    project_name: `Project ${id}`,
    status: 'Active',
    countryname: 'Federative Republic of Brazil',
    countrycode: ['BR'],
    regionname: 'Latin America and Caribbean',
    boardapprovaldate: '2024-06-28T00:00:00Z',
    closingdate: '2029-12-31',
    curr_total_commitment: '41800000',
    curr_ibrd_commitment: '41800000',
    curr_ida_commitment: '0',
    grantamt: '0',
    // Upstream repeats a window once per instrument, and a major sector once per
    // sector that rolls up to it.
    projectfinancialtype: ['IBRD', 'Other', 'Other'],
    major_sectors: [
      { major_sector: { major_sector_code: 'HHX', major_sector_name: 'Health' } },
      { major_sector: { major_sector_code: 'HHX', major_sector_name: 'Health' } },
      { major_sector: { major_sector_code: 'EEX', major_sector_name: 'Education' } },
    ],
    project_abstract: 'Rehabilitation of the dam and the associated irrigation perimeter.',
    ...overrides,
  };
}

/**
 * The response envelope: results keyed by project ID rather than listed, and
 * `total`, `os`, and `page` as strings.
 */
function envelope(projects: Array<ReturnType<typeof rawProject>>, total = projects.length) {
  return JSON.stringify({
    rows: projects.length,
    os: '0',
    page: '1',
    total: String(total),
    projects: Object.fromEntries(projects.map((project) => [project.id, project])),
    facets: {},
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProjectsService', () => {
  let fetchWithTimeoutMock: ReturnType<typeof vi.fn>;
  let service: InstanceType<
    typeof import('@/services/projects/projects-service.js')['ProjectsService']
  >;

  /** Queue one upstream response body on the fetch mock. */
  function mockBody(body: string) {
    fetchWithTimeoutMock.mockResolvedValueOnce({ text: async () => body });
  }

  /** Queue a non-2xx, which `fetchWithTimeout` surfaces as a thrown McpError. */
  async function mockHttpError(status: number, body: string) {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchWithTimeoutMock.mockRejectedValueOnce(
      new McpError(
        status >= 500 ? JsonRpcErrorCode.ServiceUnavailable : JsonRpcErrorCode.ValidationError,
        `Fetch failed with status ${status}.`,
        { status, statusText: '', body },
      ),
    );
  }

  const baseOpts = {
    countryCodes: [] as string[],
    statuses: [] as string[],
    regions: [] as string[],
    financialTypes: [] as string[],
    includeAbstract: false,
    page: 1,
    perPage: 50,
  };

  /** The URL of the nth fetch, as a parsed URL. */
  function requestedUrl(index = 0): URL {
    return new URL(String(fetchWithTimeoutMock.mock.calls[index]?.[0]));
  }

  beforeEach(async () => {
    const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
    fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);

    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue(CONFIG as never);

    const { ProjectsService } = await import('@/services/projects/projects-service.js');
    service = new ProjectsService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Envelope normalization ───────────────────────────────────────────────

  it('collects the ID-keyed projects object into rows in upstream order', async () => {
    mockBody(envelope([rawProject('P100'), rawProject('P200'), rawProject('P300')]));

    const result = await service.searchProjects(baseOpts, createMockContext());

    expect(result.projects.map((project) => project.id)).toEqual(['P100', 'P200', 'P300']);
    expect(result.total).toBe(3);
  });

  it('normalizes the string, timestamp, and repeated-value fields of a row', async () => {
    mockBody(envelope([rawProject('P100')]));

    const result = await service.searchProjects(
      { ...baseOpts, includeAbstract: true },
      createMockContext(),
    );

    expect(result.projects[0]).toEqual({
      id: 'P100',
      name: 'Project P100',
      status: 'Active',
      countryCodes: ['BR'],
      countryName: 'Federative Republic of Brazil',
      regionName: 'Latin America and Caribbean',
      // The timestamp is narrowed to the calendar day the tool's own filters use.
      boardApprovalDate: '2024-06-28',
      closingDate: '2029-12-31',
      totalCommitment: 41_800_000,
      ibrdCommitment: 41_800_000,
      idaCommitment: 0,
      grantAmount: 0,
      financialTypes: ['IBRD', 'Other'],
      majorSectors: ['Health', 'Education'],
      abstract: 'Rehabilitation of the dam and the associated irrigation perimeter.',
      url: 'https://projects.worldbank.org/en/projects-operations/project-detail/P100',
    });
  });

  it('reports an absent amount as null rather than zero, and tolerates a sparse row', async () => {
    mockBody(
      envelope([
        {
          id: 'P900',
          proj_id: 'P900',
          project_name: 'African Distance Learning Multi-Country Credit',
          status: 'Dropped',
          countryname: 'Other',
          countrycode: ['ZZ'],
          regionname: 'Other',
          boardapprovaldate: '2001-11-28T00:00:00Z',
        } as never,
      ]),
    );

    const result = await service.searchProjects(baseOpts, createMockContext());

    expect(result.projects[0]).toMatchObject({
      id: 'P900',
      closingDate: null,
      totalCommitment: null,
      financialTypes: [],
      majorSectors: [],
      abstract: null,
    });
  });

  it('never reads an unusable amount as a commitment of zero', async () => {
    mockBody(
      envelope([
        rawProject('P100', { curr_total_commitment: '' }),
        rawProject('P200', { curr_total_commitment: '   ' }),
        rawProject('P300', { curr_total_commitment: 'n/a' }),
        rawProject('P400', { curr_total_commitment: '0' }),
      ]),
    );

    const result = await service.searchProjects(baseOpts, createMockContext());

    // A commitment the portfolio does not publish is missing data. Only a real
    // upstream `0` may report as zero — `Number('')` is 0 and would erase that line.
    expect(result.projects.map((project) => project.totalCommitment)).toEqual([
      null,
      null,
      null,
      0,
    ]);
  });

  // ─── Commitment amounts ───────────────────────────────────────────────────

  /**
   * P516289 as the endpoint returned it on 2026-09-25, trimmed to the fields
   * requested: a trust-funded grant with no IBRD or IDA money, so no `totalamt`.
   */
  const grantOnlyRecord = {
    id: 'P516289',
    proj_id: 'P516289',
    project_name: 'Second Kenya Social and Economic Inclusion Project',
    status: 'Active',
    countryname: 'Republic of Kenya',
    countrycode: ['KE'],
    regionname: 'Eastern and Southern Africa',
    boardapprovaldate: '2026-07-22T00:00:00Z',
    grantamt: '22000000',
    curr_total_commitment: '22000000',
    projectfinancialtype: ['Grants'],
  };

  /**
   * P510631 (Thailand, pipeline) as returned on 2026-09-25: IBRD lending plus
   * 270,000,000 of Asian Development Bank and AIIB co-financing in `grantamt`.
   */
  const blendedRecord = {
    id: 'P510631',
    proj_id: 'P510631',
    project_name: 'Chao Phraya Flood Management Plan 2',
    status: 'Pipeline',
    countryname: 'Kingdom of Thailand',
    countrycode: ['TH'],
    regionname: 'East Asia and Pacific',
    boardapprovaldate: '2027-09-21T00:00:00Z',
    totalamt: '610000000',
    grantamt: '270000000',
    curr_total_commitment: '880000000',
    curr_ibrd_commitment: '610000000',
    curr_ida_commitment: '0',
    projectfinancialtype: ['IBRD', 'Other'],
  };

  it('reads the commitment the project page reports, so a grant-only operation is not null', async () => {
    mockBody(envelope([grantOnlyRecord as never]));
    const result = await service.searchProjects(baseOpts, createMockContext());

    expect(result.projects[0]).toMatchObject({
      totalCommitment: 22_000_000,
      grantAmount: 22_000_000,
      ibrdCommitment: null,
      idaCommitment: null,
    });
  });

  it('splits a blended commitment into IBRD, IDA, and grant amounts beside the total', async () => {
    mockBody(envelope([blendedRecord as never]));
    const result = await service.searchProjects(baseOpts, createMockContext());

    expect(result.projects[0]).toMatchObject({
      totalCommitment: 880_000_000,
      ibrdCommitment: 610_000_000,
      // A published zero is a real zero, not a missing amount.
      idaCommitment: 0,
      grantAmount: 270_000_000,
    });
  });

  it('reports every amount as null, never zero, on a record that publishes none', async () => {
    mockBody(
      envelope([
        rawProject('P900', {
          grantamt: undefined,
          curr_total_commitment: undefined,
          curr_ibrd_commitment: undefined,
          curr_ida_commitment: undefined,
        }),
      ]),
    );
    const result = await service.searchProjects(baseOpts, createMockContext());

    expect(result.projects[0]).toMatchObject({
      totalCommitment: null,
      ibrdCommitment: null,
      idaCommitment: null,
      grantAmount: null,
    });
  });

  it('requests the commitment breakdown fields', async () => {
    mockBody(envelope([rawProject('P100')]));
    await service.searchProjects(baseOpts, createMockContext());

    expect(requestedUrl().searchParams.get('fl')?.split(',')).toEqual(
      expect.arrayContaining([
        'curr_total_commitment',
        'curr_ibrd_commitment',
        'curr_ida_commitment',
        'grantamt',
      ]),
    );
  });

  it('reports the four legacy portfolio codes as their WDI ISO2 codes, leaving every other code alone', async () => {
    mockBody(
      envelope([
        rawProject('P101', { countrycode: ['RY'] }),
        rawProject('P102', { countrycode: ['ZR'] }),
        rawProject('P103', { countrycode: ['GZ'] }),
        rawProject('P104', { countrycode: ['TP'] }),
        rawProject('P105', { countrycode: ['BR'] }),
        rawProject('P106', { countrycode: ['3A'] }),
      ]),
    );
    const result = await service.searchProjects(baseOpts, createMockContext());

    expect(result.projects.map((row) => row.countryCodes)).toEqual([
      ['YE'],
      ['CD'],
      ['PS'],
      ['TL'],
      ['BR'],
      ['3A'],
    ]);
  });

  it('withholds the abstract unless it was asked for', async () => {
    mockBody(envelope([rawProject('P100')]));
    const withheld = await service.searchProjects(baseOpts, createMockContext());
    expect(withheld.projects[0]?.abstract).toBeNull();

    mockBody(envelope([rawProject('P100')]));
    const included = await service.searchProjects(
      { ...baseOpts, includeAbstract: true },
      createMockContext(),
    );
    expect(included.projects[0]?.abstract).toContain('Rehabilitation');
  });

  // ─── Query construction ───────────────────────────────────────────────────

  it('requests the fields the default projection omits, in JSON', async () => {
    mockBody(envelope([rawProject('P100')]));
    await service.searchProjects(baseOpts, createMockContext());

    const url = requestedUrl();
    expect(url.origin + url.pathname).toBe('https://search.worldbank.org/api/v3/projects');
    expect(url.searchParams.get('format')).toBe('json');
    // Without `fl` the response carries no status, country code, or abstract.
    expect(url.searchParams.get('fl')?.split(',')).toEqual(
      expect.arrayContaining(['status', 'countrycode', 'countryname', 'project_abstract']),
    );
  });

  it('joins multi-value filters with a caret and uppercases country codes', async () => {
    mockBody(envelope([rawProject('P100')]));
    await service.searchProjects(
      {
        ...baseOpts,
        query: 'climate adaptation',
        countryCodes: ['br', 'in'],
        statuses: ['Active', 'Pipeline'],
        regions: ['South Asia', 'Africa'],
        approvedFrom: '2020-01-01',
        approvedTo: '2021-01-01',
      },
      createMockContext(),
    );

    const params = requestedUrl().searchParams;
    // A comma reads as part of one value upstream and matches nothing at all.
    expect(params.get('countrycode_exact')).toBe('BR^IN');
    expect(params.get('status_exact')).toBe('Active^Pipeline');
    expect(params.get('regionname_exact')).toBe('South Asia^Africa');
    expect(params.get('qterm')).toBe('climate adaptation');
    expect(params.get('strdate')).toBe('2020-01-01');
    expect(params.get('enddate')).toBe('2021-01-01');
  });

  it('sends only the filters the caller supplied', async () => {
    mockBody(envelope([rawProject('P100')]));
    await service.searchProjects(baseOpts, createMockContext());

    const params = requestedUrl().searchParams;
    for (const key of [
      'qterm',
      'countrycode_exact',
      'status_exact',
      'regionname_exact',
      'strdate',
      'enddate',
    ]) {
      expect(params.has(key)).toBe(false);
    }
  });

  it('sends financing windows as one caret-joined OR filter, and none when none are asked for', async () => {
    mockBody(envelope([rawProject('P100')]));
    mockBody(envelope([rawProject('P100')]));

    await service.searchProjects(
      { ...baseOpts, countryCodes: ['ET'], financialTypes: ['IDA', 'Grants'] },
      createMockContext(),
    );
    await service.searchProjects({ ...baseOpts, financialTypes: [] }, createMockContext());

    expect(requestedUrl(0).searchParams.get('projectfinancialtype_exact')).toBe('IDA^Grants');
    expect(requestedUrl(0).searchParams.get('countrycode_exact')).toBe('ET');
    expect(requestedUrl(1).searchParams.has('projectfinancialtype_exact')).toBe(false);
  });

  it('orders every request by board approval date, newest first, with or without query', async () => {
    // With qterm, upstream's own order is descending project ID, not board date.
    mockBody(envelope([], 0));
    mockBody(envelope([], 12));
    mockBody(envelope([rawProject('P100')]));

    await service.searchProjects(
      { ...baseOpts, query: 'climate adaptation', countryCodes: ['BR'] },
      createMockContext(),
    );
    await service.searchProjects(baseOpts, createMockContext());

    // The search with query, the country-only probe behind its empty result, and a browse.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    for (const index of [0, 1, 2]) {
      const params = requestedUrl(index).searchParams;
      expect(params.get('srt')).toBe('boardapprovaldate');
      expect(params.get('order')).toBe('desc');
    }
    expect(requestedUrl(0).searchParams.get('qterm')).toBe('climate adaptation');
    expect(requestedUrl(1).searchParams.has('qterm')).toBe(false);
  });

  // ─── Offset pagination ────────────────────────────────────────────────────

  it('translates page and per_page into the offset the API pages by', async () => {
    mockBody(envelope([rawProject('P100')], 28_074));
    const result = await service.searchProjects(
      { ...baseOpts, page: 4, perPage: 25 },
      createMockContext(),
    );

    const params = requestedUrl().searchParams;
    expect(params.get('rows')).toBe('25');
    expect(params.get('os')).toBe('75');
    expect(result.total).toBe(28_074);
    expect(result.page).toBe(4);
    expect(result.pages).toBe(1123);
  });

  it('reports one page for an empty result rather than zero', async () => {
    mockBody(envelope([], 0));
    const result = await service.searchProjects(baseOpts, createMockContext());
    expect(result).toMatchObject({ projects: [], total: 0, page: 1, pages: 1 });
  });

  it('leaves a page size under the cap as requested and echoes it', async () => {
    mockBody(envelope([rawProject('P100')], 28_074));
    const result = await service.searchProjects({ ...baseOpts, perPage: 80 }, createMockContext());
    expect(requestedUrl().searchParams.get('rows')).toBe('80');
    expect(result.perPage).toBe(80);
  });

  it('caps a page at 80 projects, offsetting and counting pages at the capped size', async () => {
    mockBody(envelope([rawProject('P100')], 28_074));
    const result = await service.searchProjects(
      { ...baseOpts, page: 3, perPage: 1000 },
      createMockContext(),
    );

    const params = requestedUrl().searchParams;
    expect(params.get('rows')).toBe('80');
    // Page 3 at the capped size, so pages 1 and 2 at that size cover rows 0–159.
    expect(params.get('os')).toBe('160');
    expect(result).toMatchObject({ perPage: 80, page: 3, pages: 351 });
  });

  it('caps a page at 8 projects when abstracts are requested, whole abstracts included', async () => {
    const long = 'x'.repeat(8_000);
    mockBody(envelope([rawProject('P100', { project_abstract: long })], 28_074));
    const result = await service.searchProjects(
      { ...baseOpts, includeAbstract: true, page: 2, perPage: 50 },
      createMockContext(),
    );

    const params = requestedUrl().searchParams;
    expect(params.get('rows')).toBe('8');
    expect(params.get('os')).toBe('8');
    expect(result).toMatchObject({ perPage: 8, pages: 3510 });
    expect(result.projects[0]?.abstract).toHaveLength(8_000);
  });

  it('walks contiguously whether the caller repeats per_page=1000 or follows the echo', async () => {
    const ctx = createMockContext();
    for (let request = 0; request < 3; request++) {
      mockBody(envelope([rawProject('P100')], 28_074));
    }

    await service.searchProjects({ ...baseOpts, page: 1, perPage: 1000 }, ctx);
    await service.searchProjects({ ...baseOpts, page: 2, perPage: 1000 }, ctx);
    await service.searchProjects({ ...baseOpts, page: 3, perPage: 80 }, ctx);

    expect([0, 1, 2].map((i) => requestedUrl(i).searchParams.get('os'))).toEqual([
      '0',
      '80',
      '160',
    ]);
  });

  it('allows the last offset the API serves and rejects the first one past it', async () => {
    // Upstream accepts `os` 0–100,000 inclusive and answers 100,001 with HTTP 400,
    // so page 1251 at 80 rows is the last page that can be requested.
    mockBody(envelope([], 28_074));
    await service.searchProjects({ ...baseOpts, page: 1251, perPage: 80 }, createMockContext());
    expect(requestedUrl().searchParams.get('os')).toBe('100000');

    await expect(
      service.searchProjects({ ...baseOpts, page: 1252, perPage: 1000 }, createMockContext()),
    ).rejects.toMatchObject({
      data: { reason: 'page_out_of_range', page: 1252, perPage: 80, retryable: false },
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  // ─── Zero-hit country probe ───────────────────────────────────────────────

  it('probes the country filter alone when a search with one comes back empty', async () => {
    mockBody(envelope([], 0));
    mockBody(envelope([], 831));

    const result = await service.searchProjects(
      { ...baseOpts, countryCodes: ['BR'], statuses: ['Pipeline'], query: 'nuclear fusion' },
      createMockContext(),
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    const probe = requestedUrl(1).searchParams;
    expect(probe.get('countrycode_exact')).toBe('BR');
    expect(probe.get('rows')).toBe('0');
    // Everything else is dropped, so the count is the country filter's alone.
    expect(probe.has('status_exact')).toBe(false);
    expect(probe.has('qterm')).toBe(false);
    expect(result.countryOnlyTotal).toBe(831);
  });

  it('reports zero from the probe when no project carries the code', async () => {
    mockBody(envelope([], 0));
    mockBody(envelope([], 0));

    const result = await service.searchProjects(
      { ...baseOpts, countryCodes: ['QQ'] },
      createMockContext(),
    );

    expect(result.countryOnlyTotal).toBe(0);
  });

  it('keeps the empty result when the probe itself fails', async () => {
    mockBody(envelope([], 0));
    await mockHttpError(500, 'Debug: true\n\nError stack: TypeError: Invalid date');

    // The search succeeded — an empty result is a valid answer, so a broken
    // diagnostic must not convert it into an upstream failure.
    const result = await service.searchProjects(
      { ...baseOpts, countryCodes: ['BR'], statuses: ['Pipeline'] },
      createMockContext(),
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ projects: [], total: 0, countryOnlyTotal: null });
  });

  it('propagates a cancellation that lands during the probe instead of answering the search', async () => {
    const cancelled = new AbortController();
    const reason = new DOMException('The operation was aborted.', 'AbortError');
    mockBody(envelope([], 0));
    fetchWithTimeoutMock.mockImplementationOnce(async () => {
      cancelled.abort(reason);
      throw reason;
    });

    await expect(
      service.searchProjects(
        { ...baseOpts, countryCodes: ['BR'], statuses: ['Pipeline'] },
        createMockContext({ signal: cancelled.signal }),
      ),
    ).rejects.toBe(reason);
  });

  it('does not retry a probe whose 4xx is a settled answer', async () => {
    mockBody(envelope([], 0));
    await mockHttpError(400, '{"Debug":true,"error":"400 - Invalid"}');

    const result = await service.searchProjects(
      { ...baseOpts, countryCodes: ['BR'] },
      createMockContext(),
    );

    expect(result.countryOnlyTotal).toBeNull();
  });

  it('does not probe when the search matched something', async () => {
    mockBody(envelope([rawProject('P100')]));
    const result = await service.searchProjects(
      { ...baseOpts, countryCodes: ['BR'] },
      createMockContext(),
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(result.countryOnlyTotal).toBeNull();
  });

  it('does not probe an empty result that had no country filter to blame', async () => {
    mockBody(envelope([], 0));
    const result = await service.searchProjects(
      { ...baseOpts, query: 'zzzqqqnotarealword' },
      createMockContext(),
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(result.countryOnlyTotal).toBeNull();
  });

  // ─── Error classification ─────────────────────────────────────────────────

  it('classifies a 4xx as a settled upstream failure that must not be retried', async () => {
    await mockHttpError(
      400,
      '{"Debug":true,"error":"400 - Invalid","RequestUrl":"https://itsdt-externalsearchapi-prod.search.windows.net/indexes/projects-dl-index/docs/search"}',
    );
    const promise = service.searchProjects(baseOpts, createMockContext());

    await expect(promise).rejects.toMatchObject({
      data: { reason: 'upstream_unavailable', status: 400, retryable: false },
    });
    // The 4xx body names the search cluster behind the API; it stays out of the message.
    await expect(promise).rejects.not.toThrow(/search\.windows\.net|projects-dl-index/);
  });

  it('classifies a 5xx as retryable and keeps the upstream stack trace out of the message', async () => {
    await mockHttpError(
      500,
      'Debug: true\n\nError stack: TypeError: Invalid date\n    at C:\\home\\site\\wwwroot\\NodeSearchAPI\\app\\helper\\queryBuilder.js:721:111',
    );
    const promise = service.searchProjects(baseOpts, createMockContext());

    await expect(promise).rejects.toMatchObject({
      data: { reason: 'upstream_unavailable', status: 500 },
    });
    await expect(promise).rejects.toThrow(/answered HTTP 500/);
    await expect(promise).rejects.not.toThrow(/NodeSearchAPI|wwwroot/);
  });

  it('does not mark a 5xx unretryable', async () => {
    await mockHttpError(503, 'unavailable');
    await expect(service.searchProjects(baseOpts, createMockContext())).rejects.not.toMatchObject({
      data: { retryable: false },
    });
  });

  it('throws serviceUnavailable when the host returns an HTML error page', async () => {
    mockBody('<!doctype html><html lang="en"><head><title>HTTP Status 404</title></head></html>');
    await expect(service.searchProjects(baseOpts, createMockContext())).rejects.toThrow(
      /HTML error page/,
    );
  });

  it('throws a serialization error when the payload is not JSON', async () => {
    mockBody('Debug: true\n\nError stack: TypeError: Invalid date');
    await expect(service.searchProjects(baseOpts, createMockContext())).rejects.toThrow(/not JSON/);
  });

  it('throws a serialization error when the envelope has no projects object', async () => {
    mockBody('{"rows":1,"total":"1","projects":[]}');
    await expect(service.searchProjects(baseOpts, createMockContext())).rejects.toThrow(
      /without the expected projects object/,
    );
  });

  it.each(['undefined', 'many'])(
    'throws a serialization error rather than count a total of "%s"',
    async (total) => {
      // The API answers a # in qterm with HTTP 200 and `"total": "undefined"`.
      mockBody(JSON.stringify({ rows: 0, os: '0', page: '1', total, projects: {} }));
      await expect(
        service.searchProjects({ ...baseOpts, query: 'water' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        message: expect.stringMatching(/total/),
      });
    },
  );
});
