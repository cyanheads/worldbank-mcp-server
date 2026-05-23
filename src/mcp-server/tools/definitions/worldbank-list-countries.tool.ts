/**
 * @fileoverview List World Bank countries and regional aggregates with metadata.
 * Filterable by region and income level.
 * @module mcp-server/tools/definitions/worldbank-list-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankListCountries = tool('worldbank_list_countries', {
  title: 'List World Bank Countries',
  description:
    'Lists countries and regional aggregates with metadata: ISO codes, region, income level, capital, and coordinates. ' +
    'Filterable by region code (e.g. EAS, SSF, NAC) and income level (LIC, LMC, UMC, HIC). ' +
    'By default, excludes regional/income-group aggregate entries and returns individual countries only. ' +
    'Set include_aggregates=true to also see region, income group, and world aggregate entities.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    region: z
      .string()
      .optional()
      .describe(
        'Filter by World Bank region code. Valid codes: EAS (East Asia & Pacific), ' +
          'ECS (Europe & Central Asia), LCN (Latin America & Caribbean), ' +
          'MEA (Middle East & North Africa), NAC (North America), SAS (South Asia), SSF (Sub-Saharan Africa).',
      ),
    income_level: z
      .string()
      .optional()
      .describe(
        'Filter by income group code: LIC (Low income), LMC (Lower middle income), UMC (Upper middle income), HIC (High income).',
      ),
    include_aggregates: z
      .boolean()
      .default(false)
      .describe(
        'When true, includes regional, income-group, and world aggregate entries alongside individual countries. ' +
          'Default false (individual countries only).',
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(300)
      .optional()
      .describe('Results per page (default: server default, max: 300).'),
  }),
  output: z.object({
    countries: z
      .array(
        z
          .object({
            id: z.string().describe('Country or aggregate ID (ISO2 or WB aggregate code).'),
            iso2: z.string().describe('ISO2 country code.'),
            name: z.string().describe('Country or aggregate name.'),
            region: z
              .object({
                id: z.string().describe('Region code.'),
                name: z.string().describe('Region name.'),
              })
              .describe('World Bank region this country belongs to.'),
            incomeLevel: z
              .object({
                id: z.string().describe('Income level code.'),
                name: z.string().describe('Income level name.'),
              })
              .describe('World Bank income classification.'),
            lendingType: z.string().describe('World Bank lending type classification.'),
            capitalCity: z.string().describe('Capital city name (empty for aggregates).'),
            longitude: z.string().describe('Capital longitude (empty for aggregates).'),
            latitude: z.string().describe('Capital latitude (empty for aggregates).'),
            isAggregate: z
              .boolean()
              .describe(
                'True when this entry is a regional or income-group aggregate rather than an individual country.',
              ),
          })
          .describe('A country or aggregate entry.'),
      )
      .describe('Countries (and optionally aggregates) matching the filters.'),
    total: z
      .number()
      .describe(
        'Total matching entries before pagination (includes aggregates if include_aggregates=true).',
      ),
    page: z.number().describe('Current page number.'),
    pages: z.number().describe('Total number of pages.'),
  }),

  handler(input, ctx) {
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;
    ctx.log.info('Listing countries', {
      region: input.region,
      incomeLevel: input.income_level,
      includeAggregates: input.include_aggregates,
      page: input.page,
    });
    const region = input.region?.trim() || undefined;
    const incomeLevel = input.income_level?.trim() || undefined;
    return getWorldBankApiService().listCountries(
      {
        ...(region !== undefined && { region }),
        ...(incomeLevel !== undefined && { incomeLevel }),
        includeAggregates: input.include_aggregates,
        page: input.page,
        perPage,
      },
      ctx,
    );
  },

  format: (result) => {
    const lines: string[] = [
      `**Countries — Page ${result.page} of ${result.pages} (${result.total} total)**\n`,
    ];
    for (const c of result.countries) {
      const tag = c.isAggregate ? ' [Aggregate]' : '';
      lines.push(`### ${c.name} (${c.id}${tag})`);
      lines.push(
        `**ISO2:** ${c.iso2 || 'N/A'} | **Region:** ${c.region.name} (${c.region.id || 'N/A'}) | **Income:** ${c.incomeLevel.name} (${c.incomeLevel.id || 'N/A'})`,
      );
      lines.push(`**Lending Type:** ${c.lendingType || 'N/A'}`);
      if (c.capitalCity) lines.push(`**Capital:** ${c.capitalCity}`);
      if (c.longitude && c.latitude) lines.push(`**Coordinates:** ${c.latitude}, ${c.longitude}`);
    }
    if (result.page < result.pages) {
      lines.push(`\n_Use page=${result.page + 1} for more results._`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
