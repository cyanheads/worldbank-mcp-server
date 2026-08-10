/**
 * @fileoverview Query World Bank indicator values for countries across a time range.
 * The primary data-access tool.
 * @module mcp-server/tools/definitions/worldbank-get-data.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankGetData = tool('worldbank_get_data', {
  title: 'Get World Bank Indicator Data',
  description:
    'Queries World Bank indicator values for one or more countries across a time range. ' +
    'The primary data-access tool — use worldbank_search_indicators to find indicator_id values. ' +
    'Returns observations with null values when data is not available for a country×year cell (common for sparse series). ' +
    'Specify either date_range (historical analysis) or mrv (most recent N values), not both. ' +
    'For "all" countries, use pagination (per_page up to 1000) — the API returns several hundred entries per indicator.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    indicator_id: z
      .string()
      .min(1)
      .describe(
        'Indicator code to query (e.g. NY.GDP.PCAP.CD, SP.POP.TOTL). Use worldbank_search_indicators to find valid IDs.',
      ),
    countries: z
      .union([
        z
          .string()
          .regex(/[^\s;]/, 'Provide at least one country code, or "all" for every entry.')
          .describe('A single country code or "all".'),
        z
          .array(z.string().describe('A country code.'))
          .min(1)
          .refine(
            (codes) => codes.some((code) => code.trim().length > 0),
            'Provide at least one country code, or "all" for every entry.',
          )
          .describe('An array of country codes.'),
      ])
      .describe(
        'Country codes. Accepts: ISO2 (US, CN), ISO3 (USA, CHN), regional aggregate codes (EAS, LCN, MEA, SAS, SSF, ECS, NAC), ' +
          'income group codes (HIC, UMC, LMC, LIC), world code (WLD), or "all" for every entry (use pagination). ' +
          'Pass a single string or an array of codes for multi-country queries. ' +
          'At least one code is required — an empty value is rejected rather than treated as "all".',
      ),
    date_range: z
      .string()
      /**
       * Both endpoints of a range must share a period type — the API rejects a
       * mixed range such as `2020Q1:2021`. Surrounding whitespace and a blank
       * value are tolerated because form-based clients submit every field; the
       * handler treats blank as absent.
       */
      .regex(
        /^\s*(?:\d{4}(?::\d{4})?|\d{4}[Qq][1-4](?::\d{4}[Qq][1-4])?|\d{4}[Mm](?:0[1-9]|1[0-2])(?::\d{4}[Mm](?:0[1-9]|1[0-2]))?)?\s*$/,
        'date_range must be a single period or a range of two periods of the same type: YYYY, YYYYQ1–Q4, or YYYYM01–M12 (e.g. "2020", "2010:2023", "2020Q1:2021Q4", "2020M01:2020M06").',
      )
      /**
       * Every period form is fixed-width and zero-padded, and the pattern above
       * already forces both endpoints to the same form, so ordering is a plain
       * string comparison.
       */
      .refine((value) => {
        const [start, end] = value.trim().toUpperCase().split(':');
        return end === undefined || (start ?? '') <= end;
      }, 'date_range must run earliest period first.')
      .optional()
      .describe(
        'Time window to filter observations to. Accepts a whole year (`2020`), a quarter (`2020Q1`), or a month (`2020M03`), ' +
          'or a range of two periods of the same type separated by a colon, earliest first (`2010:2023`, `2020Q1:2021Q4`, `2020M01:2020M06`). ' +
          'A window and an observation match whenever the periods overlap, so a year window also selects the quarters and months inside it. ' +
          'A window covering no part of the series returns zero observations rather than the full series. ' +
          'Mutually exclusive with mrv.',
      ),
    mrv: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Return the N most recent available values per country (1–100), clamped upstream to the length of the series. ' +
          'Rows are mrv × countries, so page through them with per_page. Mutually exclusive with date_range.',
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        'Results per page (default: server default, max: 1000). Use higher values for "all" country queries.',
      ),
  }),
  output: z.object({
    data: z
      .array(
        z
          .object({
            countryCode: z.string().describe('ISO2 country code (or aggregate code).'),
            countryIso3: z.string().describe('ISO3 country code (empty for some aggregates).'),
            countryName: z.string().describe('Country or aggregate name.'),
            date: z.string().describe('Year of observation (YYYY format).'),
            value: z
              .number()
              .nullable()
              .describe(
                'Indicator value. Null when data is not available for this country×year cell.',
              ),
            obsStatus: z
              .string()
              .describe(
                'Observation status code (empty string when no special status; non-empty values signal data quality notes).',
              ),
            isAggregate: z
              .boolean()
              .describe(
                'True when this row is a regional or income-group aggregate rather than an individual country.',
              ),
          })
          .describe('A single country×year observation.'),
      )
      .describe('Indicator observations for this page. Null values are common for sparse series.'),
    indicator: z
      .object({
        id: z.string().describe('Indicator ID echoed for chaining context.'),
        name: z.string().describe('Indicator name.'),
      })
      .describe('Indicator metadata echoed from the response.'),
    nullCount: z
      .number()
      .describe(
        'Count of null values on this page — indicates data sparsity for the requested filter.',
      ),
  }),

  // Agent-facing context: pagination totals and query orientation. Kept out of the
  // domain return so it reaches both structuredContent and content[] automatically.
  enrichment: {
    appliedFilters: z
      .object({
        indicatorId: z.string().describe('Indicator ID queried.'),
        countries: z
          .string()
          .describe(
            'Country codes as sent to the API — an array input is joined with semicolons, so this shows the normalized value.',
          ),
        dateRange: z
          .string()
          .optional()
          .describe('Date window applied, omitted when none was requested.'),
        mrv: z
          .number()
          .optional()
          .describe('Most-recent-values count applied, omitted when none was requested.'),
        page: z.number().describe('Page number requested.'),
        perPage: z.number().describe('Results per page used, including the server default.'),
      })
      .describe(
        'The effective parameters sent to the World Bank API — confirms country code normalization and which filters were in force for these observations.',
      ),
    totalCount: z.number().describe('Total observations before pagination.'),
    currentPage: z.number().describe('Current page number.'),
    totalPages: z.number().describe('Total number of pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint for sparse or empty result sets — suggests how to broaden the query.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      /**
       * A per-field `render` replaces the whole trailer line, `label` included,
       * so the heading has to be part of what it returns — otherwise the echo
       * lands as a bare run of `key=value` pairs among `**field:** value` lines
       * with nothing naming it.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          `indicator_id=${filters.indicatorId}`,
          `countries=${filters.countries}`,
          ...(filters.dateRange === undefined ? [] : [`date_range=${filters.dateRange}`]),
          ...(filters.mrv === undefined ? [] : [`mrv=${filters.mrv}`]),
          `page=${filters.page}`,
          `per_page=${filters.perPage}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'invalid_params',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both date_range and mrv are provided simultaneously.',
      recovery: 'Remove date_range to use mrv, or remove mrv to use date_range.',
    },
    {
      reason: 'indicator_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The indicator ID does not exist.',
      recovery: 'Use worldbank_search_indicators to find valid indicator IDs by keyword or topic.',
    },
    {
      reason: 'country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more country codes are invalid.',
      recovery: 'Use worldbank_list_countries to browse valid ISO2, ISO3, and aggregate codes.',
    },
    {
      reason: 'indicator_and_country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The indicator ID and the country codes are both invalid.',
      recovery:
        'Look the indicator up with worldbank_search_indicators and the codes with worldbank_list_countries before retrying.',
    },
  ],

  async handler(input, ctx) {
    if (input.date_range && input.mrv !== undefined) {
      throw ctx.fail('invalid_params', 'Provide either date_range or mrv, not both.', {
        recovery: { hint: 'Remove date_range to use mrv, or remove mrv to use date_range.' },
      });
    }

    const dateRange = input.date_range?.trim() ? input.date_range.trim() : undefined;
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;
    const countryCodes = Array.isArray(input.countries)
      ? input.countries.join(';')
      : input.countries;

    ctx.log.info('Fetching indicator data', {
      indicatorId: input.indicator_id,
      countries: countryCodes,
      dateRange,
      mrv: input.mrv,
      page: input.page,
    });

    let result: Awaited<ReturnType<ReturnType<typeof getWorldBankApiService>['getData']>>;
    try {
      result = await getWorldBankApiService().getData(
        {
          indicatorId: input.indicator_id,
          countries: input.countries,
          ...(dateRange !== undefined && { dateRange }),
          ...(input.mrv !== undefined && { mrv: input.mrv }),
          page: input.page,
          perPage,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const reason = err.data?.reason as string | undefined;
        if (reason === 'indicator_not_found') {
          throw ctx.fail('indicator_not_found', err.message, {
            ...ctx.recoveryFor('indicator_not_found'),
            indicatorId: input.indicator_id,
          });
        }
        if (reason === 'country_not_found') {
          throw ctx.fail('country_not_found', err.message, {
            ...ctx.recoveryFor('country_not_found'),
            countries: input.countries,
          });
        }
        if (reason === 'indicator_and_country_not_found') {
          throw ctx.fail('indicator_and_country_not_found', err.message, {
            ...ctx.recoveryFor('indicator_and_country_not_found'),
            indicatorId: input.indicator_id,
            countries: input.countries,
          });
        }
      }
      throw err;
    }

    ctx.enrich({
      appliedFilters: {
        indicatorId: input.indicator_id,
        countries: countryCodes,
        ...(dateRange !== undefined && { dateRange }),
        ...(input.mrv !== undefined && { mrv: input.mrv }),
        page: input.page,
        perPage,
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    if (result.data.length === 0) {
      ctx.enrich.notice(
        result.dateFilterDropped
          ? `No observations fall inside date_range "${dateRange}", though the series does carry data outside it. ` +
              'Broaden date_range or use mrv to fetch the most recent available values.'
          : 'No observations returned for the requested filter. ' +
              'Try broadening the date range, removing date filters, or using mrv=5 to fetch the most recent available values.',
      );
    }

    return {
      data: result.data,
      indicator: result.indicator,
      nullCount: result.nullCount,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `# ${result.indicator.name || result.indicator.id}`,
      `**ID:** \`${result.indicator.id}\` | **Null values this page:** ${result.nullCount}\n`,
    ];

    // Group by country for readability
    const byCountry = new Map<string, typeof result.data>();
    for (const d of result.data) {
      const key = `${d.countryCode}|${d.countryName}`;
      let bucket = byCountry.get(key);
      if (!bucket) {
        bucket = [];
        byCountry.set(key, bucket);
      }
      bucket.push(d);
    }

    for (const [key, rows] of byCountry) {
      const [code, name] = key.split('|');
      const aggTag = rows[0]?.isAggregate ? ' [Aggregate]' : '';
      const iso3 = rows[0]?.countryIso3;
      const iso3Str = iso3 ? ` / ${iso3}` : '';
      lines.push(`## ${name} (${code}${iso3Str})${aggTag}`);
      for (const row of rows) {
        const valStr = row.value !== null ? String(row.value) : 'No data';
        const statusStr = row.obsStatus ? ` [obs_status: ${row.obsStatus}]` : '';
        lines.push(`- **${row.date}:** ${valStr}${statusStr}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
