/**
 * @fileoverview Search the World Bank indicator catalog by keyword, topic, or source.
 * The primary discovery entry point for finding indicator IDs.
 * @module mcp-server/tools/definitions/worldbank-search-indicators.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  CATALOG_FILTER_ID,
  SOURCE_ID_MESSAGE,
  TOPIC_ID_MESSAGE,
} from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankSearchIndicators = tool('worldbank_search_indicators', {
  title: 'Search World Bank Indicators',
  description:
    'Search the 29,500+ World Bank indicator catalog by keyword, topic, or source, returning indicator IDs and metadata for worldbank_get_data. Provide at least one of query, topic_id, or source_id; a topic and a source together narrow to indicators in both. A keyword query matches every term against indicator ID, name, and description, in any word order, across the whole catalog or the whole selected topic or source; punctuation is ignored, so the query needs at least one letter or digit. Exact ID or name matches rank first, then whole-phrase matches, then other ID/name matches, then description-only matches. Each indicator ID appears once, even where the catalog publishes it under two sources. Find topic IDs with worldbank_list_topics and source IDs with worldbank_list_sources.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Keyword search terms — an indicator name, ID, or any words from either (e.g. "GDP per capita", "NY.GDP.MKTP.CD", "CO2 emissions"). Every term must match; punctuation is ignored, so the query needs at least one letter or digit. At least one of query, topic_id, or source_id must be provided.',
      ),
    topic_id: z
      .string()
      .regex(CATALOG_FILTER_ID, TOPIC_ID_MESSAGE)
      .optional()
      .describe(
        'Filter by topic ID (e.g. "1" for Agriculture, "3" for Economy & Growth). Use worldbank_list_topics to browse valid IDs.',
      ),
    source_id: z
      .string()
      .regex(CATALOG_FILTER_ID, SOURCE_ID_MESSAGE)
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
  }),

  // Agent-facing context: pagination totals, query echo, and empty-result guidance.
  // Kept out of the domain return so it reaches both structuredContent and content[]
  // without a format() entry or format-parity concern.
  enrichment: {
    appliedFilters: z
      .object({
        query: z
          .string()
          .optional()
          .describe('Trimmed keyword query sent to the search, omitted when none was given.'),
        topicId: z
          .string()
          .optional()
          .describe('Topic ID the results were scoped to, omitted when none was given.'),
        sourceId: z
          .string()
          .optional()
          .describe('Source ID the results were scoped to, omitted when none was given.'),
      })
      .describe(
        'The effective search parameters, field by field — confirms which filter combination produced these results without parsing the effectiveQuery string.',
      ),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Active filters echoed: keyword, topic ID, and/or source ID that were applied.'),
    totalCount: z.number().describe('Total matching indicators before pagination.'),
    currentPage: z.number().describe('Current page number.'),
    totalPages: z.number().describe('Total number of pages.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no indicators matched — suggests how to broaden the search.'),
  },

  enrichmentTrailer: {
    appliedFilters: {
      /**
       * A per-field `render` replaces the whole trailer line, `label` included,
       * so the heading has to be part of what it returns. Without it this lands
       * as an unlabelled copy of the `effectiveQuery` line directly beneath it.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          ...(filters.query === undefined ? [] : [`query="${filters.query}"`]),
          ...(filters.topicId === undefined ? [] : [`topic_id=${filters.topicId}`]),
          ...(filters.sourceId === undefined ? [] : [`source_id=${filters.sourceId}`]),
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'missing_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of query, topic_id, or source_id were provided.',
      recovery:
        'Provide a keyword query, a topic_id from worldbank_list_topics, or a source_id from worldbank_list_sources.',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.NotFound,
      when: 'The topic_id or source_id does not exist upstream.',
      recovery:
        'Browse valid IDs with worldbank_list_topics or worldbank_list_sources, then retry with one of those.',
    },
    {
      reason: 'empty_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query contains no letters or digits once punctuation is ignored.',
      recovery:
        'Provide a keyword with letters or digits, or omit query to browse by topic_id or source_id.',
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
        ctx.recoveryFor('missing_filter'),
      );
    }

    const perPage = input.per_page ?? getServerConfig().defaultPerPage;

    ctx.log.info('Searching indicators', { query, topicId, sourceId, page: input.page, perPage });

    let result: Awaited<ReturnType<ReturnType<typeof getWorldBankApiService>['searchIndicators']>>;
    try {
      result = await getWorldBankApiService().searchIndicators(
        {
          ...(query !== undefined && { query }),
          ...(topicId !== undefined && { topicId }),
          ...(sourceId !== undefined && { sourceId }),
          page: input.page,
          perPage,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError && err.data?.reason === 'invalid_filter') {
        throw ctx.fail('invalid_filter', err.message, {
          ...err.data,
          ...ctx.recoveryFor('invalid_filter'),
          topicId: input.topic_id,
          sourceId: input.source_id,
        });
      }
      if (err instanceof McpError && err.data?.reason === 'empty_query') {
        throw ctx.fail('empty_query', err.message, {
          ...err.data,
          ...ctx.recoveryFor('empty_query'),
          query,
        });
      }
      throw err;
    }

    // Build effective-query echo from active filters
    const filterParts: string[] = [];
    if (query) filterParts.push(`query="${query}"`);
    if (topicId) filterParts.push(`topic_id=${topicId}`);
    if (sourceId) filterParts.push(`source_id=${sourceId}`);
    ctx.enrich({
      appliedFilters: {
        ...(query !== undefined && { query }),
        ...(topicId !== undefined && { topicId }),
        ...(sourceId !== undefined && { sourceId }),
      },
      effectiveQuery: filterParts.join(', '),
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    // A search that matched nothing is a valid answer, not a failure: return an
    // empty list with a recovery notice rather than throwing. An empty page of a
    // non-empty result set is a different problem and gets its own hint.
    if (result.indicators.length === 0) {
      let hint: string;
      if (result.total > 0) {
        hint = `Page ${result.page} is past the last page of ${result.pages}. Request a page between 1 and ${result.pages}.`;
      } else if (query) {
        hint = `No indicators matched "${query}". Try a synonym or browse by topic using worldbank_list_topics.`;
      } else {
        hint = 'No indicators found for the specified filter. Try a different topic or source ID.';
      }
      ctx.enrich.notice(hint);
    }

    return { indicators: result.indicators };
  },

  format: (result) => {
    const lines: string[] = [];
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
