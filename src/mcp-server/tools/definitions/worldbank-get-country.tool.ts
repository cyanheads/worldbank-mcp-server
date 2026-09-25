/**
 * @fileoverview Fetch full metadata for a specific country or aggregate entity.
 * @module mcp-server/tools/definitions/worldbank-get-country.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  COUNTRY_CODE,
  COUNTRY_CODE_MESSAGE,
  isAllSelector,
} from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankGetCountry = tool('worldbank_get_country', {
  title: 'Get World Bank Country',
  description:
    'Fetch metadata for one country or aggregate entity: ISO codes, region, income level, lending type, capital, and coordinates. Accepts an ISO2 code (US, DE), an ISO3 code (USA, DEU), or a World Bank aggregate code (EAS, HIC, WLD); "all" and lists of codes are rejected. Use worldbank_list_countries to browse valid codes.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    country_code: z
      .string()
      .regex(COUNTRY_CODE, COUNTRY_CODE_MESSAGE)
      .describe(
        'One country code. Accepts ISO2 (US), ISO3 (USA), or aggregate code (EAS, HIC, WLD) — not "all" or a list of codes. Use worldbank_list_countries to browse valid codes.',
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
    {
      reason: 'multiple_countries',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The code is "all", or another selector the World Bank resolves to more than one country.',
      recovery:
        'Pass a single country code, or use worldbank_list_countries to list several countries.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching country', { countryCode: input.country_code });
    if (isAllSelector(input.country_code)) {
      throw ctx.fail(
        'multiple_countries',
        `Country code "${input.country_code}" selects every country rather than one.`,
        { ...ctx.recoveryFor('multiple_countries'), countryCode: input.country_code },
      );
    }
    try {
      return await getWorldBankApiService().getCountry(input.country_code, ctx);
    } catch (err) {
      if (err instanceof McpError && err.data?.reason === 'country_not_found') {
        throw ctx.fail('country_not_found', err.message, {
          ...err.data,
          ...ctx.recoveryFor('country_not_found'),
          countryCode: input.country_code,
        });
      }
      if (err instanceof McpError && err.data?.reason === 'multiple_countries') {
        throw ctx.fail('multiple_countries', err.message, {
          ...err.data,
          ...ctx.recoveryFor('multiple_countries'),
          countryCode: input.country_code,
        });
      }
      throw err;
    }
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
