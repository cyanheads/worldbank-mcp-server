/**
 * @fileoverview worldbank_get_data country handling as a client receives it: the
 * tool runs against the real WorldBankApiService with only `fetch` stubbed, so
 * the split, the request path, the country-index lookups, and the error assembly
 * all execute before anything is asserted. Covers the `|` separator, blame placed
 * on the codes the country index lacks, the ISO3 fill for rows upstream leaves
 * without one, and the path that keeps Lesotho clear of the edge firewall.
 * @module tests/tools/worldbank-get-data-countries.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { initWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A country-listing entry. Aggregates carry region.id = incomeLevel.id = "NA". */
function entity(id: string, iso2Code: string, name: string, aggregate = false) {
  return {
    id,
    iso2Code,
    name,
    region: aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'SSF', value: 'Region' },
    incomeLevel: aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'LIC', value: 'Low' },
    lendingType: {},
    capitalCity: '',
    longitude: '',
    latitude: '',
  };
}

/** The `/v2/country` listing, cut to the entities these tests name (identifiers as captured 2026-09-25). */
const ENTITIES = [
  entity('KEN', 'KE', 'Kenya'),
  entity('BRA', 'BR', 'Brazil'),
  entity('BEN', 'BJ', 'Benin'),
  entity('BFA', 'BF', 'Burkina Faso'),
  entity('ZAF', 'ZA', 'South Africa'),
  entity('LSO', 'LS', 'Lesotho'),
  entity('SDN', 'SD', 'Sudan'),
  entity('HIC', 'XD', 'High income', true),
  entity('LIC', 'XM', 'Low income', true),
  entity('INX', 'XY', 'Not classified', true),
  entity('SSF', 'ZG', 'Sub-Saharan Africa', true),
  entity('WLD', '1W', 'World', true),
];
const LISTING = [{ page: 1, pages: 1, per_page: '10000', total: ENTITIES.length }, ENTITIES];

const INVALID_VALUE = {
  id: '120',
  key: 'Invalid value',
  value: 'The provided parameter value is not valid',
};

/** One data-endpoint row, as the standard endpoint shapes it. */
function row(countryId: string, iso3: string, name: string, value: number | null = 1) {
  return {
    indicator: { id: 'SP.POP.TOTL', value: 'Population, total' },
    country: { id: countryId, value: name },
    countryiso3code: iso3,
    date: '2025',
    value,
    unit: '',
    obs_status: '',
    decimal: 0,
  };
}

function page(rows: unknown[]) {
  return [{ page: 1, pages: 1, per_page: 50, total: rows.length, sourceid: '2' }, rows];
}

// ─── Network stub ─────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();

/** The URL of every request, in order. */
function urls(): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    String(input instanceof Request ? input.url : input),
  );
}

/** The decoded `{codes}` segment of every `/v2/country/{codes}/indicator/{id}` request. */
function countrySegments(): string[] {
  return urls().flatMap((url) => {
    const match = /^\/v2\/country\/([^/]+)\/indicator\//.exec(new URL(url).pathname);
    return match?.[1] ? [decodeURIComponent(match[1])] : [];
  });
}

/**
 * Fake upstream. The country listing is served from {@link LISTING}, a catalog
 * lookup from `catalog` (the population series by default), and a data request by
 * `data` with its decoded codes. A country segment carrying `;LS` gets the edge
 * firewall's HTTP 403 page, as the live API answers it.
 */
function serve(options: {
  data: (codes: string[], indicatorId: string) => unknown;
  catalog?: (indicatorId: string) => unknown;
  listing?: () => Response;
}) {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/v2/country') {
      return options.listing?.() ?? Response.json(LISTING);
    }
    const dataPath = /^\/v2\/country\/([^/]+)\/indicator\/([^/]+)$/.exec(url.pathname);
    if (dataPath?.[1] && dataPath[2]) {
      const segment = decodeURIComponent(dataPath[1]);
      if (/;ls(?:;|$)/i.test(segment)) {
        return new Response('<!doctype html><html><body>Request Blocked by WAF</body></html>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        });
      }
      return Response.json(options.data(segment.split(';'), decodeURIComponent(dataPath[2])));
    }
    const catalogPath = /^\/v2\/indicator\/([^/]+)$/.exec(url.pathname);
    if (catalogPath?.[1]) {
      return Response.json(
        options.catalog?.(decodeURIComponent(catalogPath[1])) ?? POPULATION_CATALOG,
      );
    }
    throw new Error(`unmocked fetch: ${url.href}`);
  });
}

/** A data endpoint that serves the listed economies and rejects any code the listing lacks. */
function servesKnownCodes(codes: string[]) {
  const known = new Set(ENTITIES.flatMap((e) => [e.id, e.iso2Code]));
  if (codes.some((code) => !known.has(code.toUpperCase()))) return [{ message: [INVALID_VALUE] }];
  return page(
    codes.map((code) => {
      const e = ENTITIES.find(
        (x) => x.id === code.toUpperCase() || x.iso2Code === code.toUpperCase(),
      );
      return row(e?.iso2Code ?? code, e?.id ?? '', e?.name ?? code);
    }),
  );
}

const POPULATION_CATALOG = [
  { page: 1, pages: 1, per_page: 50, total: 1 },
  [
    {
      id: 'SP.POP.TOTL',
      name: 'Population, total',
      source: { id: '2', value: 'WDI' },
      sourceNote: '',
      topics: [],
    },
  ],
];

type WireError = { code: number; message: string; data: Record<string, unknown> };

function textOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
}

function failure(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  return { error: (result.structuredContent as { error: WireError }).error, text: textOf(result) };
}

/** Call the tool through the contract runner, population series and `mrv: 1` unless overridden. */
function call(args: { countries: unknown; indicator_id?: string }) {
  return runToolContract(
    worldbankGetData,
    { indicator_id: 'SP.POP.TOTL', mrv: 1, ...args } as never,
    { context: { errors: worldbankGetData.errors } },
  );
}

describe('worldbank_get_data country handling, end to end', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
    initWorldBankApiService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Separators ───────────────────────────────────────────────────────────

  it.each([['BJ;BF'], ['BJ,BF'], [['BJ', 'BF']]])(
    'sends %j as the semicolon list the data endpoint takes',
    async (countries) => {
      serve({ data: servesKnownCodes });
      const result = await call({ countries });

      expect(result.isError).toBeFalsy();
      expect(countrySegments()).toEqual(['BJ;BF']);
      expect(result.structuredContent).toMatchObject({ appliedFilters: { countries: 'BJ;BF' } });
    },
  );

  it.each([['BJ|BF'], ['BJ | BF'], [['BJ|BF']], [['BJ', ' | BF']]])(
    'splits the pipe-joined countries %j and returns both economies, on both surfaces',
    async (countries) => {
      serve({ data: servesKnownCodes });
      const result = await call({ countries });

      expect(result.isError).toBeFalsy();
      expect(countrySegments()).toEqual(['BJ;BF']);
      const structured = result.structuredContent as {
        data: Array<{ countryCode: string }>;
        appliedFilters: { countries: string };
      };
      expect(structured.data.map((d) => d.countryCode)).toEqual(['BJ', 'BF']);
      expect(structured.appliedFilters.countries).toBe('BJ;BF');
      const text = textOf(result);
      expect(text).toContain('## Benin (BJ / BEN)');
      expect(text).toContain('## Burkina Faso (BF / BFA)');
      expect(text).toContain('countries=BJ;BF');
    },
  );

  it.each([['|'], [' | '], [['|']], ['|;,'], [[' , ', '|']]])(
    'rejects %j, which splits to no code, at the schema before any request',
    async (countries) => {
      serve({ data: servesKnownCodes });
      const { error, text } = failure(await call({ countries }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(text).toContain('Provide at least one country code');
    },
  );

  // ─── Blame placed on the codes the country index lacks ────────────────────

  it('names only the code the country index lacks, on both surfaces', async () => {
    serve({ data: servesKnownCodes });
    const { error, text } = failure(await call({ countries: ['KE', 'ZZ'] }));

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toContain('Country code(s) "ZZ" not valid');
    expect(error.message).not.toContain('KE');
    expect(error.data).toMatchObject({
      reason: 'country_not_found',
      countryCodes: 'ZZ',
      countries: ['KE', 'ZZ'],
      recovery: { hint: expect.stringContaining('worldbank_list_countries') },
    });
    expect(text).toContain('Country code(s) "ZZ" not valid');
    expect(text).not.toContain('KE;ZZ');
    expect(text.trimEnd()).toMatch(/\(reason country_not_found\)$/);
  });

  it('names every code the index lacks, in the order sent', async () => {
    serve({ data: servesKnownCodes });
    const { error } = failure(await call({ countries: ['KE', 'ZZ', 'QQ', 'BR'] }));

    expect(error.message).toContain('"ZZ;QQ"');
    expect(error.data).toMatchObject({
      countryCodes: 'ZZ;QQ',
      countries: ['KE', 'ZZ', 'QQ', 'BR'],
    });
  });

  it('looks codes up case-insensitively and names them as sent', async () => {
    serve({ data: servesKnownCodes });
    const { error } = failure(await call({ countries: ['ke', 'zz'] }));

    expect(error.message).toContain('"zz"');
    expect(error.data).toMatchObject({ countryCodes: 'zz', countries: ['ke', 'zz'] });
  });

  it('narrows the codes on a rejection of both the indicator and the countries', async () => {
    serve({ data: () => [{ message: [INVALID_VALUE, INVALID_VALUE] }] });
    const { error, text } = failure(
      await call({ indicator_id: 'NOT.AN.INDICATOR', countries: ['KE', 'ZZ'] }),
    );

    expect(error.data).toMatchObject({
      reason: 'indicator_and_country_not_found',
      indicatorId: 'NOT.AN.INDICATOR',
      countryCodes: 'ZZ',
      countries: ['KE', 'ZZ'],
    });
    expect(text).toContain('country code(s) "ZZ"');
    expect(text).not.toContain('KE;ZZ');
  });

  it('places the blame on a source-scoped indicator the standard endpoint rejects over a bad code', async () => {
    serve({
      data: servesKnownCodes,
      catalog: () => [
        { page: 1, pages: 1, per_page: 50, total: 1 },
        [
          {
            id: 'SM.POP.REFG.OR',
            name: 'Refugee population by country or territory of origin',
            source: { id: '57', value: 'WDI Database Archives' },
            sourceNote: '',
            topics: [],
          },
        ],
      ],
    });
    const { error } = failure(
      await call({ indicator_id: 'SM.POP.REFG.OR', countries: ['SDN', 'ZZZ'] }),
    );

    expect(error.data).toMatchObject({
      reason: 'country_not_found',
      countryCodes: 'ZZZ',
      countries: ['SDN', 'ZZZ'],
    });
  });

  it('names the whole list when the index knows every code upstream rejected', async () => {
    serve({ data: () => [{ message: [INVALID_VALUE] }] });
    const { error } = failure(await call({ countries: ['KE', 'BR'] }));

    expect(error.data).toMatchObject({
      reason: 'country_not_found',
      countryCodes: 'KE;BR',
      countries: ['KE', 'BR'],
    });
    expect(error.message).toContain('"KE;BR"');
  });

  it('keeps the rejection, naming the whole list, when the country index fails to load', async () => {
    serve({
      data: servesKnownCodes,
      listing: () => Response.json([{ message: [INVALID_VALUE] }]),
    });
    const { error } = failure(await call({ countries: ['KE', 'ZZ'] }));

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'country_not_found',
      countryCodes: 'KE;ZZ',
      countries: ['KE', 'ZZ'],
    });
    expect(error.message).not.toMatch(/country listing/);
  });

  it('reads the country index only after upstream has rejected the request', async () => {
    serve({ data: servesKnownCodes });
    failure(await call({ countries: ['KE', 'ZZ'] }));

    const paths = urls().map((url) => new URL(url).pathname);
    expect(paths).toEqual([
      '/v2/country/KE%3BZZ/indicator/SP.POP.TOTL',
      '/v2/indicator/SP.POP.TOTL',
      '/v2/country',
    ]);
  });

  // ─── ISO3 filled from the country index ───────────────────────────────────

  it('fills countryIso3 on the income-group rows upstream leaves without one, on both surfaces', async () => {
    serve({
      data: () =>
        page([
          row('XD', '', 'High income', 1_423_739_902),
          row('XY', '', 'Not classified', null),
          row('XM', '', 'Low income', 767_490_169),
          row('ZG', 'SSF', 'Sub-Saharan Africa', 1_321_654_217),
          row('1W', 'WLD', 'World', 8_215_424_893),
        ]),
    });
    const result = await call({ countries: ['HIC', 'LIC', 'WLD', 'SSF', 'INX'] });

    expect(result.isError).toBeFalsy();
    const data = (result.structuredContent as { data: Array<Record<string, unknown>> }).data;
    expect(data.map((d) => [d.countryCode, d.countryIso3, d.isAggregate])).toEqual([
      ['XD', 'HIC', true],
      ['XY', 'INX', true],
      ['XM', 'LIC', true],
      ['ZG', 'SSF', true],
      ['1W', 'WLD', true],
    ]);
    const text = textOf(result);
    expect(text).toContain('## High income (XD / HIC) [Aggregate]');
    expect(text).toContain('## Not classified (XY / INX) [Aggregate]');
    expect(text).toContain('## Low income (XM / LIC) [Aggregate]');
    // The data request and the one country listing — the fill costs no request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a Global Economic Monitor row under its ISO2 and ISO3 codes, on both surfaces', async () => {
    // Source 15 names the economy by ISO3 in country.id and leaves countryiso3code empty.
    serve({ data: () => page([row('BRA', '', 'Brazil', 248.47), row('KEN', '', 'Kenya', 283.9)]) });
    const result = await call({ indicator_id: 'CPTOTSAXN', countries: ['KE', 'BR'] });

    const data = (result.structuredContent as { data: Array<Record<string, unknown>> }).data;
    expect(data.map((d) => [d.countryCode, d.countryIso3, d.isAggregate])).toEqual([
      ['BR', 'BRA', false],
      ['KE', 'KEN', false],
    ]);
    const text = textOf(result);
    expect(text).toContain('## Brazil (BR / BRA)');
    expect(text).toContain('## Kenya (KE / KEN)');
  });

  it('keeps a row the index does not carry as upstream sent it', async () => {
    serve({ data: () => page([row('QQ', '', 'Somewhere'), row('XD', 'ODD', 'High income')]) });
    const result = await call({ countries: ['QQ', 'HIC'] });

    const data = (result.structuredContent as { data: Array<Record<string, unknown>> }).data;
    expect(data.map((d) => [d.countryCode, d.countryIso3])).toEqual([
      ['QQ', ''],
      ['XD', 'ODD'],
    ]);
    expect(textOf(result)).toContain('## Somewhere (QQ)\n');
  });

  // ─── Lesotho and the edge firewall ────────────────────────────────────────

  it.each([
    [['ZA', 'LS'], 'ZA;LSO', 'ZA;LS'],
    ['ZAF;LS', 'ZAF;LSO', 'ZAF;LS'],
    [['LS', 'ZA'], 'LSO;ZA', 'LS;ZA'],
    ['za, ls', 'za;LSO', 'za;ls'],
  ])(
    'sends Lesotho in %j as LSO and returns both economies under their own codes',
    async (countries, sent, echoed) => {
      serve({ data: servesKnownCodes });
      const result = await call({ countries });

      expect(result.isError).toBeFalsy();
      expect(countrySegments()).toEqual([sent]);
      const structured = result.structuredContent as {
        data: Array<{ countryCode: string; countryIso3: string }>;
        appliedFilters: { countries: string };
      };
      expect(structured.data.map((d) => [d.countryCode, d.countryIso3]).sort()).toEqual([
        ['LS', 'LSO'],
        ['ZA', 'ZAF'],
      ]);
      expect(structured.appliedFilters.countries).toBe(echoed);
      expect(textOf(result)).toContain('## Lesotho (LS / LSO)');
    },
  );

  it('sends a list without Lesotho unchanged', async () => {
    serve({ data: servesKnownCodes });
    await call({ countries: ['ZA', 'KE', 'SD'] });

    expect(countrySegments()).toEqual(['ZA;KE;SD']);
  });

  it('names a rejected list by the codes the caller sent, not the LSO sent for Lesotho', async () => {
    serve({ data: () => [{ message: [INVALID_VALUE] }] });
    const { error, text } = failure(await call({ countries: ['ZA', 'LS'] }));

    expect(countrySegments()).toEqual(['ZA;LSO']);
    expect(error.data).toMatchObject({ countryCodes: 'ZA;LS', countries: ['ZA', 'LS'] });
    expect(text).not.toContain('LSO');
  });
});
