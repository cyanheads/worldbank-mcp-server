/**
 * @fileoverview Fetch full metadata for a known World Bank indicator ID.
 * @module mcp-server/tools/definitions/worldbank-get-indicator.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  INDICATOR_ID,
  INDICATOR_ID_MESSAGE,
  isAllSelector,
} from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankGetIndicator = tool('worldbank_get_indicator', {
  title: 'Get World Bank Indicator',
  description:
    'Fetch metadata for one World Bank indicator: name, description, unit, source dataset, source organization, and topics. Find IDs with worldbank_search_indicators.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    indicator_id: z
      .string()
      .regex(INDICATOR_ID, INDICATOR_ID_MESSAGE)
      .describe('One indicator ID (NY.GDP.PCAP.CD); not "all" or a list.'),
  }),
  output: z.object({
    id: z.string().describe('Indicator ID.'),
    name: z.string().describe('Indicator name.'),
    unit: z.string().describe('Unit; empty when unspecified.'),
    sourceId: z.string().describe('Source dataset ID.'),
    sourceName: z.string().describe('Source dataset name.'),
    sourceNote: z.string().describe("The source's description of the indicator."),
    sourceOrganization: z.string().describe('Organization that collects or publishes the data.'),
    topics: z
      .array(
        z
          .object({
            id: z.string().describe('Topic ID.'),
            name: z.string().describe('Topic name.'),
          })
          .describe('A topic.'),
      )
      .describe('Thematic topics of the indicator.'),
  }),

  errors: [
    {
      reason: 'indicator_not_found',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'No indicator has this ID.',
      recovery: 'Use worldbank_search_indicators to find valid indicator IDs by keyword or topic.',
    },
    {
      reason: 'multiple_indicators',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The ID selects more than one indicator, as "all" does.',
      recovery:
        'Pass a single indicator ID, or use worldbank_search_indicators to list several indicators.',
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
    ctx.log.info('Fetching indicator', { indicatorId: input.indicator_id });
    if (isAllSelector(input.indicator_id)) {
      throw ctx.fail(
        'multiple_indicators',
        `Indicator ID "${input.indicator_id}" selects the whole catalog rather than one indicator.`,
        { indicatorId: input.indicator_id },
      );
    }
    try {
      return await getWorldBankApiService().getIndicator(input.indicator_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.data?.reason === 'indicator_not_found') {
        throw ctx.fail('indicator_not_found', err.message, {
          ...err.data,
          indicatorId: input.indicator_id,
        });
      }
      if (err instanceof McpError && err.data?.reason === 'multiple_indicators') {
        throw ctx.fail('multiple_indicators', err.message, {
          ...err.data,
          indicatorId: input.indicator_id,
        });
      }
      throw err;
    }
  },

  format: (result) => {
    const lines: string[] = [escapeMarkdownInline(result.name)];
    lines.push(`**ID:** ${escapeMarkdownInline(result.id)}`);
    if (result.unit) lines.push(`**Unit:** ${escapeMarkdownInline(result.unit)}`);
    lines.push(
      `**Source:** ${escapeMarkdownInline(result.sourceName || result.sourceId || 'N/A')} (ID: ${escapeMarkdownInline(result.sourceId)})`,
    );
    if (result.sourceOrganization)
      lines.push(`**Organization:** ${escapeMarkdownInline(result.sourceOrganization)}`);
    if (result.topics.length > 0) {
      lines.push(
        `**Topics:** ${result.topics.map((t) => `${escapeMarkdownInline(t.name)} (${escapeMarkdownInline(t.id)})`).join(', ')}`,
      );
    }
    if (result.sourceNote) {
      lines.push(`\n**Description:**\n${escapeMarkdownInline(result.sourceNote)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
