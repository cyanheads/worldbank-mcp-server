/**
 * @fileoverview World Bank indicator metadata resource. Stable, addressable reference
 * for known indicator IDs.
 * @module mcp-server/resources/definitions/worldbank-indicator.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankIndicatorResource = resource('worldbank://indicator/{indicatorId}', {
  name: 'worldbank-indicator',
  title: 'World Bank Indicator',
  description:
    'Indicator metadata for a known World Bank indicator ID: name, description, source, and thematic topics. ' +
    'Stable reference URI — use worldbank_search_indicators to discover indicator IDs.',
  mimeType: 'application/json',
  params: z.object({
    indicatorId: z.string().describe('Indicator ID (e.g. NY.GDP.PCAP.CD).'),
  }),
  output: z.object({
    id: z.string().describe('Indicator ID.'),
    name: z.string().describe('Indicator name.'),
    unit: z.string().describe('Unit of measurement.'),
    sourceId: z.string().describe('Source dataset ID.'),
    sourceName: z.string().describe('Source dataset name.'),
    sourceNote: z.string().describe('Detailed indicator description.'),
    sourceOrganization: z.string().describe('Organization that publishes this data.'),
    topics: z
      .array(
        z
          .object({
            id: z.string().describe('Topic ID.'),
            name: z.string().describe('Topic name.'),
          })
          .describe('A thematic topic entry.'),
      )
      .describe('Thematic topics.'),
  }),

  errors: [
    {
      reason: 'indicator_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The indicator ID does not exist in the World Bank API.',
      recovery: 'Use worldbank_search_indicators to find valid indicator IDs by keyword or topic.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Reading indicator resource', { indicatorId: params.indicatorId });
    try {
      return await getWorldBankApiService().getIndicator(params.indicatorId, ctx);
    } catch (err) {
      // Only an upstream miss is a not-found. Network failures, timeouts, and
      // 5xx keep their own classification so the caller retries instead of
      // concluding the indicator doesn't exist.
      if (err instanceof McpError && err.data?.reason === 'indicator_not_found') {
        throw ctx.fail('indicator_not_found', err.message, {
          ...ctx.recoveryFor('indicator_not_found'),
          indicatorId: params.indicatorId,
        });
      }
      throw err;
    }
  },
});
