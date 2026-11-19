/**
 * @fileoverview worldbank_get_data's served page size as a client receives it:
 * the tool runs against the real WorldBankApiService with only `fetch` stubbed,
 * so the cap, the upstream `per_page`, the local slice of rows read in full (a
 * date window, a latest-value selection, a source-scoped scope), and the
 * disclosure on both surfaces all execute before anything is asserted. The page
 * maximum is 4,000 observations.
 * @module tests/tools/worldbank-get-data-page-cap.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { initWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

const config = vi.hoisted(() => ({
  apiBaseUrl: 'https://api.worldbank.org/v2',
  defaultPerPage: 50,
  clampLimits: true,
  catalogCacheTtlMs: 60_000,
}));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * 4,500 one-year observations, one per synthetic economy, in upstream order:
 * a full 4,000-row page and 500 more.
 */
const SERIES = Array.from({ length: 4500 }, (_, i) => {
  const iso2 = `C${String(i + 1).padStart(4, '0')}`;
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

/** Source 68's economies, its years newest first, and its two Classification values. */
const SOURCE_ECONOMIES = Array.from({ length: 50 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { id: `E${n}`, name: `Economy ${n}` };
});
const SOURCE_YEARS = Array.from({ length: 45 }, (_, i) => String(2024 - i));
const CLASSIFICATIONS = [
  { id: 'PUB', label: 'Public' },
  { id: 'PRV', label: 'Private' },
];

/**
 * Every row of source 68's scope, 50 × 45 × 2 = 4,500, as `economy|year|classification`
 * in the order the tool serves them: by economy name, newest year first, then
 * the Classification listing's own order.
 */
const SOURCE_ORDER = SOURCE_ECONOMIES.flatMap((economy) =>
  SOURCE_YEARS.flatMap((year) => CLASSIFICATIONS.map((c) => `${economy.id}|${year}|${c.id}`)),
);

/** A source-scoped value listing (`/v2/sources/68/{concept}`). */
function listing(concept: string, variables: ReadonlyArray<{ id: string; value: string }>) {
  return {
    page: 1,
    pages: 1,
    per_page: 10_000,
    total: variables.length,
    source: [{ id: '68', name: 'PEFA 2016', concept: [{ id: concept, variable: variables }] }],
  };
}

/**
 * Source 68 (PEFA 2016) as the source-scoped API publishes it: Country, Series,
 * Time, and a Classification with two values, so `PI-01` read without a
 * `dimension_value` returns every value with each row labelled. The data
 * request answers the whole scope in reverse of the order the tool serves.
 */
const SOURCE_BODIES = {
  '/v2/source/68': [
    { page: 1, pages: 1, per_page: 50, total: 1 },
    [{ id: '68', name: 'PEFA 2016' }],
  ],
  '/v2/sources/68/concepts': {
    page: 1,
    pages: 1,
    source: [
      {
        id: '68',
        name: 'PEFA 2016',
        concept: ['Country', 'Classification', 'Series', 'Time'].map((id) => ({ id, value: id })),
      },
    ],
  },
  '/v2/source/68/indicator/PI-01': [
    { page: 1, pages: 1, per_page: 10_000, total: 1 },
    [
      {
        id: 'PI-01',
        name: 'PI-1 Aggregate expenditure out-turn',
        source: { id: '68', value: 'PEFA 2016' },
        sourceNote: '',
        topics: [],
      },
    ],
  ],
  '/v2/sources/68/classification': listing(
    'Classification',
    CLASSIFICATIONS.map((c) => ({ id: c.id, value: c.label })),
  ),
  '/v2/sources/68/country': listing(
    'Country',
    SOURCE_ECONOMIES.map((e) => ({ id: e.id, value: e.name })),
  ),
  '/v2/sources/68/time': listing(
    'Time',
    SOURCE_YEARS.map((year) => ({ id: `YR${year}`, value: year })),
  ),
  '/v2/sources/68/country/all/series/PI-01': {
    page: 1,
    pages: 1,
    per_page: 10_000,
    total: SOURCE_ORDER.length,
    lastupdated: '2025-12-01',
    source: {
      id: '68',
      name: 'PEFA 2016',
      data: [...SOURCE_ORDER].reverse().map((key, i) => {
        const [id, year, classification] = key.split('|');
        const economy = SOURCE_ECONOMIES.find((e) => e.id === id);
        const value = CLASSIFICATIONS.find((c) => c.id === classification);
        return {
          variable: [
            { concept: 'Classification', id: classification, value: value?.label },
            { concept: 'Time', id: `YR${year}`, value: year },
            { concept: 'Series', id: 'PI-01', value: 'PI-1' },
            { concept: 'Country', id, value: economy?.name },
          ],
          value: i,
        };
      }),
    },
  },
};
const SOURCE_ROUTES = new Map<string, unknown>(Object.entries(SOURCE_BODIES));

// ─── Network stub ─────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();

/** The `page` and `per_page` of every request to the standard data endpoint, in order. */
function dataRequests(): Array<[page: string, perPage: string]> {
  return fetchMock.mock.calls.flatMap(([input]) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    return url.pathname.startsWith('/v2/country/') && url.pathname.includes('/indicator/')
      ? [[url.searchParams.get('page') ?? '', url.searchParams.get('per_page') ?? '']]
      : [];
  });
}

/**
 * Fake upstream: the data endpoint pages {@link SERIES} by the `page` and
 * `per_page` it is sent, as the live API does, the country listing is empty,
 * and source 68 answers from {@link SOURCE_ROUTES}.
 */
function serve(series: readonly unknown[] = SERIES, sourceId: unknown = '2') {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (SOURCE_ROUTES.has(url.pathname)) return Response.json(SOURCE_ROUTES.get(url.pathname));
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

/** The observation lines `content[]` renders, one per served row (`- **2020:** 1`). */
function rowLines(text: string): string[] {
  return text.match(/^- \*\*.+$/gm) ?? [];
}

type Structured = {
  data: Array<{ countryCode: string; date: string; dimension?: { id: string; label: string } }>;
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

/** What page 3 of a 4,500-row scope at `per_page=4000` says on both surfaces. */
const PAST_END =
  'Page 3 is past the end of the results — 4500 observations span 2 pages (1–2) at per_page=4000. Keep the same filters and request a page from 1 to 2.';

/** Pages 1, 2, and 3 of one read at `per_page=4000`: a full page, the rest, and past the end. */
async function threePages(args: Record<string, unknown>) {
  const pages = [];
  for (const page of [1, 2, 3]) pages.push(await call({ ...args, per_page: 4000, page }));
  return pages;
}

/** Each page's `totalCount` and `totalPages`. */
function totalsOf(pages: ReadonlyArray<{ structured: Structured }>) {
  return pages.map(({ structured }) => [structured.totalCount, structured.totalPages]);
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
    config.clampLimits = true;
  });

  it.each([50, 199, 200, 201, 1000, 1001, 3999, 4000])(
    'serves per_page=%i without a budget reduction',
    async (size) => {
      const { structured, text } = await call({ per_page: size });
      expect(dataRequests()).toEqual([['1', String(size)]]);
      expect(structured.data).toHaveLength(size);
      expect(rowLines(text)).toHaveLength(size);
      expect(structured.appliedFilters).toMatchObject({ perPage: size });
      expect(structured.appliedFilters).not.toHaveProperty('requestedPerPage');
      expect(structured.notice).toBeUndefined();
      expect(text).toMatch(new RegExp(`, per_page=${size}$`, 'm'));
    },
  );

  it.each([
    [1, 4000],
    [2, 500],
  ])('serves per_page=4001 at 4000 and discloses it on page %i', async (page, rows) => {
    const { structured, text } = await call({ per_page: 4001, page });
    expect(dataRequests()).toEqual([[String(page), '4000']]);
    expect(structured.data).toHaveLength(rows);
    expect(rowLines(text)).toHaveLength(rows);
    expect(structured.appliedFilters).toMatchObject({ perPage: 4000, requestedPerPage: 4001 });
    expect(structured.totalPages).toBe(2);
    expect(structured.notice).toContain('per_page=4001 was reduced to 4000');
    expect(text).toContain('per_page=4000 (requested 4001)');
    expect(text).toContain('per_page=4001 was reduced to 4000');
  });

  it('discloses the maximum clamp on an empty result', async () => {
    serve([]);
    const { structured, text } = await call({ per_page: 4001 });
    expect(structured.data).toEqual([]);
    expect(structured.appliedFilters).toMatchObject({ perPage: 4000, requestedPerPage: 4001 });
    expect(structured.notice).toContain('per_page=4001 was reduced to 4000');
    expect(text).toContain('per_page=4001 was reduced to 4000');
  });

  it.each([undefined, '2020'])('pages 201 rows at a time contiguously on path %s', async (path) => {
    const series = SERIES.slice(0, 450);
    serve(series);
    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push(await call({ per_page: 201, page, ...(path && { date_range: path }) }));
    }
    const expected = series.map((row) => row.country.id);
    expect(
      pages.flatMap(({ structured }) => structured.data.map((row) => row.countryCode)),
    ).toEqual(expected);
    expect(pages[3]?.structured.data).toEqual([]);
  });

  it('reads a whole series one upstream page of 4000 per served page, contiguously', async () => {
    const pages = await threePages({});
    expect(dataRequests()).toEqual([
      ['1', '4000'],
      ['2', '4000'],
      ['3', '4000'],
    ]);
    expect(pages.map(({ structured }) => structured.data.length)).toEqual([4000, 500, 0]);
    expect(pages.map(({ text }) => rowLines(text).length)).toEqual([4000, 500, 0]);
    expect(totalsOf(pages)).toEqual(Array.from({ length: 3 }, () => [4500, 2]));
    expect(
      pages.flatMap(({ structured }) => structured.data.map((row) => row.countryCode)),
    ).toEqual(SERIES.map((row) => row.country.id));
    expect(pages[2]?.structured.notice).toBe(PAST_END);
    expect(pages[2]?.text).toContain(PAST_END);
  });

  it.each([
    ['windowed', { date_range: '2020' }],
    ['latest-value mrv', { mrv: 1 }],
    ['latest-value mrnev', { mrnev: 1 }],
  ])('slices the %s path at 4000 rows: a full page, the rest, then none', async (_path, args) => {
    const pages = await threePages(args);
    expect(pages.map(({ structured }) => structured.data.length)).toEqual([4000, 500, 0]);
    expect(pages.map(({ text }) => rowLines(text).length)).toEqual([4000, 500, 0]);
    expect(totalsOf(pages)).toEqual(Array.from({ length: 3 }, () => [4500, 2]));
    expect(
      pages.flatMap(({ structured }) => structured.data.map((row) => row.countryCode)),
    ).toEqual(SERIES.map((row) => row.country.id));
    expect(pages[0]?.text).toMatch(/, per_page=4000$/m);
    expect(pages[2]?.structured.notice).toBe(PAST_END);
  });

  it('slices the source-scoped path at 4000 rows, each carrying its dimension', async () => {
    const pages = await threePages({ source_id: '68', indicator_id: 'PI-01' });
    expect(pages.map(({ structured }) => structured.data.length)).toEqual([4000, 500, 0]);
    expect(totalsOf(pages)).toEqual(Array.from({ length: 3 }, () => [4500, 2]));
    expect(
      pages.flatMap(({ structured }) =>
        structured.data.map((row) => `${row.countryCode}|${row.date}|${row.dimension?.id}`),
      ),
    ).toEqual(SOURCE_ORDER);
    const lines = rowLines(pages[0]?.text ?? '');
    expect(lines).toHaveLength(4000);
    expect(lines.filter((line) => line.endsWith(' [PUB: Public]'))).toHaveLength(2000);
    expect(lines.filter((line) => line.endsWith(' [PRV: Private]'))).toHaveLength(2000);
    expect(pages[0]?.text).toMatch(/, per_page=4000$/m);
    expect(pages[2]?.structured.notice).toBe(PAST_END);
  });

  it('advertises and enforces the 4000 maximum under WORLDBANK_CLAMP_LIMITS=false', async () => {
    config.clampLimits = false;
    expect(z.toJSONSchema(worldbankGetData.input).properties?.per_page).toMatchObject({
      maximum: 4000,
      description: 'Results per page (default: server default, max: 4000).',
    });
    const { structured } = await call({ per_page: 4000 });
    expect(structured.data).toHaveLength(4000);
    const over = await runToolContract(worldbankGetData, {
      indicator_id: 'SP.POP.TOTL',
      countries: 'all',
      per_page: 4001,
    } as never);
    expect(over.structuredContent).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining('per_page: Too big: expected number to be <=4000'),
      },
    });
    // The rejected call sends nothing upstream.
    expect(dataRequests()).toEqual([['1', '4000']]);
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
