/**
 * @fileoverview Tests for WorldBankApiService.getData's source-scoped path: an
 * indicator the standard data endpoint rejects with message id 175 is served from
 * its catalog source's `/v2/sources/{id}/...` data API. Upstream is faked per URL
 * path, since the path encodes every validated segment the service sends.
 * @module tests/services/worldbank/source-scoped-data.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

// ─── Upstream fixtures ────────────────────────────────────────────────────────

const NOT_SERVED = [
  {
    message: [
      {
        id: '175',
        key: 'Invalid format',
        value: 'The indicator was not found. It may have been deleted or archived.',
      },
    ],
  },
];

/** The body the source-scoped API answers a bad path segment with, naming none. */
const DATA_NOT_FOUND_XML =
  '<?xml version="1.0" encoding="utf-8"?><wb:error xmlns:wb="http://www.worldbank.org"><wb:message id="160" key="Data not found.">The provided parameter value is not valid or data not found.</wb:message></wb:error>';

function catalog(...rows: Array<[id: string, name: string, sourceId: string, sourceName: string]>) {
  return [
    { page: 1, pages: 1, per_page: 50, total: rows.length },
    rows.map(([id, name, sourceId, sourceName]) => ({
      id,
      name,
      source: { id: sourceId, value: sourceName },
      sourceNote: '',
      topics: [],
    })),
  ];
}

function concepts(sourceId: string, name: string, ids: string[]) {
  return {
    page: 1,
    pages: 1,
    per_page: 50,
    total: ids.length,
    source: [{ id: sourceId, name, concept: ids.map((id) => ({ id, value: id })) }],
  };
}

function listing(sourceId: string, concept: string, variables: Array<[id: string, label: string]>) {
  return {
    page: 1,
    pages: 1,
    per_page: 10_000,
    total: variables.length,
    source: [
      {
        id: sourceId,
        name: 'x',
        concept: [
          { id: concept, name: concept, variable: variables.map(([id, value]) => ({ id, value })) },
        ],
      },
    ],
  };
}

type Obs = {
  country: [string, string];
  time: string;
  dim?: [concept: string, id: string, label: string];
  value: number | null;
};

function data(
  sourceId: string,
  observations: Obs[],
  paging: { page?: number; pages?: number } = {},
) {
  return {
    page: paging.page ?? 1,
    pages: paging.pages ?? 1,
    per_page: 10_000,
    total: observations.length,
    source: {
      id: sourceId,
      name: 'x',
      data: observations.map((o) => ({
        variable: [
          ...(o.dim ? [{ concept: o.dim[0], id: o.dim[1], value: o.dim[2] }] : []),
          { concept: 'Time', id: o.time, value: o.time.slice(2) },
          { concept: 'Series', id: 'S', value: 'Series' },
          { concept: 'Country', id: o.country[0], value: o.country[1] },
        ],
        value: o.value,
      })),
    },
  };
}

/** The `/country` listing behind ISO2 mapping and aggregate classification. */
const COUNTRY_INDEX = [
  { page: 1, pages: 1, per_page: 10_000, total: 5 },
  [
    ['SDN', 'SD', false],
    ['USA', 'US', false],
    ['AGO', 'AO', false],
    ['CHL', 'CL', false],
    ['WLD', '1W', true],
  ].map(([id, iso2Code, aggregate]) => ({
    id,
    iso2Code,
    name: id,
    region: aggregate ? { id: 'NA' } : { id: 'SSF' },
    incomeLevel: aggregate ? { id: 'NA' } : { id: 'LIC' },
  })),
];

const VERSIONS = listing('57', 'version', [
  ['202407', '2024 Jul'],
  ['202503', '2025 Mar'],
  ['202601', '2026 Jan'],
]);

const REFUGEES = catalog([
  'SM.POP.REFG.OR',
  'Refugee population by country or territory of origin',
  '57',
  'WDI Database Archives',
]);

// ─── Harness ──────────────────────────────────────────────────────────────────

describe('WorldBankApiService.getData — source-scoped path', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: InstanceType<
    typeof import('@/services/worldbank/worldbank-service.js')['WorldBankApiService']
  >;
  let routes: Map<string, unknown>;

  /** Answer every request by URL path; an unrouted path fails the test loudly. */
  function route(entries: Record<string, unknown>) {
    routes = new Map(Object.entries(entries));
    fetchMock.mockImplementation(async (url: string) => {
      const { pathname, searchParams } = new URL(url);
      const key = routes.has(`${pathname}?page=${searchParams.get('page')}`)
        ? `${pathname}?page=${searchParams.get('page')}`
        : pathname;
      if (!routes.has(key)) throw new Error(`Unrouted upstream request: ${url}`);
      const body = routes.get(key);
      return { text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    });
  }

  /** Paths requested, in order, without the query string. */
  function requestedPaths(): string[] {
    return fetchMock.mock.calls.map((call) => new URL(call[0] as string).pathname);
  }

  /** The standard rejection, catalog lookup, and WDI Database Archives discovery. */
  function archiveRoutes(extra: Record<string, unknown>) {
    return {
      '/v2/country/SDN/indicator/SM.POP.REFG.OR': NOT_SERVED,
      '/v2/indicator/SM.POP.REFG.OR': REFUGEES,
      '/v2/sources/57/concepts': concepts('57', 'WDI Database Archives', [
        'Country',
        'Series',
        'Time',
        'Version',
      ]),
      '/v2/sources/57/version': VERSIONS,
      '/v2/sources/57/country': listing('57', 'country', [
        ['SDN', 'Sudan'],
        ['USA', 'United States'],
        ['ADO', 'Andorra (legacy)'],
      ]),
      '/v2/sources/57/time': listing('57', 'time', [
        ['YR2014', '2014'],
        ['YR2015', '2015'],
        ['YR2016', '2016'],
      ]),
      '/v2/country': COUNTRY_INDEX,
      ...extra,
    };
  }

  const sdn = (time: string, version: string, value: number | null): Obs => ({
    country: ['SDN', 'Sudan'],
    time,
    dim: ['Version', version, `${version} label`],
    value,
  });

  beforeEach(async () => {
    const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
    fetchMock = vi.mocked(fetchWithTimeout);
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      apiBaseUrl: 'https://api.worldbank.org/v2',
      defaultPerPage: 50,
      catalogCacheTtlMs: 60_000,
    } as never);
    const { WorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    service = new WorldBankApiService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Routing and the default release ──────────────────────────────────────

  it('serves an id-175 indicator from its catalog source at the newest release holding data', async () => {
    route(
      archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR': data('57', [
          sdn('YR2015', '202407', 600),
          sdn('YR2015', '202503', 627080),
          sdn('YR2016', '202503', null),
          sdn('YR2015', '202601', null),
          sdn('YR2016', '202601', null),
        ]),
      }),
    );
    const result = await service.getData(
      { indicatorId: 'SM.POP.REFG.OR', countries: ['SDN'], page: 1, perPage: 50 },
      createMockContext(),
    );

    expect(result.sourceScoped).toEqual({
      sourceId: '57',
      sourceName: 'WDI Database Archives',
      dimension: {
        concept: 'Version',
        selection: 'newest_with_data',
        id: '202503',
        label: '2025 Mar',
      },
      note: expect.stringMatching(
        /^Not from the standard World Bank data endpoint, which does not serve "SM\.POP\.REFG\.OR": .*source-scoped data API.*archived or superseded/,
      ),
    });
    expect(result.indicator).toEqual({
      id: 'SM.POP.REFG.OR',
      name: 'Refugee population by country or territory of origin',
    });
    expect(result.data).toEqual([
      {
        countryCode: 'SD',
        countryIso3: 'SDN',
        countryName: 'Sudan',
        date: '2016',
        value: null,
        obsStatus: '',
        isAggregate: false,
        dimension: { id: '202503', label: '202503 label' },
      },
      expect.objectContaining({
        date: '2015',
        value: 627080,
        dimension: { id: '202503', label: '202503 label' },
      }),
    ]);
    expect(result).toMatchObject({
      total: 2,
      page: 1,
      pages: 1,
      nullCount: 1,
      dateFilterDropped: false,
    });
    // The release is resolved from one unpinned read — no version segment, no second data request.
    expect(requestedPaths().filter((p) => p.includes('/series/'))).toEqual([
      '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR',
    ]);
  });

  it('falls back to the newest release when no release holds a value in scope', async () => {
    route(
      archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR': data('57', [
          sdn('YR2015', '202407', null),
          sdn('YR2015', '202601', null),
        ]),
      }),
    );
    const result = await service.getData(
      { indicatorId: 'SM.POP.REFG.OR', countries: ['SDN'], page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.sourceScoped?.dimension).toEqual({
      concept: 'Version',
      selection: 'newest',
      id: '202601',
      label: '2026 Jan',
    });
    expect(result.data.map((d) => d.dimension?.id)).toEqual(['202601']);
  });

  it('pins a requested release case-insensitively, maps ISO2 codes, and joins the list with an encoded semicolon', async () => {
    route(
      archiveRoutes({
        '/v2/country/sd%3BUS%3BSDN/indicator/SM.POP.REFG.OR': NOT_SERVED,
        '/v2/sources/57/country/SDN%3BUSA/series/SM.POP.REFG.OR/version/202407': data('57', [
          sdn('YR2015', '202407', 600),
          {
            country: ['USA', 'United States'],
            time: 'YR2015',
            dim: ['Version', '202407', '2024 Jul'],
            value: 7,
          },
        ]),
      }),
    );
    const result = await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['sd', 'US', 'SDN'],
        dimensionValue: '202407',
        page: 1,
        perPage: 50,
      },
      createMockContext(),
    );
    expect(result.sourceScoped?.dimension).toMatchObject({
      selection: 'requested',
      id: '202407',
      label: '2024 Jul',
    });
    expect(result.data.map((d) => d.countryName)).toEqual(['Sudan', 'United States']);
    expect(requestedPaths().some((p) => p.includes(','))).toBe(false);
  });

  it('accepts a code only the source lists, such as a legacy country code', async () => {
    route(
      archiveRoutes({
        '/v2/country/ADO/indicator/SM.POP.REFG.OR': NOT_SERVED,
        '/v2/sources/57/country/ADO/series/SM.POP.REFG.OR/version/202503': data('57', [
          {
            country: ['ADO', 'Andorra'],
            time: 'YR2015',
            dim: ['Version', '202503', '2025 Mar'],
            value: 1,
          },
        ]),
      }),
    );
    const result = await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['ADO'],
        dimensionValue: '202503',
        page: 1,
        perPage: 50,
      },
      createMockContext(),
    );
    expect(result.data[0]).toMatchObject({ countryCode: 'ADO', countryIso3: 'ADO', value: 1 });
  });

  // ─── dimension_value errors ───────────────────────────────────────────────

  it('rejects a release the source does not list as unknown_dimension_value, naming every valid id, before any data request', async () => {
    route(archiveRoutes({}));
    const err = (await service
      .getData(
        {
          indicatorId: 'SM.POP.REFG.OR',
          countries: ['SDN'],
          dimensionValue: '199912',
          page: 1,
          perPage: 50,
        },
        createMockContext(),
      )
      .catch((e: unknown) => e)) as McpError;

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'unknown_dimension_value',
        dimensionValue: '199912',
        validValues: [{ sourceId: '57', concept: 'Version', ids: ['202407', '202503', '202601'] }],
      },
    });
    expect(err.message).toContain(
      'WDI Database Archives (source 57) Version: 202407, 202503, 202601',
    );
    expect(requestedPaths().some((p) => p.includes('/series/'))).toBe(false);
  });

  it('rejects dimension_value for a source with no extra dimension as dimension_not_applicable', async () => {
    route({
      '/v2/country/SDN/indicator/X.ONE': NOT_SERVED,
      '/v2/indicator/X.ONE': catalog(['X.ONE', 'One', '99', 'Plain Source']),
      '/v2/sources/99/concepts': concepts('99', 'Plain Source', ['Country', 'Series', 'Time']),
    });
    await expect(
      service.getData(
        {
          indicatorId: 'X.ONE',
          countries: ['SDN'],
          dimensionValue: 'anything',
          page: 1,
          perPage: 50,
        },
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      data: { reason: 'dimension_not_applicable', dimensionValue: 'anything' },
    });
  });

  it('rejects dimension_value when the standard endpoint serves the indicator, without extra requests', async () => {
    route({
      '/v2/country/US/indicator/NY.GDP.PCAP.CD': [
        { page: 1, pages: 1, per_page: 50, total: 1 },
        [
          {
            indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP' },
            country: { id: 'US', value: 'United States' },
            countryiso3code: 'USA',
            date: '2024',
            value: 1,
          },
        ],
      ],
    });
    await expect(
      service.getData(
        {
          indicatorId: 'NY.GDP.PCAP.CD',
          countries: ['US'],
          dimensionValue: '202503',
          page: 1,
          perPage: 50,
        },
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'dimension_not_applicable' },
    });
    expect(requestedPaths()).toEqual(['/v2/country/US/indicator/NY.GDP.PCAP.CD']);
  });

  // ─── Sources with other dimensions ────────────────────────────────────────

  it('pins the only classification a source lists and translates monthly assessment tokens', async () => {
    route({
      '/v2/country/ALB/indicator/PI-01': NOT_SERVED,
      '/v2/indicator/PI-01': catalog([
        'PI-01',
        'PI-1 Aggregate expenditure out-turn',
        '68',
        'PEFA 2016',
      ]),
      '/v2/sources/68/concepts': concepts('68', 'PEFA 2016', [
        'Country',
        'Classification',
        'Series',
        'Time',
      ]),
      '/v2/sources/68/classification': listing('68', 'classification', [['PUB', 'Public']]),
      '/v2/sources/68/country': listing('68', 'country', [['ALB', 'Albania']]),
      '/v2/sources/68/time': listing('68', 'time', [
        ['YR201712', 'Dec.17'],
        ['YR201806', 'Jun.18'],
        ['YR202505', 'May.25'],
      ]),
      '/v2/country': COUNTRY_INDEX,
      '/v2/sources/68/country/ALB/series/PI-01/time/YR201712%3BYR201806/classification/PUB': data(
        '68',
        [
          {
            country: ['ALB', 'Albania'],
            time: 'YR201712',
            dim: ['Classification', 'PUB', 'Public'],
            value: 4,
          },
          {
            country: ['ALB', 'Albania'],
            time: 'YR201806',
            dim: ['Classification', 'PUB', 'Public'],
            value: null,
          },
        ],
      ),
    });
    const result = await service.getData(
      { indicatorId: 'PI-01', countries: ['ALB'], dateRange: '2017:2018', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.sourceScoped?.dimension).toEqual({
      concept: 'Classification',
      selection: 'only_value',
      id: 'PUB',
      label: 'Public',
    });
    expect(result.data.map((d) => d.date)).toEqual(['2018M06', '2017M12']);
    // ALB is absent from the fixture country index, so its code stands in for the ISO2.
    expect(result.data[0]?.countryCode).toBe('ALB');
  });

  it('pins the World counterpart area and emulates mrv over the full series', async () => {
    const ago = (time: string, value: number | null): Obs => ({
      country: ['AGO', 'Angola'],
      time,
      dim: ['Counterpart-Area', 'WLD', 'World'],
      value,
    });
    route({
      '/v2/country/AO/indicator/DT.AMT.BLAT.CB.CD': NOT_SERVED,
      '/v2/indicator/DT.AMT.BLAT.CB.CD': catalog([
        'DT.AMT.BLAT.CB.CD',
        'CB, bilateral',
        '81',
        ' International Debt Statistics: DSSI',
      ]),
      '/v2/sources/81/concepts': concepts('81', ' International Debt Statistics: DSSI', [
        'Country',
        'Counterpart-Area',
        'Series',
        'Time',
      ]),
      '/v2/sources/81/counterpart-area': listing('81', 'counterpart-area', [
        ['265', 'Zimbabwe'],
        ['WLD', 'World'],
      ]),
      '/v2/sources/81/country': listing('81', 'country', [['AGO', 'Angola']]),
      '/v2/sources/81/time': listing('81', 'time', [
        ['YR2018', '2018'],
        ['YR2019', '2019'],
        ['YR2020', '2020'],
        ['YR2027-M11', '2027 M11'],
      ]),
      '/v2/country': COUNTRY_INDEX,
      '/v2/sources/81/country/AGO/series/DT.AMT.BLAT.CB.CD/counterpart-area/WLD': data('81', [
        ago('YR2018', 4),
        ago('YR2019', 10),
        ago('YR2020', null),
        ago('YR2027-M11', null),
      ]),
    });
    const result = await service.getData(
      { indicatorId: 'DT.AMT.BLAT.CB.CD', countries: ['AO'], mrv: 1, page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.sourceScoped).toMatchObject({
      sourceName: 'International Debt Statistics: DSSI',
      dimension: {
        concept: 'Counterpart-Area',
        selection: 'world_total',
        id: 'WLD',
        label: 'World',
      },
    });
    expect(result.data).toEqual([expect.objectContaining({ date: '2019', value: 10 })]);
    expect(result.total).toBe(1);
  });

  it('returns every multi-valued classification unpinned, each row labelled, in listing order', async () => {
    const usa = (id: string, value: number): Obs => ({
      country: ['USA', 'United States'],
      time: 'YR2017',
      dim: ['Classification', id, `${id} label`],
      value,
    });
    route({
      '/v2/country/US/indicator/1000000': NOT_SERVED,
      '/v2/indicator/1000000': catalog(['1000000', 'GDP', '78', 'ICP 2017']),
      '/v2/sources/78/concepts': concepts('78', 'ICP 2017', [
        'Classification',
        'Country',
        'Series',
        'Time',
      ]),
      '/v2/sources/78/classification': listing('78', 'classification', [
        ['CD', 'Expenditure'],
        ['PPPGlob', 'PPP'],
      ]),
      '/v2/sources/78/country': listing('78', 'country', [['USA', 'United States']]),
      '/v2/sources/78/time': listing('78', 'time', [['YR2017', '2017']]),
      '/v2/country': COUNTRY_INDEX,
      '/v2/sources/78/country/USA/series/1000000': data('78', [
        usa('PPPGlob', 1),
        usa('CD', 19519),
      ]),
    });
    const result = await service.getData(
      { indicatorId: '1000000', countries: ['US'], dateRange: '2017', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.sourceScoped?.dimension).toEqual({
      concept: 'Classification',
      selection: 'every_value',
      id: null,
      label: null,
    });
    expect(result.data.map((d) => d.dimension)).toEqual([
      { id: 'CD', label: 'CD label' },
      { id: 'PPPGlob', label: 'PPPGlob label' },
    ]);
  });

  // ─── An ID under a live and an archived source ────────────────────────────

  describe('an ID catalogued under both Food Prices for Nutrition and FPN Datahub Archive', () => {
    const fpnRoutes = (extra: Record<string, unknown>) => ({
      '/v2/country/USA/indicator/CoCA_fexp': NOT_SERVED,
      '/v2/indicator/CoCA_fexp': catalog(
        ['CoCA_fexp', 'Affordability', '93', 'FPN Datahub Archive'],
        ['CoCA_fexp', 'Affordability', '88', 'Food Prices for Nutrition'],
      ),
      '/v2/sources/88/concepts': concepts('88', 'Food Prices for Nutrition', [
        'Country',
        'Classification',
        'Series',
        'Time',
      ]),
      '/v2/sources/88/classification': listing('88', 'classification', [
        ['FPN 5.0', 'Food Prices for Nutrition 5.0'],
      ]),
      '/v2/sources/88/country': listing('88', 'country', [['USA', 'United States']]),
      '/v2/sources/88/time': listing('88', 'time', [['YR2021', '2021']]),
      '/v2/sources/93/concepts': concepts('93', 'FPN Datahub Archive', [
        'Country',
        'Classification',
        'Series',
        'Time',
      ]),
      '/v2/sources/93/classification': listing('93', 'classification', [
        ['FPN 1.0', 'Food Prices for Nutrition 1.0'],
        ['FPN 4.1', 'Food Prices for Nutrition 4.1'],
      ]),
      '/v2/sources/93/country': listing('93', 'country', [['USA', 'United States']]),
      '/v2/sources/93/time': listing('93', 'time', [['YR2021', '2021']]),
      '/v2/country': COUNTRY_INDEX,
      ...extra,
    });
    const fpn = (id: string, value: number): Obs => ({
      country: ['USA', 'United States'],
      time: 'YR2021',
      dim: ['Classification', id, id],
      value,
    });

    it('routes to the live source by default, without discovering the archive', async () => {
      route(
        fpnRoutes({
          '/v2/sources/88/country/USA/series/CoCA_fexp/classification/FPN%205.0': data('88', [
            fpn('FPN 5.0', 0.06),
          ]),
        }),
      );
      const result = await service.getData(
        { indicatorId: 'CoCA_fexp', countries: ['USA'], page: 1, perPage: 50 },
        createMockContext(),
      );
      expect(result.sourceScoped).toMatchObject({
        sourceId: '88',
        sourceName: 'Food Prices for Nutrition',
      });
      expect(requestedPaths().some((p) => p.startsWith('/v2/sources/93/'))).toBe(false);
    });

    it('routes a value only the archive lists to the archive', async () => {
      route(
        fpnRoutes({
          '/v2/sources/93/country/USA/series/CoCA_fexp/classification/FPN%204.1': data('93', [
            fpn('FPN 4.1', 0.07),
          ]),
        }),
      );
      const result = await service.getData(
        {
          indicatorId: 'CoCA_fexp',
          countries: ['USA'],
          dimensionValue: 'fpn 4.1',
          page: 1,
          perPage: 50,
        },
        createMockContext(),
      );
      expect(result.sourceScoped).toMatchObject({
        sourceId: '93',
        sourceName: 'FPN Datahub Archive',
        dimension: { selection: 'requested', id: 'FPN 4.1' },
      });
      expect(result.data[0]?.value).toBe(0.07);
    });

    it('lists both sources’ values when neither carries the requested one', async () => {
      route(fpnRoutes({}));
      const err = (await service
        .getData(
          {
            indicatorId: 'CoCA_fexp',
            countries: ['USA'],
            dimensionValue: 'FPN 9.9',
            page: 1,
            perPage: 50,
          },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(err.data?.reason).toBe('unknown_dimension_value');
      expect(err.message).toContain(
        'Food Prices for Nutrition (source 88) Classification: FPN 5.0',
      );
      expect(err.message).toContain(
        'FPN Datahub Archive (source 93) Classification: FPN 1.0, FPN 4.1',
      );
    });
  });

  // ─── Countries ────────────────────────────────────────────────────────────

  /**
   * The standard endpoint validates country codes before servability, so a code
   * reaching this path has passed it; the source-scoped listings are checked
   * anyway, since upstream silently drops an unknown member of a `;` list.
   */
  it('reports a code no listing knows as country_not_found, before any data request', async () => {
    route({ ...archiveRoutes({}), '/v2/country/SDN%3BZZZ/indicator/SM.POP.REFG.OR': NOT_SERVED });
    await expect(
      service.getData(
        { indicatorId: 'SM.POP.REFG.OR', countries: ['SDN', 'ZZZ'], page: 1, perPage: 50 },
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'country_not_found', countryCodes: 'ZZZ' },
    });
    expect(requestedPaths().some((p) => p.includes('/series/'))).toBe(false);
  });

  it('leaves out a valid code the source does not cover and reports it', async () => {
    route({
      ...archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503': data('57', [
          sdn('YR2015', '202503', 1),
        ]),
      }),
      '/v2/country/SDN%3BCHL/indicator/SM.POP.REFG.OR': NOT_SERVED,
    });
    const result = await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['SDN', 'CHL'],
        dimensionValue: '202503',
        page: 1,
        perPage: 50,
      },
      createMockContext(),
    );
    expect(result.uncoveredCountries).toEqual(['CHL']);
    expect(result.total).toBe(1);
  });

  it('makes no data request when the source covers none of the codes', async () => {
    route({ ...archiveRoutes({}), '/v2/country/CHL/indicator/SM.POP.REFG.OR': NOT_SERVED });
    const result = await service.getData(
      { indicatorId: 'SM.POP.REFG.OR', countries: ['CHL'], page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 0, uncoveredCountries: ['CHL'] });
    expect(result.sourceScoped?.dimension).toMatchObject({ selection: 'newest', id: '202601' });
    expect(requestedPaths().some((p) => p.includes('/series/'))).toBe(false);
  });

  it('sends "all" as the country segment', async () => {
    route({
      ...archiveRoutes({
        '/v2/sources/57/country/all/series/SM.POP.REFG.OR/time/YR2015/version/202503': data('57', [
          sdn('YR2015', '202503', 1),
        ]),
      }),
      '/v2/country/all/indicator/SM.POP.REFG.OR': NOT_SERVED,
    });
    const result = await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['all'],
        dateRange: '2015',
        dimensionValue: '202503',
        page: 1,
        perPage: 50,
      },
      createMockContext(),
    );
    expect(result.total).toBe(1);
  });

  // ─── Periods, pagination, empty results ───────────────────────────────────

  it('sends no time segment for a window covering every period, and no request for one covering none', async () => {
    route(
      archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503': data('57', [
          sdn('YR2015', '202503', 1),
        ]),
      }),
    );
    const ctx = createMockContext();
    await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['SDN'],
        dateRange: '2010:2020',
        dimensionValue: '202503',
        page: 1,
        perPage: 50,
      },
      ctx,
    );
    const before = fetchMock.mock.calls.length;
    const none = await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['SDN'],
        dateRange: '1850:1900',
        dimensionValue: '202503',
        page: 1,
        perPage: 50,
      },
      ctx,
    );
    expect(none).toMatchObject({ data: [], total: 0, pages: 1, dateFilterDropped: false });
    // Second call: the standard rejection and the catalog lookup only — discovery is cached.
    expect(requestedPaths().slice(before)).toEqual([
      '/v2/country/SDN/indicator/SM.POP.REFG.OR',
      '/v2/indicator/SM.POP.REFG.OR',
    ]);
  });

  it('keeps total and pages invariant across pages, and reports a page past the end with the same totals', async () => {
    const rows = ['YR2014', 'YR2015', 'YR2016'].map((t) => sdn(t, '202503', 1));
    route(
      archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503': data('57', rows),
      }),
    );
    const ctx = createMockContext();
    const call = (page: number) =>
      service.getData(
        {
          indicatorId: 'SM.POP.REFG.OR',
          countries: ['SDN'],
          dimensionValue: '202503',
          page,
          perPage: 2,
        },
        ctx,
      );
    const [first, second, past] = [await call(1), await call(2), await call(9)];
    expect(first).toMatchObject({ total: 3, pages: 2, page: 1 });
    expect(first.data.map((d) => d.date)).toEqual(['2016', '2015']);
    expect(second).toMatchObject({ total: 3, pages: 2, page: 2 });
    expect(second.data.map((d) => d.date)).toEqual(['2014']);
    expect(past).toMatchObject({ total: 3, pages: 2, page: 9, data: [] });
  });

  it('pages a scope larger than the served size at 200 rows, contiguously', async () => {
    const years = Array.from({ length: 450 }, (_, i) => 2025 - i);
    route(
      archiveRoutes({
        '/v2/sources/57/time': listing(
          '57',
          'time',
          years.map((year): [string, string] => [`YR${year}`, String(year)]),
        ),
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503': data(
          '57',
          years.map((year) => sdn(`YR${year}`, '202503', year)),
        ),
      }),
    );
    const ctx = createMockContext();
    const call = (page: number) =>
      service.getData(
        {
          indicatorId: 'SM.POP.REFG.OR',
          countries: ['SDN'],
          dimensionValue: '202503',
          page,
          perPage: 1000,
        },
        ctx,
      );
    const pages = [await call(1), await call(2), await call(3), await call(4)];

    expect(pages.map((p) => p.data.length)).toEqual([200, 200, 50, 0]);
    expect(pages.map((p) => [p.perPage, p.pages, p.total])).toEqual(
      Array.from({ length: 4 }, () => [200, 3, 450]),
    );
    expect(pages.flatMap((p) => p.data.map((d) => d.value))).toEqual(years);
  });

  it('reads every upstream page of a large scope', async () => {
    route(
      archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503?page=1': data(
          '57',
          [sdn('YR2016', '202503', 1)],
          { page: 1, pages: 2 },
        ),
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503?page=2': data(
          '57',
          [sdn('YR2015', '202503', 2)],
          { page: 2, pages: 2 },
        ),
      }),
    );
    const result = await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['SDN'],
        dimensionValue: '202503',
        page: 1,
        perPage: 50,
      },
      createMockContext(),
    );
    expect(result.data.map((d) => d.value)).toEqual([1, 2]);
  });

  it('reads the id-160 XML envelope on a validated request as an empty result', async () => {
    route(
      archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503': DATA_NOT_FOUND_XML,
      }),
    );
    const result = await service.getData(
      {
        indicatorId: 'SM.POP.REFG.OR',
        countries: ['SDN'],
        dimensionValue: '202503',
        page: 1,
        perPage: 50,
      },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 0, sourceScoped: { sourceId: '57' } });
  });

  it('refuses a scope past the row limit as source_scope_too_large before any data request', async () => {
    const countries = listing(
      '57',
      'country',
      Array.from({ length: 300 }, (_, i): [string, string] => [
        `C${String(i).padStart(2, '0')}`,
        `Country ${i}`,
      ]),
    );
    const times = listing(
      '57',
      'time',
      Array.from({ length: 67 }, (_, i): [string, string] => [`YR${1960 + i}`, `${1960 + i}`]),
    );
    route({
      ...archiveRoutes({ '/v2/sources/57/country': countries, '/v2/sources/57/time': times }),
      '/v2/country/all/indicator/SM.POP.REFG.OR': NOT_SERVED,
    });
    const err = (await service
      .getData(
        { indicatorId: 'SM.POP.REFG.OR', countries: ['all'], mrv: 1, page: 1, perPage: 50 },
        createMockContext(),
      )
      .catch((e: unknown) => e)) as McpError;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'source_scope_too_large', sourceId: '57', estimatedRows: 300 * 67 * 3 },
    });
    expect(err.message).toContain('300 countries × 67 periods × 3 Version values');
    expect(requestedPaths().some((p) => p.includes('/series/'))).toBe(false);
  });

  // ─── What still cannot be served ──────────────────────────────────────────

  it.each([
    [
      'the catalog no longer lists the ID',
      [{ message: [{ id: '120', key: 'Invalid value', value: 'x' }] }],
    ],
    ['the catalog lookup fails', '<!DOCTYPE html><html><body>503</body></html>'],
  ])('keeps indicator_not_queryable when %s', async (_label, catalogBody) => {
    route({
      '/v2/country/SDN/indicator/SM.POP.REFG.OR': NOT_SERVED,
      '/v2/indicator/SM.POP.REFG.OR': catalogBody,
    });
    const err = (await service
      .getData(
        { indicatorId: 'SM.POP.REFG.OR', countries: ['SDN'], page: 1, perPage: 50 },
        createMockContext(),
      )
      .catch((e: unknown) => e)) as McpError;
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'indicator_not_queryable' },
    });
    expect(err.message).toContain('no catalog source could be resolved');
    expect(err.message).not.toContain('SDN');
  });

  it('keeps indicator_not_queryable, naming the source, when its layout cannot be addressed', async () => {
    route({
      '/v2/country/SDN/indicator/X.SUB': NOT_SERVED,
      '/v2/indicator/X.SUB': catalog(['X.SUB', 'Subnational', '45', 'Subnational Poverty']),
      '/v2/sources/45/concepts': concepts('45', 'Subnational Poverty', [
        'Provinces',
        'Series',
        'Time',
      ]),
    });
    const err = (await service
      .getData(
        { indicatorId: 'X.SUB', countries: ['SDN'], page: 1, perPage: 50 },
        createMockContext(),
      )
      .catch((e: unknown) => e)) as McpError;
    expect(err).toMatchObject({
      data: { reason: 'indicator_not_queryable', sourceNames: ['Subnational Poverty'] },
    });
    expect(err.message).toContain('catalogued under Subnational Poverty, but neither');
  });

  // ─── Caching and the standard path ────────────────────────────────────────

  it('caches source discovery across calls and refetches it when the TTL is 0', async () => {
    const observations = data('57', [sdn('YR2015', '202503', 1)]);
    route(
      archiveRoutes({
        '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503': observations,
      }),
    );
    const input = {
      indicatorId: 'SM.POP.REFG.OR',
      countries: ['SDN'],
      dimensionValue: '202503',
      page: 1,
      perPage: 50,
    };
    await service.getData(input, createMockContext());
    const before = fetchMock.mock.calls.length;
    await service.getData(input, createMockContext());
    expect(requestedPaths().slice(before)).toEqual([
      '/v2/country/SDN/indicator/SM.POP.REFG.OR',
      '/v2/indicator/SM.POP.REFG.OR',
      '/v2/sources/57/country/SDN/series/SM.POP.REFG.OR/version/202503',
    ]);

    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      apiBaseUrl: 'https://api.worldbank.org/v2',
      catalogCacheTtlMs: 0,
    } as never);
    const { WorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const uncached = new WorldBankApiService({} as never, createInMemoryStorage());
    await uncached.getData(input, createMockContext());
    const afterFirst = fetchMock.mock.calls.length;
    await uncached.getData(input, createMockContext());
    expect(
      requestedPaths()
        .slice(afterFirst)
        .filter((p) => p === '/v2/sources/57/concepts'),
    ).toHaveLength(1);
  });

  it('adds no request to an indicator the standard endpoint serves', async () => {
    route({
      '/v2/country/US/indicator/NY.GDP.PCAP.CD': [
        { page: 1, pages: 1, per_page: 50, total: 1 },
        [
          {
            indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP' },
            country: { id: 'US', value: 'United States' },
            countryiso3code: 'USA',
            date: '2024',
            value: 1,
          },
        ],
      ],
      '/v2/country': COUNTRY_INDEX,
    });
    const result = await service.getData(
      { indicatorId: 'NY.GDP.PCAP.CD', countries: ['US'], page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.sourceScoped).toBeUndefined();
    expect(result.data[0]).not.toHaveProperty('dimension');
    expect(requestedPaths()).toEqual(['/v2/country/US/indicator/NY.GDP.PCAP.CD', '/v2/country']);
  });
});
