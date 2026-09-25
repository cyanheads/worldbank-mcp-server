/**
 * @fileoverview List World Bank data sources (datasets). Provides source IDs and names
 * for filtering worldbank_search_indicators by dataset origin.
 * @module mcp-server/tools/definitions/worldbank-list-sources.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankListSources = tool('worldbank_list_sources', {
  title: 'List World Bank Data Sources',
  description:
    'List the 70+ World Bank data sources (datasets), such as World Development Indicators, International Debt Statistics, and Doing Business. Returns source IDs and names for use as source_id in worldbank_search_indicators, one page at a time.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
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
    sources: z
      .array(
        z
          .object({
            id: z.string().describe('Source ID for use in worldbank_search_indicators.'),
            name: z.string().describe('Dataset name.'),
            code: z.string().describe('Short dataset code.'),
            lastUpdated: z.string().describe('Date of last data update (YYYY-MM-DD or empty).'),
            dataAvailability: z.string().describe('Data availability status.'),
            metadataAvailability: z.string().describe('Metadata availability status.'),
            concepts: z.string().describe('Number of concepts (variables) in this source.'),
          })
          .describe('A World Bank data source entry.'),
      )
      .describe('World Bank data sources for this page.'),
  }),

  // Agent-facing context: pagination totals. Kept out of the domain return so it
  // reaches both structuredContent and content[] automatically.
  enrichment: {
    totalCount: z.number().describe('Total number of sources.'),
    currentPage: z
      .number()
      .describe('Page number requested — past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total number of pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Context for an empty page: the page range that exists when the requested page is past the end.',
      ),
  },

  async handler(input, ctx) {
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;
    ctx.log.info('Listing World Bank sources', { page: input.page, perPage });
    const result = await getWorldBankApiService().listSources(input.page, perPage, ctx);
    ctx.enrich({
      totalCount: result.total,
      currentPage: result.page,
      totalPages: result.pages,
    });
    if (result.total === 0) {
      ctx.enrich.notice('The World Bank returned no data sources.');
    } else if (result.sources.length === 0) {
      ctx.enrich.notice(
        pagePastEndNotice({
          noun: ['source', 'sources'],
          page: result.page,
          pages: result.pages,
          perPage,
          total: result.total,
        }),
      );
    }
    return { sources: result.sources };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const s of result.sources) {
      lines.push(`### ${s.name} (ID: ${s.id}, Code: ${s.code || 'N/A'})`);
      if (s.lastUpdated) lines.push(`**Last updated:** ${s.lastUpdated}`);
      if (s.dataAvailability) lines.push(`**Data availability:** ${s.dataAvailability}`);
      if (s.metadataAvailability)
        lines.push(`**Metadata availability:** ${s.metadataAvailability}`);
      if (s.concepts) lines.push(`**Concepts:** ${s.concepts}`);
    }
    if (lines.length === 0) lines.push('No sources returned.');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
