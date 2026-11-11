/**
 * @fileoverview worldbank_list_countries' served page size and text filter as a
 * client receives them: the tool runs against the real WorldBankApiService with
 * only `fetch` stubbed, so the cap, the upstream `per_page`, the local slice of
 * an aggregate-free or filtered listing, and the disclosure on both surfaces all
 * execute.
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
    clampLimits: true,
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

/** Upstream paths {@link serveSource} answers, cleared before each test. */
const sourceRoutes = new Map<string, unknown>();

/**
 * Fake upstream for a source entity listing — the source, its concepts, and its
 * `entities` — beside any other source served in the same test.
 */
function serveSource(
  sourceId: string,
  entities: ReadonlyArray<readonly [id: string, name: string]>,
) {
  const source = { id: sourceId, name: `Source ${sourceId}` };
  sourceRoutes.set(`/v2/source/${sourceId}`, [{ page: 1, pages: 1, total: 1 }, [source]]);
  sourceRoutes.set(`/v2/sources/${sourceId}/concepts`, {
    page: 1,
    pages: 1,
    total: 3,
    source: [
      { ...source, concept: ['Country', 'Series', 'Time'].map((id) => ({ id, value: id })) },
    ],
  });
  sourceRoutes.set(`/v2/sources/${sourceId}/country`, {
    page: 1,
    pages: 1,
    total: entities.length,
    source: [
      {
        ...source,
        concept: [
          {
            id: 'Country',
            name: 'Country',
            variable: entities.map(([id, value]) => ({ id, value })),
          },
        ],
      },
    ],
  });
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!sourceRoutes.has(url.pathname)) throw new Error(`unmocked fetch: ${url.href}`);
    return Response.json(sourceRoutes.get(url.pathname));
  });
}

/** `count` source entities `S0001`, `S0002`, … named `Entity 1`, `Entity 2`, …. */
function sourceEntities(count: number): Array<[string, string]> {
  return Array.from({ length: count }, (_, i) => [
    `S${String(i + 1).padStart(4, '0')}`,
    `Entity ${i + 1}`,
  ]);
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

/** Kenya and its eight provinces in `/v2/sources/50/country`, 2026-11-11. */
const KENYA: Array<[string, string]> = [
  ['KEN', 'Kenya'],
  ['KEN_Central_KE.CN_51325_KEN001', 'Kenya, Central'],
  ['KEN_Coast_KE.CO_51326_KEN002', 'Kenya, Coast'],
  ['KEN_Eastern_KE.EA_51327_KEN003', 'Kenya, Eastern'],
  ['KEN_Nairobi_Province_KE.NP_51328_KEN004', 'Kenya, Nairobi'],
  ['KEN_North_Eastern_KE.NE_51329_KEN005', 'Kenya, North Eastern'],
  ['KEN_Nyanza_KE.NY_51330_KEN006', 'Kenya, Nyanza'],
  ['KEN_Rift_Valley_KE.RV_51331_KEN007', 'Kenya, Rift Valley'],
  ['KEN_Western_KE.WE_51332_KEN008', 'Kenya, Western'],
];

/** A global listing entry named `name`, which upstream sometimes ends in a space. */
function named(id: string, name: string, aggregate: boolean) {
  return { ...entity(id, aggregate), name };
}

/** Three of the 14 Sub-Saharan aggregates in `/v2/country`, among two economies. */
const SUB_SAHARAN_LISTING = [
  named('AGO', 'Angola', false),
  named('DSS', 'Sub-Saharan Africa (IDA-eligible countries)', true),
  named('SSF', 'Sub-Saharan Africa ', true),
  named('SXZ', 'Sub-Saharan Africa excluding South Africa', true),
  named('ZAF', 'South Africa', false),
];

// ─── Thread-CPU timing ────────────────────────────────────────────────────────

/**
 * Thread CPU each sample accumulates. Where thread CPU is charged in 1–4 ms
 * scheduler ticks one sample can read up to 40% high, which the least of several
 * pairs and the 4× bound absorb; on macOS it is exact.
 */
const SAMPLE_FLOOR_MS = 10;

/** Per-call thread-CPU milliseconds of `run`, repeated until the sample floor is reached. */
async function sampleCpuMs(run: () => Promise<unknown>): Promise<number> {
  const start = process.threadCpuUsage();
  let runs = 0;
  let ms = 0;
  do {
    await run();
    runs++;
    const { user, system } = process.threadCpuUsage(start);
    ms = (user + system) / 1_000;
  } while (ms < SAMPLE_FLOOR_MS);
  return ms / runs;
}

/**
 * Thread CPU one call may take at `size` characters: 25 ms plus 2.5 µs a
 * character, about 14× the slowest call measured on Node (12 ms at 64k, 58 ms at
 * 320k). Testing a repeated word once per occurrence stays linear in the filter
 * but took 62 ms at 8k against the 2,034-entry listing, past the 45 ms allowed.
 */
function budgetMs(size: number): number {
  return 25 + size / 400;
}

/**
 * Asserts that the run `runAt(size)` builds grows within 4× of linear over sizes
 * doubling from `sizes[0]`, and that no call at any size reaches
 * {@link budgetMs}. Each larger size is timed in up to three pairs beside the
 * base size, alternating which goes first, and the least growth across the pairs
 * is asserted before the next size is built; the base's own first sample warms
 * the path.
 */
async function expectLinearCost(
  sizes: readonly number[],
  runAt: (size: number) => Promise<() => Promise<unknown>>,
): Promise<void> {
  const first = sizes[0] as number;
  const base = await runAt(first);
  expect(await sampleCpuMs(base), `${first} characters, one call`).toBeLessThan(budgetMs(first));
  for (const size of sizes.slice(1)) {
    const bound = (4 * size) / first;
    const run = await runAt(size);
    let least = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3 && least >= bound; pair++) {
      let baseMs: number;
      let sizeMs: number;
      if (pair % 2 === 0) {
        baseMs = await sampleCpuMs(base);
        sizeMs = await sampleCpuMs(run);
      } else {
        sizeMs = await sampleCpuMs(run);
        baseMs = await sampleCpuMs(base);
      }
      expect(sizeMs, `${size} characters, one call`).toBeLessThan(budgetMs(size));
      least = Math.min(least, sizeMs / baseMs);
    }
    expect(least, `${size} characters against ${first}`).toBeLessThan(bound);
  }
}

/** 5k → 320k: a shape that never reaches Bun's ~80k slow-regex switch can take the full span. */
const LONG_SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
/** 1k → 64k: the same 64× span, held under the slow-regex switch. */
const SHORT_SIZES = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000];

describe('worldbank_list_countries served page size, end to end', () => {
  beforeEach(() => {
    sourceRoutes.clear();
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

  it('pages a source listing contiguously and names the range past its end', async () => {
    const entities = sourceEntities(700);
    serveSource('50', entities);
    const pages = [];
    for (const page of [1, 2, 3, 4])
      pages.push(await call({ source_id: '50', per_page: 300, page }));

    expect(pages.flatMap(({ structured }) => structured.countries.map((row) => row.id))).toEqual(
      entities.map(([id]) => id),
    );
    expect(pages.map(({ structured }) => [structured.totalCount, structured.totalPages])).toEqual(
      Array.from({ length: 4 }, () => [700, 3]),
    );
    const past = pages[3];
    expect(past?.structured.notice).toBe(
      'Page 4 is past the end of the results — 700 countries span 3 pages (1–3) at per_page=300. Keep the same filters and request a page from 1 to 3.',
    );
    expect(past?.text).toContain(
      '**Applied Filters:** source_id=50, include_aggregates=false, page=4, per_page=300',
    );
  });

  // ─── filter ───────────────────────────────────────────────────────────────

  it('pages a filtered source listing at match level, past the end included', async () => {
    serveSource('50', [...sourceEntities(1_000), ...KENYA, ...sourceEntities(1_024).slice(1_000)]);
    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push(await call({ source_id: '50', filter: 'kenya', per_page: 4, page }));
    }

    expect(pages.flatMap(({ structured }) => structured.countries.map((row) => row.id))).toEqual(
      KENYA.map(([id]) => id),
    );
    expect(pages.map(({ structured }) => [structured.totalCount, structured.totalPages])).toEqual(
      Array.from({ length: 4 }, () => [9, 3]),
    );
    expect(pages[0]?.structured.countries[0]).toEqual({ id: 'KEN', name: 'Kenya', sourceId: '50' });
    expect(pages[0]?.structured.notice).toBeUndefined();
    expect(pages[3]?.structured.notice).toBe(
      'Page 4 is past the end of the results — 9 countries span 3 pages (1–3) at per_page=4. Keep the same filters and request a page from 1 to 3.',
    );
    expect(pages[3]?.text).toContain(
      '**Applied Filters:** source_id=50, filter="kenya", include_aggregates=false, page=4, per_page=4',
    );
  });

  it('serves a filtered page at the cap, with the clamp disclosed', async () => {
    serveSource('50', [...sourceEntities(400), ...KENYA]);
    const { structured, text } = await call({ source_id: '50', filter: 'entity', per_page: 301 });
    expect(structured.countries).toHaveLength(300);
    expect(structured).toMatchObject({ totalCount: 400, totalPages: 2 });
    expect(structured.appliedFilters).toMatchObject({ perPage: 300, requestedPerPage: 301 });
    expect(text).toContain(
      'filter="entity", include_aggregates=false, page=1, per_page=300 (requested 301)',
    );
    expect(text).toContain('per_page=301 was reduced to 300');
  });

  it('filters the global listing from one full read, aggregates only when asked for', async () => {
    serve(SUB_SAHARAN_LISTING);
    const withAggregates = await call({ filter: 'sub-saharan', include_aggregates: true });
    expect(withAggregates.structured.countries.map((row) => row.id)).toEqual(['DSS', 'SSF', 'SXZ']);
    expect(withAggregates.structured).toMatchObject({ totalCount: 3, totalPages: 1 });
    // The trimmed name is what both surfaces carry.
    expect(withAggregates.structured.countries).toContainEqual(
      expect.objectContaining({ id: 'SSF', name: 'Sub-Saharan Africa' }),
    );
    expect(withAggregates.text).toContain('Sub-Saharan Africa (SSF [Aggregate])');
    expect(requestSizes()).toEqual(['10000']);

    const without = await call({ filter: 'sub-saharan' });
    const notice =
      'No countries matched filter="sub-saharan". Every filter word must appear in an entry\'s id or name. Aggregates are excluded under include_aggregates=false; set include_aggregates=true to match their names and codes too.';
    expect(without.structured).toMatchObject({ countries: [], totalCount: 0, notice });
    expect(without.text).toContain(notice);
  });

  it('keeps rejecting a classification filter beside filter on a source listing', async () => {
    serveSource('50', KENYA);
    const result = await runToolContract(
      worldbankListCountries,
      { source_id: '50', filter: 'kenya', region: 'SSF' } as never,
      { context: { errors: worldbankListCountries.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'unsupported_source_filter' } },
    });
    expect(textOf(result)).toContain('unsupported_source_filter');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The filter's cost as the call grows: its words are folded and matched against
 * every entry, and the caller's text is escaped into the notice and the
 * Applied Filters line. The filter and one upstream name grow together, over a
 * listing the size of Subnational Population (2,033 entities) plus that name.
 */
describe('worldbank_list_countries filter cost', () => {
  const LISTING = [...sourceEntities(2_024), ...KENYA];
  /** U+0301, which a decomposed `é` carries after its `e`. */
  const COMBINING_ACUTE = String.fromCodePoint(0x301);

  beforeEach(() => {
    sourceRoutes.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    initWorldBankApiService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A call listing `sourceId` under `filter`, checked once before it is timed. */
  async function filtered(sourceId: string, filter: string, matches: number) {
    const run = () =>
      runToolContract(worldbankListCountries, { source_id: sourceId, filter } as never, {
        context: { errors: worldbankListCountries.errors },
      });
    const result = await run();
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Structured).totalCount).toBe(matches);
    return run;
  }

  /**
   * Each row grows the filter and the name of one more entry, `BIG`, as `shape`
   * and `name` give them; `matches` is what the filter finds in the listing
   * with that entry added. Each size is its own source, so every listing stays
   * cached beside the others.
   */
  it.each([
    ['a long digit run', LONG_SIZES, (n: number) => '1'.repeat(n), (n: number) => '1'.repeat(n), 1],
    [
      'one long line ending in a break',
      SHORT_SIZES,
      (n: number) => `${'§1 x'.repeat(n / 4)}\ny`,
      (n: number) => `${'§1 x'.repeat(n / 4)}\ny`,
      1,
    ],
    [
      'breaks throughout',
      SHORT_SIZES,
      (n: number) => `kenya${'  \r\n'.repeat(n / 4)}nairobi`,
      (n: number) => `nairobi${'  \r\n'.repeat(n / 4)}kenya`,
      2,
    ],
    // Every entry holds the word, so each tests it once per occurrence unless words are deduplicated.
    [
      'a word every entry holds, repeated',
      SHORT_SIZES,
      (n: number) => 'e '.repeat(n / 2),
      (n: number) => 'e '.repeat(n / 2),
      LISTING.length + 1,
    ],
    [
      'combining marks',
      SHORT_SIZES,
      (n: number) => `e${COMBINING_ACUTE}`.repeat(n / 2),
      (n: number) => `e${COMBINING_ACUTE}`.repeat(n / 2),
      1,
    ],
  ] as const)(
    'grows linearly in the filter and an upstream name: %s',
    async (_shape, sizes, shape, name, matches) => {
      await expectLinearCost(sizes, (size) => {
        serveSource(String(size), [...LISTING, ['BIG', name(size)]]);
        return filtered(String(size), shape(size), matches);
      });
    },
  );
});
