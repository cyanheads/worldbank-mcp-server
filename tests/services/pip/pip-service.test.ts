/**
 * @fileoverview Tests for PipService — the survey-first merge and the row grain
 * it keys on, the two passes running at once and the survey-only answer when
 * the gap-filled pass fails, normalization of PIP's flat row shape, local
 * pagination, and the classification of PIP's real HTTP status codes into
 * domain errors, resolution of the PPP vintage against the versions listing,
 * and survey comparability.
 * @module tests/services/pip/pip-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import braCapture from './fixtures/bra.json' with { type: 'json' };
import groupCapture from './fixtures/groups.json' with { type: 'json' };
import ngaCapture from './fixtures/nga.json' with { type: 'json' };

// ─── fetchWithTimeout mock ────────────────────────────────────────────────────
// Hoisted so the mock is in place before the service module resolves the dep.
// The framework's transient classification stays real.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  defaultIsTransient: (await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>())
    .defaultIsTransient,
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

/** `/aux?table=regions`: one aggregate code per grouping this service routes or rejects. */
const REGIONS = [
  { region_code: 'SSF', region: 'Sub-Saharan Africa', grouping_type: 'region' },
  { region_code: 'WLD', region: 'World', grouping_type: 'world' },
  { region_code: 'LIC', region: 'Low income', grouping_type: 'incgroup' },
  { region_code: 'LMIC', region: 'Lower middle income', grouping_type: 'incgroup' },
  { region_code: 'IDA', region: 'IDA', grouping_type: 'ida' },
  { region_code: 'SSA', region: 'Sub-Saharan Africa', grouping_type: 'regionpcn' },
];

/** `/aux?table=country_list`: the economies PIP publishes, model-estimate-only ones included. */
const ECONOMIES = ['USA', 'IND', 'BRA', 'CHN', 'ABW', 'AFG'].map((country_code) => ({
  country_code,
  country_name: `Economy ${country_code}`,
}));

/** A `/pip-grp` aggregate row. */
function groupRow(code: string, reportingYear: number, overrides = {}) {
  return {
    region_code: code,
    region_name: `Aggregate ${code}`,
    reporting_year: reportingYear,
    poverty_line: 3,
    reporting_pop: 1_229_000_000,
    headcount: 0.4562,
    poverty_gap: 0.19,
    poverty_severity: 0.1,
    watts: 0.29,
    mean: 4.8,
    pop_in_poverty: 560_000_000,
    estimate_type: 'actual',
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

/**
 * Fetches held open until the test calls `release`, each rejecting first if the
 * signal it was handed aborts, as the framework's fetch does. `entered` resolves
 * once `expected` held fetches are in flight, so a test acts while the load is
 * pending by construction rather than by racing a timer.
 */
function holdOpen(expected: number) {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let inFlight = 0;
  const wait = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('fetch was aborted'));
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      released.promise.then(resolve);
      if (++inFlight === expected) entered.resolve();
    });
  return { entered: entered.promise, release: () => released.resolve(), wait };
}

/** Let every pending promise chain run to completion; nothing here waits on a timer. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

  /** Queue the per-attempt timeout `fetchWithTimeout` throws once PIP outlasts it. */
  async function mockTimeout() {
    const { timeout } = await import('@cyanheads/mcp-ts-core/errors');
    pipQueue.push(async () => {
      throw timeout('Fetch timed out.', { errorSource: 'FetchTimeout' });
    });
  }

  /** URLs of every request made so far, in order. */
  function fetchCalls(): string[] {
    return fetchWithTimeoutMock.mock.calls.map((call) => String(call[0]));
  }

  /** URLs of the `/pip` data requests made so far, in order. */
  function pipCalls(): string[] {
    return fetchCalls().filter((url) => url.includes('/pip?'));
  }

  /** URLs of the `/pip-grp` aggregate requests made so far, in order. */
  function groupCalls(): string[] {
    return fetchCalls().filter((url) => url.includes('/pip-grp?'));
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
      if (url.includes('/aux?table=regions')) {
        return { text: async () => JSON.stringify(REGIONS) };
      }
      if (url.includes('/aux?table=country_list')) {
        return { text: async () => JSON.stringify(ECONOMIES) };
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

  it('replays captured survey, latest economy, and aggregate provenance', async () => {
    mockRows(braCapture);
    const survey = await service.getPoverty(
      { ...baseOpts, countries: ['BRA'], fillGaps: false },
      createMockContext(),
    );
    expect(survey.rows[0]).toMatchObject({
      reportingYear: 2022,
      estimationType: 'survey',
      estimateType: null,
      distributionType: 'micro',
      gini: 0.5189,
    });
    mockRows([]);
    mockRows(ngaCapture);
    const latest = await service.getPoverty(
      { ...baseOpts, countries: ['all'], year: 'MRV' },
      createMockContext(),
    );
    expect(latest.rows[0]).toMatchObject({
      countryCode: 'NGA',
      reportingYear: 2026,
      estimationType: 'extrapolation',
      estimateType: 'nowcast',
      distributionType: 'micro',
      gini: null,
    });
    mockRows(groupCapture);
    const aggregate = await service.getPoverty(
      { ...baseOpts, countries: ['WLD'], year: 'MRV' },
      createMockContext(),
    );
    expect(aggregate.rows[0]).toMatchObject({
      estimationType: 'actual',
      estimateType: 'actual',
      distributionType: null,
    });
  });

  it('preserves separate estimate and distribution classifications without inferring survey defaults', async () => {
    mockRows([surveyRow('BRA', 2022, { distribution_type: 'micro' })]);
    const survey = await service.getPoverty(
      { ...baseOpts, countries: ['BRA'], fillGaps: false },
      createMockContext(),
    );
    expect(survey.rows[0]).toMatchObject({
      estimationType: 'survey',
      estimateType: null,
      distributionType: 'micro',
      gini: 0.417,
    });

    mockRows([]);
    mockRows([
      gapFilledRow('BRA', 2026, {
        estimation_type: 'extrapolation',
        estimate_type: 'nowcast',
        distribution_type: 'micro',
      }),
    ]);
    const latest = await service.getPoverty(
      { ...baseOpts, countries: ['BRA'], year: 'MRV' },
      createMockContext(),
    );
    expect(latest.rows[0]).toMatchObject({
      reportingYear: 2026,
      estimationType: 'extrapolation',
      estimateType: 'nowcast',
      distributionType: 'micro',
    });
  });

  it('retains the selected survey row classifications over its gap-filled twin', async () => {
    mockRows([surveyRow('BRA', 2022, { distribution_type: 'micro' })]);
    mockRows([
      gapFilledRow('BRA', 2022, { estimate_type: 'actual', distribution_type: 'imputed' }),
    ]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['BRA'], year: 'all' },
      createMockContext(),
    );
    expect(result.rows[0]).toMatchObject({
      estimationType: 'survey',
      estimateType: null,
      distributionType: 'micro',
    });
  });

  it.each([
    ['actual', 'micro'],
    ['projection', 'group'],
    ['nowcast', 'imputed'],
    [null, null],
  ])(
    'passes upstream estimate %j and distribution %j through without reinterpretation',
    async (estimateType, distributionType) => {
      mockRows([
        surveyRow('BRA', 2022, {
          estimate_type: estimateType,
          distribution_type: distributionType,
        }),
      ]);
      const result = await service.getPoverty(
        { ...baseOpts, countries: ['BRA'], fillGaps: false },
        createMockContext(),
      );
      expect(result.rows[0]).toMatchObject({
        estimateType,
        distributionType,
        estimationType: 'survey',
      });
    },
  );

  it('preserves aggregate estimate classifications and absent provenance as null', async () => {
    mockRows([groupRow('WLD', 2026, { estimate_type: 'nowcast' })]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['WLD'], year: 'MRV' },
      createMockContext(),
    );
    expect(result.rows[0]).toMatchObject({
      estimationType: 'nowcast',
      estimateType: 'nowcast',
      distributionType: null,
    });
    mockRows([surveyRow('BRA', 2022)]);
    mockRows([gapFilledRow('BRA', 2022)]);
    const sparse = await service.getPoverty(
      { ...baseOpts, countries: ['BRA'] },
      createMockContext(),
    );
    expect(sparse.rows[0]).toMatchObject({ estimateType: null, distributionType: null });
  });

  it('returns the inequality block on a survey year in place of its gap-filled twin', async () => {
    mockRows([surveyRow('USA', 2022)]);
    // PIP's gap-filled series answers a surveyed year too, from a different series.
    mockRows([gapFilledRow('USA', 2022, { headcount: 0.0132, estimation_type: 'survey' })]);
    const result = await service.getPoverty(baseOpts, createMockContext());

    expect(pipCalls().map((url) => new URL(url).searchParams.get('fill_gaps'))).toEqual([
      'false',
      'true',
    ]);
    expect(result).toMatchObject({ total: 1, gapFilled: false, gapFillUnavailable: false });
    expect(result.rows[0]).toMatchObject({
      countryCode: 'USA',
      reportingYear: 2022,
      headcount: 0.014,
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

  /**
   * A surveyed year can lack a grain PIP's gap-filled series carries. BOL's 1990
   * survey covers urban areas only and PIP's estimate for 1990 is national; the
   * welfare-type case has no national instance in release 20260922, but nothing
   * in PIP's model rules it out.
   */
  it.each([
    [
      'a reporting level',
      surveyRow('BOL', 1990, { reporting_level: 'urban', headcount: 0.0582, gini: 0.4204 }),
      gapFilledRow('BOL', 1990, { headcount: 0.2204, estimation_type: 'extrapolation' }),
      [
        ['national', 'income', 0.2204, 'extrapolation', null],
        ['urban', 'income', 0.0582, 'survey', 0.4204],
      ],
    ],
    [
      'a welfare type',
      surveyRow('BOL', 1990, { headcount: 0.0582, gini: 0.4204 }),
      gapFilledRow('BOL', 1990, { welfare_type: 'consumption', headcount: 0.2204 }),
      [
        ['national', 'consumption', 0.2204, 'interpolation', null],
        ['national', 'income', 0.0582, 'survey', 0.4204],
      ],
    ],
  ])(
    "adds a single year's gap-filled estimate at %s its survey does not cover",
    async (_shape, survey, estimate, expected) => {
      mockRows([survey]);
      mockRows([estimate]);
      const result = await service.getPoverty(
        { ...baseOpts, countries: ['BOL'], year: '1990' },
        createMockContext(),
      );

      expect(pipCalls()).toHaveLength(2);
      expect(result).toMatchObject({ total: 2, gapFilled: true, gapFillUnavailable: false });
      expect(
        result.rows.map((row) => [
          row.reportingLevel,
          row.welfareType,
          row.headcount,
          row.estimationType,
          row.gini,
        ]),
      ).toEqual(expected);
    },
  );

  it("adds each listed economy's uncovered estimate for a single year", async () => {
    mockRows([
      surveyRow('URY', 1995, { reporting_level: 'urban', headcount: 0.0085 }),
      surveyRow('ECU', 1995, { reporting_level: 'urban', headcount: 0.1808 }),
    ]);
    mockRows([
      gapFilledRow('ECU', 1995, { headcount: 0.2238 }),
      gapFilledRow('URY', 1995, { headcount: 0.019, estimation_type: 'extrapolation' }),
    ]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['URY', 'ECU'], year: '1995' },
      createMockContext(),
    );

    expect(
      result.rows.map((row) => [
        row.countryCode,
        row.reportingLevel,
        row.headcount,
        row.estimationType,
      ]),
    ).toEqual([
      ['ECU', 'national', 0.2238, 'interpolation'],
      ['ECU', 'urban', 0.1808, 'survey'],
      ['URY', 'national', 0.019, 'extrapolation'],
      ['URY', 'urban', 0.0085, 'survey'],
    ]);
    expect(result.gapFilled).toBe(true);
  });

  it('keeps both rows when one pass repeats a grain, dropping only a twin across passes', async () => {
    mockRows([surveyRow('USA', 2022), surveyRow('USA', 2022, { headcount: 0.015 })]);
    mockRows([
      gapFilledRow('USA', 2022),
      gapFilledRow('USA', 2022, { reporting_level: 'urban' }),
      gapFilledRow('USA', 2022, { reporting_level: 'urban', headcount: 0.02 }),
    ]);
    const result = await service.getPoverty(baseOpts, createMockContext());

    expect(result.rows.map((row) => [row.reportingLevel, row.headcount])).toEqual([
      ['national', 0.014],
      ['national', 0.015],
      ['urban', 0.014],
      ['urban', 0.02],
    ]);
  });

  // ─── The two passes, concurrently ─────────────────────────────────────────

  /** A `/pip` request held open by {@link holdPipRequests}. */
  type HeldRequest = {
    url: string;
    signal: AbortSignal;
    answer: (rows: unknown[]) => void;
    fail: (error: unknown) => void;
  };

  /**
   * Hold every `/pip` request open until the test answers or fails it.
   * `started` resolves once the first request is in flight. A held request
   * whose signal aborts first rejects with the McpError `fetchWithTimeout`
   * raises for a caller abort.
   */
  async function holdPipRequests() {
    const { requestCancelled } = await import('@cyanheads/mcp-ts-core/errors');
    const held: HeldRequest[] = [];
    const started = Promise.withResolvers<void>();
    const serve = fetchWithTimeoutMock.getMockImplementation() as (
      ...args: unknown[]
    ) => Promise<unknown>;
    fetchWithTimeoutMock.mockImplementation(
      (url: string, timeout: number, ctx: unknown, options: { signal: AbortSignal }) => {
        if (!url.includes('/pip?')) return serve(url, timeout, ctx, options);
        return new Promise((resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(requestCancelled('PIP estimates was aborted.')),
            { once: true },
          );
          held.push({
            url,
            signal: options.signal,
            answer: (rows) => resolve({ text: async () => JSON.stringify(rows) }),
            fail: reject,
          });
          started.resolve();
        });
      },
    );
    return { held, started: started.promise };
  }

  it('has the survey and gap-filled requests in flight before either answers', async () => {
    const { held, started } = await holdPipRequests();
    const result = service.getPoverty(
      { ...baseOpts, countries: ['BOL'], year: '1990' },
      createMockContext(),
    );
    await started;
    await drainMicrotasks();

    expect(held.map(({ url }) => new URL(url).searchParams.get('fill_gaps'))).toEqual([
      'false',
      'true',
    ]);
    // Answered in the reverse order: the merge does not depend on which lands first.
    held[1]?.answer([gapFilledRow('BOL', 1990, { estimation_type: 'extrapolation' })]);
    held[0]?.answer([surveyRow('BOL', 1990, { reporting_level: 'urban' })]);
    await expect(result).resolves.toMatchObject({ total: 2, gapFilled: true });
  });

  describe('once the survey pass has answered every economy of a single year', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Start a request with both `/pip` passes held, and answer the survey pass. */
    async function surveyAnswered(year: string) {
      const { held, started } = await holdPipRequests();
      let settled = false;
      const request = service.getPoverty(
        { ...baseOpts, countries: ['BOL'], year },
        createMockContext(),
      );
      void request.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started;
      await drainMicrotasks();
      held[0]?.answer([surveyRow('BOL', 1990, { reporting_level: 'urban' })]);
      await drainMicrotasks();
      return { held, request, settled: () => settled };
    }

    it('answers from the survey rows 10 s later when the gap-filled pass is still out, abandoning it', async () => {
      const { held, request, settled } = await surveyAnswered('1990');

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await drainMicrotasks();
      expect(settled()).toBe(true);

      await expect(request).resolves.toMatchObject({
        total: 1,
        gapFilled: false,
        gapFillUnavailable: true,
      });
      expect(held[1]?.signal.aborted).toBe(true);
    });

    it('merges a gap-filled answer that lands inside those 10 s', async () => {
      const { held, request } = await surveyAnswered('1990');

      await vi.advanceTimersByTimeAsync(9_999);
      held[1]?.answer([gapFilledRow('BOL', 1990, { estimation_type: 'extrapolation' })]);

      await expect(request).resolves.toMatchObject({
        total: 2,
        gapFilled: true,
        gapFillUnavailable: false,
      });
    });

    it('keeps waiting on a shape that needs the gap-filled rows', async () => {
      const { held, request, settled } = await surveyAnswered('all');

      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled()).toBe(false);
      held[1]?.answer([gapFilledRow('BOL', 1991, { estimation_type: 'interpolation' })]);

      await expect(request).resolves.toMatchObject({
        total: 2,
        gapFilled: true,
        gapFillUnavailable: false,
      });
    });
  });

  /**
   * The survey request already accepted the same parameters, so any upstream
   * failure of the gap-filled one — an error status, a bot-check page, an
   * unreadable body — is PIP's, and the survey rows still hold every economy.
   */
  it.each([
    ['an HTTP 503', () => mockHttpError(503, '{"error":["Service Unavailable"]}')],
    ['a timeout', () => mockTimeout()],
    [
      'an HTTP 404 naming a parameter',
      () => mockHttpError(404, validationBody('fill_gaps', ['true', 'false'])),
    ],
    ['an HTTP 403 page', () => mockHttpError(403, '<html><title>Just a moment...</title></html>')],
    ['a 200 body that is not JSON', () => mockBody('[{"country_code":"BOL","reporting_year":19')],
  ])(
    'answers a fully surveyed single year from its survey rows when the gap-filled pass meets %s',
    async (_failure, fail) => {
      mockRows([surveyRow('BOL', 1990, { reporting_level: 'urban', headcount: 0.0582 })]);
      await fail();
      const result = await service.getPoverty(
        { ...baseOpts, countries: ['BOL'], year: '1990' },
        createMockContext(),
      );

      expect(pipCalls()).toHaveLength(2);
      expect(result).toMatchObject({ total: 1, gapFilled: false, gapFillUnavailable: true });
      expect(result.rows.map((row) => [row.reportingLevel, row.estimationType])).toEqual([
        ['urban', 'survey'],
      ]);
    },
  );

  /**
   * Every shape but a fully surveyed single year needs the gap-filled rows for
   * whole economies or years, so its failure fails the call, as it always has.
   */
  it.each([
    ['an economy no survey covers that year', { countries: ['USA', 'IND'] }],
    ['every economy', { countries: ['all'] }],
    ['the whole window', { year: 'all' }],
    ['the most recent year', { year: 'MRV' }],
  ])('fails when the gap-filled pass fails for %s', async (_shape, opts) => {
    mockRows([surveyRow('USA', 2022)]);
    await mockHttpError(503, '{"error":["Service Unavailable"]}');

    await expect(
      service.getPoverty({ ...baseOpts, ...opts }, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', status: 503 },
    });
  });

  it('answers a fully surveyed single year from its survey rows when the gap-filled response is malformed', async () => {
    mockRows([surveyRow('USA', 2022)]);
    mockBody('{"unexpected":"object"}');

    await expect(service.getPoverty(baseOpts, createMockContext())).resolves.toMatchObject({
      total: 1,
      gapFilled: false,
      gapFillUnavailable: true,
    });
  });

  it('rejects with the cancellation, never survey rows alone, when the caller aborts the gap-filled pass', async () => {
    const { held, started } = await holdPipRequests();
    const cancelled = new AbortController();
    const request = service.getPoverty(
      { ...baseOpts, countries: ['BOL'], year: '1990' },
      createMockContext({ signal: cancelled.signal }),
    );
    await started;
    await drainMicrotasks();
    held[0]?.answer([surveyRow('BOL', 1990, { reporting_level: 'urban' })]);
    await drainMicrotasks();
    cancelled.abort();

    const outcome = await request.then(
      (value) => ({ settled: 'resolved', value }),
      (error: unknown) => ({ settled: 'rejected', error }),
    );
    expect(outcome).toMatchObject({
      settled: 'rejected',
      error: { code: JsonRpcErrorCode.RequestCancelled, message: 'PIP estimates was aborted.' },
    });
    expect(outcome).not.toHaveProperty('value');
  });

  it('fails with the survey error and abandons the gap-filled request still in flight', async () => {
    const { held, started } = await holdPipRequests();
    const ctx = createMockContext();
    const request = service.getPoverty({ ...baseOpts, countries: ['BOL'], year: '1990' }, ctx);
    await started;
    await drainMicrotasks();
    const [survey, filled] = held;

    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    survey?.fail(serviceUnavailable('Fetch failed with status 502.', { status: 502 }));

    await expect(request).rejects.toMatchObject({
      data: { reason: 'upstream_unavailable', status: 502 },
    });
    expect(filled?.signal.aborted).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
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

  it('keeps a single year at its survey rows alone, from one request, when fillGaps is false', async () => {
    mockRows([surveyRow('BOL', 1990, { reporting_level: 'urban' })]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['BOL'], year: '1990', fillGaps: false },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(1);
    expect(result).toMatchObject({ total: 1, gapFilled: false });
    expect(result.rows.map((row) => row.reportingLevel)).toEqual(['urban']);
  });

  it('drops a partial decile run rather than reporting shares against the wrong deciles', async () => {
    mockRows([surveyRow('USA', 2022, { decile7: null })]);
    mockRows([gapFilledRow('USA', 2022)]);
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

    // Covered by a survey row, but the years around it are not — the gap-filled
    // pass adds them, so both passes run and four rows come back.
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

  it('resolves MRV to the newest year either pass answers, one year per economy', async () => {
    mockRows([surveyRow('USA', 2024)]);
    mockRows([
      gapFilledRow('USA', 2026, { estimation_type: 'extrapolation' }),
      gapFilledRow('ABW', 2026, { estimation_type: 'CMD estimation', is_interpolated: false }),
    ]);

    const result = await service.getPoverty(
      { ...baseOpts, countries: ['USA', 'ABW'], year: 'MRV' },
      createMockContext(),
    );

    // Every economy answered the survey pass or not, MRV still asks for estimates:
    // PIP's latest estimate year is the most recent year available.
    expect(pipCalls()).toHaveLength(2);
    expect(result.gapFilled).toBe(true);
    expect(
      result.rows.map((row) => [row.countryCode, row.reportingYear, row.estimationType]),
    ).toEqual([
      ['ABW', 2026, 'CMD estimation'],
      ['USA', 2026, 'extrapolation'],
    ]);
  });

  it('keeps MRV at the latest survey year, from one request, when fillGaps is false', async () => {
    mockRows([surveyRow('USA', 2024)]);
    const result = await service.getPoverty(
      { ...baseOpts, year: 'MRV', fillGaps: false },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(1);
    expect(result.rows.map((row) => [row.reportingYear, row.gini])).toEqual([[2024, 0.417]]);
  });

  it('answers MRV from the survey row when the estimate pass has nothing newer at any grain', async () => {
    mockRows([surveyRow('USA', 2024)]);
    mockRows([]);

    const result = await service.getPoverty({ ...baseOpts, year: 'mrv' }, createMockContext());

    expect(result.rows.map((row) => [row.reportingYear, row.estimationType])).toEqual([
      [2024, 'survey'],
    ]);
    expect(result.gapFilled).toBe(false);
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

  it.each([50, 69, 70, 71, 1000, 1001])(
    'serves estimate page size %i at the endpoint maximum only',
    async (requested) => {
      const years = Array.from({ length: 200 }, (_, index) => 1800 + index);
      mockRows(years.map((year) => surveyRow('USA', year)));
      const result = await service.getPoverty(
        { ...baseOpts, year: 'all', fillGaps: false, perPage: requested },
        createMockContext(),
      );
      const served = Math.min(requested, 1000);
      expect(result).toMatchObject({ total: 200, perPage: served, pages: Math.ceil(200 / served) });
      expect(result.rows.map((row) => row.reportingYear)).toEqual(years.slice(0, served));
    },
  );

  it('serves a requested page beyond the former estimate cap', async () => {
    const years = Array.from({ length: 200 }, (_, index) => 1800 + index);
    mockRows(years.map((year) => surveyRow('USA', year)));

    const result = await service.getPoverty(
      { ...baseOpts, year: 'all', fillGaps: false, page: 2, perPage: 100 },
      createMockContext(),
    );

    expect(result).toMatchObject({ total: 200, perPage: 100, page: 2, pages: 2 });
    expect(result.rows).toHaveLength(100);
    expect(result.rows[0]?.reportingYear).toBe(1900);
    expect(result.rows.at(-1)?.reportingYear).toBe(1999);
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

  it('sends only the filters the caller supplied, on both passes', async () => {
    mockRows([surveyRow('USA', 2022)]);
    mockRows([gapFilledRow('USA', 2022)]);
    await service.getPoverty(
      {
        ...baseOpts,
        povertyLine: 2.15,
        welfareType: 'income',
        reportingLevel: 'national',
      },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(2);
    for (const url of pipCalls()) {
      expect(url).toContain('https://api.worldbank.org/pip/v1/pip?');
      expect(url).toContain('povline=2.15');
      expect(url).toContain('welfare_type=income');
      expect(url).toContain('reporting_level=national');
    }
  });

  it('omits povline entirely when the caller did not pick a poverty line', async () => {
    mockRows([surveyRow('USA', 2022)]);
    mockRows([gapFilledRow('USA', 2022)]);
    await service.getPoverty(baseOpts, createMockContext());
    expect(pipCalls()).toHaveLength(2);
    for (const url of pipCalls()) expect(url).not.toContain('povline');
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
    const codes = Array.from({ length: 40 }, (_, index) => `V${String.fromCharCode(65 + index)}`);
    await mockHttpError(404, validationBody('year', codes));
    const promise = service.getPoverty(baseOpts, createMockContext());

    // The recovery hint is what resolves the call; 40 values in front of it is noise.
    await expect(promise).rejects.toThrow(/rejected the value supplied for year\.$/);
    await expect(promise).rejects.not.toThrow(/VA/);
    const error = await promise.catch((e: unknown) => e);
    expect((error as { data: Record<string, unknown> }).data).not.toHaveProperty('acceptedValues');
  });

  it("summarizes year's accepted values as a span rather than listing 66 of them", async () => {
    const years = Array.from({ length: 64 }, (_, index) => String(1963 + index));
    await mockHttpError(404, validationBody('year', ['all', 'MRV', ...years]));
    const promise = service.getPoverty(baseOpts, createMockContext());

    await expect(promise).rejects.toThrow(
      'PIP rejected the value supplied for year. Accepted values: year accepts all, MRV, 1963–2026.',
    );
    await expect(promise).rejects.toMatchObject({
      data: {
        reason: 'invalid_parameter',
        parameters: ['year'],
        acceptedValues: { year: ['all', 'MRV', '1963–2026'] },
        retryable: false,
      },
    });
  });

  it.each([
    [['2000', '2001', '2002', '2005'], 'year accepts 2000–2002, 2005'],
    [['1990', '1991'], 'year accepts 1990, 1991'],
    [['2010', '2008', '2009'], 'year accepts 2010, 2008, 2009'],
    [[0, 2700], 'year accepts 0, 2700'],
  ])('collapses only a run of consecutive values into a range: %j', async (valid, expected) => {
    await mockHttpError(404, validationBody('year', valid));
    await expect(service.getPoverty(baseOpts, createMockContext())).rejects.toThrow(
      `Accepted values: ${expected}.`,
    );
  });

  it.each([
    [12, true],
    [13, false],
  ])('quotes a list that summarizes to %i entries: %s', async (count, quoted) => {
    const values = Array.from({ length: count }, (_, index) => `v${index}`);
    await mockHttpError(404, validationBody('year', values));
    const error = (await service
      .getPoverty(baseOpts, createMockContext())
      .catch((e: unknown) => e)) as { message: string; data: Record<string, unknown> };

    expect(error.message.includes('Accepted values: year accepts v0,')).toBe(quoted);
    expect('acceptedValues' in error.data).toBe(quoted);
  });

  it('quotes nothing for a rejected parameter PIP sent an empty list for', async () => {
    await mockHttpError(404, validationBody('year', []));
    const promise = service.getPoverty(baseOpts, createMockContext());

    await expect(promise).rejects.toThrow(/^PIP rejected the value supplied for year\.$/);
    await expect(promise).rejects.toMatchObject({ data: { parameters: ['year'] } });
  });

  it('reads an unkeyed rejection as naming no parameter, rather than one called details', async () => {
    await mockHttpError(
      404,
      JSON.stringify({
        error: ['Invalid query arguments have been submitted.'],
        details: { msg: ['The selected value is not available.'], valid: VERSIONS },
      }),
    );
    const promise = service.getPoverty(baseOpts, createMockContext());

    await expect(promise).rejects.toThrow('PIP rejected the value supplied for a query parameter.');
    await expect(promise).rejects.toMatchObject({
      data: { reason: 'invalid_parameter', parameters: [] },
    });
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

  it('maps a 5xx to upstream_unavailable, stating the status and no cause it cannot see', async () => {
    await mockHttpError(500, '{"error":["Error in /api/v1/pip"]}');
    const promise = service.getPoverty(baseOpts, createMockContext());

    await expect(promise).rejects.toMatchObject({
      data: { reason: 'upstream_unavailable', countryCodes: 'USA', status: 500 },
    });
    await expect(promise).rejects.toThrow(
      'PIP returned HTTP 500 for country code(s) "USA", with no detail on the cause.',
    );
  });

  // ─── Aggregates ───────────────────────────────────────────────────────────

  it('sends an aggregate to /pip-grp alone, never to /pip', async () => {
    mockRows([groupRow('WLD', 2022)]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['wld'], year: '2022' },
      createMockContext(),
    );

    expect(pipCalls()).toHaveLength(0);
    const [url] = groupCalls();
    expect(new URL(String(url)).searchParams.get('group_by')).toBe('wb');
    expect(result.countries).toEqual(['WLD']);
    expect(result.rows[0]).toMatchObject({ countryCode: 'WLD', isAggregate: true });
  });

  it("reads WDI's LMC as PIP's LMIC and asks for it once", async () => {
    mockRows([groupRow('LMIC', 2022)]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['LMC', 'lmic'], year: '2022' },
      createMockContext(),
    );

    expect(new URL(String(groupCalls()[0])).searchParams.get('country')).toBe('LMIC');
    expect(result.countries).toEqual(['LMIC']);
  });

  it('keeps an aggregate row honest about the fields /pip-grp does not publish', async () => {
    const { pop_in_poverty: _omitted, ...sparse } = groupRow('SSF', 2022);
    mockRows([sparse]);
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['SSF'], year: '2022' },
      createMockContext(),
    );

    expect(result.rows[0]).toMatchObject({
      countryCode: 'SSF',
      popInPoverty: null,
      median: null,
      reportingLevel: null,
      welfareType: null,
      isInterpolated: null,
      regionCode: null,
      estimationType: 'actual',
    });
  });

  it('skips the regions table for a request of all alone', async () => {
    mockRows([surveyRow('USA', 2022)]);
    mockRows([]);
    await service.getPoverty({ ...baseOpts, countries: ['all'] }, createMockContext());
    expect(fetchCalls().some((url) => url.includes('/aux'))).toBe(false);
  });

  // ─── Shared reference loads ───────────────────────────────────────────────

  /**
   * Hold `/versions` and the `/aux` tables open until the returned gate is
   * released. A query naming an economy or an aggregate reads two of them —
   * `/versions` and the regions table — so the gate waits for two in flight.
   */
  function holdReferenceListings() {
    const gate = holdOpen(2);
    const serve = fetchWithTimeoutMock.getMockImplementation() as
      | ((...args: unknown[]) => unknown)
      | undefined;
    fetchWithTimeoutMock.mockImplementation(
      async (url: string, timeout: number, ctx: unknown, options?: { signal?: AbortSignal }) => {
        if (url.includes('/versions') || url.includes('/aux?')) {
          await gate.wait(options?.signal);
        }
        return serve?.(url, timeout, ctx, options);
      },
    );
    return gate;
  }

  it('fails only the caller that cancels while a concurrent caller shares the reference loads', async () => {
    const gate = holdReferenceListings();
    mockRows([surveyRow('USA', 2022)]);
    mockRows([gapFilledRow('USA', 2022)]);
    const cancelled = new AbortController();

    const first = service.getPoverty(baseOpts, createMockContext({ signal: cancelled.signal }));
    await gate.entered;
    const second = service.getPoverty(baseOpts, createMockContext());
    cancelled.abort();
    gate.release();

    const [cancelledOutcome, concurrentOutcome] = await Promise.allSettled([first, second]);

    expect(concurrentOutcome).toMatchObject({ status: 'fulfilled', value: { total: 1 } });
    expect(cancelledOutcome).toEqual({ status: 'rejected', reason: cancelled.signal.reason });
    expect(versionsCalls()).toHaveLength(1);
  });

  it('keeps a reference load every caller abandoned, and serves the next caller from it', async () => {
    const gate = holdReferenceListings();
    mockRows([surveyRow('USA', 2022)]);
    mockRows([gapFilledRow('USA', 2022)]);
    const cancelled = new AbortController();

    const abandoned = service.getPoverty(baseOpts, createMockContext({ signal: cancelled.signal }));
    await gate.entered;
    cancelled.abort();
    await expect(abandoned).rejects.toThrow();

    gate.release();
    await drainMicrotasks();
    await expect(service.getPoverty(baseOpts, createMockContext())).resolves.toMatchObject({
      total: 1,
    });
    expect(versionsCalls()).toHaveLength(1);
  });

  it("still throws a caller's own cancellation during the regions-table load rather than degrading", async () => {
    const gate = holdReferenceListings();
    const cancelled = new AbortController();

    const request = service.getPoverty(
      { ...baseOpts, countries: ['SSF'] },
      createMockContext({ signal: cancelled.signal }),
    );
    await gate.entered;
    cancelled.abort();

    await expect(request).rejects.toThrow();
    expect(pipCalls()).toHaveLength(0);
    expect(groupCalls()).toHaveLength(0);
  });

  // ─── Model-estimate-only economies ────────────────────────────────────────

  it('names only the codes neither list carries, and asks for no all-economy response', async () => {
    await mockHttpError(404, validationBody('country', ['USA', 'IND']));
    await mockHttpError(404, validationBody('country', ['USA', 'IND']));
    await expect(
      service.getPoverty({ ...baseOpts, countries: ['USA', 'ZZZ'] }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'country_not_found', countryCodes: 'ZZZ' } });
    // The survey request and the gap-filled one beside it, both for the codes sent.
    expect(pipCalls().map((url) => new URL(url).searchParams.get('country'))).toEqual([
      'USA,ZZZ',
      'USA,ZZZ',
    ]);
  });

  it('keeps country_not_found for the whole batch when the rejection carries no list', async () => {
    await mockHttpError(404, validationBody('country', []).replace(',"valid":[]', ''));
    await expect(
      service.getPoverty({ ...baseOpts, countries: ['AFG'] }, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'country_not_found', countryCodes: 'AFG' } });
    expect(fetchCalls().some((url) => url.includes('country_list'))).toBe(false);
  });

  it('reports a model-estimate-only economy it left out under fillGaps false', async () => {
    await mockHttpError(404, validationBody('country', ['USA', 'IND']));
    const result = await service.getPoverty(
      { ...baseOpts, countries: ['AFG'], fillGaps: false },
      createMockContext(),
    );
    expect(result).toMatchObject({ rows: [], total: 0, modelOnly: ['AFG'] });
    expect(pipCalls()).toHaveLength(1);
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

  it('throws a serialization error, without a retry, when a 200 body is not JSON', async () => {
    mockBody('[{"country_code":"BRA","reporting_year":20');
    mockRows([surveyRow('BRA', 2022)]);

    await expect(
      service.getPoverty({ ...baseOpts, countries: ['BRA'], fillGaps: false }, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'PIP returned a response that is not JSON.',
    });
    expect(pipCalls()).toHaveLength(1);
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
    mockRows([gapFilledRow('USA', 2022)]);

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
    for (let call = 0; call < 2; call++) {
      mockRows([surveyRow('USA', 2022)]);
      mockRows([gapFilledRow('USA', 2022)]);
    }
    const ctx = createMockContext();

    await service.getPoverty(baseOpts, ctx);
    await service.getPoverty({ ...baseOpts, pppVersion: '2017' }, ctx);

    expect(versionsCalls()).toHaveLength(1);
    expect(pipCalls()).toHaveLength(4);
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
    for (let call = 0; call < 2; call++) {
      mockRows([surveyRow('USA', 2022)]);
      mockRows([gapFilledRow('USA', 2022)]);
    }

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
    mockRows([gapFilledRow('USA', 2022)]);
    const result = await service.getPoverty(baseOpts, createMockContext());
    expect(result.rows[0]).toMatchObject({ surveyComparability: null, comparableSpell: null });
  });
});
