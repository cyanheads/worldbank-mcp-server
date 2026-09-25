/**
 * @fileoverview Tests for WorldBankApiService — normalization, error detection,
 * and service-level behavior including HTML-error detection, WbErrorEnvelope
 * detection, no-data throws, aggregate classification, and client-side filtering.
 * @module tests/services/worldbank/worldbank-service.test
 */

import { readFileSync } from 'node:fs';
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
    // A request no test queued a response for fails rather than resolving to
    // nothing, and a response one test queued but never consumed stays in it.
    fetchWithTimeoutMock.mockReset();
    fetchWithTimeoutMock.mockRejectedValue(new Error('unmocked fetch'));

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

  // ─── lookupCountry ────────────────────────────────────────────────────────

  it('lookupCountry: resolves either identifier, in any case, to both', async () => {
    mockAggregateLookup();
    const ctx = createMockContext();

    const afe = { id: 'AFE', iso2: 'ZH', isAggregate: true };
    await expect(service.lookupCountry('zh', ctx)).resolves.toEqual(afe);
    await expect(service.lookupCountry('AFE', ctx)).resolves.toEqual(afe);
    await expect(service.lookupCountry(' 1w ', ctx)).resolves.toEqual({
      id: 'WLD',
      iso2: '1W',
      isAggregate: true,
    });
    // One listing request serves every lookup.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('lookupCountry: reports whether the entity is an aggregate, by either identifier', async () => {
    mockAggregateLookup();
    const ctx = createMockContext();

    await expect(service.lookupCountry('USA', ctx)).resolves.toMatchObject({
      isAggregate: false,
    });
    await expect(service.lookupCountry('US', ctx)).resolves.toMatchObject({ isAggregate: false });
    await expect(service.lookupCountry('WLD', ctx)).resolves.toMatchObject({ isAggregate: true });
    await expect(service.lookupCountry('zh', ctx)).resolves.toMatchObject({ isAggregate: true });
  });

  it('lookupCountry: answers undefined for a code the listing does not carry', async () => {
    mockAggregateLookup();
    await expect(service.lookupCountry('QQ', createMockContext())).resolves.toBeUndefined();
  });

  // ─── Shared reference loads ───────────────────────────────────────────────

  /**
   * Answer every request with `body` once the returned gate is released, failing
   * early the way the framework's fetch does when the signal it was handed
   * aborts first. Each load here is a single request.
   */
  function heldResponse(body: unknown) {
    const gate = holdOpen(1);
    fetchWithTimeoutMock.mockImplementation(
      async (_url: string, _timeout: number, _ctx: unknown, options?: { signal?: AbortSignal }) => {
        await gate.wait(options?.signal);
        return { text: async () => JSON.stringify(body) };
      },
    );
    return gate;
  }

  const COUNTRY_LISTING = [
    pagingObj({ total: 2 }),
    [rawCountry('USA', 'United States'), rawAggregate('WLD', '1W', 'World')],
  ];
  const CATALOG = [pagingObj(), [rawIndicator('NY.GDP.PCAP.CD', 'GDP per capita')]];

  it('fails only the caller that cancels while a concurrent caller shares the country index load', async () => {
    const gate = heldResponse(COUNTRY_LISTING);
    const cancelled = new AbortController();

    const first = service.lookupCountry('1W', createMockContext({ signal: cancelled.signal }));
    await gate.entered;
    const second = service.lookupCountry('1W', createMockContext());
    cancelled.abort();
    gate.release();

    const [cancelledOutcome, concurrentOutcome] = await Promise.allSettled([first, second]);

    expect(concurrentOutcome).toEqual({
      status: 'fulfilled',
      value: { id: 'WLD', iso2: '1W', isAggregate: true },
    });
    expect(cancelledOutcome).toEqual({ status: 'rejected', reason: cancelled.signal.reason });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('fails only the caller that cancels while a concurrent caller shares the indicator catalog load', async () => {
    const gate = heldResponse(CATALOG);
    const cancelled = new AbortController();
    const search = { query: 'gdp', page: 1, perPage: 10 };

    const first = service.searchIndicators(search, createMockContext({ signal: cancelled.signal }));
    await gate.entered;
    const second = service.searchIndicators(search, createMockContext());
    cancelled.abort();
    gate.release();

    const [cancelledOutcome, concurrentOutcome] = await Promise.allSettled([first, second]);

    expect(concurrentOutcome).toMatchObject({ status: 'fulfilled', value: { total: 1 } });
    expect(cancelledOutcome).toEqual({ status: 'rejected', reason: cancelled.signal.reason });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a reference load every caller abandoned, and serves the next caller from it', async () => {
    const gate = heldResponse(COUNTRY_LISTING);
    const cancelled = new AbortController();

    const abandoned = service.lookupCountry('1W', createMockContext({ signal: cancelled.signal }));
    await gate.entered;
    cancelled.abort();
    await expect(abandoned).rejects.toThrow();

    gate.release();
    await drainMicrotasks();
    await expect(service.lookupCountry('1W', createMockContext())).resolves.toEqual({
      id: 'WLD',
      iso2: '1W',
      isAggregate: true,
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
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

  /** A listing of `countries` economies and `aggregates` aggregates, economies first. */
  function listingOf(countries: number, aggregates: number) {
    const rows = [
      ...Array.from({ length: countries }, (_, i) => rawCountry(`C${i + 1}`, `Country ${i + 1}`)),
      ...Array.from({ length: aggregates }, (_, i) =>
        rawCountry(`A${i + 1}`, `Aggregate ${i + 1}`, true),
      ),
    ];
    return [pagingObj({ total: rows.length, per_page: '10000' }), rows];
  }

  it.each([
    [100, 100],
    [150, 150],
    [300, 150],
  ])(
    'listCountries: asks upstream for per_page=%i as %i entries when including aggregates',
    async (perPage, served) => {
      mockResponse([pagingObj({ total: 295, pages: Math.ceil(295 / served) }), []]);
      const result = await service.listCountries(
        { includeAggregates: true, page: 1, perPage },
        createMockContext(),
      );
      const url = new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string);
      expect(url.searchParams.get('per_page')).toBe(String(served));
      expect(result).toMatchObject({ perPage: served, total: 295 });
    },
  );

  it('listCountries: pages a locally filtered listing at the served size, without skipping or repeating', async () => {
    const pageAt = async (page: number) => {
      mockResponse(listingOf(217, 78));
      return service.listCountries(
        { includeAggregates: false, page, perPage: 300 },
        createMockContext(),
      );
    };
    const pages = [await pageAt(1), await pageAt(2), await pageAt(3)];

    expect(pages.map((p) => p.countries.length)).toEqual([150, 67, 0]);
    expect(pages.map((p) => [p.perPage, p.pages, p.total])).toEqual(
      Array.from({ length: 3 }, () => [150, 2, 217]),
    );
    expect(pages.flatMap((p) => p.countries.map((c) => c.id))).toEqual(
      Array.from({ length: 217 }, (_, i) => `C${i + 1}`),
    );
  });

  /**
   * `/country?lendingType=IDX` as upstream answers it: every entry twice, in
   * adjacent identical objects, and both copies counted in `paging.total`
   * (118 rows, 59 countries on 2026-09-25).
   */
  function doubledLendingListing() {
    const rows = ['AFG', 'BDI', 'BEN'].flatMap((id) => {
      const row = { ...rawCountry(id, id), lendingType: { id: 'IDX', value: 'IDA' } };
      return [row, { ...row }];
    });
    return [pagingObj({ total: rows.length, per_page: '10000' }), rows];
  }

  it.each([false, true])(
    'listCountries: sends lendingType and counts each doubled entry once (include_aggregates=%s)',
    async (includeAggregates) => {
      mockResponse(doubledLendingListing());
      const result = await service.listCountries(
        { lendingType: 'IDX', includeAggregates, page: 2, perPage: 2 },
        createMockContext(),
      );

      const url = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
      expect(url.searchParams.get('lendingType')).toBe('IDX');
      // Upstream paging double-counts, so the whole scope is fetched and paged here.
      expect(url.searchParams.get('per_page')).toBe('10000');
      expect(url.searchParams.get('page')).toBe('1');
      expect(result.countries.map((c) => c.id)).toEqual(['BEN']);
      expect(result).toMatchObject({ total: 3, page: 2, pages: 2 });
    },
  );

  it('listCountries: combines lendingType with region and incomeLevel upstream', async () => {
    mockResponse([pagingObj({ total: 0 }), []]);
    const result = await service.listCountries(
      {
        region: 'NAC',
        incomeLevel: 'LIC',
        lendingType: 'IDX',
        includeAggregates: false,
        page: 1,
        perPage: 50,
      },
      createMockContext(),
    );

    const params = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).searchParams;
    expect(params.get('region')).toBe('NAC');
    expect(params.get('incomeLevel')).toBe('LIC');
    expect(params.get('lendingType')).toBe('IDX');
    expect(result).toMatchObject({ countries: [], total: 0, pages: 1 });
  });

  it.each([false, true])(
    'listCountries: sends no lendingType when none is asked for (include_aggregates=%s)',
    async (includeAggregates) => {
      mockResponse([pagingObj({ total: 1 }), [rawCountry('US', 'United States')]]);
      await service.listCountries({ includeAggregates, page: 1, perPage: 50 }, createMockContext());

      const url = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
      expect(url.searchParams.has('lendingType')).toBe(false);
    },
  );

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
    // Exact name first, then the name starting with the phrase, then the one holding it later on.
    expect(byName.indicators.map((i) => i.id)).toEqual([
      'NY.GDP.MKTP.CD',
      'NY.GDP.MKTP.CD.XD',
      'NV.SRV.DISC.CD',
    ]);
  });

  // ─── searchIndicators: ranking within a tier ──────────────────────────────

  /**
   * Every catalog row whose ID or name holds all the terms of one of the ranking
   * queries, in catalog order, as captured 2026-09-25. ID and name alone decide
   * the tiers these queries reach, so the fixture leaves notes out.
   */
  const RANKING_CATALOG = (
    JSON.parse(
      readFileSync(
        new URL('../../fixtures/indicator-ranking-catalog.json', import.meta.url),
        'utf8',
      ),
    ) as { rows: Array<{ id: string; name: string; source: { id: string; value: string } }> }
  ).rows.map((row) => ({ ...row, sourceNote: '', topics: [] }));

  async function searchRankingCatalog(query: string, page = 1, perPage = 50) {
    mockResponse([pagingObj({ total: RANKING_CATALOG.length }), RANKING_CATALOG]);
    return service.searchIndicators({ query, page, perPage }, createMockContext());
  }

  it.each([
    ['GDP per capita', ['NY.GDP.PCAP.CD', 'NY.GDP.PCAP.CN', 'NY.GDP.PCAP.KD']],
    ['life expectancy', ['SP.DYN.LE00.IN', 'SP.DYN.LE00.FE.IN', 'SP.DYN.LE00.MA.IN']],
    ['CO2 emissions per capita', ['EN.GHG.CO2.PC.CE.AR5', 'EN.ATM.CO2E.PC', 'EN.ATM.METH.PC']],
  ])('searchIndicators: ranks the WDI series first for %j over the catalog', async (query, top) => {
    const result = await searchRankingCatalog(query);
    expect(result.indicators.slice(0, 3).map((i) => i.id)).toEqual(top);
  });

  it.each([
    ['GDP (current US$)', 'NY.GDP.MKTP.CD'],
    ['NY.GDP.MKTP.CD', 'NY.GDP.MKTP.CD'],
  ])('searchIndicators: keeps the exact match %j first over the catalog', async (query, first) => {
    const result = await searchRankingCatalog(query);
    expect(result.indicators[0]?.id).toBe(first);
  });

  it.each(['GDP per capita', 'life expectancy', 'CO2 emissions per capita'])(
    'searchIndicators: reorders %j without adding, dropping, repeating, or skipping an ID',
    async (query) => {
      const terms = query.toLowerCase().split(' ');
      const ids = new Set(
        RANKING_CATALOG.filter((row) =>
          terms.every((term) => `${row.id} ${row.name}`.toLowerCase().includes(term)),
        ).map((row) => row.id),
      );
      const whole = await searchRankingCatalog(query, 1, 100);
      expect(whole.total).toBe(ids.size);
      expect(new Set(whole.indicators.map((i) => i.id))).toEqual(ids);

      const walked: string[] = [];
      for (let page = 1; page <= Math.ceil(whole.total / 7); page++) {
        walked.push(...(await searchRankingCatalog(query, page, 7)).indicators.map((i) => i.id));
      }
      expect(walked).toEqual(whole.indicators.map((i) => i.id));
    },
  );

  it('searchIndicators: ranks a name starting with the phrase ahead of one holding it later', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('SE.SCH.LIFE', 'School life expectancy, primary to tertiary (years)'),
        rawIndicatorFrom('X.LE', 'Life expectancy at birth (years)', '12', 'Education Statistics'),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'life expectancy', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['X.LE', 'SE.SCH.LIFE']);
  });

  it('searchIndicators: reads "starts with the phrase" at a word boundary, so trade does not lift Trademark', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('IP.TMK.NRCT', 'Trademark applications, nonresident, by count'),
        rawIndicator('NE.TRD.GNFS.ZS', 'Trade (% of GDP)'),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'trade', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['NE.TRD.GNFS.ZS', 'IP.TMK.NRCT']);
  });

  it('searchIndicators: lets the last word of the phrase start a name in its plural', async () => {
    mockResponse([
      pagingObj({ total: 3 }),
      [
        rawIndicator('X.BAL', 'Balance of export and import values'),
        rawIndicator('BX.GSR.GNFS.CD', 'Exports of goods and services (BoP, current US$)'),
        rawIndicator('GC.TAX.EXPT.CN', 'Taxes on exports (current LCU)'),
      ],
    ]);
    const exportHits = await service.searchIndicators(
      { query: 'export', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(exportHits.indicators[0]?.id).toBe('BX.GSR.GNFS.CD');

    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator('X.SYN', 'Syntax errors in tax filings'),
        rawIndicator('GC.TAX.EXPT.CN', 'Taxes on exports (current LCU)'),
      ],
    ]);
    const taxHits = await service.searchIndicators(
      { query: 'tax', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(taxHits.indicators[0]?.id).toBe('GC.TAX.EXPT.CN');
  });

  it('searchIndicators: ranks a whole-word match ahead of one whose term only sits inside a word', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicator(
          'EN.GHG.ALL.PC.CE.AR5',
          'Total greenhouse gas emissions excluding LULUCF per capita (t CO2e/capita)',
        ),
        rawIndicator(
          'EN.GHG.CO2.PC.CE.AR5',
          'Carbon dioxide (CO2) emissions excluding LULUCF per capita (t CO2e/capita)',
        ),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'CO2 emissions per capita', page: 1, perPage: 50 },
      createMockContext(),
    );
    // "co2" is a whole word of the second name only; the first holds it just inside "CO2e".
    expect(result.indicators.map((i) => i.id)).toEqual([
      'EN.GHG.CO2.PC.CE.AR5',
      'EN.GHG.ALL.PC.CE.AR5',
    ]);
  });

  it('searchIndicators: orders a tier WDI first, then other live sources, then archives, then catalog order', async () => {
    mockResponse([
      pagingObj({ total: 5 }),
      [
        rawIndicatorFrom('A.ARCHIVE', 'Road density index', '57', 'WDI Database Archives'),
        rawIndicatorFrom('B.LIVE', 'Road density index', '37', 'LAC Equity Lab'),
        rawIndicatorFrom('C.WDI', 'Road density index', '2', 'World Development Indicators'),
        rawIndicatorFrom('D.LIVE', 'Road density index', '12', 'Education Statistics'),
        rawIndicatorFrom('E.WDI', 'Road density index', '2', 'World Development Indicators'),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'road density', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.indicators.map((i) => i.id)).toEqual([
      'C.WDI',
      'E.WDI',
      'B.LIVE',
      'D.LIVE',
      'A.ARCHIVE',
    ]);
  });

  /**
   * World Bank IDs mark a breakdown with an extra segment (`.RU`, `.FE`, `.Q1`), so
   * of one series family — the same first three segments — the shorter ID is the
   * whole population. Catalog order lists the rural and urban series first, which
   * led `access to electricity` with the rural rate.
   */
  it('searchIndicators: ranks a series ahead of its disaggregated siblings, within its tier and source', async () => {
    mockResponse([
      pagingObj({ total: 6 }),
      [
        rawIndicator('EG.ELC.ACCS.RU.ZS', 'Access to electricity, rural (% of rural population)'),
        rawIndicator('EG.ELC.RNEW.ZS', 'Access to electricity from renewables (% of total)'),
        rawIndicator('EG.ELC.ACCS.UR.ZS', 'Access to electricity, urban (% of urban population)'),
        rawIndicator('EG.ELC.ACCS.ZS', 'Access to electricity (% of population)'),
        rawIndicatorFrom(
          '1.1_ACCESS.ELECTRICITY.TOT',
          'Access to electricity (% of total population)',
          '35',
          'Sustainable Energy for All',
        ),
        // Same family, but it holds the phrase only later on, so it stays in its own tier.
        rawIndicator('EG.ELC.ACCS.FE.ZS', 'Households with access to electricity, female head (%)'),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'access to electricity', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.indicators.map((i) => i.id)).toEqual([
      'EG.ELC.ACCS.ZS',
      'EG.ELC.ACCS.RU.ZS',
      'EG.ELC.ACCS.UR.ZS',
      'EG.ELC.RNEW.ZS',
      '1.1_ACCESS.ELECTRICITY.TOT',
      'EG.ELC.ACCS.FE.ZS',
    ]);
    expect(result.total).toBe(6);
  });

  it('searchIndicators: orders the description-only tier by source too, after every ID/name hit', async () => {
    mockResponse([
      pagingObj({ total: 3 }),
      [
        {
          ...rawIndicatorFrom('A.NOTE', 'Pump price', '57', 'WDI Database Archives'),
          sourceNote: 'Price of diesel fuel.',
        },
        {
          ...rawIndicatorFrom('B.NOTE', 'Pump price', '2', 'World Development Indicators'),
          sourceNote: 'Price of diesel fuel.',
        },
        rawIndicatorFrom('C.NAME', 'Diesel stock', '57', 'WDI Database Archives'),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'diesel', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['C.NAME', 'B.NOTE', 'A.NOTE']);
  });

  it('searchIndicators: keeps an exact match first even from an archived source', async () => {
    mockResponse([
      pagingObj({ total: 2 }),
      [
        rawIndicatorFrom('X.WDI', 'Road density index', '2', 'World Development Indicators'),
        rawIndicatorFrom('X.ARC', 'Road density', '57', 'WDI Database Archives'),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'road density', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.indicators.map((i) => i.id)).toEqual(['X.ARC', 'X.WDI']);
  });

  it('searchIndicators: matches a term that appears only far into a description, and returns the note whole', async () => {
    const note = `${'Background on the survey design and coverage. '.repeat(8)}Includes kerosene.`;
    mockResponse([
      pagingObj({ total: 2 }),
      [
        { ...rawIndicator('EG.X', 'Household fuel use'), sourceNote: note },
        rawIndicator('SP.POP.TOTL', 'Population, total'),
      ],
    ]);
    const result = await service.searchIndicators(
      { query: 'kerosene', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(note.indexOf('kerosene')).toBeGreaterThan(150);
    expect(result.indicators.map((i) => i.id)).toEqual(['EG.X']);
    expect(result.indicators[0]?.sourceNote).toBe(note);
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

  it('getData: classifies an aggregate whose data rows carry no ISO3 code, and fills the code in', async () => {
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
    expect(result.data[0]).toMatchObject({
      countryCode: 'XD',
      countryIso3: 'HIC',
      isAggregate: true,
    });
    // The fill reads the listing already fetched for isAggregate: no request is added.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: keeps a non-empty ISO3 as sent, and an empty one the listing cannot place', async () => {
    mockResponse([
      pagingObj({ total: 3 }),
      [
        rawDataPoint('US', 'USA', 'United States', '2022'),
        rawDataPoint('ZH', 'XYZ', 'Africa Eastern and Southern', '2022'),
        rawDataPoint('QQ', '', 'Unlisted', '2022'),
      ],
    ]);
    mockAggregateLookup();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: ['US', 'AFE', 'QQ'], page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.data.map((d) => [d.countryCode, d.countryIso3, d.isAggregate])).toEqual([
      ['US', 'USA', false],
      ['ZH', 'XYZ', true],
      ['QQ', '', false],
    ]);
  });

  it('getData: reports a row whose country.id is an ISO3 code under ISO2 and ISO3', async () => {
    // Global Economic Monitor rows (source 15) name the economy by ISO3 in
    // country.id and leave countryiso3code empty.
    mockResponse([
      pagingObj({ total: 2 }),
      [rawDataPoint('USA', '', 'United States', '2026'), rawDataPoint('WLD', '', 'World', '2026')],
    ]);
    mockAggregateLookup();
    const result = await service.getData(
      { indicatorId: 'CPTOTSAXN', countries: ['US', 'WLD'], page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.data.map((d) => [d.countryCode, d.countryIso3, d.isAggregate])).toEqual([
      ['US', 'USA', false],
      ['1W', 'WLD', true],
    ]);
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

  it('getData: returns empty data (no throw) once the re-read an empty envelope gets matches it', async () => {
    mockResponse([pagingObj({ total: 0 }), null]);
    mockResponse([pagingObj({ total: 0 }), null]);
    const ctx = createMockContext();
    const result = await service.getData(
      {
        indicatorId: 'NY.GDP.PCAP.CD',
        countries: 'US',
        dateRange: '2018:2020',
        page: 1,
        perPage: 50,
      },
      ctx,
    );
    expect(result.data).toHaveLength(0);
    expect(result.nullCount).toBe(0);
    expect(result.total).toBe(0);
    expect(result.indicator.id).toBe('NY.GDP.PCAP.CD');
    // An empty envelope is suspect until a second read at another page size agrees.
    const sizes = fetchWithTimeoutMock.mock.calls.map((c) =>
      new URL(c[0] as string).searchParams.get('per_page'),
    );
    expect(sizes).toEqual(['20000', '19999']);
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
    mockAggregateLookup();
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
    mockAggregateLookup();
    const ctx = createMockContext();
    await expect(
      service.getData(
        { indicatorId: 'NOT.A.REAL.CODE', countries: 'ZZZ', page: 1, perPage: 50 },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'indicator_and_country_not_found' } });
    // Two bad segments are self-evident — no disambiguating catalog lookup is
    // spent; the one further request is the country listing that places the codes.
    const urls = fetchWithTimeoutMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toMatch(/^https:\/\/api\.worldbank\.org\/v2\/country\?/);
  });

  it('getData: spends exactly one catalog lookup to place a single id-120 rejection', async () => {
    mockResponse(WB_ERROR_BODY);
    mockResponse([pagingObj(), [rawIndicator('SP.POP.TOTL', 'Population, total')]]);
    mockAggregateLookup();
    const ctx = createMockContext();
    await expect(
      service.getData({ indicatorId: 'SP.POP.TOTL', countries: 'ZZ', page: 1, perPage: 50 }, ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining('"ZZ"'),
      data: { reason: 'country_not_found', countryCodes: 'ZZ' },
    });
    const urls = fetchWithTimeoutMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toMatch(/^https:\/\/api\.worldbank\.org\/v2\/indicator\/SP\.POP\.TOTL\?/);
    expect(urls[2]).toMatch(/^https:\/\/api\.worldbank\.org\/v2\/country\?/);
  });

  // ─── getData: placing a country rejection on the codes at fault ───────────

  /** Queue an id-120 rejection the catalog lookup places on the country codes. */
  function mockCountryRejection() {
    mockResponse(WB_ERROR_BODY);
    mockResponse([pagingObj(), [rawIndicator('SP.POP.TOTL', 'Population, total')]]);
  }

  it.each([
    [['US', 'ZZ'], 'ZZ'],
    [['US', 'ZZ', 'QQ', 'AFE'], 'ZZ;QQ'],
    [['us', 'zz'], 'zz'],
    ['US;ZZ', 'ZZ'],
  ])(
    'getData: names only the codes of %j the country index lacks, as sent',
    async (countries, blamed) => {
      mockCountryRejection();
      mockAggregateLookup();
      const err = await service
        .getData(
          { indicatorId: 'SP.POP.TOTL', countries, page: 1, perPage: 50 },
          createMockContext(),
        )
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'country_not_found', countryCodes: blamed, indicatorId: 'SP.POP.TOTL' },
      });
      expect((err as McpError).message).toContain(`Country code(s) "${blamed}" not valid`);
    },
  );

  it('getData: narrows the codes on a two-message rejection too', async () => {
    mockResponse([{ message: [WB_ERROR_BODY[0]?.message[0], WB_ERROR_BODY[0]?.message[0]] }]);
    mockAggregateLookup();
    const err = await service
      .getData(
        { indicatorId: 'NOT.A.REAL.CODE', countries: ['US', 'ZZZ'], page: 1, perPage: 50 },
        createMockContext(),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      data: { reason: 'indicator_and_country_not_found', countryCodes: 'ZZZ' },
    });
    expect((err as McpError).message).toContain('country code(s) "ZZZ"');
  });

  it('getData: names the whole list when the index knows every rejected code', async () => {
    mockCountryRejection();
    mockAggregateLookup();
    await expect(
      service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: ['US', 'WLD'], page: 1, perPage: 50 },
        createMockContext(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'country_not_found', countryCodes: 'US;WLD' } });
  });

  it('getData: keeps the rejection, naming the whole list, when the country index fails to load', async () => {
    mockCountryRejection();
    fetchWithTimeoutMock.mockResolvedValueOnce({
      text: async () => '<!DOCTYPE html><html><body>503 Service Unavailable</body></html>',
    });
    const ctx = createMockContext();
    const err = await service
      .getData({ indicatorId: 'SP.POP.TOTL', countries: ['US', 'ZZ'], page: 1, perPage: 50 }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'country_not_found', countryCodes: 'US;ZZ' },
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it('getData: lets a cancellation during the country-index read propagate', async () => {
    const controller = new AbortController();
    mockCountryRejection();
    const abort = new Error('The operation was aborted');
    fetchWithTimeoutMock.mockImplementationOnce(async () => {
      controller.abort(abort);
      throw abort;
    });
    await expect(
      service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: ['US', 'ZZ'], page: 1, perPage: 50 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toBe(abort);
  });

  // ─── getData: Lesotho and the edge firewall ───────────────────────────────

  /** The decoded `{codes}` segment of each data request sent. */
  function sentCountrySegments(): string[] {
    return fetchWithTimeoutMock.mock.calls.flatMap(([url]) => {
      const match = /\/v2\/country\/([^/?]+)\/indicator\//.exec(url as string);
      return match?.[1] ? [decodeURIComponent(match[1])] : [];
    });
  }

  it.each([
    [['ZA', 'LS'], 'ZA;LSO'],
    ['ZAF;LS', 'ZAF;LSO'],
    [['LS', 'ZA'], 'LSO;ZA'],
    [['za', 'ls'], 'za;LSO'],
    ['LS', 'LSO'],
  ])('getData: sends Lesotho in %j as LSO', async (countries, sent) => {
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('LS', 'LSO', 'Lesotho', '2020')]]);
    mockAggregateLookup();
    await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries, page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(sentCountrySegments()).toEqual([sent]);
  });

  it('getData: sends Lesotho as LSO on the widened read mrv falls back to too', async () => {
    // Neither economy holds a value in the window, so mrv reads the whole list over the whole series.
    const inWindow = ['ZA', 'LS'].map((code) => rawDataPoint(code, `${code}X`, code, '2020', null));
    const whole = [
      ...inWindow,
      rawDataPoint('ZA', 'ZAX', 'ZA', '1999', 7),
      rawDataPoint('LS', 'LSX', 'LS', '1999', null),
    ];
    mockResponse([pagingObj({ total: 2 }), inWindow]);
    mockResponse([pagingObj({ total: 4 }), whole]);
    mockAggregateLookup();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: ['ZA', 'LS'], mrv: 1, page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(sentCountrySegments()).toEqual(['ZA;LSO', 'ZA;LSO']);
    expect(result.data.map((d) => `${d.countryCode} ${d.date} ${d.value}`)).toEqual([
      'ZA 1999 7',
      'LS 1999 null',
    ]);
  });

  it('getData: names a rejected list by the codes sent, not the LSO sent for Lesotho', async () => {
    mockCountryRejection();
    mockAggregateLookup();
    const err = await service
      .getData(
        { indicatorId: 'SP.POP.TOTL', countries: ['US', 'LS'], page: 1, perPage: 50 },
        createMockContext(),
      )
      .catch((e: unknown) => e);
    // The listing carries US and not Lesotho, so LS is named — as the caller spelled it.
    expect(err).toMatchObject({ data: { countryCodes: 'LS' } });
    expect((err as McpError).message).not.toContain('LSO');
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
      mockAggregateLookup();
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

  // A catalogued id-175 indicator is served from its catalog source rather than
  // reported; tests/services/worldbank/source-scoped-data.test.ts covers that path.
  // What stays here is the rejection when no catalog source can be resolved.

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
    // Rows outside the window at its own form are suspect until a re-read at
    // another page size returns the same series.
    mockResponse([pagingObj({ total: 2, pages: 1 }), series]);
    mockResponse([pagingObj({ total: 2, pages: 1 }), series]);
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
   * discards the filter and returns the whole series newest-first, so upstream's
   * totals describe the unfiltered series.
   */
  const QUARTERS = ['2023Q1', '2022Q4', '2021Q3', '2021Q1', '2020Q2'];

  function mockDroppedQuarterlySeries() {
    const rows = QUARTERS.map((date) => rawDataPoint('US', 'USA', 'United States', date, 1));
    mockResponse([pagingObj({ total: 5, pages: 1 }), rows]);
  }

  it('getData: keeps the quarters inside a year window upstream dropped, from one request', async () => {
    mockDroppedQuarterlySeries();
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
    // Quarters answering a year window are no sign of another request's body: no re-read.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: paginates the matched window, not the series upstream returned', async () => {
    mockDroppedQuarterlySeries();
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

  // ─── getData: served page size ────────────────────────────────────────────

  /** `count` one-year observations for distinct synthetic countries, `C001` onward. */
  function observations(count: number, date = '2020') {
    return Array.from({ length: count }, (_, i) => {
      const code = `C${String(i + 1).padStart(3, '0')}`;
      return rawDataPoint(code, code, `Country ${i + 1}`, date);
    });
  }

  it.each([
    [50, 50],
    [200, 200],
    [201, 200],
    [1000, 200],
  ])(
    'getData: asks upstream for per_page=%i as %i rows of the whole span, one page',
    async (perPage, served) => {
      mockResponse([
        pagingObj({ total: 450, pages: Math.ceil(450 / served), per_page: served }),
        observations(served),
      ]);
      mockAggregateLookup();
      const result = await service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'all', page: 1, perPage },
        createMockContext(),
      );

      const url = new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string);
      expect(url.searchParams.get('per_page')).toBe(String(served));
      expect(url.searchParams.get('date')).toBe('1900:2100');
      expect(result).toMatchObject({ perPage: served, total: 450 });
      expect(result.data).toHaveLength(served);
    },
  );

  it('getData: reads every upstream page of a window longer than one request', async () => {
    const series = observations(3);
    mockResponse([pagingObj({ page: 1, pages: 2, total: 3 }), series.slice(0, 2)]);
    mockResponse([pagingObj({ page: 2, pages: 2, total: 3 }), series.slice(2)]);
    mockAggregateLookup();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'all', dateRange: '2020', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result.data.map((d) => d.countryCode)).toEqual(['C001', 'C002', 'C003']);
    const pagesSent = fetchWithTimeoutMock.mock.calls
      .slice(0, 2)
      .map((c) => new URL(c[0] as string).searchParams.get('page'));
    expect(pagesSent).toEqual(['1', '2']);
  });

  it('getData: slices a date window at the served size, so pages neither skip nor repeat', async () => {
    const series = observations(450);
    const pageAt = async (page: number) => {
      mockResponse([pagingObj({ total: 450, pages: 1 }), series]);
      // The country listing is read once and cached for the calls after it.
      if (page === 1) mockAggregateLookup();
      return service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'all', dateRange: '2020', page, perPage: 1000 },
        createMockContext(),
      );
    };

    const pages = [await pageAt(1), await pageAt(2), await pageAt(3), await pageAt(4)];
    expect(pages.map((p) => p.data.length)).toEqual([200, 200, 50, 0]);
    expect(pages.map((p) => [p.perPage, p.pages, p.total])).toEqual(
      Array.from({ length: 4 }, () => [200, 3, 450]),
    );
    expect(pages.flatMap((p) => p.data.map((d) => d.countryCode))).toEqual(
      series.map((row) => row.country.id),
    );
  });

  // ─── getData: exhausted pages ─────────────────────────────────────────────

  it("getData: reports upstream's totals for a page past the end with no date window", async () => {
    mockResponse([pagingObj({ page: 9, total: 125, pages: 3 }), null]);
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'all', page: 9, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 125, pages: 3, page: 9 });
    // No country listing is read for a page with no rows on it.
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it('getData: re-reads a date window upstream matched nothing in, once, then reports it empty', async () => {
    mockResponse([pagingObj({ total: 0, pages: 0 }), null]);
    mockResponse([pagingObj({ total: 0, pages: 0 }), null]);
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020', page: 1, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 0 });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: keeps an honored window total on a page past the end', async () => {
    const rows = ['2021', '2020'].map((date) => rawDataPoint('US', 'USA', 'United States', date));
    mockResponse([pagingObj({ total: 2, pages: 1 }), rows]);
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2021', page: 3, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 2, pages: 1, page: 3 });
    expect(result.dateFilterDropped).toBe(false);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it.each([3, 50])(
    'getData: reports the filtered total on page %i when upstream drops the date window',
    async (page) => {
      const series = QUARTERS.map((date) => rawDataPoint('US', 'USA', 'United States', date));
      mockResponse([pagingObj({ total: 5, pages: 1 }), series]);
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

  it('getData: reads the whole window for page 2 of a single-page series rather than reading it as empty', async () => {
    const series = QUARTERS.map((date) => rawDataPoint('US', 'USA', 'United States', date));
    mockResponse([pagingObj({ total: 5, pages: 1 }), series]);
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020:2021', page: 2, perPage: 50 },
      createMockContext(),
    );
    expect(result).toMatchObject({ data: [], total: 3, pages: 1, page: 2 });
    const sent = new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).searchParams;
    expect(sent.get('page')).toBe('1');
  });

  it.each([
    // Rows at the window's own form outside it are suspect until a re-read agrees.
    ['2020Q2', ['2020Q2'], ['2020Q1', '2020Q3'], true],
    ['2020Q2:2020Q3', ['2020Q2', '2020Q3'], ['2020Q1', '2020Q4'], true],
    ['2020M04', ['2020M04'], ['2020M03', '2020M05'], true],
    ['2020M12', ['2020Q4'], ['2021Q1'], false],
    ['2020M01', ['2020Q1'], ['2019Q4'], false],
    ['2020', ['2020Q4', '2020M01'], ['2019Q4', '2021M01'], false],
  ])(
    'getData: matches window %s against its own period boundaries',
    async (dateRange, inside, outside, reread) => {
      const rows = [...inside, ...outside].map((date) =>
        rawDataPoint('US', 'USA', 'United States', date, 1),
      );
      // Upstream ignores a window it can't apply and hands back the whole series.
      mockResponse([pagingObj({ total: rows.length, pages: 1 }), rows]);
      if (reread) mockResponse([pagingObj({ total: rows.length, pages: 1 }), rows]);
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

  /**
   * Upstream's response cache ignores `mrv`, so a request carrying it can be
   * answered with another query's rows; `mrv` goes out as a `date` window and is
   * selected locally.
   */
  it('getData: sends mrv as a date window, never as mrv', async () => {
    mockResponse([
      pagingObj({ total: 3 }),
      ['2024', '2023', '2022'].map((date) => rawDataPoint('US', 'USA', 'United States', date, 3)),
    ]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'US', mrv: 3, page: 1, perPage: 50 },
      ctx,
    );
    expect(result.data.map((d) => d.date)).toEqual(['2024', '2023', '2022']);
    const sent = new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).searchParams;
    expect(sent.has('mrv')).toBe(false);
    expect(sent.get('date')).toBe(`${new Date().getUTCFullYear() - 10}:2100`);
  });

  it('getData: reads an mrv above 10 from a window reaching back that many years', async () => {
    const years = Array.from({ length: 60 }, (_, i) => String(2025 - i));
    mockResponse([
      pagingObj({ total: 60 }),
      years.map((date) => rawDataPoint('KE', 'KEN', 'Kenya', date, 57532493)),
    ]);
    mockAggregateLookup();
    const ctx = createMockContext();
    const result = await service.getData(
      { indicatorId: 'SP.POP.TOTL', countries: 'KEN', mrv: 60, page: 1, perPage: 50 },
      ctx,
    );
    expect(result.total).toBe(60);
    expect(result.pages).toBe(2);
    const sent = new URL(fetchWithTimeoutMock.mock.calls[0]?.[0] as string).searchParams;
    expect(sent.get('date')).toBe(`${new Date().getUTCFullYear() - 60}:2100`);
  });

  // ─── getData: cancellation through the re-read and the widen read ─────────

  /** Abort `controller` from inside the next fetch and fail that fetch with the abort, as fetch does. */
  function abortOnNextFetch(controller: AbortController) {
    const abort = new Error('The operation was aborted');
    fetchWithTimeoutMock.mockImplementationOnce(async () => {
      controller.abort(abort);
      throw abort;
    });
    return abort;
  }

  it('getData: lets a cancellation during the re-read of a suspect read propagate', async () => {
    const controller = new AbortController();
    mockResponse([pagingObj({ total: 0 }), null]); // suspect: an empty envelope
    const abort = abortOnNextFetch(controller);
    await expect(
      service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'US', dateRange: '2020', page: 1, perPage: 50 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toBe(abort);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('getData: lets a cancellation during the widen read propagate', async () => {
    const controller = new AbortController();
    // No value in the window, so mrnev widens to the whole series.
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('ER', 'ERI', 'Eritrea', '2025', null)]]);
    const abort = abortOnNextFetch(controller);
    await expect(
      service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'ER', mrnev: 1, page: 1, perPage: 50 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toBe(abort);
    const widen = new URL(fetchWithTimeoutMock.mock.calls[1]?.[0] as string);
    expect(widen.searchParams.get('date')).toBe('1900:2100');
  });

  it('getData: lets a cancellation during the re-read of a suspect widen read propagate', async () => {
    const controller = new AbortController();
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('ER', 'ERI', 'Eritrea', '2025', null)]]);
    // The widen read lacks the 2025 row the window read returned: suspect.
    mockResponse([pagingObj({ total: 1 }), [rawDataPoint('ER', 'ERI', 'Eritrea', '2011', 688)]]);
    const abort = abortOnNextFetch(controller);
    await expect(
      service.getData(
        { indicatorId: 'SP.POP.TOTL', countries: 'ER', mrnev: 1, page: 1, perPage: 50 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toBe(abort);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
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
    mockAggregateLookup();
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
