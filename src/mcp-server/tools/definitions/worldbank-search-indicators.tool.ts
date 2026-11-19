/**
 * @fileoverview Search the World Bank indicator catalog by keyword, topic, or source.
 * The primary discovery entry point for finding indicator IDs.
 * @module mcp-server/tools/definitions/worldbank-search-indicators.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { perPageInput, resolvePerPage } from '@/mcp-server/tools/per-page.js';
import {
  INDICATOR_NOTE_EXCERPT_CHARS,
  MAX_INDICATORS_PER_PAGE,
  shorten,
} from '@/services/response-budget.js';
import {
  CATALOG_FILTER_ID,
  SOURCE_ID_MESSAGE,
  TOPIC_ID_MESSAGE,
} from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankSearchIndicators = tool('worldbank_search_indicators', {
  title: 'Search World Bank Indicators',
  description:
    'Search the World Bank indicator catalog by keyword, topic, or source for indicator IDs to pass to worldbank_get_data. Provide at least one of query, topic_id, or source_id; together they combine by AND. Exact ID or name matches rank first, then names starting with the phrase as whole words, whole-phrase matches, matches where every term is a whole word of the ID or name, other ID or name matches, and description-only matches; within each, World Development Indicators come first, then other live sources, then archives; among names starting with the phrase, one continuing it with ", total" leads its source (Population, total for population); and a series precedes its breakdowns by sex, area, or age. Each indicator ID appears once, even when two sources publish it.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Keywords, an indicator name, or an ID (e.g. "GDP per capita", "NY.GDP.MKTP.CD"); every term must match the ID, name, or full description, in any order. Punctuation is ignored, so it needs a letter or digit.',
      ),
    topic_id: z
      .string()
      .regex(CATALOG_FILTER_ID, TOPIC_ID_MESSAGE)
      .optional()
      .describe('Topic ID from worldbank_list_topics (e.g. "3" for Economy & Growth).'),
    source_id: z
      .string()
      .regex(CATALOG_FILTER_ID, SOURCE_ID_MESSAGE)
      .optional()
      .describe(
        'Source ID from worldbank_list_sources (e.g. "2" for World Development Indicators).',
      ),
    page: z.number().int().min(1).default(1).describe('Page number, 1-based.'),
    per_page: perPageInput(MAX_INDICATORS_PER_PAGE),
  }),
  output: z.object({
    indicators: z
      .array(
        z
          .object({
            id: z.string().describe('Indicator ID (e.g. NY.GDP.PCAP.CD).'),
            name: z.string().describe('Indicator name.'),
            sourceId: z.string().describe('Source dataset ID.'),
            sourceName: z.string().describe('Source dataset name.'),
            sourceNote: z
              .string()
              .describe(
                `Indicator description, cut to its first ${INDICATOR_NOTE_EXCERPT_CHARS} characters and marked with … when longer; worldbank_get_indicator returns it whole.`,
              ),
            topics: z
              .array(
                z
                  .object({
                    id: z.string().describe('Topic ID.'),
                    name: z.string().describe('Topic name.'),
                  })
                  .describe('A topic.'),
              )
              .describe('Topics this indicator belongs to.'),
          })
          .describe('A matching indicator.'),
      )
      .describe('Matching indicators on this page.'),
  }),

  // Agent-facing context: pagination totals, query echo, and empty-result guidance.
  // Kept out of the domain return so it reaches both structuredContent and content[]
  // without a format() entry or format-parity concern.
  enrichment: {
    appliedFilters: z
      .object({
        query: z.string().optional().describe('query applied, trimmed.'),
        topicId: z.string().optional().describe('topic_id applied.'),
        sourceId: z.string().optional().describe('source_id applied.'),
        perPage: z.number().describe('Page size served, after any reduction to the page maximum.'),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, or the server default; present only when perPage was reduced.',
          ),
      })
      .describe('Parameters in force for these results; a filter not applied is omitted.'),
    effectiveQuery: z.string().optional().describe('The applied filters as one string.'),
    totalCount: z.number().describe('Matching indicators before pagination.'),
    currentPage: z
      .number()
      .describe('Page number; past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total pages at perPage.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Explains an empty result (how to broaden it), a page past the end, or a reduced page size.',
      ),
  },

  enrichmentTrailer: {
    notice: {
      render: (notice) =>
        notice === undefined ? '' : `**Notice:** ${escapeMarkdownInline(notice)}`,
    },
    appliedFilters: {
      /**
       * A per-field `render` replaces the whole trailer line, `label` included,
       * so the heading has to be part of what it returns. Without it this lands
       * as an unlabelled copy of the `effectiveQuery` line directly beneath it.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          ...(filters.query === undefined
            ? []
            : [`query="${escapeMarkdownInline(filters.query)}"`]),
          ...(filters.topicId === undefined
            ? []
            : [`topic_id=${escapeMarkdownInline(filters.topicId)}`]),
          ...(filters.sourceId === undefined
            ? []
            : [`source_id=${escapeMarkdownInline(filters.sourceId)}`]),
          `per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'missing_filter',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No query, topic_id, or source_id.',
      recovery:
        'Provide a keyword query, a topic_id from worldbank_list_topics, or a source_id from worldbank_list_sources.',
    },
    {
      reason: 'invalid_filter',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'Unknown topic_id or source_id.',
      recovery:
        'Browse valid IDs with worldbank_list_topics or worldbank_list_sources, then retry with one of those.',
    },
    {
      reason: 'empty_query',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'query has no letter or digit.',
      recovery:
        'Provide a keyword with letters or digits, or omit query to browse by topic_id or source_id.',
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
    const query = input.query?.trim() ? input.query.trim() : undefined;
    const topicId = input.topic_id?.trim() ? input.topic_id.trim() : undefined;
    const sourceId = input.source_id?.trim() ? input.source_id.trim() : undefined;

    if (!query && !topicId && !sourceId) {
      throw ctx.fail(
        'missing_filter',
        'At least one of query, topic_id, or source_id must be provided.',
      );
    }

    const pageSize = resolvePerPage(
      {
        tool: 'worldbank_search_indicators',
        cap: MAX_INDICATORS_PER_PAGE,
        perPage: input.per_page,
      },
      ctx,
    );
    const perPage = pageSize.served;

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
          topicId: input.topic_id,
          sourceId: input.source_id,
        });
      }
      if (err instanceof McpError && err.data?.reason === 'empty_query') {
        throw ctx.fail('empty_query', err.message, {
          ...err.data,
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
        perPage,
        ...(perPage < pageSize.requested && { requestedPerPage: pageSize.requested }),
      },
      effectiveQuery: filterParts.join(', '),
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    // A search that matched nothing is a valid answer, not a failure: return an
    // empty list with a recovery notice rather than throwing. An empty page of a
    // non-empty result set is a different problem and gets its own hint.
    const notices: string[] = [];
    if (result.indicators.length === 0) {
      if (result.total > 0) {
        notices.push(
          pagePastEndNotice({
            noun: ['indicator', 'indicators'],
            page: result.page,
            pages: result.pages,
            perPage,
            total: result.total,
          }),
        );
      } else if (query) {
        notices.push(
          `No indicators matched "${query}". Try a synonym or browse by topic using worldbank_list_topics.`,
        );
      } else {
        notices.push(
          'No indicators found for the specified filter. Try a different topic or source ID.',
        );
      }
    }
    const reduced = pageSizeReducedNotice({
      requested: pageSize.requested,
      served: perPage,
      page: result.page,
      pages: result.pages,
    });
    if (reduced) notices.push(reduced);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    /**
     * A note runs up to ~4,000 characters, so a 100-row page of whole notes
     * reaches ~148 KB, and a full page several MB. Matching has already read
     * every note in full; the rows returned carry an excerpt.
     */
    return {
      indicators: result.indicators.map((indicator) => ({
        ...indicator,
        sourceNote: shorten(indicator.sourceNote, INDICATOR_NOTE_EXCERPT_CHARS),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const ind of result.indicators) {
      lines.push(escapeMarkdownInline(ind.name));
      lines.push(
        `**ID:** ${escapeMarkdownInline(ind.id)} | **Source:** ${escapeMarkdownInline(ind.sourceName || 'N/A')} (ID: ${escapeMarkdownInline(ind.sourceId || 'N/A')})`,
      );
      if (ind.topics.length > 0) {
        lines.push(
          `**Topics:** ${ind.topics.map((t) => `${escapeMarkdownInline(t.name)} (${escapeMarkdownInline(t.id)})`).join(', ')}`,
        );
      }
      if (ind.sourceNote) lines.push(escapeMarkdownInline(ind.sourceNote));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
