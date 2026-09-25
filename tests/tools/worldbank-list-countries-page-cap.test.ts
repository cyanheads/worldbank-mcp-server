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

  it.each([100, 150])(
    'serves per_page=%i with aggregates as asked, with no reduction to disclose',
    async (size) => {
      const { structured, text } = await call({ include_aggregates: true, per_page: size });

      expect(requestSizes()).toEqual([String(size)]);
      expect(structured.countries).toHaveLength(size);
      expect(structured.appliedFilters).toEqual({
        includeAggregates: true,
        page: 1,
        perPage: size,
      });
      expect(structured.notice).toBeUndefined();
      expect(text).toContain(`include_aggregates=true, page=1, per_page=${size}`);
    },
  );

  it('reduces per_page=300 with aggregates to 150 upstream and discloses it on both surfaces', async () => {
    const { structured, text } = await call({ include_aggregates: true, per_page: 300 });

    expect(requestSizes()).toEqual(['150']);
    expect(structured.countries).toHaveLength(150);
    expect(structured.appliedFilters).toMatchObject({ perPage: 150, requestedPerPage: 300 });
    expect(structured).toMatchObject({ totalCount: 295, currentPage: 1, totalPages: 2 });
    expect(structured.notice).toMatch(/per_page=300 was reduced to 150, the most one page holds/);
    expect(structured.notice).toMatch(
      /totalPages counts pages of 150, so page 2 with the same filters continues where this page ends/,
    );
    expect(text).toContain('per_page=150 (requested 300)');
    expect(text).toContain('per_page=300 was reduced to 150');
  });

  it.each([
    ['with aggregates', { include_aggregates: true }, ENTITIES],
    ['economies only', {}, ECONOMIES],
  ])(
    'continues %s with page + 1 at the reduced size, contiguously',
    async (_label, filter, all) => {
      const pages = [
        await call({ ...filter, per_page: 300, page: 1 }),
        await call({ ...filter, per_page: 300, page: 2 }),
      ];

      expect(pages.map(({ structured }) => structured.countries.length)).toEqual([
        150,
        all.length - 150,
      ]);
      expect(pages.map(({ structured }) => structured.totalPages)).toEqual([2, 2]);
      expect(pages.flatMap(({ structured }) => structured.countries.map((c) => c.id))).toEqual(
        all.map((e) => e.id),
      );
    },
  );

  it('names the page range at the served size for a page past the end', async () => {
    const { structured } = await call({ per_page: 300, page: 3 });

    expect(structured.countries).toEqual([]);
    expect(structured).toMatchObject({
      totalCount: ECONOMIES.length,
      currentPage: 3,
      totalPages: 2,
    });
    expect(structured.notice).toMatch(
      new RegExp(
        `^Page 3 is past the end of the results — ${ECONOMIES.length} countries span 2 pages \\(1–2\\) at per_page=150\\.`,
      ),
    );
  });

  /**
   * 48 entries fit on one page at the served 150, the page per_page=300 would
   * have served too, so there is no reduction to disclose — on the upstream-paged
   * path and the fetch-all path alike. The echo still says both sizes.
   */
  it.each([
    ['with aggregates', { include_aggregates: true }],
    ['economies only', {}],
  ])('discloses no reduction %s when the whole result fits on one page', async (_label, filter) => {
    serve(ECONOMIES.slice(0, 48));
    for (const page of [1, 2]) {
      const { structured, text } = await call({ ...filter, per_page: 300, page });

      expect(structured.appliedFilters).toMatchObject({ perPage: 150, requestedPerPage: 300 });
      expect(structured.totalPages).toBe(1);
      expect(structured.notice ?? '').not.toMatch(/was reduced/);
      expect(text).not.toContain('was reduced');
      expect(text).toContain('per_page=150 (requested 300)');
    }
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
});
