/**
 * @fileoverview Fetch full metadata for a known World Bank indicator ID.
 * @module mcp-server/tools/definitions/worldbank-get-indicator.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankGetIndicator = tool('worldbank_get_indicator', {
  title: 'Get World Bank Indicator',
  description:
    'Fetches complete metadata for a single World Bank indicator by its ID: name, description, source dataset, ' +
    'source organization, unit, and thematic topics. ' +
    'Use worldbank_search_indicators to discover indicator IDs if you only know the concept.',
  annotations: { readOnlyHint: true },
  input: z.object({
    indicator_id: z
      .string()
      .min(1)
      .describe(
        'Indicator code (e.g. NY.GDP.PCAP.CD, SP.POP.TOTL). Use worldbank_search_indicators to find valid IDs.',
      ),
  }),
  output: z.object({
    id: z.string().describe('Indicator ID.'),
    name: z.string().describe('Indicator name.'),
    unit: z.string().describe('Unit of measurement (empty when not specified).'),
    sourceId: z.string().describe('Source dataset ID.'),
    sourceName: z.string().describe('Source dataset name.'),
    sourceNote: z.string().describe('Detailed indicator description from the source.'),
    sourceOrganization: z.string().describe('Organization that collects or publishes this data.'),
    topics: z
      .array(
        z.object({
          id: z.string().describe('Topic ID.'),
          name: z.string().describe('Topic name.'),
        }),
      )
      .describe('Thematic topics this indicator belongs to.'),
  }),

  errors: [
    {
      reason: 'indicator_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The indicator ID does not exist in the World Bank API.',
      recovery: 'Use worldbank_search_indicators to find valid indicator IDs by keyword or topic.',
    },
  ],

  handler(input, ctx) {
    ctx.log.info('Fetching indicator', { indicatorId: input.indicator_id });
    return getWorldBankApiService().getIndicator(input.indicator_id, ctx);
  },

  format: (result) => {
    const lines: string[] = [`# ${result.name}`];
    lines.push(`**ID:** \`${result.id}\``);
    if (result.unit) lines.push(`**Unit:** ${result.unit}`);
    lines.push(
      `**Source:** ${result.sourceName || result.sourceId || 'N/A'} (ID: ${result.sourceId})`,
    );
    if (result.sourceOrganization) lines.push(`**Organization:** ${result.sourceOrganization}`);
    if (result.topics.length > 0) {
      lines.push(`**Topics:** ${result.topics.map((t) => `${t.name} (${t.id})`).join(', ')}`);
    }
    if (result.sourceNote) {
      lines.push(`\n**Description:**\n${result.sourceNote}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
