/**
 * @fileoverview worldbank_get_data's served page size as a client receives it:
 * the tool runs against the real WorldBankApiService with only `fetch` stubbed,
 * so the cap, the upstream `per_page`, the local slice of a date window read in
 * full, and the disclosure on both surfaces all execute before anything is asserted.
 * @module tests/tools/worldbank-get-data-page-cap.test
 */

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

/** 450 one-year observations, one per synthetic economy, in upstream order. */
const SERIES = Array.from({ length: 450 }, (_, i) => {
  const iso2 = `C${String(i + 1).padStart(3, '0')}`;
  return {
    indicator: { id: 'SP.POP.TOTL', value: 'Population, total' },
    country: { id: iso2, value: `Economy ${i + 1}` },
    countryiso3code: iso2,
    date: '2020',
    value: i + 1,
    unit: '',
    obs_status: '',
    decimal: 0,
  };
});

const LISTING = [{ page: 1, pages: 1, per_page: '10000', total: 0 }, []];

// ─── Network stub ─────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();

/** The `per_page` of every request to the data endpoint, in order. */
function dataRequestSizes(): string[] {
  return fetchMock.mock.calls.flatMap(([input]) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    return url.pathname.includes('/indicator/') ? [url.searchParams.get('per_page') ?? ''] : [];
  });
}

/**
 * Fake upstream: the data endpoint pages {@link SERIES} by the `page` and
 * `per_page` it is sent, as the live API does, and the country listing is empty.
 */
function serve(series: readonly unknown[] = SERIES, sourceId: unknown = '2') {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/v2/country') return Response.json(LISTING);
    if (url.pathname === '/v2/country/all/indicator/SP.POP.TOTL') {
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('per_page'));
      return Response.json([
        {
          page,
          pages: Math.ceil(series.length / size),
          per_page: size,
          total: series.length,
          sourceid: sourceId,
        },
        series.slice((page - 1) * size, page * size),
      ]);
    }
    throw new Error(`unmocked fetch: ${url.href}`);
  });
}

function textOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
}

type Structured = {
  data: Array<{ countryCode: string }>;
  appliedFilters: Record<string, unknown>;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  notice?: string;
};

async function call(args: Record<string, unknown>) {
  const result = await runToolContract(
    worldbankGetData,
    { indicator_id: 'SP.POP.TOTL', countries: 'all', ...args } as never,
    { context: { errors: worldbankGetData.errors } },
  );
  expect(result.isError).toBeFalsy();
  return { structured: result.structuredContent as Structured, text: textOf(result) };
}

describe('worldbank_get_data served page size, end to end', () => {
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

  it.each([50, 199, 200, 201, 1000])(
    'serves per_page=%i without a budget reduction',
    async (size) => {
      const { structured, text } = await call({ per_page: size });
      expect(dataRequestSizes()).toEqual([String(size)]);
      expect(structured.data).toHaveLength(Math.min(size, 450));
      expect(structured.appliedFilters).toMatchObject({ perPage: size });
      expect(structured.appliedFilters).not.toHaveProperty('requestedPerPage');
      expect(structured.notice).toBeUndefined();
      expect(text).toContain(`per_page=${size}`);
    },
  );

  it.each([1, 2])('clamps above maximum and discloses it on page %i', async (page) => {
    const { structured, text } = await call({ per_page: 1001, page });
    expect(structured.appliedFilters).toMatchObject({ perPage: 1000, requestedPerPage: 1001 });
    expect(structured.totalPages).toBe(1);
    expect(structured.notice).toContain('per_page=1001 was reduced to 1000');
    expect(text).toContain('per_page=1000 (requested 1001)');
    expect(text).toContain('per_page=1001 was reduced to 1000');
  });

  it('discloses the maximum clamp on an empty result', async () => {
    serve([]);
    const { structured, text } = await call({ per_page: 1001 });
    expect(structured.data).toEqual([]);
    expect(structured.appliedFilters).toMatchObject({ perPage: 1000, requestedPerPage: 1001 });
    expect(structured.notice).toContain('per_page=1001 was reduced to 1000');
    expect(text).toContain('per_page=1001 was reduced to 1000');
  });

  it.each([undefined, '2020'])('pages contiguously on path %s', async (path) => {
    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push(await call({ per_page: 201, page, ...(path && { date_range: path }) }));
    }
    const expected = SERIES.map((row) => row.country.id);
    expect(
      pages.flatMap(({ structured }) => structured.data.map((row) => row.countryCode)),
    ).toEqual(expected);
    expect(pages[3]?.structured.data).toEqual([]);
  });

  it.each([null, '', '   ', { id: '2' }])(
    'does not invent provenance from malformed source metadata %j',
    async (sourceId) => {
      serve(SERIES, sourceId);
      for (const args of [{}, { date_range: '2020' }]) {
        const { structured, text } = await call(args);
        expect(structured).not.toHaveProperty('sourceId');
        expect(text).not.toContain('Serving source ID:');
      }
    },
  );

  it('preserves a valid serving source on ordinary and windowed reads', async () => {
    for (const args of [{}, { date_range: '2020' }]) {
      const { structured, text } = await call(args);
      expect(structured).toHaveProperty('sourceId', '2');
      expect(text).toContain('**Serving source ID:** 2');
    }
  });
});
