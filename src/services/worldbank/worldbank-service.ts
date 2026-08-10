/**
 * @fileoverview World Bank Indicators API v2 service. Wraps all endpoint categories
 * (indicators, countries, data, topics, sources) with typed fetch methods,
 * retry/timeout, and sparse-payload normalization. Keyword indicator search,
 * collapse of indicators the catalog publishes twice, aggregate-free country
 * listing, aggregate classification of data rows, and verification of the
 * requested date window are computed locally over exhaustively fetched
 * candidate sets, since the API offers none of them server-side.
 * @module services/worldbank/worldbank-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  Country,
  DataPoint,
  Indicator,
  IndicatorDetail,
  RawCountry,
  RawDataPoint,
  RawIndicator,
  RawSource,
  RawTopic,
  Source,
  Topic,
  WbEnvelope,
} from './types.js';

/** Minimal request-context shape that satisfies fetchWithTimeout and withRetry. */
type ReqCtx = Context & Record<string, unknown>;

// ─── Error detection ─────────────────────────────────────────────────────────

/** Shape returned by the WB API for invalid IDs (HTTP 200, not 404). */
type WbErrorEnvelope = { message: Array<{ id: string; key: string; value: string }> };

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

function normalizeIndicator(raw: RawIndicator): Indicator {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    sourceId: raw.source?.id ?? '',
    sourceName: raw.source?.value ?? '',
    sourceNote: raw.sourceNote ?? '',
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

// ─── Date-range verification ─────────────────────────────────────────────────

/** An inclusive span of calendar months, each numbered `year * 12 + monthIndex`. */
type MonthSpan = { start: number; end: number };

/**
 * Expand one World Bank period token into the months it covers: `2020` is the
 * whole year, `2020Q2` is April–June, `2020M03` is March alone. Anything else
 * yields `undefined` — the tool's schema is the validator for the input's shape,
 * and an observation whose date can't be placed is kept rather than discarded.
 */
function monthSpan(token: string): MonthSpan | undefined {
  const match = /^(\d{4})(?:([QMqm])(\d{1,2}))?$/.exec(token.trim());
  if (!match) return;
  const firstMonth = Number(match[1]) * 12;
  if (!match[2]) return { start: firstMonth, end: firstMonth + 11 };

  const ordinal = Number(match[3]);
  if (match[2].toUpperCase() === 'Q') {
    if (ordinal < 1 || ordinal > 4) return;
    return { start: firstMonth + (ordinal - 1) * 3, end: firstMonth + ordinal * 3 - 1 };
  }
  if (ordinal < 1 || ordinal > 12) return;
  return { start: firstMonth + ordinal - 1, end: firstMonth + ordinal - 1 };
}

/** Parse the requested `date` filter into the span of months it asks for. */
function parseDateWindow(dateRange: string | undefined): MonthSpan | undefined {
  if (!dateRange) return;
  const [startToken, endToken, ...rest] = dateRange.trim().split(':');
  if (rest.length > 0 || startToken === undefined) return;
  const start = monthSpan(startToken);
  const end = endToken === undefined ? start : monthSpan(endToken);
  if (!start || !end || start.start > end.end) return;
  return { start: start.start, end: end.end };
}

/** True when an observation's own period overlaps the requested window. */
function isWithinWindow(date: string, window: MonthSpan): boolean {
  const span = monthSpan(date);
  if (!span) return true;
  return span.start <= window.end && span.end >= window.start;
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
  if (!phrase) return [...indicators];
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

export class WorldBankApiService {
  private readonly baseUrl: string;
  private readonly catalogCacheTtlMs: number;

  /**
   * Cached projection of the full indicator catalog, used by keyword-only
   * search. Held on the instance rather than in module scope so tests (and
   * multiple service instances) can't leak state into each other.
   */
  private catalogCache: { indicators: Indicator[]; expiresAt: number } | undefined;

  /** In-flight catalog fetch, shared so concurrent searches trigger one request. */
  private catalogInFlight: Promise<Indicator[]> | undefined;

  /**
   * Cached identifiers of every World Bank aggregate entity, used to classify
   * data rows. Same instance-scoped, TTL'd shape as {@link catalogCache}.
   */
  private aggregateCodesCache: { codes: Set<string>; expiresAt: number } | undefined;

  /** In-flight aggregate-code fetch, shared so concurrent queries trigger one request. */
  private aggregateCodesInFlight: Promise<Set<string>> | undefined;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.apiBaseUrl.replace(/\/$/, '');
    this.catalogCacheTtlMs = serverConfig.catalogCacheTtlMs;
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
  private async fetchJson<T>(url: string, ctx: Context, timeoutMs: number): Promise<T> {
    const reqCtx = ctx as ReqCtx;
    const response = await fetchWithTimeout(url, timeoutMs, reqCtx, { signal: ctx.signal });
    const text = await response.text();

    // Detect HTML error pages (upstream returns HTML on some gateway errors)
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'World Bank API returned an HTML error page — likely rate-limited or temporarily unavailable.',
      );
    }

    return JSON.parse(text) as T;
  }

  /** Fetch JSON with retry wrapping the full pipeline. */
  private fetchWithRetry<T>(
    url: string,
    ctx: Context,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return withRetry(() => this.fetchJson<T>(url, ctx, timeoutMs), {
      operation: 'WorldBankApiService.fetch',
      context: ctx as ReqCtx,
      baseDelayMs: 1000,
      signal: ctx.signal,
    });
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
   */
  private async fetchAllPages<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ctx: Context,
    onErrorEnvelope: () => never,
  ): Promise<T[]> {
    const requestPage = async (page: number) => {
      const url = this.buildUrl(path, { ...params, page, per_page: BULK_PAGE_SIZE });
      ctx.log.debug('Fetching upstream page', { url });
      const data = await this.fetchWithRetry<WbEnvelope<T> | WbErrorEnvelope>(
        url,
        ctx,
        BULK_TIMEOUT_MS,
      );
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
    const cached = this.catalogCache;
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.indicators);

    this.catalogInFlight ??= this.fetchAllPages<RawIndicator>('/indicator', {}, ctx, () => {
      throw serviceUnavailable(
        'World Bank returned an error response for the indicator catalog listing.',
      );
    })
      .then((raw) => {
        const indicators = raw.map(normalizeIndicator);
        if (this.catalogCacheTtlMs > 0) {
          this.catalogCache = { indicators, expiresAt: Date.now() + this.catalogCacheTtlMs };
        }
        ctx.log.debug('Indicator catalog loaded', { count: indicators.length });
        return indicators;
      })
      .finally(() => {
        this.catalogInFlight = undefined;
      });

    return this.catalogInFlight;
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

    // Topic wins when both are given — /topic/{id}/indicator takes no source param.
    const path = topicId ? `/topic/${encodeURIComponent(topicId)}/indicator` : '/indicator';
    const scopeParams: Record<string, string | number | undefined> =
      !topicId && sourceId ? { source: sourceId } : {};

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
      const data = await this.fetchWithRetry<WbEnvelope<RawIndicator> | WbErrorEnvelope>(url, ctx);
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
        ? (await this.fetchAllPages<RawIndicator>(path, scopeParams, ctx, invalidScope)).map(
            normalizeIndicator,
          )
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

    const data = await this.fetchWithRetry<WbEnvelope<RawIndicator> | WbErrorEnvelope>(url, ctx);

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

    // An ID published under both a live and an archived source resolves to two
    // rows here, in upstream's arbitrary order. Same tie-break as the catalog
    // search, so both report the same source for the same ID.
    return items.map(normalizeIndicatorDetail).reduce(preferredRow);
  }

  /**
   * Resolve whether an indicator ID exists. Called only from the data endpoint's
   * error path: its envelope proves a path segment was rejected but never names
   * which one, and `/indicator/{id}` is unambiguous by construction.
   */
  private async indicatorExists(indicatorId: string, ctx: Context): Promise<boolean> {
    const url = this.buildUrl(`/indicator/${encodeURIComponent(indicatorId)}`);
    ctx.log.debug('Resolving which parameter upstream rejected', { indicatorId, url });

    const data = await this.fetchWithRetry<WbEnvelope<RawIndicator> | WbErrorEnvelope>(url, ctx);
    if (isWbErrorEnvelope(data)) return false;

    const [, items] = data as WbEnvelope<RawIndicator>;
    return Boolean(items?.length);
  }

  // ─── Countries ───────────────────────────────────────────────────────────

  async listCountries(
    opts: {
      region?: string;
      incomeLevel?: string;
      includeAggregates: boolean;
      page: number;
      perPage: number;
    },
    ctx: Context,
  ): Promise<{ countries: Country[]; total: number; page: number; pages: number }> {
    const { region, incomeLevel, includeAggregates, page, perPage } = opts;

    const filterParams: Record<string, string | number | undefined> = {};
    if (region) filterParams.region = region;
    if (incomeLevel) filterParams.incomeLevel = incomeLevel;

    const invalidFilter: () => never = () => {
      throw notFound(
        'Invalid region or income_level code. Use worldbank_list_countries without filters to browse valid codes.',
        { reason: 'invalid_filter', region, incomeLevel },
      );
    };

    if (!includeAggregates) {
      // The WB API has no server-side aggregate filter, so every entity in scope
      // has to be fetched before aggregates can be dropped and the remainder
      // re-paginated — otherwise entities past the first upstream page are
      // unreachable and total/pages under-report.
      const raw = await this.fetchAllPages<RawCountry>(
        '/country',
        filterParams,
        ctx,
        invalidFilter,
      );
      const countries = raw.map(normalizeCountry).filter((c) => !c.isAggregate);
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

    return normalizeCountry(items[0] as RawCountry);
  }

  /**
   * Load and cache the identifiers of every aggregate entity. The data endpoint's
   * rows carry no `region`/`incomeLevel` field, so an observation can only be
   * classified by looking its code up in the country listing — the same
   * `region.id === "NA"` rule {@link normalizeCountry} applies, which keeps the
   * data tool in agreement with the country tools by construction.
   *
   * Both identifiers go in the set: a data row names an aggregate by ISO2 in
   * `country.id` (`ZH`) and by its aggregate code in `countryiso3code` (`AFE`).
   */
  private loadAggregateCodes(ctx: Context): Promise<Set<string>> {
    const cached = this.aggregateCodesCache;
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.codes);

    this.aggregateCodesInFlight ??= this.fetchAllPages<RawCountry>('/country', {}, ctx, () => {
      throw serviceUnavailable(
        'World Bank returned an error response for the country listing used to classify aggregates.',
      );
    })
      .then((raw) => {
        const codes = new Set<string>();
        for (const country of raw) {
          if (!normalizeCountry(country).isAggregate) continue;
          if (country.id) codes.add(country.id);
          if (country.iso2Code) codes.add(country.iso2Code);
        }
        if (this.catalogCacheTtlMs > 0) {
          this.aggregateCodesCache = { codes, expiresAt: Date.now() + this.catalogCacheTtlMs };
        }
        ctx.log.debug('Aggregate code set loaded', { count: codes.size });
        return codes;
      })
      .finally(() => {
        this.aggregateCodesInFlight = undefined;
      });

    return this.aggregateCodesInFlight;
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  async getData(
    opts: {
      indicatorId: string;
      countries: string | string[];
      dateRange?: string;
      mrv?: number;
      page: number;
      perPage: number;
    },
    ctx: Context,
  ): Promise<{
    data: DataPoint[];
    indicator: { id: string; name: string };
    total: number;
    page: number;
    pages: number;
    nullCount: number;
    dateFilterDropped: boolean;
  }> {
    const { indicatorId, countries, dateRange, mrv, page, perPage } = opts;

    const countryCodes = Array.isArray(countries) ? countries.join(';') : countries;

    const scope: Record<string, string | number | undefined> = {};
    if (dateRange) scope.date = dateRange;
    if (mrv !== undefined) scope.mrv = mrv;

    const path = `/country/${encodeURIComponent(countryCodes)}/indicator/${encodeURIComponent(indicatorId)}`;
    const url = this.buildUrl(path, { ...scope, page, per_page: perPage });
    ctx.log.debug('Fetching data', { indicatorId, countryCodes, url });

    const data = await this.fetchWithRetry<WbEnvelope<RawDataPoint> | WbErrorEnvelope>(url, ctx);

    if (isWbErrorEnvelope(data)) {
      // The /country/{codes}/indicator/{id} endpoint wraps errors in an array:
      // [{ message: [...] }], so data itself is an array and data.message would
      // be undefined. Unwrap before accessing.
      const envelope = (Array.isArray(data) ? data[0] : data) as WbErrorEnvelope;
      const detail = envelope.message[0]?.value ?? 'Invalid value';

      // Upstream emits one message per rejected path segment and never names
      // which, so two entries prove both segments are bad; one entry needs a
      // second lookup to place. The envelope text is identical in every case.
      if (envelope.message.length > 1) {
        throw notFound(
          `Neither indicator "${indicatorId}" nor country code(s) "${countryCodes}" are valid. Detail: ${detail}. Use worldbank_search_indicators and worldbank_list_countries.`,
          { reason: 'indicator_and_country_not_found', indicatorId, countryCodes, detail },
        );
      }
      if (!(await this.indicatorExists(indicatorId, ctx))) {
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

    const [paging, items] = data as WbEnvelope<RawDataPoint>;

    if (!items?.length) {
      // Return empty data — let the handler surface recovery guidance via
      // enrichment notice so structured clients see it in ctx.enrich.notice.
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

    const indicatorMeta = items[0]?.indicator;
    const indicator = { id: indicatorMeta?.id ?? indicatorId, name: indicatorMeta?.value ?? '' };

    /**
     * A date window the API can't apply — one overlapping no part of the series,
     * or finer-grained than the series it was asked of — makes upstream discard
     * the filter and return the whole thing, which is indistinguishable from a
     * hit until the returned periods are checked against the ones asked for.
     * Whether that happened can only be judged over the complete response, so a
     * windowed query that spans more than one upstream page is re-read in full
     * and paginated locally; otherwise in-window observations past this page are
     * unreachable and total/pages report the series length instead of the match
     * count.
     */
    const dateWindow = parseDateWindow(dateRange);

    let matched = items;
    let total = paging.total;
    let pages = paging.pages;
    let currentPage = paging.page ?? page;
    let dateFilterDropped = false;

    if (dateWindow) {
      const reRead = paging.pages > 1;
      const candidates = reRead
        ? await this.fetchAllPages<RawDataPoint>(path, scope, ctx, () => {
            throw serviceUnavailable(
              'World Bank returned an error response for the observation series.',
            );
          })
        : items;
      const inWindow = candidates.filter((raw) => isWithinWindow(raw.date ?? '', dateWindow));
      const start = (page - 1) * perPage;

      matched = reRead ? inWindow.slice(start, start + perPage) : inWindow;
      total = inWindow.length;
      pages = Math.max(1, Math.ceil(inWindow.length / perPage));
      currentPage = page;
      dateFilterDropped = inWindow.length < candidates.length;
    }

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

    const aggregateCodes = await this.loadAggregateCodes(ctx);
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
