/**
 * @fileoverview Tests for WorldBankApiService — normalization, error detection,
 * and service-level behavior including HTML-error detection, WbErrorEnvelope
 * detection, no-data throws, aggregate classification, and client-side filtering.
 * @module tests/services/worldbank/worldbank-service.test
 */

import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── fetchWithTimeout mock ────────────────────────────────────────────────────
// We need to intercept HTTP calls before importing the service. The mock must
// be hoisted so it's defined before any import that resolves the dep.
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

// ─── Helper to build a minimal AppConfig and StorageService ─────────────────

function makeConfig() {
  // AppConfig shape — only what WorldBankApiService's constructor receives
  return {} as Parameters<
    InstanceType<
      typeof import('@/services/worldbank/worldbank-service.js')['WorldBankApiService']
    >['constructor']
  >[0];
}

// ─── WbEnvelope response helpers ─────────────────────────────────────────────

function pagingObj(overrides = {}) {
  return { page: 1, pages: 1, per_page: 50, total: 1, ...overrides };
}

/** Minimal raw indicator; `sourceNote` defaults to empty so matching stays predictable. */
function rawIndicator(id: string, name: string, sourceNote = '') {
  return { id, name, source: { id: '2', value: 'WDI' }, sourceNote, topics: [] };
}

/**
 * Raw indicator with an explicit source. The catalog republishes dozens of
 * indicators under a second source — a live dataset and an archived copy — and
 * the two rows are identical but for this block.
 */
function rawIndicatorFrom(id: string, name: string, sourceId: string, sourceName: string) {
  return { id, name, source: { id: sourceId, value: sourceName }, sourceNote: '', topics: [] };
}

/** Minimal raw country. Aggregates carry region.id = incomeLevel.id = "NA". */
function rawCountry(id: string, name: string, aggregate = false) {
  return {
    id,
    iso2Code: id.slice(0, 2),
    name,
    region: aggregate ? { id: 'NA', value: '' } : { id: 'ECS', value: 'Europe' },
    incomeLevel: aggregate ? { id: 'NA', value: '' } : { id: 'HIC', value: 'High income' },
    lendingType: {},
    capitalCity: '',
    longitude: '',
    latitude: '',
  };
}

/**
 * Aggregate entity as the country listing returns it: an aggregate code in `id`
 * and an unrelated ISO2 in `iso2Code` (`AFE`/`ZH`), which is the pairing the data
 * endpoint splits across `countryiso3code` and `country.id`.
 */
function rawAggregate(id: string, iso2Code: string, name: string) {
  return { ...rawCountry(id, name, true), iso2Code };
}

/** One raw observation from the data endpoint. */
function rawDataPoint(
  countryId: string,
  iso3: string,
  countryName: string,
  date: string,
  value: number | null = 1,
) {
  return {
    indicator: { id: 'SP.POP.TOTL', value: 'Population, total' },
    country: { id: countryId, value: countryName },
    countryiso3code: iso3,
    date,
    value,
    obs_status: '',
  };
}

/** The WB "invalid parameter value" body, returned with HTTP 200. */
const WB_ERROR_BODY = [
  {
    message: [
      { id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' },
    ],
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorldBankApiService', () => {
  let fetchWithTimeoutMock: ReturnType<typeof vi.fn>;
  let service: InstanceType<
    typeof import('@/services/worldbank/worldbank-service.js')['WorldBankApiService']
  >;

  /** Queue one upstream JSON response on the fetch mock. */
  function mockResponse(body: unknown) {
    fetchWithTimeoutMock.mockResolvedValueOnce({ text: async () => JSON.stringify(body) });
  }

  /**
   * Queue the `/country` listing `getData` consults to classify aggregates. It is
   * fetched after the data response, so queue it after the matching mockResponse.
   */
  function mockAggregateLookup() {
    mockResponse([
      pagingObj({ total: 4 }),
      [
        rawCountry('USA', 'United States'),
        rawAggregate('AFE', 'ZH', 'Africa Eastern and Southern'),
        rawAggregate('WLD', '1W', 'World'),
        rawAggregate('EUU', 'EU', 'European Union'),
      ],
    ]);
  }

  beforeEach(async () => {
    const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
    fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);

    // Reset the config mock every test — individual tests override it (e.g. TTL 0)
    // and vi.clearAllMocks() does not restore a mockReturnValue.
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      apiBaseUrl: 'https://api.worldbank.org/v2',
      defaultPerPage: 50,
      catalogCacheTtlMs: 60_000,
    } as never);

    const { WorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const storage = createInMemoryStorage();
    service = new WorldBankApiService(makeConfig() as never, storage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── HTML error detection ─────────────────────────────────────────────────

  it('throws serviceUnavailable when upstream returns an HTML error page', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => '<!DOCTYPE html><html><body>503 Service Unavailable</body></html>',
    });
    const ctx = createMockContext();
    await expect(service.listTopics(ctx)).rejects.toThrow(/HTML error page/);
  });

  it('throws serviceUnavailable on lowercase html tag response', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => '<html><head></head><body>Error</body></html>',
    });
    const ctx = createMockContext();
    await expect(service.listTopics(ctx)).rejects.toThrow(/HTML error page/);
  });

  // ─── listTopics ───────────────────────────────────────────────────────────

  it('listTopics: normalizes raw topic array', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj(),
          [
            { id: '3', value: 'Economy & Growth', sourceNote: 'Covers GDP and trade.' },
            { id: '10', value: 'Health', sourceNote: 'Health indicators.' },
          ],
        ]),
    });
    const ctx = createMockContext();
    const topics = await service.listTopics(ctx);
    expect(topics).toHaveLength(2);
    expect(topics[0]).toMatchObject({
      id: '3',
      name: 'Economy & Growth',
      sourceNote: 'Covers GDP and trade.',
    });
    expect(topics[1]).toMatchObject({ id: '10', name: 'Health', sourceNote: 'Health indicators.' });
  });

  it('listTopics: handles empty item array', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj({ total: 0 }), null]),
    });
    const ctx = createMockContext();
    const topics = await service.listTopics(ctx);
    expect(topics).toHaveLength(0);
  });

  it('listTopics: normalizes sparse topic with missing fields', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj(), [{ id: '5' }]]), // no value or sourceNote
    });
    const ctx = createMockContext();
    const topics = await service.listTopics(ctx);
    expect(topics[0]).toMatchObject({ id: '5', name: '', sourceNote: '' });
  });

  // ─── listSources ─────────────────────────────────────────────────────────

  it('listSources: normalizes source fields and coerces page/total to numbers', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          { page: '1', pages: '2', per_page: '50', total: '71' },
          [
            {
              id: '2',
              name: 'World Development Indicators',
              code: 'WDI',
              lastupdated: '2024-01-15',
              dataavailability: 'Y',
              metadataavailability: 'Y',
              concepts: '1400',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.listSources(1, 50, ctx);
    expect(result.total).toBe(71);
    expect(result.page).toBe(1);
    expect(result.pages).toBe(2);
    expect(result.sources[0]).toMatchObject({
      id: '2',
      name: 'World Development Indicators',
      code: 'WDI',
      lastUpdated: '2024-01-15',
      dataAvailability: 'Y',
      metadataAvailability: 'Y',
      concepts: '1400',
    });
  });

  it('listSources: normalizes sparse source with missing optional fields', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          { page: '1', pages: '1', per_page: '50', total: '1' },
          [{ id: '99', name: 'Minimal Source' }],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.listSources(1, 50, ctx);
    expect(result.sources[0]).toMatchObject({
      id: '99',
      name: 'Minimal Source',
      code: '',
      lastUpdated: '',
      dataAvailability: '',
      metadataAvailability: '',
      concepts: '',
    });
  });

  // ─── getIndicator ─────────────────────────────────────────────────────────

  it('getIndicator: normalizes a full indicator', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj(),
          [
            {
              id: 'NY.GDP.PCAP.CD',
              name: 'GDP per capita (current US$)',
              unit: 'US$',
              source: { id: '2', value: 'World Development Indicators' },
              sourceNote: 'GDP per capita is...',
              sourceOrganization: 'World Bank national accounts',
              topics: [
                { id: '3', value: 'Economy & Growth' },
                { id: '', value: 'Empty topic' }, // filtered out
              ],
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.getIndicator('NY.GDP.PCAP.CD', ctx);
    expect(result.id).toBe('NY.GDP.PCAP.CD');
    expect(result.unit).toBe('US$');
    expect(result.sourceName).toBe('World Development Indicators');
    expect(result.topics).toHaveLength(1); // empty-id topic filtered out
    expect(result.topics[0]).toMatchObject({ id: '3', name: 'Economy & Growth' });
  });

  it('getIndicator: resolves a duplicate ID to the same row search keeps', async () => {
    // Upstream returns the archived copy first for this ID.
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '93', 'FPN Datahub Archive'),
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '88', 'Food Prices for Nutrition'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.getIndicator('CoCA_fexp', ctx);
    expect(result).toMatchObject({ sourceId: '88', sourceName: 'Food Prices for Nutrition' });
  });

  it('getIndicator: throws notFound when WbErrorEnvelope returned (object form)', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify({
          message: [
            {
              id: '120',
              key: 'Parameter "indicator" has an invalid value',
              value: 'The provided parameter value is not valid',
            },
          ],
        }),
    });
    const ctx = createMockContext();
    await expect(service.getIndicator('INVALID.ID', ctx)).rejects.toMatchObject({
      data: { reason: 'indicator_not_found' },
    });
  });

  it('getIndicator: throws notFound when WbErrorEnvelope returned (array-wrapped form)', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          { message: [{ id: '120', key: 'Parameter has invalid value', value: 'Invalid' }] },
        ]),
    });
    const ctx = createMockContext();
    await expect(service.getIndicator('INVALID.ID', ctx)).rejects.toMatchObject({
      data: { reason: 'indicator_not_found' },
    });
  });

  it('getIndicator: throws notFound when items array is empty', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj({ total: 0 }), []]),
    });
    const ctx = createMockContext();
    await expect(service.getIndicator('NY.UNKNOWN.ID', ctx)).rejects.toMatchObject({
      data: { reason: 'indicator_not_found' },
    });
  });

  it('getIndicator: normalizes sparse indicator with null/missing fields', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([pagingObj(), [{ id: 'SH.MED.BEDS.ZS', name: 'Hospital beds' }]]),
    });
    const ctx = createMockContext();
    const result = await service.getIndicator('SH.MED.BEDS.ZS', ctx);
    expect(result.id).toBe('SH.MED.BEDS.ZS');
    expect(result.unit).toBe('');
    expect(result.sourceOrganization).toBe('');
    expect(result.topics).toHaveLength(0);
  });

  // ─── getCountry ───────────────────────────────────────────────────────────

  it('getCountry: normalizes a full country', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj(),
          [
            {
              id: 'USA',
              iso2Code: 'US',
              name: 'United States',
              region: { id: 'NAC', value: 'North America' },
              incomeLevel: { id: 'HIC', value: 'High income' },
              lendingType: { value: 'Not classified' },
              capitalCity: 'Washington D.C.',
              longitude: '-77.032',
              latitude: '38.8895',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.getCountry('USA', ctx);
    expect(result).toMatchObject({
      id: 'USA',
      iso2: 'US',
      name: 'United States',
      region: { id: 'NAC', name: 'North America' },
      incomeLevel: { id: 'HIC', name: 'High income' },
      lendingType: 'Not classified',
      capitalCity: 'Washington D.C.',
      isAggregate: false,
    });
  });

  it('getCountry: detects aggregate when region.id = NA and incomeLevel.id = NA', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj(),
          [
            {
              id: 'EAS',
              iso2Code: 'Z4',
              name: 'East Asia & Pacific',
              region: { id: 'NA', value: '' },
              incomeLevel: { id: 'NA', value: '' },
              lendingType: {},
              capitalCity: '',
              longitude: '',
              latitude: '',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.getCountry('EAS', ctx);
    expect(result.isAggregate).toBe(true);
    expect(result.id).toBe('EAS');
  });

  it('getCountry: throws notFound on WbErrorEnvelope', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify({ message: [{ id: '120', key: 'Invalid country', value: 'Not found' }] }),
    });
    const ctx = createMockContext();
    await expect(service.getCountry('ZZ', ctx)).rejects.toMatchObject({
      data: { reason: 'country_not_found' },
    });
  });

  it('getCountry: throws notFound when items array is empty', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj({ total: 0 }), []]),
    });
    const ctx = createMockContext();
    await expect(service.getCountry('ZZ', ctx)).rejects.toMatchObject({
      data: { reason: 'country_not_found' },
    });
  });

  it('getCountry: normalizes sparse country with null/missing fields', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj(),
          [{ id: 'TCA', iso2Code: 'TC', name: 'Turks and Caicos Islands' }],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.getCountry('TCA', ctx);
    expect(result.region).toMatchObject({ id: '', name: '' });
    expect(result.incomeLevel).toMatchObject({ id: '', name: '' });
    expect(result.lendingType).toBe('');
    expect(result.capitalCity).toBe('');
    expect(result.isAggregate).toBe(false); // neither id = "NA"
  });

  // ─── listCountries ────────────────────────────────────────────────────────

  it('listCountries: excludes aggregates by default', async () => {
    const raw = [
      {
        id: 'US',
        iso2Code: 'US',
        name: 'United States',
        region: { id: 'NAC', value: 'North America' },
        incomeLevel: { id: 'HIC', value: 'High income' },
        lendingType: {},
        capitalCity: '',
        longitude: '',
        latitude: '',
      },
      {
        id: 'EAS',
        iso2Code: 'Z4',
        name: 'East Asia & Pacific',
        region: { id: 'NA', value: '' },
        incomeLevel: { id: 'NA', value: '' },
        lendingType: {},
        capitalCity: '',
        longitude: '',
        latitude: '',
      },
    ];
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj({ total: 2, per_page: 300 }), raw]),
    });
    const ctx = createMockContext();
    const result = await service.listCountries(
      { includeAggregates: false, page: 1, perPage: 50 },
      ctx,
    );
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0].id).toBe('US');
    expect(result.total).toBe(1); // re-paginated total reflects filtered count
  });

  it('listCountries: includes aggregates when requested', async () => {
    const raw = [
      {
        id: 'US',
        iso2Code: 'US',
        name: 'United States',
        region: { id: 'NAC', value: 'North America' },
        incomeLevel: { id: 'HIC', value: 'High income' },
        lendingType: {},
        capitalCity: '',
        longitude: '',
        latitude: '',
      },
      {
        id: 'EAS',
        iso2Code: 'Z4',
        name: 'East Asia & Pacific',
        region: { id: 'NA', value: '' },
        incomeLevel: { id: 'NA', value: '' },
        lendingType: {},
        capitalCity: '',
        longitude: '',
        latitude: '',
      },
    ];
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj({ total: 2 }), raw]),
    });
    const ctx = createMockContext();
    const result = await service.listCountries(
      { includeAggregates: true, page: 1, perPage: 50 },
      ctx,
    );
    expect(result.countries).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('listCountries: throws notFound on invalid filter (WbErrorEnvelope)', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify({ message: [{ id: '120', key: 'Invalid region', value: 'Bad filter' }] }),
    });
    const ctx = createMockContext();
    await expect(
      service.listCountries(
        { region: 'BOGUS', includeAggregates: false, page: 1, perPage: 50 },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
  });

  it('listCountries: correctly paginates client-filtered results', async () => {
    // 3 non-aggregate countries, perPage=2 → page 2 returns the 3rd
    const raw = [
      {
        id: 'US',
        iso2Code: 'US',
        name: 'United States',
        region: { id: 'NAC', value: 'North America' },
        incomeLevel: { id: 'HIC', value: 'High income' },
        lendingType: {},
        capitalCity: '',
        longitude: '',
        latitude: '',
      },
      {
        id: 'DE',
        iso2Code: 'DE',
        name: 'Germany',
        region: { id: 'ECS', value: 'Europe' },
        incomeLevel: { id: 'HIC', value: 'High income' },
        lendingType: {},
        capitalCity: '',
        longitude: '',
        latitude: '',
      },
      {
        id: 'JP',
        iso2Code: 'JP',
        name: 'Japan',
        region: { id: 'EAS', value: 'East Asia' },
        incomeLevel: { id: 'HIC', value: 'High income' },
        lendingType: {},
        capitalCity: '',
        longitude: '',
        latitude: '',
      },
    ];
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj({ total: 3, per_page: 300 }), raw]),
    });
    const ctx = createMockContext();
    const result = await service.listCountries(
      { includeAggregates: false, page: 2, perPage: 2 },
      ctx,
    );
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0].id).toBe('JP');
    expect(result.total).toBe(3);
    expect(result.pages).toBe(2);
  });

  it('listCountries: reaches an entity on upstream page 2 when excluding aggregates', async () => {
    mockResponse([
      pagingObj({ pages: 2, total: 4 }),
      [rawCountry('US', 'United States'), rawCountry('EAS', 'East Asia & Pacific', true)],
    ]);
    mockResponse([
      pagingObj({ page: 2, pages: 2, total: 4 }),
      [rawCountry('ZW', 'Zimbabwe'), rawCountry('WLD', 'World', true)],
    ]);
    const ctx = createMockContext();
    const result = await service.listCountries(
      { includeAggregates: false, page: 1, perPage: 50 },
      ctx,
    );
    // The caller must actually receive the page-2 country, not merely trigger the fetch.
    expect(result.countries.map((c) => c.id)).toEqual(['US', 'ZW']);
    expect(result.total).toBe(2);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('listCountries: passes page/per_page straight through when including aggregates', async () => {
    mockResponse([
      pagingObj({ page: 3, pages: 4, total: 295, per_page: 100 }),
      [rawCountry('US', 'United States')],
    ]);
    const ctx = createMockContext();
    const result = await service.listCountries(
      { includeAggregates: true, page: 3, perPage: 100 },
      ctx,
    );
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('page=3');
    expect(url).toContain('per_page=100');
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(295);
    expect(result.page).toBe(3);
    expect(result.pages).toBe(4);
  });

  // ─── searchIndicators ─────────────────────────────────────────────────────

  it('searchIndicators: keyword-only path filters the catalog instead of trusting searchterm', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita (current US$)'),
        rawIndicator('SP.POP.TOTL', 'Population, total'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators({ query: 'GDP', page: 1, perPage: 50 }, ctx);
    expect(result.indicators.map((i) => i.id)).toEqual(['NY.GDP.PCAP.CD']);
    expect(result.total).toBe(1);
    // The upstream searchterm param doesn't filter, so it must not be relied on.
    expect(fetchWithTimeoutMock.mock.calls[0][0] as string).not.toContain('searchterm');
  });

  it('searchIndicators: keyword-only path returns empty for a nonsense query', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita'),
        rawIndicator('SP.POP.TOTL', 'Population, total'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'zzzz-no-such-indicator-xyz', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('searchIndicators: keyword-only path reaches a match on upstream page 2', async () => {
    mockResponse([pagingObj({ pages: 2, total: 2 }), [rawIndicator('SP.POP.TOTL', 'Population')]]);
    mockResponse([
      pagingObj({ page: 2, pages: 2, total: 2 }),
      [rawIndicator('VC.IHR.PSRC.P5', 'Intentional homicides (per 100,000 people)')],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'VC.IHR.PSRC.P5', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['VC.IHR.PSRC.P5']);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    // The catalog is ~15 MB; the single-page timeout is far too short for it.
    expect(fetchWithTimeoutMock.mock.calls.map((c) => c[1])).toEqual([60_000, 60_000]);
  });

  it('searchIndicators: keyword matching ignores word order', async () => {
    mockResponse([
      pagingObj({ total: 1 }),
      [rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita (current US$)')],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'per capita gdp', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['NY.GDP.PCAP.CD']);
  });

  it('searchIndicators: ranks id/name matches ahead of sourceNote-only matches', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('AG.LND.FRST.ZS', 'Forest area', 'Share of land area relative to GDP trends.'),
        rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators({ query: 'gdp', page: 1, perPage: 50 }, ctx);
    expect(result.indicators.map((i) => i.id)).toEqual(['NY.GDP.PCAP.CD', 'AG.LND.FRST.ZS']);
  });

  it('searchIndicators: matches a pasted indicator name despite its punctuation', async () => {
    // Split on whitespace, this query yields the token "(%)" — which appears in
    // no indicator name — and the search returns nothing.
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('SL.UEM.TOTL.FE.ZS', 'Unemployment, female (% of female labor force)'),
        rawIndicator('SP.POP.TOTL', 'Population, total'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'Unemployment, female (%)', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['SL.UEM.TOTL.FE.ZS']);
  });

  it('searchIndicators: ranks an exact ID or name match first', async () => {
    mockResponse([
      pagingObj({ total: 3 }),
      [
        rawIndicator('NV.SRV.DISC.CD', 'Discrepancy in expenditure estimate of GDP (current US$)'),
        rawIndicator('NY.GDP.MKTP.CD.XD', 'GDP (current US$) deflator index'),
        rawIndicator('NY.GDP.MKTP.CD', 'GDP (current US$)'),
      ],
    ]);
    const ctx = createMockContext();
    const byName = await service.searchIndicators(
      { query: 'GDP (current US$)', page: 1, perPage: 50 },
      ctx,
    );
    // Exact name first, then the whole-phrase hits in catalog order.
    expect(byName.indicators.map((i) => i.id)).toEqual([
      'NY.GDP.MKTP.CD',
      'NV.SRV.DISC.CD',
      'NY.GDP.MKTP.CD.XD',
    ]);
  });

  it('searchIndicators: topic+keyword path reaches a match on upstream page 2', async () => {
    mockResponse([
      pagingObj({ pages: 2, total: 2 }),
      [rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita')],
    ]);
    mockResponse([
      pagingObj({ page: 2, pages: 2, total: 2 }),
      [rawIndicator('VC.IHR.PSRC.P5', 'Intentional homicides')],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'VC.IHR.PSRC.P5', topicId: '4', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['VC.IHR.PSRC.P5']);
    expect(result.total).toBe(1);
    expect(fetchWithTimeoutMock.mock.calls[0][0] as string).toContain('/topic/4/indicator');
  });

  it('searchIndicators: source+keyword path reaches a match on upstream page 2', async () => {
    mockResponse([
      pagingObj({ pages: 2, total: 2 }),
      [rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita')],
    ]);
    mockResponse([
      pagingObj({ page: 2, pages: 2, total: 2 }),
      [rawIndicator('VC.IHR.PSRC.P5', 'Intentional homicides')],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'homicides', sourceId: '2', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['VC.IHR.PSRC.P5']);
    expect(fetchWithTimeoutMock.mock.calls[0][0] as string).toContain('source=2');
  });

  it('searchIndicators: paginates matches beyond the first result page', async () => {
    mockResponse([
      pagingObj({ total: 3 }),
      [
        rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita'),
        rawIndicator('NY.GDP.MKTP.CD', 'GDP (current US$)'),
        rawIndicator('NY.GDP.MKTP.KD.ZG', 'GDP growth'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators({ query: 'gdp', page: 2, perPage: 2 }, ctx);
    expect(result.indicators.map((i) => i.id)).toEqual(['NY.GDP.MKTP.KD.ZG']);
    expect(result.total).toBe(3);
    expect(result.pages).toBe(2);
    expect(result.page).toBe(2);
  });

  it('searchIndicators: source-only path uses source filter param and upstream pagination', async () => {
    mockResponse([
      pagingObj({ page: 2, pages: 4, total: 190 }),
      [rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita')],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators({ sourceId: '2', page: 2, perPage: 50 }, ctx);
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('source=2');
    expect(url).toContain('per_page=50');
    expect(url).toContain('page=2');
    // Upstream pagination is passed through verbatim on this branch.
    expect(result.indicators.map((i) => i.id)).toEqual(['NY.GDP.PCAP.CD']);
    expect(result).toMatchObject({ total: 190, page: 2, pages: 4 });
  });

  it('searchIndicators: throws invalid_filter for an unknown topic id (no query)', async () => {
    mockResponse(WB_ERROR_BODY);
    const ctx = createMockContext();
    await expect(
      service.searchIndicators({ topicId: '999', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
  });

  it('searchIndicators: throws invalid_filter for an unknown source id with a keyword', async () => {
    mockResponse(WB_ERROR_BODY);
    const ctx = createMockContext();
    await expect(
      service.searchIndicators({ query: 'gdp', sourceId: '999', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
  });

  it('searchIndicators: caches the catalog across keyword-only searches', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita'),
        rawIndicator('SP.POP.TOTL', 'Population, total'),
      ],
    ]);
    const ctx = createMockContext();
    const first = await service.searchIndicators({ query: 'gdp', page: 1, perPage: 50 }, ctx);
    const second = await service.searchIndicators(
      { query: 'population', page: 1, perPage: 50 },
      ctx,
    );
    expect(first.indicators.map((i) => i.id)).toEqual(['NY.GDP.PCAP.CD']);
    expect(second.indicators.map((i) => i.id)).toEqual(['SP.POP.TOTL']);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('searchIndicators: concurrent keyword searches share one catalog fetch', async () => {
    mockResponse([pagingObj({ total: 1 }), [rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita')]]);
    const ctx = createMockContext();
    const [a, b] = await Promise.all([
      service.searchIndicators({ query: 'gdp', page: 1, perPage: 50 }, ctx),
      service.searchIndicators({ query: 'capita', page: 1, perPage: 50 }, ctx),
    ]);
    expect(a.indicators).toHaveLength(1);
    expect(b.indicators).toHaveLength(1);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('searchIndicators: refetches the catalog when the cache TTL is 0', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      apiBaseUrl: 'https://api.worldbank.org/v2',
      defaultPerPage: 50,
      catalogCacheTtlMs: 0,
    } as never);
    const { WorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const uncached = new WorldBankApiService(makeConfig() as never, createInMemoryStorage());

    const body = [pagingObj({ total: 1 }), [rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita')]];
    mockResponse(body);
    mockResponse(body);
    const ctx = createMockContext();
    await uncached.searchIndicators({ query: 'gdp', page: 1, perPage: 50 }, ctx);
    await uncached.searchIndicators({ query: 'gdp', page: 1, perPage: 50 }, ctx);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('searchIndicators: filters out topics with empty id during normalization', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 1 }),
          [
            {
              id: 'NY.GDP.PCAP.CD',
              name: 'GDP per capita',
              source: { id: '2', value: 'WDI' },
              sourceNote: '',
              topics: [
                { id: '3', value: 'Economy' },
                { id: '', value: 'Should be filtered' },
                { id: undefined, value: 'Also filtered' },
              ],
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.searchIndicators({ query: 'GDP', page: 1, perPage: 50 }, ctx);
    expect(result.indicators[0].topics).toHaveLength(1);
    expect(result.indicators[0].topics[0].id).toBe('3');
  });

  /**
   * Upstream row order for a duplicate pair is arbitrary — the live catalog
   * returns the archived copy first for some IDs and second for others — so the
   * survivor is asserted from both orders.
   */
  it.each([
    ['archived row first', ['93', '88']],
    ['archived row second', ['88', '93']],
  ])(
    'searchIndicators: collapses a duplicate ID, dropping the archived source (%s)',
    async (_label, [first, second]) => {
      const bySourceId: Record<string, string> = {
        '88': 'Food Prices for Nutrition',
        '93': 'FPN Datahub Archive',
      };
      const name = 'Affordability of an energy sufficient diet';
      mockResponse([
        pagingObj({ total: 2 }),
        [
          rawIndicatorFrom(
            'CoCA_fexp',
            name,
            first as string,
            bySourceId[first as string] as string,
          ),
          rawIndicatorFrom(
            'CoCA_fexp',
            name,
            second as string,
            bySourceId[second as string] as string,
          ),
        ],
      ]);
      const ctx = createMockContext();
      const result = await service.searchIndicators(
        { query: 'CoCA_fexp', page: 1, perPage: 50 },
        ctx,
      );
      expect(result.indicators).toHaveLength(1);
      expect(result.indicators[0]).toMatchObject({
        id: 'CoCA_fexp',
        sourceId: '88',
        sourceName: 'Food Prices for Nutrition',
      });
      expect(result.total).toBe(1);
      expect(result.pages).toBe(1);
    },
  );

  it('searchIndicators: keeps the lower source ID when neither row is archived', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicatorFrom('SP.POP.TOTL', 'Population, total', '57', 'WDI Database Extract'),
        rawIndicatorFrom('SP.POP.TOTL', 'Population, total', '2', 'World Development Indicators'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'population total', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators).toHaveLength(1);
    expect(result.indicators[0]).toMatchObject({ sourceId: '2' });
    expect(result.total).toBe(1);
  });

  it('searchIndicators: topic-scoped keyword search collapses duplicates too', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '93', 'FPN Datahub Archive'),
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '88', 'Food Prices for Nutrition'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'affordability', topicId: '1', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators).toHaveLength(1);
    expect(result.indicators[0]).toMatchObject({ sourceId: '88' });
  });

  // ─── getData ──────────────────────────────────────────────────────────────

  it('getData: returns normalized data points with nullCount', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 3 }),
          [
            {
              indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP per capita' },
              country: { id: 'US', value: 'United States' },
              countryiso3code: 'USA',
              date: '2022',
              value: 76399.42,
              obs_status: '',
            },
            {
              indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP per capita' },
              country: { id: 'CN', value: 'China' },
              countryiso3code: 'CHN',
              date: '2022',
              value: 12720.04,
              obs_status: '',
            },
            {
              indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP per capita' },
              country: { id: 'AF', value: 'Afghanistan' },
              countryiso3code: 'AFG',
              date: '2022',
              value: null,
              obs_status: '',
            },
          ],
        ]),
    });
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'NY.GDP.PCAP.CD', countries: ['US', 'CN', 'AF'], page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data).toHaveLength(3);
    expect(result.nullCount).toBe(1);
    expect(result.indicator).toMatchObject({ id: 'NY.GDP.PCAP.CD', name: 'GDP per capita' });
    expect(result.total).toBe(3);
  });

  it('getData: classifies aggregates from the country listing, not a code list', async () => {
    mockResponse([
      pagingObj({ total: 4 }),
      [
        // ISO2 in country.id, aggregate code in countryiso3code — both must resolve.
        rawDataPoint('ZH', 'AFE', 'Africa Eastern and Southern', '2022'),
        rawDataPoint('1W', 'WLD', 'World', '2022'),
        // EUU sits outside the 33 codes the service used to hardcode.
        rawDataPoint('EU', 'EUU', 'European Union', '2022'),
        rawDataPoint('US', 'USA', 'United States', '2022'),
      ],
    ]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      {
        indicatorId: 'SP.POP.TOTL',
        countries: ['AFE', 'WLD', 'EUU', 'US'],
        page: 1,
        perPage: 50,
      },
      ctx,
    );
    expect(result.data.map((d) => [d.countryIso3, d.isAggregate])).toEqual([
      ['AFE', true],
      ['WLD', true],
      ['EUU', true],
      ['USA', false],
    ]);
  });

  it('getData: classifies an aggregate whose data rows carry no ISO3 code', async () => {
    // The income-group aggregates come back with an empty countryiso3code, so
    // their ISO2 in country.id is the only identifier available to place them.
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('XD', '', 'High income', '2022')]]);
    mockResponse([
      pagingObj({ total: 2 }),
      [rawCountry('USA', 'United States'), rawAggregate('HIC', 'XD', 'High income')],
    ]);
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'HIC', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data[0]).toMatchObject({ countryCode: 'XD', countryIso3: '', isAggregate: true });
  });

  it('getData: refetches the aggregate lookup once its TTL lapses', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      apiBaseUrl: 'https://api.worldbank.org/v2',
      defaultPerPage: 50,
      catalogCacheTtlMs: 60_000,
    } as never);
    const { WorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const shortLived = new WorldBankApiService(makeConfig() as never, createInMemoryStorage());

    vi.useFakeTimers();
    try {
      const row = [pagingObj({ total: 1 }), [rawDataPoint('EU', 'EUU', 'European Union', '2022')]];
      mockResponse(row);
      mockAggregateLookup();
      mockResponse(row);
      mockAggregateLookup();
      const ctx = createMockContext();
      await shortLived.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'EUU', page: 1, perPage: 50 },
        ctx,
      );
      vi.setSystemTime(Date.now() + 60_001);
      const second = await shortLived.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'EUU', page: 1, perPage: 50 },
        ctx,
      );
      expect(second.data[0].isAggregate).toBe(true);
      // Two data requests and two country listings — the stale set was not reused.
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getData: reuses the cached aggregate lookup across calls', async () => {
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('EU', 'EUU', 'European Union', '2022')]]);
    mockAggregateLookup();
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('EU', 'EUU', 'European Union', '2021')]]);
    const ctx = createMockContext();
    const first = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'EUU', page: 1, perPage: 50 },
      ctx,
    );
    const second = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'EUU', page: 1, perPage: 50 },
      ctx,
    );
    expect(first.data[0].isAggregate).toBe(true);
    expect(second.data[0].isAggregate).toBe(true);
    // Two data requests plus one country listing — the listing is not refetched.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it('getData: returns empty data (no throw) when items array is empty', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => JSON.stringify([pagingObj({ total: 0 }), null]),
    });
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'NY.GDP.PCAP.CD', countries: 'US', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data).toHaveLength(0);
    expect(result.nullCount).toBe(0);
    expect(result.total).toBe(0);
    expect(result.indicator.id).toBe('NY.GDP.PCAP.CD');
  });

  /**
   * Upstream emits one message per rejected path segment and never names which,
   * so classification comes from the message count plus an indicator lookup —
   * never from the shape of the caller's own indicator_id.
   */
  it('getData: throws indicator_not_found when the indicator lookup comes back empty', async () => {
    mockResponse(WB_ERROR_BODY);
    mockResponse(WB_ERROR_BODY); // /indicator/{id} rejects it too
    const ctx = createMockContext();
    await expect(
      service.getData({ indicatorId: 'NY.INVALID.CD', countries: 'US', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'indicator_not_found' } });
  });

  it('getData: throws country_not_found when the indicator resolves', async () => {
    mockResponse(WB_ERROR_BODY);
    mockResponse([pagingObj(), [rawIndicator('SP.POP.TOTL', 'Population, total')]]);
    const ctx = createMockContext();
    await expect(
      service.getData({ indicatorId: 'SP.POP.TOTL', countries: 'ZZ', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'country_not_found' } });
  });

  it('getData: blames a malformed indicator ID regardless of its casing', async () => {
    // Casing used to decide the reason: an ID failing /^[A-Z]{2}\.[A-Z.]+$/ was
    // blamed on the country. Only the upstream lookup decides now.
    mockResponse(WB_ERROR_BODY);
    mockResponse(WB_ERROR_BODY); // /indicator/invalid_id rejects it
    const ctx = createMockContext();
    await expect(
      service.getData({ indicatorId: 'invalid_id', countries: 'US', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'indicator_not_found' } });
  });

  it('getData: throws indicator_and_country_not_found on a two-message envelope', async () => {
    mockResponse([
      {
        message: [
          { id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' },
          { id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' },
        ],
      },
    ]);
    const ctx = createMockContext();
    await expect(
      service.getData(
        { indicatorId: 'NOT.A.REAL.CODE', countries: 'ZZZ', page: 1, perPage: 50 },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'indicator_and_country_not_found' } });
    // Two bad segments are self-evident — no disambiguating lookup is spent.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  // ─── getData: requested date window ───────────────────────────────────────

  it('getData: reports no observations when upstream ignores a zero-overlap date_range', async () => {
    // Upstream discards a non-overlapping filter and returns the whole series.
    const series = [
      rawDataPoint('KE', 'KEN', 'Kenya', '2025', 57532493),
      rawDataPoint('KE', 'KEN', 'Kenya', '2024', 56432944),
    ];
    mockResponse([pagingObj({ total: 66, pages: 14 }), series]);
    mockResponse([pagingObj({ total: 66, pages: 1 }), series]); // exhaustive re-read
    const ctx = createMockContext();
    const result = await service.getData(
      {
        indicatorId: 'SP.POP.TOTL',
        countries: 'KEN',
        dateRange: '1850:1900',
        page: 1,
        perPage: 50,
      },
      ctx,
    );
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pages).toBe(1);
    expect(result.dateFilterDropped).toBe(true);
    expect(result.indicator).toMatchObject({ id: 'SP.POP.TOTL', name: 'Population, total' });
    // No aggregate listing is fetched for an empty result.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: returns every row of a partially-overlapping date_range', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawDataPoint('KE', 'KEN', 'Kenya', '1961', 7987770),
        rawDataPoint('KE', 'KEN', 'Kenya', '1960', 7695307),
      ],
    ]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      {
        indicatorId: 'SP.POP.TOTL',
        countries: 'KEN',
        dateRange: '1950:1965',
        page: 1,
        perPage: 50,
      },
      ctx,
    );
    expect(result.data.map((d) => d.date)).toEqual(['1961', '1960']);
    expect(result.total).toBe(2);
    expect(result.dateFilterDropped).toBe(false);
  });

  /**
   * A year window is finer than upstream applies to a quarterly series: it
   * discards the filter and pages the whole series newest-first, so the matches
   * sit past page 1 and upstream's totals describe the unfiltered series.
   */
  const QUARTERS = ['2023Q1', '2022Q4', '2021Q3', '2021Q1', '2020Q2'];

  function mockDroppedQuarterlySeries(firstPage: string[]) {
    const rows = QUARTERS.map((date) => rawDataPoint('US', 'USA', 'United States', date, 1));
    mockResponse([
      pagingObj({ total: 5, pages: 3 }),
      rows.filter((r) => firstPage.includes(r.date)),
    ]);
    mockResponse([pagingObj({ total: 5, pages: 1 }), rows]); // exhaustive re-read
  }

  it('getData: recovers in-window observations upstream dropped past the first page', async () => {
    mockDroppedQuarterlySeries(['2023Q1', '2022Q4']);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2021', page: 1, perPage: 2 },
      ctx,
    );
    expect(result.data.map((d) => d.date)).toEqual(['2021Q3', '2021Q1']);
    expect(result.total).toBe(3);
    expect(result.pages).toBe(2);
    expect(result.dateFilterDropped).toBe(true);
  });

  it('getData: paginates the matched window, not the series upstream returned', async () => {
    mockDroppedQuarterlySeries(['2021Q3', '2021Q1']);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2021', page: 2, perPage: 2 },
      ctx,
    );
    expect(result.data.map((d) => d.date)).toEqual(['2020Q2']);
    expect(result.total).toBe(3);
    expect(result.page).toBe(2);
    expect(result.pages).toBe(2);
  });

  it.each([
    ['2020Q2', ['2020Q2'], ['2020Q1', '2020Q3']],
    ['2020Q2:2020Q3', ['2020Q2', '2020Q3'], ['2020Q1', '2020Q4']],
    ['2020M04', ['2020M04'], ['2020M03', '2020M05']],
    ['2020M12', ['2020Q4'], ['2021Q1']],
    ['2020M01', ['2020Q1'], ['2019Q4']],
    ['2020', ['2020Q4', '2020M01'], ['2019Q4', '2021M01']],
  ])(
    'getData: matches window %s against its own period boundaries',
    async (dateRange, inside, outside) => {
      const rows = [...inside, ...outside].map((date) =>
        rawDataPoint('US', 'USA', 'United States', date, 1),
      );
      // Upstream ignores a window it can't apply and hands back the whole series.
      mockResponse([pagingObj({ total: rows.length, pages: 2 }), rows]);
      mockResponse([pagingObj({ total: rows.length, pages: 1 }), rows]);
      mockAggregateLookup();
      const ctx = createMockContext();
      const result = await service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange, page: 1, perPage: 50 },
        ctx,
      );
      expect(result.data.map((d) => d.date).sort()).toEqual([...inside].sort());
      expect(result.dateFilterDropped).toBe(true);
    },
  );

  it.each([
    ['2020Q1:2021Q4', ['2021Q4', '2020Q1']],
    ['2020M01:2020M06', ['2020M06', '2020M01']],
  ])('getData: leaves an honored %s window untouched', async (dateRange, dates) => {
    mockResponse([
      pagingObj({ total: 2 }),
      dates.map((date) => rawDataPoint('US', 'USA', 'United States', date, 1)),
    ]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange, page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data.map((d) => d.date)).toEqual(dates);
    expect(result.dateFilterDropped).toBe(false);
    // Honored window on one page: the data request and the aggregate listing only.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: joins array of country codes with semicolon and returns every one', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawDataPoint('US', 'USA', 'United States', '2022', 330000000),
        rawDataPoint('DE', 'DEU', 'Germany', '2022', 83000000),
      ],
    ]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: ['US', 'DE'], page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data.map((d) => d.countryIso3)).toEqual(['USA', 'DEU']);
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('US%3BDE'); // URL-encoded semicolon
  });

  it('getData: includes date param when dateRange provided', async () => {
    mockResponse([pagingObj(), [rawDataPoint('US', 'USA', 'United States', '2020', 329000000)]]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2022', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data.map((d) => d.date)).toEqual(['2020']);
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('date=2020%3A2022');
  });

  it('getData: includes mrv param when provided', async () => {
    mockResponse([pagingObj(), [rawDataPoint('US', 'USA', 'United States', '2022', 329000000)]]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', mrv: 3, page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data).toHaveLength(1);
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('mrv=3');
  });

  it('getData: forwards an mrv above the former ceiling of 10', async () => {
    mockResponse([
      pagingObj({ total: 60, pages: 2 }),
      [rawDataPoint('KE', 'KEN', 'Kenya', '2025', 57532493)],
    ]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'KEN', mrv: 60, page: 1, perPage: 50 },
      ctx,
    );
    expect(result.total).toBe(60);
    expect(result.pages).toBe(2);
    expect(fetchWithTimeoutMock.mock.calls[0][0] as string).toContain('mrv=60');
  });

  it('getData: preserves obsStatus in normalized data point', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 1 }),
          [
            {
              indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP per capita' },
              country: { id: 'US', value: 'United States' },
              countryiso3code: 'USA',
              date: '2020',
              value: 63000,
              obs_status: 'E',
            },
          ],
        ]),
    });
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'NY.GDP.PCAP.CD', countries: 'US', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data[0].obsStatus).toBe('E');
  });
});

// ─── Accessor guard ───────────────────────────────────────────────────────────

describe('getWorldBankApiService — not initialized guard', () => {
  it('throws when called before initWorldBankApiService', async () => {
    // Use isolated module to avoid contamination with the global _service
    vi.resetModules();
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    expect(() => getWorldBankApiService()).toThrow('not initialized');
  });
});
