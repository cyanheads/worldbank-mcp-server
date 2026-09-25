/**
 * @fileoverview Query World Bank indicator values for countries across a time range.
 * The primary data-access tool.
 * @module mcp-server/tools/definitions/worldbank-get-data.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { pagePastEndNotice } from '@/mcp-server/tools/page-past-end-notice.js';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';
import { MAX_OBSERVATIONS_PER_PAGE, RESPONSE_BUDGET_KB } from '@/services/response-budget.js';
import {
  COUNTRY_LIST_CONTENT,
  INDICATOR_ID,
  INDICATOR_ID_MESSAGE,
  isAllSelector,
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
    dimension.id === null ? 'every value' : `${dimension.label ?? ''} (\`${dimension.id}\`)`;
  return `**${dimension.concept}:** ${applied} — selection: ${dimension.selection} (${SELECTION_MEANING[dimension.selection]})`;
}

/**
 * An empty value is a missing required input, so the schema rejects it. A mixed
 * `"all"` and a reversed `date_range` are well-shaped mistakes a caller corrects
 * and retries, so the handler rejects those against declared reasons.
 */
const EMPTY_COUNTRIES_MESSAGE = 'Provide at least one country code, or "all" for every entry.';

export const worldbankGetData = tool('worldbank_get_data', {
  title: 'Get World Bank Indicator Data',
  description: `Query World Bank indicator values for one or more countries across a time range — the primary data-access tool; find indicator_id values with worldbank_search_indicators. Observations carry a null value where data is not available for a country×year cell, which is common for sparse series. Set at most one of date_range (a time window), mrv (the latest N periods across the requested countries), or mrnev (each country's own latest N values). Some series, such as Global Economic Monitor's, publish quarterly or monthly values beside annual ones: frequency picks the form mrv and mrnev select from (annual by default), and a date_range's own form (2024, 2024Q1, 2024M01) picks it for a window. lastUpdated gives the serving source's last update date, the data vintage to cite. For "all" countries, page through the results at up to ${MAX_OBSERVATIONS_PER_PAGE} per page, since the API returns several hundred entries per indicator. Indicators the standard data endpoint does not serve — WDI Database Archives, PEFA, ICP, GDLD, International Debt Statistics: DSSI, Food Prices for Nutrition — are answered from their own dataset instead; the response then carries sourceScoped, naming that dataset and the release, classification, sector, or counterpart area applied (see dimension_value), because those values can be archived or superseded figures rather than current ones.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputAliases: { limit: 'per_page' },
  input: z.object({
    indicator_id: z
      .string()
      .regex(INDICATOR_ID, INDICATOR_ID_MESSAGE)
      .describe(
        'One indicator code to query (e.g. NY.GDP.PCAP.CD, SP.POP.TOTL) — not "all" or a list of codes. Use worldbank_search_indicators to find valid IDs.',
      ),
    countries: z
      .union([
        z
          .string()
          .regex(COUNTRY_LIST_CONTENT, EMPTY_COUNTRIES_MESSAGE)
          .describe(
            'A single country code, a list separated by commas, semicolons, or pipes, or "all".',
          ),
        z
          .array(z.string().describe('A country code.'))
          .min(1)
          /**
           * Checked against what the split actually yields, not against raw
           * element length: the API reads an empty country segment as every
           * entry, so an array holding nothing but separators must not reach it.
           */
          .refine((codes) => splitCountryCodes(codes).length > 0, EMPTY_COUNTRIES_MESSAGE)
          .describe(
            'An array of country codes; an element holding several codes separated by commas, semicolons, or pipes is split too.',
          ),
      ])
      .describe(
        'Country codes. Accepts: ISO2 (US, CN), ISO3 (USA, CHN), regional aggregate codes (EAS, LCN, MEA, SAS, SSF, ECS, NAC), income group codes (HIC, UMC, LMC, LIC), world code (WLD), or "all" on its own for every entry (use pagination). Pass a single code, an array, or one string separated by commas, semicolons, or pipes (US,JP · US;JP · US|JP). At least one code is required — an empty value, or one made only of separators, is rejected rather than treated as "all".',
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
        "Time window to filter observations to. Accepts a whole year (`2020`), a quarter (`2020Q1`), or a month (`2020M03`), or a range of two periods of the same type separated by a colon, earliest first (`2010:2023`, `2020Q1:2021Q4`, `2020M01:2020M06`); a range running latest first is rejected. On a series publishing more than one period form, the window's form picks which: `2024` returns the annual value, `2024Q1:2024Q4` the quarters, `2024M01:2024M12` the months, and a quarter or month window is null-filled where the series has none (a notice then names the other forms). On a series with one form, a window at another form keeps the periods it overlaps (`2019:2021` on a quarterly series returns its twelve quarters). A window covering no part of the series returns zero observations rather than the full series. Mutually exclusive with mrv, mrnev, and frequency.",
      ),
    mrv: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Return the N most recent periods (1–100) holding a value for any requested country, clamped to the length of the series. Every requested country comes back at those periods, null where it has no value there rather than with its own older values; mrnev returns each country's own latest values instead. The periods are annual unless frequency names another form (a series with no annual periods keeps its own). Rows are mrv × countries, so page through them with per_page. Mutually exclusive with date_range and mrnev.",
      ),
    mrnev: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Return each requested country's own N most recent periods (1–100) holding a value — its latest non-null observations, however far back they sit. A country with fewer values in the series returns the ones it has, and a country with none returns no rows. The periods are annual unless frequency names another form (a series with no annual periods keeps its own). Mutually exclusive with date_range and mrv.",
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
        'The period form to return, for series such as Global Economic Monitor\'s that publish quarterly or monthly values beside annual ones: annual (the default), quarterly, or monthly. With mrv or mrnev it picks the form they select from — frequency "monthly" with mrv 3 returns the three latest months, where mrv 3 alone returns the three latest years. With neither, it returns the whole series at that form. A series that does not publish the form returns an empty result with a notice saying so, except that with neither mrv nor mrnev a source that null-fills the form (Global Economic Monitor) returns null rows, and a page of them carries a notice. Mutually exclusive with date_range, whose own form (2024, 2024Q1, 2024M01) picks the periods of a window.',
      ),
    dimension_value: z
      .string()
      .optional()
      .describe(
        'For indicators answered from their own dataset (the response carries sourceScoped), the id of the value of that dataset\'s extra dimension to query, matched case-insensitively: a WDI Database Archives release ("202503"), an ICP or Food Prices for Nutrition classification ("PPPGlob", "FPN 5.0"), a GDLD sector ("WHT"), or an International Debt Statistics counterpart area ("265"). Omit it for the default, which sourceScoped.dimension reports: the only value when the dataset has one, "WLD" (World) for counterpart areas, the newest WDI Database Archives release holding data for the requested countries and periods (the newest release when none does), or otherwise every value with each row labelled. A value the dataset does not list is rejected with the valid ids, and a value for an indicator the standard data endpoint serves is rejected too.',
      ),
    page: z.number().int().min(1).default(1).describe('Pagination page number (1-based).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        `Results per page (default: server default, max: 1000). One page holds at most ${MAX_OBSERVATIONS_PER_PAGE} observations, which keeps a response within about ${RESPONSE_BUDGET_KB} KB; a larger value is reduced to that cap and echoed as appliedFilters.perPage, and totalPages is counted at the reduced size, so page + 1 continues where a page ends; notice discloses the reduction whenever the result runs past one page.`,
      ),
  }),
  output: z.object({
    data: z
      .array(
        z
          .object({
            countryCode: z
              .string()
              .describe('ISO2 code of the country or aggregate (US, XD for High income).'),
            countryIso3: z
              .string()
              .describe(
                'Three-character code of the country or aggregate (USA, HIC) — the form the countries input takes. Empty only for an entity the World Bank country listing does not carry.',
              ),
            countryName: z.string().describe('Country or aggregate name.'),
            date: z
              .string()
              .describe(
                'Period of observation: a year (2020), quarter (2020Q1), or month (2020M03).',
              ),
            value: z
              .number()
              .nullable()
              .describe(
                'Indicator value. Null when data is not available for this country×year cell.',
              ),
            obsStatus: z
              .string()
              .describe(
                'Observation status code (empty string when no special status; non-empty values signal data quality notes).',
              ),
            isAggregate: z
              .boolean()
              .describe(
                'True when this row is a regional or income-group aggregate rather than an individual country.',
              ),
            dimension: z
              .object({
                id: z.string().describe('Dimension value id, e.g. "202503".'),
                label: z.string().describe('Dimension value label, e.g. "2025 Mar".'),
              })
              .optional()
              .describe(
                "The value of the dataset's extra dimension (sourceScoped.dimension.concept) this row belongs to. Present on source-scoped rows from a dataset that has one.",
              ),
          })
          .describe('A single country×period observation.'),
      )
      .describe('Indicator observations for this page. Null values are common for sparse series.'),
    sourceScoped: z
      .object({
        sourceId: z.string().describe('ID of the World Bank data source that served the values.'),
        sourceName: z.string().describe('Name of that data source, e.g. "WDI Database Archives".'),
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
                'How the value was chosen: requested (dimension_value), only_value (the only one the dataset lists), world_total (WLD, all counterpart areas), newest_with_data (newest release holding a value for the requested countries and periods), newest (newest release; none holds a value in that scope), or every_value (no single value; each row carries its own).',
              ),
            id: z.string().nullable().describe('Applied value id; null for every_value.'),
            label: z.string().nullable().describe('Applied value label; null for every_value.'),
          })
          .nullable()
          .describe('The dimension value applied; null when the dataset has no extra dimension.'),
        note: z
          .string()
          .describe(
            'States that the values came from the source-scoped data API rather than the standard World Bank data endpoint, and may be archived or superseded figures.',
          ),
      })
      .optional()
      .describe(
        'Present only when the standard data endpoint does not serve the indicator and its catalog source served the values instead. Absent for indicators the standard endpoint serves.',
      ),
    indicator: z
      .object({
        id: z.string().describe('Indicator ID echoed for chaining context.'),
        name: z.string().describe('Indicator name.'),
      })
      .describe('Indicator metadata echoed from the response.'),
    nullCount: z
      .number()
      .describe(
        'Count of null values on this page — indicates data sparsity for the requested filter.',
      ),
  }),

  // Agent-facing context: pagination totals and query orientation. Kept out of the
  // domain return so it reaches both structuredContent and content[] automatically.
  enrichment: {
    appliedFilters: z
      .object({
        indicatorId: z.string().describe('Indicator ID queried.'),
        countries: z
          .string()
          .describe(
            'Country codes as requested, normalized — array elements and strings separated by commas, semicolons, or pipes are split and rejoined with semicolons, the separator the API takes.',
          ),
        dateRange: z
          .string()
          .optional()
          .describe('Date window applied, omitted when none was requested.'),
        mrv: z
          .number()
          .optional()
          .describe('Most-recent-values count applied, omitted when none was requested.'),
        mrnev: z
          .number()
          .optional()
          .describe('Most-recent-non-empty-values count applied, omitted when none was requested.'),
        frequency: z
          .enum(FREQUENCIES)
          .optional()
          .describe(
            'Period form applied (annual, quarterly, monthly), omitted when none was requested.',
          ),
        dimensionValue: z
          .string()
          .optional()
          .describe('dimension_value as requested, omitted when none was given.'),
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
        'The effective parameters sent to the World Bank API — confirms country code normalization and which filters were in force for these observations.',
      ),
    totalCount: z.number().describe('Total observations before pagination.'),
    currentPage: z
      .number()
      .describe('Page number requested — past totalPages when the request ran off the end.'),
    totalPages: z.number().describe('Total number of pages.'),
    lastUpdated: z
      .string()
      .optional()
      .describe(
        'Last update date of the World Bank source that served these values (YYYY-MM-DD) — the data vintage to cite with them. Omitted when upstream reports none, as for an empty result.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint for an empty result set — how to broaden the query when nothing matched, whether the series publishes the requested frequency, or the page range that exists when the requested page is past the end — a quarter or month date_range whose observations are all null, with the same span at the other period forms, a frequency page whose observations are all null, a page size reduced to the page cap, and, for source-scoped data, the requested country codes the serving dataset publishes nothing for.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      /**
       * A per-field `render` replaces the whole trailer line, `label` included,
       * so the heading has to be part of what it returns — otherwise the echo
       * lands as a bare run of `key=value` pairs among `**field:** value` lines
       * with nothing naming it.
       */
      render: (filters) =>
        `**Applied Filters:** ${[
          `indicator_id=${filters.indicatorId}`,
          `countries=${filters.countries}`,
          ...(filters.dateRange === undefined ? [] : [`date_range=${filters.dateRange}`]),
          ...(filters.mrv === undefined ? [] : [`mrv=${filters.mrv}`]),
          ...(filters.mrnev === undefined ? [] : [`mrnev=${filters.mrnev}`]),
          ...(filters.frequency === undefined ? [] : [`frequency=${filters.frequency}`]),
          ...(filters.dimensionValue === undefined
            ? []
            : [`dimension_value=${filters.dimensionValue}`]),
          `page=${filters.page}`,
          `per_page=${filters.perPage}${filters.requestedPerPage === undefined ? '' : ` (requested ${filters.requestedPerPage})`}`,
        ].join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'invalid_params',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of date_range, mrv, and mrnev is provided, or frequency is provided with date_range.',
      recovery:
        "Keep one of date_range, mrv, or mrnev and remove the others: date_range for a time window, mrv for the latest periods across the countries, mrnev for each country's own latest values. Drop frequency when date_range is set: the window's own period form (2024, 2024Q1:2024Q4, 2024M01:2024M12) already picks the periods.",
    },
    {
      reason: 'mixed_all_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'countries combines "all" with one or more country codes.',
      recovery:
        'Pass "all" on its own for every entry, or drop it and list only the country codes.',
    },
    {
      reason: 'reversed_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_range names a range whose first period comes after its second.',
      recovery:
        'Swap the two periods so date_range runs earliest period first, e.g. 2010:2020 rather than 2020:2010.',
    },
    {
      reason: 'multiple_indicators',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The indicator ID is "all", which selects every indicator rather than one.',
      recovery:
        'Pass a single indicator ID; use worldbank_search_indicators to find the indicator to query.',
    },
    {
      reason: 'indicator_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The indicator ID does not exist.',
      recovery: 'Use worldbank_search_indicators to find valid indicator IDs by keyword or topic.',
    },
    {
      reason: 'indicator_not_queryable',
      code: JsonRpcErrorCode.NotFound,
      when: 'The standard data endpoint does not serve the indicator, and no catalog source can serve it through the source-scoped data API instead — the catalog no longer lists the ID, the catalog lookup failed, or the source is not organized by country, series, and time plus at most one further dimension.',
      recovery:
        'Changing the countries, dates, or dimension_value will not help. Use worldbank_search_indicators to find another indicator for the same measure.',
    },
    {
      reason: 'unknown_dimension_value',
      code: JsonRpcErrorCode.ValidationError,
      when: "dimension_value is not a value the indicator's dataset lists for its extra dimension.",
      recovery:
        'Pass one of the dimension ids the error message lists for this indicator, or omit dimension_value to use the default the response reports.',
    },
    {
      reason: 'dimension_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'dimension_value is given for an indicator the standard data endpoint serves, or whose dataset has no dimension beyond country, series, and time.',
      recovery: 'Remove dimension_value; this indicator has no extra dimension to select.',
    },
    {
      reason: 'source_scope_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A source-scoped query would read more rows (countries × periods × unpinned dimension values) than one request allows.',
      recovery:
        'Narrow countries or date_range, or pin dimension_value; a narrower call reports the default value it applied in sourceScoped.dimension, which can then be pinned.',
    },
    {
      reason: 'country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more country codes are invalid. The message and countryCodes name the codes the World Bank country listing lacks, or every requested code when it lacks none.',
      recovery: 'Use worldbank_list_countries to browse valid ISO2, ISO3, and aggregate codes.',
    },
    {
      reason: 'indicator_and_country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The indicator ID and the country codes are both invalid. The codes are named as on country_not_found.',
      recovery:
        'Look the indicator up with worldbank_search_indicators and the codes with worldbank_list_countries before retrying.',
    },
    {
      reason: 'upstream_inconsistent',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The World Bank API answered a data read, and its one re-read, with rows that do not fit the request — its response cache served another query's result — so nothing was served.",
      recovery:
        'Retry later, or change the countries list, which sends a request the stale cached answer does not match.',
      retryable: true,
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
        ctx.recoveryFor('invalid_params'),
      );
    }
    const frequency = input.frequency || undefined;
    if (frequency && dateRange) {
      throw ctx.fail(
        'invalid_params',
        `frequency "${frequency}" cannot be combined with date_range "${dateRange}": the window's own period form picks its periods.`,
        ctx.recoveryFor('invalid_params'),
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
        { ...ctx.recoveryFor('multiple_indicators'), indicatorId: input.indicator_id },
      );
    }

    const dimensionValue = input.dimension_value?.trim() ? input.dimension_value.trim() : undefined;
    const perPage = input.per_page ?? getServerConfig().defaultPerPage;
    const codes = splitCountryCodes(input.countries);
    const countryCodes = codes.join(';');

    if (mixesAll(codes)) {
      throw ctx.fail(
        'mixed_all_selector',
        `"all" cannot be combined with other country codes (${codes.join(', ')}): it already selects every entry.`,
        { ...ctx.recoveryFor('mixed_all_selector'), countries: codes },
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
          { ...ctx.recoveryFor('reversed_date_range'), dateRange },
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

    let result: DataResult;
    try {
      result = await getWorldBankApiService().getData(
        {
          indicatorId: input.indicator_id,
          countries: codes,
          ...(dateRange !== undefined && { dateRange }),
          ...(input.mrv !== undefined && { mrv: input.mrv }),
          ...(input.mrnev !== undefined && { mrnev: input.mrnev }),
          ...(frequency !== undefined && { frequency: FREQUENCY_FORM[frequency] }),
          ...(dimensionValue !== undefined && { dimensionValue }),
          page: input.page,
          perPage,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const reason = err.data?.reason as string | undefined;
        if (reason === 'indicator_not_found') {
          throw ctx.fail('indicator_not_found', err.message, {
            ...err.data,
            ...ctx.recoveryFor('indicator_not_found'),
            indicatorId: input.indicator_id,
          });
        }
        if (reason === 'indicator_not_queryable') {
          throw ctx.fail('indicator_not_queryable', err.message, {
            ...err.data,
            ...ctx.recoveryFor('indicator_not_queryable'),
            indicatorId: input.indicator_id,
          });
        }
        if (reason === 'country_not_found') {
          throw ctx.fail('country_not_found', err.message, {
            ...err.data,
            ...ctx.recoveryFor('country_not_found'),
            countries: codes,
          });
        }
        if (reason === 'indicator_and_country_not_found') {
          throw ctx.fail('indicator_and_country_not_found', err.message, {
            ...err.data,
            ...ctx.recoveryFor('indicator_and_country_not_found'),
            indicatorId: input.indicator_id,
            countries: codes,
          });
        }
        if (reason === 'unknown_dimension_value') {
          throw ctx.fail('unknown_dimension_value', err.message, {
            ...err.data,
            ...ctx.recoveryFor('unknown_dimension_value'),
            indicatorId: input.indicator_id,
            dimensionValue,
          });
        }
        if (reason === 'dimension_not_applicable') {
          throw ctx.fail('dimension_not_applicable', err.message, {
            ...err.data,
            ...ctx.recoveryFor('dimension_not_applicable'),
            indicatorId: input.indicator_id,
            dimensionValue,
          });
        }
        if (reason === 'source_scope_too_large') {
          throw ctx.fail('source_scope_too_large', err.message, {
            ...err.data,
            ...ctx.recoveryFor('source_scope_too_large'),
            indicatorId: input.indicator_id,
          });
        }
        if (reason === 'upstream_inconsistent') {
          throw ctx.fail('upstream_inconsistent', err.message, {
            ...err.data,
            ...ctx.recoveryFor('upstream_inconsistent'),
            indicatorId: input.indicator_id,
          });
        }
      }
      throw err;
    }

    ctx.enrich({
      appliedFilters: {
        indicatorId: input.indicator_id,
        countries: countryCodes,
        ...(dateRange !== undefined && { dateRange }),
        ...(input.mrv !== undefined && { mrv: input.mrv }),
        ...(input.mrnev !== undefined && { mrnev: input.mrnev }),
        ...(frequency !== undefined && { frequency }),
        ...(dimensionValue !== undefined && { dimensionValue }),
        page: input.page,
        perPage: result.perPage,
        ...(result.perPage < perPage && { requestedPerPage: perPage }),
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
    if (result.total === 0 && frequency && published.length > 0 && !published.includes(frequency)) {
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
      requested: perPage,
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
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      data: result.data,
      indicator: result.indicator,
      nullCount: result.nullCount,
      ...(result.sourceScoped && { sourceScoped: result.sourceScoped }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `# ${result.indicator.name || result.indicator.id}`,
      `**ID:** \`${result.indicator.id}\` | **Null values this page:** ${result.nullCount}\n`,
    ];

    const scoped = result.sourceScoped;
    if (scoped) {
      lines.push(
        `> **Source-scoped data:** ${scoped.sourceName} (source ${scoped.sourceId}). ${scoped.note}`,
        `> ${renderDimension(scoped.dimension)}\n`,
      );
    }
    const pinnedId = scoped?.dimension?.id;

    // Group by country for readability
    const byCountry = new Map<string, typeof result.data>();
    for (const d of result.data) {
      const key = `${d.countryCode}|${d.countryName}`;
      let bucket = byCountry.get(key);
      if (!bucket) {
        bucket = [];
        byCountry.set(key, bucket);
      }
      bucket.push(d);
    }

    for (const [key, rows] of byCountry) {
      const [code, name] = key.split('|');
      const aggTag = rows[0]?.isAggregate ? ' [Aggregate]' : '';
      const iso3 = rows[0]?.countryIso3;
      const iso3Str = iso3 ? ` / ${iso3}` : '';
      lines.push(`## ${name} (${code}${iso3Str})${aggTag}`);
      for (const row of rows) {
        const valStr = row.value !== null ? String(row.value) : 'No data';
        const statusStr = row.obsStatus ? ` [obs_status: ${row.obsStatus}]` : '';
        const dimensionStr =
          row.dimension && row.dimension.id !== pinnedId
            ? ` [${row.dimension.id}: ${row.dimension.label}]`
            : '';
        lines.push(`- **${row.date}:** ${valStr}${dimensionStr}${statusStr}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
