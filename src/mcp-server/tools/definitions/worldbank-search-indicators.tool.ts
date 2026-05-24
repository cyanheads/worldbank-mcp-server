/**
 * @fileoverview Search the World Bank indicator catalog by keyword, topic, or source.
 * The primary discovery entry point for finding indicator IDs.
 * @module mcp-server/tools/definitions/worldbank-search-indicators.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankSearchIndicators = tool('worldbank_search_indicators', {
  title: 'Search World Bank Indicators',
  description:
    'Searches the 29,500+ World Bank indicator catalog by keyword, topic, or source. ' +
    'Returns indicator IDs and metadata for chaining into worldbank_get_data. ' +
    'At least one of query, topic_id, or source_id must be provided. ' +
    'When combined with topic_id or source_id, keyword filtering applies across all results in that topic or source. ' +
    'Use worldbank_list_topics for topic IDs, worldbank_list_sources for source IDs.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Keyword search terms. At least one of query, topic_id, or source_id must be provided.',
      ),
    topic_id: z
      .string()
      .optional()
      .describe(
        'Filter by topic ID (e.g. "1" for Agriculture, "3" for Economy & Growth). Use worldbank_list_topics to browse valid IDs.',
      ),
    source_id: z
      .string()
      .optional()
      .describe(
        'Filter by data source ID (e.g. "2" for World Development Indicators). Use worldbank_list_sources to browse valid IDs.',
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Results per page (default: server default, max: 100).'),
  }),
  output: z.object({
    indicators: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe(
                'Indicator ID (e.g. NY.GDP.PCAP.CD). Use as indicator_id in worldbank_get_data.',
              ),
            name: z.string().describe('Indicator name.'),
            sourceId: z.string().describe('Source dataset ID.'),
            sourceName: z.string().describe('Source dataset name.'),
            sourceNote: z.string().describe('Brief indicator description.'),
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
          })
          .describe('A matching indicator with metadata.'),
      )
      .describe('Matching indicators for this page.'),
    total: z.number().describe('Total matching indicators before pagination.'),
    page: z.number().describe('Current page number.'),
    pages: z.number().describe('Total number of pages.'),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when no indicators matched — suggests how to broaden the search.'),
  }),

  errors: [
    {
      reason: 'missing_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of query, topic_id, or source_id were provided.',
      recovery:
        'Provide a keyword query, a topic_id from worldbank_list_topics, or a source_id from worldbank_list_sources.',
    },
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No indicators matched the query.',
      recovery: 'Broaden the query, try a synonym, or browse by topic using worldbank_list_topics.',
    },
  ],

  async handler(input, ctx) {
    const query = input.query?.trim() ? input.query.trim() : undefined;
    const topicId = input.topic_id?.trim() ? input.topic_id.trim() : undefined;
    const sourceId = input.source_id?.trim() ? input.source_id.trim() : undefined;

    if (!query && !topicId && !sourceId) {
      throw ctx.fail(
        'missing_filter',
        'At least one of query, topic_id, or source_id must be provided.',
        {
          recovery: {
            hint: 'Provide a keyword query, a topic_id from worldbank_list_topics, or a source_id from worldbank_list_sources.',
          },
        },
      );
    }

    const perPage = input.per_page ?? getServerConfig().defaultPerPage;

    ctx.log.info('Searching indicators', { query, topicId, sourceId, page: input.page, perPage });

    const result = await getWorldBankApiService().searchIndicators(
      {
        ...(query !== undefined && { query }),
        ...(topicId !== undefined && { topicId }),
        ...(sourceId !== undefined && { sourceId }),
        page: input.page,
        perPage,
      },
      ctx,
    );

    if (result.indicators.length === 0) {
      const hint = query
        ? `No indicators matched "${query}". Try a synonym or browse by topic using worldbank_list_topics.`
        : 'No indicators found for the specified filter. Try a different topic or source ID.';
      return {
        indicators: [],
        total: 0,
        page: result.page,
        pages: result.pages,
        message: hint,
      };
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `**Indicators — Page ${result.page} of ${result.pages} (${result.total} total)**\n`,
    ];
    if (result.message) {
      lines.push(`> ${result.message}\n`);
    }
    for (const ind of result.indicators) {
      lines.push(`### ${ind.name}`);
      lines.push(
        `**ID:** \`${ind.id}\` | **Source:** ${ind.sourceName || 'N/A'} (ID: ${ind.sourceId || 'N/A'})`,
      );
      if (ind.topics.length > 0) {
        lines.push(`**Topics:** ${ind.topics.map((t) => `${t.name} (${t.id})`).join(', ')}`);
      }
      if (ind.sourceNote) lines.push(ind.sourceNote);
    }
    if (result.page < result.pages) {
      lines.push(`\n_Use page=${result.page + 1} for more results._`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
