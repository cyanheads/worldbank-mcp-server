/**
 * @fileoverview World Bank Projects API service. Wraps the `/projects` search
 * endpoint, which shares neither a host, an envelope, a pagination model, nor an
 * error convention with the Indicators v2 API or with PIP: results arrive as an
 * object keyed by project ID, paging is offset-based, and an exact-match filter
 * that matches nothing answers HTTP 200 with `total: 0` rather than an error.
 * That last one is the reason this service probes the country filter in
 * isolation whenever a search comes back empty — a zero hit that reads as "no
 * results" is otherwise indistinguishable from a country code the portfolio has
 * never heard of.
 * @module services/projects/projects-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { ProjectSummary, RawProject, RawProjectsEnvelope } from './types.js';

/** Minimal request-context shape that satisfies fetchWithTimeout and withRetry. */
type ReqCtx = Context & Record<string, unknown>;

/**
 * Timeout for a single `/projects` request. Measured latency is well inside a
 * second even for a full 1,000-row page, so this matches the ordinary-request
 * budget the Indicators service uses rather than the 60s PIP needs for its cold
 * query computation.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Rows the endpoint will actually return for one request. It accepts a larger
 * `rows` and echoes it back in the envelope while still returning 1,000 records,
 * so the ceiling has to be enforced here — the response body is the only place
 * the truncation shows.
 */
const MAX_ROWS_PER_REQUEST = 1000;

/**
 * Largest `os` the endpoint accepts. Past it the request fails with an HTTP 400
 * whose body names the internal search index behind the API, so the offset is
 * bounded here instead.
 */
const MAX_OFFSET = 100_000;

/**
 * Separator for a multi-value filter. A comma reads as part of a single value
 * rather than as a list — `countrycode_exact=BR,IN` matches nothing and returns
 * HTTP 200 with `total: 0`, the same shape a genuine no-match produces. Region
 * names contain commas of their own, so the caret is the only separator that can
 * express a list here at all.
 */
const MULTI_VALUE_SEPARATOR = '^';

/**
 * Fields requested via `fl`. Without it the response carries a fixed default
 * projection that omits `status`, `countryname`, `countrycode`, and the
 * abstract. Requesting a list does not narrow the response to exactly that list:
 * `proj_id` and `project_abstract` come back whatever is asked for.
 */
const PROJECT_FIELDS = [
  'id',
  'project_name',
  'status',
  'countryname',
  'countrycode',
  'regionname',
  'boardapprovaldate',
  'closingdate',
  'totalamt',
  'projectfinancialtype',
  'major_sectors',
  'project_abstract',
].join(',');

/** Canonical project page. The API publishes no link field of its own. */
const PROJECT_PAGE_BASE = 'https://projects.worldbank.org/en/projects-operations/project-detail';

// ─── Error classification ────────────────────────────────────────────────────

/**
 * Translate a non-2xx from the Projects API into a classified domain error.
 *
 * Every status lands on the same reason, because none of them is something the
 * caller can fix by changing the search: the tool schema validates each filter
 * before the request, so a rejection here is the API's own state — a 4xx means
 * the endpoint would not accept the call at all, a 5xx that it failed serving it.
 *
 * The upstream body is deliberately never quoted into the message. A 4xx carries
 * the hostname and index name of the search cluster behind the API, and a 5xx
 * carries a Node stack trace with absolute paths from the upstream host; neither
 * helps an agent and both are the API's internals rather than this server's.
 */
function classifyProjectsError(error: McpError): McpError {
  const status = Number(error.data?.status ?? error.data?.statusCode);
  if (!Number.isFinite(status)) return error;

  return serviceUnavailable(
    `The World Bank Projects API answered HTTP ${status}.`,
    {
      reason: 'upstream_unavailable',
      status,
      // A 4xx is a settled answer — retrying the identical call cannot change it.
      ...(status < 500 && { retryable: false }),
    },
    { cause: error },
  );
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Narrow a date to its calendar day. `boardapprovaldate` arrives as a timestamp
 * (`2027-10-26T00:00:00Z`) while `closingdate` arrives bare, and the tool takes
 * its own date filters as `YYYY-MM-DD`. Anything that doesn't lead with a
 * calendar date is passed through rather than discarded.
 */
function toCalendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? (match[1] as string) : value;
}

/** Monetary fields arrive as strings; an absent amount is absent, not zero. */
function toAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * Major sector names, deduplicated in upstream order. A project can list the
 * same major sector twice when two of its sectors roll up to it.
 */
function majorSectorNames(raw: RawProject): string[] {
  const names = (raw.major_sectors ?? []).flatMap((entry) => {
    const name = entry.major_sector?.major_sector_name;
    return name ? [name] : [];
  });
  return [...new Set(names)];
}

function normalizeProject(raw: RawProject, includeAbstract: boolean): ProjectSummary {
  const id = raw.id ?? '';
  return {
    id,
    name: raw.project_name ?? '',
    status: raw.status ?? '',
    countryCodes: raw.countrycode ?? [],
    countryName: raw.countryname ?? '',
    regionName: raw.regionname ?? '',
    boardApprovalDate: toCalendarDate(raw.boardapprovaldate),
    closingDate: toCalendarDate(raw.closingdate),
    totalCommitment: toAmount(raw.totalamt),
    // Upstream repeats a financing window once per instrument drawn on it.
    financialTypes: [...new Set(raw.projectfinancialtype ?? [])],
    majorSectors: majorSectorNames(raw),
    abstract: includeAbstract ? (raw.project_abstract ?? null) : null,
    url: `${PROJECT_PAGE_BASE}/${id}`,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Query parameters the `/projects` endpoint filters on, already joined for multi-value. */
type ProjectsFilters = {
  countrycode_exact?: string;
  enddate?: string;
  qterm?: string;
  regionname_exact?: string;
  status_exact?: string;
  strdate?: string;
};

export type ProjectSearchOptions = {
  approvedFrom?: string;
  approvedTo?: string;
  countryCodes: string[];
  includeAbstract: boolean;
  page: number;
  perPage: number;
  query?: string;
  regions: string[];
  statuses: string[];
};

export type ProjectSearchResult = {
  /**
   * Projects matching the country filter on its own, measured only when the
   * search itself returned nothing and a country filter was in force. Zero means
   * no project in the portfolio carries any of those codes; a positive number
   * means the codes match as a set — the OR of them, not each individually — and
   * the other filters are what emptied the result. Null when no probe ran, or
   * when it ran and failed.
   */
  countryOnlyTotal: number | null;
  page: number;
  pages: number;
  projects: ProjectSummary[];
  total: number;
};

export class ProjectsService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().projectsBaseUrl.replace(/\/$/, '');
  }

  private buildUrl(filters: ProjectsFilters, rows: number, offset: number): string {
    const qs = new URLSearchParams({
      format: 'json',
      fl: PROJECT_FIELDS,
      rows: String(rows),
      os: String(offset),
    });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) qs.set(key, value);
    }
    return `${this.baseUrl}/projects?${qs.toString()}`;
  }

  /** Fetch one `/projects` response and normalize its envelope into rows plus a count. */
  private fetchPage(
    filters: ProjectsFilters,
    rows: number,
    offset: number,
    ctx: Context,
  ): Promise<{ raw: RawProject[]; total: number }> {
    const url = this.buildUrl(filters, rows, offset);
    ctx.log.debug('Searching World Bank projects', { url });

    return withRetry(
      async () => {
        let text: string;
        try {
          const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, ctx as ReqCtx, {
            signal: ctx.signal,
          });
          text = await response.text();
        } catch (error) {
          if (error instanceof McpError) throw classifyProjectsError(error);
          throw error;
        }

        // A 2xx carrying HTML is the shared Cloudflare front answering instead
        // of the API. A non-2xx HTML page never reaches here — fetchWithTimeout
        // throws on the status first.
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'The World Bank Projects API returned an HTML error page — likely rate-limited or temporarily unavailable.',
            { reason: 'upstream_unavailable' },
          );
        }

        let parsed: RawProjectsEnvelope;
        try {
          parsed = JSON.parse(text) as RawProjectsEnvelope;
        } catch (error) {
          throw serializationError(
            'The World Bank Projects API returned a response that is not JSON.',
            { url },
            { cause: error },
          );
        }

        const projects = parsed.projects;
        if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
          throw serializationError(
            'The World Bank Projects API returned a response without the expected projects object.',
            { url },
          );
        }

        return {
          // Results are keyed by project ID rather than listed, so the values
          // have to be collected before anything downstream can treat them as rows.
          raw: Object.values(projects),
          total: Number(parsed.total ?? 0),
        };
      },
      {
        operation: 'ProjectsService.fetchPage',
        context: ctx as ReqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Search the World Bank lending portfolio.
   *
   * Every filter this accepts is an exact match upstream, and an exact match on a
   * value the index does not hold returns HTTP 200 with `total: 0` — the same
   * response a real no-match produces. Enum-backed filters cannot reach that
   * state because the schema rejects an unknown value before the request, but a
   * country code cannot be checked that way: it is well-formed at two characters
   * and only the index knows whether the portfolio has ever used it. So an empty
   * result with a country filter in force costs one extra `rows=0` request that
   * asks the country filter alone, which separates "that code matches nothing at
   * all" from "the codes are fine, the combination is what is empty". The probe
   * asks the codes as one OR-set, so a positive count settles the set rather
   * than each code, and a probe that fails leaves the empty result untouched.
   */
  async searchProjects(opts: ProjectSearchOptions, ctx: Context): Promise<ProjectSearchResult> {
    const { countryCodes, includeAbstract, page, perPage } = opts;

    const rows = Math.min(perPage, MAX_ROWS_PER_REQUEST);
    const offset = (page - 1) * rows;
    if (offset > MAX_OFFSET) {
      throw validationError(
        `Page ${page} at ${rows} results per page starts past the ${MAX_OFFSET.toLocaleString('en-US')}-result offset the World Bank Projects API serves.`,
        { reason: 'page_out_of_range', page, perPage: rows, retryable: false },
      );
    }

    const countryFilter =
      countryCodes.length > 0
        ? countryCodes.map((code) => code.trim().toUpperCase()).join(MULTI_VALUE_SEPARATOR)
        : undefined;

    const filters: ProjectsFilters = {
      ...(opts.query !== undefined && { qterm: opts.query }),
      ...(countryFilter !== undefined && { countrycode_exact: countryFilter }),
      ...(opts.statuses.length > 0 && {
        status_exact: opts.statuses.join(MULTI_VALUE_SEPARATOR),
      }),
      ...(opts.regions.length > 0 && {
        regionname_exact: opts.regions.join(MULTI_VALUE_SEPARATOR),
      }),
      ...(opts.approvedFrom !== undefined && { strdate: opts.approvedFrom }),
      ...(opts.approvedTo !== undefined && { enddate: opts.approvedTo }),
    };

    const { raw, total } = await this.fetchPage(filters, rows, offset, ctx);

    let countryOnlyTotal: number | null = null;
    if (total === 0 && countryFilter !== undefined) {
      try {
        const probe = await this.fetchPage({ countrycode_exact: countryFilter }, 0, 0, ctx);
        countryOnlyTotal = probe.total;
      } catch (error) {
        /**
         * The search itself succeeded — an empty result is a valid answer, and a
         * failed diagnostic must not turn it into an error. Leaving the count
         * null drops the caller back to the generic empty-result notice.
         */
        ctx.log.debug('Country-filter probe failed; reporting the empty result without it', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      projects: raw.map((project) => normalizeProject(project, includeAbstract)),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / rows)),
      countryOnlyTotal,
    };
  }
}

// ─── Init/accessor pattern ─────────────────────────────────────────────────

let _service: ProjectsService | undefined;

export function initProjectsService(config: AppConfig, storage: StorageService): void {
  _service = new ProjectsService(config, storage);
}

export function getProjectsService(): ProjectsService {
  if (!_service) {
    throw new Error('ProjectsService not initialized — call initProjectsService() in setup()');
  }
  return _service;
}
