/**
 * @fileoverview Tests for PipService — the survey-first merge and the row grain
 * it keys on, normalization of PIP's flat row shape, local pagination, and the
 * classification of PIP's real HTTP status codes into domain errors.
 * @module tests/services/pip/pip-service.test
 */

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

  /** Queue one upstream response on the fetch mock. */
  function mockRows(rows: unknown[]) {
    fetchWithTimeoutMock.mockResolvedValueOnce({ text: async () => JSON.stringify(rows) });
  }

  /** Queue a non-2xx, which `fetchWithTimeout` surfaces as a thrown McpError. */
  async function mockHttpError(status: number, body: string) {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchWithTimeoutMock.mockRejectedValueOnce(
      new McpError(
        status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.InternalError,
        `Fetch failed with status ${status}.`,
        { status, statusText: '', body },
      ),
    );
  }

  const baseOpts = { countries: ['USA'], year: '2022', fillGaps: true, page: 1, perPage: 50 };

  beforeEach(async () => {
    const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
    fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);

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

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toContain('fill_gaps=false');
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
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  // ─── Gap-filled rows ──────────────────────────────────────────────────────

  it('falls back to a gap-filled row with null inequality fields when no survey covers the year', async () => {
    mockRows([]);
    mockRows([gapFilledRow('IND', 2019)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['IND'], year: '2019' },
      createMockContext(),
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeoutMock.mock.calls[1]?.[0]).toContain('fill_gaps=true');
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

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
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

    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toContain('country=IND%2CUSA%2CBRA');
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

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
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
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
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

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
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
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(result.rows.map((row) => row.reportingYear)).toEqual([2024]);
  });

  it('still gap-fills a single year for the economies the surveys missed', async () => {
    mockRows([surveyRow('USA', 2024)]);
    mockRows([gapFilledRow('USA', 2026), gapFilledRow('ABW', 2026)]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['USA', 'ABW'], year: 'MRV' },
      createMockContext(),
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
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
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).not.toContain('per_page');
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

    const url = String(fetchWithTimeoutMock.mock.calls[0]?.[0]);
    expect(url).toContain('https://api.worldbank.org/pip/v1/pip?');
    expect(url).toContain('povline=2.15');
    expect(url).toContain('welfare_type=income');
    expect(url).toContain('reporting_level=national');
  });

  it('omits povline entirely when the caller did not pick a poverty line', async () => {
    mockRows([surveyRow('USA', 2022)]);
    await service.getPoverty(baseOpts, createMockContext());
    expect(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).not.toContain('povline');
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
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => '<!DOCTYPE html><html><body>503 Service Unavailable</body></html>',
    });
    await expect(service.getPoverty(baseOpts, createMockContext())).rejects.toThrow(
      /HTML error page/,
    );
  });

  it('throws a serialization error when the payload is not an array of rows', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({ text: async () => '{"unexpected":"object"}' });
    await expect(service.getPoverty(baseOpts, createMockContext())).rejects.toThrow(
      /not the expected array/,
    );
  });
});
