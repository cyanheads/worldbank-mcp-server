/**
 * @fileoverview List World Bank countries and regional aggregates with metadata,
 * or a selected source's own entities. Filterable by region, income level,
 * lending type, and text matched against each entry's id and name.
 * @module mcp-server/tools/definitions/worldbank-list-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { perPageInput, resolvePerPage } from '@/mcp-server/tools/per-page.js';
import { MAX_COUNTRIES_PER_PAGE } from '@/services/response-budget.js';
import { CATALOG_FILTER_ID, SOURCE_ID_MESSAGE } from '@/services/worldbank/identifiers.js';
import { getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

/** The `/v2/lendingType` ids — the complete set. */
const LENDING_TYPES = ['IBD', 'IDB', 'IDX', 'LNX'] as const;

export const worldbankListCountries = tool('worldbank_list_countries', {
  title: 'List World Bank Countries',
  description:
    'List countries with ISO codes, region, income level, lending type, capital, and coordinates, narrowed by region, income_level, lending_type, and text (filter), combined by AND. With source_id, lists that dataset\'s own entities instead (source_id=50 with filter="Kenya" returns Kenya and its provinces).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    source_id: z
      .string()
      .regex(CATALOG_FILTER_ID, SOURCE_ID_MESSAGE)
      .optional()
      .describe(
        'Source ID (from worldbank_list_sources) whose own entities to list, as id, name, and sourceId only. region, income_level, lending_type, and include_aggregates=true are rejected with it (the default false keeps every entity); filter applies.',
      ),
    region: z
      .string()
      .optional()
      .describe(
        'Region code, as region.id reports: EAS (East Asia & Pacific), ECS (Europe & Central Asia), LCN (Latin America & Caribbean), MEA (Middle East, North Africa, Afghanistan & Pakistan), NAC (North America), SAS (South Asia), or SSF (Sub-Saharan Africa). Other World Bank region and grouping codes (AFE, AFW, ARB, EUU, LDC, …) filter by membership.',
      ),
    income_level: z
      .string()
      .optional()
      .describe(
        'Income group code: LIC (Low), LMC (Lower middle), UMC (Upper middle), or HIC (High income).',
      ),
    lending_type: z
      .union([z.literal(''), z.enum(LENDING_TYPES).describe('A lending type code.')])
      .optional()
      .describe(
        'Lending type code: IDX (IDA), IBD (IBRD), IDB (Blend, eligible for both), or LNX (Not classified). worldbank_get_poverty takes IDX, IBD, and IDB for its lending groups.',
      ),
    include_aggregates: z
      .boolean()
      .default(false)
      .describe(
        'Also return regional, income-group, and world aggregates (default false: countries only). No effect with region, income_level, or lending_type, which never return aggregates.',
      ),
    filter: z
      .string()
      .optional()
      .describe(
        'Text whose every word must appear in an entry\'s id and name together, ignoring case, diacritics, punctuation, and order; a word may be part of a longer one ("nairobi kenya" matches KEN_Nairobi_Province_KE.NP_51328_KEN004). Aggregates match only with include_aggregates=true. Applied before paging, so the totals count matches; one with no letter or digit is ignored.',
      ),
    page: z.number().int().min(1).default(1).describe('Page number, 1-based.'),
    per_page: perPageInput(MAX_COUNTRIES_PER_PAGE),
  }),
  output: z.object({
    countries: z
      .array(
        z
          .union([
            z
              .object({
                id: z.string().describe('Entity ID, which worldbank_get_data takes unchanged.'),
                name: z.string().describe('Entity name.'),
                sourceId: z.string().describe('Source owning this entity.'),
              })
              .describe('A source entity.'),
            z
              .object({
                id: z.string().describe('Three-character code (USA; SSF for an aggregate).'),
                iso2: z.string().describe('ISO2 code.'),
                name: z.string().describe('Country or aggregate name.'),
                region: z
                  .object({
                    id: z.string().describe('Region code.'),
                    name: z.string().describe('Region name.'),
                  })
                  .describe('World Bank region.'),
                incomeLevel: z
                  .object({
                    id: z.string().describe('Income level code.'),
                    name: z.string().describe('Income level name.'),
                  })
                  .describe('Income classification.'),
                lendingType: z
                  .string()
                  .describe('Lending type name: IDA, IBRD, Blend, Not classified, or Aggregates.'),
                capitalCity: z
                  .string()
                  .describe('Capital city; empty for aggregates, as are the coordinates.'),
                longitude: z.string().describe('Capital longitude.'),
                latitude: z.string().describe('Capital latitude.'),
                isAggregate: z.boolean().describe('True for a regional or income-group aggregate.'),
              })
              .describe('A country or aggregate.'),
          ])
          .describe('A country or aggregate, or a source entity.'),
      )
      .describe('Matching entries on this page.'),
  }),

  // Agent-facing context: the applied filters and pagination totals. Kept out of
  // the domain return so it reaches both structuredContent and content[] automatically.
  enrichment: {
    appliedFilters: z
      .object({
        sourceId: z.string().optional().describe('source_id requested.'),
        region: z.string().optional().describe('region applied.'),
        incomeLevel: z.string().optional().describe('income_level applied.'),
        lendingType: z.string().optional().describe('lending_type applied.'),
        includeAggregates: z.boolean().describe('include_aggregates in force.'),
        filter: z.string().optional().describe('filter applied, trimmed.'),
        page: z.number().describe('Page requested.'),
        perPage: z.number().describe('Page size served, after any reduction to the page maximum.'),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, or the server default; present only when perPage was reduced.',
          ),
      })
      .describe('Parameters in force for this listing; a filter not applied is omitted.'),
    totalCount: z.number().describe('Matching entries before pagination.'),
    currentPage: z
      .number()
      .describe('Page number; past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total pages at perPage.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Explains an empty result (which filters matched nothing), a page past the end, or a reduced page size.',
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
          ...(filters.filter === undefined
            ? []
            : [`filter="${escapeMarkdownInline(filters.filter)}"`]),
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
      when: 'The source lacks a country/series/time layout.',
      recovery: 'Choose another source with worldbank_list_sources.',
    },
    {
      reason: 'unsupported_source_filter',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Classification filters are combined with source_id.',
      recovery:
        'Remove region, income_level, lending_type and include_aggregates=true when selecting source_id.',
    },
    {
      reason: 'invalid_filter',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'Unknown region or income_level code.',
      recovery:
        'Use worldbank_list_countries without filters to browse valid region and income-level codes.',
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
    ctx.log.info('Listing countries', {
      region: input.region,
      incomeLevel: input.income_level,
      lendingType: input.lending_type,
      includeAggregates: input.include_aggregates,
      filter: input.filter,
      page: input.page,
    });
    const sourceId = input.source_id?.trim() || undefined;
    const region = input.region?.trim() || undefined;
    const incomeLevel = input.income_level?.trim() || undefined;
    const lendingType = input.lending_type || undefined;
    // Only letters and digits are matched, so a filter without one holds no word to narrow by.
    const filter = /[\p{L}\p{N}]/u.test(input.filter ?? '') ? input.filter?.trim() : undefined;
    const pageSize = resolvePerPage(
      { tool: 'worldbank_list_countries', cap: MAX_COUNTRIES_PER_PAGE, perPage: input.per_page },
      ctx,
    );
    let result: Awaited<ReturnType<ReturnType<typeof getWorldBankApiService>['listCountries']>>;
    try {
      result = await getWorldBankApiService().listCountries(
        {
          ...(sourceId !== undefined && { sourceId }),
          ...(region !== undefined && { region }),
          ...(incomeLevel !== undefined && { incomeLevel }),
          ...(lendingType !== undefined && { lendingType }),
          includeAggregates: input.include_aggregates,
          ...(filter !== undefined && { filter }),
          page: input.page,
          perPage: pageSize.served,
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
        ...(sourceId !== undefined && { sourceId }),
        ...(region !== undefined && { region }),
        ...(incomeLevel !== undefined && { incomeLevel }),
        ...(lendingType !== undefined && { lendingType }),
        includeAggregates: input.include_aggregates,
        ...(filter !== undefined && { filter }),
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < pageSize.requested && { requestedPerPage: pageSize.requested }),
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });

    const notices: string[] = [];
    if (result.total === 0) {
      const filters = [
        ...(region === undefined ? [] : [`region=${region}`]),
        ...(incomeLevel === undefined ? [] : [`income_level=${incomeLevel}`]),
        ...(lendingType === undefined ? [] : [`lending_type=${lendingType}`]),
        ...(filter === undefined ? [] : [`filter="${filter}"`]),
      ];
      const listing = sourceId === undefined ? 'countries' : `entities in source ${sourceId}`;
      const sentences =
        filters.length === 0
          ? ['The World Bank returned no countries.']
          : [`No ${listing} matched ${filters.join(', ')}.`];
      if (filters.length > 1)
        sentences.push(
          'The filters combine by AND, so no country matches all of them at once — drop one of them to widen the list.',
        );
      if (filter !== undefined) {
        sentences.push("Every filter word must appear in an entry's id or name.");
        // region, income_level, and lending_type return no aggregate whatever
        // include_aggregates says, so the flag is offered only without them.
        const classified =
          region !== undefined || incomeLevel !== undefined || lendingType !== undefined;
        if (sourceId === undefined && !input.include_aggregates && !classified)
          sentences.push(
            'Aggregates are excluded under include_aggregates=false; set include_aggregates=true to match their names and codes too.',
          );
      }
      notices.push(sentences.join(' '));
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
      requested: pageSize.requested,
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
