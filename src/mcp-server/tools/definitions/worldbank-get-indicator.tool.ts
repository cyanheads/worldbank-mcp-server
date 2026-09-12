/**
 * @fileoverview Fetch full metadata for a known World Bank indicator ID.
 * @module mcp-server/tools/definitions/worldbank-get-indicator.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  INDICATOR_ID,
  INDICATOR_ID_MESSAGE,
  isAllSelector,
} from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankGetIndicator = tool('worldbank_get_indicator', {
  title: 'Get World Bank Indicator',
  description:
    'Fetch metadata for one World Bank indicator by ID: name, description, unit, source dataset, source organization, and thematic topics. Use worldbank_search_indicators to find the ID when only the concept is known; "all" and lists of IDs are rejected.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    indicator_id: z
      .string()
      .regex(INDICATOR_ID, INDICATOR_ID_MESSAGE)
      .describe(
        'One indicator code (e.g. NY.GDP.PCAP.CD, SP.POP.TOTL) — not "all" or a list of codes. Use worldbank_search_indicators to find valid IDs.',
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
        z
          .object({
            id: z.string().describe('Topic ID.'),
            name: z.string().describe('Topic name.'),
          })
          .describe('A thematic topic entry.'),
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
    {
      reason: 'multiple_indicators',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The ID is "all", or another selector the World Bank resolves to more than one indicator.',
      recovery:
        'Pass a single indicator ID, or use worldbank_search_indicators to list several indicators.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching indicator', { indicatorId: input.indicator_id });
    if (isAllSelector(input.indicator_id)) {
      throw ctx.fail(
        'multiple_indicators',
        `Indicator ID "${input.indicator_id}" selects the whole catalog rather than one indicator.`,
        { ...ctx.recoveryFor('multiple_indicators'), indicatorId: input.indicator_id },
      );
    }
    try {
      return await getWorldBankApiService().getIndicator(input.indicator_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.data?.reason === 'indicator_not_found') {
        throw ctx.fail('indicator_not_found', err.message, {
          ...ctx.recoveryFor('indicator_not_found'),
          indicatorId: input.indicator_id,
        });
      }
      if (err instanceof McpError && err.data?.reason === 'multiple_indicators') {
        throw ctx.fail('multiple_indicators', err.message, {
          ...ctx.recoveryFor('multiple_indicators'),
          indicatorId: input.indicator_id,
          matchedIds: err.data.matchedIds,
        });
      }
      throw err;
    }
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
