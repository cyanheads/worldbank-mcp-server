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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorldBankApiService', () => {
  let fetchWithTimeoutMock: ReturnType<typeof vi.fn>;
  let service: InstanceType<
    typeof import('@/services/worldbank/worldbank-service.js')['WorldBankApiService']
  >;

  beforeEach(async () => {
    const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
    fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);

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

  // ─── searchIndicators ─────────────────────────────────────────────────────

  it('searchIndicators: keyword-only path sends searchterm param', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 1 }),
          [
            {
              id: 'NY.GDP.PCAP.CD',
              name: 'GDP per capita (current US$)',
              source: { id: '2', value: 'World Development Indicators' },
              sourceNote: 'GDP per capita description.',
              topics: [{ id: '3', value: 'Economy & Growth' }],
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.searchIndicators({ query: 'GDP', page: 1, perPage: 50 }, ctx);
    expect(result.indicators).toHaveLength(1);
    expect(result.indicators[0].id).toBe('NY.GDP.PCAP.CD');
    // Verify URL included searchterm
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('searchterm=GDP');
  });

  it('searchIndicators: topic+keyword path filters client-side', async () => {
    // Returns 3 indicators for the topic, only 1 matches the keyword
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 3 }),
          [
            {
              id: 'NY.GDP.PCAP.CD',
              name: 'GDP per capita',
              source: { id: '2', value: 'WDI' },
              sourceNote: 'GDP desc.',
              topics: [{ id: '3', value: 'Economy' }],
            },
            {
              id: 'SP.POP.TOTL',
              name: 'Population, total',
              source: { id: '2', value: 'WDI' },
              sourceNote: 'Population.',
              topics: [{ id: '3', value: 'Economy' }],
            },
            {
              id: 'NY.ADJ.NNTY.PC.CD',
              name: 'Adjusted net national income per capita',
              source: { id: '2', value: 'WDI' },
              sourceNote: 'Adj net.',
              topics: [{ id: '3', value: 'Economy' }],
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'population', topicId: '3', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators).toHaveLength(1);
    expect(result.indicators[0].id).toBe('SP.POP.TOTL');
    expect(result.total).toBe(1);
  });

  it('searchIndicators: source-only path uses source filter param', async () => {
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
              topics: [],
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    await service.searchIndicators({ sourceId: '2', page: 1, perPage: 50 }, ctx);
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('source=2');
  });

  it('searchIndicators: source+keyword path filters client-side', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 2 }),
          [
            {
              id: 'NY.GDP.PCAP.CD',
              name: 'GDP per capita',
              source: { id: '2', value: 'WDI' },
              sourceNote: 'GDP description.',
              topics: [],
            },
            {
              id: 'SP.POP.TOTL',
              name: 'Population, total',
              source: { id: '2', value: 'WDI' },
              sourceNote: 'Population total.',
              topics: [],
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'gdp', sourceId: '2', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.indicators).toHaveLength(1);
    expect(result.indicators[0].id).toBe('NY.GDP.PCAP.CD');
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

  it('getData: classifies known aggregate codes as isAggregate=true', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 1 }),
          [
            {
              indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP per capita' },
              country: { id: 'ZH', value: 'Africa Eastern and Southern' },
              countryiso3code: 'AFE',
              date: '2022',
              value: 1500,
              obs_status: '',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'NY.GDP.PCAP.CD', countries: 'AFE', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data[0].isAggregate).toBe(true);
    expect(result.data[0].countryIso3).toBe('AFE');
  });

  it('getData: classifies WLD as isAggregate=true', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 1 }),
          [
            {
              indicator: { id: 'NY.GDP.PCAP.CD', value: 'GDP per capita' },
              country: { id: '1W', value: 'World' },
              countryiso3code: 'WLD',
              date: '2022',
              value: 12000,
              obs_status: '',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'NY.GDP.PCAP.CD', countries: 'WLD', page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data[0].isAggregate).toBe(true);
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

  it('getData: throws indicator_not_found for WB-format indicator ID on WbErrorEnvelope', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          { message: [{ id: '120', key: 'Invalid indicator', value: 'Not found' }] },
        ]),
    });
    const ctx = createMockContext();
    await expect(
      service.getData({ indicatorId: 'NY.INVALID.CD', countries: 'US', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'indicator_not_found' },
    });
  });

  it('getData: throws country_not_found for non-WB-format indicator on WbErrorEnvelope', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([{ message: [{ id: '120', key: 'Invalid country', value: 'Not found' }] }]),
    });
    const ctx = createMockContext();
    // Lowercase indicator ID doesn't match /^[A-Z]{2}\.[A-Z.]+$/ → country_not_found
    await expect(
      service.getData({ indicatorId: 'invalid_id', countries: 'ZZ', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'country_not_found' },
    });
  });

  it('getData: joins array of country codes with semicolon in URL', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj({ total: 2 }),
          [
            {
              indicator: { id: 'SP.POP.TOTL', value: 'Population' },
              country: { id: 'US', value: 'United States' },
              countryiso3code: 'USA',
              date: '2022',
              value: 330000000,
              obs_status: '',
            },
            {
              indicator: { id: 'SP.POP.TOTL', value: 'Population' },
              country: { id: 'DE', value: 'Germany' },
              countryiso3code: 'DEU',
              date: '2022',
              value: 83000000,
              obs_status: '',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: ['US', 'DE'], page: 1, perPage: 50 },
      ctx,
    );
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('US%3BDE'); // URL-encoded semicolon
  });

  it('getData: includes date param when dateRange provided', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj(),
          [
            {
              indicator: { id: 'SP.POP.TOTL', value: 'Population' },
              country: { id: 'US', value: 'United States' },
              countryiso3code: 'USA',
              date: '2020',
              value: 329000000,
              obs_status: '',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2022', page: 1, perPage: 50 },
      ctx,
    );
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('date=2020%3A2022');
  });

  it('getData: includes mrv param when provided', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify([
          pagingObj(),
          [
            {
              indicator: { id: 'SP.POP.TOTL', value: 'Population' },
              country: { id: 'US', value: 'United States' },
              countryiso3code: 'USA',
              date: '2022',
              value: 329000000,
              obs_status: '',
            },
          ],
        ]),
    });
    const ctx = createMockContext();
    await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', mrv: 3, page: 1, perPage: 50 },
      ctx,
    );
    const url = fetchWithTimeoutMock.mock.calls[0][0] as string;
    expect(url).toContain('mrv=3');
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
