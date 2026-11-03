/**
 * @fileoverview List World Bank countries and regional aggregates with metadata.
 * Filterable by region, income level, and lending type.
 * @module mcp-server/tools/definitions/worldbank-list-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { MAX_COUNTRIES_PER_PAGE } from '@/services/response-budget.js';
import { CATALOG_FILTER_ID, SOURCE_ID_MESSAGE } from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

/** The `/v2/lendingType` ids — the complete set. */
const LENDING_TYPES = ['IBD', 'IDB', 'IDX', 'LNX'] as const;

export const worldbankListCountries = tool('worldbank_list_countries', {
  title: 'List World Bank Countries',
  description:
    'List countries and regional aggregates with metadata: ISO codes, region, income level, lending type, capital, and coordinates. Filter by region code (e.g. EAS, SSF, NAC), income level (LIC, LMC, UMC, HIC), and lending type (IDX for IDA, IBD for IBRD, IDB for Blend); filters combine by AND. Aggregate entries are excluded by default, leaving individual countries only; set include_aggregates=true to also return region, income group, and world aggregate entities.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    source_id: z
      .string()
      .regex(CATALOG_FILTER_ID, SOURCE_ID_MESSAGE)
      .optional()
      .describe(
        'Select a source-specific entity listing. Entries carry canonical id, name and sourceId only; global classification filters and include_aggregates=true are unavailable. Default false keeps all source entities.',
      ),
    region: z
      .string()
      .optional()
      .describe(
        "Filter by World Bank region code. A country's region.id is one of EAS (East Asia & Pacific), ECS (Europe & Central Asia), LCN (Latin America & Caribbean), MEA (Middle East, North Africa, Afghanistan & Pakistan), NAC (North America), SAS (South Asia), or SSF (Sub-Saharan Africa). Any other World Bank region or grouping code also filters, by membership: AFE (Africa Eastern and Southern), AFW (Africa Western and Central), ARB (Arab World), EUU (European Union), LDC (Least developed countries), and the rest of the codes the World Bank publishes for regions.",
      ),
    income_level: z
      .string()
      .optional()
      .describe(
        'Filter by income group code: LIC (Low income), LMC (Lower middle income), UMC (Upper middle income), HIC (High income).',
      ),
    lending_type: z
      .union([
        z.literal(''),
        z
          .enum(LENDING_TYPES)
          .describe('IDX (IDA), IBD (IBRD), IDB (Blend), or LNX (Not classified).'),
      ])
      .optional()
      .describe(
        "Filter by World Bank lending type code: IDX (IDA), IBD (IBRD), IDB (Blend — eligible for both), or LNX (Not classified). IDX, IBD, and IDB are also the codes worldbank_get_poverty takes for its lending groups; a country's lendingType field reports the name (IDA, IBRD, Blend, Not classified).",
      ),
    include_aggregates: z
      .boolean()
      .default(false)
      .describe(
        'When true, includes regional, income-group, and world aggregate entries alongside individual countries. Default false (individual countries only). No aggregate is returned under region or lending_type, whichever code is given, so this changes nothing when either is set.',
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Results per page (default: server default). Positive integers above 300 are served at that maximum with the requested and served sizes echoed and a notice. totalPages uses the served size.',
      ),
  }),
  output: z.object({
    countries: z
      .array(
        z
          .union([
            z
              .object({
                id: z
                  .string()
                  .describe(
                    'Canonical source entity ID, accepted unchanged by worldbank_get_data.',
                  ),
                name: z.string().describe('Source entity name.'),
                sourceId: z.string().describe('Source owning this entity.'),
              })
              .describe('An entity from a selected source.'),
            z
              .object({
                id: z.string().describe('Country or aggregate ID (ISO2 or WB aggregate code).'),
                iso2: z.string().describe('ISO2 country code.'),
                name: z.string().describe('Country or aggregate name.'),
                region: z
                  .object({
                    id: z.string().describe('Region code.'),
                    name: z.string().describe('Region name.'),
                  })
                  .describe('World Bank region this country belongs to.'),
                incomeLevel: z
                  .object({
                    id: z.string().describe('Income level code.'),
                    name: z.string().describe('Income level name.'),
                  })
                  .describe('World Bank income classification.'),
                lendingType: z
                  .string()
                  .describe(
                    'World Bank lending type name: IDA, IBRD, Blend, or Not classified (lending_type filters by the codes IDX, IBD, IDB, LNX). Aggregates report Aggregates.',
                  ),
                capitalCity: z.string().describe('Capital city name (empty for aggregates).'),
                longitude: z.string().describe('Capital longitude (empty for aggregates).'),
                latitude: z.string().describe('Capital latitude (empty for aggregates).'),
                isAggregate: z
                  .boolean()
                  .describe(
                    'True when this entry is a regional or income-group aggregate rather than an individual country.',
                  ),
              })
              .describe('A country or aggregate entry.'),
          ])
          .describe('A global country or aggregate, or an entity from the selected source.'),
      )
      .describe('Countries (and optionally aggregates) matching the filters.'),
  }),

  // Agent-facing context: the applied filters and pagination totals. Kept out of
  // the domain return so it reaches both structuredContent and content[] automatically.
  enrichment: {
    appliedFilters: z
      .object({
        sourceId: z
          .string()
          .optional()
          .describe('Source dataset requested, omitted for the global country listing.'),
        region: z.string().optional().describe('Region code applied, omitted when none.'),
        incomeLevel: z
          .string()
          .optional()
          .describe('Income level code applied, omitted when none.'),
        lendingType: z
          .string()
          .optional()
          .describe('Lending type code applied, omitted when none.'),
        includeAggregates: z
          .boolean()
          .describe('Whether aggregates were requested, including the default of false.'),
        page: z.number().describe('Page number requested.'),
        perPage: z
          .number()
          .describe(
            'Results per page actually served — the requested size or server default, reduced to the page cap when larger. totalPages is counted at this size.',
          ),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, present only when it exceeded the page cap and perPage was reduced.',
          ),
      })
      .describe(
        'The effective listing parameters — which filters were in force and the page size served.',
      ),
    totalCount: z
      .number()
      .describe(
        'Total matching entries before pagination (includes aggregates if include_aggregates=true).',
      ),
    currentPage: z
      .number()
      .describe('Page number requested — past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total number of pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Context for an empty page — which filters matched nothing, or the page range that exists when the requested page is past the end — or for a page size reduced to the page cap.',
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
       * so the heading has to be part of what it returns.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          ...(filters.sourceId === undefined
            ? []
            : [`source_id=${escapeMarkdownInline(filters.sourceId)}`]),
          ...(filters.region === undefined
            ? []
            : [`region=${escapeMarkdownInline(filters.region)}`]),
          ...(filters.incomeLevel === undefined
            ? []
            : [`income_level=${escapeMarkdownInline(filters.incomeLevel)}`]),
          ...(filters.lendingType === undefined
            ? []
            : [`lending_type=${escapeMarkdownInline(filters.lendingType)}`]),
          `include_aggregates=${filters.includeAggregates}`,
          `page=${filters.page}`,
          `per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'source_not_found',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'source_id does not name a source.',
      recovery: 'Use worldbank_list_sources to find valid source IDs.',
    },
    {
      reason: 'source_not_queryable',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The selected source has no supported country/series/time layout.',
      recovery: 'Choose another source with worldbank_list_sources.',
    },
    {
      reason: 'unsupported_source_filter',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Global classification filters are combined with source_id.',
      recovery:
        'Remove region, income_level, lending_type and include_aggregates=true when selecting source_id.',
    },
    {
      reason: 'invalid_filter',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'An invalid region or income_level code was provided.',
      recovery:
        'Use worldbank_list_countries without filters to browse valid region and income-level codes.',
    },
  ],

  async handler(input, ctx) {
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;
    ctx.log.info('Listing countries', {
      region: input.region,
      incomeLevel: input.income_level,
      lendingType: input.lending_type,
      includeAggregates: input.include_aggregates,
      page: input.page,
    });
    const region = input.region?.trim() || undefined;
    const incomeLevel = input.income_level?.trim() || undefined;
    const lendingType = input.lending_type || undefined;
    let result: Awaited<ReturnType<ReturnType<typeof getWorldBankApiService>['listCountries']>>;
    try {
      result = await getWorldBankApiService().listCountries(
        {
          ...(input.source_id?.trim() && { sourceId: input.source_id.trim() }),
          ...(region !== undefined && { region }),
          ...(incomeLevel !== undefined && { incomeLevel }),
          ...(lendingType !== undefined && { lendingType }),
          includeAggregates: input.include_aggregates,
          page: input.page,
          perPage: Math.min(perPage, MAX_COUNTRIES_PER_PAGE),
        },
        ctx,
      );
    } catch (err) {
      if (
        err instanceof McpError &&
        (err.data?.reason === 'source_not_found' ||
          err.data?.reason === 'source_not_queryable' ||
          err.data?.reason === 'unsupported_source_filter')
      )
        throw ctx.fail(err.data.reason, err.message, err.data);
      if (err instanceof McpError && err.data?.reason === 'invalid_filter') {
        throw ctx.fail('invalid_filter', err.message, {
          ...err.data,
          region: input.region,
          incomeLevel: input.income_level,
        });
      }
      throw err;
    }
    ctx.enrich({
      appliedFilters: {
        ...(input.source_id?.trim() && { sourceId: input.source_id.trim() }),
        ...(region !== undefined && { region }),
        ...(incomeLevel !== undefined && { incomeLevel }),
        ...(lendingType !== undefined && { lendingType }),
        includeAggregates: input.include_aggregates,
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < perPage && { requestedPerPage: perPage }),
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    const notices: string[] = [];
    if (result.total === 0) {
      const filters = [
        ...(region === undefined ? [] : [`region=${region}`]),
        ...(incomeLevel === undefined ? [] : [`income_level=${incomeLevel}`]),
        ...(lendingType === undefined ? [] : [`lending_type=${lendingType}`]),
      ];
      notices.push(
        filters.length > 1
          ? `No countries matched ${filters.join(', ')}. The filters combine by AND, so no country matches all of them at once — drop one of them to widen the list.`
          : filters.length === 1
            ? `No countries matched ${filters[0]}.`
            : 'The World Bank returned no countries.',
      );
    } else if (result.countries.length === 0) {
      notices.push(
        pagePastEndNotice({
          noun: ['country', 'countries'],
          page: result.page,
          pages: result.pages,
          perPage: result.perPage,
          total: result.total,
        }),
      );
    }
    const reduced = pageSizeReducedNotice({
      requested: perPage,
      served: result.perPage,
      page: result.page,
      pages: result.pages,
    });
    if (reduced) notices.push(reduced);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return { countries: result.countries };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const c of result.countries) {
      if ('sourceId' in c) {
        lines.push(
          `${escapeMarkdownInline(c.name)} (${escapeMarkdownInline(c.id)})`,
          `**Source:** ${escapeMarkdownInline(c.sourceId)}`,
        );
        continue;
      }
      const tag = c.isAggregate ? ' [Aggregate]' : '';
      lines.push(`${escapeMarkdownInline(c.name)} (${escapeMarkdownInline(c.id)}${tag})`);
      lines.push(
        `**ISO2:** ${escapeMarkdownInline(c.iso2 || 'N/A')} | **Region:** ${escapeMarkdownInline(c.region.name)} (${escapeMarkdownInline(c.region.id || 'N/A')}) | **Income:** ${escapeMarkdownInline(c.incomeLevel.name)} (${escapeMarkdownInline(c.incomeLevel.id || 'N/A')})`,
      );
      lines.push(`**Lending Type:** ${escapeMarkdownInline(c.lendingType || 'N/A')}`);
      if (c.capitalCity) lines.push(`**Capital:** ${escapeMarkdownInline(c.capitalCity)}`);
      if (c.longitude && c.latitude)
        lines.push(
          `**Coordinates:** ${escapeMarkdownInline(c.latitude)}, ${escapeMarkdownInline(c.longitude)}`,
        );
    }
    if (lines.length === 0) lines.push('No countries returned.');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
