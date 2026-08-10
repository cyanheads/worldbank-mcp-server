/**
 * @fileoverview World Bank country metadata resource. Stable, addressable reference
 * for country ISO codes and aggregate codes.
 * @module mcp-server/resources/definitions/worldbank-country.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankCountryResource = resource('worldbank://country/{countryCode}', {
  name: 'worldbank-country',
  title: 'World Bank Country',
  description:
    'Country metadata for a known country or aggregate code: ISO codes, region, income level, capital, and coordinates. ' +
    'Accepts ISO2 (US), ISO3 (USA), or World Bank aggregate codes (EAS, HIC). ' +
    'Use worldbank_list_countries to browse valid codes.',
  mimeType: 'application/json',
  params: z.object({
    countryCode: z
      .string()
      .describe('ISO2, ISO3, or World Bank aggregate code (e.g. US, USA, EAS, HIC).'),
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
      .describe('World Bank region.'),
    incomeLevel: z
      .object({
        id: z.string().describe('Income level code.'),
        name: z.string().describe('Income level name.'),
      })
      .describe('World Bank income classification.'),
    lendingType: z.string().describe('World Bank lending type.'),
    capitalCity: z.string().describe('Capital city name.'),
    longitude: z.string().describe('Capital longitude.'),
    latitude: z.string().describe('Capital latitude.'),
    isAggregate: z.boolean().describe('True for regional or income-group aggregates.'),
  }),

  errors: [
    {
      reason: 'country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The country code does not exist in the World Bank API.',
      recovery: 'Use worldbank_list_countries to browse valid ISO2, ISO3, and aggregate codes.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Reading country resource', { countryCode: params.countryCode });
    try {
      return await getWorldBankApiService().getCountry(params.countryCode, ctx);
    } catch (err) {
      // Only an upstream miss is a not-found. Network failures, timeouts, and
      // 5xx keep their own classification so the caller retries instead of
      // concluding the country doesn't exist.
      if (err instanceof McpError && err.data?.reason === 'country_not_found') {
        throw ctx.fail('country_not_found', err.message, {
          ...ctx.recoveryFor('country_not_found'),
          countryCode: params.countryCode,
        });
      }
      throw err;
    }
  },
});
