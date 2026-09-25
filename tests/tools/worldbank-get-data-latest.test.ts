/**
 * @fileoverview worldbank_get_data's standard-endpoint reads as a client receives
 * them: the tool runs against the real WorldBankApiService with only `fetch`
 * stubbed by a fake Indicators API that answers `date`, `mrv`, `mrnev`, and
 * paging the way the live one does. The fake can also model the origin's
 * response cache, which keys a data response by country path, `per_page`,
 * `date`, and `page` and ignores `mrv`, `mrnev`, and `frequency`, and it can
 * answer a request with a polluted body. Covers the request shape every data
 * read carries, the read check and its one re-read, `mrnev` and the local `mrv`,
 * paging over the reduced set, and `lastUpdated`.
 * @module tests/tools/worldbank-get-data-latest.test
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

// ─── Fake Indicators API ──────────────────────────────────────────────────────

type Entity = {
  iso3: string;
  iso2: string;
  name: string;
  aggregate?: boolean;
  /** Returned under `all` alone: the country path reads its code as another entity's. */
  allOnly?: boolean;
  /** Value by period; a period the series carries but this map lacks is null. */
  values: Record<string, number>;
};

type Series = {
  name: string;
  lastUpdated: string;
  /** Every period the series carries, newest first. */
  periods: string[];
  entities: Entity[];
};

/** Years from `last` down to `first`, newest first. */
function years(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, i) => String(last - i));
}

/** A value for every year from `first` to `last`, with `overrides` on top. */
function valuesFor(first: number, last: number, seed: number, overrides = {}) {
  const values: Record<string, number> = {};
  for (let year = first; year <= last; year++) values[year] = seed * 1000 + (year - 1900);
  return { ...values, ...overrides };
}

/** NY.GDP.PCAP.CD, cut to the economies these tests name; headline values as of 2026-09-25. */
const GDP: Series = {
  name: 'GDP per capita (current US$)',
  lastUpdated: '2026-07-13',
  periods: years(1960, 2025),
  entities: [
    {
      iso3: 'AFG',
      iso2: 'AF',
      name: 'Afghanistan',
      values: valuesFor(1960, 2024, 1, { 2024: 374.38 }),
    },
    {
      iso3: 'BRA',
      iso2: 'BR',
      name: 'Brazil',
      values: valuesFor(1960, 2025, 2, { 2025: 10713.29 }),
    },
    {
      iso3: 'ERI',
      iso2: 'ER',
      name: 'Eritrea',
      values: valuesFor(1992, 2011, 3, { 2011: 688.68, 2010: 642.51 }),
    },
    {
      iso3: 'GIN',
      iso2: 'GN',
      name: 'Guinea',
      values: valuesFor(1960, 2025, 4, { 2025: 1098.14 }),
    },
    {
      iso3: 'SSD',
      iso2: 'SS',
      name: 'South Sudan',
      values: valuesFor(2008, 2015, 5, { 2015: 1080.15, 2014: 1322.62 }),
    },
    {
      iso3: 'URY',
      iso2: 'UY',
      name: 'Uruguay',
      values: valuesFor(1960, 2025, 6, { 2025: 19374.52 }),
    },
    {
      iso3: 'VEN',
      iso2: 'VE',
      name: 'Venezuela, RB',
      values: valuesFor(1960, 2025, 7, { 2025: 3494.81 }),
    },
    { iso3: 'XKX', iso2: 'XK', name: 'Kosovo', values: {} },
    { iso3: 'WLD', iso2: '1W', name: 'World', aggregate: true, values: valuesFor(1960, 2025, 8) },
  ],
};

/**
 * 300 synthetic economies over 1990–2025, larger than one served page once
 * reduced. Five of them stop reporting in 2006, outside any ten-year window.
 */
const WIDE: Series = {
  name: 'Population, total',
  lastUpdated: '2026-07-13',
  periods: years(1990, 2025),
  entities: Array.from({ length: 300 }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    const lastYear = i < 5 ? 2006 : 2025;
    return {
      iso3: `E${n}`,
      iso2: `E${n}`,
      name: `Economy ${n}`,
      values: valuesFor(1990, lastYear, i),
    };
  }),
};

/**
 * A series whose entities a code does not tell apart, as Doing Business and Human
 * Capital Index send them: China and two of its cities all as `CN` / `CHN` (the
 * country path reads `CHN` as China alone), and two economies with no code at all.
 * Beijing and Nauru stop reporting before any ten-year window.
 */
const SHARED_CODES: Series = {
  name: 'Enforcing contracts: Attorney fees (% of claim)',
  lastUpdated: '2019-10-23',
  periods: years(2004, 2020),
  entities: [
    { iso3: 'CHN', iso2: 'CN', name: 'China', values: valuesFor(2004, 2020, 10) },
    {
      iso3: 'CHN',
      iso2: 'CN',
      name: 'Beijing',
      allOnly: true,
      values: valuesFor(2004, 2008, 11),
    },
    {
      iso3: 'CHN',
      iso2: 'CN',
      name: 'Shanghai',
      allOnly: true,
      values: valuesFor(2004, 2020, 12),
    },
    { iso3: '', iso2: '', name: 'Gibraltar', allOnly: true, values: valuesFor(2004, 2020, 13) },
    { iso3: '', iso2: '', name: 'Nauru', allOnly: true, values: valuesFor(2004, 2005, 14) },
  ],
};

/** The same layout with every entity coded, so Beijing is the only one short. */
const CITIES: Series = {
  ...SHARED_CODES,
  name: 'Enforcing contracts: Time (days)',
  entities: [
    ...SHARED_CODES.entities.filter((e) => e.iso3 !== ''),
    { iso3: 'BRA', iso2: 'BR', name: 'Brazil', values: valuesFor(2004, 2020, 15) },
  ],
};

const SERIES: Record<string, Series> = {
  'NY.GDP.PCAP.CD': GDP,
  'SP.POP.TOTL': WIDE,
  'ENF.CONT.COEN.ATDR': SHARED_CODES,
  'ENF.CONT.DURS.DY': CITIES,
};

/** The country listing behind isAggregate, carrying the GDP economies. */
const LISTING = [
  { page: 1, pages: 1, per_page: '10000', total: GDP.entities.length },
  GDP.entities.map((e) => ({
    id: e.iso3,
    iso2Code: e.iso2,
    name: e.name,
    region: e.aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'SSF', value: 'Region' },
    incomeLevel: e.aggregate ? { id: 'NA', value: 'Aggregates' } : { id: 'LIC', value: 'Low' },
    lendingType: {},
    capitalCity: '',
    longitude: '',
    latitude: '',
  })),
];

/** The envelope the live API answers a request with no rows in scope with. */
const EMPTY_ENVELOPE = [
  { page: 0, pages: 0, per_page: 0, total: 0, sourceid: null, lastupdated: null },
  null,
];

type RawRow = {
  indicator: { id: string; value: string };
  country: { id: string; value: string };
  countryiso3code: string;
  date: string;
  value: number | null;
  unit: string;
  obs_status: string;
  decimal: number;
};

function rawRow(indicatorId: string, series: Series, entity: Entity, period: string): RawRow {
  return {
    indicator: { id: indicatorId, value: series.name },
    country: { id: entity.iso2, value: entity.name },
    countryiso3code: entity.iso3,
    date: period,
    value: entity.values[period] ?? null,
    unit: '',
    obs_status: '',
    decimal: 1,
  };
}

/**
 * Every row of a data request before paging, as the live API computes it: a
 * `date` window selects the periods inside it, or the whole series when none
 * is; `mrv` wins over `date` and keeps the N latest periods holding a value
 * for any entity; `mrnev` keeps each entity's N latest non-null periods.
 */
function rowsFor(url: URL, indicatorId: string, codes: string[]): RawRow[] {
  const series = SERIES[indicatorId];
  if (!series) throw new Error(`fake has no series ${indicatorId}`);
  const entities =
    codes.length === 1 && codes[0]?.toLowerCase() === 'all'
      ? series.entities
      : codes.flatMap((code) => {
          const upper = code.toUpperCase();
          return series.entities.filter(
            (e) => !e.allOnly && (e.iso3 === upper || e.iso2 === upper),
          );
        });
  const params = url.searchParams;
  const mrv = Number(params.get('mrv') ?? 0);
  const mrnev = Number(params.get('mrnev') ?? 0);
  if (mrv > 0) {
    const kept = series.periods
      .filter((p) => entities.some((e) => e.values[p] !== undefined))
      .slice(0, mrv);
    return entities.flatMap((e) => kept.map((p) => rawRow(indicatorId, series, e, p)));
  }
  if (mrnev > 0) {
    return entities.flatMap((e) =>
      series.periods
        .filter((p) => e.values[p] !== undefined)
        .slice(0, mrnev)
        .map((p) => rawRow(indicatorId, series, e, p)),
    );
  }
  const date = params.get('date');
  let periods = series.periods;
  if (date) {
    const [start = '', end = start] = date.split(':');
    const inside = periods.filter((p) => p >= start && p <= end);
    if (inside.length > 0) periods = inside;
  }
  return entities.flatMap((e) => periods.map((p) => rawRow(indicatorId, series, e, p)));
}

/** A page of `rows` as the live API envelopes it. */
function envelope(rows: RawRow[], page: number, perPage: number, lastUpdated: string) {
  if (rows.length === 0) return EMPTY_ENVELOPE;
  return [
    {
      page,
      pages: Math.ceil(rows.length / perPage),
      per_page: perPage,
      total: rows.length,
      sourceid: '2',
      lastupdated: lastUpdated,
    },
    rows.slice((page - 1) * perPage, page * perPage),
  ];
}

const fetchMock = vi.fn<typeof fetch>();

/** Data requests received, in order. */
let dataRequests: URL[] = [];
/**
 * Bodies to answer the next data requests with, first in first out, ahead of the
 * fake's own; an `undefined` slot lets that request through to the fake.
 */
let polluted: unknown[] = [];
/** The origin's response cache, when modelled: key → body. */
let originCache: Map<string, unknown> | undefined;

/** What the origin keys a data response by: every parameter but `mrv`, `mrnev`, and `frequency`. */
function originKey(url: URL): string {
  const kept = [...url.searchParams].filter(([k]) => !['mrv', 'mrnev', 'frequency'].includes(k));
  kept.sort(([a], [b]) => a.localeCompare(b));
  return `${decodeURIComponent(url.pathname)}?${kept.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

function serve() {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/v2/country') return Response.json(LISTING);
    const match = /^\/v2\/country\/([^/]+)\/indicator\/([^/]+)$/.exec(url.pathname);
    if (!match?.[1] || !match[2]) throw new Error(`unmocked fetch: ${url.href}`);
    dataRequests.push(url);
    const pollutedBody = polluted.shift();
    if (pollutedBody !== undefined) return Response.json(pollutedBody);

    const key = originKey(url);
    const cached = originCache?.get(key);
    if (cached) return Response.json(cached);

    const indicatorId = decodeURIComponent(match[2]);
    const rows = rowsFor(url, indicatorId, decodeURIComponent(match[1]).split(';'));
    const body = envelope(
      rows,
      Number(url.searchParams.get('page') ?? 1),
      Number(url.searchParams.get('per_page') ?? 50),
      SERIES[indicatorId]?.lastUpdated ?? '',
    );
    originCache?.set(key, body);
    return Response.json(body);
  });
}

/** A body carrying one row per listed economy at the given periods, as a polluting request would get. */
function bodyAt(indicatorId: string, cells: Array<[iso3: string, period: string]>) {
  const series = SERIES[indicatorId] as Series;
  const rows = cells.map(([iso3, period]) =>
    rawRow(indicatorId, series, series.entities.find((e) => e.iso3 === iso3) as Entity, period),
  );
  return envelope(rows, 1, 50, series.lastUpdated);
}

// ─── Calling the tool ─────────────────────────────────────────────────────────

type Row = { countryIso3: string; date: string; value: number | null };
type Structured = {
  data: Row[];
  appliedFilters: Record<string, unknown>;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  lastUpdated?: string;
  notice?: string;
  error?: { code: number; data?: Record<string, unknown> };
};

async function call(args: Record<string, unknown>) {
  const result = await runToolContract(
    worldbankGetData,
    { indicator_id: 'NY.GDP.PCAP.CD', ...args } as never,
    { context: { errors: worldbankGetData.errors } },
  );
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  return { isError: result.isError, structured: result.structuredContent as Structured, text };
}

/** A result's rows as `ISO3 period value`, in served order. */
function cells(rows: Row[]): string[] {
  return rows.map((r) => `${r.countryIso3} ${r.date} ${r.value}`);
}

/** The rows the fake holds for these economies and periods, as `cells` renders them. */
function truth(series: Series, iso3s: string[], periods: string[]): string[] {
  return iso3s.flatMap((iso3) => {
    const entity = series.entities.find((e) => e.iso3 === iso3) as Entity;
    return periods.map((p) => `${iso3} ${p} ${entity.values[p] ?? null}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  dataRequests = [];
  polluted = [];
  originCache = undefined;
  initWorldBankApiService({} as never, createInMemoryStorage());
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Characterization: the default call ───────────────────────────────────────

describe('a call with neither date_range nor mrv', () => {
  it('returns the whole series in upstream order, paged at the served size with the same totals', async () => {
    const pages = [await call({ countries: 'BR;ER' }), await call({ countries: 'BR;ER', page: 2 })];
    const third = await call({ countries: 'BR;ER', page: 3 });

    const all = truth(GDP, ['BRA', 'ERI'], GDP.periods);
    expect(cells(pages[0]?.structured.data ?? [])).toEqual(all.slice(0, 50));
    expect(cells(pages[1]?.structured.data ?? [])).toEqual(all.slice(50, 100));
    expect(cells(third.structured.data)).toEqual(all.slice(100));
    for (const { structured } of [...pages, third]) {
      expect(structured).toMatchObject({ totalCount: 132, totalPages: 3 });
    }
  });

  it('reads only the page asked for: one request at the served size over the full span', async () => {
    await call({ countries: 'BR;ER' });
    await call({ countries: 'BR;ER', page: 2, per_page: 1000 });

    expect(
      dataRequests.map((url) =>
        ['date', 'page', 'per_page'].map((k) => url.searchParams.get(k)).join(' '),
      ),
    ).toEqual(['1900:2100 1 50', '1900:2100 2 200']);
  });

  it('maps page N to upstream page N, serving its rows and upstream totals', async () => {
    const { structured } = await call({ countries: 'BR;ER', page: 2 });

    expect(dataRequests).toHaveLength(1);
    expect(dataRequests[0]?.searchParams.get('page')).toBe('2');
    expect(cells(structured.data)).toEqual(truth(GDP, ['BRA', 'ERI'], GDP.periods).slice(50, 100));
    expect(structured).toMatchObject({ totalCount: 132, totalPages: 3, currentPage: 2 });
  });

  it('carries the past-end notice from upstream totals on a page after the last', async () => {
    const { structured } = await call({ countries: 'BR;ER', page: 4 });

    expect(dataRequests).toHaveLength(1);
    expect(structured).toMatchObject({ data: [], totalCount: 132, totalPages: 3 });
    expect(structured.notice).toMatch(/^Page 4 is past the end of the results/);
  });
});

// ─── #66: what every data read carries ────────────────────────────────────────

describe('standard-endpoint data requests', () => {
  it.each([
    ['mrv', { mrv: 1 }],
    ['mrnev', { mrnev: 1 }],
    ['no date_range or mrv', {}],
    ['date_range', { date_range: '2018:2020' }],
  ])('carry date and never mrv, mrnev, or frequency (%s)', async (_label, args) => {
    await call({ countries: 'BR;ER;SS;VE', ...args });

    expect(dataRequests.length).toBeGreaterThan(0);
    for (const url of dataRequests) {
      expect(url.searchParams.get('date')).toBeTruthy();
      expect(url.searchParams.has('mrv')).toBe(false);
      expect(url.searchParams.has('mrnev')).toBe(false);
      expect(url.searchParams.has('frequency')).toBe(false);
    }
  });

  it('sends the full span for a call with neither date_range nor mrv', async () => {
    await call({ countries: 'BR' });
    expect(dataRequests.map((url) => url.searchParams.get('date'))).toEqual(['1900:2100']);
  });

  it('reads a window over a series that spans it with one request', async () => {
    const { structured } = await call({ countries: 'BR;ER;SS;VE', mrv: 1 });

    expect(dataRequests).toHaveLength(1);
    expect(dataRequests[0]?.searchParams.get('date')).toBe(
      `${new Date().getUTCFullYear() - 10}:2100`,
    );
    expect(cells(structured.data)).toEqual([
      'BRA 2025 10713.29',
      'ERI 2025 null',
      'SSD 2025 null',
      'VEN 2025 3494.81',
    ]);
  });
});

describe('results that do not depend on earlier calls (origin cache modelled)', () => {
  beforeEach(() => {
    originCache = new Map();
  });

  it('serves a call with neither date_range nor mrv its whole series after an mrv call', async () => {
    await call({ countries: 'AF;GN;UY', mrv: 1 });
    const { structured } = await call({ countries: 'AF;GN;UY' });
    expect(structured.totalCount).toBe(3 * 66);
  });

  it.each([
    ['mrv then mrnev', [{ mrv: 1 }, { mrnev: 1 }]],
    ['mrnev then mrv', [{ mrnev: 1 }, { mrv: 1 }]],
  ])('returns each call its own rows: %s', async (_label, sequence) => {
    const results = [];
    for (const args of sequence) results.push(await call({ countries: 'AF;GN;UY', ...args }));

    const own = (args: Record<string, unknown>) =>
      'mrv' in args
        ? ['AFG 2025 null', 'GIN 2025 1098.14', 'URY 2025 19374.52']
        : ['AFG 2024 374.38', 'GIN 2025 1098.14', 'URY 2025 19374.52'];
    expect(results.map((r) => cells(r.structured.data))).toEqual(sequence.map(own));
  });

  it("heals a third party's mrv body on the window read's key through the widen read", async () => {
    // The body a request adding mrv=1 to the window read's own URL leaves in the cache.
    polluted.push(
      bodyAt('NY.GDP.PCAP.CD', [
        ['BRA', '2025'],
        ['ERI', '2025'],
        ['SSD', '2025'],
        ['VEN', '2025'],
      ]),
    );
    const { structured } = await call({ countries: 'BR;ER;SS;VE', mrnev: 1 });
    expect(cells(structured.data)).toEqual([
      'BRA 2025 10713.29',
      'ERI 2011 688.68',
      'SSD 2015 1080.15',
      'VEN 2025 3494.81',
    ]);
  });
});

// ─── #66: the read check ──────────────────────────────────────────────────────

describe('a read answered with a polluted body', () => {
  it('re-reads a window answered with one row per country at 2025, at another per_page', async () => {
    const fresh = await call({ countries: 'AF;GN;UY', date_range: '2018:2020' });
    dataRequests = [];
    polluted.push(
      bodyAt('NY.GDP.PCAP.CD', [
        ['AFG', '2025'],
        ['GIN', '2025'],
        ['URY', '2025'],
      ]),
    );

    const { structured, text } = await call({ countries: 'AF;GN;UY', date_range: '2018:2020' });

    expect(cells(structured.data)).toEqual(cells(fresh.structured.data));
    expect(cells(structured.data)).toEqual(
      truth(GDP, ['AFG', 'GIN', 'URY'], ['2020', '2019', '2018']),
    );
    expect(dataRequests).toHaveLength(2);
    const [first, second] = dataRequests.map((url) => url.searchParams);
    expect(second?.get('date')).toBe(first?.get('date'));
    expect(second?.get('per_page')).not.toBe(first?.get('per_page'));
    expect(text).toContain('**2020:**');
  });

  it('re-reads an mrv window answered with an mrnev body whose countries sit at different periods', async () => {
    polluted.push(
      bodyAt('NY.GDP.PCAP.CD', [
        ['AFG', '2024'],
        ['GIN', '2025'],
        ['URY', '2025'],
      ]),
    );
    const { structured } = await call({ countries: 'AF;GN;UY', mrv: 1 });

    expect(cells(structured.data)).toEqual([
      'AFG 2025 null',
      'GIN 2025 1098.14',
      'URY 2025 19374.52',
    ]);
    expect(dataRequests).toHaveLength(2);
  });

  it('re-reads a read answered with an empty envelope', async () => {
    polluted.push(EMPTY_ENVELOPE);
    const { structured } = await call({ countries: 'BR;ER', date_range: '1960:2025' });

    expect(structured.totalCount).toBe(132);
    expect(dataRequests).toHaveLength(2);
  });

  it('re-reads a widened read that lacks a period the window read returned', async () => {
    // The window read is clean; the widen read for ER and SS gets an mrv=1-shaped body.
    polluted.push(
      undefined,
      bodyAt('NY.GDP.PCAP.CD', [
        ['ERI', '2025'],
        ['SSD', '2025'],
      ]),
    );
    const { structured } = await call({ countries: 'BR;ER;SS;VE', mrnev: 1 });

    expect(cells(structured.data)).toEqual([
      'BRA 2025 10713.29',
      'ERI 2011 688.68',
      'SSD 2015 1080.15',
      'VEN 2025 3494.81',
    ]);
    expect(dataRequests).toHaveLength(3);
  });

  it('fails as upstream_inconsistent, never serving either body, when the re-read is suspect too', async () => {
    polluted.push(
      bodyAt('NY.GDP.PCAP.CD', [
        ['AFG', '2025'],
        ['GIN', '2025'],
        ['URY', '2025'],
      ]),
      bodyAt('NY.GDP.PCAP.CD', [
        ['AFG', '2024'],
        ['GIN', '2025'],
        ['URY', '2025'],
      ]),
    );
    const { isError, structured, text } = await call({
      countries: 'AF;GN;UY',
      date_range: '2018:2020',
    });

    expect(isError).toBe(true);
    expect(structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_inconsistent', recovery: { hint: expect.any(String) } },
    });
    expect(text).toMatch(/upstream_inconsistent/);
    expect(text).toMatch(/Recovery:/);
    expect(dataRequests).toHaveLength(2);
  });

  it('serves an honest empty result once the re-read matches it', async () => {
    const { isError, structured } = await call({
      countries: 'XKX',
      date_range: '2018:2020',
      indicator_id: 'SP.POP.TOTL',
    });

    expect(isError).toBeFalsy();
    expect(structured).toMatchObject({ data: [], totalCount: 0 });
    expect(structured.lastUpdated).toBeUndefined();
    expect(dataRequests).toHaveLength(2);
  });

  it('serves a zero-overlap window as empty once the re-read matches the whole series upstream returned', async () => {
    const { structured } = await call({ countries: 'BR', date_range: '1850:1900' });

    expect(structured).toMatchObject({ data: [], totalCount: 0 });
    expect(structured.notice).toMatch(/No observations fall inside date_range "1850:1900"/);
    expect(dataRequests).toHaveLength(2);
  });
});

// ─── #43: mrnev and the local mrv ─────────────────────────────────────────────

describe('mrnev', () => {
  it("returns each country's latest non-empty value from two data requests, on both surfaces", async () => {
    const { structured, text } = await call({ countries: 'BR;ER;SS;VE', mrnev: 1 });

    expect(cells(structured.data)).toEqual([
      'BRA 2025 10713.29',
      'ERI 2011 688.68',
      'SSD 2015 1080.15',
      'VEN 2025 3494.81',
    ]);
    expect(dataRequests).toHaveLength(2);
    expect(decodeURIComponent(dataRequests[1]?.pathname ?? '')).toContain('/country/ERI;SSD/');
    expect(dataRequests[1]?.searchParams.get('date')).toBe('1900:2100');
    expect(structured.appliedFilters).toMatchObject({ mrnev: 1 });
    expect(structured.appliedFilters).not.toHaveProperty('mrv');
    expect(text).toContain('mrnev=1');
    expect(text).toContain('**2011:** 688.68');
  });

  it('returns N rows per country, none null, and none for a country with no value in the series', async () => {
    const { structured } = await call({ countries: 'BR;ER;SS;VE;XK', mrnev: 2 });

    expect(cells(structured.data)).toEqual([
      'BRA 2025 10713.29',
      `BRA 2024 ${GDP.entities[1]?.values['2024']}`,
      'ERI 2011 688.68',
      'ERI 2010 642.51',
      'SSD 2015 1080.15',
      'SSD 2014 1322.62',
      'VEN 2025 3494.81',
      `VEN 2024 ${GDP.entities[6]?.values['2024']}`,
    ]);
    expect(structured.data.some((r) => r.value === null)).toBe(false);
  });

  it.each([
    ['date_range', { date_range: '2018:2020' }],
    ['mrv', { mrv: 2 }],
  ])('is rejected with %s as invalid_params before any request', async (_label, args) => {
    const { isError, structured } = await call({ countries: 'BR', mrnev: 1, ...args });

    expect(isError).toBe(true);
    expect(structured.error).toMatchObject({ data: { reason: 'invalid_params' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, 101])('fails the schema at %i before any request', async (mrnev) => {
    const { isError, structured } = await call({ countries: 'BR', mrnev });

    expect(isError).toBe(true);
    expect(structured.error).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pages a reduced set larger than one page contiguously, with the same totals on every page', async () => {
    const pages = [];
    for (let page = 1; page <= 5; page++) {
      dataRequests = [];
      pages.push(
        await call({
          indicator_id: 'SP.POP.TOTL',
          countries: 'all',
          mrnev: 3,
          per_page: 1000,
          page,
        }),
      );
      // Every page rebuilds the reduced set: the window read and one widen read for the five short economies.
      expect(dataRequests).toHaveLength(2);
    }

    for (const { structured } of pages) {
      expect(structured).toMatchObject({ totalCount: 900, totalPages: 5 });
      expect(structured.appliedFilters).toMatchObject({ perPage: 200, requestedPerPage: 1000 });
    }
    expect(pages.map(({ structured }) => structured.data.length)).toEqual([
      200, 200, 200, 200, 100,
    ]);
    const served = pages.flatMap(({ structured }) => cells(structured.data));
    expect(new Set(served).size).toBe(900);
    expect(served.slice(0, 3)).toEqual(truth(WIDE, ['E001'], ['2006', '2005', '2004']));
    expect(served.slice(-3)).toEqual(truth(WIDE, ['E300'], ['2025', '2024', '2023']));
  });

  it('carries the past-end notice on the page after the last', async () => {
    const { structured, text } = await call({
      indicator_id: 'SP.POP.TOTL',
      countries: 'all',
      mrnev: 3,
      per_page: 200,
      page: 6,
    });

    expect(structured).toMatchObject({ data: [], totalCount: 900, currentPage: 6, totalPages: 5 });
    expect(structured.notice).toMatch(
      /^Page 6 is past the end of the results — 900 observations span 5 pages/,
    );
    expect(text).toContain('Page 6 is past the end of the results');
  });
});

describe('mrv, computed locally', () => {
  it('keeps every country at the latest period holding a value, nulls included, from one request', async () => {
    const { structured, text } = await call({
      countries: 'all',
      indicator_id: 'SP.POP.TOTL',
      mrv: 1,
      per_page: 200,
    });

    expect(structured).toMatchObject({ totalCount: 300, totalPages: 2 });
    expect(structured.data.slice(0, 2).map((r) => `${r.countryIso3} ${r.date} ${r.value}`)).toEqual(
      ['E001 2025 null', 'E002 2025 null'],
    );
    expect(dataRequests).toHaveLength(1);
    expect(text).toContain('mrv=1');
  });

  it('widens the whole list when the window holds fewer than N periods with a value', async () => {
    const { structured } = await call({ countries: 'ER;SS', mrv: 2 });

    expect(cells(structured.data)).toEqual([
      'ERI 2015 null',
      'ERI 2014 null',
      'SSD 2015 1080.15',
      'SSD 2014 1322.62',
    ]);
    expect(dataRequests).toHaveLength(2);
    expect(decodeURIComponent(dataRequests[1]?.pathname ?? '')).toContain('/country/ER;SS/');
  });
});

describe('entities a code does not tell apart', () => {
  const named = (rows: Row[]) =>
    rows.map((r) => `${(r as Row & { countryName: string }).countryName} ${r.date} ${r.value}`);
  const value = (name: string, period: string) =>
    SHARED_CODES.entities.find((e) => e.name === name)?.values[period];

  it('reads the series as the honest grid it is, with one request', async () => {
    const { structured } = await call({ indicator_id: 'ENF.CONT.COEN.ATDR', countries: 'all' });

    expect(structured.totalCount).toBe(5 * 17);
    expect(dataRequests).toHaveLength(1);
  });

  it('gives each entity sharing a code, or lacking one, its own latest value under mrnev', async () => {
    const { structured } = await call({
      indicator_id: 'ENF.CONT.COEN.ATDR',
      countries: 'all',
      mrnev: 1,
    });

    expect(named(structured.data)).toEqual([
      `China 2020 ${value('China', '2020')}`,
      `Beijing 2008 ${value('Beijing', '2008')}`,
      `Shanghai 2020 ${value('Shanghai', '2020')}`,
      `Gibraltar 2020 ${value('Gibraltar', '2020')}`,
      `Nauru 2005 ${value('Nauru', '2005')}`,
    ]);
    // Nauru has no code to request it by, so the widen reads the whole list.
    expect(decodeURIComponent(dataRequests[1]?.pathname ?? '')).toContain('/country/all/');
  });

  it('widens the whole list for a short entity whose code names another', async () => {
    const { structured } = await call({
      indicator_id: 'ENF.CONT.DURS.DY',
      countries: 'all',
      mrnev: 1,
    });

    expect(named(structured.data)).toEqual([
      `China 2020 ${value('China', '2020')}`,
      `Beijing 2008 ${value('Beijing', '2008')}`,
      `Shanghai 2020 ${value('Shanghai', '2020')}`,
      `Brazil 2020 ${CITIES.entities.at(-1)?.values['2020']}`,
    ]);
    // `CHN` would read China alone, so Beijing is reachable only under `all`.
    expect(decodeURIComponent(dataRequests[1]?.pathname ?? '')).toContain('/country/all/');
  });
});

/** The page the API's web server answers HTTP 400 with, intermittently, for a request that is fine. */
const REQUEST_ERROR_PAGE =
  '<?xml version="1.0" encoding="utf-8"?>\r\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\r\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml">\r\n  <head>\r\n    <title>Request Error</title>\r\n  </head>\r\n  <body>\r\n    <div id="content">\r\n' +
  '      <p class="heading1">Request Error</p>\r\n      <p>The server encountered an error processing the request. See server logs for more details.</p>\r\n' +
  '    </div>\r\n  </body>\r\n</html>';

describe('an HTTP 400 answered with the "Request Error" page', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const badRequest = (body: string, type: string) =>
    new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': type },
    });

  it('is retried, and the call succeeds when the retry is answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockImplementationOnce(async () => badRequest(REQUEST_ERROR_PAGE, 'text/html'));

    const pending = call({ countries: 'BR;ER', date_range: '2018:2020' });
    await vi.advanceTimersByTimeAsync(10_000);
    const { isError, structured } = await pending;

    expect(isError).toBeFalsy();
    expect(cells(structured.data)).toEqual(truth(GDP, ['BRA', 'ERI'], ['2020', '2019', '2018']));
    expect(dataRequests).toHaveLength(1); // the fake records the answered request only
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/indicator/'))).toHaveLength(2);
  });

  it('ends as ServiceUnavailable with the attempts on the wire when every attempt gets it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/indicator/')
        ? badRequest(REQUEST_ERROR_PAGE, 'text/html')
        : Response.json(LISTING),
    );

    const pending = call({ countries: 'BR;ER', date_range: '2018:2020' });
    await vi.advanceTimersByTimeAsync(60_000);
    const { isError, structured } = await pending;

    expect(isError).toBe(true);
    expect(structured.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryAttempts: 4, status: 400 },
    });
  });

  it('keeps the invalid-params mapping, unretried, for a 400 carrying anything else', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/indicator/')
        ? badRequest('{"error":"bad"}', 'application/json')
        : Response.json(LISTING),
    );

    const { isError, structured } = await call({ countries: 'BR;ER', date_range: '2018:2020' });

    expect(isError).toBe(true);
    expect(structured.error).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/indicator/'))).toHaveLength(1);
  });
});

describe('a data request the origin stalls on', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is abandoned and retried within seconds when it reads listed countries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The first data request never answers until it is aborted; the retry is served normally.
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    let settled = false;
    const pending = call({ countries: 'BR;ER', date_range: '2018:2020' }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(settled).toBe(true);
    const { isError, structured } = await pending;
    expect(isError).toBeFalsy();
    expect(cells(structured.data)).toEqual(truth(GDP, ['BRA', 'ERI'], ['2020', '2019', '2018']));
  });
});

// ─── #43: data vintage ────────────────────────────────────────────────────────

describe('lastUpdated', () => {
  it("carries the serving envelope's last update on both surfaces", async () => {
    const { structured, text } = await call({ countries: 'BR', mrnev: 1 });

    expect(structured.lastUpdated).toBe('2026-07-13');
    expect(text).toContain('2026-07-13');
  });
});
