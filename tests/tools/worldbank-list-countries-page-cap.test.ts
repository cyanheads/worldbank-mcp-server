/**
 * @fileoverview worldbank_list_countries' served page size as a client receives
 * it: the tool runs against the real WorldBankApiService with only `fetch`
 * stubbed, so the cap, the upstream `per_page`, the local slice of an
 * aggregate-free listing, and the disclosure on both surfaces all execute.
 * @module tests/tools/worldbank-list-countries-page-cap.test
 */

import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankListCountries } from '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { initWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** One listing entry. Aggregates carry region.id = incomeLevel.id = "NA". */
function entity(id: string, aggregate: boolean) {
  return {
    id,
    iso2Code: id.slice(0, 2),
    name: id,
    region: aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'SSF', value: 'Region' },
    incomeLevel: aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'LIC', value: 'Low' },
    lendingType: aggregate ? { id: '', value: 'Aggregates' } : { id: 'IDX', value: 'IDA' },
    capitalCity: aggregate ? '' : 'Capital',
    longitude: aggregate ? '' : '1',
    latitude: aggregate ? '' : '2',
  };
}

/** A 295-entry listing, the size of the live one, with every fourth entry an aggregate. */
const ENTITIES = Array.from({ length: 295 }, (_, i) =>
  i % 4 === 3
    ? entity(`A${String(i).padStart(3, '0')}`, true)
    : entity(`E${String(i).padStart(3, '0')}`, false),
);
const ECONOMIES = ENTITIES.filter((e) => e.region.id !== 'NA');

// ─── Network stub ─────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();

/** The `per_page` of every listing request, in order. */
function requestSizes(): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    String(
      new URL(String(input instanceof Request ? input.url : input)).searchParams.get('per_page'),
    ),
  );
}

/** Fake upstream: `/v2/country` pages {@link ENTITIES} by the `page` and `per_page` sent. */
function serve(entities: readonly unknown[] = ENTITIES) {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname !== '/v2/country') throw new Error(`unmocked fetch: ${url.href}`);
    const page = Number(url.searchParams.get('page'));
    const size = Number(url.searchParams.get('per_page'));
    return Response.json([
      { page, pages: Math.ceil(entities.length / size), per_page: size, total: entities.length },
      entities.slice((page - 1) * size, page * size),
    ]);
  });
}

function textOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
}

type Structured = {
  countries: Array<{ id: string }>;
  appliedFilters: Record<string, unknown>;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  notice?: string;
};

async function call(args: Record<string, unknown>) {
  const result = await runToolContract(worldbankListCountries, args as never, {
    context: { errors: worldbankListCountries.errors },
  });
  expect(result.isError).toBeFalsy();
  return { structured: result.structuredContent as Structured, text: textOf(result) };
}

describe('worldbank_list_countries served page size, end to end', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
    initWorldBankApiService({} as never, createInMemoryStorage());
    serve();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('echoes the filters it applied beside the page size', async () => {
    const { structured, text } = await call({
      region: ' SSF ',
      income_level: 'LIC',
      lending_type: 'IDX',
      page: 2,
      per_page: 20,
    });

    expect(structured.appliedFilters).toEqual({
      region: 'SSF',
      incomeLevel: 'LIC',
      lendingType: 'IDX',
      includeAggregates: false,
      page: 2,
      perPage: 20,
    });
    expect(text).toContain(
      '**Applied Filters:** region=SSF, income_level=LIC, lending_type=IDX, include_aggregates=false, page=2, per_page=20',
    );
  });

  it.each([50, 149, 150, 151, 300])(
    'serves per_page=%i without a budget reduction',
    async (size) => {
      const { structured, text } = await call({ include_aggregates: true, per_page: size });
      expect(requestSizes()).toEqual([String(size)]);
      expect(structured.countries).toHaveLength(Math.min(size, 295));
      expect(structured.appliedFilters).toMatchObject({ perPage: size });
      expect(structured.appliedFilters).not.toHaveProperty('requestedPerPage');
      expect(structured.notice).toBeUndefined();
      expect(text).toContain(`per_page=${size}`);
    },
  );

  it.each([1, 2])('clamps above maximum and discloses it on page %i', async (page) => {
    const { structured, text } = await call({ include_aggregates: true, per_page: 301, page });
    expect(structured.appliedFilters).toMatchObject({ perPage: 300, requestedPerPage: 301 });
    expect(structured.totalPages).toBe(1);
    expect(structured.notice).toContain('per_page=301 was reduced to 300');
    expect(text).toContain('per_page=300 (requested 301)');
    expect(text).toContain('per_page=301 was reduced to 300');
  });

  it('discloses the maximum clamp on an empty result', async () => {
    serve([]);
    const { structured, text } = await call({ include_aggregates: true, per_page: 301 });
    expect(structured.countries).toEqual([]);
    expect(structured.appliedFilters).toMatchObject({ perPage: 300, requestedPerPage: 301 });
    expect(structured.notice).toContain('per_page=301 was reduced to 300');
    expect(text).toContain('per_page=301 was reduced to 300');
  });

  it.each([true, false])('pages contiguously on path %s', async (path) => {
    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push(await call({ per_page: 151, page, include_aggregates: path }));
    }
    const expected = (path ? ENTITIES : ECONOMIES).map((row) => row.id);
    expect(pages.flatMap(({ structured }) => structured.countries.map((row) => row.id))).toEqual(
      expected,
    );
    expect(pages[3]?.structured.countries).toEqual([]);
  });
});
