/**
 * @fileoverview worldbank_get_poverty end to end over its real services, with
 * only the network stubbed: how each requested code is resolved and routed —
 * ISO2 codes through the country index, aggregate codes to PIP's group
 * aggregates, model-estimate-only economies to the all-economy response — how
 * `MRV` resolves, and how rows from several upstream requests merge into one
 * paginated list. The fake answers each upstream request from fixed fixtures and
 * never builds rows out of the request it was sent, and any request it does not
 * recognize fails the test.
 * @module tests/tools/worldbank-get-poverty-routing.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankGetPoverty } from '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { initPipService } from '@/services/pip/pip-service.js';
import { initWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    pipBaseUrl: 'https://api.worldbank.org/pip/v1',
    projectsBaseUrl: 'https://search.worldbank.org/api/v3',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

// ─── Upstream fixtures ────────────────────────────────────────────────────────

const VERSIONS = [
  {
    version: '20260922_2021_01_02_PROD',
    release_version: '20260922',
    ppp_version: '2021',
    identity: 'PROD',
  },
  {
    version: '20260922_2017_01_02_PROD',
    release_version: '20260922',
    ppp_version: '2017',
    identity: 'PROD',
  },
];

/** `/aux?table=regions` as release 20260922 publishes it. */
const REGIONS = [
  ['AFE', 'Eastern and Southern Africa', 'africa_split'],
  ['AFW', 'Western and Central Africa', 'africa_split'],
  ['FCVN', 'Not-fragile', 'fcv'],
  ['FCVY', 'Fragile', 'fcv'],
  ['BLND', 'Blend', 'ida'],
  ['IBRD', 'IBRD', 'ida'],
  ['IDA', 'IDA', 'ida'],
  ['REST', 'Rest of the world', 'ida'],
  ['HIC', 'High income', 'incgroup'],
  ['LIC', 'Low income', 'incgroup'],
  ['LMIC', 'Lower middle income', 'incgroup'],
  ['UMIC', 'Upper middle income', 'incgroup'],
  ['EAS', 'East Asia & Pacific', 'region'],
  ['ECS', 'Europe & Central Asia', 'region'],
  ['LCN', 'Latin America & Caribbean', 'region'],
  ['MEA', 'Middle East, North Africa, Afghanistan & Pakistan', 'region'],
  ['NAC', 'North America', 'region'],
  ['SAS', 'South Asia', 'region'],
  ['SSF', 'Sub-Saharan Africa', 'region'],
  ['EAP', 'East Asia & Pacific', 'regionpcn'],
  ['ECA', 'Europe & Central Asia', 'regionpcn'],
  ['LAC', 'Latin America & Caribbean', 'regionpcn'],
  ['MNA', 'Middle East & North Africa', 'regionpcn'],
  ['OHI', 'Other High Income Countries', 'regionpcn'],
  ['SAR', 'South Asia', 'regionpcn'],
  ['SSA', 'Sub-Saharan Africa', 'regionpcn'],
  ['WLD', 'World', 'world'],
].map(([region_code, region, grouping_type]) => ({ region_code, region, grouping_type }));

/** Surveyed economies in these fixtures — the ones `/pip` accepts by code. */
const SURVEYED = ['CHN', 'IND', 'KEN', 'NGA', 'PHL', 'SSD', 'USA'];

/** Economies PIP publishes only as model estimates: in `country=all`, never accepted by code. */
const MODEL_ONLY = ['AFG', 'GUM'];

/** `country`'s accepted values in a `/pip` 404: `ALL`, every aggregate code, and the surveyed economies. */
const PIP_COUNTRY_VALUES = ['ALL', ...REGIONS.map((r) => r.region_code), ...SURVEYED];

/** `/aux?table=country_list`: every economy PIP publishes, model-estimate-only ones included. */
const COUNTRY_LIST = [...SURVEYED, ...MODEL_ONLY].map((country_code) => ({
  country_code,
  country_name: `Economy ${country_code}`,
}));

/** The World Bank country listing behind two-character code resolution. */
const WB_COUNTRIES = [
  ['NGA', 'NG', 'SSF'],
  ['KEN', 'KE', 'SSF'],
  ['GUM', 'GU', 'EAS'],
  ['SSF', 'ZG', 'NA'],
  ['WLD', '1W', 'NA'],
  ['HIC', 'XD', 'NA'],
  ['LMC', 'XN', 'NA'],
  ['SSA', 'ZF', 'NA'],
  ['ARB', '1A', 'NA'],
  ['IDA', 'XG', 'NA'],
  ['IDX', 'XI', 'NA'],
  ['IDB', 'XH', 'NA'],
  ['IBD', 'XF', 'NA'],
].map(([id, iso2Code, region]) => ({
  id,
  iso2Code,
  name: `Entity ${id}`,
  region: { id: region, value: '' },
  incomeLevel: { id: region === 'NA' ? 'NA' : 'LMC', value: '' },
}));

/** A survey-derived `/pip` row: the distributional block is present. */
function surveyRow(countryCode: string, reportingYear: number, overrides = {}) {
  return {
    region_name: 'Sub-Saharan Africa',
    region_code: 'SSA',
    country_name: `Economy ${countryCode}`,
    country_code: countryCode,
    reporting_year: reportingYear,
    reporting_level: 'national',
    survey_acronym: 'LSS',
    survey_year: reportingYear,
    welfare_type: 'consumption',
    survey_comparability: 1,
    comparable_spell: String(reportingYear),
    poverty_line: 3,
    headcount: 0.3419,
    poverty_gap: 0.1,
    poverty_severity: 0.05,
    watts: 0.13,
    mean: 5.2,
    median: 3.9,
    mld: 0.23,
    gini: 0.351,
    polarization: 0.29,
    decile1: 0.03,
    decile2: 0.04,
    decile3: 0.05,
    decile4: 0.06,
    decile5: 0.07,
    decile6: 0.08,
    decile7: 0.1,
    decile8: 0.12,
    decile9: 0.16,
    decile10: 0.29,
    reporting_pop: 196_000_000,
    is_interpolated: false,
    estimation_type: 'survey',
    ...overrides,
  };
}

/** A gap-filled `/pip` row: poverty measures present, distributional block null. */
function estimateRow(countryCode: string, reportingYear: number, overrides = {}) {
  return {
    ...surveyRow(countryCode, reportingYear),
    survey_acronym: null,
    survey_year: null,
    survey_comparability: null,
    comparable_spell: null,
    median: null,
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
    headcount: 0.4,
    is_interpolated: true,
    estimation_type: 'extrapolation',
    ...overrides,
  };
}

/** A `/pip-grp` row, as PIP publishes an aggregate. */
function groupRow(code: string, name: string, reportingYear: number, overrides = {}) {
  return {
    region_code: code,
    region_name: name,
    reporting_year: reportingYear,
    poverty_line: 3,
    reporting_pop: 1_229_000_000,
    headcount: 0.4562,
    poverty_gap: 0.19,
    poverty_severity: 0.1,
    watts: 0.29,
    mean: 4.8,
    spr: 0.49,
    pg: 11.2,
    pop_in_poverty: 560_000_000,
    estimate_type: 'actual',
    ...overrides,
  };
}

/** PIP's 404 body rejecting `country`, carrying its accepted values. */
const COUNTRY_REJECTION = JSON.stringify({
  error: ['Invalid query arguments have been submitted.'],
  details: {
    country: {
      msg: ['You supplied an invalid value for country. Please use one of the valid values.'],
      valid: PIP_COUNTRY_VALUES,
    },
  },
});

// ─── Network fake ─────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();

/** Every URL requested so far, in order. */
function requested(): URL[] {
  return fetchMock.mock.calls.map(
    ([input]) => new URL(String(input instanceof Request ? input.url : input)),
  );
}

function requestsTo(path: string): URL[] {
  return requested().filter((url) => url.pathname.endsWith(path));
}

/** `/pip` data requests, in order. */
const pipRequests = () => requestsTo('/pip/v1/pip');
/** `/pip-grp` requests, in order. */
const groupRequests = () => requestsTo('/pip/v1/pip-grp');

/** Rows to answer a request with, a whole response (an upstream failure), or `undefined` when unexpected. */
type Fixture = (params: URLSearchParams) => unknown[] | Response | undefined;

/**
 * Answer the reference endpoints from the fixtures above, `/pip` from `pip`,
 * and `/pip-grp` from `groups`. `/pip` rejects any code outside its accepted
 * list with the 404 PIP sends, and `/pip-grp` rejects an economy code with the
 * 400 PIP sends. A fixture returning `undefined` means the test did not expect
 * that request. With `regionsDown`, the regions table answers HTTP 503.
 */
function serve(
  pip: Fixture,
  groups: Fixture = () => undefined,
  { regionsDown = false }: { regionsDown?: boolean } = {},
) {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const params = url.searchParams;
    const path = url.pathname;

    if (path === '/v2/country') {
      return Response.json([
        { page: 1, pages: 1, per_page: 10_000, total: WB_COUNTRIES.length },
        WB_COUNTRIES,
      ]);
    }
    if (path === '/pip/v1/versions') return Response.json(VERSIONS);
    if (path === '/pip/v1/aux' && params.get('table') === 'regions') {
      return regionsDown
        ? new Response('{"error":["Internal Server Error"]}', { status: 503 })
        : Response.json(REGIONS);
    }
    if (path === '/pip/v1/aux' && params.get('table') === 'country_list') {
      return Response.json(COUNTRY_LIST);
    }
    if (path === '/pip/v1/pip') {
      const codes = (params.get('country') ?? '').split(',');
      if (codes.some((code) => !PIP_COUNTRY_VALUES.includes(code.toUpperCase()))) {
        return new Response(COUNTRY_REJECTION, { status: 404 });
      }
      const rows = pip(params);
      if (rows instanceof Response) return rows;
      if (rows) return Response.json(rows);
    }
    if (path === '/pip/v1/pip-grp') {
      const codes = (params.get('country') ?? '').split(',');
      if (codes.some((code) => !REGIONS.some((r) => r.region_code === code))) {
        return new Response('{"error":["Invalid query arguments have been submitted."]}', {
          status: 400,
        });
      }
      const rows = groups(params);
      if (rows instanceof Response) return rows;
      if (rows) return Response.json(rows);
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
}

type Structured = {
  estimates: Array<Record<string, unknown>>;
  appliedFilters: Record<string, unknown>;
  totalCount: number;
  totalPages: number;
  currentPage: number;
  notice?: string;
};

/** The structured result and the whole content[] text of a successful call. */
async function call(input: Record<string, unknown>) {
  const result = await runToolContract(worldbankGetPoverty, input as never);
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  if (result.isError) throw new Error(`tool failed: ${text}`);
  return { structured: result.structuredContent as Structured, text };
}

/** The error envelope and the whole content[] text of a failed call. */
async function failure(input: Record<string, unknown>) {
  const result = await runToolContract(worldbankGetPoverty, input as never);
  expect(result.isError).toBe(true);
  const error = (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  return { error, text };
}

/** `[code, year, estimationType]` per estimate — the shape most assertions compare. */
const summary = (structured: Structured) =>
  structured.estimates.map((row) => [row.countryCode, row.reportingYear, row.estimationType]);

describe('worldbank_get_poverty routing', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
    initPipService({} as never, createInMemoryStorage());
    initWorldBankApiService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Surveyed economies (the fast path) ───────────────────────────────────

  it('answers a surveyed economy for one year from one /pip request and nothing else', async () => {
    serve((params) =>
      params.get('country') === 'NGA' && params.get('fill_gaps') === 'false'
        ? [surveyRow('NGA', 2018)]
        : undefined,
    );
    const { structured, text } = await call({ countries: 'NGA', year: '2018' });

    expect(summary(structured)).toEqual([['NGA', 2018, 'survey']]);
    expect(pipRequests()).toHaveLength(1);
    expect(groupRequests()).toHaveLength(0);
    expect(requested().some((url) => url.searchParams.get('country') === 'all')).toBe(false);
    expect(requestsTo('/v2/country')).toHaveLength(0);
    expect(structured.appliedFilters.countries).toBe('NGA');
    expect(text).toContain('Economy NGA (NGA) — 2018, national');
  });

  it('asks no reference table again once the regions table is cached', async () => {
    serve((params) => (params.get('country') === 'NGA' ? [surveyRow('NGA', 2018)] : undefined));
    await call({ countries: 'NGA', year: '2018' });
    const before = requested().length;
    await call({ countries: 'NGA', year: '2018' });

    const second = requested().slice(before);
    expect(second.map((url) => url.pathname)).toEqual(['/pip/v1/pip']);
  });

  it('keeps MRV at the latest survey year per economy when fill_gaps is false', async () => {
    serve((params) =>
      params.get('fill_gaps') === 'false' && params.get('year') === 'MRV'
        ? [
            surveyRow('IND', 2023, { gini: 0.23 }),
            surveyRow('SSD', 2016, { gini: 0.4405, headcount: 0.765 }),
          ]
        : undefined,
    );
    const { structured } = await call({ countries: ['SSD', 'IND'], year: 'MRV', fill_gaps: false });

    expect(summary(structured)).toEqual([
      ['IND', 2023, 'survey'],
      ['SSD', 2016, 'survey'],
    ]);
    expect(structured.estimates.map((row) => row.gini)).toEqual([0.23, 0.4405]);
    expect(pipRequests()).toHaveLength(1);
    expect(structured.notice ?? '').not.toMatch(/gap-filled/);
  });

  // ─── #53: two-character codes ─────────────────────────────────────────────

  it.each([
    ['NG', ['NGA'], 'NGA'],
    [['ng'], ['NGA'], 'NGA'],
    ['NG;KEN', ['NGA', 'KEN'], 'NGA,KEN'],
    ['NG,NGA', ['NGA'], 'NGA'],
  ])('resolves %j through the country index before querying PIP', async (countries, sent, echo) => {
    serve((params) =>
      params.get('fill_gaps') === 'false'
        ? (params.get('country') ?? '').split(',').map((code) => surveyRow(code, 2018))
        : undefined,
    );
    const { structured } = await call({ countries, year: '2018' });

    expect(pipRequests()[0]?.searchParams.get('country')).toBe(sent.join(','));
    expect(structured.appliedFilters.countries).toBe(echo);
  });

  it('fails an unmappable two-character code as country_not_found before asking PIP', async () => {
    serve(() => undefined);
    const { error, text } = await failure({ countries: 'QQ', year: '2018' });

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'country_not_found', retryable: false });
    expect(error.message).toContain('"QQ"');
    expect(pipRequests()).toHaveLength(0);
    expect(text).toMatch(/\(reason country_not_found · not retryable\)/);
  });

  it('routes an aggregate reached by its two-character code the way its own code routes', async () => {
    serve(
      () => undefined,
      (params) =>
        params.get('country') === 'SSF' && params.get('group_by') === 'wb'
          ? [groupRow('SSF', 'Sub-Saharan Africa', 2022)]
          : undefined,
    );
    const { structured } = await call({ countries: 'ZG', year: '2022' });

    expect(summary(structured)).toEqual([['SSF', 2022, 'actual']]);
    expect(structured.appliedFilters.countries).toBe('SSF');
    expect(pipRequests()).toHaveLength(0);
  });

  it('never loads the country index for a request with no two-character code', async () => {
    serve((params) => (params.get('country') === 'KEN' ? [surveyRow('KEN', 2021)] : undefined));
    await call({ countries: ['KEN'], year: '2021' });
    expect(requestsTo('/v2/country')).toHaveLength(0);
  });

  // ─── #52 / #58: aggregates ────────────────────────────────────────────────

  it('answers a region from /pip-grp, flagged as an aggregate, with no /pip request', async () => {
    serve(
      () => undefined,
      (params) =>
        params.get('country') === 'SSF' && params.get('group_by') === 'wb'
          ? [groupRow('SSF', 'Sub-Saharan Africa', 2022, { poverty_line: 6.85, headcount: 0.8375 })]
          : undefined,
    );
    const { structured, text } = await call({ countries: 'SSF', year: '2022', poverty_line: 6.85 });

    expect(pipRequests()).toHaveLength(0);
    const grp = groupRequests()[0];
    expect(grp?.searchParams.get('povline')).toBe('6.85');
    expect(grp?.searchParams.get('version')).toBe('20260922_2021_01_02_PROD');
    expect(structured.estimates[0]).toMatchObject({
      countryCode: 'SSF',
      countryName: 'Sub-Saharan Africa',
      isAggregate: true,
      popInPoverty: 560_000_000,
      headcount: 0.8375,
      estimationType: 'actual',
      reportingLevel: null,
      welfareType: null,
      isInterpolated: null,
      median: null,
      gini: null,
      decileShares: null,
      surveyYear: null,
    });
    expect(structured.notice).toMatch(/aggregate/i);
    expect(text).toContain('Sub-Saharan Africa (SSF) — 2022, aggregate');
    expect(text).toContain('**popInPoverty:** 560000000');
    expect(text).toContain('**isAggregate:** true');
  });

  it('merges an economy and a region into one list at one pinned version', async () => {
    serve(
      (params) =>
        params.get('country') === 'NGA' && params.get('fill_gaps') === 'false'
          ? [surveyRow('NGA', 2022)]
          : undefined,
      (params) =>
        params.get('country') === 'SSF' ? [groupRow('SSF', 'Sub-Saharan Africa', 2022)] : undefined,
    );
    const { structured } = await call({ countries: ['NGA', 'SSF'], year: '2022' });

    expect(summary(structured)).toEqual([
      ['NGA', 2022, 'survey'],
      ['SSF', 2022, 'actual'],
    ]);
    expect(structured.estimates.map((row) => row.isAggregate)).toEqual([false, true]);
    expect(structured.estimates[0]?.popInPoverty).toBeNull();
    expect(structured.appliedFilters.countries).toBe('NGA,SSF');
    expect(structured).toMatchObject({ totalCount: 2, totalPages: 1 });
    const versions = [...pipRequests(), ...groupRequests()].map((url) =>
      url.searchParams.get('version'),
    );
    expect(new Set(versions)).toEqual(new Set(['20260922_2021_01_02_PROD']));
  });

  it('moves aggregate rows to the requested PPP vintage', async () => {
    serve(
      () => undefined,
      (params) =>
        params.get('version') === '20260922_2017_01_02_PROD'
          ? [groupRow('SSF', 'Sub-Saharan Africa', 2022, { poverty_line: 2.15, headcount: 0.3807 })]
          : undefined,
    );
    const { structured } = await call({ countries: 'SSF', year: '2022', ppp_version: '2017' });
    expect(structured.estimates[0]).toMatchObject({ povertyLine: 2.15, headcount: 0.3807 });
    expect(structured.appliedFilters.pppVersion).toBe('2017');
  });

  /**
   * `queried` is the code sent to `/pip-grp`; `emitted` is the code the caller
   * sees in the row and the echo. They differ only for PIP's IDA-only group,
   * which a caller requests as IDX because IDA on input means IDA total.
   */
  it.each([
    ['LIC', 'incgroup', 'LIC', 'LIC'],
    ['LMIC', 'incgroup', 'LMIC', 'LMIC'],
    ['LMC', 'incgroup', 'LMIC', 'LMIC'],
    ['UMC', 'incgroup', 'UMIC', 'UMIC'],
    ['XN', 'incgroup', 'LMIC', 'LMIC'],
    ['IDX', 'ida', 'IDA', 'IDX'],
    ['XI', 'ida', 'IDA', 'IDX'],
    ['IDB', 'ida', 'BLND', 'BLND'],
    ['XH', 'ida', 'BLND', 'BLND'],
    ['BLND', 'ida', 'BLND', 'BLND'],
    ['IBD', 'ida', 'IBRD', 'IBRD'],
    ['XF', 'ida', 'IBRD', 'IBRD'],
    ['IBRD', 'ida', 'IBRD', 'IBRD'],
    ['REST', 'ida', 'REST', 'REST'],
    ['WLD', 'wb', 'WLD', 'WLD'],
    ['AFE', 'wb', 'AFE', 'AFE'],
  ])(
    'routes %s to /pip-grp with group_by=%s as %s, reported as %s',
    async (code, groupBy, queried, emitted) => {
      serve(
        () => undefined,
        (params) =>
          params.get('group_by') === groupBy && params.get('country') === queried
            ? [groupRow(queried, queried, 2022)]
            : undefined,
      );
      const { structured, text } = await call({ countries: code, year: '2022' });

      expect(summary(structured)).toEqual([[emitted, 2022, 'actual']]);
      expect(structured.appliedFilters.countries).toBe(emitted);
      expect(text).toContain(`(${emitted}) — 2022, aggregate`);
      expect(text).toContain(`countries=${emitted}`);
      expect(pipRequests()).toHaveLength(0);
    },
  );

  it.each([
    ['IDX'],
    ['XI'],
    ['LMC'],
    ['XN'],
    ['UMC'],
    ['IDB'],
    ['IBD'],
    ['BLND'],
    ['IBRD'],
    ['REST'],
    ['HIC'],
    ['LIC'],
    ['WLD'],
    ['SSF'],
    ['ZG'],
    ['AFW'],
  ])('reports %s under a code that, sent back, asks for the same group', async (code) => {
    /** One fixed row per PIP aggregate code these cases reach; any other request fails. */
    const aggregates = new Map(
      ['IDA', 'LMIC', 'UMIC', 'BLND', 'IBRD', 'REST', 'HIC', 'LIC', 'WLD', 'SSF', 'AFW'].map(
        (pipCode) => [pipCode, groupRow(pipCode, `Aggregate ${pipCode}`, 2022)],
      ),
    );
    serve(
      () => undefined,
      (params) => {
        const row = aggregates.get(params.get('country') ?? '');
        return row ? [row] : undefined;
      },
    );
    const first = await call({ countries: code, year: '2022' });
    const firstRequest = groupRequests()[0];
    const emitted = new Set([
      ...first.structured.estimates.map((row) => String(row.countryCode)),
      String(first.structured.appliedFilters.countries),
    ]);

    for (const echoed of emitted) {
      const before = groupRequests().length;
      const again = await call({ countries: echoed, year: '2022' });
      const request = groupRequests()[before];

      expect(request?.searchParams.get('group_by')).toBe(
        firstRequest?.searchParams.get('group_by'),
      );
      expect(request?.searchParams.get('country')).toBe(firstRequest?.searchParams.get('country'));
      expect(again.structured.estimates.map((row) => row.countryCode)).toEqual(
        first.structured.estimates.map((row) => row.countryCode),
      );
      expect(again.structured.appliedFilters.countries).toBe(echoed);
    }
  });

  it("names the IDA-only row 'IDA only', WDI's name for IDX, on both surfaces", async () => {
    // PIP publishes the group as region_code IDA, region_name IDA.
    serve(
      () => undefined,
      (params) =>
        params.get('group_by') === 'ida' && params.get('country') === 'IDA'
          ? [groupRow('IDA', 'IDA', 2022)]
          : undefined,
    );
    const { structured, text } = await call({ countries: 'IDX', year: '2022' });

    expect(structured.estimates[0]).toMatchObject({ countryCode: 'IDX', countryName: 'IDA only' });
    expect(text).toContain('## IDA only (IDX) — 2022, aggregate');
    expect(text).not.toMatch(/## IDA \(/);
  });

  it('names the IDA-only group as IDX when rejecting a filter beside it', async () => {
    serve(() => undefined);
    const { error } = await failure({ countries: 'IDX', year: '2022', welfare_type: 'income' });

    expect(error.data).toMatchObject({ reason: 'aggregate_filter_conflict', countryCodes: 'IDX' });
    expect(error.message).toContain('"IDX"');
    expect(error.message).not.toMatch(/\bIDA\b/);
  });

  it('names the IDA-only group as IDX when /pip-grp fails', async () => {
    serve(
      () => undefined,
      () => new Response('{"error":["Internal Server Error"]}', { status: 500 }),
    );
    const { error } = await failure({ countries: 'XI', year: '2022' });

    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 500,
      countryCodes: 'IDX',
    });
    expect(error.message).not.toMatch(/\bIDA\b/);
  });

  it('merges a region, an income group, and an economy from three requests', async () => {
    serve(
      (params) => (params.get('country') === 'KEN' ? [surveyRow('KEN', 2021)] : undefined),
      (params) => {
        if (params.get('group_by') === 'wb' && params.get('country') === 'SSF') {
          return [groupRow('SSF', 'Sub-Saharan Africa', 2021)];
        }
        if (params.get('group_by') === 'incgroup' && params.get('country') === 'LIC') {
          return [groupRow('LIC', 'Low income', 2021)];
        }
        return;
      },
    );
    const { structured } = await call({ countries: 'SSF,LIC,KEN', year: '2021' });

    expect(summary(structured)).toEqual([
      ['KEN', 2021, 'survey'],
      ['LIC', 2021, 'actual'],
      ['SSF', 2021, 'actual'],
    ]);
    expect(groupRequests()).toHaveLength(2);
    expect(structured.appliedFilters.countries).toBe('SSF,LIC,KEN');
  });

  it.each([['SSA'], ['EAP'], ['FCVY'], ['MIC'], ['LMY'], ['ZF']])(
    'rejects %s as an aggregate this tool does not serve, before any data request',
    async (code) => {
      serve(() => undefined);
      const { error, text } = await failure({ countries: ['KEN', code], year: '2022' });

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'unserved_aggregate', retryable: false });
      expect(error.message).toContain('SSF');
      expect(error.message).toContain('LIC');
      // The lending groups are listed under the spellings that reach them.
      expect(error.message).toContain('IDX');
      expect(error.message).not.toMatch(/\bIDA\b/);
      expect(text).toMatch(/Recovery:/);
      expect(pipRequests()).toHaveLength(0);
      expect(groupRequests()).toHaveLength(0);
    },
  );

  it.each([['IDA'], ['ida'], ['XG']])(
    "rejects WDI's IDA total (%s) before any request, naming IDX and IDB",
    async (code) => {
      serve(() => undefined);
      const { error, text } = await failure({ countries: ['KEN', code], year: '2022' });

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'ambiguous_aggregate', retryable: false });
      expect(error.message).toContain('IDX');
      expect(error.message).toContain('IDB');
      expect(text).toMatch(/Recovery:.*IDX/);
      expect(text).toMatch(/\(reason ambiguous_aggregate · not retryable\)/);
      expect(requested()).toHaveLength(0);
    },
  );

  // ─── Regions table outage ─────────────────────────────────────────────────

  it('still answers an economy when the regions table is down, and retries the table next time', async () => {
    serve(
      (params) =>
        params.get('country') === 'NGA' && params.get('fill_gaps') === 'false'
          ? [surveyRow('NGA', 2018)]
          : undefined,
      () => undefined,
      { regionsDown: true },
    );
    const { structured } = await call({ countries: 'NGA', year: '2018' });
    expect(summary(structured)).toEqual([['NGA', 2018, 'survey']]);

    const before = requestsTo('/pip/v1/aux').length;
    await call({ countries: 'NGA', year: '2018' });
    // The failure was not cached: the next request asks for the table again.
    expect(requestsTo('/pip/v1/aux').length).toBeGreaterThan(before);
  });

  it('sends an aggregate to /pip, as before the regions table existed, when the table is down', async () => {
    // `/pip` lists SSF as a valid country and answers it with a detail-free 500.
    serve(
      (params) =>
        params.get('country') === 'SSF'
          ? new Response('{"error":["Internal Server Error"]}', { status: 500 })
          : undefined,
      () => undefined,
      { regionsDown: true },
    );
    const { error } = await failure({ countries: 'SSF', year: '2022' });

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
    expect(groupRequests()).toHaveLength(0);
    expect(pipRequests()[0]?.searchParams.get('country')).toBe('SSF');
  });

  it.each([
    [{ welfare_type: 'income' }, 'welfare_type'],
    [{ reporting_level: 'urban' }, 'reporting_level'],
  ])('rejects %j alongside an aggregate before any data request', async (filter, name) => {
    serve(() => undefined);
    const { error } = await failure({ countries: ['NGA', 'SSF'], year: '2022', ...filter });

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'aggregate_filter_conflict', retryable: false });
    expect(error.message).toContain(name);
    expect(pipRequests()).toHaveLength(0);
    expect(groupRequests()).toHaveLength(0);
  });

  it('keeps a WDI aggregate PIP does not list as country_not_found, naming the aggregates it serves', async () => {
    serve(() => undefined);
    const { error } = await failure({ countries: 'ARB', year: '2022' });

    expect(error.data.reason).toBe('country_not_found');
    expect((error.data.recovery as { hint: string }).hint).toMatch(/SSF/);
    expect(requested().some((url) => url.searchParams.get('country') === 'all')).toBe(false);
  });

  it.each(['MRV', 'mrv'])(
    'resolves year %s for an aggregate locally to its newest reporting year',
    async (year) => {
      serve(
        () => undefined,
        (params) =>
          params.get('year') === null
            ? [
                groupRow('SSF', 'Sub-Saharan Africa', 2024),
                groupRow('SSF', 'Sub-Saharan Africa', 2026, { estimate_type: 'nowcast' }),
                groupRow('SSF', 'Sub-Saharan Africa', 2025, { estimate_type: 'nowcast' }),
                groupRow('WLD', 'World', 2026, { estimate_type: 'nowcast' }),
                groupRow('WLD', 'World', 2019, { estimate_type: 'projection' }),
              ]
            : [],
      );
      const { structured } = await call({ countries: ['SSF', 'WLD'], year });

      expect(summary(structured)).toEqual([
        ['SSF', 2026, 'nowcast'],
        ['WLD', 2026, 'nowcast'],
      ]);
      expect(groupRequests()[0]?.searchParams.has('year')).toBe(false);
    },
  );

  it('returns the full series for an aggregate when year is all or omitted', async () => {
    serve(
      () => undefined,
      () => [2024, 2025, 2026].map((y) => groupRow('WLD', 'World', y)),
    );
    const { structured } = await call({ countries: 'WLD' });
    expect(structured.estimates.map((row) => row.reportingYear)).toEqual([2024, 2025, 2026]);
  });

  it('reports an aggregate year PIP has no row for as an empty result', async () => {
    serve(
      () => undefined,
      () => [],
    );
    const { structured, text } = await call({ countries: 'SSF', year: '1970' });

    expect(structured.estimates).toEqual([]);
    expect(structured).toMatchObject({ totalCount: 0, totalPages: 1 });
    expect(structured.notice).toMatch(/No estimates for the requested filter/);
    expect(text).toContain('No estimates returned.');
  });

  it('names the two-character code sent when its resolved form is one PIP does not publish', async () => {
    serve(() => undefined);
    const { error } = await failure({ countries: ['KE', '1A'], year: '2022' });

    expect(error.data).toMatchObject({ reason: 'country_not_found', countryCodes: 'ARB' });
    expect(error.message).toContain('PIP does not recognize the country code(s) "ARB".');
    expect(error.message).toContain('"1A" as ARB');
  });

  // ─── Paging across merged sources ─────────────────────────────────────────

  it('caps a merged page at 70 estimates and counts pages at that size', async () => {
    const series = (code: string) =>
      Array.from({ length: 46 }, (_, index) => groupRow(code, code, 1981 + index));
    serve(
      () => undefined,
      () => [...series('SSF'), ...series('WLD')],
    );
    const { structured, text } = await call({ countries: ['SSF', 'WLD'], per_page: 1000 });

    expect(structured.estimates).toHaveLength(70);
    expect(structured).toMatchObject({ totalCount: 92, totalPages: 2, currentPage: 1 });
    expect(structured.appliedFilters).toMatchObject({ perPage: 70, requestedPerPage: 1000 });
    expect(structured.estimates.at(-1)).toMatchObject({ countryCode: 'WLD', reportingYear: 2004 });
    expect(text).toContain('per_page=1000 was reduced to 70');
  });

  it('pages one merged list, the last page short', async () => {
    serve(
      (params) =>
        params.get('fill_gaps') === 'false'
          ? [surveyRow('KEN', 2021), surveyRow('NGA', 2021)]
          : undefined,
      () => [groupRow('SSF', 'Sub-Saharan Africa', 2021)],
    );
    const { structured, text } = await call({
      countries: ['KEN', 'NGA', 'SSF'],
      year: '2021',
      page: 2,
      per_page: 2,
    });

    expect(summary(structured)).toEqual([['SSF', 2021, 'actual']]);
    expect(structured).toMatchObject({ totalCount: 3, totalPages: 2, currentPage: 2 });
    expect(text).toContain('Sub-Saharan Africa (SSF)');
  });

  it('reports a page past the end of a merged list', async () => {
    serve(
      (params) => (params.get('fill_gaps') === 'false' ? [surveyRow('KEN', 2021)] : undefined),
      () => [groupRow('SSF', 'Sub-Saharan Africa', 2021)],
    );
    const { structured, text } = await call({
      countries: ['KEN', 'SSF'],
      year: '2021',
      page: 3,
      per_page: 1,
    });

    expect(structured.estimates).toEqual([]);
    expect(structured).toMatchObject({ totalCount: 2, totalPages: 2, currentPage: 3 });
    expect(structured.notice).toMatch(/Page 3 is past the end of the results — 2 estimates span/);
    expect(text).toContain('Page 3 is past the end');
  });

  // ─── #57: model-estimate-only economies ───────────────────────────────────

  it('answers a model-estimate-only economy from the all-economy response, narrowed to it', async () => {
    serve((params) =>
      params.get('country') === 'all' &&
      params.get('fill_gaps') === 'true' &&
      params.get('year') === '2020'
        ? [
            estimateRow('AFG', 2020, { estimation_type: 'CMD estimation', is_interpolated: false }),
            estimateRow('KEN', 2020),
            estimateRow('NGA', 2020),
          ]
        : undefined,
    );
    const { structured, text } = await call({ countries: 'AFG', year: '2020' });

    expect(summary(structured)).toEqual([['AFG', 2020, 'CMD estimation']]);
    expect(structured.appliedFilters.countries).toBe('AFG');
    expect(text).toContain('**estimationType:** CMD estimation');
  });

  it('names the model-estimate-only economy, not "all", when the all-economy response fails', async () => {
    // PIP answers some whole-history shapes, at some poverty lines, with a settled 500.
    serve((params) =>
      params.get('country') === 'all'
        ? new Response('{"error":["Internal Server Error"]}', { status: 500 })
        : undefined,
    );
    const { error, text } = await failure({ countries: 'AFG', year: 'all', poverty_line: 4.2 });

    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 500,
      countryCodes: 'AFG',
    });
    expect(error.message).toContain('"AFG"');
    expect(text).not.toMatch(/"all"/i);
  });

  it('answers a model-estimate-only economy and a surveyed one together', async () => {
    serve((params) => {
      const country = params.get('country');
      if (country === 'KEN' && params.get('fill_gaps') === 'false') return [surveyRow('KEN', 2020)];
      if (country === 'all' && params.get('fill_gaps') === 'true') {
        return [
          estimateRow('AFG', 2020, { estimation_type: 'CMD estimation', is_interpolated: false }),
          estimateRow('KEN', 2020),
        ];
      }
      return;
    });
    const { structured } = await call({ countries: ['AFG', 'KEN'], year: '2020' });

    expect(summary(structured)).toEqual([
      ['AFG', 2020, 'CMD estimation'],
      ['KEN', 2020, 'survey'],
    ]);
  });

  it('returns nothing for a model-estimate-only economy under fill_gaps false, and says why', async () => {
    serve(() => undefined);
    const { structured } = await call({ countries: 'AFG', year: '2020', fill_gaps: false });

    expect(structured.estimates).toEqual([]);
    expect(structured.notice).toMatch(/AFG/);
    expect(structured.notice).toMatch(/only as a gap-filled/);
    expect(requested().some((url) => url.searchParams.get('country') === 'all')).toBe(false);
  });

  it('serves the resolved form of a two-character code that is model-estimate-only', async () => {
    serve((params) =>
      params.get('country') === 'all'
        ? [estimateRow('GUM', 2020, { estimation_type: 'CMD estimation', is_interpolated: false })]
        : undefined,
    );
    const { structured } = await call({ countries: 'GU', year: '2020' });
    expect(summary(structured)).toEqual([['GUM', 2020, 'CMD estimation']]);
  });

  it('keeps country_not_found for a code PIP serves under neither form, without the all-economy request', async () => {
    serve(() => undefined);
    const { error, text } = await failure({ countries: ['KEN', 'ZZZ'], year: 'all' });

    expect(error.data).toMatchObject({ reason: 'country_not_found', countryCodes: 'ZZZ' });
    expect(error.message).toContain('"ZZZ"');
    expect(error.message).not.toContain('KEN');
    expect(requested().some((url) => url.searchParams.get('country') === 'all')).toBe(false);
    expect(text).toMatch(/\(reason country_not_found · not retryable\)/);
  });

  // ─── #40: MRV follows fill_gaps ───────────────────────────────────────────

  it('resolves MRV to the latest estimate year when fill_gaps is on, and says where the survey year is', async () => {
    serve((params) => {
      if (params.get('fill_gaps') === 'false') {
        return [surveyRow('IND', 2023), surveyRow('SSD', 2016, { headcount: 0.765 })];
      }
      return [estimateRow('IND', 2026, { headcount: 0.014 }), estimateRow('SSD', 2026)];
    });
    const { structured, text } = await call({ countries: ['SSD', 'IND'], year: 'MRV' });

    expect(summary(structured)).toEqual([
      ['IND', 2026, 'extrapolation'],
      ['SSD', 2026, 'extrapolation'],
    ]);
    expect(pipRequests()).toHaveLength(2);
    expect(structured.notice).toMatch(/fill_gaps.*false/);
    expect(structured.notice).toMatch(/latest survey year/);
    expect(text).toMatch(/latest survey year/);
  });

  it('falls back to the survey row when the estimate pass has nothing at that grain', async () => {
    serve((params) =>
      params.get('fill_gaps') === 'false'
        ? [surveyRow('PHL', 2023, { welfare_type: 'income' })]
        : [],
    );
    const { structured } = await call({ countries: 'PHL', year: 'MRV', welfare_type: 'income' });
    expect(summary(structured)).toEqual([['PHL', 2023, 'survey']]);
  });

  it('keeps every reporting level of an economy at its one resolved year', async () => {
    serve((params) =>
      params.get('fill_gaps') === 'false'
        ? ['national', 'rural', 'urban'].map((level) =>
            surveyRow('CHN', 2022, { reporting_level: level }),
          )
        : ['national', 'rural', 'urban'].map((level) =>
            estimateRow('CHN', 2026, { reporting_level: level }),
          ),
    );
    const { structured } = await call({ countries: 'CHN', year: 'MRV' });

    expect(structured.estimates.map((row) => [row.reportingYear, row.reportingLevel])).toEqual([
      [2026, 'national'],
      [2026, 'rural'],
      [2026, 'urban'],
    ]);
  });

  it('prefers the survey row over its gap-filled twin at the resolved year and grain', async () => {
    serve((params) =>
      params.get('fill_gaps') === 'false'
        ? [surveyRow('USA', 2026)]
        : [estimateRow('USA', 2026, { welfare_type: 'consumption' })],
    );
    const { structured } = await call({ countries: 'USA', year: 'mrv' });

    expect(summary(structured)).toEqual([['USA', 2026, 'survey']]);
    expect(structured.estimates[0]?.gini).toBe(0.351);
  });

  it('gives every economy one reporting year under countries "all"', async () => {
    serve((params) =>
      params.get('fill_gaps') === 'false'
        ? [surveyRow('IND', 2023), surveyRow('NGA', 2018)]
        : [estimateRow('IND', 2026), estimateRow('NGA', 2026), estimateRow('AFG', 2026)],
    );
    const { structured } = await call({ countries: 'all', year: 'MRV' });

    const years = new Map<unknown, Set<unknown>>();
    for (const row of structured.estimates) {
      years.set(row.countryCode, (years.get(row.countryCode) ?? new Set()).add(row.reportingYear));
    }
    expect([...years.values()].every((set) => set.size === 1)).toBe(true);
    expect(summary(structured)).toEqual([
      ['AFG', 2026, 'extrapolation'],
      ['IND', 2026, 'extrapolation'],
      ['NGA', 2026, 'extrapolation'],
    ]);
    expect(structured.appliedFilters.countries).toBe('all');
  });
});
