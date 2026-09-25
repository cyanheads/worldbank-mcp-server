/**
 * @fileoverview Search the World Bank lending portfolio — active, closed,
 * dropped, and pipeline operations — by free text, country, region, status, and
 * board approval date.
 * @module mcp-server/tools/definitions/worldbank-search-projects.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { getProjectsService } from '@/services/projects/projects-service.js';
import {
  MAX_PROJECTS_PER_PAGE,
  MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT,
  RESPONSE_BUDGET_KB,
} from '@/services/response-budget.js';

/**
 * Recovery for a Projects API 4xx, which the service marks not retryable. The
 * filters are validated before the request, so a refusal comes from query text
 * the API's search syntax cannot parse — `[`, `]`, `{`, `"`, `/`, `\`, and a
 * trailing AND, OR, or NOT each answer HTTP 400 — and the same call is refused
 * every time.
 */
const REFUSED_SEARCH_HINT =
  'The Projects API refuses this search as sent, every time it is sent. Remove brackets, braces, double quotes, slashes, backslashes, and a trailing AND, OR, or NOT from query, then search again.';

/** Split a caller-supplied country string on either separator this server's tools use. */
function splitCodes(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

/** Collect country codes from either accepted input shape. */
function collectCodes(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.flatMap(splitCodes) : splitCodes(value);
}

/**
 * The Projects API keys countries on a two-character code — ISO2 for an
 * individual economy, and a World Bank regional code such as `3A` for a
 * multi-country operation. Every other tool on this server takes ISO3, and an
 * ISO3 code here is well-formed enough to reach upstream and comes back as a
 * plain zero-hit rather than an error, so the length is enforced before the
 * request. Digits are accepted because the regional codes carry them: 34 of the
 * 218 codes the portfolio uses are not two letters.
 */
const COUNTRY_CODE = /^[A-Za-z0-9]{2}$/;

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
    'Search the World Bank lending portfolio — the individual loans, credits, and grants the Bank finances — by free text, country, region, status, and board approval date. Returns the project ID, name, borrowing country, region, status, board approval and closing dates, total commitment in USD, financing instrument, major sectors, and a link to the project page. This is the operations catalogue, not the statistics catalogue: use it for "what is the World Bank funding in Kenya", "which climate adaptation projects are active", or "how much was committed to education in South Asia since 2020". For development statistics and time series, use worldbank_search_indicators and worldbank_get_data instead. Countries are identified by ISO2 code here (BR, IN, ZA), which is the one place this server departs from the ISO3 codes its other tools take — worldbank_get_country reports a country\'s iso2 field for either form, and multi-country operations carry a World Bank regional code such as 3A instead. Every filter is an exact match upstream and combines with the others by AND, so a narrow search can legitimately return nothing; when it does, the response says whether the country codes matched anything on their own.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search across project names, abstracts, and objectives. Every word must appear, so extra words narrow the result. Omit to browse the portfolio by filter alone, newest board approvals first.',
      ),
    countries: z
      .union([
        z
          .string()
          .describe(
            'A single two-character code, or a comma- or semicolon-separated list of them.',
          ),
        z
          .array(z.string().describe('A two-character country code.'))
          .describe('An array of two-character codes.'),
      ])
      .optional()
      .describe(
        'Borrowing countries, by the two-character code this API keys on: ISO2 for an economy (BR), or a World Bank regional code for a multi-country operation (3A for Africa, 4E for East Asia and Pacific). Several codes are combined as OR — a project matching any of them is returned. Omit for every country.',
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
        `Include each project's abstract. Abstracts run long — a median of roughly 1,200 characters, up to 8,000 — so a page carrying them holds at most ${MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT} projects rather than ${MAX_PROJECTS_PER_PAGE}, with every abstract returned whole; leave this off while narrowing a search and turn it on once the result set is small enough to read. Projects that publish no abstract report null either way, which appliedFilters.includeAbstract distinguishes.`,
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        `Results per page (default: server default, max: 1000). One page holds at most ${MAX_PROJECTS_PER_PAGE} projects, or ${MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT} with include_abstract, which keeps a response within about ${RESPONSE_BUDGET_KB} KB; a larger value, the server default included, is reduced to that cap, disclosed in notice, and echoed as appliedFilters.perPage, and totalPages is counted at the reduced size.`,
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
                'Two-character code of the borrowing country — ISO2 for an economy, a World Bank regional code such as 3A for a multi-country operation. Upstream publishes it as a list, though every project in the portfolio carries exactly one.',
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
                'Total World Bank commitment in USD. Null on just over half the portfolio, which publishes no amount — dropped and older operations mostly — and that is not the same as a commitment of zero.',
              ),
            financialTypes: z
              .array(z.string())
              .describe(
                'Financing windows behind the operation: IBRD, IDA, Grants, or Other. A blended operation lists more than one.',
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
                'Project abstract. Null when include_abstract was not requested and when the project publishes none — appliedFilters.includeAbstract separates the two.',
              ),
            url: z.string().describe('Project page on projects.worldbank.org.'),
          })
          .describe('One World Bank lending operation.'),
      )
      .describe(
        'Projects on this page, newest board approval date first — the order the API returns and the order pagination walks.',
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
            'Country codes as sent upstream — uppercased and comma-joined here for readability, though the API itself takes them caret-separated. Omitted when no country filter was applied.',
          ),
        status: z.string().optional().describe('Statuses applied, omitted when none.'),
        region: z.string().optional().describe('Regions applied, omitted when none.'),
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
        'Context for an empty result set — including whether the country filter matched anything on its own — for a page past the end of the results, or for a page size reduced to the page cap.',
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
      when: 'A countries entry is not a two-character code — most often an ISO3 code such as BRA, which the Projects API does not key on.',
      recovery:
        'Replace each code with its two-character ISO2 form, BR rather than BRA; worldbank_get_country resolves either form and reports the iso2 field.',
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
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested page starts past the 100,000-result offset the Projects API serves.',
      recovery:
        'Lower the page number, or add a filter so the matches fit inside the range the API pages through.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Projects API answered with a non-success status or an HTML error page: a 4xx when it refuses the query text, a 5xx or an error page when it cannot serve the search.',
      recovery:
        'Retry the same search once; if it keeps failing, the Projects API is down or has moved, and no change to the search will help.',
    },
  ],

  async handler(input, ctx) {
    const codes = collectCodes(input.countries);
    const statuses = input.status ?? [];
    const regions = input.region ?? [];
    const query = input.query?.trim() ? input.query.trim() : undefined;
    const approvedFrom = input.approved_from || undefined;
    const approvedTo = input.approved_to || undefined;
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;

    /**
     * Checked here rather than on the schema so each failure carries a reason and
     * a recovery hint; a schema refinement would reject with neither.
     */
    const invalidCodes = codes.filter((code) => !COUNTRY_CODE.test(code));
    if (invalidCodes.length > 0) {
      throw ctx.fail(
        'invalid_country_code',
        `Country code(s) "${invalidCodes.join(', ')}" must be two characters — ISO2 for an economy (BR, IN, ZA) or a World Bank regional code for a multi-country operation (3A, 4E). The World Bank Projects API keys on ISO2, unlike the ISO3 codes worldbank_get_poverty and worldbank_get_data accept.`,
        { ...ctx.recoveryFor('invalid_country_code'), invalidCodes },
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

    ctx.log.info('Searching World Bank projects', {
      query,
      countries: codes,
      statuses,
      regions,
      page: input.page,
    });

    let result: Awaited<ReturnType<ReturnType<typeof getProjectsService>['searchProjects']>>;
    try {
      result = await getProjectsService().searchProjects(
        {
          ...(query !== undefined && { query }),
          countryCodes: codes,
          statuses: [...statuses],
          regions: [...regions],
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
        if (reason === 'upstream_unavailable') {
          throw ctx.fail('upstream_unavailable', err.message, {
            ...err.data,
            recovery:
              Number(err.data?.status) < 500
                ? { hint: REFUSED_SEARCH_HINT }
                : ctx.recoveryFor('upstream_unavailable').recovery,
          });
        }
      }
      throw err;
    }

    ctx.enrich({
      appliedFilters: {
        ...(query !== undefined && { query }),
        ...(codes.length > 0 && {
          countries: codes.map((code) => code.toUpperCase()).join(','),
        }),
        ...(statuses.length > 0 && { status: statuses.join(',') }),
        ...(regions.length > 0 && { region: regions.join(',') }),
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
      const codeList = codes.map((code) => code.toUpperCase()).join(', ');
      const otherFilters = [
        ...(query === undefined ? [] : ['query']),
        ...(statuses.length > 0 ? ['status'] : []),
        ...(regions.length > 0 ? ['region'] : []),
        ...(approvedFrom === undefined ? [] : ['approved_from']),
        ...(approvedTo === undefined ? [] : ['approved_to']),
      ];

      if (result.countryOnlyTotal === 0) {
        ctx.enrich.notice(
          `No project carries country code(s) ${codeList}, with every other filter removed. Either the code is not one the portfolio uses — it must be two characters, ISO2 for an economy so BR rather than BRA, and worldbank_get_country reports the iso2 field for a country — or that economy has no World Bank lending history.`,
        );
      } else if (result.countryOnlyTotal !== null) {
        /**
         * The probe asks the codes as one OR-set, so a positive count proves the
         * set matches, not that each code does. With more than one in force, say
         * so rather than letting the agent read it as a clean bill for all of them.
         */
        const perCodeCaveat =
          codes.length > 1
            ? ' That count is for the codes combined, so one of them may still be unused by the portfolio — re-run with a single code to check it on its own.'
            : '';
        ctx.enrich.notice(
          `No project matches every filter at once. Country code(s) ${codeList} match ${result.countryOnlyTotal} projects with every other filter removed, so ${otherFilters.join(', ')} narrowed the result to nothing — drop or widen ${otherFilters.length === 1 ? 'it' : 'one of them'} and retry.${perCodeCaveat}`,
        );
      } else {
        // No probe count to lean on, so name every filter in force, countries included.
        const applied = [...(codes.length > 0 ? ['countries'] : []), ...otherFilters];
        ctx.enrich.notice(
          `No project matches this search. Filters combine by AND and match exactly${applied.length > 0 ? ` — ${applied.join(', ')} ${applied.length === 1 ? 'was' : 'were'} applied` : ''}. Widen the date window, add statuses, or drop words from the query, which requires every word to appear.`,
        );
      }
    } else {
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
        ...(result.perPage < perPage
          ? [
              `per_page=${perPage} was reduced to ${result.perPage}, the most one page holds${input.include_abstract ? ` with include_abstract on (${MAX_PROJECTS_PER_PAGE} with include_abstract off)` : ''}, to keep this response within about ${RESPONSE_BUDGET_KB} KB. totalPages counts pages of ${result.perPage}${result.page < result.pages ? `, so page ${result.page + 1} with the same filters continues where this page ends` : ''}.${input.include_abstract ? ' Abstracts are never shortened; the smaller page is how they fit.' : ''}`,
            ]
          : []),
      ];
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    }

    return { projects: result.projects };
  },

  format: (result) => {
    if (result.projects.length === 0) {
      return [{ type: 'text', text: '# World Bank Projects\n\nNo projects returned.' }];
    }

    const lines: string[] = ['# World Bank Projects'];

    for (const project of result.projects) {
      lines.push(
        `\n## ${project.name} (${project.id})`,
        `- **status:** ${project.status || 'unknown'} | **countryName:** ${project.countryName} | **countryCodes:** ${project.countryCodes.join(', ') || 'none'}`,
        `- **regionName:** ${project.regionName}`,
        `- **boardApprovalDate:** ${project.boardApprovalDate} | **closingDate:** ${project.closingDate}`,
        `- **totalCommitment:** ${project.totalCommitment === null ? 'null' : `${project.totalCommitment.toLocaleString('en-US')} USD`} | **financialTypes:** ${project.financialTypes.join(', ') || 'none'}`,
        `- **majorSectors:** ${project.majorSectors.join(', ') || 'none'}`,
        `- **url:** ${project.url}`,
        `- **abstract:** ${project.abstract ?? 'null'}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
