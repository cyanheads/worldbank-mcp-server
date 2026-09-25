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
function serve(series: readonly unknown[] = SERIES) {
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
          sourceid: '2',
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

  it.each([50, 200])('serves per_page=%i as asked, with no reduction to disclose', async (size) => {
    const { structured, text } = await call({ per_page: size });

    expect(dataRequestSizes()).toEqual([String(size)]);
    expect(structured.data).toHaveLength(size);
    expect(structured.appliedFilters).toMatchObject({ perPage: size });
    expect(structured.appliedFilters).not.toHaveProperty('requestedPerPage');
    expect(structured.totalPages).toBe(Math.ceil(450 / size));
    expect(structured.notice).toBeUndefined();
    expect(text).toContain(`per_page=${size}`);
    expect(text).not.toContain('requested');
  });

  it('reduces per_page=1000 to 200 and discloses it on both surfaces', async () => {
    const { structured, text } = await call({ per_page: 1000 });

    expect(dataRequestSizes()).toEqual(['200']);
    expect(structured.data).toHaveLength(200);
    expect(structured.appliedFilters).toMatchObject({ perPage: 200, requestedPerPage: 1000 });
    expect(structured).toMatchObject({ totalCount: 450, currentPage: 1, totalPages: 3 });
    expect(structured.notice).toMatch(/per_page=1000 was reduced to 200, the most one page holds/);
    expect(structured.notice).toMatch(/50 KB/);
    expect(structured.notice).toMatch(
      /totalPages counts pages of 200, so page 2 with the same filters continues where this page ends/,
    );
    expect(text).toContain('per_page=200 (requested 1000)');
    expect(text).toContain('per_page=1000 was reduced to 200');
  });

  it('continues with page + 1 at the reduced size, neither skipping nor repeating a row', async () => {
    const pages = [
      await call({ per_page: 1000, page: 1 }),
      await call({ per_page: 1000, page: 2 }),
      await call({ per_page: 1000, page: 3 }),
    ];

    expect(pages.map(({ structured }) => structured.data.length)).toEqual([200, 200, 50]);
    expect(pages.flatMap(({ structured }) => structured.data.map((d) => d.countryCode))).toEqual(
      SERIES.map((row) => row.country.id),
    );
    // The last page has no next page to point at.
    expect(pages[2]?.structured.notice).not.toMatch(/continues/);
  });

  it('names the page range at the served size for a page past the end', async () => {
    const { structured, text } = await call({ per_page: 1000, page: 4 });

    expect(structured.data).toEqual([]);
    expect(structured).toMatchObject({ totalCount: 450, currentPage: 4, totalPages: 3 });
    expect(structured.notice).toMatch(
      /^Page 4 is past the end of the results — 450 observations span 3 pages \(1–3\) at per_page=200\./,
    );
    expect(text).toContain('Page 4 is past the end of the results');
  });

  /**
   * 120 observations fit on one page at the served 200, the page per_page=1000
   * would have served too, so there is no reduction to disclose. The echo still
   * says what was served and what was asked for.
   */
  it('discloses no reduction when the whole result fits on one page at the served size', async () => {
    serve(SERIES.slice(0, 120));
    for (const page of [1, 2]) {
      const { structured, text } = await call({ per_page: 1000, page });

      expect(structured.appliedFilters).toMatchObject({ perPage: 200, requestedPerPage: 1000 });
      expect(structured.totalPages).toBe(1);
      expect(structured.notice ?? '').not.toMatch(/was reduced/);
      expect(text).not.toContain('was reduced');
      expect(text).toContain('per_page=200 (requested 1000)');
    }
  });

  it('slices a date window it reads in full at the served size', async () => {
    const pages = [
      await call({ per_page: 1000, date_range: '2020', page: 1 }),
      await call({ per_page: 1000, date_range: '2020', page: 2 }),
      await call({ per_page: 1000, date_range: '2020', page: 3 }),
    ];

    expect(pages.map(({ structured }) => structured.data.length)).toEqual([200, 200, 50]);
    expect(pages.map(({ structured }) => structured.totalPages)).toEqual([3, 3, 3]);
    expect(pages.flatMap(({ structured }) => structured.data.map((d) => d.countryCode))).toEqual(
      SERIES.map((row) => row.country.id),
    );
    expect(pages[1]?.structured.appliedFilters).toMatchObject({
      perPage: 200,
      requestedPerPage: 1000,
    });
  });
});
