/**
 * @fileoverview Tests for PipService — the survey-first merge and the row grain
 * it keys on, normalization of PIP's flat row shape, local pagination, and the
 * classification of PIP's real HTTP status codes into domain errors, resolution
 * of the PPP vintage against the versions listing, and survey comparability.
 * @module tests/services/pip/pip-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── fetchWithTimeout mock ────────────────────────────────────────────────────
// Hoisted so the mock is in place before the service module resolves the dep.
vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    pipBaseUrl: 'https://api.worldbank.org/pip/v1',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

// ─── Raw row helpers ──────────────────────────────────────────────────────────

/** Ten decile shares, as PIP publishes them on a survey-derived row. */
const DECILES = {
  decile1: 0.0169,
  decile2: 0.0339,
  decile3: 0.0452,
  decile4: 0.0564,
  decile5: 0.0687,
  decile6: 0.0829,
  decile7: 0.1005,
  decile8: 0.1241,
  decile9: 0.1623,
  decile10: 0.3091,
};

/**
 * A survey-derived row: the distributional block is present. This is the only
 * shape PIP ever populates `gini` and the deciles on.
 */
function surveyRow(countryCode: string, reportingYear: number, overrides = {}) {
  return {
    region_name: 'North America',
    region_code: 'NAC',
    country_name: `Economy ${countryCode}`,
    country_code: countryCode,
    reporting_year: reportingYear,
    reporting_level: 'national',
    survey_acronym: 'CPS-ASEC-LIS',
    survey_year: reportingYear,
    welfare_type: 'income',
    survey_comparability: 3,
    comparable_spell: '2019 - 2023',
    poverty_line: 3,
    headcount: 0.014,
    poverty_gap: 0.0104,
    poverty_severity: 0.0087,
    watts: 0.0249,
    mean: 89.9496,
    median: 67.7236,
    mld: 0.3475,
    gini: 0.417,
    polarization: 0.3757,
    ...DECILES,
    reporting_pop: 334017321,
    is_interpolated: false,
    estimation_type: 'survey',
    ...overrides,
  };
}

/**
 * A gap-filled row exactly as PIP returns it: poverty measures present, the
 * whole distributional block and `survey_year` null.
 */
function gapFilledRow(countryCode: string, reportingYear: number, overrides = {}) {
  return {
    ...surveyRow(countryCode, reportingYear),
    survey_acronym: null,
    survey_year: null,
    survey_comparability: null,
    comparable_spell: null,
    mld: null,
    gini: null,
    polarization: null,
    decile1: null,
    decile2: null,
    decile3: null,
    decile4: null,
    decile5: null,
    decile6: null,
    decile7: null,
    decile8: null,
    decile9: null,
    decile10: null,
    is_interpolated: true,
    estimation_type: 'interpolation',
    ...overrides,
  };
}

/**
 * The `/versions` listing: every release × PPP vintage PIP publishes, newest
 * release first. The newest release carries 2021 and 2017 builds; 2011 survives
 * only on an older release.
 */
const VERSIONS = [
  {
    version: '20260324_2021_01_02_PROD',
    release_version: '20260324',
    ppp_version: '2021',
    identity: 'PROD',
  },
  {
    version: '20260324_2017_01_02_PROD',
    release_version: '20260324',
    ppp_version: '2017',
    identity: 'PROD',
  },
  {
    version: '20250930_2021_01_02_PROD',
    release_version: '20250930',
    ppp_version: '2021',
    identity: 'PROD',
  },
  {
    version: '20250930_2017_01_02_PROD',
    release_version: '20250930',
    ppp_version: '2017',
    identity: 'PROD',
  },
  {
    version: '20240627_2017_01_02_PROD',
    release_version: '20240627',
    ppp_version: '2017',
    identity: 'PROD',
  },
  {
    version: '20240627_2011_02_02_PROD',
    release_version: '20240627',
    ppp_version: '2011',
    identity: 'PROD',
  },
];

/** PIP's HTTP-404 body for a rejected parameter value, as an McpError's captured body. */
function validationBody(parameter: string, valid: unknown[]) {
  return JSON.stringify({
    error: ['Invalid query arguments have been submitted.'],
    details: {
      [parameter]: {
        msg: [
          `You supplied an invalid value for ${parameter}. Please use one of the valid values.`,
        ],
        valid,
      },
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PipService', () => {
  let fetchWithTimeoutMock: ReturnType<typeof vi.fn>;
  let service: InstanceType<typeof import('@/services/pip/pip-service.js')['PipService']>;

  /**
   * Responses for `/pip` requests, served in order. Kept apart from the
   * `/versions` listing, which the service may consult at any point, so a queued
   * row set always reaches the data request it was written for.
   */
  let pipQueue: Array<() => Promise<unknown>>;

  /** What `/versions` answers with for the current test. */
  let versionsListing: unknown[];

  /** URLs of the `/versions` listing requests made so far. */
  function versionsCalls(): string[] {
    return fetchWithTimeoutMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/versions'));
  }

  /** Queue one upstream `/pip` response. */
  function mockRows(rows: unknown[]) {
    mockBody(JSON.stringify(rows));
  }

  /** Queue one raw `/pip` response body. */
  function mockBody(text: string) {
    pipQueue.push(async () => ({ text: async () => text }));
  }

  /** Queue a non-2xx, which `fetchWithTimeout` surfaces as a thrown McpError. */
  async function mockHttpError(status: number, body: string) {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const error = new McpError(
      status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.InternalError,
      `Fetch failed with status ${status}.`,
      { status, statusText: '', body },
    );
    pipQueue.push(async () => {
      throw error;
    });
  }

  /** URLs of the `/pip` data requests made so far, in order. */
  function pipCalls(): string[] {
    return fetchWithTimeoutMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/pip?'));
  }

  const baseOpts = { countries: ['USA'], year: '2022', fillGaps: true, page: 1, perPage: 50 };

  beforeEach(async () => {
    const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
    fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);
    pipQueue = [];
    versionsListing = VERSIONS;
    fetchWithTimeoutMock.mockImplementation(async (url: string) => {
      if (url.includes('/versions')) {
        return { text: async () => JSON.stringify(versionsListing) };
      }
      const next = pipQueue.shift();
      if (!next) throw new Error(`No response queued for ${url}`);
      return next();
    });

    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      apiBaseUrl: 'https://api.worldbank.org/v2',
      pipBaseUrl: 'https://api.worldbank.org/pip/v1',
      defaultPerPage: 50,
      catalogCacheTtlMs: 60_000,
    } as never);

    const { PipService } = await import('@/services/pip/pip-service.js');
    service = new PipService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Survey rows ──────────────────────────────────────────────────────────

  it('returns the inequality block on a survey year and asks upstream once', async () => {
    mockRows([surveyRow('USA', 2022)]);
    const result = await service.getPoverty(baseOpts, createMockContext());

    expect(pipCalls()).toHaveLength(1);
    expect(pipCalls()[0]).toContain('fill_gaps=false');
    expect(result.gapFilled).toBe(false);
    expect(result.rows[0]).toMatchObject({
      countryCode: 'USA',
      reportingYear: 2022,
      gini: 0.417,
      mld: 0.3475,
      polarization: 0.3757,
      surveyYear: 2022,
      surveyAcronym: 'CPS-ASEC-LIS',
      estimationType: 'survey',
      isInterpolated: false,
    });
    expect(result.rows[0]?.decileShares).toEqual([
      0.0169, 0.0339, 0.0452, 0.0564, 0.0687, 0.0829, 0.1005, 0.1241, 0.1623, 0.3091,
    ]);
  });

  it('does not gap-fill when the survey response already covers every country', async () => {
    mockRows([surveyRow('USA', 2022)]);
    await service.getPoverty(baseOpts, createMockContext());
    expect(pipCalls()).toHaveLength(1);
  });

  // ─── Gap-filled rows ──────────────────────────────────────────────────────

  it('falls back to a gap-filled row with null inequality fields when no survey covers the year', async () => {
    mockRows([]);
    mockRows([gapFilledRow('IND', 2019)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['IND'], year: '2019' },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(2);
    expect(pipCalls()[1]).toContain('fill_gaps=true');
    expect(result.gapFilled).toBe(true);
    expect(result.rows[0]).toMatchObject({
      countryCode: 'IND',
      headcount: 0.014,
      gini: null,
      mld: null,
      polarization: null,
      decileShares: null,
      surveyYear: null,
      surveyAcronym: '',
      estimationType: 'interpolation',
      isInterpolated: true,
    });
  });

  it('skips the gap-fill request entirely when fillGaps is false', async () => {
    mockRows([]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['IND'], year: '2019', fillGaps: false },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(1);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.gapFilled).toBe(false);
  });

  it('drops a partial decile run rather than reporting shares against the wrong deciles', async () => {
    mockRows([surveyRow('USA', 2022, { decile7: null })]);
    const result = await service.getPoverty(baseOpts, createMockContext());
    expect(result.rows[0]?.decileShares).toBeNull();
    expect(result.rows[0]?.gini).toBe(0.417);
  });

  // ─── Multi-country batches ────────────────────────────────────────────────

  it('joins a country batch with commas and gap-fills only the countries the surveys missed', async () => {
    mockRows([surveyRow('USA', 2019), surveyRow('BRA', 2019)]);
    mockRows([gapFilledRow('IND', 2019), gapFilledRow('USA', 2019), gapFilledRow('BRA', 2019)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['ind', 'USA', 'BRA'], year: '2019' },
      createMockContext(),
    );

    expect(pipCalls()[0]).toContain('country=IND%2CUSA%2CBRA');
    expect(result.total).toBe(3);
    // Sorted by country code, and the survey rows win over their gap-filled twins.
    expect(result.rows.map((row) => [row.countryCode, row.estimationType])).toEqual([
      ['BRA', 'survey'],
      ['IND', 'interpolation'],
      ['USA', 'survey'],
    ]);
    expect(result.gapFilled).toBe(true);
  });

  it('always looks for gaps when the batch is "all"', async () => {
    mockRows([surveyRow('USA', 2019)]);
    mockRows([gapFilledRow('IND', 2019), gapFilledRow('USA', 2019)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['all'], year: '2019' },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(2);
    expect(result.rows.map((row) => row.countryCode)).toEqual(['IND', 'USA']);
  });

  // ─── Multi-year requests ──────────────────────────────────────────────────

  it('gap-fills the years between surveys when the request spans the whole window', async () => {
    mockRows([surveyRow('IND', 2011), surveyRow('IND', 2022)]);
    mockRows(
      [2011, 2019, 2022, 2026].map((year) =>
        gapFilledRow('IND', year, year === 2026 ? { estimation_type: 'extrapolation' } : {}),
      ),
    );

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['IND'], year: 'all', perPage: 100 },
      createMockContext(),
    );

    // Covered by a survey row, but the years around it are not — the country
    // key alone would have skipped the second request and returned two rows.
    expect(pipCalls()).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.gapFilled).toBe(true);
    expect(result.rows.map((row) => [row.reportingYear, row.estimationType])).toEqual([
      [2011, 'survey'],
      [2019, 'interpolation'],
      [2022, 'survey'],
      [2026, 'extrapolation'],
    ]);
    // The survey years keep their distribution rather than the gap-filled twin's nulls.
    expect(result.rows.filter((row) => row.gini !== null).map((row) => row.reportingYear)).toEqual([
      2011, 2022,
    ]);
  });

  it('treats an omitted year as the whole window, the same way PIP does', async () => {
    mockRows([surveyRow('IND', 2022)]);
    mockRows([gapFilledRow('IND', 2021), gapFilledRow('IND', 2022)]);

    const { year: _dropped, ...noYear } = baseOpts;
    const result = await service.getPoverty(
      { ...noYear, countries: ['IND'], perPage: 100 },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(2);
    expect(result.rows.map((row) => row.reportingYear)).toEqual([2021, 2022]);
  });

  it('keeps a gap-filled row that differs only by reporting level or welfare type', async () => {
    mockRows([surveyRow('CHN', 2021, { reporting_level: 'national' })]);
    mockRows([
      gapFilledRow('CHN', 2021, { reporting_level: 'national' }),
      gapFilledRow('CHN', 2021, { reporting_level: 'urban' }),
      gapFilledRow('CHN', 2021, { reporting_level: 'national', welfare_type: 'consumption' }),
    ]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['CHN'], year: 'all', perPage: 100 },
      createMockContext(),
    );

    // Only the exact national/income twin is dropped; the other two are distinct rows.
    expect(result.total).toBe(3);
    expect(
      result.rows.map((row) => [row.reportingLevel, row.welfareType, row.estimationType]),
    ).toEqual([
      ['national', 'consumption', 'interpolation'],
      ['national', 'income', 'survey'],
      ['urban', 'income', 'interpolation'],
    ]);
  });

  it('resolves MRV to one row per economy rather than a survey year and a projected one', async () => {
    mockRows([surveyRow('USA', 2024)]);

    const result = await service.getPoverty({ ...baseOpts, year: 'MRV' }, createMockContext());

    // MRV is the most recent survey year in one mode and the last projected year
    // in the other; a second request would answer "most recent value" twice.
    expect(pipCalls()).toHaveLength(1);
    expect(result.rows.map((row) => row.reportingYear)).toEqual([2024]);
  });

  it('still gap-fills a single year for the economies the surveys missed', async () => {
    mockRows([surveyRow('USA', 2024)]);
    mockRows([gapFilledRow('USA', 2026), gapFilledRow('ABW', 2026)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['USA', 'ABW'], year: 'MRV' },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(2);
    // USA answered at its survey year; the gap-filled USA row is not a second answer.
    expect(result.rows.map((row) => [row.countryCode, row.reportingYear])).toEqual([
      ['ABW', 2026],
      ['USA', 2024],
    ]);
  });

  // ─── Empty results ────────────────────────────────────────────────────────

  it('treats an empty response under gap-filling as a successful empty result', async () => {
    mockRows([]);
    mockRows([]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['TWN'], year: '1970' },
      createMockContext(),
    );
    expect(result).toMatchObject({ rows: [], total: 0, page: 1, pages: 1, gapFilled: false });
  });

  // ─── Pagination ───────────────────────────────────────────────────────────

  it('paginates locally, since PIP has no server-side paging', async () => {
    mockRows([2018, 2019, 2020, 2021, 2022].map((year) => surveyRow('USA', year)));
    mockRows([]);

    const ctx = createMockContext();
    const page2 = await service.getPoverty({ ...baseOpts, year: 'all', page: 2, perPage: 2 }, ctx);

    expect(page2.total).toBe(5);
    expect(page2.pages).toBe(3);
    expect(page2.rows.map((row) => row.reportingYear)).toEqual([2020, 2021]);
    expect(pipCalls()[0]).not.toContain('per_page');
  });

  it('caps a page at 70 estimates, slicing and counting pages at the capped size', async () => {
    const years = Array.from({ length: 200 }, (_, index) => 1800 + index);
    mockRows(years.map((year) => surveyRow('USA', year)));

    const result = await service.getPoverty(
      { ...baseOpts, year: 'all', fillGaps: false, page: 2, perPage: 1000 },
      createMockContext(),
    );

    expect(result).toMatchObject({ total: 200, perPage: 70, page: 2, pages: 3 });
    expect(result.rows).toHaveLength(70);
    // Page 2 at the capped size starts right after page 1's 70 rows.
    expect(result.rows[0]?.reportingYear).toBe(1870);
    expect(result.rows.at(-1)?.reportingYear).toBe(1939);
  });

  it('leaves a page size under the cap as requested and echoes it', async () => {
    mockRows([2018, 2019, 2020].map((year) => surveyRow('USA', year)));
    const result = await service.getPoverty(
      { ...baseOpts, year: 'all', fillGaps: false, perPage: 70 },
      createMockContext(),
    );
    expect(result).toMatchObject({ perPage: 70, pages: 1 });
  });

  // ─── Query construction ───────────────────────────────────────────────────

  it('sends only the filters the caller supplied', async () => {
    mockRows([surveyRow('USA', 2022)]);
    await service.getPoverty(
      {
        ...baseOpts,
        povertyLine: 2.15,
        welfareType: 'income',
        reportingLevel: 'national',
      },
      createMockContext(),
    );

    const url = String(pipCalls()[0]);
    expect(url).toContain('https://api.worldbank.org/pip/v1/pip?');
    expect(url).toContain('povline=2.15');
    expect(url).toContain('welfare_type=income');
    expect(url).toContain('reporting_level=national');
  });

  it('omits povline entirely when the caller did not pick a poverty line', async () => {
    mockRows([surveyRow('USA', 2022)]);
    await service.getPoverty(baseOpts, createMockContext());
    expect(String(pipCalls()[0])).not.toContain('povline');
  });

  // ─── Error classification ─────────────────────────────────────────────────

  it('maps a 404 naming country to country_not_found', async () => {
    await mockHttpError(404, validationBody('country', ['USA', 'IND', 'BRA']));
    await expect(
      service.getPoverty({ ...baseOpts, countries: ['ZZZ'] }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'country_not_found', countryCodes: 'ZZZ' } });
  });

  it('maps a 404 naming another parameter to invalid_parameter and quotes its short valid list', async () => {
    await mockHttpError(404, validationBody('welfare_type', ['all', 'consumption', 'income']));
    const promise = service.getPoverty(baseOpts, createMockContext());

    await expect(promise).rejects.toMatchObject({
      data: { reason: 'invalid_parameter', parameters: ['welfare_type'] },
    });
    await expect(promise).rejects.toThrow(/welfare_type accepts all, consumption, income/);
  });

  it('names a rejected parameter without reciting a long list of accepted values', async () => {
    const years = Array.from({ length: 66 }, (_, index) => String(1963 + index));
    await mockHttpError(404, validationBody('year', ['all', 'MRV', ...years]));
    const promise = service.getPoverty(baseOpts, createMockContext());

    // The recovery hint is what resolves the call; 68 years in front of it is noise.
    await expect(promise).rejects.toThrow(/rejected the value supplied for year\.$/);
    await expect(promise).rejects.not.toThrow(/1963/);
  });

  it('names the rejected parameter even when the 404 body was truncated mid-list', async () => {
    const truncated = `${validationBody('year', ['all', 'MRV', '1963', '1964']).slice(0, 90)}…`;
    await mockHttpError(404, truncated);
    const promise = service.getPoverty(baseOpts, createMockContext());

    await expect(promise).rejects.toMatchObject({
      data: { reason: 'invalid_parameter', parameters: ['year'] },
    });
    // No `valid` list survives the truncation, so none is quoted.
    await expect(promise).rejects.toThrow(/rejected the value supplied for year\.$/);
  });

  it('maps a 5xx to upstream_unavailable and offers both causes without asserting either', async () => {
    await mockHttpError(500, '{"error":["Error in /api/v1/pip"]}');
    const promise = service.getPoverty({ ...baseOpts, countries: ['WLD'] }, createMockContext());

    await expect(promise).rejects.toMatchObject({
      data: { reason: 'upstream_unavailable', countryCodes: 'WLD', status: 500 },
    });
    // PIP's 500 body says only "Internal Server Error", so neither cause may be
    // stated as the diagnosis — an outage reported as a bad country code, or the
    // reverse, sends the agent after the wrong fix.
    await expect(promise).rejects.toThrow(/temporarily unavailable/);
    await expect(promise).rejects.toThrow(/regional or income-group aggregate/);
  });

  it('throws serviceUnavailable when the gateway returns an HTML error page', async () => {
    mockBody('<!DOCTYPE html><html><body>503 Service Unavailable</body></html>');
    await expect(service.getPoverty(baseOpts, createMockContext())).rejects.toThrow(
      /HTML error page/,
    );
  });

  it('throws a serialization error when the payload is not an array of rows', async () => {
    mockBody('{"unexpected":"object"}');
    await expect(service.getPoverty(baseOpts, createMockContext())).rejects.toThrow(
      /not the expected array/,
    );
  });

  // ─── PPP vintage ──────────────────────────────────────────────────────────

  it('resolves no selector to the newest release at its newest PPP vintage, on both requests', async () => {
    mockRows([]);
    mockRows([gapFilledRow('IND', 2019)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['IND'], year: '2019' },
      createMockContext(),
    );

    expect(result).toMatchObject({ pppVersion: '2021', releaseVersion: '20260324' });
    expect(pipCalls()).toHaveLength(2);
    for (const url of pipCalls()) {
      expect(url).toContain('version=20260324_2021_01_02_PROD');
      expect(url).not.toContain('ppp_version=');
    }
  });

  it('resolves ppp_version alone to that vintage in the newest release, on both requests', async () => {
    mockRows([]);
    mockRows([gapFilledRow('IND', 2019)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['IND'], year: '2019', pppVersion: '2017' },
      createMockContext(),
    );

    expect(result).toMatchObject({ pppVersion: '2017', releaseVersion: '20260324' });
    expect(pipCalls().map((url) => new URL(url).searchParams.get('version'))).toEqual([
      '20260324_2017_01_02_PROD',
      '20260324_2017_01_02_PROD',
    ]);
  });

  it('picks the newest release by its date stamp, not by where the listing puts it', async () => {
    versionsListing = [...VERSIONS].reverse();
    mockRows([surveyRow('USA', 2022)]);

    const result = await service.getPoverty(baseOpts, createMockContext());
    expect(result).toMatchObject({ pppVersion: '2021', releaseVersion: '20260324' });
  });

  it('rejects a vintage the newest release does not carry, naming the ones it does', async () => {
    const promise = service.getPoverty({ ...baseOpts, pppVersion: '2011' }, createMockContext());

    await expect(promise).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'ppp_version_unavailable',
        pppVersion: '2011',
        availablePppVersions: ['2021', '2017'],
        releaseVersion: '20260324',
      },
    });
    await expect(promise).rejects.toThrow(/2021, 2017/);
    expect(pipCalls()).toHaveLength(0);
  });

  it('reads the versions listing once and reuses it across requests', async () => {
    mockRows([surveyRow('USA', 2022)]);
    mockRows([surveyRow('USA', 2022)]);
    const ctx = createMockContext();

    await service.getPoverty(baseOpts, ctx);
    await service.getPoverty({ ...baseOpts, pppVersion: '2017' }, ctx);

    expect(versionsCalls()).toHaveLength(1);
    expect(pipCalls()).toHaveLength(2);
  });

  it('rereads the versions listing on every request when caching is disabled', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      pipBaseUrl: 'https://api.worldbank.org/pip/v1',
      defaultPerPage: 50,
      catalogCacheTtlMs: 0,
    } as never);
    const { PipService } = await import('@/services/pip/pip-service.js');
    const uncached = new PipService({} as never, createInMemoryStorage());
    mockRows([surveyRow('USA', 2022)]);
    mockRows([surveyRow('USA', 2022)]);

    await uncached.getPoverty(baseOpts, createMockContext());
    await uncached.getPoverty(baseOpts, createMockContext());
    expect(versionsCalls()).toHaveLength(2);
  });

  it('throws a serialization error when the versions listing names no release', async () => {
    versionsListing = [];
    await expect(service.getPoverty(baseOpts, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    expect(pipCalls()).toHaveLength(0);
  });

  // ─── Survey comparability ─────────────────────────────────────────────────

  it('passes survey comparability through on survey rows and keeps it null on gap-filled ones', async () => {
    mockRows([surveyRow('IND', 2022, { survey_comparability: 9, comparable_spell: '2022' })]);
    mockRows([
      gapFilledRow('IND', 2021, { survey_comparability: null, comparable_spell: null }),
      gapFilledRow('IND', 2022),
    ]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['IND'], year: 'all' },
      createMockContext(),
    );

    expect(
      result.rows.map((row) => [
        row.reportingYear,
        row.estimationType,
        row.surveyComparability,
        row.comparableSpell,
      ]),
    ).toEqual([
      [2021, 'interpolation', null, null],
      [2022, 'survey', 9, '2022'],
    ]);
  });

  it('reports comparability as null when a row omits the fields entirely', async () => {
    const { survey_comparability: _a, comparable_spell: _b, ...sparse } = surveyRow('USA', 2022);
    mockRows([sparse]);
    const result = await service.getPoverty(baseOpts, createMockContext());
    expect(result.rows[0]).toMatchObject({ surveyComparability: null, comparableSpell: null });
  });
});
