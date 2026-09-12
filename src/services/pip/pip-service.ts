/**
 * @fileoverview World Bank Poverty and Inequality Platform (PIP) service. Wraps
 * the `/pip` endpoint, which shares neither an envelope, a pagination model, nor
 * an error convention with the Indicators v2 API: rows arrive as a flat JSON
 * array, there is no server-side paging, and a rejected parameter value comes
 * back as a real HTTP 404 carrying the list of values that would have been
 * accepted. Survey rows are preferred over gap-filled ones and the two are
 * merged, because PIP strips the whole distributional block from every
 * gap-filled row.
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
import type { PipValidationBody, PovertyRow, RawPipRow, RawPipVersion } from './types.js';

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
 * Most values PIP will enumerate back for a rejected parameter before the list
 * stops being worth putting in front of an agent. `welfare_type` enumerates
 * three and `reporting_level` four, both worth quoting verbatim; `country` runs
 * to 200 and `year` to 66, and belong behind a recovery hint instead.
 */
const MAX_QUOTED_VALID_VALUES = 12;

// ─── Error classification ────────────────────────────────────────────────────

/**
 * Read the parameter names out of PIP's 404 body. The framework truncates a
 * captured error body at 500 bytes, which lands mid-array for `country` and
 * `year`, so the names are matched rather than parsed.
 *
 * The pattern can only under-report, never mis-report: `msg` appears nowhere in
 * the body except as the first key of a `details` entry, so a name is only ever
 * matched where PIP put one, and a truncation that cuts through an entry drops
 * it from the list instead of substituting a neighbour. `country` is always the
 * first `details` entry, so the branch that depends on spotting it survives
 * every truncation.
 */
function rejectedParameterNames(body: string): string[] {
  return [...body.matchAll(/"([A-Za-z_]+)"\s*:\s*\{\s*"msg"/g)].map((m) => m[1] as string);
}

/**
 * Accepted values for a rejected parameter, when PIP sent few enough of them to
 * be useful and the body survived truncation intact. Anything longer is dropped:
 * a 200-entry country list crowds out the recovery hint that would actually
 * resolve the call.
 */
function quotableValidValues(body: string, parameter: string): string[] | undefined {
  let parsed: PipValidationBody;
  try {
    parsed = JSON.parse(body) as PipValidationBody;
  } catch {
    return;
  }
  const valid = parsed.details?.[parameter]?.valid;
  if (!Array.isArray(valid) || valid.length === 0 || valid.length > MAX_QUOTED_VALID_VALUES) return;
  return valid.map(String);
}

/**
 * Translate a non-2xx from PIP into a classified domain error.
 *
 * A 404 is a rejected parameter value, never a missing resource — PIP answers a
 * well-formed query that matches nothing with an empty array and HTTP 200.
 *
 * A 5xx has two causes that are indistinguishable from the response, which
 * carries no detail beyond `Internal Server Error`: an ordinary upstream fault,
 * or an aggregate `country` code. `/pip` lists every region and income group
 * among its valid `country` values but serves none of them, so `country=WLD`
 * fails as an internal error rather than a validation error. The message states
 * the status and offers both, rather than asserting the aggregate cause over an
 * outage.
 */
function classifyPipError(error: McpError, countryCodes: string): McpError {
  const status = Number(error.data?.status ?? error.data?.statusCode);
  const body = String(error.data?.body ?? error.data?.responseBody ?? '');

  if (status === 404) {
    const parameters = rejectedParameterNames(body);
    if (parameters.includes('country')) {
      return notFound(
        `PIP does not recognize the country code(s) "${countryCodes}". PIP covers individual economies only, under their ISO3 codes. Use worldbank_list_countries to look a code up.`,
        { reason: 'country_not_found', countryCodes, retryable: false },
        { cause: error },
      );
    }
    const named = parameters.length > 0 ? parameters.join(', ') : 'a query parameter';
    const quotable = parameters.flatMap((parameter) => {
      const valid = quotableValidValues(body, parameter);
      return valid ? [`${parameter} accepts ${valid.join(', ')}`] : [];
    });
    return validationError(
      `PIP rejected the value supplied for ${named}.${quotable.length > 0 ? ` Accepted values: ${quotable.join('; ')}.` : ''}`,
      { reason: 'invalid_parameter', parameters, retryable: false },
      { cause: error },
    );
  }

  if (status >= 500) {
    return serviceUnavailable(
      `PIP returned HTTP ${status} for country code(s) "${countryCodes}", with no detail on the cause. Either the service is temporarily unavailable, or one of those codes is a regional or income-group aggregate — PIP lists those among its valid country values but does not serve them on this endpoint, and rejects them this way.`,
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

/** Stable ordering, so a merged result doesn't depend on which request answered first. */
function compareRows(a: PovertyRow, b: PovertyRow): number {
  return (
    a.countryCode.localeCompare(b.countryCode) ||
    a.reportingYear - b.reportingYear ||
    a.reportingLevel.localeCompare(b.reportingLevel) ||
    a.welfareType.localeCompare(b.welfareType)
  );
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Query parameters `/pip` accepts, before `fill_gaps` is decided per request. */
type PipQuery = {
  country: string;
  version: string;
  year?: string;
  povline?: number;
  welfare_type?: string;
  reporting_level?: string;
};

/** The data release and PPP vintage every request of one query is pinned to. */
type ResolvedVersion = { pppVersion: string; releaseVersion: string; version: string };

export class PipService {
  private readonly baseUrl: string;
  private readonly versionsCacheTtlMs: number;

  /**
   * The `/versions` listing, cached as a promise so concurrent queries share one
   * request. Held on the instance, like the Indicators service's reference
   * caches, so tests and multiple instances stay isolated.
   */
  private versionsCache: { expiresAt: number; listing: Promise<RawPipVersion[]> } | undefined;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.pipBaseUrl.replace(/\/$/, '');
    this.versionsCacheTtlMs = serverConfig.catalogCacheTtlMs;
  }

  private buildUrl(query: PipQuery, fillGaps: boolean): string {
    const qs = new URLSearchParams({ fill_gaps: String(fillGaps) });
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) qs.set(key, String(value));
    }
    return `${this.baseUrl}/pip?${qs.toString()}`;
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
         * One retry, not the framework default of three. PIP's 5xx is at least
         * as often permanent as transient — every aggregate code it advertises
         * as a valid `country` fails that way on every attempt — so the extra
         * attempts only add delay to a settled answer. The one retry earns its
         * place on a timeout instead: the attempt that timed out leaves the
         * query warm in PIP's cache, and the retry usually answers at once.
         */
        maxRetries: 1,
        signal: ctx.signal,
      },
    );
  }

  /** Fetch one `/pip` response, mapping PIP's status codes to domain errors. */
  private async fetchRows(query: PipQuery, fillGaps: boolean, ctx: Context): Promise<RawPipRow[]> {
    const url = this.buildUrl(query, fillGaps);
    ctx.log.debug('Fetching PIP estimates', { url });

    const parsed = await this.fetchJson(url, ctx, (error) =>
      classifyPipError(error, query.country),
    );
    if (!Array.isArray(parsed)) {
      throw serializationError(
        'PIP returned a response that is not the expected array of estimate rows.',
        { url },
      );
    }
    return parsed as RawPipRow[];
  }

  /** Load the `/versions` listing, from cache while it is fresh. */
  private loadVersions(ctx: Context): Promise<RawPipVersion[]> {
    const cached = this.versionsCache;
    if (cached && cached.expiresAt > Date.now()) return cached.listing;

    const url = `${this.baseUrl}/versions?format=json`;
    ctx.log.debug('Fetching PIP versions', { url });
    const listing = this.fetchJson(url, ctx, (error) => error).then((parsed) => {
      if (!Array.isArray(parsed)) {
        throw serializationError('PIP returned a versions listing that is not an array.', { url });
      }
      return parsed as RawPipVersion[];
    });

    this.versionsCache = { listing, expiresAt: Date.now() + this.versionsCacheTtlMs };
    // A failed listing must not be served from cache to the next query.
    listing.catch(() => {
      if (this.versionsCache?.listing === listing) this.versionsCache = undefined;
    });
    return listing;
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
   * Fetch poverty and inequality estimates, preferring survey rows and filling
   * in whatever they leave uncovered.
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
   * What "uncovered" means depends on the request. A single reporting year — a
   * four-digit year, or `MRV`, which resolves to one year per economy — is
   * answered once an economy has any survey row, and PIP returns the same row
   * grain in both modes for a year it surveyed; gap-filling there is per
   * economy, so `MRV` cannot return one economy twice at two different years.
   * A request spanning the whole window (`all`, or no `year`) is the opposite:
   * PIP surveys a handful of years and estimates every year around them, so an
   * economy with survey rows still has gaps between and after them. Gap-filling
   * there is per row grain, which is what keeps `fill_gaps` from silently doing
   * nothing on the most common query of all — one economy, no year.
   *
   * Both requests carry the same fully-qualified `version`, resolved once up
   * front, so the survey rows and the estimates filled around them always come
   * from one release at one PPP vintage.
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
    gapFilled: boolean;
    pppVersion: string;
    releaseVersion: string;
  }> {
    const { countries, year, povertyLine, welfareType, reportingLevel, fillGaps, page, perPage } =
      opts;

    const resolved = await this.resolveVersion(opts.pppVersion, ctx);
    const requested = countries.map((code) => code.trim().toUpperCase());
    const query: PipQuery = {
      country: requested.join(','),
      version: resolved.version,
      ...(year !== undefined && { year }),
      ...(povertyLine !== undefined && { povline: povertyLine }),
      ...(welfareType !== undefined && { welfare_type: welfareType }),
      ...(reportingLevel !== undefined && { reporting_level: reportingLevel }),
    };

    const surveyRows = (await this.fetchRows(query, false, ctx)).map(normalizeRow);
    const multiYear = spansMultipleYears(year);
    const answered = new Set(surveyRows.map((row) => row.countryCode));

    let rows = surveyRows;
    let gapFilled = false;

    /**
     * A single reporting year needs nothing added once every requested economy
     * has answered; `all` hides which economies were asked for, so it always
     * looks. A multi-year request always has the years between the surveys to
     * fill, however many economies answered.
     */
    const mayHaveGaps =
      multiYear || requested.includes('ALL') || requested.some((code) => !answered.has(code));

    if (fillGaps && mayHaveGaps) {
      const keyOf = multiYear ? rowKey : (row: PovertyRow) => row.countryCode;
      const covered = new Set(surveyRows.map(keyOf));
      const filled = (await this.fetchRows(query, true, ctx))
        .map(normalizeRow)
        .filter((row) => !covered.has(keyOf(row)));
      if (filled.length > 0) {
        rows = [...surveyRows, ...filled];
        gapFilled = true;
      }
    }

    rows.sort(compareRows);
    const size = Math.min(perPage, MAX_ESTIMATES_PER_PAGE);
    const start = (page - 1) * size;

    return {
      rows: rows.slice(start, start + size),
      total: rows.length,
      page,
      pages: Math.max(1, Math.ceil(rows.length / size)),
      perPage: size,
      gapFilled,
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
