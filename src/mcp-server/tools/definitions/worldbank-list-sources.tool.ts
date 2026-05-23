/**
 * @fileoverview List World Bank data sources (datasets). Provides source IDs and names
 * for filtering worldbank_search_indicators by dataset origin.
 * @module mcp-server/tools/definitions/worldbank-list-sources.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

export const worldbankListSources = tool('worldbank_list_sources', {
  title: 'List World Bank Data Sources',
  description:
    'Lists the 70+ World Bank data sources (datasets) such as World Development Indicators, IDS, and Doing Business. ' +
    'Returns source IDs and names for use as source_id in worldbank_search_indicators. Supports pagination.',
  annotations: { readOnlyHint: true },
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
        z.object({
          id: z.string().describe('Source ID for use in worldbank_search_indicators.'),
          name: z.string().describe('Dataset name.'),
          code: z.string().describe('Short dataset code.'),
          lastUpdated: z.string().describe('Date of last data update (YYYY-MM-DD or empty).'),
          dataAvailability: z.string().describe('Data availability status.'),
          metadataAvailability: z.string().describe('Metadata availability status.'),
          concepts: z.string().describe('Number of concepts (variables) in this source.'),
        }),
      )
      .describe('World Bank data sources for this page.'),
    total: z.number().describe('Total number of sources.'),
    page: z.number().describe('Current page number.'),
    pages: z.number().describe('Total number of pages.'),
  }),

  async handler(input, ctx) {
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;
    ctx.log.info('Listing World Bank sources', { page: input.page, perPage });
    const result = await getWorldBankApiService().listSources(input.page, perPage, ctx);
    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `**Sources — Page ${result.page} of ${result.pages} (${result.total} total)**\n`,
    ];
    for (const s of result.sources) {
      lines.push(`### ${s.name} (ID: ${s.id}, Code: ${s.code || 'N/A'})`);
      if (s.lastUpdated) lines.push(`**Last updated:** ${s.lastUpdated}`);
      if (s.dataAvailability) lines.push(`**Data availability:** ${s.dataAvailability}`);
      if (s.metadataAvailability)
        lines.push(`**Metadata availability:** ${s.metadataAvailability}`);
      if (s.concepts) lines.push(`**Concepts:** ${s.concepts}`);
    }
    if (result.page < result.pages) {
      lines.push(`\n_Use page=${result.page + 1} to see the next page._`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
