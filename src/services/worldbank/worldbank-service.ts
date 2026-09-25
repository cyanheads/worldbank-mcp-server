/**
 * @fileoverview World Bank Indicators API v2 service. Wraps all endpoint categories
 * (indicators, countries, data, topics, sources) with typed fetch methods,
 * retry/timeout, and sparse-payload normalization. Keyword indicator search,
 * collapse of indicators the catalog publishes twice, aggregate-free country
 * listing, aggregate classification of data rows, and verification of the
 * requested date window are computed locally over exhaustively fetched
 * candidate sets, since the API offers none of them server-side. Indicators the
 * standard data endpoint won't serve (message id 175) are answered from their
 * catalog source's source-scoped data API instead.
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
import { sharedLoadContext, untilAborted } from '@/services/shared-load.js';
import { isWithinWindow, monthSpan, parseDateWindow, periodFromToken } from './periods.js';
import {
  defaultSelection,
  keepMostRecentPeriods,
  layoutFromConcepts,
  newestVersionWithData,
  readRow,
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

function normalizeDataPoint(raw: RawDataPoint, aggregateCodes: Set<string>): DataPoint {
  const countryCode = raw.country?.id ?? '';
  return {
    countryCode,
    countryIso3: raw.countryiso3code ?? '',
    countryName: raw.country?.value ?? '',
    date: raw.date ?? '',
    value: raw.value ?? null,
    obsStatus: raw.obs_status ?? '',
    // Data endpoint returns country.id as ISO2 (e.g. "ZH" for AFE), but
    // countryiso3code carries the aggregate code (e.g. "AFE"). Check both;
    // aggregateCodes holds both identifiers for every aggregate.
    isAggregate: aggregateCodes.has(raw.countryiso3code ?? '') || aggregateCodes.has(countryCode),
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
  const currentArchived = /archive/i.test(current.sourceName);
  const candidateArchived = /archive/i.test(candidate.sourceName);
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

/**
 * Rank the ID/name hits so a caller who typed something specific gets it first:
 * an exact ID or name, then the query as a contiguous phrase, then the rest in
 * catalog order. Without this, `Population, total` buries `SP.POP.TOTL` behind
 * whichever loosely-related indicators happen to sort earlier upstream.
 */
function rankIdOrNameHits(hits: readonly Indicator[], phrase: string): Indicator[] {
  const exact: Indicator[] = [];
  const contiguous: Indicator[] = [];
  const rest: Indicator[] = [];
  for (const indicator of hits) {
    const id = normalizeForMatch(indicator.id);
    const name = normalizeForMatch(indicator.name);
    if (phrase === id || phrase === name) exact.push(indicator);
    else if (`${id} ${name}`.includes(phrase)) contiguous.push(indicator);
    else rest.push(indicator);
  }
  return [...exact, ...contiguous, ...rest];
}

/**
 * Filter indicators by keyword. Every token of the normalized query must appear
 * (case-insensitive substring) in the indicator's ID, name, or source note, so
 * word order doesn't matter — "per capita GDP" and "gdp per capita" return the
 * same set. Tokens are alphanumeric-only, which lets them be matched against the
 * raw haystack directly: an alphanumeric run in the normalized text is present
 * verbatim in the original, so normalizing 29.5k source notes per query buys
 * nothing. Results matching on ID or name are ranked ahead of those that only
 * matched the prose in `sourceNote`, which keeps the useful hits on page one.
 */
function matchIndicators(indicators: readonly Indicator[], query: string): Indicator[] {
  const phrase = normalizeForMatch(query);
  const tokens = phrase.split(' ');

  const byIdOrName: Indicator[] = [];
  const byNote: Indicator[] = [];
  for (const indicator of indicators) {
    const idAndName = `${indicator.id} ${indicator.name}`.toLowerCase();
    if (tokens.every((token) => idAndName.includes(token))) {
      byIdOrName.push(indicator);
      continue;
    }
    const note = indicator.sourceNote.toLowerCase();
    if (tokens.every((token) => idAndName.includes(token) || note.includes(token))) {
      byNote.push(indicator);
    }
  }
  return [...rankIdOrNameHits(byIdOrName, phrase), ...byNote];
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
  mrv?: number;
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
  nullCount: number;
  dateFilterDropped: boolean;
  /** Present when the source-scoped data API served the result instead of the standard endpoint. */
  sourceScoped?: SourceScopedDisclosure;
  /** Valid codes the serving source publishes no data for, left out of the request. */
  uncoveredCountries?: string[];
};

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
   * Fetch every upstream page for a scope and return the concatenated raw items.
   *
   * `pages` from the first response is the loop bound; the accumulated item
   * count — not `paging.total` — is what callers paginate against, since only
   * the rows actually in hand can be served and local filtering changes the
   * count anyway.
   *
   * @param onErrorEnvelope - Throws the caller's domain error when the World
   *   Bank returns its HTTP-200 error envelope for an invalid filter value.
   * @param idInPath - The path carries a caller-supplied ID, so an upstream 404
   *   reaches `onErrorEnvelope` too (see {@link fetchLookup}).
   */
  private async fetchAllPages<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ctx: Context,
    onErrorEnvelope: () => never,
    idInPath = false,
  ): Promise<T[]> {
    const requestPage = async (page: number) => {
      const url = this.buildUrl(path, { ...params, page, per_page: BULK_PAGE_SIZE });
      ctx.log.debug('Fetching upstream page', { url });
      const data = idInPath
        ? await this.fetchLookup<T>(url, ctx, BULK_TIMEOUT_MS)
        : await this.fetchWithRetry<WbEnvelope<T> | WbErrorEnvelope>(url, ctx, BULK_TIMEOUT_MS);
      if (isWbErrorEnvelope(data)) onErrorEnvelope();
      const [paging, items] = data as WbEnvelope<T>;
      return { paging, items: items ?? [] };
    };

    const first = await requestPage(1);
    const pages = Number(first.paging.pages);
    if (pages <= 1) return first.items;

    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => requestPage(i + 2)));
    return [first.items, ...rest.map((r) => r.items)].flat();
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
   * and paginated locally: `mrv` and the default version are computed from it, and
   * upstream's row order changes with the shape of the request.
   */
  private async serveFromSource(
    opts: GetDataOptions,
    detail: string,
    ctx: Context,
  ): Promise<DataResult> {
    const { indicatorId, countries, dateRange, mrv, dimensionValue, page, perPage } = opts;
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
    const periodTokens = window
      ? timeTokens.filter((token) => {
          const period = periodFromToken(token.id);
          return monthSpan(period) !== undefined && isWithinWindow(period, window);
        })
      : timeTokens;

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
        (body) => body.source?.data,
      );
      rows = raw.flatMap((item) => readRow(item, concept) ?? []);
    }

    if (selection === 'resolve_version') {
      const newest = newestVersionWithData(rows, values);
      selection = newest ? 'newest_with_data' : 'newest';
      pinned = newest ?? values.at(-1);
      rows = rows.filter((r) => r.dimension?.id.toLowerCase() === pinned?.id.toLowerCase());
    }
    if (mrv !== undefined) rows = keepMostRecentPeriods(rows, mrv);
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
    };
  }

  // ─── Countries ───────────────────────────────────────────────────────────

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
  ): Promise<{ countries: Country[]; total: number; page: number; pages: number }> {
    const { region, incomeLevel, lendingType, includeAggregates, page, perPage } = opts;

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

  async getData(opts: GetDataOptions, ctx: Context): Promise<DataResult> {
    const { indicatorId, countries, dateRange, mrv, dimensionValue, page, perPage } = opts;

    const countryCodes = Array.isArray(countries) ? countries.join(';') : countries;

    const scope: Record<string, string | number | undefined> = {};
    if (dateRange) scope.date = dateRange;
    if (mrv !== undefined) scope.mrv = mrv;

    const path = `/country/${encodeURIComponent(countryCodes)}/indicator/${encodeURIComponent(indicatorId)}`;
    const url = this.buildUrl(path, { ...scope, page, per_page: perPage });
    ctx.log.debug('Fetching data', { indicatorId, countryCodes, url });

    const data = await this.fetchLookup<RawDataPoint>(url, ctx);

    if (isWbErrorEnvelope(data)) {
      // The /country/{codes}/indicator/{id} endpoint wraps errors in an array:
      // [{ message: [...] }], so data itself is an array and data.message would
      // be undefined. Unwrap before accessing.
      const envelope = (Array.isArray(data) ? data[0] : data) as WbErrorEnvelope;
      const detail = envelope.message[0]?.value ?? 'Invalid value';

      // Upstream emits one message per rejected path segment and never names
      // which, so two entries prove both segments are bad; one entry needs a
      // second lookup to place. The id-120 envelope text is identical in every
      // case. Id 175 is the exception: upstream reaches it only once the country
      // codes have passed, and it means this endpoint does not serve the
      // indicator — its catalog source's source-scoped API is tried instead.
      if (envelope.message.length > 1) {
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

    const [paging, items] = data as WbEnvelope<RawDataPoint>;

    /**
     * A date window the API can't apply — one overlapping no part of the series,
     * or finer-grained than the series it was asked of — makes upstream discard
     * the filter and return the whole thing, which is indistinguishable from a
     * hit until the returned periods are checked against the ones asked for.
     * Whether that happened can only be judged over the complete response, so a
     * windowed query is re-read in full and paginated locally unless the page in
     * hand already is the whole series; otherwise in-window observations past
     * this page are unreachable and total/pages report the series length instead
     * of the match count.
     *
     * That includes a page past the end, which comes back empty: upstream's
     * paging on it still describes whatever series it chose to serve, so only
     * a response with nothing in it at all (`total: 0`) — or one with no window
     * to verify — can be reported as-is. An empty page is no reason to skip the
     * window check, or the total would depend on which page was requested.
     */
    const dateWindow = parseDateWindow(dateRange);

    if (!items?.length && (!dateWindow || !(paging.total > 0))) {
      return {
        data: [],
        indicator: { id: indicatorId, name: '' },
        total: paging.total ?? 0,
        page: paging.page ?? page,
        pages: paging.pages ?? 1,
        nullCount: 0,
        dateFilterDropped: false,
      };
    }

    let matched = items ?? [];
    let total = paging.total;
    let pages = paging.pages;
    let currentPage = paging.page ?? page;
    let dateFilterDropped = false;
    let indicatorMeta = matched[0]?.indicator;

    if (dateWindow) {
      const wholeSeriesInHand = page === 1 && paging.pages <= 1;
      const candidates = wholeSeriesInHand
        ? matched
        : await this.fetchAllPages<RawDataPoint>(path, scope, ctx, () => {
            throw serviceUnavailable(
              'World Bank returned an error response for the observation series.',
            );
          });
      const inWindow = candidates.filter((raw) => isWithinWindow(raw.date ?? '', dateWindow));
      const start = (page - 1) * perPage;

      matched = inWindow.slice(start, start + perPage);
      total = inWindow.length;
      pages = Math.max(1, Math.ceil(inWindow.length / perPage));
      currentPage = page;
      dateFilterDropped = inWindow.length < candidates.length;
      indicatorMeta ??= candidates[0]?.indicator;
    }

    const indicator = { id: indicatorMeta?.id ?? indicatorId, name: indicatorMeta?.value ?? '' };

    if (!matched.length) {
      return {
        data: [],
        indicator,
        total,
        page: currentPage,
        pages,
        nullCount: 0,
        dateFilterDropped,
      };
    }

    const { aggregateCodes } = await this.loadCountryIndex(ctx);
    const dataPoints = matched.map((raw) => normalizeDataPoint(raw, aggregateCodes));

    return {
      data: dataPoints,
      indicator,
      total,
      page: currentPage,
      pages,
      nullCount: dataPoints.filter((d) => d.value === null).length,
      dateFilterDropped,
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
