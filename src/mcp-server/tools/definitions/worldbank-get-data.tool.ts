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
    'For "all" countries, use pagination (per_page up to 1000) since the API returns ~266 entries per indicator.',
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
        z.string().describe('A single country code or "all".'),
        z.array(z.string().describe('A country code.')).describe('An array of country codes.'),
      ])
      .describe(
        'Country codes. Accepts: ISO2 (US, CN), ISO3 (USA, CHN), regional aggregate codes (EAS, LCN, MEA, SAS, SSF, ECS, NAC), ' +
          'income group codes (HIC, UMC, LMC, LIC), world code (WLD), or "all" for all 266 entries (use pagination). ' +
          'Pass a single string or an array of codes for multi-country queries.',
      ),
    date_range: z
      .string()
      .optional()
      .describe(
        'Year or year range in YYYY or YYYY:YYYY format (e.g. "2020" or "2010:2023"). Mutually exclusive with mrv.',
      ),
    mrv: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe(
        'Return the N most recent available values (1–10). Mutually exclusive with date_range.',
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
  ],

  async handler(input, ctx) {
    if (input.date_range && input.mrv !== undefined) {
      throw ctx.fail('invalid_params', 'Provide either date_range or mrv, not both.', {
        recovery: { hint: 'Remove date_range to use mrv, or remove mrv to use date_range.' },
      });
    }

    const dateRange = input.date_range?.trim() ? input.date_range.trim() : undefined;
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;

    ctx.log.info('Fetching indicator data', {
      indicatorId: input.indicator_id,
      countries: Array.isArray(input.countries) ? input.countries.join(';') : input.countries,
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
      }
      throw err;
    }

    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    if (result.data.length === 0) {
      ctx.enrich.notice(
        'No observations returned for the requested filter. ' +
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
