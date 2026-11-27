/**
 * @fileoverview Query World Bank indicator values for countries across a time range.
 * The primary data-access tool.
 * @module mcp-server/tools/definitions/worldbank-get-data.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { perPageInput, resolvePerPage } from '@/mcp-server/tools/per-page.js';
import { MAX_OBSERVATIONS_PER_PAGE } from '@/services/response-budget.js';
import {
  CATALOG_FILTER_ID,
  COUNTRY_LIST_CONTENT,
  INDICATOR_ID,
  INDICATOR_ID_MESSAGE,
  isAllSelector,
  SOURCE_ID_MESSAGE,
  splitCountryCodes,
} from '@/services/worldbank/identifiers.js';
import { type PeriodForm, parseDateWindow, periodForm } from '@/services/worldbank/periods.js';
import type { SourceScopedDisclosure } from '@/services/worldbank/types.js';
import { type DataResult, getWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

/** The `frequency` values, each naming the period form it selects. */
const FREQUENCY_FORM = { annual: 'year', quarterly: 'quarter', monthly: 'month' } as const;
type Frequency = keyof typeof FREQUENCY_FORM;
const FREQUENCIES = Object.keys(FREQUENCY_FORM) as [Frequency, ...Frequency[]];

/** The `frequency` value that selects each period form. */
const FORM_FREQUENCY: Record<PeriodForm, Frequency> = {
  year: 'annual',
  quarter: 'quarterly',
  month: 'monthly',
};

/**
 * The notice for a quarter or month `date_range` whose rows are all null, which
 * is how a source publishing several forms answers a form a series lacks: it
 * spells the same span at the other two forms (`2024Q1:2024Q4` → `2024M01:2024M12`
 * and `2024`). Undefined for a year window, which selects the annual rows.
 */
function allNullWindowNotice(dateRange: string): string | undefined {
  const form = periodForm(dateRange.split(':')[0] ?? '');
  const span = parseDateWindow(dateRange);
  if (!span || (form !== 'quarter' && form !== 'month')) return;
  const year = (month: number) => Math.floor(month / 12);
  const spell = (first: string, last: string) => `"${first === last ? first : `${first}:${last}`}"`;
  const at = {
    year: (m: number) => String(year(m)),
    quarter: (m: number) => `${year(m)}Q${Math.floor((m % 12) / 3) + 1}`,
    month: (m: number) => `${year(m)}M${String((m % 12) + 1).padStart(2, '0')}`,
  };
  const other = form === 'quarter' ? 'month' : 'quarter';
  return (
    `Every observation in date_range "${dateRange}" is null: this series may not publish ${FORM_FREQUENCY[form]} values. ` +
    `Ask for the same span by ${other} (${spell(at[other](span.start), at[other](span.end))}) ` +
    `or by year (${spell(at.year(span.start), at.year(span.end))}), or use frequency with mrv or mrnev for the latest values at each form.`
  );
}

/**
 * `"all"` is a keyword for the whole set, not a code. Inside a list upstream
 * rejects it with the same envelope as an invalid code, which would surface as
 * `country_not_found` blaming codes that are valid.
 */
function mixesAll(codes: string[]): boolean {
  return codes.length > 1 && codes.some((code) => code.toLowerCase() === 'all');
}

/** What each way of choosing a dimension value means, for the rendered disclosure. */
const SELECTION_MEANING = {
  requested: 'as requested by dimension_value',
  only_value: 'the only value the dataset lists',
  world_total: 'the World total across all counterpart areas',
  newest_with_data: 'the newest release holding a value for the requested countries and periods',
  newest: 'the newest release; no release holds a value for the requested countries and periods',
  every_value: 'no single value — each row shows its own',
} as const;

/** Render the dimension line of a source-scoped disclosure. */
function renderDimension(dimension: SourceScopedDisclosure['dimension']): string {
  if (!dimension) return '**Dimension:** none beyond country, series, and time';
  const applied =
    dimension.id === null
      ? 'every value'
      : `${escapeMarkdownInline(dimension.label ?? '')} (${escapeMarkdownInline(dimension.id)})`;
  return `**${escapeMarkdownInline(dimension.concept)}:** ${applied} — selection: ${dimension.selection} (${SELECTION_MEANING[dimension.selection]})`;
}

/**
 * An empty value is a missing required input, so the schema rejects it. A mixed
 * `"all"` and a reversed `date_range` are well-shaped mistakes a caller corrects
 * and retries, so the handler rejects those against declared reasons.
 */
const EMPTY_COUNTRIES_MESSAGE = 'Provide at least one country code, or "all" for every entry.';

export const worldbankGetData = tool('worldbank_get_data', {
  title: 'Get World Bank Indicator Data',
  description: `Query one World Bank indicator's values for countries across periods — the primary data tool; find indicator_id with worldbank_search_indicators. Set at most one of date_range, mrv, or mrnev, and frequency only without date_range. For "all" countries, page at up to ${MAX_OBSERVATIONS_PER_PAGE} per page. Indicators the standard data endpoint does not serve — WDI Database Archives, PEFA, ICP, GDLD, International Debt Statistics: DSSI, Food Prices for Nutrition — are answered from their own dataset; the response then carries sourceScoped, naming the dataset and the dimension value applied, since those values can be archived or superseded figures.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: {
    limit: 'per_page',
    country: 'countries',
    country_codes: 'countries',
    indicator: 'indicator_id',
    date: 'date_range',
  },
  input: z.object({
    source_id: z
      .string()
      .regex(CATALOG_FILTER_ID, SOURCE_ID_MESSAGE)
      .optional()
      .describe(
        'Source dataset to read, subnational ones included (IDs from worldbank_list_sources); worldbank_list_countries with the same source_id lists its entity IDs. Omit for the standard endpoint with automatic fallback.',
      ),
    indicator_id: z
      .string()
      .regex(INDICATOR_ID, INDICATOR_ID_MESSAGE)
      .describe('One indicator ID (e.g. NY.GDP.PCAP.CD), not "all" or a list.'),
    countries: z
      .union([
        z
          .string()
          .regex(COUNTRY_LIST_CONTENT, EMPTY_COUNTRIES_MESSAGE)
          .describe('One code, or several in one string.'),
        z
          .array(z.string().describe('A country code.'))
          .min(1)
          /**
           * Checked against what the split actually yields, not against raw
           * element length: the API reads an empty country segment as every
           * entry, so an array holding nothing but separators must not reach it.
           */
          .refine((codes) => splitCountryCodes(codes).length > 0, EMPTY_COUNTRIES_MESSAGE)
          .describe('Codes as an array.'),
      ])
      .describe(
        'ISO2 (US) or ISO3 (USA) codes, regional (EAS, SSF), income (HIC, LMC), or world (WLD) aggregates, or "all" alone for every entry. One code, an array, or codes separated by commas, semicolons, or pipes (US,JP · US;JP · US|JP), in a string or an array element. An empty or separator-only value is rejected, never read as "all".',
      ),
    date_range: z
      .string()
      /**
       * Both endpoints of a range must share a period type — the API rejects a
       * mixed range such as `2020Q1:2021`. Surrounding whitespace and a blank
       * value are tolerated because form-based clients submit every field; the
       * handler treats blank as absent.
       */
      .regex(
        /^\s*(?:\d{4}(?::\d{4})?|\d{4}[Qq][1-4](?::\d{4}[Qq][1-4])?|\d{4}[Mm](?:0[1-9]|1[0-2])(?::\d{4}[Mm](?:0[1-9]|1[0-2]))?)?\s*$/,
        'date_range must be a single period or a range of two periods of the same type: YYYY, YYYYQ1–Q4, or YYYYM01–M12 (e.g. "2020", "2010:2023", "2020Q1:2021Q4", "2020M01:2020M06").',
      )
      .optional()
      .describe(
        "A period, or two of the same form joined by a colon, earliest first: years (`2020`, `2010:2023`), quarters (`2020Q1:2021Q4`), or months (`2020M01:2020M06`). On a series publishing several forms the window's form picks the periods, null-filled where the series lacks it (with a notice); on a single-form series a window at another form keeps the periods it overlaps (`2019:2021` on a quarterly series gives twelve quarters). A window outside the series returns no observations.",
      ),
    mrv: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'The N latest periods (1–100, at most the series length) where any requested country has a value; every country comes back at those periods, null where it has none. Rows are mrv × countries.',
      ),
    mrnev: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Each requested country's own N latest non-null values (1–100), however far back; a country with fewer returns those it has, and one with none returns no rows.",
      ),
    frequency: z
      .union([
        z.literal(''),
        z
          .enum(FREQUENCIES)
          .describe('annual (2025), quarterly (2025Q4), or monthly (2025M12) periods.'),
      ])
      .optional()
      .describe(
        'Period form, for series that also publish quarterly or monthly values (Global Economic Monitor): annual (default; a series with no annual periods keeps its own), quarterly, or monthly. It applies to mrv and mrnev ("monthly" with mrv 3 gives the three latest months), or alone to the whole series. A form the series lacks returns no rows, or null rows on a whole-series read from a source that null-fills it; a notice says so.',
      ),
    dimension_value: z
      .string()
      .optional()
      .describe(
        'For a source-scoped indicator (the response carries sourceScoped), the value of its dataset\'s extra dimension, by id or full label, case-insensitively, ids matched first: a WDI Database Archives release ("202503" or "2025 Mar"), an ICP or Food Prices for Nutrition classification ("PPPGlob", "FPN 5.0"), a GDLD sector ("WHT"), or an International Debt Statistics counterpart area ("730" or "China"). Omit for the default, which sourceScoped.dimension reports.',
      ),
    page: z.number().int().min(1).default(1).describe('Page number, 1-based.'),
    per_page: perPageInput(MAX_OBSERVATIONS_PER_PAGE),
  }),
  output: z.object({
    sourceId: z
      .string()
      .optional()
      .describe('ID of the source that served the values, when known.'),
    data: z
      .array(
        z
          .object({
            countryCode: z
              .string()
              .describe("ISO2 code (US; XD for High income), or a source-only entity's opaque ID."),
            countryIso3: z
              .string()
              .describe(
                'Three-character code (USA, HIC), the form countries takes; empty for an entity the World Bank country listing lacks.',
              ),
            countryName: z.string().describe('Country or aggregate name.'),
            date: z.string().describe('Period: year (2020), quarter (2020Q1), or month (2020M03).'),
            value: z
              .number()
              .nullable()
              .describe(
                'Indicator value; null where the series has no data for this country and period, common in sparse series.',
              ),
            obsStatus: z
              .string()
              .describe('Observation status code flagging a data-quality note; empty when none.'),
            isAggregate: z.boolean().describe('True for a regional or income-group aggregate.'),
            dimension: z
              .object({
                id: z.string().describe('Dimension value id, e.g. "202503".'),
                label: z.string().describe('Dimension value label, e.g. "2025 Mar".'),
              })
              .optional()
              .describe(
                "This row's value of the dataset's extra dimension, on source-scoped rows of a dataset that has one.",
              ),
          })
          .describe('One country-period observation.'),
      )
      .describe('Observations on this page.'),
    sourceScoped: z
      .object({
        sourceId: z.string().describe('Serving source ID.'),
        sourceName: z.string().describe('Serving source name, e.g. "WDI Database Archives".'),
        dimension: z
          .object({
            concept: z
              .string()
              .describe(
                'The extra dimension: Version, Classification, Sector, or Counterpart-Area.',
              ),
            selection: z
              .enum([
                'requested',
                'only_value',
                'world_total',
                'newest_with_data',
                'newest',
                'every_value',
              ])
              .describe(
                "How the value was chosen: requested (dimension_value), only_value (the dataset's only value), world_total (WLD, all counterpart areas), newest_with_data (newest release with a value for the requested countries and periods), newest (newest release; none has one), or every_value (each row carries its own).",
              ),
            id: z.string().nullable().describe('Applied value id; null for every_value.'),
            label: z.string().nullable().describe('Applied value label; null for every_value.'),
          })
          .nullable()
          .describe('Dimension value applied; null when the dataset has no extra dimension.'),
        note: z.string().describe('Provenance note for these values.'),
      })
      .optional()
      .describe(
        'Present when the source-scoped data API served the values, for a source_id or the fallback.',
      ),
    indicator: z
      .object({
        id: z.string().describe('Indicator ID.'),
        name: z.string().describe('Indicator name.'),
      })
      .describe('The indicator queried.'),
    nullCount: z.number().describe('Null values on this page.'),
  }),

  // Agent-facing context: pagination totals and query orientation. Kept out of the
  // domain return so it reaches both structuredContent and content[] automatically.
  enrichment: {
    appliedFilters: z
      .object({
        sourceId: z.string().optional().describe('source_id requested.'),
        indicatorId: z.string().describe('Indicator ID queried.'),
        countries: z
          .string()
          .describe('Country codes as requested, split and rejoined with semicolons.'),
        dateRange: z.string().optional().describe('date_range applied.'),
        mrv: z.number().optional().describe('mrv applied.'),
        mrnev: z.number().optional().describe('mrnev applied.'),
        frequency: z.enum(FREQUENCIES).optional().describe('frequency applied.'),
        dimensionValue: z.string().optional().describe('dimension_value requested.'),
        page: z.number().describe('Page requested.'),
        perPage: z.number().describe('Page size served, after any reduction to the page maximum.'),
        requestedPerPage: z
          .number()
          .optional()
          .describe(
            'Page size asked for, or the server default; present only when perPage was reduced.',
          ),
      })
      .describe('Parameters in force for these observations; a filter not applied is omitted.'),
    totalCount: z.number().describe('Observations before pagination.'),
    currentPage: z
      .number()
      .describe('Page number; past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total pages at perPage.'),
    lastUpdated: z
      .string()
      .optional()
      .describe(
        'Last update (YYYY-MM-DD) of the source that served these values, the vintage to cite; omitted when upstream reports none.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Explains empty or all-null results, missing countries or periods, a page past the end, or a reduced page size.',
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
       * so the heading has to be part of what it returns — otherwise the echo
       * lands as a bare run of `key=value` pairs among `**field:** value` lines
       * with nothing naming it.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          `indicator_id=${escapeMarkdownInline(filters.indicatorId)}`,
          ...(filters.sourceId === undefined
            ? []
            : [`source_id=${escapeMarkdownInline(filters.sourceId)}`]),
          `countries=${escapeMarkdownInline(filters.countries)}`,
          ...(filters.dateRange === undefined
            ? []
            : [`date_range=${escapeMarkdownInline(filters.dateRange)}`]),
          ...(filters.mrv === undefined ? [] : [`mrv=${filters.mrv}`]),
          ...(filters.mrnev === undefined ? [] : [`mrnev=${filters.mrnev}`]),
          ...(filters.frequency === undefined ? [] : [`frequency=${filters.frequency}`]),
          ...(filters.dimensionValue === undefined
            ? []
            : [`dimension_value=${escapeMarkdownInline(filters.dimensionValue)}`]),
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
      reason: 'invalid_params',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of date_range, mrv, and mrnev, or frequency with date_range.',
      recovery:
        "Keep one of date_range, mrv, or mrnev and remove the others: date_range for a time window, mrv for the latest periods across the countries, mrnev for each country's own latest values. Drop frequency when date_range is set: the window's own period form (2024, 2024Q1:2024Q4, 2024M01:2024M12) already picks the periods.",
    },
    {
      reason: 'mixed_all_selector',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'countries mixes "all" with codes.',
      recovery:
        'Pass "all" on its own for every entry, or drop it and list only the country codes.',
    },
    {
      reason: 'reversed_date_range',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_range runs latest first.',
      recovery:
        'Swap the two periods so date_range runs earliest period first, e.g. 2010:2020 rather than 2020:2010.',
    },
    {
      reason: 'multiple_indicators',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'indicator_id is "all".',
      recovery:
        'Pass a single indicator ID; use worldbank_search_indicators to find the indicator to query.',
    },
    {
      reason: 'indicator_not_found',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'Unknown indicator_id.',
      recovery: 'Use worldbank_search_indicators to find valid indicator IDs by keyword or topic.',
    },
    {
      reason: 'indicator_not_queryable',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'Neither the standard data endpoint nor a source-scoped dataset can serve the indicator.',
      recovery:
        'Changing the countries, dates, or dimension_value will not help. Use worldbank_search_indicators to find another indicator for the same measure.',
    },
    {
      reason: 'unknown_dimension_value',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: "dimension_value matches no id or label of the dataset's extra dimension.",
      recovery:
        'Pass one of the ids the error message lists for this indicator, or the label quoted beside one in full, or omit dimension_value to use the default the response reports.',
    },
    {
      reason: 'ambiguous_dimension_value',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'dimension_value is a label several values share.',
      recovery:
        'Pass one of the ids the error message names in place of the label; each id selects one of the values sharing it.',
    },
    {
      reason: 'dimension_not_applicable',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'dimension_value is given for an indicator with no extra dimension.',
      recovery: 'Remove dimension_value; this indicator has no extra dimension to select.',
    },
    {
      reason: 'source_scope_too_large',
      severity: 'notice',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A source-scoped query exceeds the per-request row limit.',
      recovery:
        'Narrow countries or date_range, or pin dimension_value; a narrower call reports the default value it applied in sourceScoped.dimension, which can then be pinned.',
    },
    {
      reason: 'country_not_found',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more country codes are invalid.',
      recovery: 'Use worldbank_list_countries to browse valid ISO2, ISO3, and aggregate codes.',
    },
    {
      reason: 'indicator_and_country_not_found',
      severity: 'notice',
      code: JsonRpcErrorCode.NotFound,
      when: 'Both indicator_id and country codes are invalid.',
      recovery:
        'Look the indicator up with worldbank_search_indicators and the codes with worldbank_list_countries before retrying.',
    },
    {
      reason: 'upstream_inconsistent',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Indicators API returned conflicting data reads for a valid request.',
      recovery:
        'Retry later, or change the countries list, which sends a request the stale cached answer does not match.',
      retryable: true,
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      thrownBy: 'service',
      when: "The World Bank Indicators API did not answer every read within the call's 50-second budget.",
      recovery:
        'The request is valid. Repeat the same call unchanged after about a minute: the World Bank Indicators API finishes a request after this server stops waiting and caches the answer, so the repeat is usually served from that cache. A changed call starts a new computation.',
    },
  ],

  async handler(input, ctx) {
    const dateRange = input.date_range?.trim() || undefined;
    const scopes = [
      ...(dateRange ? ['date_range'] : []),
      ...(input.mrv === undefined ? [] : ['mrv']),
      ...(input.mrnev === undefined ? [] : ['mrnev']),
    ];
    if (scopes.length > 1) {
      throw ctx.fail(
        'invalid_params',
        `Provide at most one of date_range, mrv, and mrnev; this call sets ${scopes.join(' and ')}.`,
      );
    }
    const frequency = input.frequency || undefined;
    if (frequency && dateRange) {
      throw ctx.fail(
        'invalid_params',
        `frequency "${frequency}" cannot be combined with date_range "${dateRange}": the window's own period form picks its periods.`,
      );
    }

    /**
     * The data endpoint rejects `all` in place of an indicator with the same
     * envelope as a bad code, and the catalog lookup that places the rejection
     * finds rows for `all`, which would blame valid country codes.
     */
    if (isAllSelector(input.indicator_id)) {
      throw ctx.fail(
        'multiple_indicators',
        `indicator_id "${input.indicator_id}" selects every indicator; the data endpoint serves one indicator per call.`,
        { indicatorId: input.indicator_id },
      );
    }

    const dimensionValue = input.dimension_value?.trim() ? input.dimension_value.trim() : undefined;
    const codes = splitCountryCodes(input.countries);
    const countryCodes = codes.join(';');

    if (mixesAll(codes)) {
      throw ctx.fail(
        'mixed_all_selector',
        `"all" cannot be combined with other country codes (${codes.join(', ')}): it already selects every entry.`,
        { countries: codes },
      );
    }

    if (dateRange !== undefined) {
      /**
       * Every period form is fixed-width and zero-padded, and the schema pattern
       * forces both endpoints to the same form, so ordering is a plain string
       * comparison.
       */
      const [start = '', end] = dateRange.toUpperCase().split(':');
      if (end !== undefined && start > end) {
        throw ctx.fail(
          'reversed_date_range',
          `date_range "${dateRange}" runs backwards: ${start} comes after ${end}.`,
          { dateRange },
        );
      }
    }

    ctx.log.info('Fetching indicator data', {
      indicatorId: input.indicator_id,
      countries: countryCodes,
      dateRange,
      mrv: input.mrv,
      mrnev: input.mrnev,
      frequency,
      dimensionValue,
      page: input.page,
    });

    const pageSize = resolvePerPage(
      { tool: 'worldbank_get_data', cap: MAX_OBSERVATIONS_PER_PAGE, perPage: input.per_page },
      ctx,
    );
    let result: DataResult;
    try {
      result = await getWorldBankApiService().getData(
        {
          indicatorId: input.indicator_id,
          ...(input.source_id?.trim() && { sourceId: input.source_id.trim() }),
          countries: codes,
          ...(dateRange !== undefined && { dateRange }),
          ...(input.mrv !== undefined && { mrv: input.mrv }),
          ...(input.mrnev !== undefined && { mrnev: input.mrnev }),
          ...(frequency !== undefined && { frequency: FREQUENCY_FORM[frequency] }),
          ...(dimensionValue !== undefined && { dimensionValue }),
          page: input.page,
          perPage: pageSize.served,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        if (err.data?.reason === 'source_not_found' || err.data?.reason === 'source_not_queryable')
          throw ctx.fail(err.data.reason, err.message, err.data);
        const reason = err.data?.reason as string | undefined;
        if (reason === 'indicator_not_found') {
          throw ctx.fail('indicator_not_found', err.message, {
            ...err.data,
            indicatorId: input.indicator_id,
          });
        }
        if (reason === 'indicator_not_queryable') {
          throw ctx.fail('indicator_not_queryable', err.message, {
            ...err.data,
            indicatorId: input.indicator_id,
          });
        }
        if (reason === 'country_not_found') {
          throw ctx.fail('country_not_found', err.message, {
            ...err.data,
            countries: codes,
          });
        }
        if (reason === 'indicator_and_country_not_found') {
          throw ctx.fail('indicator_and_country_not_found', err.message, {
            ...err.data,
            indicatorId: input.indicator_id,
            countries: codes,
          });
        }
        // The ids these messages list render as code spans: the values to send back.
        if (reason === 'unknown_dimension_value' || reason === 'ambiguous_dimension_value') {
          throw ctx.fail(
            reason,
            err.message,
            { ...err.data, indicatorId: input.indicator_id, dimensionValue },
            err.literals && { literals: err.literals },
          );
        }
        if (reason === 'dimension_not_applicable') {
          throw ctx.fail('dimension_not_applicable', err.message, {
            ...err.data,
            indicatorId: input.indicator_id,
            dimensionValue,
          });
        }
        if (reason === 'source_scope_too_large') {
          throw ctx.fail('source_scope_too_large', err.message, {
            ...err.data,
            indicatorId: input.indicator_id,
          });
        }
        if (reason === 'upstream_inconsistent') {
          throw ctx.fail('upstream_inconsistent', err.message, {
            ...err.data,
            indicatorId: input.indicator_id,
          });
        }
      }
      throw err;
    }

    ctx.enrich({
      appliedFilters: {
        ...(input.source_id?.trim() && { sourceId: input.source_id.trim() }),
        indicatorId: input.indicator_id,
        countries: countryCodes,
        ...(dateRange !== undefined && { dateRange }),
        ...(input.mrv !== undefined && { mrv: input.mrv }),
        ...(input.mrnev !== undefined && { mrnev: input.mrnev }),
        ...(frequency !== undefined && { frequency }),
        ...(dimensionValue !== undefined && { dimensionValue }),
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < pageSize.requested && { requestedPerPage: pageSize.requested }),
      },
    });
    ctx.enrich({ totalCount: result.total, currentPage: result.page, totalPages: result.pages });
    if (result.lastUpdated) ctx.enrich({ lastUpdated: result.lastUpdated });

    const latest =
      input.mrnev !== undefined
        ? `mrnev=${input.mrnev}`
        : input.mrv !== undefined
          ? `mrv=${input.mrv}`
          : undefined;
    const notices: string[] = [];
    const published = (result.periodForms ?? []).map((form) => FORM_FREQUENCY[form]);
    if (result.overlapCheckUnavailable) {
      notices.push(
        `The World Bank returned no rows for "${dateRange}". It could not check overlapping periods at another frequency. Repeat the same call to check coverage.`,
      );
    } else if (
      result.total === 0 &&
      frequency &&
      published.length > 0 &&
      !published.includes(frequency)
    ) {
      notices.push(
        `"${result.indicator.id}" publishes no ${frequency} periods — only ${published.join(' and ')} ones — ` +
          `so frequency "${frequency}" has nothing to return. Use frequency "${published[0]}", or omit frequency.`,
      );
    } else if (result.total === 0 && frequency) {
      const others = FREQUENCIES.filter((f) => f !== frequency).map((f) => `"${f}"`);
      notices.push(
        `No requested country has a ${frequency} value in this series, which may not publish ${frequency} figures at all. ` +
          `Try frequency ${others.join(' or ')}, or other countries.`,
      );
    } else if (result.total === 0) {
      notices.push(
        result.dateFilterDropped
          ? `No observations fall inside date_range "${dateRange}", though the series does carry data outside it. ` +
              "Broaden date_range or use mrnev to fetch each country's latest available values."
          : latest
            ? `No requested country has a value anywhere in this series, so ${latest} had nothing to select. ` +
              'Try other countries, frequency "quarterly" or "monthly" for a series publishing those, or a better-covered indicator from worldbank_search_indicators.'
            : 'No observations returned for the requested filter. ' +
              "Try broadening the date range, removing date filters, or using mrnev=1 to fetch each country's latest available value.",
      );
    } else if (result.data.length === 0) {
      notices.push(
        pagePastEndNotice({
          noun: ['observation', 'observations'],
          page: result.page,
          pages: result.pages,
          perPage: result.perPage,
          total: result.total,
        }),
      );
    }
    const allNull = dateRange && result.allNull ? allNullWindowNotice(dateRange) : undefined;
    if (allNull) notices.push(allNull);
    /**
     * A source that null-fills a form a series lacks (Global Economic Monitor)
     * answers a whole-series read at that form with null rows rather than none.
     */
    if (frequency && !latest && result.data.length > 0 && result.nullCount === result.data.length) {
      const others = FREQUENCIES.filter((f) => f !== frequency).map((f) => `"${f}"`);
      notices.push(
        `Every observation on this page is null: this series may not publish ${frequency} values, or none for these countries at these periods. ` +
          `Try frequency ${others.join(' or ')}, or mrnev with frequency "${frequency}", which returns only the values that exist.`,
      );
    }
    const reduced = pageSizeReducedNotice({
      requested: pageSize.requested,
      served: result.perPage,
      page: result.page,
      pages: result.pages,
    });
    if (reduced) notices.push(reduced);
    const uncovered = result.uncoveredCountries ?? [];
    if (result.sourceScoped && uncovered.length > 0) {
      const { sourceName, sourceId } = result.sourceScoped;
      notices.push(
        `${sourceName} (source ${sourceId}) publishes no data for ${uncovered.join(', ')}, so ` +
          `${uncovered.length === 1 ? 'that code was' : 'those codes were'} left out of the query.`,
      );
    }
    if (result.missingLatestCodes?.length) {
      notices.push(`No non-null value selected for ${result.missingLatestCodes.join(', ')}.`);
    }
    if (result.unresolvedLatestCodes?.length) {
      notices.push(
        `Could not check ${result.unresolvedLatestCodes.join(', ')} against the selected values because the country index was unavailable.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      data: result.data,
      indicator: result.indicator,
      nullCount: result.nullCount,
      ...(result.sourceId !== undefined && { sourceId: result.sourceId }),
      ...(result.sourceScoped && { sourceScoped: result.sourceScoped }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      escapeMarkdownInline(result.indicator.name || result.indicator.id),
      `**ID:** ${escapeMarkdownInline(result.indicator.id)} | **Null values this page:** ${result.nullCount}\n`,
    ];

    const scoped = result.sourceScoped;
    if (result.sourceId !== undefined)
      lines.push(`**Serving source ID:** ${escapeMarkdownInline(result.sourceId)}`);
    if (scoped) {
      lines.push(
        `**Source-scoped data:** ${escapeMarkdownInline(scoped.sourceName)} (source ${escapeMarkdownInline(scoped.sourceId)}). ${escapeMarkdownInline(scoped.note)}`,
        `${renderDimension(scoped.dimension)}\n`,
      );
    }
    const pinnedId = scoped?.dimension?.id;

    // Group by country for readability
    type Row = (typeof result.data)[number];
    const byCountry = new Map<string, [Row, ...Row[]]>();
    for (const d of result.data) {
      const key = JSON.stringify([d.countryCode, d.countryName]);
      const bucket = byCountry.get(key);
      if (bucket) bucket.push(d);
      else byCountry.set(key, [d]);
    }

    for (const rows of byCountry.values()) {
      const { countryCode: code, countryName: name, isAggregate, countryIso3: iso3 } = rows[0];
      const aggTag = isAggregate ? ' [Aggregate]' : '';
      const iso3Str = iso3 ? ` / ${escapeMarkdownInline(iso3)}` : '';
      lines.push(
        `${escapeMarkdownInline(name)} (${escapeMarkdownInline(code)}${iso3Str})${aggTag}`,
      );
      for (const row of rows) {
        const valStr = row.value !== null ? String(row.value) : 'No data';
        const statusStr = row.obsStatus
          ? ` [obs_status: ${escapeMarkdownInline(row.obsStatus)}]`
          : '';
        const dimensionStr =
          row.dimension && row.dimension.id !== pinnedId
            ? ` [${escapeMarkdownInline(row.dimension.id)}: ${escapeMarkdownInline(row.dimension.label)}]`
            : '';
        lines.push(`- **${escapeMarkdownInline(row.date)}:** ${valStr}${dimensionStr}${statusStr}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
