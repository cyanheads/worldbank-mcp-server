/**
 * @fileoverview Query poverty and inequality estimates from the World Bank
 * Poverty and Inequality Platform (PIP) — headcount, gap, and severity at any
 * poverty line for economies and PIP's own aggregates, alongside the Gini
 * coefficient and decile distribution.
 * @module mcp-server/tools/definitions/worldbank-get-poverty.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { perPageInput, resolvePerPage } from '@/mcp-server/tools/per-page.js';
import {
  CALL_DEADLINE_MS,
  isCallDeadlineExceeded,
  withCallDeadline,
} from '@/services/call-deadline.js';
import { getPipService } from '@/services/pip/pip-service.js';
import { MAX_ESTIMATES_PER_PAGE } from '@/services/response-budget.js';
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
    'Query Poverty and Inequality Platform (PIP) economies and aggregates: headcount, gap, and severity at any poverty line, or the welfare threshold for a population share in an economy. Welfare is in PPP dollars per person per day. Unlike WDI series in worldbank_get_data, PIP computes estimates at custom lines. Read estimationType to distinguish surveys from gap-filled estimates, whose inequality fields are null.',
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
          .describe('One code, several separated by commas, semicolons, or pipes, or "all".'),
        z
          .array(z.string())
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
          .describe('Codes; an element holding several separated codes is split too.'),
      ])
      .describe(
        'Economies by ISO3 (IND) or ISO2 (IN) code, model-estimate-only ones (AFG) included, or "all" for every economy. PIP aggregates: WLD; regions AFE, AFW, EAS, ECS, LCN, MEA, NAC, SAS, SSF; income HIC, LIC, LMIC (LMC), UMIC (UMC); fragility FCVY (fragile), FCVN (not fragile); lending IDX (IDA only), IDB or BLND (IDA blend), IBD or IBRD (IBRD only), REST. Income membership follows PIP\'s release for every year and can differ from worldbank_get_country. For IDA use IDX and IDB. FCS, SSA, EAP, MIC, and LMY are unsupported. Aggregates cannot combine with population_share, welfare_type, or reporting_level.',
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
        'A four-digit reporting year, "all" (the default) for the full history, or "MRV" for the latest: per economy, PIP\'s latest estimate year with fill_gaps true or its latest survey year with fill_gaps false; an aggregate\'s newest year. Coverage runs from 1963 to the last year of PIP\'s data release.',
      ),
    poverty_line: z
      .number()
      .min(0)
      .max(2700)
      .optional()
      .describe(
        "Fixed line in PPP dollars per person per day. PIP rounds it to two decimals (6.953 is computed at 6.95): each row's povertyLine is the line applied, appliedFilters.povertyLine the value sent. With neither threshold input, PIP uses the international line for the applied vintage.",
      ),
    population_share: z
      .number()
      .gt(0)
      .lt(1)
      // A pipe preserves the numeric schema while keeping framework repair from accepting strings.
      .pipe(z.number())
      .optional()
      .describe(
        'Target fraction of the population strictly between 0 and 1 (0.4 for the poorest 40%). Economy queries only. Omit poverty_line to use it.',
      ),
    welfare_type: z
      .union([
        z.literal(''),
        z.enum(['income', 'consumption']).describe('Income or consumption surveys.'),
      ])
      .optional()
      .describe(
        "One welfare measure. Income and consumption are not directly comparable, so pin one for a cross-country comparison. Omitted, each economy's published measure, with a row per measure in a year surveyed both ways; gap-filled estimates use one measure per year.",
      ),
    reporting_level: z
      .union([
        z.literal(''),
        z.enum(['national', 'urban', 'rural']).describe('National, urban, or rural estimates.'),
      ])
      .optional()
      .describe(
        'One reporting level. Most economies publish national figures only; China publishes all three for the same year; some publish urban or rural figures in some years, where fill_gaps true adds PIP\'s national estimate if it has one. Argentina is urban only, so "national" leaves it out.',
      ),
    ppp_version: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}$/, 'ppp_version must be a four-digit PPP vintage year, e.g. "2017".')
          .describe('A four-digit PPP vintage year.'),
      ])
      .optional()
      .describe(
        'PPP vintage for every dollar figure ("2021", "2017"), one PIP\'s current data release is published at; omitted, the newest.',
      ),
    fill_gaps: z
      .boolean()
      .default(true)
      .describe(
        "True: PIP's estimates fill the years, reporting levels, and welfare types no survey covers, so an unsurveyed year still returns a row; those rows carry no inequality data. False: survey rows only, empty for unsurveyed years and for model-estimate-only economies. No effect on aggregates.",
      ),
    page: z.number().int().min(1).default(1).describe('Page number, 1-based.'),
    per_page: perPageInput(MAX_ESTIMATES_PER_PAGE),
  }),
  output: z.object({
    estimates: z
      .array(
        z
          .object({
            countryCode: z
              .string()
              .describe(
                'Economy ISO3 code, or the aggregate code (IDX for IDA only); accepted back as countries.',
              ),
            countryName: z.string().describe('Economy or aggregate name.'),
            regionCode: z.string().nullable().describe('PIP region code, such as SAS.'),
            regionName: z.string().nullable().describe('PIP region name.'),
            reportingYear: z.number().describe('Year the estimate reports on.'),
            reportingLevel: z.string().nullable().describe('Coverage: national, urban, or rural.'),
            welfareType: z.string().nullable().describe('Welfare measure: income or consumption.'),
            povertyLine: z
              .number()
              .describe(
                'Applied line, or threshold computed for population_share, in PPP dollars per person per day.',
              ),
            headcount: z
              .number()
              .nullable()
              .describe('Actual fraction below the line, which can differ from population_share.'),
            povertyGap: z
              .number()
              .nullable()
              .describe(
                'Mean shortfall below the line across the population, as a fraction of the line.',
              ),
            povertySeverity: z
              .number()
              .nullable()
              .describe('Squared poverty gap, weighting the poorest most.'),
            watts: z.number().nullable().describe('Watts poverty index.'),
            mean: z.number().nullable().describe('Mean daily welfare per person in PPP dollars.'),
            median: z
              .number()
              .nullable()
              .describe('Median daily welfare per person in PPP dollars.'),
            gini: z.number().nullable().describe('Gini coefficient, 0 (equality) to 1.'),
            mld: z.number().nullable().describe('Mean log deviation.'),
            polarization: z.number().nullable().describe('Wolfson polarization index.'),
            decileShares: z
              .array(z.number())
              .length(10)
              .nullable()
              .describe(
                "Each decile's share of income or consumption, poorest first, summing to 1.",
              ),
            population: z.number().nullable().describe('Population the estimate covers.'),
            popInPoverty: z
              .number()
              .nullable()
              .describe(
                'People below the line, published on aggregate rows; null on economy rows, where population × headcount gives it.',
              ),
            surveyYear: z
              .number()
              .nullable()
              .describe('Survey year, fractional when the survey spans a fiscal year (2022.58).'),
            surveyAcronym: z
              .string()
              .describe('Survey short name; empty on gap-filled rows and where none is published.'),
            surveyComparability: z
              .number()
              .nullable()
              .describe(
                'Comparability code within the economy, 0 for its oldest series and stepping up at each break; two survey rows compare over time only when they share it.',
              ),
            comparableSpell: z
              .string()
              .nullable()
              .describe('Years the comparable series covers, as PIP labels it ("2011 - 2022").'),
            estimationType: z
              .string()
              .describe(
                'How the row was produced. Economy rows: "survey", or gap-filled "interpolation", "extrapolation", or "CMD estimation" (no survey at all), whose gini, mld, polarization, decileShares, surveyYear, surveyComparability, and comparableSpell are null. Aggregate rows: "actual", "nowcast", or "projection".',
              ),
            estimateType: z
              .string()
              .nullable()
              .describe(
                'Estimate classification: actual, nowcast, or projection; null when none is published. Independent of estimationType.',
              ),
            distributionType: z
              .string()
              .nullable()
              .describe(
                'Distribution classification: micro, group, or imputed; null when none is published.',
              ),
            isInterpolated: z
              .boolean()
              .nullable()
              .describe(
                'True on interpolated and extrapolated rows but false on a gap-filled "CMD estimation" row, so read estimationType.',
              ),
            isAggregate: z
              .boolean()
              .describe(
                'True on a PIP aggregate row, whose regionCode, regionName, reportingLevel, welfareType, median, gini, mld, polarization, decileShares, surveyYear, surveyComparability, comparableSpell, and isInterpolated are null and surveyAcronym is empty.',
              ),
          })
          .describe(
            'An economy × year × reporting level × welfare type estimate, or an aggregate × year.',
          ),
      )
      .describe(
        'Estimates on this page, ordered by code, year, reporting level, then welfare type.',
      ),
  }),

  enrichment: {
    appliedFilters: z
      .object({
        countries: z
          .string()
          .describe(
            "Codes as queried, comma-joined: uppercased, deduplicated, ISO2 resolved to three characters (NG → NGA), and WDI group spellings read as PIP's (LMC → LMIC, IDB → BLND, IBD → IBRD). Each can be sent back as countries.",
          ),
        year: z.string().optional().describe('Year applied.'),
        povertyLine: z.number().optional().describe('Poverty line as sent.'),
        populationShare: z.number().optional().describe('Target population share as sent.'),
        welfareType: z.string().optional().describe('Welfare type applied.'),
        reportingLevel: z.string().optional().describe('Reporting level applied.'),
        pppVersion: z.string().describe('PPP vintage of every dollar figure.'),
        releaseVersion: z.string().describe('PIP data release (YYYYMMDD), the newest PIP lists.'),
        fillGaps: z.boolean().describe('Whether gap-filling was on.'),
        page: z.number().describe('Page requested.'),
        perPage: z.number().describe('Page size served, after any reduction to the page maximum.'),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, or the server default; present only when perPage was reduced.',
          ),
      })
      .describe('The query as sent to PIP; a filter not applied is omitted.'),
    totalCount: z.number().describe('Matching estimates before pagination.'),
    currentPage: z
      .number()
      .describe('Page number; past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total pages at perPage.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Explains an empty result, a page past the end, a reduced page size, gap-filled or aggregate rows, gap-filled estimates PIP failed to return, or economies fill_gaps false left out.',
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
          `countries=${escapeMarkdownInline(filters.countries)}`,
          ...(filters.year === undefined ? [] : [`year=${filters.year}`]),
          ...(filters.povertyLine === undefined ? [] : [`poverty_line=${filters.povertyLine}`]),
          ...(filters.populationShare === undefined
            ? []
            : [`population_share=${filters.populationShare}`]),
          ...(filters.welfareType === undefined ? [] : [`welfare_type=${filters.welfareType}`]),
          ...(filters.reportingLevel === undefined
            ? []
            : [`reporting_level=${filters.reportingLevel}`]),
          `ppp_version=${filters.pppVersion}`,
          `release_version=${escapeMarkdownInline(filters.releaseVersion)}`,
          `fill_gaps=${filters.fillGaps}`,
          `page=${filters.page}`,
          `per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'country_not_found',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'A code names no economy or aggregate PIP publishes.',
      recovery:
        'Look an economy up with worldbank_list_countries by its ISO3 or ISO2 code. For an aggregate use a code the countries parameter lists: WLD, a region such as SSF, an income group such as LIC, or a lending group such as IDX.',
    },
    {
      reason: 'ambiguous_aggregate',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: "IDA or XG asks for WDI's IDA total, which PIP does not compute.",
      recovery:
        'Ask for IDX (IDA only) and IDB (IDA blend) instead, together if both parts are wanted.',
    },
    {
      reason: 'unserved_aggregate',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An aggregate code this tool does not serve, such as FCS, SSA, or MIC.',
      recovery:
        'Use one of the accepted aggregate codes the message lists — SSF rather than SSA for Sub-Saharan Africa — or query the individual economies instead.',
    },
    {
      reason: 'aggregate_filter_conflict',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'population_share, welfare_type, or reporting_level is set with an aggregate code.',
      recovery:
        'Drop population_share, welfare_type, and reporting_level for aggregates, or query economies separately.',
    },
    {
      reason: 'invalid_params',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both poverty_line and population_share are set.',
      recovery: 'Choose population_share for a threshold or poverty_line for a share.',
    },
    {
      reason: 'invalid_parameter',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'PIP rejected a parameter value.',
      recovery:
        'Correct the rejected parameter to the form its description gives and retry, or drop the parameter.',
    },
    {
      reason: 'ppp_version_unavailable',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: "ppp_version is not a vintage PIP's current release is published at.",
      recovery:
        'Retry with one of the PPP vintages named in the message, or omit ppp_version to use the newest one.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'PIP returned a server error, or the country listing that resolves ISO2 codes did not load.',
      recovery:
        'Wait a few seconds and retry the same request; if it keeps failing, narrow it to fewer codes or a single year.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      thrownBy: 'service',
      when: "The call's 50-second budget ran out before PIP or the ISO2 country listing answered, or a PIP request ran past its 90-second bound.",
      recovery:
        'Repeat the same call: this server keeps the request running after the deadline and answers the repeat from its result. When PIP itself did not finish the request within 90 seconds, a repeat starts over, so narrow it to fewer economies or years.',
    },
  ],

  async handler(input, ctx) {
    if (input.poverty_line !== undefined && input.population_share !== undefined) {
      throw ctx.fail('invalid_params', 'Set only one of poverty_line and population_share.', {
        parameters: ['poverty_line', 'population_share'],
        retryable: false,
      });
    }
    /**
     * One deadline for the whole call, started before anything waits: the ISO2
     * lookup through the Indicators API and every PIP request spend the same
     * budget, never one each.
     */
    const call = withCallDeadline(ctx);
    const codes = splitCountryCodes(input.countries);
    const year = input.year?.trim() ? input.year.trim() : undefined;
    const welfareType = input.welfare_type || undefined;
    const reportingLevel = input.reporting_level || undefined;
    const pppVersion = input.ppp_version || undefined;

    ctx.log.info('Fetching PIP poverty estimates', {
      countries: codes,
      year,
      povertyLine: input.poverty_line,
      populationShare: input.population_share,
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
     * naming the listing, and one still loading when the call deadline passes as
     * the timeout it is; a cancellation of this call is the caller's and
     * propagates untouched.
     */
    const lookups = await Promise.all(
      codes.map((code) =>
        code.length === 2 ? getWorldBankApiService().lookupCountry(code, call) : undefined,
      ),
    ).catch((err: unknown) => {
      if (ctx.signal.aborted) throw err;
      if (isCallDeadlineExceeded(err)) {
        const hint = (err.data?.recovery as { hint?: string } | undefined)?.hint;
        throw ctx.fail(
          'upstream_timeout',
          `The World Bank Indicators API country listing, which resolves an ISO2 code to the three-character code PIP takes, did not load within the call's ${CALL_DEADLINE_MS / 1000} s deadline.`,
          {
            ...err.data,
            recovery: {
              hint: `${hint ? `${hint} ` : ''}Passing each economy by its ISO3 code needs no country-listing lookup.`,
            },
            countries: codes,
          },
          { cause: err },
        );
      }
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

    const pageSize = resolvePerPage(
      { tool: 'worldbank_get_poverty', cap: MAX_ESTIMATES_PER_PAGE, perPage: input.per_page },
      ctx,
    );
    let result: Awaited<ReturnType<ReturnType<typeof getPipService>['getPoverty']>>;
    try {
      result = await getPipService().getPoverty(
        {
          countries: queried,
          ...(year !== undefined && { year }),
          ...(input.poverty_line !== undefined && { povertyLine: input.poverty_line }),
          ...(input.population_share !== undefined && { populationShare: input.population_share }),
          ...(welfareType !== undefined && { welfareType }),
          ...(reportingLevel !== undefined && { reportingLevel }),
          ...(pppVersion !== undefined && { pppVersion }),
          fillGaps: input.fill_gaps,
          page: input.page,
          perPage: pageSize.served,
        },
        call,
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
            { ...err.data, countries: codes },
          );
        }
        if (reason === 'unserved_aggregate') {
          throw ctx.fail('unserved_aggregate', err.message, {
            ...err.data,
            countries: codes,
          });
        }
        if (reason === 'aggregate_filter_conflict') {
          throw ctx.fail('aggregate_filter_conflict', err.message, {
            ...err.data,
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
            countries: codes,
          });
        }
        if (reason === 'upstream_unavailable') {
          throw ctx.fail('upstream_unavailable', err.message, {
            ...err.data,
            countries: codes,
          });
        }
        if (reason === 'upstream_timeout') {
          throw ctx.fail('upstream_timeout', err.message, {
            ...err.data,
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
        ...(input.population_share !== undefined && { populationShare: input.population_share }),
        ...(welfareType !== undefined && { welfareType }),
        ...(reportingLevel !== undefined && { reportingLevel }),
        pppVersion: result.pppVersion,
        releaseVersion: result.releaseVersion,
        fillGaps: input.fill_gaps,
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < pageSize.requested && { requestedPerPage: pageSize.requested }),
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
      if (result.rows.length > 0 && result.gapFilled) {
        notices.push(
          'Some rows are gap-filled: no survey covers their year, reporting level, and welfare type, so PIP estimated the poverty measures and published no distributional data alongside them. Their gini, mld, polarization, and decileShares are null by design. Read estimationType per row to tell a survey-derived row from an estimated one — the two come from different upstream series, so their poverty figures are close but not on the same footing.',
        );
        if (year?.toLowerCase() === 'mrv') {
          notices.push(
            'year "MRV" resolved each economy to PIP\'s latest estimate year; set fill_gaps to false for each economy\'s latest survey year, which carries the inequality block.',
          );
        }
      }
      if (result.gapFillUnavailable) {
        notices.push(
          'PIP did not return its gap-filled estimates for the surveyed economies, so their rows come from surveys alone. An estimate the surveys do not cover, such as a national figure for a year surveyed only in urban areas, may be missing; repeat the same request in about a minute to include it.',
        );
      }
      if (result.rows.some((row) => row.isAggregate)) {
        notices.push(
          'Rows with isAggregate true are PIP aggregates: they carry the poverty measures, mean, population, and popInPoverty, but no median, distributional block, survey fields, welfareType, or reportingLevel, and fill_gaps does not apply to them. Their estimationType says whether a year is actual, a nowcast, or a projection.',
        );
      }
    }
    const reduced = pageSizeReducedNotice({
      requested: pageSize.requested,
      served: result.perPage,
      page: result.page,
      pages: result.pages,
    });
    if (reduced) notices.push(reduced);
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
     * aggregate row names isAggregate and popInPoverty.
     */
    for (const row of result.estimates) {
      lines.push(
        `\n${escapeMarkdownInline(row.countryName)} (${escapeMarkdownInline(row.countryCode)}) — ${row.reportingYear}, ${escapeMarkdownInline(row.reportingLevel ?? 'aggregate')}`,
        `- **region:** ${row.regionCode === null ? 'none' : `${escapeMarkdownInline(String(row.regionName))} (${escapeMarkdownInline(row.regionCode)})`}${row.isAggregate ? ' | **isAggregate:** true' : ''}`,
        `- **welfareType:** ${escapeMarkdownInline(String(row.welfareType))} | **povertyLine:** ${row.povertyLine}/day PPP`,
        `- **headcount:** ${row.headcount} | **povertyGap:** ${row.povertyGap} | **povertySeverity:** ${row.povertySeverity} | **watts:** ${row.watts}`,
        `- **mean:** ${row.mean} | **median:** ${row.median} | **population:** ${row.population}${row.popInPoverty === null ? '' : ` | **popInPoverty:** ${row.popInPoverty}`}`,
        `- **gini:** ${row.gini} | **mld:** ${row.mld} | **polarization:** ${row.polarization}`,
        `- **decileShares:** ${row.decileShares === null ? 'null' : row.decileShares.join(', ')}`,
        `- **estimationType:** ${escapeMarkdownInline(row.estimationType)} | **isInterpolated:** ${row.isInterpolated} | **surveyYear:** ${row.surveyYear} | **surveyAcronym:** ${escapeMarkdownInline(row.surveyAcronym || 'none')}`,
        `- **surveyComparability:** ${row.surveyComparability} | **comparableSpell:** ${escapeMarkdownInline(String(row.comparableSpell))}`,
        `- **estimateType:** ${escapeMarkdownInline(String(row.estimateType))} | **distributionType:** ${escapeMarkdownInline(String(row.distributionType))}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
