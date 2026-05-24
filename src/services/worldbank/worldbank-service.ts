/**
 * @fileoverview World Bank Indicators API v2 service. Wraps all endpoint categories
 * (indicators, countries, data, topics, sources) with typed fetch methods,
 * retry/timeout, and sparse-payload normalization.
 * @module services/worldbank/worldbank-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Minimal request-context shape that satisfies fetchWithTimeout and withRetry. */
type ReqCtx = Context & Record<string, unknown>;

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

// ─── Error detection ─────────────────────────────────────────────────────────

/** Shape returned by the WB API for invalid IDs (HTTP 200, not 404). */
type WbErrorEnvelope = { message: Array<{ id: string; key: string; value: string }> };

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
    // countryiso3code carries the aggregate code (e.g. "AFE"). Check both.
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

// ─── Service ─────────────────────────────────────────────────────────────────

export class WorldBankApiService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().apiBaseUrl.replace(/\/$/, '');
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
  private async fetchJson<T>(url: string, ctx: Context): Promise<T> {
    const reqCtx = ctx as ReqCtx;
    const response = await fetchWithTimeout(url, 15_000, reqCtx, { signal: ctx.signal });
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
  private fetchWithRetry<T>(url: string, ctx: Context): Promise<T> {
    return withRetry(() => this.fetchJson<T>(url, ctx), {
      operation: 'WorldBankApiService.fetch',
      context: ctx as ReqCtx,
      baseDelayMs: 1000,
      signal: ctx.signal,
    });
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

    let url: string;
    let clientFilterTerm: string | undefined;

    if (topicId && !query) {
      // Topic-only: use dedicated endpoint
      url = this.buildUrl(`/topic/${encodeURIComponent(topicId)}/indicator`, {
        page,
        per_page: perPage,
      });
    } else if (topicId && query) {
      // Topic + keyword: fetch by topic, filter client-side
      url = this.buildUrl(`/topic/${encodeURIComponent(topicId)}/indicator`, {
        page: 1,
        per_page: 1000,
      });
      clientFilterTerm = query.toLowerCase();
    } else if (sourceId && !query) {
      // Source-only: use source filter
      url = this.buildUrl('/indicator', { source: sourceId, page, per_page: perPage });
    } else if (sourceId && query) {
      // Source + keyword: fetch by source, filter client-side
      url = this.buildUrl('/indicator', { source: sourceId, page: 1, per_page: 1000 });
      clientFilterTerm = query.toLowerCase();
    } else if (query) {
      // Keyword-only: use searchterm
      url = this.buildUrl('/indicator', { searchterm: query, page, per_page: perPage });
    } else {
      // No filter: list all
      url = this.buildUrl('/indicator', { page, per_page: perPage });
    }

    ctx.log.debug('Searching indicators', { url });
    const data = await this.fetchWithRetry<WbEnvelope<RawIndicator>>(url, ctx);
    const [paging, items] = data;

    let normalized = (items ?? []).map(normalizeIndicator);

    if (clientFilterTerm) {
      const term = clientFilterTerm;
      normalized = normalized.filter(
        (ind) =>
          ind.name.toLowerCase().includes(term) ||
          ind.id.toLowerCase().includes(term) ||
          ind.sourceNote.toLowerCase().includes(term),
      );
    }

    // Apply pagination to client-filtered results
    if (clientFilterTerm) {
      const start = (page - 1) * perPage;
      const pageItems = normalized.slice(start, start + perPage);
      return {
        indicators: pageItems,
        total: normalized.length,
        page,
        pages: Math.ceil(normalized.length / perPage),
      };
    }

    return {
      indicators: normalized,
      total: paging.total,
      page: paging.page,
      pages: paging.pages,
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

    return normalizeIndicatorDetail(items[0] as RawIndicator);
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

    // When filtering aggregates, the WB API has no server-side parameter for this.
    // Fetch all entries in one shot (max 300, WB total is ~296) so we can filter
    // and compute accurate total/pages. When including aggregates, use the requested
    // page/perPage directly against the API — no over-fetch needed.
    const fetchPage = includeAggregates ? page : 1;
    const fetchPerPage = includeAggregates ? perPage : 300;

    const params: Record<string, string | number | undefined> = {
      page: fetchPage,
      per_page: fetchPerPage,
    };
    if (region) params.region = region;
    if (incomeLevel) params.incomeLevel = incomeLevel;

    const url = this.buildUrl('/country', params);
    ctx.log.debug('Listing countries', { url });

    const data = await this.fetchWithRetry<WbEnvelope<RawCountry> | WbErrorEnvelope>(url, ctx);

    if (isWbErrorEnvelope(data)) {
      throw notFound(
        'Invalid region or income_level code. Use worldbank_list_countries without filters to browse valid codes.',
        { reason: 'invalid_filter', region: opts.region, incomeLevel: opts.incomeLevel },
      );
    }

    const [paging, items] = data as WbEnvelope<RawCountry>;

    let countries = (items ?? []).map(normalizeCountry);

    if (!includeAggregates) {
      // Filter aggregates client-side and re-paginate so total/pages match.
      countries = countries.filter((c) => !c.isAggregate);
      const filteredTotal = countries.length;
      const filteredPages = Math.max(1, Math.ceil(filteredTotal / perPage));
      const start = (page - 1) * perPage;
      return {
        countries: countries.slice(start, start + perPage),
        total: filteredTotal,
        page,
        pages: filteredPages,
      };
    }

    return {
      countries,
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
  }> {
    const { indicatorId, countries, dateRange, mrv, page, perPage } = opts;

    const countryCodes = Array.isArray(countries) ? countries.join(';') : countries;

    const params: Record<string, string | number | undefined> = { page, per_page: perPage };
    if (dateRange) params.date = dateRange;
    if (mrv !== undefined) params.mrv = mrv;

    const path = `/country/${encodeURIComponent(countryCodes)}/indicator/${encodeURIComponent(indicatorId)}`;
    const url = this.buildUrl(path, params);
    ctx.log.debug('Fetching data', { indicatorId, countryCodes, url });

    const data = await this.fetchWithRetry<WbEnvelope<RawDataPoint> | WbErrorEnvelope>(url, ctx);

    if (isWbErrorEnvelope(data)) {
      // Could be invalid indicator or country — message is the same either way.
      // The /country/{code}/indicator/{id} endpoint wraps errors in an array:
      // [{ message: [...] }], so data itself is an array and data.message would
      // be undefined. Unwrap before accessing.
      const envelope = (Array.isArray(data) ? data[0] : data) as WbErrorEnvelope;
      const msg = envelope.message[0]?.value ?? 'Invalid value';
      // Try to classify by checking if the indicator ID looks like a WB code
      const isLikelyIndicator = /^[A-Z]{2}\.[A-Z.]+$/.test(indicatorId);
      if (isLikelyIndicator) {
        throw notFound(
          `Indicator "${indicatorId}" not found. Use worldbank_search_indicators to find valid IDs.`,
          { reason: 'indicator_not_found', indicatorId, detail: msg },
        );
      }
      throw notFound(
        `Invalid country code or indicator ID. Detail: ${msg}. Use worldbank_list_countries or worldbank_search_indicators.`,
        { reason: 'country_not_found', countryCodes, indicatorId, detail: msg },
      );
    }

    const [paging, items] = data as WbEnvelope<RawDataPoint>;

    if (!items?.length) {
      throw notFound(
        `No data found for indicator "${indicatorId}" with the specified filters. ` +
          `Try broadening the date range or using mrv=5 to get the most recent available values.`,
        { reason: 'no_data', indicatorId, countryCodes },
      );
    }

    // Determine aggregate codes from the data itself (region.id = "NA" detection isn't
    // available in the data endpoint — use a known set of WB aggregate codes instead)
    const knownAggregates = new Set([
      'EAS',
      'ECS',
      'LCN',
      'MEA',
      'SAS',
      'SSF',
      'NAC',
      'MNA',
      'HIC',
      'UMC',
      'LMC',
      'LIC',
      'WLD',
      '1W',
      'OED',
      'INX',
      'IDA',
      'IBD',
      'IBT',
      'IDB',
      'IDX',
      'PRE',
      'PST',
      'EMU',
      'LAC',
      'CEB',
      'EAP',
      'ECA',
      'LTE',
      'MIC',
      'AFR',
      'AFE',
      'AFW',
    ]);

    const dataPoints = (items ?? []).map((raw) => normalizeDataPoint(raw, knownAggregates));
    const nullCount = dataPoints.filter((d) => d.value === null).length;

    // Extract indicator metadata from the first item
    const indicatorMeta = items[0]?.indicator;

    return {
      data: dataPoints,
      indicator: {
        id: indicatorMeta?.id ?? indicatorId,
        name: indicatorMeta?.value ?? '',
      },
      total: paging.total,
      page: paging.page,
      pages: paging.pages,
      nullCount,
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
