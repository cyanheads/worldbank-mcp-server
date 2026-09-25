/**
 * @fileoverview World Bank Poverty and Inequality Platform (PIP) service. Wraps
 * the `/pip` endpoint for economies and `/pip-grp` for PIP's regional,
 * income-group, and lending-group aggregates, neither of which shares an
 * envelope, a pagination model, or an error convention with the Indicators v2
 * API: rows arrive as a flat JSON array, there is no server-side paging, and a
 * rejected parameter value comes back as a real HTTP 404 carrying the list of
 * values that would have been accepted. Each requested code is routed by PIP's
 * own regions table; economy survey rows are preferred over gap-filled ones and
 * the two are merged, because PIP strips the whole distributional block from
 * every gap-filled row; and economies PIP publishes only as model estimates,
 * which `/pip` rejects by code, are read from its all-economy response instead.
 * @module services/pip/pip-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { MAX_ESTIMATES_PER_PAGE } from '@/services/response-budget.js';
import { sharedLoadContext, untilAborted } from '@/services/shared-load.js';
import type {
  PipValidationBody,
  PovertyRow,
  RawPipEconomy,
  RawPipGroupRow,
  RawPipRegion,
  RawPipRow,
  RawPipVersion,
} from './types.js';

/** Minimal request-context shape that satisfies fetchWithTimeout and withRetry. */
type ReqCtx = Context & Record<string, unknown>;

/**
 * Timeout for a single `/pip` request. PIP computes a query the first time it
 * sees it and serves the repeat from cache, so latency is bimodal: a warm query
 * answers in under a second, while a cold one routinely runs 15–60s and has
 * been measured near 90s. The 60s ceiling matches what the Indicators service
 * allows its own bulk fetches; a tighter one fails on queries that do complete.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Bound on a reference load shared by concurrent queries, which runs under no
 * caller's signal: both attempts `fetchJson` makes, with room for the backoff
 * between them.
 */
const REFERENCE_LOAD_TIMEOUT_MS = 2 * REQUEST_TIMEOUT_MS + 5_000;

/**
 * Bytes of a non-2xx body captured into the error, raised from the framework's
 * 500-byte default so a 404 arrives whole and parses. Measured against release
 * 20260922: 635 B for a rejected `year`, 945 B for `year`, `welfare_type`, and
 * `reporting_level` together, 2,221 B for four parameters with `country` among
 * them, and 2,117 B for a rejected `version`.
 */
const ERROR_BODY_LIMIT = 8_192;

/**
 * Most entries a rejected parameter's accepted values may summarize to and still
 * be quoted in the message. `year` summarizes to three (`all, MRV, 1963–2026`),
 * `welfare_type` enumerates three and `reporting_level` four; `country` runs to
 * 200 codes that no range shortens, and belongs behind a recovery hint instead.
 */
const MAX_QUOTED_VALID_VALUES = 12;

// ─── Aggregate routing ───────────────────────────────────────────────────────

/**
 * The `group_by` `/pip-grp` serves each routed grouping of PIP's regions table
 * under, with the label an error message lists its codes under. `world` rides
 * `wb` because `group_by=world` answers HTTP 500, while `wb` serves `WLD`
 * beside the regions. `fcv` and `regionpcn` are absent on purpose: PIP serves
 * them under their own `group_by`, but this tool does not route them.
 */
const ROUTED_GROUPINGS: Readonly<Record<string, { groupBy: string; label: string }>> = {
  world: { groupBy: 'wb', label: 'World' },
  region: { groupBy: 'wb', label: 'regions' },
  africa_split: { groupBy: 'wb', label: 'regions' },
  incgroup: { groupBy: 'incgroup', label: 'income groups' },
  ida: { groupBy: 'ida', label: 'lending groups' },
};

/**
 * WDI's spellings of groups PIP codes differently: two income groups, and the
 * three lending groups — WDI's `IDX` (IDA only), `IDB` (IDA blend), and `IBD`
 * (IBRD only) are PIP's `IDA`, `BLND`, and `IBRD`. WDI's own `IDA` means IDA
 * total, which PIP does not compute; the tool rejects it before it gets here.
 */
const WDI_GROUP_SPELLINGS: Readonly<Record<string, string>> = {
  LMC: 'LMIC',
  UMC: 'UMIC',
  IDX: 'IDA',
  IDB: 'BLND',
  IBD: 'IBRD',
};

/**
 * PIP's `IDA` is reachable only as WDI's `IDX`, since a caller's `IDA` means
 * IDA total. Every code the service hands back — a row's code, the echo, an
 * error message, the list of accepted codes — names it that way, so any code in
 * a response can be sent again and asks for the same group. Its row takes WDI's
 * name for that code, `IDA only`, in place of PIP's bare `IDA`, so the name and
 * the code agree. PIP's other spellings (`LMIC`, `BLND`, `IBRD`) are accepted as
 * sent and need no entry.
 */
const LISTED_AS: Readonly<Record<string, { code: string; name: string }>> = {
  IDA: { code: 'IDX', name: 'IDA only' },
};

/** A PIP code as the caller sees and sends it. */
function listedCode(code: string): string {
  return LISTED_AS[code]?.code ?? code;
}

/**
 * WDI income aggregates PIP computes no aggregate for. Rejected as unserved
 * rather than sent to `/pip`, where they would read as unknown country codes:
 * they sit beside the income groups this tool does serve.
 */
const UNSERVED_WDI_GROUPS: ReadonlySet<string> = new Set(['MIC', 'LMY']);

/** Where each requested code goes: `/pip` for economies, `/pip-grp` per `group_by` for aggregates. */
type Routing = { economies: string[]; groups: Map<string, string[]> };

/**
 * Route each code by PIP's regions table and reject, before any data request,
 * the aggregates this tool does not serve and the filters PIP's aggregates
 * cannot take. PIP computes an aggregate over each economy's own welfare
 * measure and reporting level, so it has no income-only or urban-only version:
 * `welfare_type=income` narrows `SSF` to the income-surveyed sliver of the
 * region (119,878 people in 2022), and `reporting_level=urban` answers HTTP 500.
 */
function routeCodes(
  codes: readonly string[],
  regions: ReadonlyMap<string, string>,
  filters: { welfareType: string | undefined; reportingLevel: string | undefined },
): Routing {
  const routing: Routing = { economies: [], groups: new Map() };
  const unserved: string[] = [];
  for (const code of codes) {
    const grouping = regions.get(code);
    const routed = grouping === undefined ? undefined : ROUTED_GROUPINGS[grouping];
    if (UNSERVED_WDI_GROUPS.has(code) || (grouping !== undefined && !routed)) {
      unserved.push(code);
    } else if (routed) {
      routing.groups.set(routed.groupBy, [...(routing.groups.get(routed.groupBy) ?? []), code]);
    } else {
      routing.economies.push(code);
    }
  }

  if (unserved.length > 0) {
    const labels = [...new Set(Object.values(ROUTED_GROUPINGS).map((routed) => routed.label))];
    const accepted = labels.map((label) => ({
      label,
      codes: [...regions]
        .filter(([, grouping]) => ROUTED_GROUPINGS[grouping]?.label === label)
        .map(([code]) => listedCode(code)),
    }));
    const listed = accepted
      .filter((group) => group.codes.length > 0)
      .map((group) => `${group.label} ${group.codes.join(', ')}`);
    throw validationError(
      `This tool does not serve the aggregate code(s) "${unserved.join(',')}". Accepted aggregate codes: ${listed.join('; ')}.`,
      {
        reason: 'unserved_aggregate',
        countryCodes: unserved.join(','),
        acceptedAggregates: accepted.flatMap((group) => group.codes),
        retryable: false,
      },
    );
  }

  const conflicting = [
    ...(filters.welfareType === undefined ? [] : ['welfare_type']),
    ...(filters.reportingLevel === undefined ? [] : ['reporting_level']),
  ];
  if (routing.groups.size > 0 && conflicting.length > 0) {
    const aggregates = [...routing.groups.values()].flat().map(listedCode);
    throw validationError(
      `${conflicting.join(' and ')} cannot be applied to the aggregate code(s) "${aggregates.join(',')}": PIP computes each aggregate across every economy's own welfare measure and reporting level.`,
      {
        reason: 'aggregate_filter_conflict',
        parameters: conflicting,
        countryCodes: aggregates.join(','),
        retryable: false,
      },
    );
  }
  return routing;
}

// ─── Error classification ────────────────────────────────────────────────────

/** A PIP 404: the parameters it rejects, and each one's accepted values where it sent them. */
interface PipRejection {
  parameters: string[];
  valid: Record<string, unknown[]>;
}

/**
 * Read a PIP 404 body. `details` is keyed by parameter name, one object per
 * rejected parameter. A rejected `version` breaks that shape: its `details` is a
 * single unkeyed `{msg, valid}` pair, whose two array members name no parameter,
 * so it reads as a rejection of an unnamed one.
 *
 * A body that does not parse falls back to matching the `"<name>": {"msg"`
 * prefixes that open each keyed entry. The match can drop a parameter whose
 * entry was cut, never substitute a neighbour; `details` itself is excluded
 * because the unkeyed shape opens with `"details":{"msg"`.
 */
function readRejection(body: string): PipRejection {
  let details: unknown;
  try {
    details = (JSON.parse(body) as PipValidationBody).details;
  } catch {
    const parameters = [...body.matchAll(/"([A-Za-z_]+)"\s*:\s*\{\s*"msg"/g)]
      .map((m) => m[1] as string)
      .filter((name) => name !== 'details');
    return { parameters, valid: {} };
  }

  const rejection: PipRejection = { parameters: [], valid: {} };
  if (typeof details !== 'object' || details === null) return rejection;
  for (const [name, entry] of Object.entries(details)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    rejection.parameters.push(name);
    const valid = (entry as { valid?: unknown }).valid;
    if (Array.isArray(valid)) rejection.valid[name] = valid;
  }
  return rejection;
}

/** A whole number PIP lists as a string (a year) or as a number (a `povline` bound). */
function wholeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * Render an accepted-values list in the order PIP sent it, collapsing each run
 * of three or more whole numbers that step by one into a range — `year`'s 66
 * values read `all, MRV, 1963–2026`. A gap ends the run and a run of two stays
 * two values, so a list with holes keeps them visible and a pair of bounds such
 * as `povline`'s `0, 2700` is never shown as a span.
 */
function summarizeValues(values: unknown[]): string[] {
  const summary: string[] = [];
  let start = 0;
  while (start < values.length) {
    const first = wholeNumber(values[start]);
    let end = start;
    while (
      first !== undefined &&
      end + 1 < values.length &&
      wholeNumber(values[end + 1]) === first + (end + 1 - start)
    ) {
      end++;
    }
    if (end - start >= 2) {
      summary.push(`${String(values[start])}–${String(values[end])}`);
      start = end + 1;
    } else {
      summary.push(String(values[start]));
      start++;
    }
  }
  return summary;
}

/**
 * The codes a `/pip` country rejection found missing from PIP's accepted list,
 * keyed by the classified error. Kept off the error's `data`, which reaches the
 * client and already names them in `countryCodes`.
 */
const unlistedCountries = new WeakMap<McpError, string[]>();

/**
 * Translate a non-2xx from PIP into a classified domain error.
 *
 * A 404 is a rejected parameter value, never a missing resource — PIP answers a
 * well-formed query that matches nothing with an empty array and HTTP 200. The
 * rejection is summarized rather than pre-empted: the span of years PIP accepts
 * differs by release (1963–2026 for 20260922, 1963–2025 for 20250930), and the
 * 404 is computed against the release the query is pinned to, so it is the one
 * authority on what would have been accepted. `acceptedValues` carries exactly
 * the lists the message quotes, keyed by parameter.
 *
 * A rejected `country` names only the codes its accepted list lacks, when the
 * body carried the list, and records them in {@link unlistedCountries} for the
 * model-estimate fallback — the list holds surveyed economies and aggregates,
 * so a code missing from it may still be an economy PIP publishes. A body with
 * no list names every code sent.
 *
 * A 5xx carries no detail beyond `Internal Server Error`. Aggregate codes, which
 * `/pip` lists as valid but answers with a 500, never reach it, so the message
 * reports an upstream fault and nothing else. Codes are named as the caller
 * sends them ({@link listedCode}).
 */
function classifyPipError(error: McpError, codes: readonly string[]): McpError {
  const status = Number(error.data?.status ?? error.data?.statusCode);
  const body = String(error.data?.body ?? error.data?.responseBody ?? '');

  if (status === 404) {
    const { parameters, valid } = readRejection(body);
    if (parameters.includes('country')) {
      const accepted = valid.country?.map((value) => String(value).toUpperCase());
      const unlisted = accepted && codes.filter((code) => !accepted.includes(code));
      const named = (unlisted?.length ? unlisted : codes).map(listedCode).join(',');
      const rejection = notFound(
        `PIP does not recognize the country code(s) "${named}".`,
        { reason: 'country_not_found', countryCodes: named, retryable: false },
        { cause: error },
      );
      if (unlisted?.length) unlistedCountries.set(rejection, unlisted);
      return rejection;
    }
    const acceptedValues: Record<string, string[]> = {};
    for (const parameter of parameters) {
      const summary = summarizeValues(valid[parameter] ?? []);
      if (summary.length > 0 && summary.length <= MAX_QUOTED_VALID_VALUES) {
        acceptedValues[parameter] = summary;
      }
    }
    const quoted = Object.entries(acceptedValues).map(
      ([parameter, values]) => `${parameter} accepts ${values.join(', ')}`,
    );
    const named = parameters.length > 0 ? parameters.join(', ') : 'a query parameter';
    return validationError(
      `PIP rejected the value supplied for ${named}.${quoted.length > 0 ? ` Accepted values: ${quoted.join('; ')}.` : ''}`,
      {
        reason: 'invalid_parameter',
        parameters,
        ...(quoted.length > 0 && { acceptedValues }),
        retryable: false,
      },
      { cause: error },
    );
  }

  if (status >= 500) {
    const countryCodes = codes.map(listedCode).join(',');
    return serviceUnavailable(
      `PIP returned HTTP ${status} for country code(s) "${countryCodes}", with no detail on the cause.`,
      { reason: 'upstream_unavailable', countryCodes, status },
      { cause: error },
    );
  }

  return error;
}

// ─── Normalization ───────────────────────────────────────────────────────────

const DECILE_KEYS = [
  'decile1',
  'decile2',
  'decile3',
  'decile4',
  'decile5',
  'decile6',
  'decile7',
  'decile8',
  'decile9',
  'decile10',
] as const satisfies ReadonlyArray<keyof RawPipRow>;

/**
 * Collect the ten decile shares, or nothing. PIP publishes the distributional
 * block as a unit — all ten present or all ten null — so a partial run would be
 * a payload the endpoint has never produced, and returning it as a short array
 * would misreport which decile each share belongs to.
 */
function decileShares(raw: RawPipRow): number[] | null {
  const shares = DECILE_KEYS.map((key) => raw[key]);
  return shares.every((share) => typeof share === 'number') ? shares : null;
}

function normalizeRow(raw: RawPipRow): PovertyRow {
  return {
    countryCode: raw.country_code ?? '',
    countryName: raw.country_name ?? '',
    regionCode: raw.region_code ?? '',
    regionName: raw.region_name ?? '',
    reportingYear: raw.reporting_year ?? 0,
    reportingLevel: raw.reporting_level ?? '',
    welfareType: raw.welfare_type ?? '',
    povertyLine: raw.poverty_line ?? 0,
    headcount: raw.headcount ?? null,
    povertyGap: raw.poverty_gap ?? null,
    povertySeverity: raw.poverty_severity ?? null,
    watts: raw.watts ?? null,
    mean: raw.mean ?? null,
    median: raw.median ?? null,
    gini: raw.gini ?? null,
    mld: raw.mld ?? null,
    polarization: raw.polarization ?? null,
    decileShares: decileShares(raw),
    population: raw.reporting_pop ?? null,
    surveyYear: raw.survey_year ?? null,
    surveyAcronym: raw.survey_acronym ?? '',
    surveyComparability: raw.survey_comparability ?? null,
    comparableSpell: raw.comparable_spell ?? null,
    estimationType: raw.estimation_type ?? '',
    isInterpolated: raw.is_interpolated ?? false,
    isAggregate: false,
    popInPoverty: null,
  };
}

/**
 * Normalize a `/pip-grp` aggregate. What the endpoint does not publish — the
 * median, the distributional block, the survey fields, welfare type, reporting
 * level, and the interpolation flag — is null rather than defaulted. The code
 * and name are the ones a caller sends and reads ({@link LISTED_AS}).
 */
function normalizeGroupRow(raw: RawPipGroupRow): PovertyRow {
  return {
    countryCode: listedCode(raw.region_code ?? ''),
    countryName: LISTED_AS[raw.region_code ?? '']?.name ?? raw.region_name ?? '',
    regionCode: null,
    regionName: null,
    reportingYear: raw.reporting_year ?? 0,
    reportingLevel: null,
    welfareType: null,
    povertyLine: raw.poverty_line ?? 0,
    headcount: raw.headcount ?? null,
    povertyGap: raw.poverty_gap ?? null,
    povertySeverity: raw.poverty_severity ?? null,
    watts: raw.watts ?? null,
    mean: raw.mean ?? null,
    median: null,
    gini: null,
    mld: null,
    polarization: null,
    decileShares: null,
    population: raw.reporting_pop ?? null,
    surveyYear: null,
    surveyAcronym: '',
    surveyComparability: null,
    comparableSpell: null,
    estimationType: raw.estimate_type ?? '',
    isInterpolated: null,
    isAggregate: true,
    popInPoverty: raw.pop_in_poverty ?? null,
  };
}

/**
 * The grain of a `/pip` row: one economy, reporting year, reporting level, and
 * welfare measure. Ten economies publish more than one reporting level and
 * thirty-five publish both an income and a consumption series, so the country
 * code alone does not identify a row.
 */
function rowKey(row: PovertyRow): string {
  return `${row.countryCode}|${row.reportingYear}|${row.reportingLevel}|${row.welfareType}`;
}

/**
 * Whether the request spans more than one reporting year. `all` — and an
 * omitted `year`, which PIP reads the same way — covers an economy's whole
 * window; a four-digit year and `MRV` each resolve to a single year per
 * economy. The distinction decides what a gap-filled row is allowed to add.
 */
function spansMultipleYears(year: string | undefined): boolean {
  return year === undefined || year.trim().toLowerCase() === 'all';
}

/** Whether `year` asks for the most recent year, which PIP matches case-insensitively. */
function isMostRecent(year: string | undefined): boolean {
  return year?.trim().toLowerCase() === 'mrv';
}

/** Keep each code's rows at its newest reporting year, so no code answers at two years. */
function keepNewestYear(rows: readonly PovertyRow[]): PovertyRow[] {
  const newest = new Map<string, number>();
  for (const row of rows) {
    newest.set(row.countryCode, Math.max(newest.get(row.countryCode) ?? 0, row.reportingYear));
  }
  return rows.filter((row) => row.reportingYear === newest.get(row.countryCode));
}

/** Stable ordering, so a merged result doesn't depend on which request answered first. */
function compareRows(a: PovertyRow, b: PovertyRow): number {
  return (
    a.countryCode.localeCompare(b.countryCode) ||
    a.reportingYear - b.reportingYear ||
    (a.reportingLevel ?? '').localeCompare(b.reportingLevel ?? '') ||
    (a.welfareType ?? '').localeCompare(b.welfareType ?? '')
  );
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Filters `/pip` and `/pip-grp` share, pinned to one `version` — everything but
 * the codes and, on `/pip`, `fill_gaps`.
 */
type PipFilters = {
  version: string;
  year?: string;
  povline?: number;
  welfare_type?: string;
  reporting_level?: string;
};

/** Economy rows from `/pip`, and what the tool needs to explain them. */
type EconomyRows = {
  rows: PovertyRow[];
  /** Whether any row came from the gap-filled pass. */
  gapFilled: boolean;
  /** Economies PIP publishes only as model estimates, left out because `fill_gaps` was off. */
  modelOnly: string[];
};

const NO_ECONOMY_ROWS: EconomyRows = { rows: [], gapFilled: false, modelOnly: [] };

/** The data release and PPP vintage every request of one query is pinned to. */
type ResolvedVersion = { pppVersion: string; releaseVersion: string; version: string };

export class PipService {
  private readonly baseUrl: string;
  private readonly referenceCacheTtlMs: number;

  /**
   * Reference listings — `/versions` and the two `/aux` tables — keyed by what
   * was fetched and cached as promises, so concurrent queries share one
   * request. Held on the instance, like the Indicators service's reference
   * caches, so tests and multiple instances stay isolated.
   */
  private readonly referenceCache = new Map<
    string,
    { expiresAt: number; listing: Promise<unknown[]> }
  >();

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.pipBaseUrl.replace(/\/$/, '');
    this.referenceCacheTtlMs = serverConfig.catalogCacheTtlMs;
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) qs.set(key, String(value));
    }
    return `${this.baseUrl}${path}?${qs.toString()}`;
  }

  /** Fetch and parse one PIP response, with non-2xx statuses translated by `classify`. */
  private fetchJson(
    url: string,
    ctx: Context,
    classify: (error: McpError) => McpError,
  ): Promise<unknown> {
    return withRetry(
      async () => {
        let text: string;
        try {
          const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, ctx as ReqCtx, {
            signal: ctx.signal,
            expectedStatuses: [404],
            errorBodyLimit: ERROR_BODY_LIMIT,
          });
          text = await response.text();
        } catch (error) {
          if (error instanceof McpError) throw classify(error);
          throw error;
        }

        // Same Cloudflare front as the Indicators API, same HTML-on-gateway-error mode.
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'PIP returned an HTML error page — likely rate-limited or temporarily unavailable.',
          );
        }

        return JSON.parse(text) as unknown;
      },
      {
        operation: 'PipService.fetchJson',
        context: ctx as ReqCtx,
        baseDelayMs: 1000,
        /**
         * One retry, not the framework default of three. Some PIP 5xx answers
         * are settled rather than transient — `country=all&year=all` with
         * `povline=4.11&welfare_type=consumption` fails on every attempt — so
         * extra attempts only add delay to them. The one retry earns its place
         * on a timeout instead: the attempt that timed out leaves the query warm
         * in PIP's cache, and the retry usually answers at once.
         */
        maxRetries: 1,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch one `/pip` or `/pip-grp` response, mapping PIP's status codes to
   * domain errors. An error names `reported` — the codes sent, unless the
   * request stands in for others, as `all` does when read for the economies
   * PIP publishes only as model estimates.
   */
  private async fetchRows<T>(
    path: '/pip' | '/pip-grp',
    codes: readonly string[],
    params: Record<string, string | number | undefined>,
    ctx: Context,
    reported: readonly string[] = codes,
  ): Promise<T[]> {
    const url = this.buildUrl(path, { country: codes.join(','), ...params });
    ctx.log.debug('Fetching PIP estimates', { url });

    const parsed = await this.fetchJson(url, ctx, (error) => classifyPipError(error, reported));
    if (!Array.isArray(parsed)) {
      throw serializationError(
        'PIP returned a response that is not the expected array of estimate rows.',
        { url },
      );
    }
    return parsed as T[];
  }

  /** Fetch one `/pip` pass for `codes`, survey-only or gap-filled; an error names `reported`. */
  private async economyPass(
    codes: readonly string[],
    filters: PipFilters,
    fillGaps: boolean,
    ctx: Context,
    reported: readonly string[] = codes,
  ): Promise<PovertyRow[]> {
    const rows = await this.fetchRows<RawPipRow>(
      '/pip',
      codes,
      { ...filters, fill_gaps: String(fillGaps) },
      ctx,
      reported,
    );
    return rows.map(normalizeRow);
  }

  /**
   * Load a reference listing, from cache while it is fresh. A TTL of 0 disables
   * retention; a failed load is never served from cache to the next query.
   *
   * The load is shared by every query waiting on it, so it runs under a signal
   * of its own ({@link sharedLoadContext}) rather than the first caller's, and
   * each caller waits on it only until its own signal aborts. One caller
   * cancelling fails that caller alone, and a load every caller abandoned still
   * completes and caches for the next query.
   */
  private loadReference<T>(key: string, url: string, ctx: Context): Promise<T[]> {
    const cached = this.referenceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return untilAborted(cached.listing as Promise<T[]>, ctx.signal);
    }

    ctx.log.debug('Fetching PIP reference listing', { url });
    const shared = sharedLoadContext(ctx, REFERENCE_LOAD_TIMEOUT_MS);
    const listing = this.fetchJson(url, shared, (error) => error).then((parsed) => {
      if (!Array.isArray(parsed)) {
        throw serializationError('PIP returned a reference listing that is not an array.', {
          url,
        });
      }
      return parsed as T[];
    });

    this.referenceCache.set(key, { listing, expiresAt: Date.now() + this.referenceCacheTtlMs });
    listing.catch(() => {
      if (this.referenceCache.get(key)?.listing === listing) this.referenceCache.delete(key);
    });
    return untilAborted(listing, ctx.signal);
  }

  /** The `/versions` listing: every data release × PPP vintage. */
  private loadVersions(ctx: Context): Promise<RawPipVersion[]> {
    return this.loadReference('versions', this.buildUrl('/versions', { format: 'json' }), ctx);
  }

  /**
   * PIP's regions table, as aggregate code → grouping type. Read unpinned: it is
   * loaded alongside `/versions`, before a release is resolved, and its 27
   * codes were identical across both vintages of release 20260922 and the
   * unpinned form.
   *
   * A table that fails to load degrades to an empty one rather than failing
   * the query: every code then goes to `/pip`, as it did before aggregates were
   * routed, so an economy still answers and an aggregate meets `/pip`'s own
   * 500. The failure is logged and not cached, so the next query asks again.
   */
  private async loadRegions(ctx: Context): Promise<Map<string, string>> {
    const url = this.buildUrl('/aux', { table: 'regions', format: 'json' });
    let regions: RawPipRegion[];
    try {
      regions = await this.loadReference<RawPipRegion>('regions', url, ctx);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log.warning('PIP regions table unavailable; routing every code to /pip', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }
    return new Map(
      regions.flatMap((region) =>
        region.region_code && region.grouping_type
          ? [[region.region_code.toUpperCase(), region.grouping_type] as const]
          : [],
      ),
    );
  }

  /** Every economy PIP publishes in `version`, those it publishes only as model estimates included. */
  private async loadEconomies(version: string, ctx: Context): Promise<Set<string>> {
    const url = this.buildUrl('/aux', { table: 'country_list', version, format: 'json' });
    const economies = await this.loadReference<RawPipEconomy>(`country_list/${version}`, url, ctx);
    return new Set(economies.flatMap((economy) => economy.country_code?.toUpperCase() ?? []));
  }

  /**
   * Pin a query to one release and PPP vintage. The listing keeps older releases
   * that `/pip` no longer serves — they answer HTTP 500, every 2011-vintage
   * build among them — so the choice is confined to the newest
   * `release_version`, and a vintage that release was not built at is rejected
   * rather than sent. The newest release is found by its `YYYYMMDD` stamp, not
   * by the listing's order.
   */
  private async resolveVersion(
    pppVersion: string | undefined,
    ctx: Context,
  ): Promise<ResolvedVersion> {
    const entries = (await this.loadVersions(ctx)).flatMap((entry) =>
      entry.version && entry.release_version && entry.ppp_version
        ? [
            {
              version: entry.version,
              releaseVersion: entry.release_version,
              pppVersion: entry.ppp_version,
            },
          ]
        : [],
    );

    const releaseVersion = entries.reduce(
      (newest, entry) => (entry.releaseVersion > newest ? entry.releaseVersion : newest),
      '',
    );
    if (!releaseVersion) {
      throw serializationError('PIP returned a versions listing that names no data release.');
    }

    const current = entries
      .filter((entry) => entry.releaseVersion === releaseVersion)
      .sort((a, b) => b.pppVersion.localeCompare(a.pppVersion));
    const chosen =
      pppVersion === undefined
        ? current[0]
        : current.find((entry) => entry.pppVersion === pppVersion);

    if (!chosen) {
      const available = current.map((entry) => entry.pppVersion);
      throw validationError(
        `PPP vintage ${pppVersion} is not available: PIP's current data release (${releaseVersion}) is published at PPP vintages ${available.join(', ')}.`,
        {
          reason: 'ppp_version_unavailable',
          pppVersion,
          availablePppVersions: available,
          releaseVersion,
          retryable: false,
        },
      );
    }
    return chosen;
  }

  /**
   * Economy estimates, preferring survey rows and filling in whatever they
   * leave uncovered.
   *
   * `fill_gaps=true` is not a superset of `fill_gaps=false`. It answers for
   * every year in a country's coverage window, but every row it returns drops
   * `gini`, `mld`, `polarization`, the ten decile shares, and `survey_year` —
   * including for years a survey does exist for. Asking upstream once with the
   * caller's `fill_gaps` value would therefore make the whole inequality half of
   * this tool permanently null. Asking for survey rows first and gap-filling
   * around them gives an agent the real distribution whenever one exists, and an
   * estimate labelled as such when it doesn't.
   *
   * What "uncovered" means depends on the request. A four-digit year is answered
   * once an economy has any survey row, and PIP returns the same row grain in
   * both modes for a year it surveyed, so gap-filling there is per economy. A
   * request spanning the whole window (`all`, or no `year`) is the opposite: PIP
   * surveys a handful of years and estimates every year around them, so an
   * economy with survey rows still has gaps between and after them, and
   * gap-filling is per row grain. `MRV` follows `fill_gaps` as PIP's own `MRV`
   * does: both passes always run, each economy resolves to the newest year
   * either answers — PIP's latest estimate year wherever it publishes one — and
   * a survey row wins over its gap-filled twin at that year and grain, so no
   * economy comes back at two different years.
   */
  private async surveyFirst(
    codes: readonly string[],
    filters: PipFilters,
    fillGaps: boolean,
    ctx: Context,
  ): Promise<EconomyRows> {
    const surveyRows = await this.economyPass(codes, filters, false, ctx);
    if (!fillGaps) return { rows: surveyRows, gapFilled: false, modelOnly: [] };

    const multiYear = spansMultipleYears(filters.year);
    const mostRecent = isMostRecent(filters.year);
    const answered = new Set(surveyRows.map((row) => row.countryCode));
    /**
     * A four-digit year needs nothing added once every requested economy has
     * answered; `all` hides which economies were asked for, so it always looks.
     * A multi-year request always has the years between the surveys to fill,
     * and `MRV` has PIP's latest estimate year to weigh against the survey's.
     */
    const mayHaveGaps =
      multiYear || mostRecent || codes.includes('ALL') || codes.some((code) => !answered.has(code));
    if (!mayHaveGaps) return { rows: surveyRows, gapFilled: false, modelOnly: [] };

    const keyOf = multiYear || mostRecent ? rowKey : (row: PovertyRow) => row.countryCode;
    const covered = new Set(surveyRows.map(keyOf));
    const filled = (await this.economyPass(codes, filters, true, ctx)).filter(
      (row) => !covered.has(keyOf(row)),
    );
    const merged = [...surveyRows, ...filled];
    const rows = mostRecent ? keepNewestYear(merged) : merged;
    const fromFilled = new Set(filled);
    return { rows, gapFilled: rows.some((row) => fromFilled.has(row)), modelOnly: [] };
  }

  /**
   * Economy estimates for `codes`, answering the economies PIP publishes only
   * as model estimates (`CMD estimation`). `/pip` rejects those by code — its
   * accepted `country` list holds surveyed economies and aggregates only — but
   * serves their rows under `country=all`. So a country rejection is read
   * against that list: a code PIP's full economy list does not carry either is
   * `country_not_found`, and the rest are answered from one `country=all`
   * gap-filled request for the same year and filters, narrowed to them, while
   * the other codes take the ordinary survey-first path. With `fill_gaps` off
   * they have no rows to return and are reported instead. A surveyed-economy
   * request never reaches this path, so it costs nothing extra.
   */
  private async economyRows(
    codes: readonly string[],
    filters: PipFilters,
    fillGaps: boolean,
    ctx: Context,
  ): Promise<EconomyRows> {
    try {
      return await this.surveyFirst(codes, filters, fillGaps, ctx);
    } catch (error) {
      const unlisted = error instanceof McpError ? unlistedCountries.get(error) : undefined;
      if (!unlisted) throw error;

      const economies = await this.loadEconomies(filters.version, ctx);
      const unknown = unlisted.filter((code) => !economies.has(code));
      if (unknown.length > 0) {
        throw notFound(
          `PIP does not recognize the country code(s) "${unknown.join(',')}".`,
          { reason: 'country_not_found', countryCodes: unknown.join(','), retryable: false },
          { cause: error },
        );
      }

      const listed = codes.filter((code) => !unlisted.includes(code));
      // `all` among the listed codes already gap-fills every economy, these included.
      const needsModelPass = fillGaps && !listed.includes('ALL');
      const [surveyed, modelled] = await Promise.all([
        listed.length > 0
          ? this.surveyFirst(listed, filters, fillGaps, ctx)
          : Promise.resolve(NO_ECONOMY_ROWS),
        needsModelPass
          ? this.economyPass(['all'], filters, true, ctx, unlisted)
          : Promise.resolve([]),
      ]);
      const wanted = new Set(unlisted);
      const modelRows = modelled.filter((row) => wanted.has(row.countryCode));
      return {
        rows: [...surveyed.rows, ...modelRows],
        gapFilled: surveyed.gapFilled || modelRows.length > 0,
        modelOnly: fillGaps ? [] : unlisted,
      };
    }
  }

  /**
   * Aggregate estimates from `/pip-grp`, one request per `group_by` in use.
   * `/pip-grp` answers `year=MRV` with an empty array, so `MRV` asks for the
   * whole series and keeps each aggregate's newest year — its latest nowcast,
   * the same reading `MRV` has for an economy under `fill_gaps`.
   */
  private async groupRows(
    groups: ReadonlyMap<string, string[]>,
    filters: PipFilters,
    ctx: Context,
  ): Promise<PovertyRow[]> {
    const mostRecent = isMostRecent(filters.year);
    const params = {
      version: filters.version,
      povline: filters.povline,
      year: mostRecent ? undefined : filters.year,
    };
    const batches = await Promise.all(
      [...groups].map(([groupBy, codes]) =>
        this.fetchRows<RawPipGroupRow>('/pip-grp', codes, { ...params, group_by: groupBy }, ctx),
      ),
    );
    const rows = batches.flat().map(normalizeGroupRow);
    return mostRecent ? keepNewestYear(rows) : rows;
  }

  /**
   * Fetch poverty and inequality estimates for economies and aggregates, merged
   * into one list and paginated locally.
   *
   * Codes are resolved in one order: WDI's group spellings (`LMC`, `IDX`, …)
   * read as PIP's and duplicates collapse; PIP's regions table then routes each
   * aggregate to `/pip-grp` and rejects the ones this tool does not serve,
   * before any data request; every other code goes to `/pip`. The regions table
   * loads alongside `/versions` and is skipped for a request of `all` alone.
   *
   * Every request carries the same fully-qualified `version`, resolved once up
   * front, so survey rows, the estimates filled around them, and the aggregates
   * always come from one release at one PPP vintage.
   */
  async getPoverty(
    opts: {
      countries: string[];
      year?: string;
      povertyLine?: number;
      welfareType?: string;
      reportingLevel?: string;
      pppVersion?: string;
      fillGaps: boolean;
      page: number;
      perPage: number;
    },
    ctx: Context,
  ): Promise<{
    rows: PovertyRow[];
    total: number;
    page: number;
    pages: number;
    /** Page size actually served: the requested size, reduced to the page cap when larger. */
    perPage: number;
    /**
     * Codes as queried — uppercased, respelled, and deduplicated in request
     * order — under the spelling a caller sends them ({@link listedCode}).
     */
    countries: string[];
    gapFilled: boolean;
    /** Economies PIP publishes only as model estimates, left out because `fillGaps` was off. */
    modelOnly: string[];
    pppVersion: string;
    releaseVersion: string;
  }> {
    const { countries, year, povertyLine, welfareType, reportingLevel, fillGaps, page, perPage } =
      opts;

    const requested = [
      ...new Set(
        countries.map((code) => {
          const upper = code.trim().toUpperCase();
          return WDI_GROUP_SPELLINGS[upper] ?? upper;
        }),
      ),
    ];
    const [resolved, regions] = await Promise.all([
      this.resolveVersion(opts.pppVersion, ctx),
      requested.some((code) => code !== 'ALL')
        ? this.loadRegions(ctx)
        : Promise.resolve(new Map<string, string>()),
    ]);
    const { economies, groups } = routeCodes(requested, regions, { welfareType, reportingLevel });

    const filters: PipFilters = {
      version: resolved.version,
      ...(year !== undefined && { year }),
      ...(povertyLine !== undefined && { povline: povertyLine }),
      ...(welfareType !== undefined && { welfare_type: welfareType }),
      ...(reportingLevel !== undefined && { reporting_level: reportingLevel }),
    };
    const [economyResult, aggregateRows] = await Promise.all([
      economies.length > 0
        ? this.economyRows(economies, filters, fillGaps, ctx)
        : Promise.resolve(NO_ECONOMY_ROWS),
      groups.size > 0 ? this.groupRows(groups, filters, ctx) : Promise.resolve([]),
    ]);

    const rows = [...economyResult.rows, ...aggregateRows].sort(compareRows);
    const size = Math.min(perPage, MAX_ESTIMATES_PER_PAGE);
    const start = (page - 1) * size;

    return {
      rows: rows.slice(start, start + size),
      total: rows.length,
      page,
      pages: Math.max(1, Math.ceil(rows.length / size)),
      perPage: size,
      countries: requested.map(listedCode),
      gapFilled: economyResult.gapFilled,
      modelOnly: economyResult.modelOnly,
      pppVersion: resolved.pppVersion,
      releaseVersion: resolved.releaseVersion,
    };
  }
}

// ─── Init/accessor pattern ─────────────────────────────────────────────────

let _service: PipService | undefined;

export function initPipService(config: AppConfig, storage: StorageService): void {
  _service = new PipService(config, storage);
}

export function getPipService(): PipService {
  if (!_service) {
    throw new Error('PipService not initialized — call initPipService() in setup()');
  }
  return _service;
}
