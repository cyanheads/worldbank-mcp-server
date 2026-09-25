/**
 * @fileoverview worldbank_search_projects country resolution against its real
 * services, with only the network stubbed: ISO3 codes resolve through the World
 * Bank country index, the four economies the portfolio files under legacy codes
 * resolve from either identifier, WDI aggregates and unknown codes are rejected
 * before the Projects API is asked, and a search in two-character codes never
 * touches the Indicators API.
 * @module tests/tools/worldbank-search-projects-countries.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';
import { initProjectsService } from '@/services/projects/projects-service.js';
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A country-listing entry. Aggregates carry region.id = incomeLevel.id = "NA". */
function entity(id: string, iso2Code: string, name: string, aggregate = false) {
  return {
    id,
    iso2Code,
    name,
    region: aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'MEA', value: 'Region' },
    incomeLevel: aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'LIC', value: 'Low' },
    lendingType: aggregate ? { id: '', value: 'Aggregates' } : { id: 'IDX', value: 'IDA' },
    capitalCity: '',
    longitude: '',
    latitude: '',
  };
}

/** The `/v2/country` listing, as captured 2026-09-25, cut to the entities these tests name. */
const COUNTRY_LISTING = [
  { page: 1, pages: 1, per_page: '10000', total: 12 },
  [
    entity('BRA', 'BR', 'Brazil'),
    entity('IND', 'IN', 'India'),
    entity('KEN', 'KE', 'Kenya'),
    entity('YEM', 'YE', 'Yemen, Rep.'),
    entity('COD', 'CD', 'Congo, Dem. Rep.'),
    entity('PSE', 'PS', 'West Bank and Gaza'),
    entity('TLS', 'TL', 'Timor-Leste'),
    entity('SSF', 'ZG', 'Sub-Saharan Africa', true),
    entity('WLD', '1W', 'World', true),
    entity('SAS', '8S', 'South Asia', true),
    entity('EAP', '4E', 'East Asia & Pacific (excluding high income)', true),
    entity('ECA', '7E', 'Europe & Central Asia (excluding high income)', true),
  ],
];

/** One Projects API row. */
function project(id: string, countrycode: string) {
  return {
    id,
    proj_id: id,
    project_name: `Project ${id}`,
    status: 'Active',
    countryname: 'Somewhere',
    countrycode: [countrycode],
    regionname: 'Middle East, North Africa, Afghanistan, and Pakistan',
    boardapprovaldate: '2025-06-01T00:00:00Z',
  };
}

const fetchMock = vi.fn<typeof fetch>();

/** Every URL the tool requested, split by upstream. */
function requests() {
  const urls = fetchMock.mock.calls.map(([input]) =>
    String(input instanceof Request ? input.url : input),
  );
  return {
    indicators: urls.filter((url) => url.startsWith('https://api.worldbank.org/v2/')),
    projects: urls
      .filter((url) => url.startsWith('https://search.worldbank.org/api/v3/projects?'))
      .map((url) => new URL(url).searchParams),
  };
}

/** Serve the country listing and answer every Projects search with `rows`. */
function serve(rows: Array<ReturnType<typeof project>>) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.worldbank.org/v2/country?')) {
      return Response.json(COUNTRY_LISTING);
    }
    if (url.startsWith('https://search.worldbank.org/api/v3/projects?')) {
      return Response.json({
        rows: rows.length,
        os: '0',
        page: '1',
        total: String(rows.length),
        projects: Object.fromEntries(rows.map((row) => [row.id, row])),
      });
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
}

type WireError = { code: number; message: string; data: Record<string, unknown> };

function failure(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: WireError }).error;
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  return { error, text };
}

describe('worldbank_search_projects country resolution', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
    initWorldBankApiService({} as never, createInMemoryStorage());
    initProjectsService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves an ISO3 code to the ISO2 the portfolio keys on, and echoes the code sent', async () => {
    serve([project('P100', 'BR')]);
    const result = await runToolContract(worldbankSearchProjects, { countries: 'BRA' });

    expect(result.isError).toBeFalsy();
    expect(requests().projects[0]?.get('countrycode_exact')).toBe('BR');
    expect(result.structuredContent).toMatchObject({ appliedFilters: { countries: 'BR' } });
    expect(result.content.map((block) => ('text' in block ? block.text : '')).join('\n')).toContain(
      'countries=BR',
    );
  });

  it('resolves a mixed-case ISO3 list beside ISO2 into one caret-joined filter', async () => {
    serve([project('P100', 'BR')]);
    const result = await runToolContract(worldbankSearchProjects, { countries: ['bra', 'IN'] });

    expect(requests().projects[0]?.get('countrycode_exact')).toBe('BR^IN');
    expect(result.structuredContent).toMatchObject({ appliedFilters: { countries: 'BR,IN' } });
  });

  it.each([
    ['YEM', 'RY'],
    ['YE', 'RY'],
    ['COD', 'ZR'],
    ['CD', 'ZR'],
    ['PSE', 'GZ'],
    ['PS', 'GZ'],
    ['TLS', 'TP'],
    ['TL', 'TP'],
    ['RY', 'RY'],
  ])('searches %s under the portfolio code %s', async (code, portfolioCode) => {
    serve([project('P200', portfolioCode)]);
    const result = await runToolContract(worldbankSearchProjects, { countries: code });

    expect(result.isError).toBeFalsy();
    expect(requests().projects[0]?.get('countrycode_exact')).toBe(portfolioCode);
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { countries: portfolioCode },
    });
  });

  it('reports a legacy-coded project under the WDI ISO2 code, on both surfaces', async () => {
    serve([project('P300', 'RY')]);
    const result = await runToolContract(worldbankSearchProjects, { countries: 'YEM' });

    expect(result.structuredContent).toMatchObject({ projects: [{ countryCodes: ['YE'] }] });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**countryCodes:** YE');
  });

  it('asks the Indicators API nothing when every code is two characters', async () => {
    serve([project('P100', 'BR')]);
    await runToolContract(worldbankSearchProjects, { countries: ['BR', 'IN', '3A', 'YE'] });

    expect(requests().indicators).toEqual([]);
    expect(requests().projects[0]?.get('countrycode_exact')).toBe('BR^IN^3A^RY');
  });

  it.each(['SSF', 'WLD', 'SAS', 'EAP', 'ECA'])(
    'rejects the WDI aggregate %s as invalid_country_code before any Projects request',
    async (code) => {
      serve([]);
      const { error, text } = failure(
        await runToolContract(worldbankSearchProjects, { countries: code }),
      );

      expect(requests().projects).toEqual([]);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'invalid_country_code',
        invalidCodes: [code],
        recovery: { hint: expect.stringContaining('region') },
      });
      expect(text).toContain(`"${code}"`);
      expect(text).toMatch(/aggregate/);
      expect(text).not.toMatch(/BR rather than BRA/);
    },
  );

  it('names unknown codes and aggregates apart when both are sent', async () => {
    serve([]);
    const { error, text } = failure(
      await runToolContract(worldbankSearchProjects, { countries: 'SSF;XYZ;WLD' }),
    );

    expect(requests().projects).toEqual([]);
    expect(error.data).toMatchObject({ invalidCodes: ['XYZ', 'SSF', 'WLD'] });
    expect(text).toContain('No economy in the World Bank country index has the code(s) "XYZ".');
    expect(text).toContain('"SSF, WLD" are WDI aggregates, not economies');
  });

  it('rejects a three-character code no economy has before any Projects request', async () => {
    serve([]);
    const { error, text } = failure(
      await runToolContract(worldbankSearchProjects, { countries: ['BR', 'XYZ'] }),
    );

    expect(requests().projects).toEqual([]);
    expect(error.data).toMatchObject({ reason: 'invalid_country_code', invalidCodes: ['XYZ'] });
    expect(text).toContain('"XYZ"');
    expect(text).toMatch(/Recovery:.*worldbank_list_countries/);
  });

  it.each(['BRAZ', 'B', 'B-'])(
    'rejects the malformed code %s before any request at all',
    async (code) => {
      serve([]);
      const { error } = failure(
        await runToolContract(worldbankSearchProjects, { countries: code }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(error.data).toMatchObject({ reason: 'invalid_country_code', invalidCodes: [code] });
    },
  );

  it('no longer tells the caller to convert ISO3 to ISO2 when a code matches nothing', async () => {
    serve([]);
    const result = await runToolContract(worldbankSearchProjects, { countries: 'QQ' });

    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toMatch(/No project carries country code\(s\) QQ/);
    expect(notice).not.toMatch(/BRA/);
    expect(notice).not.toMatch(/iso2 field/);
  });
});
