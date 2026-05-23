/**
 * @fileoverview Fetch full metadata for a specific country or aggregate entity.
 * @module mcp-server/tools/definitions/worldbank-get-country.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankGetCountry = tool('worldbank_get_country', {
  title: 'Get World Bank Country',
  description:
    'Fetches full metadata for a specific country or aggregate entity: region, income level, capital, coordinates, and lending type. ' +
    'Accepts ISO2 codes (US, DE), ISO3 codes (USA, DEU), or World Bank aggregate codes (EAS, HIC, WLD).',
  annotations: { readOnlyHint: true },
  input: z.object({
    country_code: z
      .string()
      .min(1)
      .describe(
        'Country code. Accepts ISO2 (US), ISO3 (USA), or aggregate code (EAS, HIC, WLD). Use worldbank_list_countries to browse valid codes.',
      ),
  }),
  output: z.object({
    id: z.string().describe('Country or aggregate ID.'),
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
      .describe('True when this entry is a regional or income-group aggregate.'),
  }),

  errors: [
    {
      reason: 'country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The country code does not exist in the World Bank API.',
      recovery: 'Use worldbank_list_countries to browse valid ISO2, ISO3, and aggregate codes.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching country', { countryCode: input.country_code });
    return getWorldBankApiService().getCountry(input.country_code, ctx);
  },

  format: (result) => {
    const lines: string[] = [`# ${result.name} (${result.id})`];
    lines.push(`**ISO2:** ${result.iso2 || 'N/A'}`);
    lines.push(
      `**Region:** ${result.region.name || result.region.id || 'N/A'} (${result.region.id})`,
    );
    lines.push(
      `**Income Level:** ${result.incomeLevel.name || result.incomeLevel.id || 'N/A'} (${result.incomeLevel.id})`,
    );
    lines.push(`**Lending Type:** ${result.lendingType || 'N/A'}`);
    if (result.capitalCity) lines.push(`**Capital:** ${result.capitalCity}`);
    if (result.longitude && result.latitude) {
      lines.push(`**Coordinates:** ${result.latitude}, ${result.longitude}`);
    }
    lines.push(`**Is Aggregate:** ${result.isAggregate ? 'Yes' : 'No'}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
