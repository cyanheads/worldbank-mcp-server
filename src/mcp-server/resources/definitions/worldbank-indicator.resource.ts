/**
 * @fileoverview World Bank indicator metadata resource. Stable, addressable reference
 * for known indicator IDs.
 * @module mcp-server/resources/definitions/worldbank-indicator.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
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
        z.object({
          id: z.string().describe('Topic ID.'),
          name: z.string().describe('Topic name.'),
        }),
      )
      .describe('Thematic topics.'),
  }),

  async handler(params, ctx) {
    ctx.log.debug('Reading indicator resource', { indicatorId: params.indicatorId });
    const indicator = await getWorldBankApiService()
      .getIndicator(params.indicatorId, ctx)
      .catch((err) => {
        // Rethrow as notFound for resource semantics
        throw notFound(`Indicator "${params.indicatorId}" not found.`, {
          indicatorId: params.indicatorId,
          cause: err,
        });
      });
    return indicator;
  },
});
