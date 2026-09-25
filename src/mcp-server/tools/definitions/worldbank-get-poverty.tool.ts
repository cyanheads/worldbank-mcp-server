/**
 * @fileoverview Query poverty and inequality estimates from the World Bank
 * Poverty and Inequality Platform (PIP) — headcount, gap, and severity at any
 * poverty line for economies and PIP's own aggregates, alongside the Gini
 * coefficient and decile distribution.
 * @module mcp-server/tools/definitions/worldbank-get-poverty.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { getPipService } from '@/services/pip/pip-service.js';
import { MAX_ESTIMATES_PER_PAGE, RESPONSE_BUDGET_KB } from '@/services/response-budget.js';
import { COUNTRY_LIST_CONTENT, splitCountryCodes } from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

/**
 * WDI's IDA-total aggregate, by its code and its ISO2 code. It spans IDA-only
 * and blend economies, which PIP publishes only as two separate groups, so the
 * code is refused rather than answered with PIP's narrower `IDA`.
 */
const IDA_TOTAL_CODES: ReadonlySet<string> = new Set(['IDA', 'XG']);

/** `a` or `a and b`, for naming one to a handful of codes in a notice. */
function listCodes(codes: readonly string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(codes);
}

/**
 * The `invalid_parameter` recovery for a rejection whose message quotes accepted
 * values for `listed`. It points only those parameters at the message, and any
 * other rejected parameter at its own description, so the hint never refers to
 * values the message leaves out.
 */
function listedValuesHint(parameters: readonly string[], listed: readonly string[]): string {
  const unlisted = parameters.filter((parameter) => !listed.includes(parameter));
  return `Set ${listed.join(', ')} to one of the values the message lists and retry, or drop the rejected ${parameters.length > 1 ? 'parameters' : 'parameter'}.${unlisted.length > 0 ? ` Correct ${unlisted.join(', ')} to the form the parameter description gives.` : ''}`;
}

export const worldbankGetPoverty = tool('worldbank_get_poverty', {
  title: 'Get World Bank Poverty and Inequality Estimates',
  description:
    'Query poverty and inequality estimates from the World Bank Poverty and Inequality Platform (PIP) for economies and for PIP\'s own aggregates — World, World Bank regions, income groups, and lending groups. Returns the poverty headcount ratio, poverty gap, and poverty severity at any poverty line, plus mean and median welfare and population. Use it for inequality and distribution questions too — survey-based economy rows carry the Gini coefficient, mean log deviation, polarization, and the ten decile income/consumption shares, because PIP returns poverty and inequality in the same row. PIP is a separate dataset from the WDI series worldbank_get_data reads: it measures welfare in PPP dollars per person per day, at a PPP vintage ppp_version selects, and computes its aggregates at any poverty line, where worldbank_get_data carries only the published lines. Every row reports how it was produced. On an economy, estimationType "survey" rows carry the full inequality block; "interpolation", "extrapolation", and "CMD estimation" rows are gap-filled estimates for years no survey covers, and their gini, mld, polarization, and decileShares are null — a documented gap in the source data, not an error. Aggregate rows (isAggregate true) are "actual", "nowcast", or "projection", add popInPoverty, and carry no distributional block.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    countries: z
      .union([
        z
          .string()
          .regex(
            COUNTRY_LIST_CONTENT,
            'Provide at least one country code, or "all" for every economy.',
          )
          .describe(
            'A single country code, a list separated by commas, semicolons, or pipes, or "all".',
          ),
        z
          .array(z.string().describe('A country code.'))
          .min(1)
          /**
           * Checked against what the split actually yields, not against raw
           * string length: PIP reads an empty `country` as every economy, so an
           * array holding nothing but separators must not reach it.
           */
          .refine(
            (codes) => splitCountryCodes(codes).length > 0,
            'Provide at least one country code, or "all" for every economy.',
          )
          .describe(
            'An array of country codes; an element holding several codes separated by commas, semicolons, or pipes is split too.',
          ),
      ])
      .describe(
        'Country codes: a single code, an array, or one string separated by commas, semicolons, or pipes. Economies go by ISO3 (IND, USA) or ISO2 (IN, US) code, including those PIP publishes only as model estimates (AFG); "all" returns every economy. PIP\'s aggregates are served too: WLD; the World Bank regions AFE, AFW, EAS, ECS, LCN, MEA, NAC, SAS, SSF; the income groups HIC, LIC, LMIC (or LMC), UMIC (or UMC); and the lending groups IDX (IDA only), IDB or BLND (IDA blend), IBD or IBRD (IBRD only), and REST. Income groups follow the fiscal-year classification PIP\'s data release was built with — FY2026 (July 2025) for release 20260922 — applied to every year, so membership can differ from the current one worldbank_get_country reports. IDA (IDA total) is rejected because PIP computes no IDA total: ask for IDX and IDB together. Other aggregate codes (SSA, EAP, FCVY, MIC, LMY) are rejected, and welfare_type and reporting_level cannot be combined with an aggregate.',
      ),
    year: z
      .string()
      /**
       * Blank is tolerated because form-based clients submit every field; the
       * handler reads it as absent, which upstream answers with full history.
       */
      .regex(
        /^\s*(?:\d{4}|all|MRV)?\s*$/i,
        'year must be a four-digit year, "all", or "MRV" (most recent value).',
      )
      .optional()
      .describe(
        'Reporting year to return. A four-digit year (2022), "all" for the full history, or "MRV" for the most recent year. Omitted behaves as "all". MRV follows fill_gaps: with fill_gaps true each economy resolves to PIP\'s latest estimate year, and with fill_gaps false to its latest survey year; an aggregate resolves to its newest reporting year. PIP coverage starts in 1963 and ends at the last year of the data release in use; a year outside that span fails with the span named.',
      ),
    poverty_line: z
      .number()
      .min(0)
      .max(2700)
      .optional()
      .describe(
        'Poverty line in PPP dollars per person per day, at the applied PPP vintage — any threshold, not only the published ones. Omitted uses the international poverty line for that vintage, so the applied value is echoed back on every row as povertyLine rather than assumed here. The poverty line does not affect the inequality fields, which describe the whole distribution.',
      ),
    welfare_type: z
      .union([
        z.literal(''),
        z
          .enum(['income', 'consumption'])
          .describe('Restrict to surveys measuring income, or to those measuring consumption.'),
      ])
      .optional()
      .describe(
        'Restrict results to one welfare measure. Surveys measure either income or consumption and the two are not directly comparable, so a cross-country comparison is safer pinned to one. Omitted returns whichever each economy publishes, and both where an economy publishes both — thirty-five do, and those return two rows per year.',
      ),
    reporting_level: z
      .union([
        z.literal(''),
        z
          .enum(['national', 'urban', 'rural'])
          .describe('Restrict to the national, urban, or rural estimate.'),
      ])
      .optional()
      .describe(
        'Restrict results to one reporting level. Most economies publish a national figure only; ten publish a split and return an extra row per year for it, China with all three levels and the rest pairing national with either urban or rural. Every row states its own reportingLevel.',
      ),
    ppp_version: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}$/, 'ppp_version must be a four-digit PPP vintage year, e.g. "2017".')
          .describe('A PPP vintage year.'),
      ])
      .optional()
      .describe(
        'PPP vintage to express every dollar figure in — the poverty line, mean, and median — as a four-digit year ("2021", "2017"). It must be one of the vintages PIP\'s current data release is published at; any other value fails with the available vintages named. Omitted uses the newest vintage of that release. The vintage and release applied are echoed as appliedFilters.pppVersion and appliedFilters.releaseVersion.',
      ),
    fill_gaps: z
      .boolean()
      .default(true)
      .describe(
        'When true (the default), any year the surveys do not cover falls back to PIP\'s own estimate for it instead of being left out — so a single-year query still answers, and a full-history query returns a row per year rather than only the survey years. Those fallback rows carry no inequality data. Set false to return survey-derived rows only, accepting an empty result for years no survey covers and for economies PIP publishes only as model estimates. It also decides what "MRV" resolves to, and has no effect on aggregate rows.',
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        `Results per page (default: server default, max: 1000). "all" countries across "all" years runs to several thousand rows. One page holds at most ${MAX_ESTIMATES_PER_PAGE} estimates, which keeps a response within about ${RESPONSE_BUDGET_KB} KB; a larger value, the server default included, is reduced to that cap and echoed as appliedFilters.perPage, and totalPages is counted at the reduced size; notice discloses the reduction whenever the result runs past one page.`,
      ),
  }),
  output: z.object({
    estimates: z
      .array(
        z
          .object({
            countryCode: z
              .string()
              .describe(
                "ISO3 code of the economy, or the aggregate code (SSF, LIC, WLD) on an aggregate row — IDX for PIP's IDA-only group. Accepted back as countries.",
              ),
            countryName: z
              .string()
              .describe('Economy or aggregate name — "IDA only" for IDX, as WDI names it.'),
            regionCode: z
              .string()
              .nullable()
              .describe(
                'PIP region code of the economy (e.g. SAS, NAC, SSF); null on an aggregate row.',
              ),
            regionName: z
              .string()
              .nullable()
              .describe('PIP region name of the economy; null on an aggregate row.'),
            reportingYear: z.number().describe('Calendar year the estimate reports on.'),
            reportingLevel: z
              .string()
              .nullable()
              .describe(
                'Coverage of this estimate: national, urban, or rural. Null on an aggregate row.',
              ),
            welfareType: z
              .string()
              .nullable()
              .describe(
                'Whether the underlying survey measures income or consumption. The two are not directly comparable across economies. Null on an aggregate row, which spans both.',
              ),
            povertyLine: z
              .number()
              .describe(
                'Poverty line the poverty measures were computed at, in PPP dollars per person per day, as applied upstream.',
              ),
            headcount: z
              .number()
              .nullable()
              .describe(
                'Share of the population below the poverty line, as a fraction (0.0814 = 8.14%).',
              ),
            povertyGap: z
              .number()
              .nullable()
              .describe(
                'Mean shortfall below the poverty line across the whole population, as a fraction of the line — depth of poverty, not just its incidence.',
              ),
            povertySeverity: z
              .number()
              .nullable()
              .describe(
                'Squared poverty gap, weighting the poorest most heavily — inequality among those below the line.',
              ),
            watts: z.number().nullable().describe('Watts index, a distribution-sensitive measure.'),
            mean: z.number().nullable().describe('Mean daily welfare per person in PPP dollars.'),
            median: z
              .number()
              .nullable()
              .describe(
                'Median daily welfare per person in PPP dollars. Null on aggregate rows, which PIP publishes without one.',
              ),
            gini: z
              .number()
              .nullable()
              .describe(
                'Gini coefficient of the welfare distribution, 0 (perfect equality) to 1. Null on gap-filled rows — see estimationType.',
              ),
            mld: z
              .number()
              .nullable()
              .describe('Mean log deviation, an inequality measure. Null on gap-filled rows.'),
            polarization: z
              .number()
              .nullable()
              .describe('Wolfson polarization index. Null on gap-filled rows.'),
            decileShares: z
              .array(z.number())
              .length(10)
              .nullable()
              .describe(
                'Share of total income or consumption held by each decile, poorest first, summing to 1. Null on gap-filled rows.',
              ),
            population: z
              .number()
              .nullable()
              .describe(
                'Population the estimate covers — multiply by headcount for the number of people below the line.',
              ),
            popInPoverty: z
              .number()
              .nullable()
              .describe(
                'Number of people below the poverty line, as PIP publishes it on aggregate rows. Null on economy rows, where population × headcount gives it.',
              ),
            surveyYear: z
              .number()
              .nullable()
              .describe(
                'Year of the survey behind the estimate, fractional when the survey spans a fiscal year (2022.58). Null on gap-filled rows, which trace to no single survey.',
              ),
            surveyAcronym: z
              .string()
              .describe(
                'Short name of the underlying survey (empty on gap-filled rows and where PIP publishes none).',
              ),
            surveyComparability: z
              .number()
              .nullable()
              .describe(
                "PIP's series comparability code within the economy: 0 is its oldest comparable series and the code steps up each time comparability breaks, so two survey rows of one economy compare over time only when they share it. Null on gap-filled rows.",
              ),
            comparableSpell: z
              .string()
              .nullable()
              .describe(
                'The span of years the comparable series behind this row covers, as PIP labels it ("2022", "2011 - 2022"). Null on gap-filled rows.',
              ),
            estimationType: z
              .string()
              .describe(
                'How the row was produced. On an economy: "survey" carries the full inequality block; "interpolation", "extrapolation", and "CMD estimation" are gap-filled and carry none, the last being what PIP publishes for economies it has no survey for at all. On an aggregate: "actual", "nowcast", or "projection".',
              ),
            isInterpolated: z
              .boolean()
              .nullable()
              .describe(
                'True on the interpolated and extrapolated rows. Read estimationType instead of relying on this alone — a "CMD estimation" row is also gap-filled but reports false here. Null on aggregate rows.',
              ),
            isAggregate: z
              .boolean()
              .describe(
                'True on a PIP aggregate — World, a region, an income group, or a lending group — whose median, distributional block, survey fields, welfareType, and reportingLevel are null.',
              ),
          })
          .describe(
            'One economy × year × reporting-level × welfare-type estimate, or one aggregate × year.',
          ),
      )
      .describe(
        'Poverty and inequality estimates for this page — economies and aggregates in one list, ordered by code, year, reporting level, then welfare type.',
      ),
  }),

  enrichment: {
    appliedFilters: z
      .object({
        countries: z
          .string()
          .describe(
            "Codes as queried, comma-joined across economies and aggregates: uppercased and deduplicated, two-character codes resolved to their three-character form (NG → NGA), and WDI group spellings read as PIP's (LMC → LMIC, IDB → BLND, IBD → IBRD). PIP's IDA-only group stays IDX, since IDA means IDA total. Every code here can be sent back as countries and asks for the same economy or group.",
          ),
        year: z
          .string()
          .optional()
          .describe('Year filter applied, omitted when none was requested.'),
        povertyLine: z
          .number()
          .optional()
          .describe(
            'Poverty line requested, omitted when the upstream default was used — in which case the applied value is on every row as povertyLine.',
          ),
        welfareType: z
          .string()
          .optional()
          .describe('Welfare-type filter applied, omitted when none.'),
        reportingLevel: z
          .string()
          .optional()
          .describe('Reporting-level filter applied, omitted when none.'),
        pppVersion: z
          .string()
          .describe(
            'PPP vintage every dollar figure in these estimates is expressed in, whether requested or resolved as the newest vintage of the release.',
          ),
        releaseVersion: z
          .string()
          .describe(
            'PIP data release the estimates come from, as its YYYYMMDD stamp — the newest release PIP lists. Survey and gap-filled rows share it.',
          ),
        fillGaps: z
          .boolean()
          .describe(
            'Whether gap-filling was permitted for this query, including the server default of true.',
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
        'The effective parameters sent to PIP — confirms country code normalization and which filters were in force for these estimates.',
      ),
    totalCount: z.number().describe('Total estimates before pagination.'),
    currentPage: z
      .number()
      .describe('Page number requested — past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total number of pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Context for an empty result set, for a page past the end of the results, for a page size reduced to the page cap, for a result carrying gap-filled or aggregate rows with no inequality data, and for economies fill_gaps false left out.',
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
          `countries=${filters.countries}`,
          ...(filters.year === undefined ? [] : [`year=${filters.year}`]),
          ...(filters.povertyLine === undefined ? [] : [`poverty_line=${filters.povertyLine}`]),
          ...(filters.welfareType === undefined ? [] : [`welfare_type=${filters.welfareType}`]),
          ...(filters.reportingLevel === undefined
            ? []
            : [`reporting_level=${filters.reportingLevel}`]),
          `ppp_version=${filters.pppVersion}`,
          `release_version=${filters.releaseVersion}`,
          `fill_gaps=${filters.fillGaps}`,
          `page=${filters.page}`,
          `per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No economy or aggregate PIP publishes goes by one or more of the codes, including a two-character code the World Bank country listing does not carry.',
      recovery:
        'Look an economy up with worldbank_list_countries by its ISO3 or ISO2 code. For an aggregate use a code the countries parameter lists: WLD, a region such as SSF, an income group such as LIC, or a lending group such as IDX.',
    },
    {
      reason: 'ambiguous_aggregate',
      code: JsonRpcErrorCode.ValidationError,
      when: "IDA or its ISO2 code XG names WDI's IDA total, which PIP does not compute.",
      recovery:
        'Ask for IDX (IDA only) and IDB (IDA blend) instead, together if both parts are wanted.',
    },
    {
      reason: 'unserved_aggregate',
      code: JsonRpcErrorCode.ValidationError,
      when: "An aggregate code this tool does not serve: an FCV or PovcalNet grouping from PIP's regions table (FCVY, SSA, EAP), or a WDI income aggregate PIP computes none for (MIC, LMY).",
      recovery:
        'Use one of the accepted aggregate codes the message lists — SSF rather than SSA for Sub-Saharan Africa — or query the individual economies instead.',
    },
    {
      reason: 'aggregate_filter_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'welfare_type or reporting_level was set alongside an aggregate code.',
      recovery:
        'Drop welfare_type and reporting_level, or query the aggregates and the economies in separate calls.',
    },
    {
      reason: 'invalid_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'PIP rejected the value supplied for a query parameter other than country.',
      recovery:
        'Correct the rejected parameter to the form its description gives and retry, or drop the parameter.',
    },
    {
      reason: 'ppp_version_unavailable',
      code: JsonRpcErrorCode.ValidationError,
      when: "ppp_version names a PPP vintage PIP's current data release is not published at.",
      recovery:
        'Retry with one of the PPP vintages named in the message, or omit ppp_version to use the newest one.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'PIP answered with a server error, or the World Bank Indicators API country listing that resolves an ISO2 code could not be loaded.',
      recovery:
        'Wait a few seconds and retry the same request; if it keeps failing, narrow it to fewer codes or a single year.',
    },
  ],

  async handler(input, ctx) {
    const codes = splitCountryCodes(input.countries);
    const year = input.year?.trim() ? input.year.trim() : undefined;
    const welfareType = input.welfare_type || undefined;
    const reportingLevel = input.reporting_level || undefined;
    const pppVersion = input.ppp_version || undefined;
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;

    ctx.log.info('Fetching PIP poverty estimates', {
      countries: codes,
      year,
      povertyLine: input.poverty_line,
      fillGaps: input.fill_gaps,
      page: input.page,
    });

    const idaTotal = codes.filter((code) => IDA_TOTAL_CODES.has(code.toUpperCase()));
    if (idaTotal.length > 0) {
      throw ctx.fail(
        'ambiguous_aggregate',
        `"${idaTotal.join(',')}" is WDI's IDA total — IDA-only and IDA blend economies together — which PIP does not compute. PIP publishes the two parts as IDX (IDA only) and IDB (IDA blend).`,
        {
          countryCodes: idaTotal.join(','),
          retryable: false,
          ...ctx.recoveryFor('ambiguous_aggregate'),
          countries: codes,
        },
      );
    }

    /**
     * PIP takes three-character codes only. A two-character code resolves
     * through the World Bank country index to its three-character ID, which an
     * aggregate's ISO2 code (ZG → SSF) shares with its own code, so it routes
     * the same way. The index is read only when a two-character code is present.
     * An index that fails to load is reported as the upstream failure it is,
     * naming the listing; a cancellation of this call is the caller's and
     * propagates untouched.
     */
    const lookups = await Promise.all(
      codes.map((code) =>
        code.length === 2 ? getWorldBankApiService().lookupCountry(code, ctx) : undefined,
      ),
    ).catch((err: unknown) => {
      if (ctx.signal.aborted) throw err;
      throw ctx.fail(
        'upstream_unavailable',
        'The World Bank Indicators API country listing, which resolves an ISO2 code to the three-character code PIP takes, could not be loaded.',
        {
          ...(err instanceof McpError &&
            err.data?.status !== undefined && { status: err.data.status }),
          recovery: {
            hint: 'Wait a few seconds and retry the same request; if it keeps failing, pass each economy by its ISO3 code, which needs no country-listing lookup.',
          },
          countries: codes,
        },
        { cause: err },
      );
    });
    const unmapped = codes.filter((code, index) => code.length === 2 && !lookups[index]);
    if (unmapped.length > 0) {
      throw ctx.fail(
        'country_not_found',
        `No economy or aggregate in the World Bank country listing has the two-character code(s) "${unmapped.join(',')}".`,
        {
          countryCodes: unmapped.join(','),
          retryable: false,
          ...ctx.recoveryFor('country_not_found'),
          countries: codes,
        },
      );
    }
    /** Each resolved three-character ID, mapped back to the two-character code sent for it. */
    const resolvedFrom = new Map<string, string>();
    const queried = codes.map((code, index) => {
      const entity = lookups[index];
      if (!entity) return code;
      resolvedFrom.set(entity.id.toUpperCase(), code);
      return entity.id;
    });

    let result: Awaited<ReturnType<ReturnType<typeof getPipService>['getPoverty']>>;
    try {
      result = await getPipService().getPoverty(
        {
          countries: queried,
          ...(year !== undefined && { year }),
          ...(input.poverty_line !== undefined && { povertyLine: input.poverty_line }),
          ...(welfareType !== undefined && { welfareType }),
          ...(reportingLevel !== undefined && { reportingLevel }),
          ...(pppVersion !== undefined && { pppVersion }),
          fillGaps: input.fill_gaps,
          page: input.page,
          perPage,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const reason = err.data?.reason;
        if (reason === 'country_not_found') {
          const sentAs = String(err.data?.countryCodes ?? '')
            .split(',')
            .flatMap((code) => {
              const sent = resolvedFrom.get(code);
              return sent ? [`"${sent}" as ${code}`] : [];
            });
          throw ctx.fail(
            'country_not_found',
            sentAs.length > 0
              ? `${err.message} Queried ${listCodes(sentAs)}, resolved from the two-character code sent.`
              : err.message,
            { ...err.data, ...ctx.recoveryFor('country_not_found'), countries: codes },
          );
        }
        if (reason === 'unserved_aggregate') {
          throw ctx.fail('unserved_aggregate', err.message, {
            ...err.data,
            ...ctx.recoveryFor('unserved_aggregate'),
            countries: codes,
          });
        }
        if (reason === 'aggregate_filter_conflict') {
          throw ctx.fail('aggregate_filter_conflict', err.message, {
            ...err.data,
            ...ctx.recoveryFor('aggregate_filter_conflict'),
            countries: codes,
          });
        }
        if (reason === 'invalid_parameter') {
          const listed = Object.keys(err.data?.acceptedValues ?? {});
          throw ctx.fail('invalid_parameter', err.message, {
            ...err.data,
            recovery:
              listed.length > 0
                ? { hint: listedValuesHint(err.data?.parameters as string[], listed) }
                : ctx.recoveryFor('invalid_parameter').recovery,
            countries: codes,
          });
        }
        if (reason === 'ppp_version_unavailable') {
          throw ctx.fail('ppp_version_unavailable', err.message, {
            ...err.data,
            ...ctx.recoveryFor('ppp_version_unavailable'),
            countries: codes,
          });
        }
        if (reason === 'upstream_unavailable') {
          throw ctx.fail('upstream_unavailable', err.message, {
            ...err.data,
            ...ctx.recoveryFor('upstream_unavailable'),
            countries: codes,
          });
        }
      }
      throw err;
    }

    ctx.enrich({
      appliedFilters: {
        countries: result.countries.map((code) => (code === 'ALL' ? 'all' : code)).join(','),
        ...(year !== undefined && { year }),
        ...(input.poverty_line !== undefined && { povertyLine: input.poverty_line }),
        ...(welfareType !== undefined && { welfareType }),
        ...(reportingLevel !== undefined && { reportingLevel }),
        pppVersion: result.pppVersion,
        releaseVersion: result.releaseVersion,
        fillGaps: input.fill_gaps,
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < perPage && { requestedPerPage: perPage }),
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    const notices: string[] = [];
    if (result.total === 0) {
      notices.push(
        input.fill_gaps
          ? 'No estimates for the requested filter. PIP covers economies from 1963 onward and its aggregates from 1981, but not every economy in every year; widen the year, drop welfare_type or reporting_level, or check the country code.'
          : 'No estimates for the requested filter. fill_gaps is false, so only years covered by an actual survey are returned — set fill_gaps to true for an interpolated estimate, or use year="all" to see which years do have surveys.',
      );
    } else {
      if (result.rows.length === 0) {
        notices.push(
          pagePastEndNotice({
            noun: ['estimate', 'estimates'],
            page: result.page,
            pages: result.pages,
            perPage: result.perPage,
            total: result.total,
          }),
        );
      }
      const reduced = pageSizeReducedNotice({
        requested: perPage,
        served: result.perPage,
        page: result.page,
        pages: result.pages,
      });
      if (reduced) notices.push(reduced);
      if (result.rows.length > 0 && result.gapFilled) {
        notices.push(
          'Some rows are gap-filled: no survey covers those years, so PIP estimated the poverty measures and published no distributional data alongside them. Their gini, mld, polarization, and decileShares are null by design. Read estimationType per row to tell a survey-derived row from an estimated one — the two come from different upstream series, so their poverty figures are close but not on the same footing.',
        );
        if (year?.toLowerCase() === 'mrv') {
          notices.push(
            'year "MRV" resolved each economy to PIP\'s latest estimate year; set fill_gaps to false for each economy\'s latest survey year, which carries the inequality block.',
          );
        }
      }
      if (result.rows.some((row) => row.isAggregate)) {
        notices.push(
          'Rows with isAggregate true are PIP aggregates: they carry the poverty measures, mean, population, and popInPoverty, but no median, distributional block, survey fields, welfareType, or reportingLevel, and fill_gaps does not apply to them. Their estimationType says whether a year is actual, a nowcast, or a projection.',
        );
      }
    }
    if (result.modelOnly.length > 0) {
      const one = result.modelOnly.length === 1;
      notices.push(
        `PIP publishes ${listCodes(result.modelOnly)} only as a gap-filled model estimate (estimationType "CMD estimation"), so fill_gaps false returns no rows for ${one ? 'it' : 'them'}; set fill_gaps to true to include ${one ? 'it' : 'them'}.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { estimates: result.rows };
  },

  format: (result) => {
    if (result.estimates.length === 0) {
      return [
        { type: 'text', text: '# Poverty and Inequality Estimates\n\nNo estimates returned.' },
      ];
    }

    const lines: string[] = ['# Poverty and Inequality Estimates'];

    /**
     * An economy row renders as it did before aggregates existed: its region and
     * reporting level mark it as one, and its popInPoverty is always null. Only an
     * aggregate row names isAggregate and popInPoverty, which keeps the heaviest
     * 70-row page of economies inside the response budget.
     */
    for (const row of result.estimates) {
      lines.push(
        `\n## ${row.countryName} (${row.countryCode}) — ${row.reportingYear}, ${row.reportingLevel ?? 'aggregate'}`,
        `- **region:** ${row.regionCode === null ? 'none' : `${row.regionName} (${row.regionCode})`}${row.isAggregate ? ' | **isAggregate:** true' : ''}`,
        `- **welfareType:** ${row.welfareType} | **povertyLine:** ${row.povertyLine}/day PPP`,
        `- **headcount:** ${row.headcount} | **povertyGap:** ${row.povertyGap} | **povertySeverity:** ${row.povertySeverity} | **watts:** ${row.watts}`,
        `- **mean:** ${row.mean} | **median:** ${row.median} | **population:** ${row.population}${row.popInPoverty === null ? '' : ` | **popInPoverty:** ${row.popInPoverty}`}`,
        `- **gini:** ${row.gini} | **mld:** ${row.mld} | **polarization:** ${row.polarization}`,
        `- **decileShares:** ${row.decileShares === null ? 'null' : row.decileShares.join(', ')}`,
        `- **estimationType:** ${row.estimationType} | **isInterpolated:** ${row.isInterpolated} | **surveyYear:** ${row.surveyYear} | **surveyAcronym:** ${row.surveyAcronym || 'none'}`,
        `- **surveyComparability:** ${row.surveyComparability} | **comparableSpell:** ${row.comparableSpell}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
