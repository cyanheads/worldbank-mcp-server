---
name: worldbank-guide
description: Use with worldbank_* tools for development comparisons, source-specific datasets, poverty and inequality research, or World Bank lending analysis. Resolve dataset-specific identifiers and check time, coverage, and provenance before comparing values or totaling commitments.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use World Bank indicators for development time series, PIP for custom poverty thresholds and survey distributions, and Projects for the Bank's lending operations. These are separate datasets: WDI poverty series and PIP can differ in vintage, and the lending portfolio does not represent all development spending. Access is read-only and keyless.

## Identifiers

- Treat indicator IDs as opaque. Choose a concept through `worldbank_search_indicators`; use `worldbank_get_indicator` to inspect the complete description before selecting between similar measures. Search excerpts can omit the distinction that matters, and synonyms may need separate searches.
- Discover topic and source IDs through `worldbank_list_topics` and `worldbank_list_sources`. A source-specific indicator browse establishes which series belongs to the selected dataset.
- For a selected source, obtain entity IDs through `worldbank_list_countries` scoped to that source. Carry each canonical ID unchanged into `worldbank_get_data` with the same source. Subnational IDs are not ISO codes; source entities do not establish global region, income, or aggregate classifications.
- Keep PIP aggregate codes and Projects operational regions within their own datasets. A WDI grouping is not evidence that another dataset covers the same members.
- For extra dimensions, use IDs accepted by the selected dataset; an unknown-value error supplies valid IDs. Preserve the applied source and dimension in citations and comparisons.

## Gates

1. Establish the measure, unit, geography, and period before comparing observations. A similarly named series can measure a different quantity; never infer units from the indicator code alone.
2. Finish pagination before presenting an exhaustive ranking, count, or commitment total. Use returned page metadata and applied filters to continue; an empty page beyond the end does not mean the dataset has no records.
3. Preserve missing values as unknown. A null observation or commitment is not zero, and missing inequality fields do not establish equality.
4. Inspect data provenance before calling values current. A source-scoped result can represent an archive release or a classification; record its applied dimension and data vintage. A release containing only nulls does not establish that the series never existed.
5. For cross-country comparisons, inspect every observation's period. Each country's latest non-empty value can refer to a different year; select a common period when the question requires contemporaneous values. A newest annual observation can be a partial year on a series that also publishes quarters or months.
6. For poverty comparisons, keep the poverty threshold, PPP vintage, welfare concept, and reporting level comparable. Do not merge PIP aggregates with a grouping reconstructed from current WDI classifications and call them equivalent.
7. For inequality, establish survey coverage before concluding data is absent. Gap-filled economy rows and aggregate rows lack the survey distribution. Keep `estimationType` distinct from `estimateType`: interpolation or extrapolation describes production, while nowcast or projection qualifies the estimate. A missing classification stays unknown; `distributionType` qualifies the distribution without proving survey status.
8. For a sector-defined lending total, use the sector-name filter rather than free-text mentions alone. Free text can match incidental prose. An unknown sector name can return no matches; that alone does not establish no lending in the intended sector.

## Core chain

Discover the indicator, inspect its metadata where the measure is ambiguous, then fetch observations. For a specific dataset, keep discovery, entity listing, and data reads scoped to the same source. Do not substitute another dataset when the selected source has no observations.

## Workflows

**Comparable development indicators.** Resolve the intended measure first, then choose a common time window or explicitly report the differing latest periods. Inspect nulls, aggregate classification, and provenance before calculating comparisons. Avoid mixing aggregate rows with their member economies in a total.

**Subnational or archive data.** Select the source, browse its indicators and entities, and query canonical entity IDs within that source. If an extra dimension applies, inspect the reported selection before widening the query; pinning a release or classification can reduce an oversized scope. Do not interpret an empty ISO3 field on a source-only entity as permission to invent a code.

**Poverty and distribution.** Use `worldbank_get_poverty` for a caller-chosen poverty line or inequality distribution. Seek survey-derived years for Gini and decile comparisons; use gap-filled estimates for poverty trends with their provenance disclosed. Report the estimate's actual year and any nowcast or projection classification when answering a latest-rate question.

**Lending portfolio.** Resolve geography, choose the lifecycle stages and approval window the question requires, and narrow by classifications before totaling. Sector filtering accepts names, including the historical `FY17 - ` spelling, rather than sector codes; differently named categories are not established aliases. There is no sector-discovery tool. Read applied filters and no-match notices rather than silently dropping a failed sector filter. Exhaust the matching pages, retain missing amounts in the result's coverage statement, and distinguish total commitments from their IBRD, IDA, and grant components so components are not added to the total again. Board approval and commitment amounts do not establish actual disbursements. Retrieve abstracts when project-level interpretation needs them.
