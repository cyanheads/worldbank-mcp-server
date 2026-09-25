/**
 * @fileoverview worldbank_get_data on series published at more than one period
 * form, as a client receives it: the tool runs against the real
 * WorldBankApiService with only `fetch` stubbed by a fake Indicators API that
 * answers a `date` window the way each source family does. Global Economic
 * Monitor answers a window at the window's own form — a year window with the
 * annual rows, a quarter or month window with rows at that form, null-filled
 * where the series lacks it. World Development Indicators and Quarterly Public
 * Sector Debt carry one form, and drop a window at any other, answering with the
 * whole series. Covers `frequency` on `mrv`, `mrnev`, and the whole series, its
 * exclusivity with `date_range`, and the notices on an all-null sub-annual window
 * and an all-null `frequency` page.
 * @module tests/tools/worldbank-get-data-frequency.test
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

type Form = 'year' | 'quarter' | 'month';

type Entity = {
  iso3: string;
  iso2: string;
  name: string;
  /** Value by period; a period the series answers but this map lacks is null. */
  values: Record<string, number>;
};

type Series = {
  name: string;
  lastUpdated: string;
  /**
   * `fill` answers a window at its own form, null-filled where the series has no
   * value (Global Economic Monitor); `drop` answers a window at a form it lacks, or
   * one overlapping none of its periods, with the whole series.
   */
  family: 'fill' | 'drop';
  /** Every period the series answers at each form, newest first. */
  calendar: Partial<Record<Form, string[]>>;
  /** Global Economic Monitor rows carry ISO3 in `country.id` and no `countryiso3code`. */
  iso3InCountryId: boolean;
  entities: Entity[];
};

const formOf = (period: string): Form =>
  period.includes('Q') ? 'quarter' : period.includes('M') ? 'month' : 'year';

/** Years from `last` down to `first`, newest first. */
function years(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, i) => String(last - i));
}

/** Quarters from `first`Q1 to `lastYear`Q`lastQuarter`, newest first. */
function quarters(first: number, lastYear: number, lastQuarter: number): string[] {
  return years(first, lastYear).flatMap((y) =>
    [4, 3, 2, 1].filter((q) => Number(y) < lastYear || q <= lastQuarter).map((q) => `${y}Q${q}`),
  );
}

/** Months from `first`M01 to `lastYear`M`lastMonth`, newest first. */
function months(first: number, lastYear: number, lastMonth: number): string[] {
  return years(first, lastYear).flatMap((y) =>
    Array.from({ length: 12 }, (_, i) => 12 - i)
      .filter((m) => Number(y) < lastYear || m <= lastMonth)
      .map((m) => `${y}M${String(m).padStart(2, '0')}`),
  );
}

/** A value for every period listed, derived from its position, with `overrides` on top. */
function valuesAt(periods: string[], seed: number, overrides: Record<string, number> = {}) {
  const values: Record<string, number> = {};
  periods.forEach((p, i) => {
    values[p] = seed * 10_000 + (periods.length - i);
  });
  return { ...values, ...overrides };
}

/** The Global Economic Monitor calendar: 2000 through 2026Q3 and 2026M08. */
const GEM_CALENDAR = {
  year: years(2000, 2026),
  quarter: quarters(2000, 2026, 3),
  month: months(2000, 2026, 8),
};

/** CPI, seasonally adjusted (Global Economic Monitor): annual and monthly, no quarters. */
const CPI: Series = {
  name: 'CPI Price, nominal, seas. adj.',
  lastUpdated: '2026-09-08',
  family: 'fill',
  calendar: GEM_CALENDAR,
  iso3InCountryId: true,
  entities: [
    {
      iso3: 'KEN',
      iso2: 'KE',
      name: 'Kenya',
      values: {
        ...valuesAt(years(2000, 2026), 1, { 2026: 283.9, 2025: 271.59, 2024: 260.97 }),
        ...valuesAt(months(2000, 2026, 7), 2, {
          '2026M07': 289.76,
          '2026M06': 288.21,
          '2026M05': 288.03,
          '2024M03': 258.96,
          '2024M02': 258.57,
          '2024M01': 258.04,
        }),
      },
    },
    {
      iso3: 'UGA',
      iso2: 'UG',
      name: 'Uganda',
      // Monthly figures stop at 2019M12, before any three-year window.
      values: {
        ...valuesAt(years(2000, 2025), 3),
        ...valuesAt(months(2000, 2019, 12), 4, { '2019M12': 190.5, '2019M11': 189.25 }),
      },
    },
    {
      // A legacy entity "all" returns, which the country path rejects by code (see LEGACY_CODES).
      iso3: 'YUG',
      iso2: 'YUG',
      name: 'Yugoslavia',
      values: { 2002: 51.25, 2001: 48.5 },
    },
  ],
};

/**
 * Codes the live country path rejects with the id-120 envelope, alone or in a
 * list, though Global Economic Monitor returns rows for them under `all`.
 */
const LEGACY_CODES = new Set(['YUG']);
const INVALID_VALUE = [
  {
    message: [
      { id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' },
    ],
  },
];

/** GDP at constant prices, seasonally adjusted (Global Economic Monitor): annual and quarterly. */
const GDP_Q: Series = {
  name: 'GDP,constant 2010 US$,millions,seas. adj.',
  lastUpdated: '2026-09-08',
  family: 'fill',
  calendar: GEM_CALENDAR,
  iso3InCountryId: true,
  entities: [
    {
      iso3: 'USA',
      iso2: 'US',
      name: 'United States',
      values: {
        // 2026 is a partial year: 2026Q1 + 2026Q2.
        ...valuesAt(years(2000, 2026), 5, { 2026: 10784586.44, 2025: 21235729.94 }),
        ...valuesAt(quarters(2000, 2026, 2), 6, {
          '2026Q2': 5402220.83,
          '2026Q1': 5382365.61,
          '2025Q4': 5354586.12,
        }),
      },
    },
  ],
};

/** Merchandise imports (Global Economic Monitor): annual, quarterly, and monthly. */
const IMPORTS: Series = {
  name: 'Merchandise Imports, current US$, millions, seas. adj.',
  lastUpdated: '2026-09-08',
  family: 'fill',
  calendar: GEM_CALENDAR,
  iso3InCountryId: true,
  entities: [
    {
      iso3: 'USA',
      iso2: 'US',
      name: 'United States',
      values: {
        // 2026 is a partial year, dated after every month and quarter inside it.
        ...valuesAt(years(2000, 2026), 7, { 2026: 1900000, 2025: 3300000 }),
        ...valuesAt(quarters(2000, 2026, 2), 8, { '2026Q2': 840000 }),
        ...valuesAt(months(2000, 2026, 7), 9, { '2026M07': 281000 }),
      },
    },
  ],
};

/** GDP per capita (World Development Indicators): annual only. */
const GDP_PC: Series = {
  name: 'GDP per capita (current US$)',
  lastUpdated: '2026-07-13',
  family: 'drop',
  calendar: { year: years(1960, 2025) },
  iso3InCountryId: false,
  entities: [
    {
      iso3: 'KEN',
      iso2: 'KE',
      name: 'Kenya',
      values: valuesAt(years(1960, 2025), 10, { 2025: 2206.13 }),
    },
  ],
};

/** Gross public sector debt (Quarterly Public Sector Debt): quarterly only. */
const DEBT: Series = {
  name: 'Gross PSD, Central Gov., All maturities, All instruments, Domestic creditors, Nominal Value, Local Currency',
  lastUpdated: '2026-09-18',
  family: 'drop',
  calendar: { quarter: quarters(1995, 2026, 1) },
  iso3InCountryId: false,
  entities: [
    {
      iso3: 'CHL',
      iso2: 'CL',
      name: 'Chile',
      values: valuesAt(quarters(1995, 2026, 1), 11, { '2026Q1': 71.5, '2025Q4': 70.25 }),
    },
  ],
};

const SERIES: Record<string, Series> = {
  CPTOTSAXN: CPI,
  NYGDPMKTPSAKD: GDP_Q,
  DMGSRMRCHSACD: IMPORTS,
  'NY.GDP.PCAP.CD': GDP_PC,
  'DP.DOD.DECD.CR.BC.CD': DEBT,
};

/** The country listing behind code completion and isAggregate. */
const ENTITIES = [
  ['KEN', 'KE', 'Kenya'],
  ['UGA', 'UG', 'Uganda'],
  ['USA', 'US', 'United States'],
  ['CHL', 'CL', 'Chile'],
];
const LISTING = [
  { page: 1, pages: 1, per_page: '10000', total: ENTITIES.length },
  ENTITIES.map(([id, iso2Code, name]) => ({
    id,
    iso2Code,
    name,
    region: { id: 'SSF', value: 'Region' },
    incomeLevel: { id: 'LIC', value: 'Low' },
    lendingType: {},
    capitalCity: '',
    longitude: '',
    latitude: '',
  })),
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
    country: { id: series.iso3InCountryId ? entity.iso3 : entity.iso2, value: entity.name },
    countryiso3code: series.iso3InCountryId ? '' : entity.iso3,
    date: period,
    value: entity.values[period] ?? null,
    unit: '',
    obs_status: '',
    decimal: 1,
  };
}

/** Every period the series answers at any form, newest first by form. */
function wholeSeries(series: Series): string[] {
  return (['year', 'quarter', 'month'] as const).flatMap((form) => series.calendar[form] ?? []);
}

/**
 * The periods a `date` window selects, the way each source family answers it.
 * Every period token is fixed-width, so a window compares as strings within its form.
 */
function periodsFor(series: Series, date: string | null): string[] {
  if (!date) return series.family === 'fill' ? (series.calendar.year ?? []) : wholeSeries(series);
  const [start = '', end = start] = date.split(':');
  const atForm = series.calendar[formOf(start)];
  const inside = (atForm ?? []).filter((p) => p >= start && p <= end);
  if (series.family === 'fill') return inside;
  return inside.length > 0 ? inside : wholeSeries(series);
}

function rowsFor(url: URL, indicatorId: string, codes: string[]): RawRow[] {
  const series = SERIES[indicatorId];
  if (!series) throw new Error(`fake has no series ${indicatorId}`);
  const entities =
    codes.length === 1 && codes[0]?.toLowerCase() === 'all'
      ? series.entities
      : codes.flatMap((code) =>
          series.entities.filter((e) => e.iso3 === code.toUpperCase() || e.iso2 === code),
        );
  const periods = periodsFor(series, url.searchParams.get('date'));
  return entities.flatMap((e) => periods.map((p) => rawRow(indicatorId, series, e, p)));
}

/** The envelope the live API answers a request with no rows in scope with. */
const EMPTY_ENVELOPE = [
  { page: 0, pages: 0, per_page: 0, total: 0, sourceid: null, lastupdated: null },
  null,
];

function envelope(rows: RawRow[], page: number, perPage: number, lastUpdated: string) {
  if (rows.length === 0) return EMPTY_ENVELOPE;
  return [
    {
      page,
      pages: Math.ceil(rows.length / perPage),
      per_page: perPage,
      total: rows.length,
      sourceid: '15',
      lastupdated: lastUpdated,
    },
    rows.slice((page - 1) * perPage, page * perPage),
  ];
}

const fetchMock = vi.fn<typeof fetch>();

/** Data requests received, in order. */
let dataRequests: URL[] = [];
/** Bodies to answer the next data requests with, ahead of the fake's own; `undefined` passes one through. */
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
    const codes = decodeURIComponent(match[1]).split(';');
    if (codes.some((code) => LEGACY_CODES.has(code.toUpperCase()))) {
      return Response.json(INVALID_VALUE);
    }
    const pollutedBody = polluted.shift();
    if (pollutedBody !== undefined) return Response.json(pollutedBody);

    const key = originKey(url);
    const cached = originCache?.get(key);
    if (cached) return Response.json(cached);

    const indicatorId = decodeURIComponent(match[2]);
    const body = envelope(
      rowsFor(url, indicatorId, decodeURIComponent(match[1]).split(';')),
      Number(url.searchParams.get('page') ?? 1),
      Number(url.searchParams.get('per_page') ?? 50),
      SERIES[indicatorId]?.lastUpdated ?? '',
    );
    originCache?.set(key, body);
    return Response.json(body);
  });
}

/** A body carrying the listed cells, as a polluting request would leave it. */
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
  notice?: string;
  error?: { code: number; message?: string; data?: Record<string, unknown> };
};

async function call(args: Record<string, unknown>) {
  const result = await runToolContract(worldbankGetData, args as never, {
    context: { errors: worldbankGetData.errors },
  });
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  return { isError: result.isError, structured: result.structuredContent as Structured, text };
}

/** A result's rows as `ISO3 period value`, in served order. */
function cells(rows: Row[]): string[] {
  return rows.map((r) => `${r.countryIso3} ${r.date} ${r.value}`);
}

/** The `date` each data request carried, in order. */
const dates = () => dataRequests.map((url) => url.searchParams.get('date'));

const YEAR = new Date().getUTCFullYear();

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

// ─── Characterization: behaviour that stays ───────────────────────────────────

describe('behaviour without frequency', () => {
  it('keeps the twelve quarters a year window overlaps on a quarterly-only series, from one request', async () => {
    const { structured } = await call({
      indicator_id: 'DP.DOD.DECD.CR.BC.CD',
      countries: 'CL',
      date_range: '2019:2021',
    });

    expect(structured.data.map((r) => r.date)).toEqual(quarters(2019, 2021, 4));
    expect(structured.totalCount).toBe(12);
    expect(dataRequests).toHaveLength(1);
  });

  it('selects mrv among the annual periods of a series that also publishes monthly ones', async () => {
    const { structured } = await call({ indicator_id: 'CPTOTSAXN', countries: 'KE', mrv: 3 });

    expect(cells(structured.data)).toEqual([
      'KEN 2026 283.9',
      'KEN 2025 271.59',
      'KEN 2024 260.97',
    ]);
    expect(dates()).toEqual([`${YEAR - 10}:2100`]);
  });

  it("keeps a quarterly-only series' own quarters for mrv", async () => {
    const { structured } = await call({
      indicator_id: 'DP.DOD.DECD.CR.BC.CD',
      countries: 'CL',
      mrv: 2,
    });

    expect(cells(structured.data)).toEqual(['CHL 2026Q1 71.5', 'CHL 2025Q4 70.25']);
    expect(dataRequests).toHaveLength(1);
  });

  it('answers a year window with the annual value and a month window with the months', async () => {
    const year = await call({ indicator_id: 'CPTOTSAXN', countries: 'KE', date_range: '2024' });
    const months3 = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      date_range: '2024M01:2024M03',
    });

    expect(cells(year.structured.data)).toEqual(['KEN 2024 260.97']);
    expect(cells(months3.structured.data)).toEqual([
      'KEN 2024M03 258.96',
      'KEN 2024M02 258.57',
      'KEN 2024M01 258.04',
    ]);
    expect(year.structured.notice).toBeUndefined();
    expect(months3.structured.notice).toBeUndefined();
  });
});

// ─── frequency on mrv and mrnev ───────────────────────────────────────────────

describe('frequency with mrv and mrnev', () => {
  it('selects the latest months from one read of a three-year month window, on both surfaces', async () => {
    const { structured, text } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      frequency: 'monthly',
      mrv: 3,
    });

    expect(cells(structured.data)).toEqual([
      'KEN 2026M07 289.76',
      'KEN 2026M06 288.21',
      'KEN 2026M05 288.03',
    ]);
    expect(dates()).toEqual([`${YEAR - 2}M01:2100M12`]);
    expect(structured.appliedFilters).toMatchObject({ frequency: 'monthly', mrv: 3 });
    expect(text).toContain('frequency=monthly');
    expect(text).toContain('**2026M07:** 289.76');
  });

  it('selects the latest quarters from a ten-year quarter window', async () => {
    const { structured } = await call({
      indicator_id: 'NYGDPMKTPSAKD',
      countries: 'US',
      frequency: 'quarterly',
      mrv: 3,
    });

    expect(cells(structured.data)).toEqual([
      'USA 2026Q2 5402220.83',
      'USA 2026Q1 5382365.61',
      'USA 2025Q4 5354586.12',
    ]);
    expect(dates()).toEqual([`${YEAR - 10}Q1:2100Q4`]);
  });

  it('keeps each form apart on a series publishing all three', async () => {
    const at = async (frequency: string) =>
      cells(
        (await call({ indicator_id: 'DMGSRMRCHSACD', countries: 'US', frequency, mrnev: 1 }))
          .structured.data,
      );

    expect(await at('annual')).toEqual(['USA 2026 1900000']);
    expect(await at('quarterly')).toEqual(['USA 2026Q2 840000']);
    expect(await at('monthly')).toEqual(['USA 2026M07 281000']);
  });

  it('serves only rows at the frequency when a read carries other forms too', async () => {
    // A body for the month window holding the annual and quarterly values beside the months.
    polluted.push(
      bodyAt('DMGSRMRCHSACD', [
        ['USA', '2026'],
        ['USA', '2026Q2'],
        ['USA', '2026M07'],
        ['USA', '2026M06'],
        ['USA', '2026M05'],
      ]),
    );
    const { structured } = await call({
      indicator_id: 'DMGSRMRCHSACD',
      countries: 'US',
      frequency: 'monthly',
      mrv: 2,
    });

    expect(structured.data.map((r) => r.date)).toEqual(['2026M07', '2026M06']);
  });

  it('widens only the country short of N months, over the whole monthly series', async () => {
    const { structured } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE;UG',
      frequency: 'monthly',
      mrnev: 2,
    });

    expect(cells(structured.data)).toEqual([
      'KEN 2026M07 289.76',
      'KEN 2026M06 288.21',
      'UGA 2019M12 190.5',
      'UGA 2019M11 189.25',
    ]);
    expect(dates()).toEqual([`${YEAR - 2}M01:2100M12`, '1900M01:2100M12']);
    expect(decodeURIComponent(dataRequests[1]?.pathname ?? '')).toContain('/country/UGA/');
  });

  it('keeps every country at the latest months under mrv, null where one has no value', async () => {
    const { structured } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE;UG',
      frequency: 'monthly',
      mrv: 1,
    });

    expect(cells(structured.data)).toEqual(['KEN 2026M07 289.76', 'UGA 2026M07 null']);
    expect(dataRequests).toHaveLength(1);
  });

  it('reads a larger N further back', async () => {
    await call({ indicator_id: 'CPTOTSAXN', countries: 'KE', frequency: 'monthly', mrv: 60 });
    await call({ indicator_id: 'NYGDPMKTPSAKD', countries: 'US', frequency: 'quarterly', mrv: 60 });

    expect(dates()).toEqual([`${YEAR - 5}M01:2100M12`, `${YEAR - 15}Q1:2100Q4`]);
  });
});

describe('results that do not depend on earlier calls (origin cache modelled)', () => {
  beforeEach(() => {
    originCache = new Map();
  });

  it.each([
    ['annual then monthly', [{ mrv: 2 }, { frequency: 'monthly', mrv: 2 }]],
    ['monthly then annual', [{ frequency: 'monthly', mrv: 2 }, { mrv: 2 }]],
  ])('returns each call its own frequency: %s', async (_label, sequence) => {
    const results = [];
    for (const args of sequence) {
      results.push(await call({ indicator_id: 'CPTOTSAXN', countries: 'KE;UG', ...args }));
    }

    const own = (args: Record<string, unknown>) =>
      'frequency' in args
        ? ['KEN 2026M07 289.76', 'KEN 2026M06 288.21', 'UGA 2026M07 null', 'UGA 2026M06 null']
        : [
            'KEN 2026 283.9',
            'KEN 2025 271.59',
            'UGA 2026 null',
            `UGA 2025 ${CPI.entities[1]?.values['2025']}`,
          ];
    expect(results.map((r) => cells(r.structured.data))).toEqual(sequence.map(own));
  });
});

// ─── A frequency the series lacks ─────────────────────────────────────────────

describe('a frequency the series does not publish', () => {
  it('returns an empty result whose notice says the series has no periods at that form', async () => {
    const { isError, structured, text } = await call({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'KE',
      frequency: 'monthly',
      mrv: 1,
    });

    expect(isError).toBeFalsy();
    expect(structured).toMatchObject({ data: [], totalCount: 0 });
    expect(structured.notice).toMatch(/publishes no monthly periods/);
    expect(structured.notice).toMatch(/annual/);
    expect(text).toContain('publishes no monthly periods');
  });

  it('says so for annual on a quarterly-only series asked for its whole history', async () => {
    const { structured } = await call({
      indicator_id: 'DP.DOD.DECD.CR.BC.CD',
      countries: 'CL',
      frequency: 'annual',
    });

    expect(structured).toMatchObject({ data: [], totalCount: 0 });
    expect(structured.notice).toMatch(/publishes no annual periods/);
    expect(structured.notice).toMatch(/quarterly/);
  });

  it('names both readings where the source null-fills a form: no value for these countries, or none published', async () => {
    const { structured } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      frequency: 'quarterly',
      mrnev: 1,
    });

    expect(structured).toMatchObject({ data: [], totalCount: 0 });
    expect(structured.notice).toMatch(/No requested country has a quarterly value/);
    expect(structured.notice).toMatch(/may not publish quarterly/);
    expect(dates()).toEqual([`${YEAR - 10}Q1:2100Q4`, '1900Q1:2100Q4']);
  });
});

// ─── frequency on the whole series ────────────────────────────────────────────

describe('frequency without mrv or mrnev', () => {
  it('returns the whole series at that form, paged at the served size with the same totals', async () => {
    const pages = [];
    for (const page of [1, 2, 3]) {
      dataRequests = [];
      pages.push(
        await call({
          indicator_id: 'CPTOTSAXN',
          countries: 'KE',
          frequency: 'monthly',
          per_page: 1000,
          page,
        }),
      );
      // A page past the end shows no rows, so page 1 is read to learn which form upstream served.
      expect(dates()).toEqual(
        page === 3 ? ['1900M01:2100M12', '1900M01:2100M12'] : ['1900M01:2100M12'],
      );
    }

    const [first, second, third] = pages.map((p) => p.structured);
    for (const structured of [first, second, third]) {
      expect(structured).toMatchObject({ totalCount: 320, totalPages: 2 });
    }
    expect(first?.data).toHaveLength(200);
    expect(first?.data[0]).toMatchObject({ date: '2026M08', value: null });
    expect(second?.data).toHaveLength(120);
    expect(second?.data.at(-1)?.date).toBe('2000M01');
    expect(new Set([...(first?.data ?? []), ...(second?.data ?? [])].map((r) => r.date)).size).toBe(
      320,
    );
    expect(first?.data.every((r) => r.date.includes('M'))).toBe(true);
    expect(third?.data).toEqual([]);
    expect(third?.notice).toMatch(/^Page 3 is past the end of the results/);
  });

  it('reads only the page asked for, as upstream page N at the served size', async () => {
    await call({ indicator_id: 'CPTOTSAXN', countries: 'KE', frequency: 'monthly', page: 2 });

    expect(dataRequests).toHaveLength(1);
    expect(
      ['date', 'page', 'per_page'].map((k) => dataRequests[0]?.searchParams.get(k)).join(' '),
    ).toBe('1900M01:2100M12 2 50');
  });

  it('carries a notice on a page of null rows, as a null-filling source answers a form the series lacks', async () => {
    const lacking = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      frequency: 'quarterly',
    });

    expect(lacking.structured.data.length).toBeGreaterThan(0);
    expect(lacking.structured.data.every((r) => r.value === null)).toBe(true);
    expect(lacking.structured.notice).toMatch(
      /^Every observation on this page is null: this series may not publish quarterly values/,
    );
    expect(lacking.text).toContain('Every observation on this page is null');

    const publishing = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      frequency: 'monthly',
    });
    expect(publishing.structured.notice).toBeUndefined();
  });

  it('says the form is not published on a page past the end of the series upstream answered instead', async () => {
    const { structured } = await call({
      indicator_id: 'DP.DOD.DECD.CR.BC.CD',
      countries: 'CL',
      frequency: 'annual',
      page: 9,
    });

    expect(structured).toMatchObject({ data: [], totalCount: 0 });
    expect(structured.notice).toMatch(/publishes no annual periods — only quarterly ones/);
  });
});

// ─── frequency with date_range, and bad values ────────────────────────────────

describe('frequency input checks', () => {
  it('rejects frequency with date_range as invalid_params before any request', async () => {
    const { isError, structured, text } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      frequency: 'quarterly',
      date_range: '2024',
    });

    expect(isError).toBe(true);
    expect(structured.error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_params', recovery: { hint: expect.stringMatching(/date_range/) } },
    });
    expect(text).toMatch(/frequency/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a value outside the three forms at the schema, before any request', async () => {
    const { isError, structured } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      frequency: 'weekly',
      mrv: 1,
    });

    expect(isError).toBe(true);
    expect(structured.error).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a blank frequency, as a form client sends it, as absent', async () => {
    const { structured } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      frequency: '',
      date_range: '2024',
    });

    expect(cells(structured.data)).toEqual(['KEN 2024 260.97']);
    expect(structured.appliedFilters).not.toHaveProperty('frequency');
  });
});

// ─── The all-null sub-annual window ───────────────────────────────────────────

describe('a quarter or month window whose rows are all null', () => {
  it('carries a notice naming the other period forms and frequency', async () => {
    const { structured, text } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'KE',
      date_range: '2024Q1:2024Q4',
    });

    expect(cells(structured.data)).toEqual([
      'KEN 2024Q4 null',
      'KEN 2024Q3 null',
      'KEN 2024Q2 null',
      'KEN 2024Q1 null',
    ]);
    expect(structured.notice).toMatch(/Every observation in date_range "2024Q1:2024Q4" is null/);
    expect(structured.notice).toContain('2024M01:2024M12');
    expect(structured.notice).toContain('"2024"');
    expect(structured.notice).toMatch(/frequency/);
    expect(text).toContain('Every observation in date_range "2024Q1:2024Q4" is null');
  });

  it('names the quarters and years around a month window', async () => {
    const { structured } = await call({
      indicator_id: 'NYGDPMKTPSAKD',
      countries: 'US',
      date_range: '2024M02:2024M05',
    });

    expect(structured.notice).toContain('2024Q1:2024Q2');
    expect(structured.notice).toContain('"2024"');
  });

  it('carries none when the window holds a value', async () => {
    const { structured } = await call({
      indicator_id: 'NYGDPMKTPSAKD',
      countries: 'US',
      date_range: '2024Q1:2024Q4',
    });

    expect(structured.data.every((r) => r.value !== null)).toBe(true);
    expect(structured.notice).toBeUndefined();
  });

  it('carries none on a year window, which selects the annual rows', async () => {
    const { structured } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'UG',
      date_range: '2026',
    });

    expect(cells(structured.data)).toEqual(['UGA 2026 null']);
    expect(structured.notice).toBeUndefined();
  });
});

// ─── Widening past an entity the country path rejects ─────────────────────────

describe('mrnev on "all" when a short entity is one the country path rejects by code', () => {
  it.each([
    [
      'annually',
      {},
      `${YEAR - 10}:2100`,
      '1900:2100',
      [
        { countryCode: 'KE', date: '2026', value: 283.9 },
        { countryCode: 'UG', date: '2025' },
        // The country listing does not carry the legacy entity, so its row keeps the code upstream sent.
        { countryCode: 'YUG', date: '2002', value: 51.25 },
      ],
    ],
    [
      'monthly',
      { frequency: 'monthly' },
      `${YEAR - 2}M01:2100M12`,
      '1900M01:2100M12',
      [
        { countryCode: 'KE', date: '2026M07', value: 289.76 },
        { countryCode: 'UG', date: '2019M12', value: 190.5 },
      ],
    ],
  ])('widens over the whole list instead, %s', async (_label, args, window, span, expected) => {
    const { isError, structured } = await call({
      indicator_id: 'CPTOTSAXN',
      countries: 'all',
      mrnev: 1,
      ...args,
    });

    expect(isError).toBeFalsy();
    expect(structured.data).toMatchObject(expected);
    expect(structured.data).toHaveLength(expected.length);
    // The window read, the rejected list of short entities, then the whole list at the same form.
    expect(dates()).toEqual([window, span, span]);
    expect(decodeURIComponent(dataRequests[1]?.pathname ?? '')).toContain('YUG');
    expect(decodeURIComponent(dataRequests[2]?.pathname ?? '')).toContain('/country/all/');
  });
});
