/**
 * @fileoverview Query poverty and inequality estimates from the World Bank
 * Poverty and Inequality Platform (PIP) — headcount, gap, and severity at any
 * poverty line, alongside the Gini coefficient and decile distribution.
 * @module mcp-server/tools/definitions/worldbank-get-poverty.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getPipService } from '@/services/pip/pip-service.js';

/** Split a caller-supplied country string on either separator this server's tools use. */
function splitCodes(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

export const worldbankGetPoverty = tool('worldbank_get_poverty', {
  title: 'Get World Bank Poverty and Inequality Estimates',
  description:
    'Queries poverty and inequality estimates from the World Bank Poverty and Inequality Platform (PIP) for one or more countries. ' +
    'Returns the poverty headcount ratio, poverty gap, and poverty severity at any poverty line, plus mean and median welfare and population. ' +
    'This is also the tool for inequality and distribution questions — survey-based rows carry the Gini coefficient, mean log deviation, polarization, and the ten decile income/consumption shares, because PIP returns poverty and inequality in the same row. ' +
    'PIP is a separate dataset from the WDI series worldbank_get_data reads: it measures welfare in PPP dollars per person per day and covers individual economies only, so regional and income-group aggregate codes are not accepted. ' +
    'Every row reports how it was produced. estimationType "survey" rows carry the full inequality block; "interpolation", "extrapolation", and "CMD estimation" rows are gap-filled estimates for years no survey covers, and their gini, mld, polarization, and decileShares are null — a documented gap in the source data, not an error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    countries: z
      .union([
        z
          .string()
          .regex(/[^\s;,]/, 'Provide at least one country code, or "all" for every economy.')
          .describe('A single country code, a comma-separated list, or "all".'),
        z
          .array(z.string().describe('A country code.'))
          .min(1)
          /**
           * Checked against what the split actually yields, not against raw
           * string length: PIP reads an empty `country` as every economy, so an
           * array holding nothing but separators must not reach it.
           */
          .refine(
            (codes) => codes.flatMap(splitCodes).length > 0,
            'Provide at least one country code, or "all" for every economy.',
          )
          .describe('An array of country codes.'),
      ])
      .describe(
        'Country codes. PIP identifies economies by ISO3 code (IND, USA, BRA); "all" returns every economy it covers. ' +
          'Pass a single code, an array, or one string separated by commas or semicolons. ' +
          'Regional, income-group, and world aggregate codes (WLD, SSF, HIC) are not served by this dataset — query the individual economies instead.',
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
        'Reporting year to return. A four-digit year (2022), "all" for the full history, or "MRV" for the most recent year available. ' +
          'Omitted behaves as "all". PIP coverage starts in 1963 and runs to the current year.',
      ),
    poverty_line: z
      .number()
      .min(0)
      .max(2700)
      .optional()
      .describe(
        'Poverty line in PPP dollars per person per day — any threshold, not only the published ones. ' +
          'Omitted uses the international poverty line of the PIP release currently served, so the applied value is echoed back on every row as povertyLine rather than assumed here. ' +
          'The poverty line does not affect the inequality fields, which describe the whole distribution.',
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
    fill_gaps: z
      .boolean()
      .default(true)
      .describe(
        "When true (the default), any year the surveys do not cover falls back to PIP's own estimate for it instead of being left out — so a single-year query still answers, and a full-history query returns a row per year rather than only the survey years. Those fallback rows carry no inequality data. Set false to return survey-derived rows only, accepting an empty result for years no survey covers.",
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        'Results per page (default: server default, max: 1000). "all" countries across "all" years runs to a few thousand rows.',
      ),
  }),
  output: z.object({
    estimates: z
      .array(
        z
          .object({
            countryCode: z.string().describe('ISO3 country code.'),
            countryName: z.string().describe('Economy name.'),
            regionCode: z.string().describe('PIP region code (e.g. SAS, NAC, SSA).'),
            regionName: z.string().describe('PIP region name.'),
            reportingYear: z.number().describe('Calendar year the estimate reports on.'),
            reportingLevel: z
              .string()
              .describe('Coverage of this estimate: national, urban, or rural.'),
            welfareType: z
              .string()
              .describe(
                'Whether the underlying survey measures income or consumption. The two are not directly comparable across economies.',
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
              .describe('Median daily welfare per person in PPP dollars.'),
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
            estimationType: z
              .string()
              .describe(
                'How the row was produced: "survey" carries the full inequality block; "interpolation", "extrapolation", and "CMD estimation" are gap-filled and carry none. The last is what PIP publishes for economies it has no survey for at all.',
              ),
            isInterpolated: z
              .boolean()
              .describe(
                'True on the interpolated and extrapolated rows. Read estimationType instead of relying on this alone — a "CMD estimation" row is also gap-filled but reports false here.',
              ),
          })
          .describe('One country × year × reporting-level × welfare-type estimate.'),
      )
      .describe(
        'Poverty and inequality estimates for this page, ordered by country, year, reporting level, then welfare type.',
      ),
  }),

  enrichment: {
    appliedFilters: z
      .object({
        countries: z
          .string()
          .describe(
            'Country codes as sent to PIP — arrays and semicolon-separated input are normalized to a comma-joined list, so this shows the value actually queried.',
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
        fillGaps: z
          .boolean()
          .describe(
            'Whether gap-filling was permitted for this query, including the server default of true.',
          ),
        page: z.number().describe('Page number requested.'),
        perPage: z.number().describe('Results per page used, including the server default.'),
      })
      .describe(
        'The effective parameters sent to PIP — confirms country code normalization and which filters were in force for these estimates.',
      ),
    totalCount: z.number().describe('Total estimates before pagination.'),
    currentPage: z.number().describe('Current page number.'),
    totalPages: z.number().describe('Total number of pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Context for an empty result set, or for a result carrying gap-filled rows with no inequality data.',
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
          `fill_gaps=${filters.fillGaps}`,
          `page=${filters.page}`,
          `per_page=${filters.perPage}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'PIP does not recognize one or more of the country codes.',
      recovery:
        'Use worldbank_list_countries to look up the ISO3 code, and query individual economies rather than aggregate codes.',
    },
    {
      reason: 'invalid_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'PIP rejected the value supplied for a query parameter other than country.',
      recovery:
        'Read the accepted values named in the message and retry with one of them, or drop the parameter.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'PIP answered with a server error, which an aggregate country code also produces.',
      recovery:
        'Replace any regional or income-group code with individual economy codes; otherwise wait and retry.',
    },
  ],

  async handler(input, ctx) {
    const codes = Array.isArray(input.countries)
      ? input.countries.flatMap(splitCodes)
      : splitCodes(input.countries);
    const year = input.year?.trim() ? input.year.trim() : undefined;
    const welfareType = input.welfare_type || undefined;
    const reportingLevel = input.reporting_level || undefined;
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;

    ctx.log.info('Fetching PIP poverty estimates', {
      countries: codes,
      year,
      povertyLine: input.poverty_line,
      fillGaps: input.fill_gaps,
      page: input.page,
    });

    let result: Awaited<ReturnType<ReturnType<typeof getPipService>['getPoverty']>>;
    try {
      result = await getPipService().getPoverty(
        {
          countries: codes,
          ...(year !== undefined && { year }),
          ...(input.poverty_line !== undefined && { povertyLine: input.poverty_line }),
          ...(welfareType !== undefined && { welfareType }),
          ...(reportingLevel !== undefined && { reportingLevel }),
          fillGaps: input.fill_gaps,
          page: input.page,
          perPage,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const reason = err.data?.reason;
        if (
          reason === 'country_not_found' ||
          reason === 'invalid_parameter' ||
          reason === 'upstream_unavailable'
        ) {
          throw ctx.fail(reason, err.message, {
            ...ctx.recoveryFor(reason),
            countries: codes,
          });
        }
      }
      throw err;
    }

    ctx.enrich({
      appliedFilters: {
        countries: codes.join(','),
        ...(year !== undefined && { year }),
        ...(input.poverty_line !== undefined && { povertyLine: input.poverty_line }),
        ...(welfareType !== undefined && { welfareType }),
        ...(reportingLevel !== undefined && { reportingLevel }),
        fillGaps: input.fill_gaps,
        page: input.page,
        perPage,
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    if (result.total === 0) {
      ctx.enrich.notice(
        input.fill_gaps
          ? 'No estimates for the requested filter. PIP covers individual economies from 1963 onward but not every economy in every year; widen the year, drop welfare_type or reporting_level, or check the country code.'
          : 'No estimates for the requested filter. fill_gaps is false, so only years covered by an actual survey are returned — set fill_gaps to true for an interpolated estimate, or use year="all" to see which years do have surveys.',
      );
    } else if (result.gapFilled) {
      ctx.enrich.notice(
        'Some rows are gap-filled: no survey covers those years, so PIP estimated the poverty measures and published no distributional data alongside them. Their gini, mld, polarization, and decileShares are null by design. Read estimationType per row to tell a survey-derived row from an estimated one — the two come from different upstream series, so their poverty figures are close but not on the same footing.',
      );
    }

    return { estimates: result.rows };
  },

  format: (result) => {
    if (result.estimates.length === 0) {
      return [
        { type: 'text', text: '# Poverty and Inequality Estimates\n\nNo estimates returned.' },
      ];
    }

    const lines: string[] = ['# Poverty and Inequality Estimates'];

    for (const row of result.estimates) {
      lines.push(
        `\n## ${row.countryName} (${row.countryCode}) — ${row.reportingYear}, ${row.reportingLevel}`,
        `- **region:** ${row.regionName} (${row.regionCode})`,
        `- **welfareType:** ${row.welfareType} | **povertyLine:** ${row.povertyLine}/day PPP`,
        `- **headcount:** ${row.headcount} | **povertyGap:** ${row.povertyGap} | **povertySeverity:** ${row.povertySeverity} | **watts:** ${row.watts}`,
        `- **mean:** ${row.mean} | **median:** ${row.median} | **population:** ${row.population}`,
        `- **gini:** ${row.gini} | **mld:** ${row.mld} | **polarization:** ${row.polarization}`,
        `- **decileShares:** ${row.decileShares === null ? 'null' : row.decileShares.join(', ')}`,
        `- **estimationType:** ${row.estimationType} | **isInterpolated:** ${row.isInterpolated} | **surveyYear:** ${row.surveyYear} | **surveyAcronym:** ${row.surveyAcronym || 'none'}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
