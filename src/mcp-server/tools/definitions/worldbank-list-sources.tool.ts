/**
 * @fileoverview List World Bank data sources (datasets). Provides source IDs and names
 * for filtering indicator searches, data retrieval, and country listings by dataset.
 * @module mcp-server/tools/definitions/worldbank-list-sources.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { perPageInput, resolvePerPage } from '@/mcp-server/tools/per-page.js';
import { MAX_SOURCES_PER_PAGE } from '@/services/response-budget.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankListSources = tool('worldbank_list_sources', {
  title: 'List World Bank Data Sources',
  description:
    'List World Bank data sources (datasets), such as World Development Indicators and International Debt Statistics, one page at a time. Each id is the source_id that worldbank_search_indicators, worldbank_get_data, and worldbank_list_countries take.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    page: z.number().int().min(1).default(1).describe('Page number, 1-based.'),
    per_page: perPageInput(MAX_SOURCES_PER_PAGE),
  }),
  output: z.object({
    sources: z
      .array(
        z
          .object({
            id: z.string().describe('Source ID.'),
            name: z.string().describe('Dataset name.'),
            code: z.string().describe('Short dataset code.'),
            lastUpdated: z.string().describe('Last data update (YYYY-MM-DD), or empty.'),
            dataAvailability: z.string().describe('Data availability status.'),
            metadataAvailability: z.string().describe('Metadata availability status.'),
            concepts: z.string().describe('Number of concepts (variables).'),
          })
          .describe('A data source.'),
      )
      .describe('Sources on this page.'),
  }),

  // Agent-facing context: the page size served and pagination totals. Kept out of
  // the domain return so it reaches both structuredContent and content[] automatically.
  enrichment: {
    appliedFilters: z
      .object({
        perPage: z.number().describe('Page size served, after any reduction to the page maximum.'),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, or the server default; present only when perPage was reduced.',
          ),
      })
      .describe('Page size in force.'),
    totalCount: z.number().describe('Sources before pagination.'),
    currentPage: z
      .number()
      .describe('Page number; past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total pages at perPage.'),
    notice: z
      .string()
      .optional()
      .describe('Explains an empty result, a page past the end, or a reduced page size.'),
  },

  enrichmentTrailer: {
    appliedFilters: {
      /**
       * A per-field `render` replaces the whole trailer line, `label` included,
       * so the heading has to be part of what it returns.
       */
      render: (filters) =>
        `**Applied Filters:** per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
    },
  },

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

  async handler(input, ctx) {
    const pageSize = resolvePerPage(
      { tool: 'worldbank_list_sources', cap: MAX_SOURCES_PER_PAGE, perPage: input.per_page },
      ctx,
    );
    const perPage = pageSize.served;
    ctx.log.info('Listing World Bank sources', { page: input.page, perPage });
    const result = await getWorldBankApiService().listSources(input.page, perPage, ctx);
    ctx.enrich({
      appliedFilters: {
        perPage,
        ...(perPage < pageSize.requested && { requestedPerPage: pageSize.requested }),
      },
      totalCount: result.total,
      currentPage: result.page,
      totalPages: result.pages,
    });
    const notices: string[] = [];
    if (result.total === 0) {
      notices.push('The World Bank returned no data sources.');
    } else if (result.sources.length === 0) {
      notices.push(
        pagePastEndNotice({
          noun: ['source', 'sources'],
          page: result.page,
          pages: result.pages,
          perPage,
          total: result.total,
        }),
      );
    }
    const reduced = pageSizeReducedNotice({
      requested: pageSize.requested,
      served: perPage,
      page: result.page,
      pages: result.pages,
    });
    if (reduced) notices.push(reduced);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return { sources: result.sources };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const s of result.sources) {
      lines.push(
        `${escapeMarkdownInline(s.name)} (ID: ${escapeMarkdownInline(s.id)}, Code: ${escapeMarkdownInline(s.code || 'N/A')})`,
      );
      if (s.lastUpdated) lines.push(`**Last updated:** ${escapeMarkdownInline(s.lastUpdated)}`);
      if (s.dataAvailability)
        lines.push(`**Data availability:** ${escapeMarkdownInline(s.dataAvailability)}`);
      if (s.metadataAvailability)
        lines.push(`**Metadata availability:** ${escapeMarkdownInline(s.metadataAvailability)}`);
      if (s.concepts) lines.push(`**Concepts:** ${escapeMarkdownInline(s.concepts)}`);
    }
    if (lines.length === 0) lines.push('No sources returned.');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
