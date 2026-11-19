/**
 * @fileoverview Search the World Bank lending portfolio — active, closed,
 * dropped, and pipeline operations — by free text, country, region, status,
 * sector, theme, financing window, and board approval date.
 * @module mcp-server/tools/definitions/worldbank-search-projects.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { perPageInput, resolvePerPage } from '@/mcp-server/tools/per-page.js';
import {
  CALL_DEADLINE_MS,
  isCallDeadlineExceeded,
  withCallDeadline,
} from '@/services/call-deadline.js';
import {
  normalizeSectorNames,
  normalizeThemeNames,
} from '@/services/projects/normalize-sector-names.js';
import { toPortfolioCode } from '@/services/projects/portfolio-country-codes.js';
import { getProjectsService } from '@/services/projects/projects-service.js';
import { MAX_PROJECTS_PER_PAGE } from '@/services/response-budget.js';
import { splitCountryCodes } from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

/**
 * The Projects API keys countries on a two-character code — ISO2 for an
 * individual economy (a legacy code for four of them), and a World Bank regional
 * code such as `3W` for a multi-country operation. Every other tool on this
 * server takes ISO3 too, so a three-character code is resolved through the World
 * Bank country index before the request; sent as-is it would come back as a
 * plain zero-hit rather than an error. Digits are accepted because the regional
 * codes carry them: 34 of the 218 codes the portfolio uses are not two letters.
 */
const COUNTRY_CODE = /^[A-Za-z0-9]{2,3}$/;

/** Statuses the portfolio publishes. Every project carries exactly one. */
const PROJECT_STATUSES = ['Active', 'Closed', 'Dropped', 'Pipeline'] as const;

/**
 * Operational regions the portfolio publishes, which are the World Bank's
 * lending regions rather than the WDI aggregate codes the other tools use.
 * "Africa" is the pre-split region, on closed and dropped operations only (245,
 * 2026-11-11); "Other" holds current world and multi-regional operations.
 */
const PROJECT_REGIONS = [
  'East Asia and Pacific',
  'Europe and Central Asia',
  'Latin America and Caribbean',
  'Middle East, North Africa, Afghanistan, and Pakistan',
  'South Asia',
  'Eastern and Southern Africa',
  'Western and Central Africa',
  'Africa',
  'Other',
] as const;

/**
 * Financing windows the portfolio publishes in `projectfinancialtype` — the
 * complete set across all 28,153 projects (2026-09-25), matched case-sensitively
 * upstream. The filter takes exactly the values `financialTypes` reports.
 */
const FINANCING_WINDOWS = ['IBRD', 'IDA', 'Grants', 'Other'] as const;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Whether a `YYYY-MM-DD` string names a day that exists. The schema pattern
 * settles the shape; this settles the calendar, which the Projects API does not:
 * an out-of-range month crashes it with an HTTP 500, and an out-of-range day
 * (`2020-02-30`, `2023-02-29`) is accepted and searched as though it were real.
 */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lastDay = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  return day >= 1 && day <= lastDay;
}

export const worldbankSearchProjects = tool('worldbank_search_projects', {
  title: 'Search World Bank Projects',
  description:
    'Search the World Bank lending portfolio — the loans, credits, and grants the Bank finances — by free text, country, region, status, sector, theme, financing windows, and board approval date. Returns each operation\'s objective, borrower, status, dates, USD commitment with its IBRD, IDA, and grant parts, financing windows, sectors with their shares, optional themes and abstract, and project page. Use it for questions such as "what is the World Bank funding in Kenya" or "which climate adaptation projects are active" (theme: ["Adaptation"], status: ["Active"]); for development statistics, use worldbank_search_indicators and worldbank_get_data. Prefer the sector and theme filters to a free-text query, which also matches incidental prose: education commitments start from sector: ["Primary Education", "Secondary Education", "Tertiary Education"], three of the Education sub-sectors rows list in sectors[].name — read it on matching rows for the rest. Filters match exactly and combine by AND, so a narrow search can return nothing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free text matched against project names, abstracts, and objectives; every word must appear. A quoted phrase and AND or OR between words parse; brackets, braces, an unmatched double quote, a slash between words, a trailing backslash, an AND or OR at either end, a trailing NOT, and # are rejected. Omit to browse by filter alone.',
      ),
    countries: z
      .union([
        z.string().describe('One code, or several separated by commas, semicolons, or pipes.'),
        z
          .array(z.string())
          .describe('Codes; an element holding several separated codes is split too.'),
      ])
      .optional()
      .describe(
        'Borrowing economies by ISO3 or ISO2 code (BRA or BR), or World Bank regional codes for multi-country operations (3W Western and Central Africa, 3E Eastern and Southern Africa, 4E East Asia and Pacific); 3A is the pre-split Africa code, on closed and dropped operations only. Several codes combine as OR. Yemen, DR Congo, West Bank and Gaza, and Timor-Leste are searched under their legacy portfolio codes (RY, ZR, GZ, TP), also accepted as sent. WDI aggregates (SSF, WLD) are rejected: use region. Omit for every country.',
      ),
    status: z
      .array(z.enum(PROJECT_STATUSES))
      .optional()
      .describe(
        'Lifecycle stages, combined as OR: Active (under implementation), Pipeline (approved, not yet effective), Closed (finished disbursing), Dropped (abandoned before approval). Omitted, results are mostly closed operations.',
      ),
    sector: z
      .array(z.string())
      .optional()
      .describe(
        'Sub-sector names as rows list them in sectors[].name, such as Primary Education or FY17 - Social Protection, not majorSectors names or sector codes. Each name matches in its bare and FY17 - spellings; several combine as OR. A project matches at any share, so weight a sector total by sectors[].percent. Unknown names match nothing; a name must be nonblank with no caret.',
      ),
    theme: z
      .array(z.string())
      .optional()
      .describe(
        'Theme names as rows list them in themes[].name (set include_themes), at any of the three levels, such as Adaptation, Gender, or FY17 - Climate change, not theme codes. Each name matches in its bare and FY17 - spellings; several combine as OR. Matching is case-sensitive, and the current and FY17 taxonomies, never mixed on one project, spell some themes differently (pass both Climate Change and Climate change), so check themes[].name on rows of each before relying on one spelling. A project matches at any share, and shares overlap, so weight or threshold by themes[].percent. Unknown names match nothing; a name must be nonblank with no caret.',
      ),
    region: z
      .array(z.enum(PROJECT_REGIONS))
      .optional()
      .describe(
        'World Bank lending regions, combined as OR; not WDI aggregate codes. Africa is the pre-split region, on closed and dropped operations only; current African operations sit under Eastern and Southern Africa or Western and Central Africa.',
      ),
    financial_type: z
      .array(z.enum(FINANCING_WINDOWS))
      .optional()
      .describe(
        'Financing windows, combined as OR, matched against financialTypes; a project that publishes none never matches.',
      ),
    approved_from: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(CALENDAR_DATE, 'approved_from must be a calendar date as YYYY-MM-DD.')
          .describe('A date as YYYY-MM-DD.'),
      ])
      .optional()
      .describe(
        'Earliest board approval date, inclusive: a real calendar day, on or before approved_to.',
      ),
    approved_to: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(CALENDAR_DATE, 'approved_to must be a calendar date as YYYY-MM-DD.')
          .describe('A date as YYYY-MM-DD.'),
      ])
      .optional()
      .describe('Latest board approval date, inclusive: a real calendar day.'),
    include_abstract: z
      .boolean()
      .default(false)
      .describe("Include each project's full abstract; page size is unchanged."),
    include_themes: z
      .boolean()
      .default(false)
      .describe(
        "Include each project's themes; page size is unchanged, though themes can roughly triple a page. The theme filter works without it.",
      ),
    page: z.number().int().min(1).default(1).describe('Page number, 1-based.'),
    per_page: perPageInput(MAX_PROJECTS_PER_PAGE),
  }),
  output: z.object({
    projects: z
      .array(
        z
          .object({
            id: z.string().describe('Project ID, such as P513206.'),
            name: z.string().describe('Project name.'),
            objective: z
              .string()
              .nullable()
              .describe(
                'Development objective as plain text; null where none is published. Upstream cuts a few at 8,000 characters.',
              ),
            status: z.string().describe('Lifecycle stage: Active, Closed, Dropped, or Pipeline.'),
            countryCodes: z
              .array(z.string())
              .describe(
                "The borrower's ISO2 code, which the other tools take (YE for Yemen, filed upstream as RY), or a World Bank regional code (3W) for a multi-country operation; one per project.",
              ),
            countryName: z.string().describe('Borrower, as the portfolio names it.'),
            regionName: z.string().describe('World Bank lending region.'),
            boardApprovalDate: z
              .string()
              .nullable()
              .describe(
                "Board approval date, YYYY-MM-DD; a future date is a pipeline project's scheduled one.",
              ),
            closingDate: z
              .string()
              .nullable()
              .describe(
                'Scheduled or actual closing date, YYYY-MM-DD; null where none is published, as on most dropped operations.',
              ),
            totalCommitment: z
              .number()
              .nullable()
              .describe(
                'Commitment in USD as the project page reports it: ibrdCommitment + idaCommitment + grantAmount. Null where no amount is published, mostly on dropped and older operations — not a zero commitment. Bank lending alone is ibrdCommitment + idaCommitment.',
              ),
            ibrdCommitment: z
              .number()
              .nullable()
              .describe(
                'IBRD commitment in USD; null, not zero, when no IBRD or IDA amount is published, as on a grant-only operation.',
              ),
            idaCommitment: z
              .number()
              .nullable()
              .describe(
                'IDA commitment in USD, IDA grants included; null on the same terms as ibrdCommitment.',
              ),
            grantAmount: z
              .number()
              .nullable()
              .describe(
                "Grant amount in USD: trust-fund grants and, on some operations, other agencies' co-financing, so not all World Bank money. Independent of financialTypes.",
              ),
            financialTypes: z
              .array(z.string())
              .describe(
                'Financing windows, the values financial_type takes; several on a blended operation, empty where none is published.',
              ),
            majorSectors: z
              .array(z.string())
              .describe(
                'Major sectors, such as Health or Education; empty where none is published. Not accepted by the sector filter.',
              ),
            sectors: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .describe('Sub-sector name, the value the sector filter takes.'),
                    code: z.string().describe('Sector code, such as EEP.'),
                    majorSector: z.string().describe('Its majorSectors name.'),
                    percent: z
                      .number()
                      .nullable()
                      .describe(
                        'Share of the commitment in percent, usually summing to 100; null on every entry of a project that publishes no split, which is not a zero share.',
                      ),
                  })
                  .describe('A sub-sector.'),
              )
              .describe('Sub-sectors in upstream order; empty where none is published.'),
            themes: z
              .array(
                z
                  .object({
                    name: z.string().describe('Theme name, the value the theme filter takes.'),
                    code: z
                      .string()
                      .describe(
                        'Theme code: six digits in the current taxonomy (240102), two or three in the FY17 one (812).',
                      ),
                    parent: z
                      .string()
                      .nullable()
                      .describe(
                        'Theme one level up; null at the top level. A name at two levels appears twice, told apart by parent.',
                      ),
                    percent: z
                      .number()
                      .nullable()
                      .describe(
                        'Published share in percent. Shares overlap, so they do not add up across themes, and a few older ones exceed 100. Null where none is published, and on every entry of a project whose shares are all zero, which is not a zero share.',
                      ),
                  })
                  .describe('A theme, at any level.'),
              )
              .nullable()
              .describe(
                'Themes at all three levels, flattened in upstream order. Null unless include_themes is set; empty where none is published, including some recent operations the theme filter still matches.',
              ),
            abstract: z
              .string()
              .nullable()
              .describe(
                'Full abstract as plain text; null when include_abstract is false or none is published.',
              ),
            url: z.string().describe('Project page on projects.worldbank.org.'),
          })
          .describe('A lending operation.'),
      )
      .describe('Projects on this page, newest board approval first and undated ones last.'),
  }),

  enrichment: {
    appliedFilters: z
      .object({
        query: z.string().optional().describe('Query applied.'),
        countries: z
          .string()
          .optional()
          .describe(
            "Country codes as sent, each resolved to the portfolio's code (BRA → BR, YEM → RY), comma-joined.",
          ),
        status: z.string().optional().describe('Statuses applied.'),
        region: z.string().optional().describe('Regions applied.'),
        sector: z
          .array(z.string())
          .optional()
          .describe('Sector names applied, deduplicated, FY17 - prefix removed.'),
        theme: z
          .array(z.string())
          .optional()
          .describe('Theme names applied, deduplicated, FY17 - prefix removed, case kept.'),
        financialType: z.string().optional().describe('Financing windows applied, comma-joined.'),
        approvedFrom: z.string().optional().describe('Earliest board approval date applied.'),
        approvedTo: z.string().optional().describe('Latest board approval date applied.'),
        includeAbstract: z.boolean().describe('Whether abstracts were requested.'),
        includeThemes: z.boolean().describe('Whether themes were requested.'),
        page: z.number().describe('Page requested.'),
        perPage: z.number().describe('Page size served, after any reduction to the page maximum.'),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, or the server default; present only when perPage was reduced.',
          ),
      })
      .describe('The search as sent upstream; a filter not applied is omitted.'),
    totalCount: z.number().describe('Matching projects before pagination.'),
    currentPage: z
      .number()
      .describe('Page number; past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total pages at perPage.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Explains an empty result (including whether the country codes match on their own), a page past the end, or a reduced page size.',
      ),
  },

  enrichmentTrailer: {
    notice: {
      render: (notice) =>
        notice === undefined ? '' : `**Notice:** ${escapeMarkdownInline(notice)}`,
    },
    appliedFilters: {
      /**
       * A per-field `render` replaces the whole trailer line, `label` included,
       * so the heading has to be part of what it returns.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          ...(filters.query === undefined ? [] : [`query=${escapeMarkdownInline(filters.query)}`]),
          ...(filters.countries === undefined
            ? []
            : [`countries=${escapeMarkdownInline(filters.countries)}`]),
          ...(filters.status === undefined
            ? []
            : [`status=${escapeMarkdownInline(filters.status)}`]),
          ...(filters.region === undefined
            ? []
            : [`region=${escapeMarkdownInline(filters.region)}`]),
          ...(filters.sector === undefined
            ? []
            : [`sector=${filters.sector.map(escapeMarkdownInline).join(', ')}`]),
          ...(filters.theme === undefined
            ? []
            : [`theme=${filters.theme.map(escapeMarkdownInline).join(', ')}`]),
          ...(filters.financialType === undefined
            ? []
            : [`financial_type=${escapeMarkdownInline(filters.financialType)}`]),
          ...(filters.approvedFrom === undefined
            ? []
            : [`approved_from=${escapeMarkdownInline(filters.approvedFrom)}`]),
          ...(filters.approvedTo === undefined
            ? []
            : [`approved_to=${escapeMarkdownInline(filters.approvedTo)}`]),
          `include_abstract=${filters.includeAbstract}`,
          `include_themes=${filters.includeThemes}`,
          `page=${filters.page}`,
          `per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'invalid_sector_name',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'A sector name is blank or contains a caret.',
      recovery:
        'Send each nonblank sector name in its own array element, without caret separators.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_theme_name',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'A theme name is blank or contains a caret.',
      recovery: 'Send each nonblank theme name in its own array element, without caret separators.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_country_code',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A country code is malformed, unknown, or a WDI aggregate, or countries holds only separators.',
      recovery:
        'Pass each economy by an ISO3 or ISO2 code worldbank_list_countries lists, or a World Bank regional code such as 3W for multi-country operations. For every project in a region, drop the aggregate code and set the region filter instead.',
    },
    {
      reason: 'invalid_date',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'approved_from or approved_to is not a real calendar day.',
      recovery:
        'Correct the date to a real calendar day as YYYY-MM-DD, such as 2024-02-29 or 2023-02-28, and retry.',
    },
    {
      reason: 'reversed_date_range',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'approved_from is after approved_to.',
      recovery:
        'Swap the two dates so approved_from is on or before approved_to, or drop one of them for an open-ended window.',
    },
    {
      reason: 'invalid_query',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'query has syntax the Projects API cannot parse, or contains #.',
      recovery:
        'Remove from query any brackets or braces, an unmatched double quote, a slash between words, a trailing backslash, a #, an AND or OR at either end, and a trailing NOT, then search again. Plain words, a balanced quoted phrase, and AND or OR between words all parse.',
    },
    {
      reason: 'page_out_of_range',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The page starts past the 100,000-result offset the Projects API serves.',
      recovery:
        'Lower the page number, or add a filter so the matches fit inside the range the API pages through.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Projects API failed (a rate limit, a 408, a 5xx, or an HTML error page), or the country listing that resolves ISO3 codes did not load.',
      recovery:
        'Retry the same search once; if it keeps failing, the Projects API is down or has moved, and no change to the search will help.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      thrownBy: 'service',
      when: "The call's 50-second budget ran out before the Projects API or the ISO3 country listing answered.",
      recovery:
        'Retry the call shortly, or narrow the request so the World Bank Projects API has less to return.',
    },
  ],

  async handler(input, ctx) {
    /**
     * One deadline for the whole call, started before anything waits: the ISO3
     * lookup through the Indicators API and the Projects requests spend the same
     * budget, never one each.
     */
    const call = withCallDeadline(ctx);
    const codes = input.countries === undefined ? [] : splitCountryCodes(input.countries);
    const statuses = input.status ?? [];
    const regions = input.region ?? [];
    const sectors = normalizeSectorNames(input.sector ?? []);
    const themes = normalizeThemeNames(input.theme ?? []);
    const financialTypes = input.financial_type ?? [];
    const query = input.query?.trim() ? input.query.trim() : undefined;
    const approvedFrom = input.approved_from || undefined;
    const approvedTo = input.approved_to || undefined;

    /**
     * Checked here rather than on the schema so each failure carries a reason and
     * a recovery hint; a schema refinement would reject with neither. A blank
     * value reads as no country filter, for form-based clients, but one made only
     * of separators is refused: sent on as no filter it would search every country.
     */
    const nonBlank = [input.countries ?? []].flat().filter((value) => value.trim());
    if (codes.length === 0 && nonBlank.length > 0) {
      throw ctx.fail(
        'invalid_country_code',
        `countries ${nonBlank.map((value) => `"${value}"`).join(', ')} names no country code, only separators (commas, semicolons, or pipes).`,
        {
          recovery: {
            hint: 'List at least one ISO3, ISO2, or World Bank regional code, or omit countries to search every country.',
          },
          invalidCodes: nonBlank,
        },
      );
    }
    const malformedCodes = codes.filter((code) => !COUNTRY_CODE.test(code));
    if (malformedCodes.length > 0) {
      throw ctx.fail(
        'invalid_country_code',
        `Country code(s) "${malformedCodes.join(', ')}" must be two or three letters or digits: an economy's ISO3 or ISO2 code (BRA, BR) or a World Bank regional code for a multi-country operation (3W, 4E).`,
        { invalidCodes: malformedCodes },
      );
    }
    for (const [field, value] of [
      ['approved_from', approvedFrom],
      ['approved_to', approvedTo],
    ] as const) {
      if (value !== undefined && !isCalendarDate(value)) {
        throw ctx.fail(
          'invalid_date',
          `${field} "${value}" is not a real calendar date: the month must be 01–12 and the day must fall inside that month, with February 29 only in a leap year.`,
          { field, value },
        );
      }
    }
    if (approvedFrom !== undefined && approvedTo !== undefined && approvedFrom > approvedTo) {
      throw ctx.fail(
        'reversed_date_range',
        `approved_from "${approvedFrom}" is after approved_to "${approvedTo}", so no project can match the window.`,
        { approvedFrom, approvedTo },
      );
    }
    /**
     * A # is the one piece of query syntax the API does not refuse: it answers
     * HTTP 200 with rows unrelated to the search and a non-numeric total, so it
     * has to be caught here rather than classified from a status.
     */
    if (query?.includes('#')) {
      throw ctx.fail(
        'invalid_query',
        `query "${query}" contains #, which the World Bank Projects API cannot search on — it answers with rows unrelated to the query rather than an error.`,
        { retryable: false },
      );
    }

    /**
     * A three-character code resolves through the World Bank country index to
     * the economy's ISO2 code. The index is read only when such a code is
     * present, so a search already in two-character codes never depends on the
     * Indicators API. A WDI aggregate resolves too, but the portfolio lists
     * operations by economy — the ISO2 codes of WLD, EAP, ECA, and SAS (1W, 4E,
     * 7E, 8S) are regional codes that select multi-country operations only, 18
     * for 8S against 2,371 for the South Asia region — so it is rejected rather
     * than mapped. An index that fails to load is reported as the upstream
     * failure it is, naming the listing, and one still loading when the call
     * deadline passes as the timeout it is; a cancellation of this call is the
     * caller's and propagates untouched.
     */
    const lookups = await Promise.all(
      codes.map((code) =>
        code.length === 3 ? getWorldBankApiService().lookupCountry(code, call) : undefined,
      ),
    ).catch((err: unknown) => {
      if (ctx.signal.aborted) throw err;
      if (isCallDeadlineExceeded(err)) {
        const hint = (err.data?.recovery as { hint?: string } | undefined)?.hint;
        throw ctx.fail(
          'upstream_timeout',
          `The World Bank Indicators API country listing, which resolves an ISO3 code to the code the portfolio keys on, did not load within the call's ${CALL_DEADLINE_MS / 1000} s deadline.`,
          {
            ...err.data,
            recovery: {
              hint: `${hint ? `${hint} ` : ''}Passing each economy by its ISO2 code needs no country-listing lookup.`,
            },
          },
          { cause: err },
        );
      }
      throw ctx.fail(
        'upstream_unavailable',
        'The World Bank Indicators API country listing, which resolves an ISO3 code to the code the portfolio keys on, could not be loaded.',
        {
          ...(err instanceof McpError &&
            err.data?.status !== undefined && { status: err.data.status }),
          recovery: {
            hint: 'Retry the same search once; if it keeps failing, pass each economy by its ISO2 code, which needs no country-listing lookup.',
          },
        },
        { cause: err },
      );
    });
    const unknownCodes = codes.filter((code, index) => code.length === 3 && !lookups[index]);
    const aggregateCodes = codes.filter((_code, index) => lookups[index]?.isAggregate);
    if (unknownCodes.length > 0 || aggregateCodes.length > 0) {
      const causes = [
        ...(unknownCodes.length > 0
          ? [
              `No economy in the World Bank country index has the code(s) "${unknownCodes.join(', ')}".`,
            ]
          : []),
        ...(aggregateCodes.length > 0
          ? [
              `"${aggregateCodes.join(', ')}" ${aggregateCodes.length === 1 ? 'is a WDI aggregate, not an economy' : 'are WDI aggregates, not economies'}: the lending portfolio lists operations by economy, with a regional code only for multi-country operations.`,
            ]
          : []),
      ];
      throw ctx.fail('invalid_country_code', causes.join(' '), {
        invalidCodes: [...unknownCodes, ...aggregateCodes],
      });
    }
    /** Each code as the portfolio keys it: ISO3 resolved to ISO2, then the legacy table. */
    const countryCodes = [
      ...new Set(
        codes.map((code, index) => toPortfolioCode((lookups[index]?.iso2 ?? code).toUpperCase())),
      ),
    ];

    ctx.log.info('Searching World Bank projects', {
      query,
      countries: countryCodes,
      statuses,
      regions,
      financialTypes,
      page: input.page,
    });

    const pageSize = resolvePerPage(
      { tool: 'worldbank_search_projects', cap: MAX_PROJECTS_PER_PAGE, perPage: input.per_page },
      ctx,
    );
    let result: Awaited<ReturnType<ReturnType<typeof getProjectsService>['searchProjects']>>;
    try {
      result = await getProjectsService().searchProjects(
        {
          ...(query !== undefined && { query }),
          countryCodes,
          statuses: [...statuses],
          regions: [...regions],
          ...(sectors.length > 0 && { sectors }),
          ...(themes.length > 0 && { themes }),
          financialTypes: [...financialTypes],
          ...(approvedFrom !== undefined && { approvedFrom }),
          ...(approvedTo !== undefined && { approvedTo }),
          includeAbstract: input.include_abstract,
          includeThemes: input.include_themes,
          page: input.page,
          perPage: pageSize.served,
        },
        call,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const reason = err.data?.reason;
        if (reason === 'page_out_of_range') {
          throw ctx.fail('page_out_of_range', err.message, {
            ...err.data,
          });
        }
        if (reason === 'invalid_query') {
          throw ctx.fail('invalid_query', err.message, {
            ...err.data,
          });
        }
        if (reason === 'upstream_unavailable') {
          throw ctx.fail('upstream_unavailable', err.message, {
            ...err.data,
          });
        }
      }
      throw err;
    }

    ctx.enrich({
      appliedFilters: {
        ...(query !== undefined && { query }),
        ...(countryCodes.length > 0 && { countries: countryCodes.join(',') }),
        ...(statuses.length > 0 && { status: statuses.join(',') }),
        ...(regions.length > 0 && { region: regions.join(',') }),
        ...(sectors.length > 0 && { sector: sectors }),
        ...(themes.length > 0 && { theme: themes }),
        ...(financialTypes.length > 0 && { financialType: financialTypes.join(',') }),
        ...(approvedFrom !== undefined && { approvedFrom }),
        ...(approvedTo !== undefined && { approvedTo }),
        includeAbstract: input.include_abstract,
        includeThemes: input.include_themes,
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < pageSize.requested && { requestedPerPage: pageSize.requested }),
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    const notices: string[] = [];
    if (result.total === 0) {
      // How to check each name filter in force; both match only names the rows list.
      const nameAdvice = [
        ...(sectors.length > 0
          ? [
              ' The sector filter matches the sub-sector names rows list in sectors[].name exactly, in bare and FY17 - spellings, not the majorSectors names. Check each name against sectors[].name on a search without the filter, or remove the sector filter and retry.',
            ]
          : []),
        ...(themes.length > 0
          ? [
              ' The theme filter matches the names rows list in themes[].name exactly, case included, in bare and FY17 - spellings, and the two taxonomies spell some themes differently. Check each name against themes[].name on a search without the filter and with include_themes, or remove the theme filter and retry.',
            ]
          : []),
      ].join('');
      /**
       * An exact-match filter that matches nothing is a plain zero-hit upstream,
       * so an empty result has to say which filter emptied it. The enum-backed
       * filters cannot hold an unknown value, which leaves the country codes —
       * hence the probe. A null count means there was nothing to probe, or the
       * probe failed; either way the generic branch claims nothing about them.
       */
      const codeList = countryCodes.join(', ');
      const otherFilters = [
        ...(query === undefined ? [] : ['query']),
        ...(statuses.length > 0 ? ['status'] : []),
        ...(regions.length > 0 ? ['region'] : []),
        ...(sectors.length > 0 ? ['sector'] : []),
        ...(themes.length > 0 ? ['theme'] : []),
        ...(financialTypes.length > 0 ? ['financial_type'] : []),
        ...(approvedFrom === undefined ? [] : ['approved_from']),
        ...(approvedTo === undefined ? [] : ['approved_to']),
      ];

      if (result.countryOnlyTotal === 0) {
        notices.push(
          `No project carries country code(s) ${codeList}, with every other filter removed: either the portfolio uses no such code, or that economy has no World Bank lending history. Economies are searched by ISO2, an ISO3 code resolved to it, and multi-country operations by a regional code such as 3W.${nameAdvice}`,
        );
      } else if (result.countryOnlyTotal !== null) {
        /**
         * The probe asks the codes as one OR-set, so a positive count proves the
         * set matches, not that each code does. With more than one in force, say
         * so rather than letting the agent read it as a clean bill for all of them.
         */
        const perCodeCaveat =
          countryCodes.length > 1
            ? ' That count is for the codes combined, so one of them may still be unused by the portfolio — re-run with a single code to check it on its own.'
            : '';
        notices.push(
          `No project matches every filter at once. Country code(s) ${codeList} match ${result.countryOnlyTotal} projects with every other filter removed, so ${otherFilters.join(', ')} narrowed the result to nothing — drop or widen ${otherFilters.length === 1 ? 'it' : 'one of them'} and retry.${perCodeCaveat}${nameAdvice}`,
        );
      } else {
        // No probe count to lean on, so name every filter in force, countries included.
        const applied = [...(countryCodes.length > 0 ? ['countries'] : []), ...otherFilters];
        notices.push(
          `No project matches this search. Filters combine by AND and match exactly${applied.length > 0 ? ` — ${applied.join(', ')} ${applied.length === 1 ? 'was' : 'were'} applied` : ''}. Widen the date window, add statuses, or drop words from the query, which requires every word to appear.${nameAdvice}`,
        );
      }
    } else if (result.projects.length === 0) {
      notices.push(
        pagePastEndNotice({
          noun: ['project', 'projects'],
          page: result.page,
          pages: result.pages,
          perPage: result.perPage,
          total: result.total,
        }),
      );
    }
    const reduced = pageSizeReducedNotice({
      requested: pageSize.requested,
      served: result.perPage,
      page: result.page,
      pages: result.pages,
    });
    if (reduced) notices.push(reduced);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { projects: result.projects };
  },

  format: (result) => {
    if (result.projects.length === 0) {
      return [{ type: 'text', text: '# World Bank Projects\n\nNo projects returned.' }];
    }

    const lines: string[] = ['# World Bank Projects'];
    const amount = (value: number | null) =>
      value === null ? 'null' : value.toLocaleString('en-US');

    /**
     * Preserve every component's identity, including nulls, zeros, and a sole
     * component equal to the total, on the rendered surface as well.
     */
    const breakdown = (project: (typeof result.projects)[number]) => {
      const parts = Object.entries({
        ibrdCommitment: project.ibrdCommitment,
        idaCommitment: project.idaCommitment,
        grantAmount: project.grantAmount,
      });
      return ` (${parts.map(([field, value]) => `${field} ${amount(value)}`).join(' · ')})`;
    };

    /** `name (code · majorSector · share)`; sector names carry commas, so entries join with `; `. */
    const sector = (entry: (typeof result.projects)[number]['sectors'][number]) =>
      `${escapeMarkdownInline(entry.name)} (${escapeMarkdownInline(entry.code)} · ${escapeMarkdownInline(entry.majorSector)} · ${entry.percent === null ? 'percent null' : `${entry.percent}%`})`;

    /** `name (code · parent name · share)`, nulls spelled out; theme names carry commas too. */
    const theme = (entry: NonNullable<(typeof result.projects)[number]['themes']>[number]) =>
      `${escapeMarkdownInline(entry.name)} (${escapeMarkdownInline(entry.code)} · parent ${entry.parent === null ? 'null' : escapeMarkdownInline(entry.parent)} · ${entry.percent === null ? 'percent null' : `${entry.percent}%`})`;

    /**
     * A row with no objective or abstract gets no line for it, nor a row whose
     * themes were not requested: format() sees only the rows, and the
     * applied-filters trailer's include_abstract and include_themes say whether
     * either was requested at all. Requested themes a project does not publish
     * render as none.
     */
    for (const project of result.projects) {
      lines.push(`\n${escapeMarkdownInline(project.name)} (${escapeMarkdownInline(project.id)})`);
      if (project.objective !== null)
        lines.push(`- **objective:** ${escapeMarkdownInline(project.objective)}`);
      lines.push(
        `- **status:** ${escapeMarkdownInline(project.status || 'unknown')} | **countryName:** ${escapeMarkdownInline(project.countryName)} | **countryCodes:** ${project.countryCodes.map(escapeMarkdownInline).join(', ') || 'none'} | **regionName:** ${escapeMarkdownInline(project.regionName)}`,
        `- **boardApprovalDate:** ${escapeMarkdownInline(String(project.boardApprovalDate))} | **closingDate:** ${escapeMarkdownInline(String(project.closingDate))}`,
        `- **totalCommitment:** ${amount(project.totalCommitment)}${project.totalCommitment === null ? '' : ' USD'}${breakdown(project)} | **financialTypes:** ${project.financialTypes.map(escapeMarkdownInline).join(', ') || 'none'}`,
        // Major-sector names carry commas too (Agriculture, Fishing and Forestry).
        `- **majorSectors:** ${project.majorSectors.map(escapeMarkdownInline).join('; ') || 'none'}`,
        `- **sectors:** ${project.sectors.map(sector).join('; ') || 'none'}`,
      );
      if (project.themes !== null)
        lines.push(`- **themes:** ${project.themes.map(theme).join('; ') || 'none'}`);
      lines.push(`- **url:** ${markdownLink(project.url, project.url)}`);
      if (project.abstract !== null)
        lines.push(`- **abstract:** ${escapeMarkdownInline(project.abstract)}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
