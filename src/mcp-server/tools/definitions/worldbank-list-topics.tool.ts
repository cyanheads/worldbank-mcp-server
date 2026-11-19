/**
 * @fileoverview List all 21 World Bank thematic topics. Used to browse the indicator
 * space and find topic IDs for filtering worldbank_search_indicators.
 * @module mcp-server/tools/definitions/worldbank-list-topics.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankListTopics = tool('worldbank_list_topics', {
  title: 'List World Bank Topics',
  description:
    'List the 21 World Bank thematic topics (Economy & Growth, Health, Education, and others) with descriptions, to browse indicators by theme or find a topic_id for worldbank_search_indicators.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({}),
  output: z.object({
    topics: z
      .array(
        z
          .object({
            id: z.string().describe('Topic ID.'),
            name: z.string().describe('Topic name.'),
            sourceNote: z.string().describe('Topic description.'),
          })
          .describe('A topic.'),
      )
      .describe('Every topic.'),
  }),

  errors: [
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

  async handler(_input, ctx) {
    ctx.log.info('Listing World Bank topics');
    const topics = await getWorldBankApiService().listTopics(ctx);
    return { topics };
  },

  format: (result) => {
    const lines: string[] = [`**Topics (${result.topics.length} total)**\n`];
    for (const t of result.topics) {
      lines.push(`${escapeMarkdownInline(t.name)} (ID: ${escapeMarkdownInline(t.id)})`);
      if (t.sourceNote) lines.push(escapeMarkdownInline(t.sourceNote));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
