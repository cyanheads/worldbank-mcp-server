/**
 * @fileoverview World Bank country metadata resource. Stable, addressable reference
 * for country ISO codes and aggregate codes.
 * @module mcp-server/resources/definitions/worldbank-country.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  COUNTRY_CODE,
  COUNTRY_CODE_MESSAGE,
  isAllSelector,
} from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankCountryResource = resource('worldbank://country/{countryCode}', {
  name: 'worldbank-country',
  title: 'World Bank Country',
  description:
    'Read metadata for one country or aggregate code: ISO codes, region, income level, capital, and coordinates. Accepts an ISO2 (US), ISO3 (USA), or World Bank aggregate code (EAS, HIC); "all" and lists of codes are rejected. Use worldbank_list_countries to browse valid codes.',
  mimeType: 'application/json',
  params: z.object({
    countryCode: z
      .string()
      .regex(COUNTRY_CODE, COUNTRY_CODE_MESSAGE)
      .describe(
        'One ISO2, ISO3, or World Bank aggregate code (e.g. US, USA, EAS, HIC) — not "all" or a list of codes.',
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
    {
      reason: 'multiple_countries',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The code is "all", or another selector the World Bank resolves to more than one country.',
      recovery:
        'Pass a single country code, or use worldbank_list_countries to list several countries.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Reading country resource', { countryCode: params.countryCode });
    if (isAllSelector(params.countryCode)) {
      throw ctx.fail(
        'multiple_countries',
        `Country code "${params.countryCode}" selects every country rather than one.`,
        { ...ctx.recoveryFor('multiple_countries'), countryCode: params.countryCode },
      );
    }
    try {
      return await getWorldBankApiService().getCountry(params.countryCode, ctx);
    } catch (err) {
      // Only an upstream miss is a not-found. Network failures, timeouts, and
      // 5xx keep their own classification so the caller retries instead of
      // concluding the country doesn't exist.
      if (err instanceof McpError && err.data?.reason === 'country_not_found') {
        throw ctx.fail('country_not_found', err.message, {
          ...err.data,
          ...ctx.recoveryFor('country_not_found'),
          countryCode: params.countryCode,
        });
      }
      if (err instanceof McpError && err.data?.reason === 'multiple_countries') {
        throw ctx.fail('multiple_countries', err.message, {
          ...err.data,
          ...ctx.recoveryFor('multiple_countries'),
          countryCode: params.countryCode,
        });
      }
      throw err;
    }
  },
});
