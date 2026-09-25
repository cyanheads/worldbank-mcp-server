/**
 * @fileoverview Search the World Bank lending portfolio — active, closed,
 * dropped, and pipeline operations — by free text, country, region, status,
 * financing window, and board approval date.
 * @module mcp-server/tools/definitions/worldbank-search-projects.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { toPortfolioCode } from '@/services/projects/portfolio-country-codes.js';
import { getProjectsService } from '@/services/projects/projects-service.js';
import {
  MAX_ABSTRACT_CHARS,
  MAX_PROJECTS_PER_PAGE,
  MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT,
  RESPONSE_BUDGET_KB,
  shorten,
} from '@/services/response-budget.js';
import { splitCountryCodes } from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

/**
 * The Projects API keys countries on a two-character code — ISO2 for an
 * individual economy (a legacy code for four of them), and a World Bank regional
 * code such as `3A` for a multi-country operation. Every other tool on this
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
 * lending regions rather than the WDI aggregate codes the other tools use —
 * "Africa" and "Other" are legacy buckets on older operations.
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
    'Search the World Bank lending portfolio — the individual loans, credits, and grants the Bank finances — by free text, country, region, status, financing window (IBRD, IDA, Grants, Other), and board approval date. Returns the project ID, name, borrowing country, region, status, board approval and closing dates, the commitment amount in USD with its IBRD, IDA, and grant parts, financing windows, major sectors, and a link to the project page. This is the operations catalogue, not the statistics catalogue: use it for "what is the World Bank funding in Kenya", "which climate adaptation projects are active", or "how much was committed to education in South Asia since 2020". For development statistics and time series, use worldbank_search_indicators and worldbank_get_data instead. Countries take the ISO3 or ISO2 codes the other tools take (BRA or BR), and multi-country operations carry a World Bank regional code such as 3A; WDI aggregates such as SSF or WLD are rejected, since the portfolio lists operations by economy — use region for those. Every filter is an exact match upstream and combines with the others by AND, so a narrow search can legitimately return nothing; when it does, the response says whether the country codes matched anything on their own.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search across project names, abstracts, and objectives. Every word must appear, so extra words narrow the result. A balanced quoted phrase and AND or OR between words parse; brackets, braces, an unmatched double quote, a slash between words, a trailing backslash, an AND or OR at either end, a trailing NOT, and # are not. Omit to browse the portfolio by filter alone. Results come newest board approval first either way.',
      ),
    countries: z
      .union([
        z
          .string()
          .describe(
            'A single country code, or a list of them separated by commas, semicolons, or pipes.',
          ),
        z
          .array(z.string().describe('An ISO3, ISO2, or World Bank regional code.'))
          .describe(
            'An array of country codes; an element holding several codes separated by commas, semicolons, or pipes is split too.',
          ),
      ])
      .optional()
      .describe(
        'Borrowing countries: an economy by ISO3 or ISO2 code (BRA or BR), or a World Bank regional code for a multi-country operation (3A for Africa, 4E for East Asia and Pacific). Several codes — an array, or one string separated by commas, semicolons, or pipes — are combined as OR: a project matching any of them is returned. A value made only of separators is rejected rather than read as every country. Yemen, DR Congo, West Bank and Gaza, and Timor-Leste are searched under the legacy codes the portfolio files them by (RY, ZR, GZ, TP), which are also accepted as sent. A WDI aggregate (SSF, WLD, SAS) is rejected; use region for a regional search. Omit for every country.',
      ),
    status: z
      .array(z.enum(PROJECT_STATUSES))
      .optional()
      .describe(
        'Lifecycle stages to include, combined as OR. "Active" is under implementation, "Pipeline" is approved but not yet effective, "Closed" has finished disbursing, and "Dropped" was abandoned before approval. Most of the portfolio is closed, so omitting this returns mostly historical operations.',
      ),
    region: z
      .array(z.enum(PROJECT_REGIONS))
      .optional()
      .describe(
        'World Bank operational regions to include, combined as OR. These are the lending regions the portfolio is organized by, not the WDI aggregate codes worldbank_get_data accepts.',
      ),
    financial_type: z
      .array(z.enum(FINANCING_WINDOWS))
      .optional()
      .describe(
        `Financing windows to include, combined as OR: a project matches when its financialTypes holds any of them. ${FINANCING_WINDOWS.join(', ')} are the complete set, case-sensitive. A project that publishes no financing window — 36% of the portfolio, older and dropped operations mostly — never matches. The Grants window says how an operation is financed; it is not the grantAmount figure.`,
      ),
    approved_from: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(CALENDAR_DATE, 'approved_from must be a calendar date as YYYY-MM-DD.')
          .describe('Earliest board approval date to include.'),
      ])
      .optional()
      .describe(
        'Earliest board approval date, as YYYY-MM-DD and inclusive. It must be a real calendar day (2024-02-29, not 2023-02-29) and, when approved_to is also set, on or before it. Board approval is the date the Bank committed to the operation; pipeline projects carry a scheduled date in the future.',
      ),
    approved_to: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(CALENDAR_DATE, 'approved_to must be a calendar date as YYYY-MM-DD.')
          .describe('Latest board approval date to include.'),
      ])
      .optional()
      .describe(
        'Latest board approval date, as YYYY-MM-DD and inclusive. It must be a real calendar day.',
      ),
    include_abstract: z
      .boolean()
      .default(false)
      .describe(
        `Include each project's abstract. Abstracts run long — a median of roughly 1,200 characters, up to 8,000 — so a page carrying them holds at most ${MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT} projects rather than ${MAX_PROJECTS_PER_PAGE}, and an abstract longer than ${MAX_ABSTRACT_CHARS.toLocaleString('en-US')} characters (about 2% of them) is cut there and marked with …, with notice naming the projects cut and each project's url leading to the full text; leave this off while narrowing a search and turn it on once the result set is small enough to read. Projects that publish no abstract report null either way, which appliedFilters.includeAbstract distinguishes.`,
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        `Results per page (default: server default, max: 1000). One page holds at most ${MAX_PROJECTS_PER_PAGE} projects, or ${MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT} with include_abstract, which keeps a response within about ${RESPONSE_BUDGET_KB} KB; a larger value, the server default included, is reduced to that cap and echoed as appliedFilters.perPage, and totalPages is counted at the reduced size; notice discloses the reduction whenever the result runs past one page.`,
      ),
  }),
  output: z.object({
    projects: z
      .array(
        z
          .object({
            id: z.string().describe('World Bank project ID, e.g. P513206.'),
            name: z.string().describe('Project name.'),
            status: z.string().describe('Lifecycle stage: Active, Closed, Dropped, or Pipeline.'),
            countryCodes: z
              .array(z.string())
              .describe(
                "Two-character code of the borrowing country — the economy's ISO2 code, which chains into the other tools (YE for Yemen, though the portfolio files it under RY), or a World Bank regional code such as 3A for a multi-country operation. Upstream publishes it as a list, though every project in the portfolio carries exactly one.",
              ),
            countryName: z.string().describe('Borrowing country, as the portfolio names it.'),
            regionName: z.string().describe('World Bank operational region.'),
            boardApprovalDate: z
              .string()
              .nullable()
              .describe(
                'Date the Board approved the operation, as YYYY-MM-DD. A future date belongs to a pipeline project with a scheduled board date.',
              ),
            closingDate: z
              .string()
              .nullable()
              .describe(
                'Scheduled or actual closing date, as YYYY-MM-DD. Null on roughly 44% of the portfolio, which publishes none — almost all dropped operations among them.',
              ),
            totalCommitment: z
              .number()
              .nullable()
              .describe(
                "Commitment amount in USD as the project page reports it: ibrdCommitment + idaCommitment + grantAmount. Null on 35.8% of the portfolio (28,153 projects, 2026-09-25), which publishes no amount — dropped and older operations mostly — and that is not the same as a commitment of zero. It can include other agencies' co-financing through grantAmount; World Bank lending alone is ibrdCommitment + idaCommitment.",
              ),
            ibrdCommitment: z
              .number()
              .nullable()
              .describe(
                'IBRD commitment in USD. Null when the project publishes no IBRD or IDA amount, as on a grant-only operation — not a commitment of zero.',
              ),
            idaCommitment: z
              .number()
              .nullable()
              .describe(
                'IDA commitment in USD, IDA grants included. Null when the project publishes no IBRD or IDA amount — not a commitment of zero.',
              ),
            grantAmount: z
              .number()
              .nullable()
              .describe(
                "Grant amount in USD: trust-fund grants and, on some operations, other agencies' co-financing recorded on the project, so it is not all World Bank money. Counted in totalCommitment. It is its own figure, unrelated to which financialTypes the project lists.",
              ),
            financialTypes: z
              .array(z.string())
              .describe(
                `Financing windows behind the operation: ${FINANCING_WINDOWS.join(', ')} — the values financial_type filters on. A blended operation lists more than one; empty where the project publishes none.`,
              ),
            majorSectors: z
              .array(z.string())
              .describe(
                'Major sectors the operation is classified under, e.g. Health, Education, Transportation. Empty where the portfolio publishes no sector classification.',
              ),
            abstract: z
              .string()
              .nullable()
              .describe(
                `Project abstract, cut at ${MAX_ABSTRACT_CHARS.toLocaleString('en-US')} characters and marked with … when longer. Null when include_abstract was not requested and when the project publishes none — appliedFilters.includeAbstract separates the two.`,
              ),
            url: z.string().describe('Project page on projects.worldbank.org.'),
          })
          .describe('One World Bank lending operation.'),
      )
      .describe(
        'Projects on this page, newest board approval date first with or without query, and projects with no board date last. Pagination walks the same order.',
      ),
  }),

  enrichment: {
    appliedFilters: z
      .object({
        query: z.string().optional().describe('Free-text query applied, omitted when none.'),
        countries: z
          .string()
          .optional()
          .describe(
            'Country codes as sent upstream — each resolved to the code the portfolio keys on (BRA → BR, YEM or YE → RY), uppercased, deduplicated, and comma-joined here for readability, though the API itself takes them caret-separated. Omitted when no country filter was applied.',
          ),
        status: z.string().optional().describe('Statuses applied, omitted when none.'),
        region: z.string().optional().describe('Regions applied, omitted when none.'),
        financialType: z
          .string()
          .optional()
          .describe('Financing windows applied, comma-joined, omitted when none.'),
        approvedFrom: z
          .string()
          .optional()
          .describe('Earliest board approval date applied, omitted when none.'),
        approvedTo: z
          .string()
          .optional()
          .describe('Latest board approval date applied, omitted when none.'),
        includeAbstract: z
          .boolean()
          .describe(
            'Whether abstracts were requested, including the server default of false. A null abstract means "not requested" when this is false and "none published" when it is true.',
          ),
        page: z.number().describe('Page number requested.'),
        perPage: z
          .number()
          .describe(
            'Results per page actually served — the requested size or server default, reduced to the page cap when larger. totalPages is counted at this size.',
          ),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, requested or server default, present only when it exceeded the page cap and perPage was reduced.',
          ),
      })
      .describe(
        'The effective search sent upstream — confirms country-code normalization and which filters were in force for these results.',
      ),
    totalCount: z.number().describe('Total projects matching the search, before pagination.'),
    currentPage: z
      .number()
      .describe('Page number requested — past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total number of pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Context for an empty result set — including whether the country filter matched anything on its own — for a page past the end of the results, for a page size reduced to the page cap, or naming the projects whose abstracts were cut.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      /**
       * A per-field `render` replaces the whole trailer line, `label` included,
       * so the heading has to be part of what it returns.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          ...(filters.query === undefined ? [] : [`query=${filters.query}`]),
          ...(filters.countries === undefined ? [] : [`countries=${filters.countries}`]),
          ...(filters.status === undefined ? [] : [`status=${filters.status}`]),
          ...(filters.region === undefined ? [] : [`region=${filters.region}`]),
          ...(filters.financialType === undefined
            ? []
            : [`financial_type=${filters.financialType}`]),
          ...(filters.approvedFrom === undefined ? [] : [`approved_from=${filters.approvedFrom}`]),
          ...(filters.approvedTo === undefined ? [] : [`approved_to=${filters.approvedTo}`]),
          `include_abstract=${filters.includeAbstract}`,
          `page=${filters.page}`,
          `per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'invalid_country_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A countries entry resolves to no economy: it is not two or three letters or digits, no economy in the World Bank country index has that three-character code, or it is a WDI aggregate such as SSF or WLD, which the portfolio lists no operations under. Also when countries holds only separators and so names no code at all.',
      recovery:
        'Pass each economy by an ISO3 or ISO2 code worldbank_list_countries lists, or a World Bank regional code such as 3A for multi-country operations. For every project in a region, drop the aggregate code and set the region filter instead.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'approved_from or approved_to is shaped YYYY-MM-DD but names no real day — a month outside 01–12, or a day outside its month.',
      recovery:
        'Correct the date to a real calendar day as YYYY-MM-DD, such as 2024-02-29 or 2023-02-28, and retry.',
    },
    {
      reason: 'reversed_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'approved_from falls after approved_to, an interval no project can match.',
      recovery:
        'Swap the two dates so approved_from is on or before approved_to, or drop one of them for an open-ended window.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The Projects API could not parse query and answered HTTP 400, or query contains #, which the API answers with rows unrelated to the search.',
      recovery:
        'Remove from query any brackets or braces, an unmatched double quote, a slash between words, a trailing backslash, a #, an AND or OR at either end, and a trailing NOT, then search again. Plain words, a balanced quoted phrase, and AND or OR between words all parse.',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested page starts past the 100,000-result offset the Projects API serves.',
      recovery:
        'Lower the page number, or add a filter so the matches fit inside the range the API pages through.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Projects API answered with a non-success status other than a query it could not parse — a rate limit, a timeout, a 5xx — or with an HTML error page, or the World Bank Indicators API country listing that resolves an ISO3 code could not be loaded.',
      recovery:
        'Retry the same search once; if it keeps failing, the Projects API is down or has moved, and no change to the search will help.',
    },
  ],

  async handler(input, ctx) {
    const codes = input.countries === undefined ? [] : splitCountryCodes(input.countries);
    const statuses = input.status ?? [];
    const regions = input.region ?? [];
    const financialTypes = input.financial_type ?? [];
    const query = input.query?.trim() ? input.query.trim() : undefined;
    const approvedFrom = input.approved_from || undefined;
    const approvedTo = input.approved_to || undefined;
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;

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
        `Country code(s) "${malformedCodes.join(', ')}" must be two or three letters or digits: an economy's ISO3 or ISO2 code (BRA, BR) or a World Bank regional code for a multi-country operation (3A, 4E).`,
        { ...ctx.recoveryFor('invalid_country_code'), invalidCodes: malformedCodes },
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
          { ...ctx.recoveryFor('invalid_date'), field, value },
        );
      }
    }
    if (approvedFrom !== undefined && approvedTo !== undefined && approvedFrom > approvedTo) {
      throw ctx.fail(
        'reversed_date_range',
        `approved_from "${approvedFrom}" is after approved_to "${approvedTo}", so no project can match the window.`,
        { ...ctx.recoveryFor('reversed_date_range'), approvedFrom, approvedTo },
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
        { ...ctx.recoveryFor('invalid_query'), retryable: false },
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
     * failure it is, naming the listing; a cancellation of this call is the
     * caller's and propagates untouched.
     */
    const lookups = await Promise.all(
      codes.map((code) =>
        code.length === 3 ? getWorldBankApiService().lookupCountry(code, ctx) : undefined,
      ),
    ).catch((err: unknown) => {
      if (ctx.signal.aborted) throw err;
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
        ...ctx.recoveryFor('invalid_country_code'),
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

    let result: Awaited<ReturnType<ReturnType<typeof getProjectsService>['searchProjects']>>;
    try {
      result = await getProjectsService().searchProjects(
        {
          ...(query !== undefined && { query }),
          countryCodes,
          statuses: [...statuses],
          regions: [...regions],
          financialTypes: [...financialTypes],
          ...(approvedFrom !== undefined && { approvedFrom }),
          ...(approvedTo !== undefined && { approvedTo }),
          includeAbstract: input.include_abstract,
          page: input.page,
          perPage,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const reason = err.data?.reason;
        if (reason === 'page_out_of_range') {
          throw ctx.fail('page_out_of_range', err.message, {
            ...err.data,
            ...ctx.recoveryFor('page_out_of_range'),
          });
        }
        if (reason === 'invalid_query') {
          throw ctx.fail('invalid_query', err.message, {
            ...err.data,
            ...ctx.recoveryFor('invalid_query'),
          });
        }
        if (reason === 'upstream_unavailable') {
          throw ctx.fail('upstream_unavailable', err.message, {
            ...err.data,
            ...ctx.recoveryFor('upstream_unavailable'),
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
        ...(financialTypes.length > 0 && { financialType: financialTypes.join(',') }),
        ...(approvedFrom !== undefined && { approvedFrom }),
        ...(approvedTo !== undefined && { approvedTo }),
        includeAbstract: input.include_abstract,
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < perPage && { requestedPerPage: perPage }),
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    if (result.total === 0) {
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
        ...(financialTypes.length > 0 ? ['financial_type'] : []),
        ...(approvedFrom === undefined ? [] : ['approved_from']),
        ...(approvedTo === undefined ? [] : ['approved_to']),
      ];

      if (result.countryOnlyTotal === 0) {
        ctx.enrich.notice(
          `No project carries country code(s) ${codeList}, with every other filter removed: either the portfolio uses no such code, or that economy has no World Bank lending history. Economies are searched by ISO2, an ISO3 code resolved to it, and multi-country operations by a regional code such as 3A.`,
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
        ctx.enrich.notice(
          `No project matches every filter at once. Country code(s) ${codeList} match ${result.countryOnlyTotal} projects with every other filter removed, so ${otherFilters.join(', ')} narrowed the result to nothing — drop or widen ${otherFilters.length === 1 ? 'it' : 'one of them'} and retry.${perCodeCaveat}`,
        );
      } else {
        // No probe count to lean on, so name every filter in force, countries included.
        const applied = [...(countryCodes.length > 0 ? ['countries'] : []), ...otherFilters];
        ctx.enrich.notice(
          `No project matches this search. Filters combine by AND and match exactly${applied.length > 0 ? ` — ${applied.join(', ')} ${applied.length === 1 ? 'was' : 'were'} applied` : ''}. Widen the date window, add statuses, or drop words from the query, which requires every word to appear.`,
        );
      }
    } else {
      const cut = result.projects.flatMap((project) =>
        project.abstract !== null && project.abstract.length > MAX_ABSTRACT_CHARS
          ? [project.id]
          : [],
      );
      const notices = [
        ...(result.projects.length === 0
          ? [
              pagePastEndNotice({
                noun: ['project', 'projects'],
                page: result.page,
                pages: result.pages,
                perPage: result.perPage,
                total: result.total,
              }),
            ]
          : []),
        pageSizeReducedNotice({
          requested: perPage,
          served: result.perPage,
          page: result.page,
          pages: result.pages,
          ...(input.include_abstract && {
            condition: `with include_abstract on (${MAX_PROJECTS_PER_PAGE} with include_abstract off)`,
          }),
        }),
        ...(cut.length > 0
          ? [
              cut.length === 1
                ? `The abstract of ${cut[0]} runs past ${MAX_ABSTRACT_CHARS.toLocaleString('en-US')} characters and is cut there, marked with …; the project page at url carries the full text.`
                : `The abstracts of ${new Intl.ListFormat('en', { type: 'conjunction' }).format(cut)} run past ${MAX_ABSTRACT_CHARS.toLocaleString('en-US')} characters and are cut there, marked with …; each project page at url carries the full text.`,
            ]
          : []),
      ].filter((notice) => notice !== undefined);
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    }

    /**
     * The heaviest 8-row page of whole abstracts reaches ~69 KB, and 295 of the
     * portfolio's 14,779 published abstracts run past the ceiling (2026-09-25).
     */
    return {
      projects: result.projects.map((project) =>
        project.abstract === null
          ? project
          : { ...project, abstract: shorten(project.abstract, MAX_ABSTRACT_CHARS) },
      ),
    };
  },

  format: (result) => {
    if (result.projects.length === 0) {
      return [{ type: 'text', text: '# World Bank Projects\n\nNo projects returned.' }];
    }

    const lines: string[] = ['# World Bank Projects'];
    const amount = (value: number | null) =>
      value === null ? 'null' : value.toLocaleString('en-US');

    /**
     * The breakdown shares the total's line, unbolded and in the same USD, and
     * names only the parts that add to it: a null or zero part is left out, and
     * so is a single remaining part equal to the total, which says nothing the
     * total does not. structuredContent carries every part, nulls and zeros
     * included.
     */
    const breakdown = (project: (typeof result.projects)[number]) => {
      const parts = Object.entries({
        ibrdCommitment: project.ibrdCommitment,
        idaCommitment: project.idaCommitment,
        grantAmount: project.grantAmount,
      }).filter(([, value]) => value !== null && value !== 0);
      if (parts.length === 0) return '';
      if (parts.length === 1 && parts[0]?.[1] === project.totalCommitment) return '';
      return ` (${parts.map(([field, value]) => `${field} ${amount(value)}`).join(' · ')})`;
    };

    /**
     * Six lines a project keep an 80-row page inside the response budget. A row
     * with no abstract gets no abstract line: format() sees only the rows, and
     * the applied-filters trailer's include_abstract says whether abstracts were
     * requested at all.
     */
    for (const project of result.projects) {
      lines.push(
        `\n## ${project.name} (${project.id})`,
        `- **status:** ${project.status || 'unknown'} | **countryName:** ${project.countryName} | **countryCodes:** ${project.countryCodes.join(', ') || 'none'} | **regionName:** ${project.regionName}`,
        `- **boardApprovalDate:** ${project.boardApprovalDate} | **closingDate:** ${project.closingDate}`,
        `- **totalCommitment:** ${amount(project.totalCommitment)}${project.totalCommitment === null ? '' : ' USD'}${breakdown(project)} | **financialTypes:** ${project.financialTypes.join(', ') || 'none'}`,
        `- **majorSectors:** ${project.majorSectors.join(', ') || 'none'}`,
        `- **url:** ${project.url}`,
      );
      if (project.abstract !== null) lines.push(`- **abstract:** ${project.abstract}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
