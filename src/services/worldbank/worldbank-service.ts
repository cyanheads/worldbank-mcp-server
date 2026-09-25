/**
 * @fileoverview World Bank Indicators API v2 service. Wraps all endpoint categories
 * (indicators, countries, data, topics, sources) with typed fetch methods,
 * retry/timeout, and sparse-payload normalization. Keyword indicator search,
 * collapse of indicators the catalog publishes twice, aggregate-free country
 * listing, aggregate classification of data rows, verification of the requested
 * date window, and the latest-value selection behind `mrv` and `mrnev` are
 * computed locally over exhaustively fetched candidate sets, since the API offers
 * none of them server-side in a form its response cache keeps apart. Every
 * windowed or latest-value data read is checked for the signs of another request's
 * cached body and re-read once before it is served; a read of the whole series
 * takes one upstream page. Indicators the standard data endpoint won't serve (message
 * id 175) are answered from their catalog source's source-scoped data API instead.
 * @module services/worldbank/worldbank-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { MAX_COUNTRIES_PER_PAGE, MAX_OBSERVATIONS_PER_PAGE } from '@/services/response-budget.js';
import { sharedLoadContext, untilAborted } from '@/services/shared-load.js';
import {
  fullSpan,
  type LatestSelection,
  latestWindow,
  type RowReader,
  selectionForm,
  selectLatest,
} from './latest-values.js';
import {
  isWithinWindow,
  monthSpan,
  type PeriodForm,
  parseDateWindow,
  periodForm,
  periodFromToken,
} from './periods.js';
import {
  defaultSelection,
  layoutFromConcepts,
  newestVersionWithData,
  readRow,
  SCOPED_ROW_READER,
  type ScopedRow,
  type SourceLayout,
  sortRows,
  valuesFromListing,
} from './source-scoped.js';
import type {
  Country,
  DataPoint,
  DimensionSelection,
  DimensionValue,
  Indicator,
  IndicatorDetail,
  RawCountry,
  RawDataPoint,
  RawIndicator,
  RawSource,
  RawSourceData,
  RawSourceListing,
  RawSourceObservation,
  RawTopic,
  Source,
  SourceScopedDisclosure,
  Topic,
  WbEnvelope,
  WbPage,
} from './types.js';

/** Minimal request-context shape that satisfies fetchWithTimeout and withRetry. */
type ReqCtx = Context & Record<string, unknown>;

// ─── Error detection ─────────────────────────────────────────────────────────

/** Shape returned by the WB API for invalid IDs (HTTP 200, not 404). */
type WbErrorEnvelope = { message: Array<{ id: string; key: string; value: string }> };

/**
 * Message id the data endpoint returns for an indicator the catalog lists but
 * the endpoint will not serve for any country, date, or `source` parameter:
 * "The indicator was not found. It may have been deleted or archived." It covers
 * every WDI Database Archives indicator and whole non-archive sources too (PEFA,
 * ICP, Food Prices for Nutrition), so a source name can't stand in for it. A
 * bad country code on the same indicator produces the generic id 120 instead.
 */
const NOT_SERVED_MESSAGE_ID = '175';

/**
 * Per-request page size for exhaustive fetches. Not a result ceiling — the
 * fetch loop reads `pages` from the first response and keeps going, so this
 * only trades request count against response size.
 */
const BULK_PAGE_SIZE = 10_000;

/**
 * Page size of a windowed or latest-value data read, which reads every page. It
 * holds any annual series for every entry in one request (265 entries × 66 years
 * is 17,490 rows), which matters because a read fetches page 1 before it knows
 * how many more there are. Upstream accepts up to 32,767.
 */
const DATA_PAGE_SIZE = 20_000;

/**
 * Page size of the one re-read a suspect data read gets. The origin and Cloudflare
 * both key a data response by `per_page`, so this is a separate entry in both
 * caches from the {@link DATA_PAGE_SIZE} read it checks.
 */
const REREAD_PAGE_SIZE = DATA_PAGE_SIZE - 1;

/** Timeout for ordinary single-page requests. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Timeout for exhaustive fetches. The full indicator catalog is ~15 MB and
 * takes seconds to transfer even on a good day, so it gets far more headroom
 * than the small requests {@link REQUEST_TIMEOUT_MS} was sized for.
 */
const BULK_TIMEOUT_MS = 60_000;

/**
 * Bound on a reference load shared by concurrent callers, which runs under no
 * caller's signal: a bulk request's own timeout across the framework's default
 * retry budget of four attempts, with room for the backoff between them.
 */
const REFERENCE_LOAD_TIMEOUT_MS = 4 * BULK_TIMEOUT_MS + 15_000;

/**
 * Stand-in for the invalid-value envelope when upstream answers a lookup with a
 * real HTTP 404. A well-formed but unknown ID gets the HTTP-200 envelope; an ID
 * that escapes into a path the router can't match (`a%2Fb`, `%253B`) gets a 404
 * page instead, and the two mean the same thing to the caller.
 */
const PATH_NOT_FOUND_ENVELOPE: WbErrorEnvelope = {
  message: [
    { id: '404', key: 'Not Found', value: 'No World Bank API resource exists at this path' },
  ],
};

/**
 * Most rows one source-scoped request may read: the requested countries × periods
 * × unpinned dimension values, counted against the source's full listings. The
 * largest pinned scope any source serves today, PEFA 2011 for every country and
 * period, is 58,941 rows (~17 MB); an unpinned WDI Database Archives query for
 * every country across all years would be 2.7 million.
 */
const SOURCE_SCOPE_ROW_LIMIT = 60_000;

/**
 * The source-scoped data API ignores `format=json` on failure and answers
 * HTTP 200 with an XML body — `<wb:error><wb:message id="160" key="Data not
 * found.">…</wb:message></wb:error>` — whichever path segment it rejected. Read
 * into the JSON error envelope so one check covers both APIs.
 */
function parseXmlErrorEnvelope(text: string): WbErrorEnvelope | undefined {
  if (!/<wb:error\b/.test(text)) return;
  const message = [...text.matchAll(/<wb:message\b([^>]*)>([^<]*)<\/wb:message>/g)].map(
    ([, attributes = '', value = '']) => ({
      id: /\bid="([^"]*)"/.exec(attributes)?.[1] ?? '',
      key: /\bkey="([^"]*)"/.exec(attributes)?.[1] ?? '',
      value: value.trim(),
    }),
  );
  return { message };
}

/** True for the error `fetchWithTimeout` throws when upstream answers HTTP 404. */
function isUpstreamNotFound(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.data?.errorSource === 'FetchHttpError' &&
    error.data.status === 404
  );
}

/**
 * True for the HTTP 400 the Indicators API sometimes answers a well-formed request
 * with: its web server's HTML "Request Error" page, where the API's own validation
 * failures arrive as HTTP-200 envelopes. The same URL succeeds when repeated, so it
 * is an upstream fault to retry, not the caller's invalid input. Any other 400
 * keeps the framework's mapping.
 */
function isTransientRequestError(error: unknown): boolean {
  if (!(error instanceof McpError) || error.data?.errorSource !== 'FetchHttpError') return false;
  const body = error.data.body;
  return (
    error.data.status === 400 &&
    typeof body === 'string' &&
    /<html\b/i.test(body) &&
    />\s*Request Error\s*</.test(body)
  );
}

function isWbErrorEnvelope(data: unknown): data is WbErrorEnvelope {
  // Direct object: { message: [...] }
  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    Array.isArray((data as WbErrorEnvelope).message)
  )
    return true;
  // Array-wrapped: [{ message: [...] }] — returned by list endpoints like /country?region=INVALID
  if (Array.isArray(data) && data.length > 0) return isWbErrorEnvelope(data[0]);
  return false;
}

// ─── Normalization helpers ────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/**
 * Reduce provider-authored prose to plain text. A few source notes carry HTML
 * (`SE.PRM.INPT` breaks a dash list with `</br>`), which reached both response
 * surfaces as literal tags. Breaks become line breaks, other tags are dropped
 * with their text kept, and entities are decoded after the tags are gone, so an
 * encoded `&lt;b&gt;` survives as text. Only a `<` followed by a letter reads as
 * a tag: literal brackets in prose (`<$2.15 a day`, `<-2 standard deviations`)
 * pass through, and a note without markup comes back unchanged.
 */
function plainProse(value: string): string {
  return value
    .replace(/[ \t]*<\/?br\s*\/?>[ \t]*/gi, '\n')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
      if (!body.startsWith('#')) return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
      const codePoint = /^#x/i.test(body)
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    });
}

function normalizeIndicator(raw: RawIndicator): Indicator {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    sourceId: raw.source?.id ?? '',
    sourceName: raw.source?.value ?? '',
    sourceNote: plainProse(raw.sourceNote ?? ''),
    topics: (raw.topics ?? [])
      .filter((t): t is typeof t & { id: string } => typeof t.id === 'string' && t.id.length > 0)
      .map((t) => ({ id: t.id, name: t.value ?? '' })),
  };
}

function normalizeIndicatorDetail(raw: RawIndicator): IndicatorDetail {
  return {
    ...normalizeIndicator(raw),
    unit: raw.unit ?? '',
    sourceOrganization: raw.sourceOrganization ?? '',
  };
}

function normalizeCountry(raw: RawCountry): Country {
  const regionId = raw.region?.id ?? '';
  const incomeLevelId = raw.incomeLevel?.id ?? '';
  // Aggregate entries have region.id = "NA" and incomeLevel.id = "NA"
  const isAggregate = regionId === 'NA' && incomeLevelId === 'NA';
  return {
    id: raw.id ?? '',
    iso2: raw.iso2Code ?? '',
    name: raw.name ?? '',
    region: { id: regionId, name: raw.region?.value ?? '' },
    incomeLevel: { id: incomeLevelId, name: raw.incomeLevel?.value ?? '' },
    lendingType: raw.lendingType?.value ?? '',
    capitalCity: raw.capitalCity ?? '',
    longitude: raw.longitude ?? '',
    latitude: raw.latitude ?? '',
    isAggregate,
  };
}

/**
 * Normalize one data-endpoint row, completing its two codes from the country
 * index. `country.id` is normally ISO2 and `countryiso3code` the three-character
 * code, but upstream leaves `countryiso3code` empty on the income groups and Not
 * classified (`XD`, `XY`), and Global Economic Monitor rows put the ISO3 code in
 * `country.id` (`KEN`) with `countryiso3code` empty. An entity the index does not
 * carry keeps what upstream sent.
 */
function normalizeDataPoint(raw: RawDataPoint, index: CountryIndex): DataPoint {
  const entity = index.entities.get((raw.country?.id ?? '').toUpperCase());
  const countryCode = entity?.iso2 || (raw.country?.id ?? '');
  const countryIso3 = raw.countryiso3code || entity?.id || '';
  return {
    countryCode,
    countryIso3,
    countryName: raw.country?.value ?? '',
    date: raw.date ?? '',
    value: raw.value ?? null,
    obsStatus: raw.obs_status ?? '',
    isAggregate: index.aggregateCodes.has(countryIso3) || index.aggregateCodes.has(countryCode),
  };
}

function normalizeTopic(raw: RawTopic): Topic {
  return {
    id: raw.id ?? '',
    name: raw.value ?? '',
    sourceNote: raw.sourceNote ?? '',
  };
}

function normalizeSource(raw: RawSource): Source {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    code: raw.code ?? '',
    lastUpdated: raw.lastupdated ?? '',
    dataAvailability: raw.dataavailability ?? '',
    metadataAvailability: raw.metadataavailability ?? '',
    concepts: raw.concepts ?? '',
  };
}

// ─── Duplicate indicator collapse ────────────────────────────────────────────

/**
 * Whether a catalog source is an archive of another — WDI Database Archives and
 * FPN Datahub Archive, whose series are superseded copies of live ones.
 */
function isArchivedSource(sourceName: string): boolean {
  return /archive/i.test(sourceName);
}

/**
 * Pick the row to keep out of two catalog entries sharing one indicator ID.
 * Dozens of indicators are published twice, identical but for their `source`:
 * a live dataset and an archived copy of it. The archived copy loses; when
 * neither is archived the lower source ID wins, so the choice never depends on
 * the order upstream happened to return the rows in.
 */
function preferredRow<T extends { sourceId: string; sourceName: string }>(
  current: T,
  candidate: T,
): T {
  const currentArchived = isArchivedSource(current.sourceName);
  const candidateArchived = isArchivedSource(candidate.sourceName);
  if (currentArchived !== candidateArchived) return currentArchived ? candidate : current;
  return Number(candidate.sourceId) < Number(current.sourceId) ? candidate : current;
}

/**
 * Collapse rows sharing an indicator ID down to one, keeping the first
 * occurrence's position so ranking and pagination stay stable. Without this a
 * search returns the same ID more than once and counts every copy in `total`,
 * and an agent chaining the results issues duplicate data requests for one series.
 */
function dedupeIndicators(indicators: readonly Indicator[]): Indicator[] {
  const byId = new Map<string, Indicator>();
  for (const indicator of indicators) {
    const existing = byId.get(indicator.id);
    byId.set(indicator.id, existing ? preferredRow(existing, indicator) : indicator);
  }
  return [...byId.values()];
}

// ─── Single-item lookups ─────────────────────────────────────────────────────

/** How many of a rejected selector's matched IDs a lookup error names. */
const ID_SAMPLE_SIZE = 5;

/**
 * The distinct IDs across a lookup's rows, in upstream order. `/country/{code}`
 * and `/indicator/{id}` accept collection selectors (`all`, `USA;CAN`) as well
 * as single codes, so a lookup is single only when every row shares one ID. The
 * row count is no test: an indicator published under a live and an archived
 * source answers two rows for one ID.
 */
function distinctIds(rows: ReadonlyArray<{ id?: string }>): string[] {
  return [...new Set(rows.map((row) => row.id ?? ''))];
}

/** Render the first matched IDs for an error message, marking any remainder. */
function sampleIds(ids: readonly string[]): string {
  const shown = ids.slice(0, ID_SAMPLE_SIZE).join(', ');
  return ids.length > ID_SAMPLE_SIZE ? `${shown}, …` : shown;
}

// ─── Keyword matching ────────────────────────────────────────────────────────

/**
 * Lowercase and collapse every run of non-alphanumeric characters to a single
 * space. Indicator names are dense with punctuation — `GDP (current US$)`,
 * `Unemployment, female (% of female labor force)` — and splitting a query on
 * whitespace alone yields tokens like `us$)` or `(%)` that appear nowhere,
 * zeroing out queries a caller would reasonably expect to work.
 */
function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Source ID of World Development Indicators, the Bank's flagship series. */
const WDI_SOURCE_ID = '2';

/**
 * Order of a hit's source within a match tier: World Development Indicators,
 * then any other live source, then an archive. A regional dataset or an archived
 * copy otherwise sorts ahead of the canonical series whenever the catalog lists
 * it first.
 */
function sourceRank(indicator: Indicator): number {
  if (indicator.sourceId === WDI_SOURCE_ID) return 0;
  return isArchivedSource(indicator.sourceName) ? 2 : 1;
}

/**
 * What may follow the phrase at the start of a name for the name to start with
 * it: the end of a word, optionally after a plural `s` or `es` on its last word.
 * `trade` starts `Trade (% of GDP)` but not `Trademark applications`, and `export`
 * still starts `Exports of goods and services`.
 */
const PHRASE_WORD_END = /^(?:e?s)?(?: |$)/;

/**
 * How specifically an ID/name hit matches the normalized query: an exact ID or
 * name (0), a name starting with the phrase as whole words (1), the phrase
 * anywhere in the ID or name (2), every term a whole word of them (3), or terms
 * found only inside longer words (4) — `co2` inside `CO2e` matches, but a series
 * whose name carries `CO2` itself is the likelier target.
 */
function matchTier(indicator: Indicator, phrase: string, terms: readonly string[]): number {
  const id = normalizeForMatch(indicator.id);
  const name = normalizeForMatch(indicator.name);
  if (phrase === id || phrase === name) return 0;
  if (name.startsWith(phrase) && PHRASE_WORD_END.test(name.slice(phrase.length))) return 1;
  const idAndName = `${id} ${name}`;
  if (idAndName.includes(phrase)) return 2;
  const words = new Set(idAndName.split(' '));
  return terms.every((term) => words.has(term)) ? 3 : 4;
}

/**
 * The series family an indicator ID belongs to: its first three segments
 * (`SP.DYN.LE00` for `SP.DYN.LE00.FE.IN`), or the whole ID when it has no more.
 * World Bank IDs mark a breakdown — by sex, area, age, or quintile — with an
 * extra segment, so the family member with the fewest segments is the series for
 * the whole population.
 */
function seriesFamily(id: string): string {
  return id.split('.').slice(0, 3).join('.');
}

/** Tier of a hit that matched only the prose in `sourceNote`, after every ID/name tier. */
const DESCRIPTION_ONLY_TIER = 5;

/**
 * Rank the hits so a caller who typed something specific gets it first: by
 * match tier, then by source within a tier, then in catalog order, except that
 * a series family is gathered at its first member's place, fewest ID segments
 * first. Without this, `Population, total` buries `SP.POP.TOTL` behind whichever
 * loosely-related indicators happen to sort earlier upstream, `GDP per capita`
 * leads with a regional dataset's copy of the series, and `access to electricity`
 * with the rural rate, which the catalog lists ahead of the total. Both sorts are
 * stable, so catalog order breaks the remaining ties.
 */
function rankHits(hits: ReadonlyArray<{ indicator: Indicator; tier: number }>): Indicator[] {
  const ranked = hits
    .map((hit) => ({ ...hit, source: sourceRank(hit.indicator) }))
    .sort((a, b) => a.tier - b.tier || a.source - b.source);
  const familyLead = new Map<string, number>();
  return ranked
    .map((hit, index) => {
      const family = `${hit.tier}|${hit.source}|${seriesFamily(hit.indicator.id)}`;
      let lead = familyLead.get(family);
      if (lead === undefined) {
        lead = index;
        familyLead.set(family, lead);
      }
      return { indicator: hit.indicator, lead, segments: hit.indicator.id.split('.').length };
    })
    .sort((a, b) => a.lead - b.lead || a.segments - b.segments)
    .map(({ indicator }) => indicator);
}

/**
 * Filter indicators by keyword. Every token of the normalized query must appear
 * (case-insensitive substring) in the indicator's ID, name, or source note, so
 * word order doesn't matter — "per capita GDP" and "gdp per capita" return the
 * same set. Tokens are alphanumeric-only, which lets them be matched against the
 * raw haystack directly: an alphanumeric run in the normalized text is present
 * verbatim in the original, so normalizing 29.5k source notes per query buys
 * nothing. Results matching on ID or name are ranked ahead of those that only
 * matched the prose in `sourceNote`, which keeps the useful hits on page one;
 * those description-only hits form the last tier, ranked like the others. The
 * whole note is read here, whatever excerpt of it a tool returns.
 */
function matchIndicators(indicators: readonly Indicator[], query: string): Indicator[] {
  const phrase = normalizeForMatch(query);
  const tokens = phrase.split(' ');

  const hits: Array<{ indicator: Indicator; tier: number }> = [];
  for (const indicator of indicators) {
    const idAndName = `${indicator.id} ${indicator.name}`.toLowerCase();
    if (tokens.every((token) => idAndName.includes(token))) {
      hits.push({ indicator, tier: matchTier(indicator, phrase, tokens) });
      continue;
    }
    const note = indicator.sourceNote.toLowerCase();
    if (tokens.every((token) => idAndName.includes(token) || note.includes(token))) {
      hits.push({ indicator, tier: DESCRIPTION_ONLY_TIER });
    }
  }
  return rankHits(hits);
}

// ─── Observation reads ───────────────────────────────────────────────────────

/** One complete standard-endpoint read: every page's rows, under the first page's envelope. */
type SeriesRead = { paging: WbPage; items: RawDataPoint[] };

/**
 * The code a request path names a data row's entity by: the three-character
 * code, or `country.id` where upstream leaves that empty (the income groups by
 * ISO2, Global Economic Monitor rows by ISO3). Empty for an entity upstream sends
 * with neither, such as Gibraltar in Human Capital Index or "IDA total" in Global
 * Financial Development.
 */
function observationCode(raw: RawDataPoint): string {
  return raw.countryiso3code || raw.country?.id || '';
}

/**
 * The series a data row belongs to: its code and its name. A code alone does not
 * identify an entity — Doing Business answers `CHN` for China, Beijing, and
 * Shanghai alike, and some sources send several entities with no code at all.
 */
function observationSeries(raw: RawDataPoint): string {
  return `${observationCode(raw)}|${raw.country?.value ?? ''}`;
}

/** How the latest-value selection reads a standard-endpoint row. */
const OBSERVATION_READER: RowReader<RawDataPoint> = {
  series: observationSeries,
  period: (raw) => raw.date ?? '',
  hasValue: (raw) => raw.value !== null && raw.value !== undefined,
};

/**
 * Why a data read looks like the answer to another request, or `undefined` when
 * it doesn't. The origin keys a data response by country path, `per_page`, and
 * `date` alone, so a request adding `mrv`, `mrnev`, or `frequency` to the same
 * three can answer this one, and Cloudflare then serves that body for the URL for
 * up to a day. An honest read is a rectangular grid — every entity
 * ({@link observationSeries}) at the same periods, null-filled — inside its window
 * at the window's own form. A read is suspect when:
 * - its envelope is empty;
 * - its entities sit at different periods, as an `mrnev` body's countries do;
 * - it holds rows outside `date` at `date`'s own form, as an `mrv` body answering
 *   a window does;
 * - it lacks a period in `required`: the periods the first read returned, when
 *   this read widens it to the whole series.
 *
 * An honest result can look suspect too — an empty scope, or a window upstream
 * drops and answers with the whole series — and its re-read then matches it.
 */
function suspectRead(
  items: readonly RawDataPoint[],
  date: string,
  required?: ReadonlySet<string>,
): string | undefined {
  if (items.length === 0) return 'an empty envelope';

  const grids = new Set(
    [...Map.groupBy(items, observationSeries).values()].map((rows) =>
      rows.map(OBSERVATION_READER.period).sort().join(','),
    ),
  );
  if (grids.size > 1) return 'countries at different periods';

  const window = parseDateWindow(date);
  const windowForm = periodForm(date.split(':')[0] ?? '');
  const outside =
    window !== undefined &&
    items.some((raw) => {
      const period = raw.date ?? '';
      return periodForm(period) === windowForm && !isWithinWindow(period, window);
    });
  if (outside) return `rows outside date=${date}`;

  if (required) {
    const periods = new Set(items.map((raw) => raw.date ?? ''));
    const missing = [...required].find((period) => !periods.has(period));
    if (missing) return `no ${missing} row, which the first read returned`;
  }
  return;
}

/** The period forms among `periods`, in first-seen order; an unplaceable period has none. */
function formsOf(periods: readonly string[]): PeriodForm[] {
  return [...new Set(periods.map(periodForm).filter((form) => form !== undefined))];
}

/** Whether two reads carry the same rows, in any order. */
function sameRows(a: readonly RawDataPoint[], b: readonly RawDataPoint[]): boolean {
  const cells = (items: readonly RawDataPoint[]) =>
    items
      .map((raw) => `${observationSeries(raw)}|${raw.date}|${raw.value}`)
      .sort()
      .join('\n');
  return a.length === b.length && cells(a) === cells(b);
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** One entity of the country listing: both identifiers, and whether it is an aggregate. */
export type CountryEntity = { id: string; iso2: string; isAggregate: boolean };

/** Every entity in the country listing, by either identifier, plus the aggregate codes. */
type CountryIndex = {
  aggregateCodes: Set<string>;
  entities: Map<string, CountryEntity>;
};

/** Options for {@link WorldBankApiService.getData}. */
type GetDataOptions = {
  indicatorId: string;
  countries: string | string[];
  dateRange?: string;
  /** The N most recent periods holding a value for any requested country. */
  mrv?: number;
  /** Each requested country's N most recent periods holding a value. */
  mrnev?: number;
  /**
   * The period form to return: the form `mrv` and `mrnev` select within, or with
   * neither, the whole series at that form. Absent, a selection is annual unless
   * the series has no annual periods, and a read keeps every form upstream returns.
   */
  frequency?: PeriodForm;
  /** A value of the serving source's extra dimension; applies to source-scoped data only. */
  dimensionValue?: string;
  page: number;
  perPage: number;
};

/** One page of observations from either data path. */
export type DataResult = {
  data: DataPoint[];
  indicator: { id: string; name: string };
  total: number;
  page: number;
  pages: number;
  /** Page size actually served: the requested size, reduced to the page cap when larger. */
  perPage: number;
  nullCount: number;
  dateFilterDropped: boolean;
  /** Present when the source-scoped data API served the result instead of the standard endpoint. */
  sourceScoped?: SourceScopedDisclosure;
  /** Valid codes the serving source publishes no data for, left out of the request. */
  uncoveredCountries?: string[];
  /** The serving source's last update date (`2026-07-13`); absent when its envelope carries none. */
  lastUpdated?: string;
  /**
   * The period forms the series answered with, before any selection — what tells
   * a `frequency` the series does not publish from one no requested country has a
   * value at. A source that null-fills a form it lacks answers with that form too.
   */
  periodForms?: PeriodForm[];
  /** True when the result holds rows and every one of them, on every page, is null. */
  allNull?: boolean;
};

/** The latest-value selection `mrv` or `mrnev` asks for, if either does. */
function latestSelection({ mrv, mrnev }: GetDataOptions): LatestSelection | undefined {
  if (mrnev !== undefined) return { mode: 'mrnev', count: mrnev };
  if (mrv !== undefined) return { mode: 'mrv', count: mrv };
  return;
}

export class WorldBankApiService {
  private readonly baseUrl: string;
  private readonly catalogCacheTtlMs: number;

  /**
   * TTL'd reference data — the indicator catalog, the country index, and each
   * source's concepts and value listings — keyed by what was fetched. Held on the
   * instance rather than in module scope so tests (and multiple service
   * instances) can't leak state into each other.
   */
  private readonly referenceCache = new Map<string, { value: unknown; expiresAt: number }>();

  /** In-flight reference fetches, shared so concurrent callers trigger one request per key. */
  private readonly referenceInFlight = new Map<string, Promise<unknown>>();

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.apiBaseUrl.replace(/\/$/, '');
    this.catalogCacheTtlMs = serverConfig.catalogCacheTtlMs;
  }

  /**
   * Serve `key` from the reference cache, loading it once per TTL window. A TTL
   * of 0 disables retention, though concurrent callers still share one load.
   *
   * `load` receives the context to fetch with: a signal of its own
   * ({@link sharedLoadContext}), not the first caller's, because every
   * concurrent caller waits on the same load. Each caller waits only until its
   * own signal aborts, so one caller cancelling fails that caller alone, and a
   * load every caller abandoned still completes and caches for the next one.
   */
  private cachedReference<T>(
    key: string,
    ctx: Context,
    load: (shared: Context) => Promise<T>,
  ): Promise<T> {
    const cached = this.referenceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value as T);

    let pending = this.referenceInFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load(sharedLoadContext(ctx, REFERENCE_LOAD_TIMEOUT_MS))
        .then((value) => {
          if (this.catalogCacheTtlMs > 0) {
            this.referenceCache.set(key, { value, expiresAt: Date.now() + this.catalogCacheTtlMs });
          }
          return value;
        })
        .finally(() => this.referenceInFlight.delete(key));
      this.referenceInFlight.set(key, pending);
    }
    return untilAborted(pending, ctx.signal);
  }

  /** Build a fully-qualified URL with format=json always appended. */
  private buildUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
    const qs = new URLSearchParams();
    qs.set('format', 'json');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    return `${this.baseUrl}${path}?${qs.toString()}`;
  }

  /** Fetch a URL, detect HTML error pages, and return the parsed JSON. */
  private async fetchJson<T>(
    url: string,
    ctx: Context,
    timeoutMs: number,
    expectedStatuses?: number[],
  ): Promise<T> {
    const reqCtx = ctx as ReqCtx;
    const response = await fetchWithTimeout(url, timeoutMs, reqCtx, {
      signal: ctx.signal,
      ...(expectedStatuses && { expectedStatuses }),
    }).catch((err: unknown) => {
      throw isTransientRequestError(err)
        ? serviceUnavailable(
            'World Bank API answered HTTP 400 with its "Request Error" page, which it returns intermittently for requests that succeed when repeated.',
            { status: 400, errorSource: 'UpstreamRequestErrorPage' },
            { cause: err },
          )
        : err;
    });
    const text = await response.text();

    // Detect HTML error pages (upstream returns HTML on some gateway errors)
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'World Bank API returned an HTML error page — likely rate-limited or temporarily unavailable.',
      );
    }

    return (parseXmlErrorEnvelope(text) ?? JSON.parse(text)) as T;
  }

  /**
   * Fetch JSON with retry wrapping the full pipeline.
   *
   * @param expectedStatuses - Non-OK statuses the caller handles itself, which
   *   the framework then logs at debug rather than error. Still thrown.
   */
  private fetchWithRetry<T>(
    url: string,
    ctx: Context,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    expectedStatuses?: number[],
  ): Promise<T> {
    return withRetry(() => this.fetchJson<T>(url, ctx, timeoutMs, expectedStatuses), {
      operation: 'WorldBankApiService.fetch',
      context: ctx as ReqCtx,
      baseDelayMs: 1000,
      signal: ctx.signal,
    });
  }

  /**
   * Fetch a request whose path carries a caller-supplied ID. An upstream 404 comes
   * back as {@link PATH_NOT_FOUND_ENVELOPE}, so the caller's existing invalid-ID
   * handling reports it with its own contract reason, and the upstream error page
   * the framework captured is dropped. Every other status keeps the framework's
   * classification.
   */
  private async fetchLookup<T>(
    url: string,
    ctx: Context,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<WbEnvelope<T> | WbErrorEnvelope> {
    try {
      return await this.fetchWithRetry<WbEnvelope<T> | WbErrorEnvelope>(url, ctx, timeoutMs, [404]);
    } catch (err) {
      if (isUpstreamNotFound(err)) return PATH_NOT_FOUND_ENVELOPE;
      throw err;
    }
  }

  /**
   * Fetch every upstream page for a scope: the first page's envelope and the
   * concatenated raw items, or the HTTP-200 error envelope when any page is one.
   *
   * `pages` from the first response is the loop bound; the accumulated item
   * count — not `paging.total` — is what callers paginate against, since only
   * the rows actually in hand can be served and local filtering changes the
   * count anyway.
   *
   * @param perPage - Rows per request; a larger page trades request count
   *   against response size, never what is read.
   * @param idInPath - The path carries a caller-supplied ID, so an upstream 404
   *   comes back as the error envelope too (see {@link fetchLookup}).
   */
  private async readAllPages<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ctx: Context,
    { perPage = BULK_PAGE_SIZE, idInPath = false, timeoutMs = BULK_TIMEOUT_MS } = {},
  ): Promise<{ paging: WbPage; items: T[] } | WbErrorEnvelope> {
    const requestPage = (page: number) => {
      const url = this.buildUrl(path, { ...params, page, per_page: perPage });
      ctx.log.debug('Fetching upstream page', { url });
      return idInPath
        ? this.fetchLookup<T>(url, ctx, timeoutMs)
        : this.fetchWithRetry<WbEnvelope<T> | WbErrorEnvelope>(url, ctx, timeoutMs);
    };

    const first = await requestPage(1);
    if (isWbErrorEnvelope(first)) return first;
    const [paging, items] = first;
    const pages = Number(paging.pages);
    if (pages <= 1) return { paging, items: items ?? [] };

    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => requestPage(i + 2)));
    const failed = rest.find(isWbErrorEnvelope);
    if (failed) return failed;
    return {
      paging,
      items: [items ?? [], ...rest.map((page) => (page as WbEnvelope<T>)[1] ?? [])].flat(),
    };
  }

  /**
   * Every upstream item for a scope, through {@link readAllPages}.
   *
   * @param onErrorEnvelope - Throws the caller's domain error when the World
   *   Bank returns its HTTP-200 error envelope for an invalid filter value.
   */
  private async fetchAllPages<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ctx: Context,
    onErrorEnvelope: () => never,
    idInPath = false,
  ): Promise<T[]> {
    const read = await this.readAllPages<T>(path, params, ctx, { idInPath });
    if (isWbErrorEnvelope(read)) onErrorEnvelope();
    return read.items;
  }

  // ─── Topics ──────────────────────────────────────────────────────────────

  async listTopics(ctx: Context): Promise<Topic[]> {
    const url = this.buildUrl('/topic');
    ctx.log.debug('Fetching topics', { url });

    const data = await this.fetchWithRetry<WbEnvelope<RawTopic>>(url, ctx);
    const [, items] = data;
    return (items ?? []).map(normalizeTopic);
  }

  // ─── Sources ─────────────────────────────────────────────────────────────

  async listSources(
    page: number,
    perPage: number,
    ctx: Context,
  ): Promise<{ sources: Source[]; total: number; page: number; pages: number }> {
    const url = this.buildUrl('/source', { page, per_page: perPage });
    ctx.log.debug('Fetching sources', { url });

    const data = await this.fetchWithRetry<WbEnvelope<RawSource>>(url, ctx);
    const [paging, items] = data;
    return {
      sources: (items ?? []).map(normalizeSource),
      // /source returns page/pages/total as strings — coerce to number
      total: Number(paging.total),
      page: Number(paging.page),
      pages: Number(paging.pages),
    };
  }

  // ─── Indicators ──────────────────────────────────────────────────────────

  /**
   * Load and cache the full indicator catalog. Keyword-only search has no
   * server-side counterpart — the upstream `searchterm` parameter returns the
   * unfiltered catalog — so matching happens locally over the whole set.
   * Concurrent callers share one in-flight fetch instead of each pulling ~15 MB.
   */
  private loadIndicatorCatalog(ctx: Context): Promise<Indicator[]> {
    return this.cachedReference('indicator-catalog', ctx, async (shared) => {
      const raw = await this.fetchAllPages<RawIndicator>('/indicator', {}, shared, () => {
        throw serviceUnavailable(
          'World Bank returned an error response for the indicator catalog listing.',
        );
      });
      const indicators = raw.map(normalizeIndicator);
      shared.log.debug('Indicator catalog loaded', { count: indicators.length });
      return indicators;
    });
  }

  async searchIndicators(
    opts: {
      query?: string;
      topicId?: string;
      sourceId?: string;
      page: number;
      perPage: number;
    },
    ctx: Context,
  ): Promise<{ indicators: Indicator[]; total: number; page: number; pages: number }> {
    const { query, topicId, sourceId, page, perPage } = opts;

    // Matching ignores everything but letters and digits, so a query made only
    // of punctuation has no term to match — rejected rather than read as "no
    // filter", which would return the whole scope under an echoed query.
    if (query !== undefined && !normalizeForMatch(query)) {
      throw validationError(
        `Query "${query}" has no letters or digits to search for; punctuation is ignored when matching.`,
        { reason: 'empty_query', query },
      );
    }

    // /topic/{id}/indicator honors `source` exactly as /indicator does — it
    // intersects the two scopes and rejects an unknown source ID — so both
    // filters go upstream together.
    const path = topicId ? `/topic/${encodeURIComponent(topicId)}/indicator` : '/indicator';
    const scopeParams: Record<string, string | number | undefined> = { source: sourceId };

    const invalidScope: () => never = () => {
      throw notFound(
        'Invalid topic_id or source_id. Use worldbank_list_topics or worldbank_list_sources to browse valid IDs.',
        { reason: 'invalid_filter', topicId, sourceId },
      );
    };

    if (!query) {
      // No keyword: upstream pagination is authoritative, one request per page.
      const url = this.buildUrl(path, { ...scopeParams, page, per_page: perPage });
      ctx.log.debug('Listing indicators', { url });
      const data = await this.fetchLookup<RawIndicator>(url, ctx);
      if (isWbErrorEnvelope(data)) invalidScope();

      const [paging, items] = data as WbEnvelope<RawIndicator>;
      return {
        indicators: (items ?? []).map(normalizeIndicator),
        total: paging.total,
        page: paging.page,
        pages: paging.pages,
      };
    }

    // Keyword matching is entirely client-side, so every candidate in scope has
    // to be in hand before filtering — otherwise matches past the first upstream
    // page are unreachable through any tool input.
    const pool =
      topicId || sourceId
        ? (
            await this.fetchAllPages<RawIndicator>(path, scopeParams, ctx, invalidScope, !!topicId)
          ).map(normalizeIndicator)
        : await this.loadIndicatorCatalog(ctx);

    const matches = matchIndicators(dedupeIndicators(pool), query);
    const start = (page - 1) * perPage;
    return {
      indicators: matches.slice(start, start + perPage),
      total: matches.length,
      page,
      pages: Math.ceil(matches.length / perPage),
    };
  }

  async getIndicator(indicatorId: string, ctx: Context): Promise<IndicatorDetail> {
    const url = this.buildUrl(`/indicator/${encodeURIComponent(indicatorId)}`);
    ctx.log.debug('Fetching indicator', { indicatorId, url });

    const data = await this.fetchLookup<RawIndicator>(url, ctx);

    if (isWbErrorEnvelope(data)) {
      throw notFound(
        `Indicator "${indicatorId}" not found. Use worldbank_search_indicators to find valid IDs.`,
        { reason: 'indicator_not_found', indicatorId },
      );
    }

    const [, items] = data as WbEnvelope<RawIndicator>;
    if (!items?.length) {
      throw notFound(
        `Indicator "${indicatorId}" not found. Use worldbank_search_indicators to find valid IDs.`,
        { reason: 'indicator_not_found', indicatorId },
      );
    }

    const ids = distinctIds(items);
    if (ids.length > 1) {
      throw validationError(
        `Indicator ID "${indicatorId}" selects more than one indicator (${sampleIds(ids)}). ` +
          'Pass a single indicator ID, or use worldbank_search_indicators to list indicators.',
        { reason: 'multiple_indicators', indicatorId, matchedIds: ids.slice(0, ID_SAMPLE_SIZE) },
      );
    }

    // An ID published under both a live and an archived source resolves to two
    // rows here, in upstream's arbitrary order. Same tie-break as the catalog
    // search, so both report the same source for the same ID.
    return items.map(normalizeIndicatorDetail).reduce(preferredRow);
  }

  /**
   * Fetch every catalog row for an indicator ID — empty when the catalog doesn't
   * list it. Called only from the data endpoint's error path: its envelope never
   * names the rejected path segment, and `/indicator/{id}` is unambiguous by
   * construction.
   */
  private async lookupCatalogRows(indicatorId: string, ctx: Context): Promise<Indicator[]> {
    const url = this.buildUrl(`/indicator/${encodeURIComponent(indicatorId)}`);
    ctx.log.debug('Looking up the catalog record behind a data rejection', { indicatorId, url });

    const data = await this.fetchLookup<RawIndicator>(url, ctx);
    if (isWbErrorEnvelope(data)) return [];

    const [, items] = data as WbEnvelope<RawIndicator>;
    return (items ?? []).map(normalizeIndicator);
  }

  /**
   * The catalog rows behind an id-175 rejection, which name the source(s) whose
   * source-scoped data API can serve the indicator instead. A failed lookup yields
   * no rows rather than an unrelated upstream error: the rejection alone already
   * settles that the standard endpoint won't serve the indicator.
   */
  private async catalogRowsForUnserved(indicatorId: string, ctx: Context): Promise<Indicator[]> {
    try {
      return await this.lookupCatalogRows(indicatorId, ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('Catalog lookup failed; no source to route the unserved indicator to', {
        indicatorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * The error for an indicator neither data path can serve: the standard endpoint
   * rejected it with id 175, and no catalog source resolved to a source-scoped
   * layout the tool can address.
   */
  private indicatorNotQueryable(indicatorId: string, rows: Indicator[], detail: string): McpError {
    const sourceNames = [...new Set(rows.map((row) => row.sourceName.trim()).filter(Boolean))];
    const name = rows[0]?.name;
    const label = name ? `"${indicatorId}" (${name})` : `"${indicatorId}"`;
    const cause =
      sourceNames.length > 0
        ? ` is catalogued under ${new Intl.ListFormat('en', { type: 'conjunction' }).format(sourceNames)}, but neither the World Bank data endpoint nor the source-scoped data API can serve it`
        : ' is not served by the World Bank data endpoint for any country or date, and no catalog source could be resolved to query its source-scoped data API instead';

    return notFound(
      `Indicator ${label}${cause}. Detail: ${detail.replace(/\.$/, '')}. ` +
        'Use worldbank_search_indicators to find another indicator for the same measure.',
      {
        reason: 'indicator_not_queryable',
        indicatorId,
        detail,
        ...(sourceNames.length > 0 && { sourceNames }),
      },
    );
  }

  // ─── Source-scoped data API ──────────────────────────────────────────────

  /**
   * Fetch every page of a `/sources/...` request and return the items `pick`
   * selects from each. The id-160 envelope names no segment — callers validate the
   * segments first — so it reads as no items.
   */
  private async fetchSourcePages<TBody, TItem>(
    path: string,
    ctx: Context,
    pick: (body: TBody) => TItem[] | undefined,
  ): Promise<TItem[]> {
    const requestPage = (page: number) => {
      const url = this.buildUrl(path, { page, per_page: BULK_PAGE_SIZE });
      ctx.log.debug('Fetching source-scoped page', { url });
      return this.fetchWithRetry<(TBody & { pages?: number | string }) | WbErrorEnvelope>(
        url,
        ctx,
        BULK_TIMEOUT_MS,
      );
    };

    const first = await requestPage(1);
    if (isWbErrorEnvelope(first)) return [];
    const pages = Number(first.pages ?? 1);
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => requestPage(i + 2)));
    return [first, ...rest].flatMap((body) => (isWbErrorEnvelope(body) ? [] : (pick(body) ?? [])));
  }

  /** A source's concept layout, or `undefined` when the tool can't address its data. */
  private sourceLayout(sourceId: string, ctx: Context): Promise<SourceLayout | undefined> {
    return this.cachedReference(`source/${sourceId}/concepts`, ctx, async (shared) => {
      const url = this.buildUrl(`/sources/${encodeURIComponent(sourceId)}/concepts`);
      const listing = await this.fetchWithRetry<RawSourceListing | WbErrorEnvelope>(url, shared);
      return isWbErrorEnvelope(listing) ? undefined : layoutFromConcepts(sourceId, listing);
    });
  }

  /** One of a source's value listings: `country`, `time`, or its extra dimension. */
  private sourceValues(sourceId: string, concept: string, ctx: Context): Promise<DimensionValue[]> {
    const path = `/sources/${encodeURIComponent(sourceId)}/${encodeURIComponent(concept.toLowerCase())}`;
    return this.cachedReference(`source/${sourceId}/${concept.toLowerCase()}`, ctx, (shared) =>
      this.fetchSourcePages<RawSourceListing, DimensionValue>(path, shared, valuesFromListing),
    );
  }

  /**
   * Choose the catalog source to query and the dimension value the caller named.
   * Candidates run live source first, the order `preferredRow` ranks them in. A
   * named value routes to the first candidate whose listing carries it, which is
   * how an ID published under a live and an archived source reaches the archive
   * (`FPN 4.1` is listed only by FPN Datahub Archive). With no value named, the
   * first addressable candidate is used.
   */
  private async routeSource(
    indicatorId: string,
    rows: Indicator[],
    dimensionValue: string | undefined,
    detail: string,
    ctx: Context,
  ): Promise<{
    row: Indicator;
    layout: SourceLayout;
    values: DimensionValue[];
    requested?: DimensionValue;
  }> {
    // `/indicator/{id}` answers one row per catalog source.
    const preferred = rows.reduce(preferredRow);
    const candidates = [preferred, ...rows.filter((row) => row.sourceId !== preferred.sourceId)];

    const addressable: Array<{ row: Indicator; layout: SourceLayout; values: DimensionValue[] }> =
      [];
    for (const row of candidates) {
      const layout = await this.sourceLayout(row.sourceId, ctx);
      if (!layout) continue;
      const values = layout.dimension
        ? await this.sourceValues(row.sourceId, layout.dimension, ctx)
        : [];
      if (dimensionValue === undefined) return { row, layout, values };
      const requested = values.find((v) => v.id.toLowerCase() === dimensionValue.toLowerCase());
      if (requested) return { row, layout, values, requested };
      addressable.push({ row, layout, values });
    }

    if (addressable.length === 0) throw this.indicatorNotQueryable(indicatorId, rows, detail);

    const withDimension = addressable.filter((a) => a.layout.dimension);
    if (withDimension.length === 0) {
      throw validationError(
        `dimension_value "${dimensionValue}" does not apply: ${addressable[0]?.layout.sourceName} (source ${addressable[0]?.layout.sourceId}), which serves "${indicatorId}", has no dimension beyond country, series, and time.`,
        { reason: 'dimension_not_applicable', indicatorId, dimensionValue },
      );
    }

    const listings = withDimension.map(
      ({ layout, values }) =>
        `${layout.sourceName} (source ${layout.sourceId}) ${layout.dimension}: ${values.map((v) => v.id).join(', ')}`,
    );
    throw validationError(
      `dimension_value "${dimensionValue}" is not a value "${indicatorId}" can be queried at. Valid values — ${listings.join('; ')}.`,
      {
        reason: 'unknown_dimension_value',
        indicatorId,
        dimensionValue,
        validValues: withDimension.map(({ layout, values }) => ({
          sourceId: layout.sourceId,
          concept: layout.dimension,
          ids: values.map((v) => v.id),
        })),
      },
    );
  }

  /**
   * Serve an indicator the standard endpoint rejected with id 175 from its catalog
   * source's source-scoped data API. Every path segment is validated before the
   * request — upstream silently drops an unknown member of a `;` list and answers
   * any other bad segment with an id-160 envelope that names none — so a response
   * with no rows is reported as an empty result. The full scope is read
   * and paginated locally: `mrv`, `mrnev`, and the default version are computed
   * from it, and upstream's row order changes with the shape of the request.
   * `frequency` narrows the source's own time tokens to that form before the request.
   */
  private async serveFromSource(
    opts: GetDataOptions,
    detail: string,
    ctx: Context,
  ): Promise<DataResult> {
    const { indicatorId, countries, dateRange, dimensionValue, frequency, page, perPage } = opts;
    const catalogRows = await this.catalogRowsForUnserved(indicatorId, ctx);
    if (catalogRows.length === 0)
      throw this.indicatorNotQueryable(indicatorId, catalogRows, detail);

    const { row, layout, values, requested } = await this.routeSource(
      indicatorId,
      catalogRows,
      dimensionValue,
      detail,
      ctx,
    );
    const { sourceId } = layout;

    const [index, sourceCountries, timeTokens] = await Promise.all([
      this.loadCountryIndex(ctx),
      this.sourceValues(sourceId, 'country', ctx),
      this.sourceValues(sourceId, 'time', ctx),
    ]);

    // ── Countries: the source takes its own three-character codes only ──
    const codes = Array.isArray(countries) ? countries : countries.split(';');
    const isAll = codes.length === 1 && codes[0]?.toLowerCase() === 'all';
    const listed = new Set(sourceCountries.map((c) => c.id.toUpperCase()));
    const countryIds: string[] = [];
    const uncovered: string[] = [];
    const invalid: string[] = [];
    if (!isAll) {
      for (const code of codes) {
        const upper = code.toUpperCase();
        const entityId = listed.has(upper) ? upper : index.entities.get(upper)?.id.toUpperCase();
        if (entityId && listed.has(entityId)) {
          if (!countryIds.includes(entityId)) countryIds.push(entityId);
        } else if (entityId) uncovered.push(code);
        else invalid.push(code);
      }
    }
    if (invalid.length > 0) {
      throw notFound(
        `Country code(s) "${invalid.join(';')}" not valid. Use worldbank_list_countries to browse valid codes.`,
        { reason: 'country_not_found', countryCodes: invalid.join(';'), indicatorId },
      );
    }

    // ── Dimension value ──
    const concept = layout.dimension;
    let selection: DimensionSelection | 'resolve_version' | undefined;
    let pinned: DimensionValue | undefined;
    if (concept && requested) {
      selection = 'requested';
      pinned = requested;
    } else if (concept) {
      const choice = defaultSelection(concept, values);
      selection = choice.selection;
      if ('value' in choice) pinned = choice.value;
    }

    // ── Periods: explicit tokens, since the API has no range syntax ──
    const window = parseDateWindow(dateRange);
    const periodTokens = timeTokens.filter((token) => {
      const period = periodFromToken(token.id);
      if (frequency && periodForm(period) !== frequency) return false;
      return !window || (monthSpan(period) !== undefined && isWithinWindow(period, window));
    });

    const countryCount = isAll ? sourceCountries.length : countryIds.length;
    const valueCount = concept && !pinned ? Math.max(values.length, 1) : 1;
    const estimatedRows = countryCount * periodTokens.length * valueCount;
    if (estimatedRows > SOURCE_SCOPE_ROW_LIMIT) {
      throw validationError(
        `Querying "${row.id}" from ${layout.sourceName} for ${countryCount} countries × ${periodTokens.length} periods` +
          `${valueCount > 1 ? ` × ${valueCount} ${concept} values` : ''} would read ${estimatedRows.toLocaleString('en')} rows, ` +
          `over the ${SOURCE_SCOPE_ROW_LIMIT.toLocaleString('en')}-row limit for one source-scoped request.`,
        { reason: 'source_scope_too_large', indicatorId, sourceId, estimatedRows },
      );
    }

    // A scope that selects no country or no period has no rows to request.
    let rows: ScopedRow[] = [];
    let lastUpdated: string | undefined;
    if ((isAll || countryIds.length > 0) && periodTokens.length > 0) {
      let path = `/sources/${encodeURIComponent(sourceId)}/country/${encodeURIComponent(isAll ? 'all' : countryIds.join(';'))}/series/${encodeURIComponent(row.id)}`;
      if (periodTokens.length < timeTokens.length) {
        path += `/time/${encodeURIComponent(periodTokens.map((t) => t.id).join(';'))}`;
      }
      if (concept && pinned) {
        path += `/${encodeURIComponent(concept.toLowerCase())}/${encodeURIComponent(pinned.id)}`;
      }
      const raw = await this.fetchSourcePages<RawSourceData, RawSourceObservation>(
        path,
        ctx,
        (body) => {
          lastUpdated ||= body.lastupdated;
          return body.source?.data;
        },
      );
      rows = raw.flatMap((item) => readRow(item, concept) ?? []);
    }

    if (selection === 'resolve_version') {
      const newest = newestVersionWithData(rows, values);
      selection = newest ? 'newest_with_data' : 'newest';
      pinned = newest ?? values.at(-1);
      rows = rows.filter((r) => r.dimension?.id.toLowerCase() === pinned?.id.toLowerCase());
    }
    const latest = latestSelection(opts);
    if (latest) {
      const form = frequency ?? selectionForm(rows.map((r) => r.period));
      rows = selectLatest(rows, latest, form, SCOPED_ROW_READER).rows;
    }
    rows = sortRows(rows, values);

    const start = (page - 1) * perPage;
    const data = rows.slice(start, start + perPage).map((r): DataPoint => {
      const entity = index.entities.get(r.countryId.toUpperCase());
      return {
        countryCode: entity?.iso2 || r.countryId,
        countryIso3: r.countryId,
        countryName: r.countryName,
        date: r.period,
        value: r.value,
        obsStatus: '',
        isAggregate: index.aggregateCodes.has(r.countryId),
        ...(r.dimension && { dimension: r.dimension }),
      };
    });

    return {
      data,
      indicator: { id: row.id, name: row.name },
      total: rows.length,
      page,
      pages: Math.max(1, Math.ceil(rows.length / perPage)),
      perPage,
      nullCount: data.filter((d) => d.value === null).length,
      dateFilterDropped: false,
      sourceScoped: {
        sourceId,
        sourceName: layout.sourceName,
        dimension:
          concept && selection
            ? { concept, selection, id: pinned?.id ?? null, label: pinned?.label ?? null }
            : null,
        note:
          `Not from the standard World Bank data endpoint, which does not serve "${row.id}": these values come from this ` +
          "source's own dataset through the source-scoped data API, and may be archived or superseded figures.",
      },
      uncoveredCountries: uncovered,
      ...(lastUpdated && { lastUpdated }),
      periodForms: formsOf(timeTokens.map((token) => periodFromToken(token.id))),
      allNull: rows.length > 0 && rows.every((r) => r.value === null),
    };
  }

  // ─── Countries ───────────────────────────────────────────────────────────

  /**
   * One page of the country listing, at most {@link MAX_COUNTRIES_PER_PAGE}
   * entries, with pages counted at the size served on either path.
   */
  async listCountries(
    opts: {
      region?: string;
      incomeLevel?: string;
      /** A `/v2/lendingType` id: `IBD`, `IDB`, `IDX`, or `LNX`. */
      lendingType?: string;
      includeAggregates: boolean;
      page: number;
      perPage: number;
    },
    ctx: Context,
  ): Promise<{
    countries: Country[];
    total: number;
    page: number;
    pages: number;
    /** Page size actually served: the requested size, reduced to the page cap when larger. */
    perPage: number;
  }> {
    const { region, incomeLevel, lendingType, includeAggregates, page } = opts;
    const perPage = Math.min(opts.perPage, MAX_COUNTRIES_PER_PAGE);

    const filterParams: Record<string, string | number | undefined> = {};
    if (region) filterParams.region = region;
    if (incomeLevel) filterParams.incomeLevel = incomeLevel;
    if (lendingType) filterParams.lendingType = lendingType;

    const invalidFilter: () => never = () => {
      throw notFound(
        'Invalid region or income_level code. Use worldbank_list_countries without filters to browse valid codes.',
        { reason: 'invalid_filter', region, incomeLevel },
      );
    };

    /**
     * The WB API has no server-side aggregate filter, so excluding aggregates
     * means fetching every entity in scope before dropping them and paginating
     * the remainder — otherwise entities past the first upstream page are
     * unreachable and total/pages under-report. `lendingType` takes the same
     * path whatever `includeAggregates` says: upstream answers `IBD`, `IDB`, and
     * `IDX` with every entry twice and counts both copies in `paging.total`
     * (118 rows for 59 `IDX` countries), so only a deduplicated local page is
     * right. No aggregate carries a lending type, so none survive that filter.
     */
    if (!includeAggregates || lendingType) {
      const raw = await this.fetchAllPages<RawCountry>(
        '/country',
        filterParams,
        ctx,
        invalidFilter,
      );
      const unique = new Map(raw.map((country) => [country.id ?? '', country]));
      const countries = [...unique.values()]
        .map(normalizeCountry)
        .filter((c) => includeAggregates || !c.isAggregate);
      const start = (page - 1) * perPage;
      return {
        countries: countries.slice(start, start + perPage),
        total: countries.length,
        page,
        pages: Math.max(1, Math.ceil(countries.length / perPage)),
        perPage,
      };
    }

    const url = this.buildUrl('/country', { ...filterParams, page, per_page: perPage });
    ctx.log.debug('Listing countries', { url });

    const data = await this.fetchWithRetry<WbEnvelope<RawCountry> | WbErrorEnvelope>(url, ctx);
    if (isWbErrorEnvelope(data)) invalidFilter();

    const [paging, items] = data as WbEnvelope<RawCountry>;
    return {
      countries: (items ?? []).map(normalizeCountry),
      total: paging.total,
      page: paging.page,
      pages: paging.pages,
      perPage,
    };
  }

  async getCountry(countryCode: string, ctx: Context): Promise<Country> {
    const url = this.buildUrl(`/country/${encodeURIComponent(countryCode)}`);
    ctx.log.debug('Fetching country', { countryCode, url });

    const data = await this.fetchWithRetry<WbEnvelope<RawCountry> | WbErrorEnvelope>(url, ctx);

    if (isWbErrorEnvelope(data)) {
      throw notFound(
        `Country code "${countryCode}" not found. Use worldbank_list_countries to browse valid codes.`,
        { reason: 'country_not_found', countryCode },
      );
    }

    const [, items] = data as WbEnvelope<RawCountry>;
    if (!items?.length) {
      throw notFound(
        `Country code "${countryCode}" not found. Use worldbank_list_countries to browse valid codes.`,
        { reason: 'country_not_found', countryCode },
      );
    }

    const ids = distinctIds(items);
    if (ids.length > 1) {
      throw validationError(
        `Country code "${countryCode}" selects more than one country (${sampleIds(ids)}). ` +
          'Pass a single ISO2, ISO3, or aggregate code, or use worldbank_list_countries to list countries.',
        { reason: 'multiple_countries', countryCode, matchedIds: ids.slice(0, ID_SAMPLE_SIZE) },
      );
    }

    return normalizeCountry(items[0] as RawCountry);
  }

  /**
   * Load and cache an index of every entity in the country listing. The data
   * endpoint's rows carry no `region`/`incomeLevel` field, so an observation can
   * only be classified by looking its code up here — the same `region.id === "NA"`
   * rule {@link normalizeCountry} applies, which keeps the data tool in agreement
   * with the country tools by construction.
   *
   * Both identifiers go in `aggregateCodes`: a data row names an aggregate by ISO2
   * in `country.id` (`ZH`) and by its aggregate code in `countryiso3code` (`AFE`).
   * `entities` maps either identifier, uppercased, to both — the source-scoped
   * API and PIP take only the three-character code, where callers may pass ISO2.
   */
  private loadCountryIndex(ctx: Context): Promise<CountryIndex> {
    return this.cachedReference('country-index', ctx, async (shared) => {
      const raw = await this.fetchAllPages<RawCountry>('/country', {}, shared, () => {
        throw serviceUnavailable(
          'World Bank returned an error response for the country listing used to classify aggregates.',
        );
      });
      const index: CountryIndex = { aggregateCodes: new Set(), entities: new Map() };
      for (const country of raw) {
        const entity: CountryEntity = {
          id: country.id ?? '',
          iso2: country.iso2Code ?? '',
          isAggregate: normalizeCountry(country).isAggregate,
        };
        if (entity.id) index.entities.set(entity.id.toUpperCase(), entity);
        if (entity.iso2) index.entities.set(entity.iso2.toUpperCase(), entity);
        if (!entity.isAggregate) continue;
        if (entity.id) index.aggregateCodes.add(entity.id);
        if (entity.iso2) index.aggregateCodes.add(entity.iso2);
      }
      shared.log.debug('Country index loaded', { aggregates: index.aggregateCodes.size });
      return index;
    });
  }

  /**
   * Look a country or aggregate up by either identifier, case-insensitively, and
   * return both — the three-character ID and the ISO2 code — with whether it is
   * an aggregate, or `undefined` when the country listing carries no entity
   * under that code. Served from the cached country index.
   */
  async lookupCountry(code: string, ctx: Context): Promise<CountryEntity | undefined> {
    const { entities } = await this.loadCountryIndex(ctx);
    return entities.get(code.trim().toUpperCase());
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  /**
   * Place a rejection of the country segment on the requested codes the country
   * index lacks — upstream's envelope never names the codes at fault. Read only
   * once upstream has rejected the request, so the index never gates a call
   * upstream would accept. It places the blame and never decides it: when it
   * knows every code, or fails to load, every requested code is named.
   */
  private async blamedCountryCodes(codes: string[], ctx: Context): Promise<string> {
    try {
      const { entities } = await this.loadCountryIndex(ctx);
      const unknown = codes.filter((code) => !entities.has(code.toUpperCase()));
      return (unknown.length > 0 ? unknown : codes).join(';');
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('Country index unavailable; naming every requested country code', {
        error: err instanceof Error ? err.message : String(err),
      });
      return codes.join(';');
    }
  }

  /**
   * The standard endpoint's path for a data request.
   *
   * The API's edge firewall answers HTTP 403 to any country segment carrying
   * `;LS` — Lesotho after another code — which reads as a shell command. `LS`
   * is the only one of the 295 codes the listing carries that it blocks, and
   * `LSO` names the same economy, so the path sends that. Rows still name
   * Lesotho `LS` / `LSO`.
   */
  private dataPath(codes: readonly string[], indicatorId: string): string {
    const pathCodes = codes.map((code) => (code.toUpperCase() === 'LS' ? 'LSO' : code)).join(';');
    return `/country/${encodeURIComponent(pathCodes)}/indicator/${encodeURIComponent(indicatorId)}`;
  }

  /**
   * Every page of one data request over `date`, at `perPage` rows a page. A read
   * of every entry can run to megabytes a page and gets the bulk timeout. A read
   * of listed countries is small and gets the ordinary one: the origin sometimes
   * holds a request for about a minute before answering, and a retry after the
   * ordinary timeout answers it sooner.
   */
  private readSeries(
    path: string,
    date: string,
    perPage: number,
    ctx: Context,
  ): Promise<SeriesRead | WbErrorEnvelope> {
    const timeoutMs = /^\/country\/all\//i.test(path) ? BULK_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    return this.readAllPages<RawDataPoint>(path, { date }, ctx, {
      perPage,
      idInPath: true,
      timeoutMs,
    });
  }

  /** Upstream page `page` of one data request over `date`, at `perPage` rows a page. */
  private async readSeriesPage(
    path: string,
    date: string,
    page: number,
    perPage: number,
    ctx: Context,
  ): Promise<SeriesRead | WbErrorEnvelope> {
    const url = this.buildUrl(path, { date, page, per_page: perPage });
    ctx.log.debug('Fetching upstream page', { url });
    const body = await this.fetchLookup<RawDataPoint>(url, ctx);
    if (isWbErrorEnvelope(body)) return body;
    const [paging, items] = body;
    return { paging, items: items ?? [] };
  }

  /**
   * One upstream page of a call reading the whole series — no `date_range`,
   * `mrv`, or `mrnev` — served with upstream's own paging. It is not checked:
   * a page boundary cuts a country's periods, so the grid check would fire on
   * honest pages, and the whole-series read it would need costs up to 27 MB for
   * one 200-row page. With `frequency`, a page holding rows at another form is
   * the whole series a single-form source answers a window at a form it lacks
   * with, so the form is not published; a page past the end shows no rows, and
   * page 1 is read to tell which.
   */
  private async servePage(
    path: string,
    date: string,
    read: SeriesRead,
    opts: GetDataOptions,
    ctx: Context,
  ): Promise<DataResult> {
    const { indicatorId, frequency, page, perPage } = opts;
    let { items } = read;
    let total = Number(read.paging.total ?? 0);
    let pages = Number(read.paging.pages ?? 0);
    let periodForms = formsOf(items.map(OBSERVATION_READER.period));

    if (frequency) {
      let sample = items;
      if (sample.length === 0 && total > 0 && page !== 1) {
        const first = await this.readSeriesPage(path, date, 1, perPage, ctx);
        if (!isWbErrorEnvelope(first)) sample = first.items;
      }
      if (sample.some((raw) => periodForm(raw.date ?? '') !== frequency)) {
        periodForms = formsOf(sample.map(OBSERVATION_READER.period));
        items = [];
        total = 0;
        pages = 1;
      }
    }

    const index = items.length > 0 ? await this.loadCountryIndex(ctx) : undefined;
    const data = index ? items.map((raw) => normalizeDataPoint(raw, index)) : [];
    const indicatorMeta = items[0]?.indicator;
    const lastUpdated = read.paging.lastupdated;

    return {
      data,
      indicator: { id: indicatorMeta?.id ?? indicatorId, name: indicatorMeta?.value ?? '' },
      total,
      page,
      pages,
      perPage,
      nullCount: data.filter((d) => d.value === null).length,
      dateFilterDropped: false,
      ...(lastUpdated && { lastUpdated }),
      periodForms,
    };
  }

  /**
   * `read`, once it passes {@link suspectRead}; a suspect read is requested once
   * more at {@link REREAD_PAGE_SIZE}. The re-read is served when it passes, or
   * when it matches the first read, which makes the suspect shape the honest
   * answer. Otherwise neither is served and the call fails as
   * `upstream_inconsistent`.
   */
  private async confirmRead(
    path: string,
    date: string,
    read: SeriesRead,
    ctx: Context,
    required?: ReadonlySet<string>,
  ): Promise<SeriesRead> {
    const suspicion = suspectRead(read.items, date, required);
    if (!suspicion) return read;

    ctx.log.warning('Data read looks like the answer to another request; re-reading it', {
      path,
      date,
      suspicion,
    });
    const again = await this.readSeries(path, date, REREAD_PAGE_SIZE, ctx);
    if (
      !isWbErrorEnvelope(again) &&
      (!suspectRead(again.items, date, required) || sameRows(read.items, again.items))
    ) {
      return again;
    }
    throw serviceUnavailable(
      `The World Bank API answered the data request for date=${date} twice with rows that do not fit it (${suspicion}); ` +
        'its response cache can answer one query with the rows computed for another, so neither answer is served.',
      { reason: 'upstream_inconsistent', date, suspicion },
    );
  }

  /**
   * The rows `latest` selects at `frequency` (by default annual, or the series'
   * own form when it has no annual periods), the last update of the envelope
   * serving them, and the period forms the reads carried. The window read answers
   * nearly every call; when it falls short, one read over the {@link fullSpan} at
   * the same form follows — of the whole list for `mrv`, when every country (or
   * the window read itself) came up short, or when a short one has no code of its
   * own to request it by (none, or one it shares: Doing Business sends Beijing as
   * `CHN`, which the country path reads as China alone), and otherwise of the codes
   * of only the countries short of `count` values, whose rows then take their
   * place in the window read's order. The widened read must hold every period the
   * window read did.
   *
   * A list of short countries can name an entity the country path rejects by
   * code — Global Economic Monitor returns legacy `YUG` under `all` — and upstream
   * then answers the whole list with its invalid-value envelope, so the widen
   * falls back to the list the window read was accepted for.
   */
  private async latestRows(
    path: string,
    indicatorId: string,
    read: SeriesRead,
    latest: LatestSelection,
    frequency: PeriodForm | undefined,
    ctx: Context,
  ): Promise<{ rows: RawDataPoint[]; lastUpdated: string | undefined; periodForms: PeriodForm[] }> {
    const form = frequency ?? selectionForm(read.items.map(OBSERVATION_READER.period));
    const inWindow = selectLatest(read.items, latest, form, OBSERVATION_READER);
    if (inWindow.complete) {
      return {
        rows: inWindow.rows,
        lastUpdated: read.paging.lastupdated,
        periodForms: formsOf(read.items.map(OBSERVATION_READER.period)),
      };
    }

    const span = fullSpan(frequency ?? 'year');
    const codes = new Map(read.items.map((raw) => [observationSeries(raw), observationCode(raw)]));
    const entitiesByCode = new Map<string, number>();
    for (const code of codes.values())
      entitiesByCode.set(code, (entitiesByCode.get(code) ?? 0) + 1);
    const shortCodes = [...new Set(inWindow.short.map((series) => codes.get(series) ?? ''))];
    let everyCountry =
      latest.mode === 'mrv' ||
      inWindow.short.length === codes.size ||
      shortCodes.some((code) => !code || (entitiesByCode.get(code) ?? 0) > 1);
    let widenPath = everyCountry ? path : this.dataPath(shortCodes, indicatorId);
    let widened = await this.readSeries(widenPath, span, DATA_PAGE_SIZE, ctx);
    if (isWbErrorEnvelope(widened) && !everyCountry) {
      ctx.log.debug('Upstream rejected the short countries by code; widening the whole list', {
        path: widenPath,
      });
      everyCountry = true;
      widenPath = path;
      widened = await this.readSeries(path, span, DATA_PAGE_SIZE, ctx);
    }
    if (isWbErrorEnvelope(widened)) {
      throw serviceUnavailable('World Bank returned an error response for the observation series.');
    }
    const windowPeriods = new Set(read.items.map(OBSERVATION_READER.period));
    const whole = await this.confirmRead(widenPath, span, widened, ctx, windowPeriods);
    const selected = selectLatest(
      whole.items,
      latest,
      form ?? selectionForm(whole.items.map(OBSERVATION_READER.period)),
      OBSERVATION_READER,
    ).rows;
    const lastUpdated = read.paging.lastupdated || whole.paging.lastupdated;
    const periodForms = formsOf([...read.items, ...whole.items].map(OBSERVATION_READER.period));
    if (everyCountry) return { rows: selected, lastUpdated, periodForms };

    const short = new Set(inWindow.short);
    const order = new Map([...codes.keys()].map((s, i) => [s, i]));
    const position = (raw: RawDataPoint) => order.get(observationSeries(raw)) ?? order.size;
    const rows = [
      ...inWindow.rows.filter((raw) => !short.has(observationSeries(raw))),
      ...selected,
    ].sort((a, b) => position(a) - position(b));
    return { rows, lastUpdated, periodForms };
  }

  /**
   * One page of observations. The page size is reduced to
   * {@link MAX_OBSERVATIONS_PER_PAGE} once, here, so every path below serves and
   * counts pages at that size.
   *
   * Every standard-endpoint read carries `date` and never `mrv`, `mrnev`, or
   * `frequency`, which the API's response cache does not key on: `date_range` as
   * given, the {@link latestWindow} at the `frequency` form for `mrv` and
   * `mrnev`, and otherwise the {@link fullSpan} at that form. A call with neither
   * `date_range` nor `mrv`/`mrnev` reads just the page asked for
   * ({@link servePage}). Every other read takes every upstream page and passes
   * {@link confirmRead} before anything is served, and pages are sliced locally
   * out of the rows served — those inside `date_range`, or those `mrv`/`mrnev`
   * select — so `total` and `pages` are the same on every page.
   *
   * A window's period form selects which periods a series publishing several
   * returns (Global Economic Monitor: a year window its annual rows, a quarter or
   * month window rows at that form, null-filled where it has none). A window the
   * API can't apply — one overlapping no part of the series, or at a form a
   * single-form series lacks — makes upstream discard the filter and return the
   * whole series, which is indistinguishable from a hit until the returned
   * periods are checked against the ones asked for, so rows are kept by their
   * overlap with the window: `2019:2021` keeps a quarterly series' twelve quarters.
   */
  async getData(requested: GetDataOptions, ctx: Context): Promise<DataResult> {
    const opts = { ...requested, perPage: Math.min(requested.perPage, MAX_OBSERVATIONS_PER_PAGE) };
    const { indicatorId, countries, dateRange, dimensionValue, frequency, page, perPage } = opts;
    const latest = latestSelection(opts);

    const codes = Array.isArray(countries) ? countries : countries.split(';');
    const path = this.dataPath(codes, indicatorId);
    const date =
      dateRange ??
      (latest
        ? latestWindow(latest.count, new Date().getUTCFullYear(), frequency)
        : fullSpan(frequency ?? 'year'));
    ctx.log.debug('Fetching data', { indicatorId, countries: codes, date });

    const paged = dateRange === undefined && !latest;
    const first = paged
      ? await this.readSeriesPage(path, date, page, perPage, ctx)
      : await this.readSeries(path, date, DATA_PAGE_SIZE, ctx);

    if (isWbErrorEnvelope(first)) {
      // The /country/{codes}/indicator/{id} endpoint wraps errors in an array:
      // [{ message: [...] }], so the envelope itself is an array and .message
      // would be undefined. Unwrap before accessing.
      const envelope = (Array.isArray(first) ? first[0] : first) as WbErrorEnvelope;
      const detail = envelope.message[0]?.value ?? 'Invalid value';

      // Upstream emits one message per rejected path segment and never names
      // which, so two entries prove both segments are bad; one entry needs a
      // second lookup to place. The id-120 envelope text is identical in every
      // case. Id 175 is the exception: upstream reaches it only once the country
      // codes have passed, and it means this endpoint does not serve the
      // indicator — its catalog source's source-scoped API is tried instead.
      if (envelope.message.length > 1) {
        const countryCodes = await this.blamedCountryCodes(codes, ctx);
        throw notFound(
          `Neither indicator "${indicatorId}" nor country code(s) "${countryCodes}" are valid. Detail: ${detail}. Use worldbank_search_indicators and worldbank_list_countries.`,
          { reason: 'indicator_and_country_not_found', indicatorId, countryCodes, detail },
        );
      }
      if (envelope.message[0]?.id === NOT_SERVED_MESSAGE_ID) {
        return this.serveFromSource(opts, detail, ctx);
      }
      if ((await this.lookupCatalogRows(indicatorId, ctx)).length === 0) {
        throw notFound(
          `Indicator "${indicatorId}" not found. Use worldbank_search_indicators to find valid IDs.`,
          { reason: 'indicator_not_found', indicatorId, detail },
        );
      }
      const countryCodes = await this.blamedCountryCodes(codes, ctx);
      throw notFound(
        `Country code(s) "${countryCodes}" not valid. Detail: ${detail}. Use worldbank_list_countries to browse valid codes.`,
        { reason: 'country_not_found', countryCodes, indicatorId, detail },
      );
    }

    // The standard endpoint has no dimension beyond country, indicator, and date,
    // so a dimension value can't have been applied — reported, not ignored.
    if (dimensionValue !== undefined) {
      throw validationError(
        `dimension_value "${dimensionValue}" does not apply: "${indicatorId}" is served by the standard World Bank data endpoint, which has no dimension beyond country, indicator, and date.`,
        { reason: 'dimension_not_applicable', indicatorId, dimensionValue },
      );
    }

    if (paged) return this.servePage(path, date, first, opts, ctx);

    const read = await this.confirmRead(path, date, first, ctx);

    let rows = read.items;
    let lastUpdated = read.paging.lastupdated;
    let periodForms = formsOf(read.items.map(OBSERVATION_READER.period));
    let dateFilterDropped = false;
    const dateWindow = parseDateWindow(dateRange);
    if (latest) {
      ({ rows, lastUpdated, periodForms } = await this.latestRows(
        path,
        indicatorId,
        read,
        latest,
        frequency,
        ctx,
      ));
    } else if (dateWindow) {
      rows = read.items.filter((raw) => isWithinWindow(raw.date ?? '', dateWindow));
      dateFilterDropped = rows.length < read.items.length;
    }

    const indicatorMeta = (read.items[0] ?? rows[0])?.indicator;
    const start = (page - 1) * perPage;
    const pageRows = rows.slice(start, start + perPage);
    const index = pageRows.length > 0 ? await this.loadCountryIndex(ctx) : undefined;
    const data = index ? pageRows.map((raw) => normalizeDataPoint(raw, index)) : [];

    return {
      data,
      indicator: { id: indicatorMeta?.id ?? indicatorId, name: indicatorMeta?.value ?? '' },
      total: rows.length,
      page,
      pages: Math.max(1, Math.ceil(rows.length / perPage)),
      perPage,
      nullCount: data.filter((d) => d.value === null).length,
      dateFilterDropped,
      ...(lastUpdated && { lastUpdated }),
      periodForms,
      allNull: rows.length > 0 && rows.every((raw) => !OBSERVATION_READER.hasValue(raw)),
    };
  }
}

// ─── Init/accessor pattern ─────────────────────────────────────────────────

let _service: WorldBankApiService | undefined;

export function initWorldBankApiService(config: AppConfig, storage: StorageService): void {
  _service = new WorldBankApiService(config, storage);
}

export function getWorldBankApiService(): WorldBankApiService {
  if (!_service) {
    throw new Error(
      'WorldBankApiService not initialized — call initWorldBankApiService() in setup()',
    );
  }
  return _service;
}
