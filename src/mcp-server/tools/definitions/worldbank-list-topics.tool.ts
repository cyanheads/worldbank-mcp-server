/**
 * @fileoverview List all 21 World Bank thematic topics. Used to browse the indicator
 * space and find topic IDs for filtering worldbank_search_indicators.
 * @module mcp-server/tools/definitions/worldbank-list-topics.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankListTopics = tool('worldbank_list_topics', {
  title: 'List World Bank Topics',
  description:
    'Lists all 21 World Bank thematic topics (Economy & Growth, Health, Education, etc.) with descriptions. ' +
    'Use to browse the indicator space or find a topic_id for worldbank_search_indicators.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({
    topics: z
      .array(
        z.object({
          id: z.string().describe('Topic ID for use in worldbank_search_indicators.'),
          name: z.string().describe('Topic name.'),
          sourceNote: z.string().describe('Brief description of the topic.'),
        }),
      )
      .describe('All 21 World Bank thematic topics.'),
  }),

  async handler(_input, ctx) {
    ctx.log.info('Listing World Bank topics');
    const topics = await getWorldBankApiService().listTopics(ctx);
    return { topics };
  },

  format: (result) => {
    const lines: string[] = [`**Topics (${result.topics.length} total)**\n`];
    for (const t of result.topics) {
      lines.push(`### ${t.name} (ID: ${t.id})`);
      if (t.sourceNote) lines.push(t.sourceNote);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
