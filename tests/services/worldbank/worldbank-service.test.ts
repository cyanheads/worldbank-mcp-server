/**
 * @fileoverview Tests for WorldBankApiService — normalization, error detection,
 * and service-level behavior including HTML-error detection, WbErrorEnvelope
 * detection, no-data throws, aggregate classification, and client-side filtering.
 * @module tests/services/worldbank/worldbank-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
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
  return {} as ConstructorParameters<
    typeof import('@/services/worldbank/worldbank-service.js')['WorldBankApiService']
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

/** The XHTML page upstream answers a malformed path with, as captured into an HTTP error. */
const UPSTREAM_404_PAGE =
  '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html><body>404 - File or directory not found.</body></html>';

/**
 * The error the framework's `fetchWithTimeout` throws for a non-OK status: the
 * status-mapped code, the redacted URL in the message, and the captured body
 * under both its canonical and legacy field names.
 */
function upstreamHttpError(status: number, path: string) {
  const code = status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.ServiceUnavailable;
  return new McpError(
    code,
    `Fetch failed for https://api.worldbank.org/v2${path}?…. Status: ${status}`,
    {
      status,
      statusText: status === 404 ? 'Not Found' : 'Service Unavailable',
      body: UPSTREAM_404_PAGE,
      statusCode: status,
      responseBody: UPSTREAM_404_PAGE,
      errorSource: 'FetchHttpError',
    },
  );
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

  /**
   * `/indicator/{id}` also takes collection selectors: `all` answers the first
   * page of the whole catalog. A lookup is single only when every row shares
   * one ID — row count alone would reject the dual-source IDs above.
   */
  it('getIndicator: rejects a selector that resolves to more than one indicator ID', async () => {
    mockResponse([
      pagingObj({ total: 29544, pages: 591 }),
      [
        rawIndicatorFrom('1.1_YOUTH.LITERACY.RATE', 'Literacy rate, youth', '34', 'GPE'),
        rawIndicatorFrom('1.0.HCount.1.90usd', 'Poverty Headcount ($1.90 a day)', '37', 'LAC'),
        rawIndicatorFrom('1.0.HCount.1.90usd', 'Poverty Headcount ($1.90 a day)', '99', 'Archive'),
      ],
    ]);
    const ctx = createMockContext();
    const err = await service.getIndicator('all', ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'multiple_indicators',
        indicatorId: 'all',
        matchedIds: ['1.1_YOUTH.LITERACY.RATE', '1.0.HCount.1.90usd'],
      },
    });
    expect((err as McpError).message).toContain('"all"');
    expect((err as McpError).message).toContain('worldbank_search_indicators');
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

  // ─── Provider markup in sourceNote ────────────────────────────────────────

  /** Live `/indicator/SE.PRM.INPT` source note, verbatim — a `</br>` inside a dash list. */
  const SE_PRM_INPT_NOTE =
    'School survey.  Total score is the sum of whether a school has:   , Functional blackboard    - Pens, pencils, exercise books </br> - Textbooks   - Fraction of students in class with a desk    - Used ICT in class and have access to ICT in the school.';

  /** Live `/indicator/SE.PRM.TSUP` source note, verbatim — a `<br>` before its last item. */
  const SE_PRM_TSUP_NOTE =
    'School survey.  Our teaching support indicator asks teachers about participation and the experience with several types of formal/informal training:      Pre,Service (Induction) Training:   - 0.5 Points. Had a pre-service training   - 0.5 Points.  Teacher reported receiving usable skills from training      Teacher practicum (teach a class with supervision)   - 0.5 Points. Teacher participated in a practicum   - 0.5 Points.  Practicum lasted more than 3 months and teacher spent more than one hour per day teaching to students.     In-Service Training:   - 0.5 Points. Had an in-service training   - 0.25 Points. In-service training lasted more than 2 total days   - 0.125 Points. More than 25% of the in-service training was done in the classroom.   - 0.125 Points. More than 50% of the in-service training was done in the classroom.     Opportunities for teachers to come together to share ways of improving teaching: <br>  - 1 Point if such opportunities exist.';

  function rawWithNote(id: string, sourceNote: string) {
    return { ...rawIndicatorFrom(id, 'Basic Inputs', '12', 'Education Statistics'), sourceNote };
  }

  it('getIndicator: turns a provider break tag into a line break, keeping both sides', async () => {
    mockResponse([pagingObj(), [rawWithNote('SE.PRM.INPT', SE_PRM_INPT_NOTE)]]);
    const ctx = createMockContext();
    const result = await service.getIndicator('SE.PRM.INPT', ctx);
    expect(result.sourceNote).toBe(
      'School survey.  Total score is the sum of whether a school has:   , Functional blackboard    - Pens, pencils, exercise books\n- Textbooks   - Fraction of students in class with a desk    - Used ICT in class and have access to ICT in the school.',
    );
  });

  it('searchIndicators: cleans the same markup on the search path', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [rawWithNote('SE.PRM.INPT', SE_PRM_INPT_NOTE), rawWithNote('SE.PRM.TSUP', SE_PRM_TSUP_NOTE)],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'school survey', page: 1, perPage: 50 },
      ctx,
    );
    const notes = result.indicators.map((i) => i.sourceNote);
    expect(notes.every((note) => !/<\/?br/i.test(note))).toBe(true);
    expect(notes[0]).toContain('exercise books\n- Textbooks');
    expect(notes[1]).toMatch(/improving teaching:\n- 1 Point if such opportunities exist\.$/);
  });

  it('getIndicator: strips other tags without their text and decodes entities', async () => {
    mockResponse([
      pagingObj(),
      [
        rawWithNote(
          'X.TEST',
          '<p>Share of <b>adults</b> &amp; youth<br/>aged &lt;15 &#8211; &#x2014; see &quot;Notes&quot;</p>',
        ),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.getIndicator('X.TEST', ctx);
    expect(result.sourceNote).toBe('Share of adults & youth\naged <15 – — see "Notes"');
  });

  /**
   * 29,542 of the 29,544 catalog entries carry no markup; their prose includes
   * literal angle brackets (`<$2.15 a day`, `<-2 standard deviations`) and raw
   * newline runs, all of which must come through byte-identical.
   */
  it('getIndicator: leaves a note without markup byte-identical', async () => {
    const note =
      'Share below the poverty line (<$2.15 a day).\n\n\nStunting is height <-2 standard deviations from the median; 5 > 3.';
    mockResponse([pagingObj(), [rawWithNote('SI.POV.TEST', note)]]);
    const ctx = createMockContext();
    const result = await service.getIndicator('SI.POV.TEST', ctx);
    expect(result.sourceNote).toBe(note);
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

  /**
   * `/country/{code}` resolves `USA;CAN` to both countries (Canada first) and
   * `all` to the whole listing (Aruba first). Taking the first row answered a
   * different entity than the one asked for, with no sign anything was dropped.
   */
  it.each([
    ['USA;CAN', [rawCountry('CAN', 'Canada'), rawCountry('USA', 'United States')], ['CAN', 'USA']],
    [
      'all',
      [rawCountry('ABW', 'Aruba'), rawCountry('AFE', 'Africa Eastern and Southern', true)],
      ['ABW', 'AFE'],
    ],
  ])(
    'getCountry: rejects %j, which resolves to more than one country',
    async (countryCode, rows, matchedIds) => {
      mockResponse([pagingObj({ total: rows.length }), rows]);
      const ctx = createMockContext();
      const err = await service.getCountry(countryCode, ctx).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'multiple_countries', countryCode, matchedIds },
      });
      expect((err as McpError).message).toContain(`"${countryCode}"`);
      expect((err as McpError).message).toContain('worldbank_list_countries');
    },
  );

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
    expect(result.countries[0]?.id).toBe('US');
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
    expect(result.countries[0]?.id).toBe('JP');
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
    const url = fetchWithTimeoutMock.mock.calls[0]?.[0] as string;
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
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).not.toContain('searchterm');
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
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).toContain('/topic/4/indicator');
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
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).toContain('source=2');
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
    const url = fetchWithTimeoutMock.mock.calls[0]?.[0] as string;
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

  // ─── searchIndicators: queries with no searchable terms ───────────────────

  /**
   * Matching ignores every character that isn't a letter or digit, so a query
   * made only of punctuation has no term to match. Treated as "no filter" it
   * returned the whole scope while the response echoed the query as applied.
   */
  it.each([['!!!'], ['???'], ['...'], ['---'], ['%'], ['()'], ['$ ( ) %']])(
    'searchIndicators: rejects the punctuation-only query %j before fetching anything',
    async (query) => {
      const ctx = createMockContext();
      await expect(
        service.searchIndicators({ query, page: 1, perPage: 50 }, ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'empty_query', query },
      });
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['source', { sourceId: '2' }],
    ['topic', { topicId: '3' }],
  ])('searchIndicators: rejects a punctuation-only query scoped to a %s', async (_label, scope) => {
    const ctx = createMockContext();
    await expect(
      service.searchIndicators({ query: '!!!', ...scope, page: 1, perPage: 1 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'empty_query' } });
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it.each([
    ['GDP (current US$)', ['NY.GDP.MKTP.CD']],
    ['CO2 emissions', ['EN.GHG.CO2.MT.CE.AR5']],
    // Terms "n" and "a" are loose substrings; the whole-phrase hit ranks first.
    ['N/A', ['NA.TEST.IND', 'EN.GHG.CO2.MT.CE.AR5']],
    ['123', ['TEST.123']],
  ])('searchIndicators: keeps matching the punctuated query %j', async (query, expected) => {
    mockResponse([
      pagingObj({ total: 4 }),
      [
        rawIndicator('NY.GDP.MKTP.CD', 'GDP (current US$)'),
        rawIndicator('EN.GHG.CO2.MT.CE.AR5', 'Carbon dioxide (CO2) emissions'),
        rawIndicator('NA.TEST.IND', 'Coverage (N/A where unreported)'),
        rawIndicator('TEST.123', 'Series 123'),
      ],
    ]);
    const ctx = createMockContext();
    const result = await service.searchIndicators({ query, page: 1, perPage: 50 }, ctx);
    expect(result.indicators.map((i) => i.id)).toEqual(expected);
  });

  // ─── searchIndicators: topic and source together ──────────────────────────

  /**
   * Upstream fake for `/topic/{id}/indicator`, which honors `source` the way
   * `/indicator` does: it intersects the two scopes and rejects an unknown
   * source ID with the id-120 envelope. Topic 3 carries rows from sources 37
   * and 6; only source 6 rows survive `source=6`.
   */
  function mockTopicEndpoint() {
    const topicRows = [
      rawIndicatorFrom('6.0.GDP_current', 'GDP (current $)', '37', 'LAC Equity Lab'),
      rawIndicatorFrom('BM.GSR.TOTL.CD', 'Imports of goods and services', '6', 'IDS'),
    ];
    fetchWithTimeoutMock.mockImplementationOnce(async (url: string) => {
      const source = new URL(url).searchParams.get('source');
      const body =
        source === '999999'
          ? WB_ERROR_BODY
          : (() => {
              const rows = source ? topicRows.filter((row) => row.source.id === source) : topicRows;
              return [pagingObj({ total: rows.length }), rows];
            })();
      return { text: async () => JSON.stringify(body) };
    });
  }

  it('searchIndicators: topic-only path sends no source param', async () => {
    mockTopicEndpoint();
    const ctx = createMockContext();
    const result = await service.searchIndicators({ topicId: '3', page: 1, perPage: 50 }, ctx);
    const url = new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/v2/topic/3/indicator');
    expect(url.searchParams.has('source')).toBe(false);
    expect(result.total).toBe(2);
  });

  it('searchIndicators: topic+source path applies the source on the topic endpoint', async () => {
    mockTopicEndpoint();
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { topicId: '3', sourceId: '6', page: 1, perPage: 50 },
      ctx,
    );
    const url = new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/v2/topic/3/indicator');
    expect(url.searchParams.get('source')).toBe('6');
    expect(result.indicators.map((i) => i.sourceId)).toEqual(['6']);
    expect(result.total).toBe(1);
  });

  it('searchIndicators: topic+source+keyword matches only within the intersection', async () => {
    mockTopicEndpoint();
    const ctx = createMockContext();
    const result = await service.searchIndicators(
      { query: 'GDP', topicId: '3', sourceId: '6', page: 1, perPage: 50 },
      ctx,
    );
    expect(
      new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).searchParams.get('source'),
    ).toBe('6');
    // The GDP row belongs to source 37, outside the requested source.
    expect(result.indicators).toEqual([]);
    expect(result.total).toBe(0);
  });

  it.each([
    ['without a keyword', undefined],
    ['with a keyword', 'gdp'],
  ])(
    'searchIndicators: throws invalid_filter for an unknown source alongside a valid topic (%s)',
    async (_label, query) => {
      mockTopicEndpoint();
      const ctx = createMockContext();
      await expect(
        service.searchIndicators(
          { ...(query && { query }), topicId: '3', sourceId: '999999', page: 1, perPage: 50 },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'invalid_filter', topicId: '3', sourceId: '999999' },
      });
    },
  );

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
    expect(result.indicators[0]?.topics).toHaveLength(1);
    expect(result.indicators[0]?.topics[0]?.id).toBe('3');
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
      expect(second.data[0]?.isAggregate).toBe(true);
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
    expect(first.data[0]?.isAggregate).toBe(true);
    expect(second.data[0]?.isAggregate).toBe(true);
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

  it('getData: spends exactly one catalog lookup to place a single id-120 rejection', async () => {
    mockResponse(WB_ERROR_BODY);
    mockResponse([pagingObj(), [rawIndicator('SP.POP.TOTL', 'Population, total')]]);
    const ctx = createMockContext();
    await expect(
      service.getData({ indicatorId: 'SP.POP.TOTL', countries: 'ZZ', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining('"ZZ"'),
      data: { reason: 'country_not_found', countryCodes: 'ZZ' },
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeoutMock.mock.calls[1]?.[0] as string).toMatch(
      /^https:\/\/api\.worldbank\.org\/v2\/indicator\/SP\.POP\.TOTL\?/,
    );
  });

  it('getData: never consults the catalog on a successful data response', async () => {
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('US', 'USA', 'United States', '2022')]]);
    mockAggregateLookup();
    const ctx = createMockContext();
    await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', page: 1, perPage: 50 },
      ctx,
    );
    const urls = fetchWithTimeoutMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.startsWith('https://api.worldbank.org/v2/indicator/'))).toBe(
      false,
    );
  });

  /**
   * A bad country code is validated before the indicator's servability: live,
   * `/country/ZZZ/indicator/SM.POP.REFG.OR` answers the generic id-120 message,
   * not the id-175 one, so a catalog record under an archived source says
   * nothing about which segment was rejected.
   */
  it.each([
    [
      'catalogued only under an archived source',
      [rawIndicatorFrom('SM.POP.REFG.OR', 'Refugee population', '57', 'WDI Database Archives')],
    ],
    [
      'catalogued under both a live and an archived source',
      [
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '93', 'FPN Datahub Archive'),
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '88', 'Food Prices for Nutrition'),
      ],
    ],
  ])(
    'getData: blames the country code on an id-120 rejection of an indicator %s',
    async (_label, rows) => {
      mockResponse(WB_ERROR_BODY);
      mockResponse([pagingObj({ total: rows.length }), rows]);
      const ctx = createMockContext();
      await expect(
        service.getData(
          { indicatorId: rows[0]?.id ?? '', countries: 'ZZZ', page: 1, perPage: 50 },
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'country_not_found', countryCodes: 'ZZZ' } });
    },
  );

  it('getData: surfaces a failed catalog lookup on an id-120 rejection as unavailable', async () => {
    mockResponse(WB_ERROR_BODY);
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => '<!DOCTYPE html><html><body>503 Service Unavailable</body></html>',
    });
    const ctx = createMockContext();
    const err = await service
      .getData({ indicatorId: 'SP.POP.TOTL', countries: 'ZZ', page: 1, perPage: 50 }, ctx)
      .catch((e: unknown) => e);
    // Without the lookup the one-message envelope cannot be placed, so no reason is guessed.
    expect(err).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect((err as McpError).data?.reason).toBeUndefined();
  });

  // ─── getData: indicators the data endpoint does not serve ─────────────────

  /**
   * The data endpoint answers id 175 ("The indicator was not found. It may have
   * been deleted or archived.") for an indicator the catalog still lists but the
   * endpoint will not serve for any country or date — every WDI Database
   * Archives ID, and several non-archive sources (PEFA, ICP, Food Prices for
   * Nutrition). The country codes are never the cause.
   */
  const WB_NOT_SERVED_BODY = [
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

  it('getData: reports indicator_not_queryable on id 175, naming the catalog source', async () => {
    mockResponse(WB_NOT_SERVED_BODY);
    mockResponse([
      pagingObj(),
      [
        rawIndicatorFrom(
          'SM.POP.REFG.OR',
          'Refugee population by country or territory of origin',
          '57',
          'WDI Database Archives',
        ),
      ],
    ]);
    const ctx = createMockContext();
    const err = await service
      .getData(
        { indicatorId: 'SM.POP.REFG.OR', countries: 'SDN', mrv: 3, page: 1, perPage: 50 },
        ctx,
      )
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'indicator_not_queryable',
        indicatorId: 'SM.POP.REFG.OR',
        sourceNames: ['WDI Database Archives'],
      },
    });
    const { message } = err as McpError;
    expect(message).toContain('SM.POP.REFG.OR');
    expect(message).toContain('WDI Database Archives');
    expect(message).toContain('Refugee population by country or territory of origin');
    expect(message).toContain('worldbank_search_indicators');
    expect(message).not.toContain('SDN');
    expect(message).not.toContain('worldbank_list_countries');
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: reports indicator_not_queryable on id 175 for an ID under a live and an archived source', async () => {
    mockResponse(WB_NOT_SERVED_BODY);
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '93', 'FPN Datahub Archive'),
        rawIndicatorFrom('CoCA_fexp', 'Affordability', '88', 'Food Prices for Nutrition'),
      ],
    ]);
    const ctx = createMockContext();
    const err = await service
      .getData({ indicatorId: 'CoCA_fexp', countries: ['US', 'JP'], page: 1, perPage: 50 }, ctx)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      data: {
        reason: 'indicator_not_queryable',
        sourceNames: ['FPN Datahub Archive', 'Food Prices for Nutrition'],
      },
    });
    expect((err as McpError).message).not.toMatch(/US;JP|"US"|"JP"/);
  });

  it('getData: still reports indicator_not_queryable on id 175 when the catalog lookup fails', async () => {
    mockResponse(WB_NOT_SERVED_BODY);
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => '<!DOCTYPE html><html><body>503 Service Unavailable</body></html>',
    });
    const ctx = createMockContext();
    const err = await service
      .getData({ indicatorId: 'SM.POP.REFG.OR', countries: 'SDN', page: 1, perPage: 50 }, ctx)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'indicator_not_queryable', indicatorId: 'SM.POP.REFG.OR' },
    });
    expect((err as McpError).data?.sourceNames).toBeUndefined();
    expect((err as McpError).message).not.toContain('SDN');
    expect((err as McpError).message).toContain('worldbank_search_indicators');
  });

  it('getData: reports indicator_not_queryable on id 175 when the catalog no longer lists the ID', async () => {
    mockResponse(WB_NOT_SERVED_BODY);
    mockResponse(WB_ERROR_BODY);
    const ctx = createMockContext();
    const err = await service
      .getData({ indicatorId: 'GONE.IND', countries: 'US', page: 1, perPage: 50 }, ctx)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      data: { reason: 'indicator_not_queryable', indicatorId: 'GONE.IND' },
    });
    expect((err as McpError).data?.sourceNames).toBeUndefined();
    expect((err as McpError).message).not.toContain('"US"');
  });

  it('getData: lets a cancellation during the id-175 catalog lookup propagate', async () => {
    const controller = new AbortController();
    mockResponse(WB_NOT_SERVED_BODY);
    const abort = new Error('The operation was aborted');
    fetchWithTimeoutMock.mockImplementationOnce(async () => {
      controller.abort();
      throw abort;
    });
    const ctx = createMockContext({ signal: controller.signal });
    await expect(
      service.getData(
        { indicatorId: 'SM.POP.REFG.OR', countries: 'SDN', page: 1, perPage: 50 },
        ctx,
      ),
    ).rejects.toBe(abort);
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

  // ─── getData: exhausted pages ─────────────────────────────────────────────

  it('getData: reports upstream paging for a page past the end with no date window', async () => {
    mockResponse([pagingObj({ page: 9, pages: 3, total: 125 }), null]);
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', page: 9, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 125, pages: 3, page: 9 });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('getData: skips the re-read when upstream matched nothing under a date window', async () => {
    mockResponse([pagingObj({ total: 0, pages: 0 }), null]);
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 0 });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('getData: keeps an honored window total on a page past the end', async () => {
    const rows = ['2021', '2020'].map((date) => rawDataPoint('US', 'USA', 'United States', date));
    mockResponse([pagingObj({ page: 3, pages: 1, total: 2 }), null]);
    mockResponse([pagingObj({ total: 2, pages: 1 }), rows]); // exhaustive re-read
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2021', page: 3, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 2, pages: 1, page: 3 });
    expect(result.dateFilterDropped).toBe(false);
  });

  it.each([
    // Page 3 is still inside the raw series' page count: upstream returns rows.
    [3, QUARTERS.slice(4)],
    // Page 50 is past the raw series' page count too: upstream returns none.
    [50, []],
  ])(
    'getData: reports the filtered total on page %i when upstream drops the date window',
    async (page, upstreamRows) => {
      const series = QUARTERS.map((date) => rawDataPoint('US', 'USA', 'United States', date));
      mockResponse([
        pagingObj({ page, pages: 3, total: 5 }),
        series.filter((row) => upstreamRows.includes(row.date)),
      ]);
      mockResponse([pagingObj({ total: 5, pages: 1 }), series]); // exhaustive re-read
      const result = await service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2021', page, perPage: 2 },
        createMockContext(),
      );
      // Three quarters fall inside 2020:2021 whichever page was asked for.
      expect(result).toMatchObject({ data: [], total: 3, pages: 2, page });
      expect(result.dateFilterDropped).toBe(true);
      expect(result.indicator).toMatchObject({ id: 'SP.POP.TOTL', name: 'Population, total' });
    },
  );

  it('getData: re-reads a single-page series for page 2 rather than reading it as empty', async () => {
    const series = QUARTERS.map((date) => rawDataPoint('US', 'USA', 'United States', date));
    mockResponse([pagingObj({ page: 2, pages: 1, total: 5 }), null]);
    mockResponse([pagingObj({ total: 5, pages: 1 }), series]); // exhaustive re-read
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2021', page: 2, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 3, pages: 1, page: 2 });
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
    const url = fetchWithTimeoutMock.mock.calls[0]?.[0] as string;
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
    const url = fetchWithTimeoutMock.mock.calls[0]?.[0] as string;
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
    const url = fetchWithTimeoutMock.mock.calls[0]?.[0] as string;
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
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).toContain('mrv=60');
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
    expect(result.data[0]?.obsStatus).toBe('E');
  });

  // ─── Upstream HTTP errors on paths that carry a caller-supplied ID ────────

  /** What a non-OK status looks like once the framework's `fetchWithTimeout` has thrown it. */
  function mockHttpError(status: number, path: string) {
    fetchWithTimeoutMock.mockRejectedValueOnce(upstreamHttpError(status, path));
  }

  /** Leaves every status other than 404 exactly as the framework classified it. */
  it.each([
    [
      'getIndicator',
      '/indicator/NY.GDP.PCAP.CD',
      (ctx: ReturnType<typeof createMockContext>) => service.getIndicator('NY.GDP.PCAP.CD', ctx),
    ],
    [
      'getData',
      '/country/US/indicator/SP.POP.TOTL',
      (ctx: ReturnType<typeof createMockContext>) =>
        service.getData({ indicatorId: 'SP.POP.TOTL', countries: 'US', page: 1, perPage: 50 }, ctx),
    ],
    [
      'searchIndicators (topic)',
      '/topic/3/indicator',
      (ctx: ReturnType<typeof createMockContext>) =>
        service.searchIndicators({ topicId: '3', page: 1, perPage: 50 }, ctx),
    ],
  ])('%s: propagates an upstream 503 unchanged', async (_label, path, run) => {
    const upstream = upstreamHttpError(503, path);
    fetchWithTimeoutMock.mockRejectedValueOnce(upstream);
    await expect(run(createMockContext())).rejects.toBe(upstream);
  });

  it('listTopics: propagates a 404 on its fixed path unchanged', async () => {
    const upstream = upstreamHttpError(404, '/topic');
    fetchWithTimeoutMock.mockRejectedValueOnce(upstream);
    await expect(service.listTopics(createMockContext())).rejects.toBe(upstream);
  });

  it('getCountry: propagates a 404 unchanged', async () => {
    const upstream = upstreamHttpError(404, '/country/USA');
    fetchWithTimeoutMock.mockRejectedValueOnce(upstream);
    await expect(service.getCountry('USA', createMockContext())).rejects.toBe(upstream);
  });

  /**
   * An ID segment that escapes to `/` or `%` makes upstream answer HTTP 404
   * instead of its HTTP-200 invalid-value envelope. The 404 reports the reason
   * the envelope would, and the upstream error page never reaches the caller.
   */
  it('getIndicator: reports an upstream 404 as indicator_not_found without the upstream body', async () => {
    mockHttpError(404, '/indicator/a%2Fb');
    const err = await service.getIndicator('a/b', createMockContext()).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'indicator_not_found', indicatorId: 'a/b' },
    });
    expect(JSON.stringify(err)).not.toContain('XHTML');
    expect((err as McpError).data).not.toHaveProperty('body');
    // The framework logs an expected status at debug rather than error.
    expect(fetchWithTimeoutMock.mock.calls[0]?.[3]).toMatchObject({ expectedStatuses: [404] });
  });

  it('getData: reports an upstream 404 on the indicator segment as indicator_not_found', async () => {
    mockHttpError(404, '/country/US/indicator/a%2Fb');
    mockHttpError(404, '/indicator/a%2Fb'); // the disambiguating catalog lookup 404s too
    const err = await service
      .getData(
        { indicatorId: 'a/b', countries: 'US', mrv: 1, page: 1, perPage: 50 },
        createMockContext(),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'indicator_not_found', indicatorId: 'a/b' },
    });
    expect(JSON.stringify(err)).not.toContain('XHTML');
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: reports an upstream 404 on the country segment as country_not_found', async () => {
    mockHttpError(404, '/country/U%2FS/indicator/SP.POP.TOTL');
    mockResponse([pagingObj(), [rawIndicator('SP.POP.TOTL', 'Population, total')]]);
    const err = await service
      .getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'U/S', page: 1, perPage: 50 },
        createMockContext(),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      data: { reason: 'country_not_found', countryCodes: 'U/S' },
    });
    expect(JSON.stringify(err)).not.toContain('XHTML');
  });

  it.each([
    ['without a keyword', undefined],
    ['with a keyword', 'gdp'],
  ])(
    'searchIndicators: reports an upstream 404 on the topic path as invalid_filter (%s)',
    async (_label, query) => {
      mockHttpError(404, '/topic/a%2Fb/indicator');
      const err = await service
        .searchIndicators(
          { ...(query && { query }), topicId: 'a/b', page: 1, perPage: 50 },
          createMockContext(),
        )
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'invalid_filter', topicId: 'a/b' },
      });
      expect(JSON.stringify(err)).not.toContain('XHTML');
    },
  );
});

// ─── Upstream 404 through the tool and resource contracts ─────────────────────

describe('upstream 404 on a lookup path, end to end', () => {
  beforeEach(async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      apiBaseUrl: 'https://api.worldbank.org/v2',
      defaultPerPage: 50,
      catalogCacheTtlMs: 60_000,
    } as never);
    const { initWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    initWorldBankApiService(makeConfig() as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function rejectNextFetch(status: number, path: string) {
    const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(upstreamHttpError(status, path));
  }

  function textOf(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content.map((block) => block.text ?? '').join('\n');
  }

  it('worldbank_get_indicator carries indicator_not_found and its recovery on both surfaces', async () => {
    await rejectNextFetch(404, '/indicator/NOPE.NOT.SERVED');
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const result = await runToolContract(
      worldbankGetIndicator,
      { indicator_id: 'NOPE.NOT.SERVED' },
      { context: { errors: worldbankGetIndicator.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'indicator_not_found',
          recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
        },
      },
    });
    const text = textOf(result);
    expect(text).toMatch(/Recovery:.*worldbank_search_indicators/);
    expect(JSON.stringify(result)).not.toMatch(/XHTML|Fetch failed/);
  });

  it('worldbank_get_data carries indicator_not_found and its recovery on both surfaces', async () => {
    await rejectNextFetch(404, '/country/US/indicator/NOPE.NOT.SERVED');
    await rejectNextFetch(404, '/indicator/NOPE.NOT.SERVED');
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const result = await runToolContract(
      worldbankGetData,
      { indicator_id: 'NOPE.NOT.SERVED', countries: 'US', mrv: 1 },
      { context: { errors: worldbankGetData.errors } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'indicator_not_found' } },
    });
    expect(textOf(result)).toMatch(/Recovery:.*worldbank_search_indicators/);
    expect(JSON.stringify(result)).not.toMatch(/XHTML|Fetch failed/);
  });

  it('worldbank_search_indicators carries invalid_filter and its recovery on both surfaces', async () => {
    await rejectNextFetch(404, '/topic/99/indicator');
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(
      worldbankSearchIndicators,
      { topic_id: '99' },
      { context: { errors: worldbankSearchIndicators.errors } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'invalid_filter', topicId: '99' } },
    });
    expect(textOf(result)).toMatch(/Recovery:.*worldbank_list_topics/);
    expect(JSON.stringify(result)).not.toMatch(/XHTML|Fetch failed/);
  });

  it('the worldbank://indicator resource carries indicator_not_found with its recovery', async () => {
    await rejectNextFetch(404, '/indicator/NOPE.NOT.SERVED');
    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const err = await Promise.resolve(
      worldbankIndicatorResource.handler({ indicatorId: 'NOPE.NOT.SERVED' }, ctx),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'indicator_not_found',
        recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
      },
    });
    expect(JSON.stringify(err)).not.toMatch(/XHTML|Fetch failed/);
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
