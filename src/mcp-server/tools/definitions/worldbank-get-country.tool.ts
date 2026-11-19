/**
 * @fileoverview Fetch full metadata for a specific country or aggregate entity.
 * @module mcp-server/tools/definitions/worldbank-get-country.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  COUNTRY_CODE,
  COUNTRY_CODE_MESSAGE,
  isAllSelector,
} from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankGetCountry = tool('worldbank_get_country', {
  title: 'Get World Bank Country',
  description:
    'Fetch metadata for one country or aggregate: ISO codes, region, income level, lending type, capital, and coordinates. Browse codes with worldbank_list_countries.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    country_code: z
      .string()
      .regex(COUNTRY_CODE, COUNTRY_CODE_MESSAGE)
      .describe(
        'One ISO2 (US), ISO3 (USA), or World Bank aggregate (EAS, HIC, WLD) code; not "all" or a list.',
      ),
  }),
  output: z.object({
    id: z.string().describe('Country or aggregate ID.'),
    iso2: z.string().describe('ISO2 code.'),
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
    capitalCity: z.string().describe('Capital city.'),
    longitude: z.string().describe('Capital longitude.'),
    latitude: z.string().describe('Capital latitude.'),
    isAggregate: z
      .boolean()
      .describe(
        'True for a regional or income-group aggregate, whose capitalCity, longitude, and latitude are empty.',
      ),
  }),

  errors: [
    {
      reason: 'country_not_found',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'No country or aggregate has this code.',
      recovery: 'Use worldbank_list_countries to browse valid ISO2, ISO3, and aggregate codes.',
    },
    {
      reason: 'multiple_countries',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The code selects more than one country, as "all" does.',
      recovery:
        'Pass a single country code, or use worldbank_list_countries to list several countries.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      thrownBy: 'service',
      when: "The World Bank Indicators API did not answer within the call's 50-second budget.",
      recovery:
        'The request is valid. Repeat the same call unchanged after about a minute: the World Bank Indicators API finishes a request after this server stops waiting and caches the answer, so the repeat is usually served from that cache. A changed call starts a new computation.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching country', { countryCode: input.country_code });
    if (isAllSelector(input.country_code)) {
      throw ctx.fail(
        'multiple_countries',
        `Country code "${input.country_code}" selects every country rather than one.`,
        { countryCode: input.country_code },
      );
    }
    try {
      return await getWorldBankApiService().getCountry(input.country_code, ctx);
    } catch (err) {
      if (err instanceof McpError && err.data?.reason === 'country_not_found') {
        throw ctx.fail('country_not_found', err.message, {
          ...err.data,
          countryCode: input.country_code,
        });
      }
      if (err instanceof McpError && err.data?.reason === 'multiple_countries') {
        throw ctx.fail('multiple_countries', err.message, {
          ...err.data,
          countryCode: input.country_code,
        });
      }
      throw err;
    }
  },

  format: (result) => {
    const lines: string[] = [
      `${escapeMarkdownInline(result.name)} (${escapeMarkdownInline(result.id)})`,
    ];
    lines.push(`**ISO2:** ${escapeMarkdownInline(result.iso2 || 'N/A')}`);
    lines.push(
      `**Region:** ${escapeMarkdownInline(result.region.name || result.region.id || 'N/A')} (${escapeMarkdownInline(result.region.id)})`,
    );
    lines.push(
      `**Income Level:** ${escapeMarkdownInline(result.incomeLevel.name || result.incomeLevel.id || 'N/A')} (${escapeMarkdownInline(result.incomeLevel.id)})`,
    );
    lines.push(`**Lending Type:** ${escapeMarkdownInline(result.lendingType || 'N/A')}`);
    if (result.capitalCity) lines.push(`**Capital:** ${escapeMarkdownInline(result.capitalCity)}`);
    if (result.longitude && result.latitude) {
      lines.push(
        `**Coordinates:** ${escapeMarkdownInline(result.latitude)}, ${escapeMarkdownInline(result.longitude)}`,
      );
    }
    lines.push(`**Is Aggregate:** ${result.isAggregate ? 'Yes' : 'No'}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
