# World Bank MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `worldbank_search_indicators` | Search the 29,500+ indicator catalog by keyword, topic, or source. Returns indicator IDs, names, and metadata for chaining. | `query`, `topic_id`, `source_id`, `page`, `per_page` | `readOnlyHint: true` |
| `worldbank_get_indicator` | Fetch full metadata for a known indicator ID: name, description, source, and associated topics. | `indicator_id` | `readOnlyHint: true` |
| `worldbank_get_data` | Query indicator values for one or more countries across a year range. The primary data-access tool. Accepts ISO2/ISO3 country codes, regional aggregate codes (`EAS`, `LCN`, etc.), income-level codes (`HIC`, `LIC`), or `all`. | `indicator_id`, `countries`, `date_range`, `mrv`, `page`, `per_page` | `readOnlyHint: true` |
| `worldbank_list_countries` | List all countries and regional aggregates with metadata: ISO codes, region, income level, capital, coordinates. Filterable by region and income level. | `region`, `income_level`, `include_aggregates`, `page`, `per_page` | `readOnlyHint: true` |
| `worldbank_get_country` | Fetch metadata for a specific country: region, income level, capital, coordinates, lending type. | `country_code` | `readOnlyHint: true` |
| `worldbank_list_topics` | List all 21 thematic topics (Economy & Growth, Health, Education, etc.) with descriptions. Use to browse the indicator space or find a `topic_id` for `worldbank_search_indicators`. | — | `readOnlyHint: true` |
| `worldbank_list_sources` | List the 70+ data sources (World Development Indicators, IDS, Doing Business, etc.) with codes. Use to find a `source_id` for filtering indicator search. | `page`, `per_page` | `readOnlyHint: true` |
| `worldbank_get_poverty` | Poverty headcount, gap, and severity at any poverty line, plus the Gini coefficient, mean log deviation, polarization, and decile shares, from the Poverty and Inequality Platform. Individual economies only. | `countries`, `year`, `poverty_line`, `welfare_type`, `reporting_level`, `fill_gaps`, `page`, `per_page` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `worldbank://indicator/{indicatorId}` | Indicator metadata: name, description, source, topics. Stable reference for known indicators. | No |
| `worldbank://country/{countryCode}` | Country metadata: ISO codes, region, income level, capital, coordinates. | No |

### Prompts

None. Data-access-only server; no recurring interaction patterns warrant a prompt template.

---

## Overview

Exposes the World Bank Open Data API (Indicators API v2) for development economics research, policy analysis, and cross-country comparison workflows. Covers 29,500+ development indicators — GDP, poverty rates, health, education, energy, trade, infrastructure — for 200+ countries and aggregates over 60+ years of data. No authentication required.

Designed as the global complement to BLS (US detail) and EIA (US energy) — provides the international context those servers lack.

## Requirements

- Read-only throughout; no auth or write operations
- Indicator search must handle 29,500+ indicators: keyword search + topic/source filtering is the primary discovery path
- Country queries must support: individual ISO2/ISO3 codes, semicolon-separated multi-country lists, regional aggregates, income-level groups, and `all`
- Year range queries via `date=YYYY:YYYY`; most-recent-values shorthand via `mrv=N`
- Pagination via `page`/`per_page` on all list endpoints; max `per_page` = 1000 for data, no fixed cap on metadata
- No API key required; no rate-limit enforcement needed at server level
- Response data can be sparse: individual country×year cells may be `null` when the WDI doesn't have a value
- Aggregates (regions, income groups, World) are returned alongside individual countries in `all` queries; the server must communicate what type each entry is
- Poverty at a caller-chosen threshold, and the inequality distribution behind it, come from the Poverty and Inequality Platform rather than the WDI series — a second upstream API, with its own envelope, error convention, and survey coverage, and no aggregate support

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `WorldBankApiService` | World Bank Indicators API v2 (`https://api.worldbank.org/v2/`) | All tools and resources except `worldbank_get_poverty` |
| `PipService` | World Bank Poverty and Inequality Platform (`https://api.worldbank.org/pip/v1/`) | `worldbank_get_poverty` |

One service per upstream API. Every Indicators v2 endpoint shares a base URL and the `[paging, items]` envelope, so a single service covers that whole surface. PIP shares none of it — flat JSON array, no pagination, real HTTP status codes — so it gets its own client rather than an extension of `WorldBankApiService`, whose `buildUrl`, `fetchAllPages`, and `isWbErrorEnvelope` are all specific to Indicators v2. What the two share is the framework layer beneath them: `fetchWithTimeout`, `withRetry`, the init/accessor pattern, and HTML-error-page detection against the common Cloudflare front.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `WORLDBANK_API_BASE_URL` | No | Override the Indicators v2 base URL (default: `https://api.worldbank.org/v2`). Useful for testing against local mirrors. |
| `WORLDBANK_PIP_BASE_URL` | No | Override the PIP base URL (default: `https://api.worldbank.org/pip/v1`). |
| `WORLDBANK_DEFAULT_PER_PAGE` | No | Default page size for list/search operations (default: `50`). |
| `WORLDBANK_CATALOG_CACHE_TTL_MS` | No | Lifetime of the in-process reference caches — the indicator catalog behind keyword-only search and the aggregate-code set behind `isAggregate` (default: `3600000`). `0` disables caching and refetches on every use. |

No API key. The World Bank API is fully public.

## Implementation Order

1. Config (`src/config/server-config.ts`) — base URL, default page size
2. `WorldBankApiService` — typed fetch methods for each endpoint category, retry/timeout wiring
3. `worldbank_list_topics` + `worldbank_list_sources` — static reference data, simple to verify
4. `worldbank_list_countries` + `worldbank_get_country` — country metadata
5. `worldbank_search_indicators` + `worldbank_get_indicator` — indicator discovery
6. `worldbank_get_data` — primary data tool; most complex due to multi-country and aggregate handling
7. Resources — `worldbank://indicator/{id}` and `worldbank://country/{code}`
8. `PipService` + `worldbank_get_poverty` — a second upstream API with its own envelope, error convention, and survey-vs-gap-filled merge

Each step is independently testable against the live API.

---

## Domain Mapping

The API has four endpoint families. All return the same envelope: `[{ page, pages, per_page, total }, [...items]]`.

| Noun | Endpoint | Operations |
|:-----|:---------|:-----------|
| Indicator | `GET /v2/indicator` | list (paginated), filter by source (`?source=`). `?searchterm=` exists but does not filter — see the note under `worldbank_search_indicators`. |
| Indicator | `GET /v2/indicator/{id}` | get by ID |
| Indicator | `GET /v2/topic/{id}/indicator` | list indicators for a topic |
| Country | `GET /v2/country` | list (paginated); includes aggregates intermixed |
| Country | `GET /v2/country/{code}` | get by ISO2, ISO3, or aggregate code |
| Data | `GET /v2/country/{codes}/indicator/{id}` | query data; `{codes}` = single code, `;`-delimited list, or `all` |
| Topic | `GET /v2/topic` | list all 21 topics |
| Source | `GET /v2/source` | list all ~71 sources |

Key query parameters for the data endpoint:

| Parameter | Format | Purpose |
|:----------|:-------|:--------|
| `date` | `YYYY`, `YYYYQ1`–`Q4`, `YYYYM01`–`M12`, or a range of two periods of the same type | Filter to a period or range. A window the API can't apply — no overlap with the series, or a granularity the series doesn't carry — is silently discarded upstream and the full series comes back, so the returned periods are checked against the requested ones locally |
| `mrv` | integer | Most recent N values (alternative to `date`) |
| `page` | integer | Pagination page |
| `per_page` | integer | Results per page (max: API allows up to 1000) |
| `format` | `json` | Always required |

The API returns country aggregates (regions, income groups, World) mixed with individual countries in `all` queries. Aggregate entries have `region.id = "NA"` and `incomeLevel.id = "NA"` in the country listing, making them identifiable.

## Workflow Analysis

### Common agent workflows

**Discover then query (most frequent path):**

| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Search for indicator by concept | `worldbank_search_indicators` |
| 2 | Inspect metadata for the best match | `worldbank_get_indicator` (optional) |
| 3 | Query data for countries × years | `worldbank_get_data` |

**Topic-led discovery:**

| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Browse topic list | `worldbank_list_topics` |
| 2 | Search indicators filtered to a topic | `worldbank_search_indicators` + `topic_id` |
| 3 | Query data | `worldbank_get_data` |

**Country profile:**

| # | Call | Tool |
|:--|:-----|:-----|
| 1 | List/find countries filtered by region or income level | `worldbank_list_countries` |
| 2 | Get full metadata for a specific country | `worldbank_get_country` (optional) |
| 3 | Query multiple indicators for that country | `worldbank_get_data` (repeated per indicator) |

**Cross-regional comparison:**

| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Query indicator with regional aggregate codes | `worldbank_get_data` (countries = `EAS;LCN;MEA;SAS;SSF;ECS`) |
| 2 | Follow up with income-group breakdown | `worldbank_get_data` (countries = `LIC;LMC;UMC;HIC`) |

## Tool Specifications

### `worldbank_search_indicators`

Searches the 29,500+ indicator catalog. The critical discovery entry point — without this, an agent must already know an indicator's cryptic ID (e.g., `NY.GDP.PCAP.CD`).

**Input:**
- `query: string` — keyword terms, matched locally. Required unless `topic_id` or `source_id` is provided.
- `topic_id: string | undefined` — numeric topic ID (1–21) to filter by thematic area. Use `worldbank_list_topics` to browse.
- `source_id: string | undefined` — numeric source ID to filter by dataset origin (e.g., `"2"` for World Development Indicators). Use `worldbank_list_sources` to browse.
- `page: number` (default: 1) — pagination page
- `per_page: number` (default: 50, max: 100) — results per page

**Note:** The API's `searchterm` parameter does not filter anything — a nonsense term returns the entire catalog, with or without a topic/source filter present. Keyword matching therefore happens entirely in the service, over the full candidate set for the requested scope: the whole catalog for a keyword-only search, `GET /v2/topic/{id}/indicator` for topic scope, `GET /v2/indicator?source={id}` for source scope. Each scope is fetched exhaustively (loop over the envelope's `pages`) before matching, so a hit on upstream page 2 is reachable. Matching is token-AND over an alphanumeric tokenization: the query is lowercased and split on every run of non-alphanumeric characters, and each resulting term must appear as a substring of the indicator's ID, name, or `sourceNote`. Results are ordered exact ID or name match, then whole-phrase ID/name match, then remaining ID/name matches, then `sourceNote`-only matches.

**Output:**
- `indicators: Array<{ id, name, sourceId, sourceName, topics[], sourceNote }>` — matching indicators
- `total: number` — total matches before pagination
- `page: number`, `pages: number` — pagination state

**Errors:**
- `missing_filter` (`ValidationError`) — none of `query`, `topic_id`, `source_id` given. Recovery: supply one.
- `invalid_filter` (`NotFound`) — `topic_id` or `source_id` doesn't exist upstream (HTTP 200 with the error envelope). Recovery: browse valid IDs with `worldbank_list_topics` / `worldbank_list_sources`.

A search that matches nothing is not an error — it returns an empty `indicators` array with an `enrichment.notice` carrying the recovery hint.

### `worldbank_get_indicator`

Fetches complete metadata for a single known indicator ID.

**Input:**
- `indicator_id: string` — the indicator code (e.g., `NY.GDP.PCAP.CD`)

**Output:**
- `id, name, unit, sourceId, sourceName, sourceNote, sourceOrganization` — full metadata
- `topics: Array<{ id, name }>` — thematic categories

**Errors:**
- `indicator_not_found` (`NotFound`) — the API returns `{"message": [{"id": "120", "key": "Invalid value", "value": "The provided parameter value is not valid"}]}` for unknown indicator IDs (HTTP 200 with a message envelope, not a 404). The service layer must detect this pattern and throw `NotFound`. Recovery: use `worldbank_search_indicators` to find valid indicator IDs.

### `worldbank_get_data`

The primary data access tool. Queries indicator values for countries across a time range.

**Input:**
- `indicator_id: string` — indicator code to query (e.g., `NY.GDP.PCAP.CD`). `.describe()` should include a format example and note to use `worldbank_search_indicators` to discover valid IDs.
- `countries: string | string[]` — one or more country codes. Pass a single string or an array; the service joins arrays with `;` before sending to the API. Accepts:
  - ISO2 codes (`US`, `CN`, `DE`)
  - ISO3 codes (`USA`, `CHN`, `DEU`)
  - Aggregate codes: region (`EAS`, `ECS`, `LCN`, `MEA`, `SAS`, `SSF`), income group (`HIC`, `UMC`, `LMC`, `LIC`), world (`WLD`)
  - `"all"` for all countries + aggregates (several hundred entries, varying by indicator; use pagination)
  - At least one code is required. An empty array, an empty string, or a separator-only string is a `ValidationError` — the API reads an empty path segment as every country, so silently widening would hand back an unrelated dataset.
  - `.describe()` on this parameter should include examples of each form and note that `"all"` returns enough entries to require pagination. Don't pin a count — the row count varies by indicator.
- `date_range: string | undefined` — one period (`2020`, `2020Q1`, `2020M03`) or a range of two periods of the same type, earliest first (`2010:2023`, `2020Q1:2021Q4`, `2020M01:2020M06`). Enforced by a schema `pattern`, so a malformed, mixed-type, or reversed range is a `ValidationError` before any request goes out. Mutually exclusive with `mrv`.
- `mrv: number | undefined` — most recent N values (1–100), clamped upstream to the length of the series. Mutually exclusive with `date_range`.
- `page: number` (default: 1)
- `per_page: number` (default: 50, max: 1000)

**Output:**
- `data: Array<{ countryCode, countryIso3, countryName, date, value, obsStatus, isAggregate }>` — observations; `value` is `null` when WDI has no data for that cell. API source fields: `country.id` (ISO2) → `countryCode`, `countryiso3code` → `countryIso3`, `country.value` → `countryName`, `obs_status` → `obsStatus` (typically empty string; non-empty values signal data quality notes).
- `indicator: { id, name }` — echoed for chaining context
- `total: number`, `page: number`, `pages: number` — pagination state
- `nullCount: number` — count of null values in this page (helps the agent understand data sparsity)

`isAggregate: boolean` distinguishes regional/income-group entries from individual country entries so the agent can split the output if needed.

**Errors:**
- `indicator_not_found` (`NotFound`) — indicator ID doesn't exist. Recovery: use `worldbank_search_indicators` to find valid IDs.
- `country_not_found` (`NotFound`) — one or more country codes are invalid. Recovery: use `worldbank_list_countries` to find valid codes.
- `indicator_and_country_not_found` (`NotFound`) — both the indicator ID and the country codes are invalid. Recovery: look both up before retrying.

The API answers all three with the same HTTP-200 `{"message": [{"id": "120", ...}]}` envelope and never names the parameter it rejected. It does emit one `message` entry per rejected path segment, so two entries prove both are bad; one entry is placed by a follow-up `/indicator/{id}` lookup, which is unambiguous by construction and costs a request only on a path that has already failed.

Zero observations are not an error — the tool returns an empty array with an `enrichment.notice`, matching `worldbank_search_indicators`.

### `worldbank_list_countries`

Lists countries and aggregates with full metadata. Supports filtering.

**Input:**
- `region: string | undefined` — WB region code to filter (e.g., `EAS`, `SSF`, `NAC`). Valid codes are in the `region.id` field of country entries; the API Reference section lists the standard set.
- `income_level: string | undefined` — income group code to filter (`LIC`, `LMC`, `UMC`, `HIC`).
- `include_aggregates: boolean` (default: false) — when false, excludes regional/income-group/world aggregate entries, returning only individual countries.
- `page: number` (default: 1)
- `per_page: number` (default: 50, max: 300)

**Output:**
- `countries: Array<{ id, iso2, name, region: { id, name }, incomeLevel: { id, name }, lendingType, capitalCity, longitude, latitude, isAggregate }>` — country list
- `total: number`, `page: number`, `pages: number`

### `worldbank_get_country`

Fetches metadata for a single country or aggregate entity.

**Input:**
- `country_code: string` — ISO2, ISO3, or aggregate code (e.g., `US`, `USA`, `EAS`)

**Output:**
- Full country metadata as in `worldbank_list_countries` output, single object.

**Errors:**
- `country_not_found` (`NotFound`) — code doesn't exist. Recovery: use `worldbank_list_countries` to browse valid codes.

### `worldbank_list_topics`

Lists all 21 WB thematic topics. Lightweight — no pagination, always ≤21 entries. Returns `topic_id` values for use in `worldbank_search_indicators`.

**Output:**
- `topics: Array<{ id, name, sourceNote }>` — full list, no pagination needed. The API returns `value` instead of `name` on topic objects — map `value` → `name` in the server response for consistency.

### `worldbank_list_sources`

Lists the ~71 WB data sources (datasets). Supports pagination since the list can exceed one page.

**Input:**
- `page: number` (default: 1)
- `per_page: number` (default: 50)

**Output:**
- `sources: Array<{ id, name, code, lastUpdated, dataAvailability, metadataAvailability, concepts }>` — source list. API fields are lowercase (`lastupdated`, `dataavailability`, `metadataavailability`) — map to camelCase in the server response.
- `total: number`, `page: number`, `pages: number`

### `worldbank_get_poverty`

Poverty and inequality estimates from the Poverty and Inequality Platform. The only tool backed by `PipService`.

**Input:**
- `countries: string | string[]` — one or more economies by ISO3 code, or `"all"`. A single string may hold several codes separated by commas or semicolons; both are normalized to the comma-joined form PIP expects, so a caller carrying over `worldbank_get_data`'s semicolon habit is not silently wrong. At least one code is required.
- `year: string | undefined` — a four-digit year, `"all"` for full history, or `"MRV"` for the most recent available. Enforced by a schema `pattern`. Omitted behaves as `"all"`. Blank is read as absent, for form-based clients.
- `poverty_line: number | undefined` — PPP dollars per person per day, 0–2700 (the range PIP itself enumerates). No server-side default: PIP's own default tracks the PPP vintage of the release it is serving, and the applied value comes back on every row as `povertyLine`.
- `welfare_type: 'income' | 'consumption' | undefined` — the two are not directly comparable, so a cross-country comparison is safer pinned to one.
- `reporting_level: 'national' | 'urban' | 'rural' | undefined` — ten economies publish a split, only China with all three levels; every row carries its own `reportingLevel`.
- `fill_gaps: boolean` (default: `true`)
- `page: number` (default: 1), `per_page: number` (default: 50, max: 1000) — applied locally; PIP has no pagination.

**Output:**
- `estimates: Array<{ countryCode, countryName, regionCode, regionName, reportingYear, reportingLevel, welfareType, povertyLine, headcount, povertyGap, povertySeverity, watts, mean, median, gini, mld, polarization, decileShares, population, surveyYear, surveyAcronym, estimationType, isInterpolated }>` — ordered by country, year, reporting level, then welfare type.

Every measure is nullable. `gini`, `mld`, `polarization`, `decileShares`, `surveyYear`, and `surveyAcronym` are populated only on survey-derived rows; `estimationType` (`survey` / `interpolation` / `extrapolation` / `CMD estimation`) is the field that says which kind of row this is. Across the full dataset the correspondence is exact: every `survey` row carries a `gini`, and no row of any other type does. `decileShares` is all ten shares or `null` — never a partial run, which would misreport which decile each share belongs to.

Enrichment carries `appliedFilters` (including the applied `fillGaps`), `totalCount`, `currentPage`, `totalPages`, and a `notice` when the result is empty or contains gap-filled rows.

**Errors:**
- `country_not_found` (`NotFound`) — PIP rejected a country code. Recovery: look the ISO3 code up, and query economies rather than aggregates.
- `invalid_parameter` (`ValidationError`) — PIP rejected some other parameter value. The message names it, and quotes PIP's accepted values when the list is short enough to be useful.
- `upstream_unavailable` (`ServiceUnavailable`) — a 5xx. An aggregate country code produces the same status with no distinguishing detail, so the message offers both causes rather than asserting either.

PIP answers a rejected parameter with a real HTTP 404 whose body names the parameter and enumerates every accepted value. The framework truncates a captured error body at 500 bytes, which lands mid-array for `country` and `year`, so the parameter names are read out of the body with a regex over the `"<name>": {"msg"` prefixes rather than parsed; those prefixes sit at the head of each `details` entry and `msg` appears nowhere else, so a truncated body can drop a later parameter from the list but can never substitute a wrong name. `country` is always the first `details` entry, so the country-not-found branch survives every truncation. A `valid` list is quoted only when the body arrived intact and holds twelve entries or fewer. Zero rows is a successful empty result with a notice, not an error — PIP returns `[]` for a well-formed query that matches nothing.

---

## Design Decisions

| Decision | Rationale |
|:---------|:----------|
| Single `worldbank_get_data` for all data queries | The API returns data in the same shape regardless of whether you query one country, many, a region, or `all`. Splitting by use case would be a 1:1 API-mirror mistake — the tool is already self-sufficient with flexible `countries` input. |
| `countries` accepts both single string and array | Agents most often query 2–6 countries for comparison; array input reads naturally for that case. The service layer joins the array with `;` before calling the API. |
| `include_aggregates` defaults to `false` in `worldbank_list_countries` | Aggregate entries (regions, income groups) look like real countries in the raw API response and confuse country-browsing workflows. A researcher asking "list Sub-Saharan countries" doesn't want `AFR`, `AFE`, `SSA` in the results. Aggregates are fully accessible by setting the flag or querying with aggregate codes directly. |
| Aggregate-free country listing fetches every upstream page | The API has no server-side aggregate filter, so `include_aggregates=false` must filter locally — and can only do that correctly over the complete entity set. A fixed first-page fetch made anything past that page unreachable and made `total`/`pages` under-report silently. `include_aggregates=true` still pages straight through to upstream. |
| `isAggregate` field on data rows | The WDI mixes individual country data with regional aggregates in `all` queries. The agent needs to split or label them correctly for analysis. The data endpoint carries no `region`/`incomeLevel` field, so the flag is a lookup against the aggregate codes derived from `/country` — the same `region.id = "NA"` rule the country tools apply, which keeps all three in agreement by construction. |
| `mrv` vs `date_range` as mutually exclusive | The API supports both `mrv` and `date` independently. They serve different workflows (explore recent trends vs. historical analysis) and combining them yields confusing results. Making them mutually exclusive in the schema forces clarity. |
| All keyword matching is client-side over an exhaustively fetched scope | `?searchterm=` never filters, so there is no server-side search to lean on for any query shape. Every keyword path fetches its whole scope (catalog, topic, or source) by looping the envelope's `pages`, then matches and paginates locally. A single-shot fetch with a fixed page size would silently drop matches past that page. |
| Full-catalog fetch is cached in-process with single-flight | The catalog is ~15 MB / 29.5k rows and paying that on every keyword-only search is untenable. A TTL'd cache on the service instance (`WORLDBANK_CATALOG_CACHE_TTL_MS`, default 1 h) with a shared in-flight promise keeps concurrent searches to one fetch. State lives on the instance, not module scope, so tests and multiple instances stay isolated. |
| Token-AND matching on alphanumeric terms, ranked by specificity | Whole-string substring matching is word-order sensitive: "per capita GDP" returned 8 hits where "gdp per capita" returned 38, for the same intent. Requiring each term independently makes both return the same 108. Splitting on punctuation rather than whitespace is what keeps a copied indicator name working — `Unemployment, female (%)` tokenized on whitespace yields `(%)`, which appears in no name, and the query returns nothing. The looser tokens widen recall, so the exact/phrase ranking tiers do the work of putting the obvious answer first. |
| Duplicate indicator IDs collapse to one row, the archived source dropped | An exhaustively fetched catalog carries 54 IDs twice from two unrelated causes: 43 are the same indicator published under a live source and an archived copy of it, and 11 are single rows that repeat because `/indicator` is not stably ordered between page requests, so a row can land on both sides of a page boundary. Returned as-is they read as distinct indicators, so an agent chains both into `worldbank_get_data` and issues duplicate requests for one series, and `total` counts both rows. Collapsing the fetched pool rather than the catalog is what covers both causes. Keyword search collapses before ranking: the row whose source name contains "Archive" loses, and a tie falls to the lower source ID, so the survivor never depends on the order upstream returned the rows in. `worldbank_get_indicator` applies the same tie-break — `/indicator/{id}` returns the archived row first, so taking the first row reported a different source than search did for the same ID. |
| Empty results are structured success, not `no_match` | A search with zero hits is a valid answer. It returns an empty array plus an `enrichment.notice` carrying the recovery hint, matching `worldbank_get_data`'s empty-result handling. The declared `no_match` error was unreachable and was removed rather than wired up. |
| No `worldbank_compare_countries` workflow tool | A first-class comparison tool is tempting but adds no real value over `worldbank_get_data` with multiple countries — the agent can do the comparison logic. Keeping the surface tight avoids duplicating the data query with a thin wrapper. |
| DataCanvas not used | Data result sets are moderate-sized (200 countries × N years). The 1000-row `per_page` ceiling and typical query sizes (10–50 rows for focused country comparisons) don't warrant the DuckDB overhead. An agent doing deep tabular analysis can call multiple times. This can be revisited if large `all`-country time-series queries prove problematic in practice. |
| One `worldbank_get_poverty`, not a separate `worldbank_get_inequality` | PIP returns the poverty measures and the whole distributional block in the same row, and `poverty_line` does not affect the inequality fields — a second tool would fire an identical upstream request for data the first call already had in hand. The tool-selection cost of hiding "Gini" inside a tool named `get_poverty` is paid in prose: the description names Gini, inequality, and decile distribution explicitly so a search for those concepts lands here. |
| `fill_gaps` defaults to `true`, and the applied value is echoed | Upstream defaults it to `false`, where an ordinary query (`country=IND&year=2019`) returns a bare `[]` rather than an error, because India has no 2019 survey. Defaulting to `true` makes the common query answerable. It is echoed in `appliedFilters` because an agent cannot reason about a fallback it cannot see. |
| Survey rows are fetched first and the gap-fill pass only adds what they left uncovered | `fill_gaps=true` is not a superset of `fill_gaps=false`: PIP strips `gini`, `mld`, `polarization`, the ten deciles, and `survey_year` from **every** row it returns in that mode, including rows for years a survey does exist for (`USA&year=2022` returns `gini: 0.417` without the flag and `gini: null` with it). A single request using the caller's `fill_gaps` value would therefore leave the entire inequality half of this tool permanently null. Asking for survey rows first and merging the gap-filled pass around them keeps the real distribution wherever one exists. What counts as uncovered depends on the request: a single reporting year (`YYYY` or `MRV`) is answered per economy — PIP returns the same row grain in both modes for a year it surveyed, so an economy with a survey row needs nothing added, and `MRV` cannot come back as two rows at two different years. A request spanning the window (`all`, or no `year`) is answered per row grain, because PIP surveys a handful of years and estimates every year around them. |
| Provenance is a first-class output field, not an inference | Gap-filled rows are the common case, since PIP publishes an estimate for nearly every year and surveys only a handful. `estimationType`, `surveyYear`, `surveyAcronym`, and `isInterpolated` ship on every row, and `.describe()` states that null inequality on a gap-filled row is a documented data gap, so an agent can tell "no data for this year" from "this year is an estimate that carries no distributional detail." `isInterpolated` alone is not enough — it is `true` on interpolated and extrapolated rows but `false` on `CMD estimation` rows, which are gap-filled all the same. |
| No server-side default for `poverty_line` | PIP's own default tracks the PPP vintage of the release it serves, which has already moved once ($2.15 under 2017 PPPs, $3.00 under 2021 PPPs). Pinning a number here would silently express the applied line in the wrong vintage after the next revision. The line PIP applied comes back on every row as `povertyLine`. |
| `PipService` is a separate service, not an extension of `WorldBankApiService` | Nothing transfers: `buildUrl()` forces `format=json` plus `page`/`per_page`, which PIP takes neither of; `fetchAllPages()` assumes the `[paging, items]` tuple, where PIP returns a flat array; `isWbErrorEnvelope()` detects an HTTP-200 sentinel, where PIP uses real status codes. The reuse is one level down — `fetchWithTimeout`, `withRetry`, the init/accessor pattern, and HTML-error detection against the shared Cloudflare front. |
| PIP's 5xx retry budget is one retry, not the framework default of three | All 28 aggregate codes PIP advertises among its valid `country` values fail this endpoint with HTTP 500 (`/pip-grp` serves those, and is out of scope), on every attempt. Three retries only delay a settled answer. The one retry is kept for the timeout case instead: PIP computes a query on first sight and caches it, so the attempt that timed out warms the query and the retry usually returns at once. The 500 body carries nothing but `Internal Server Error`, so the message states the status and offers the outage and the aggregate cause side by side rather than asserting one. |
| Resources for country and indicator | Stable, addressable by ID, read-only, useful as injectable context for agents that support resources. Both entities satisfy the resource criteria without redundancy — their tool path (`worldbank_get_country`, `worldbank_get_indicator`) also covers tool-only clients. |

## Known Limitations

- **Search is literal substring matching.** No semantic search, no stemming, no fuzzy matching. An agent searching for "income inequality" won't find the Gini coefficient unless it also tries "Gini". Synonyms require multiple calls. Short terms match inside longer words (`us` hits `housing`), which the ranking tiers mitigate but do not eliminate.
- **Data sparsity is inherent.** Many indicators lack data for specific countries or years — the API returns `null` for those cells without warning. `nullCount` in the response quantifies this; the agent must interpret null values in context.
- **The upstream `searchterm` parameter does not filter.** It is accepted and ignored — a nonsense term still returns the full 29,500-record catalog with the same `total`. There is no server-side full-text search to fall back on, so the service does all keyword matching itself.
- **A keyword-only search costs a full-catalog fetch on a cold cache.** ~15 MB and a few seconds, once per `WORLDBANK_CATALOG_CACHE_TTL_MS` window per process. Topic- and source-scoped searches are far smaller (the largest source is ~1,500 rows).
- **The catalog contains duplicate indicator IDs.** 43 IDs are published twice in `/indicator`, once under a live source and once under an archived copy of it. Keyword search collapses them to one row per ID and `worldbank_get_indicator` resolves to the same row, so the extra copy's `sourceId`/`sourceName` is not reachable through either path. The no-keyword browse paths page straight through upstream without collapsing, which they can do because the pairs differ only by source: a source-scoped listing filters server-side on that field, and every one of the 43 carries an empty `topics` array, so no topic-scoped listing contains a pair either.
- **Indicator IDs are opaque and hierarchical.** IDs like `NY.GDP.PCAP.CD` encode source, topic, and unit, but the encoding isn't documented for programmatic parsing. The agent should treat them as opaque strings.
- **PIP inequality data exists only for survey years.** PIP publishes a poverty estimate for every year from 1981 to 2026 in an economy's coverage window but surveys only a handful — 2,584 survey rows against 10,119 gap-filled ones across the whole dataset — and it attaches the Gini, decile shares, mean log deviation, and polarization to survey-derived rows alone. For most year requests the inequality fields are legitimately null. `estimationType` distinguishes that from an outright absence of data.
- **PIP serves individual economies only.** Its `/pip` endpoint lists 28 aggregate codes among the 200 valid `country` values — regions, income groups, lending groups, `REST` — and answers HTTP 500 for every one of them; only the 172 individual economies resolve. The aggregates live behind `/pip-grp`, which this server does not expose.
- **PIP and WDI poverty figures will not match exactly.** `SI.POV.DDAY` and friends are WDI series with their own vintage and revision cycle; `worldbank_get_poverty` reads PIP directly. Comparable questions, different numbers.
- **A cold PIP query is slow.** PIP computes a query the first time it sees it and serves repeats from cache, so the same request can take 15–60 seconds once and under a second thereafter; 90 seconds has been observed. The request timeout is 60s with a single retry, which recovers the common case because the timed-out attempt leaves the query warm. A full-history request with `fill_gaps` on pays this twice, once per pass.
- **Update frequency varies widely.** Some indicators are annual, some quarterly, some have multi-year gaps. The API provides no update schedule — agents querying "most recent data" may get values from several years ago.

## API Reference

**Base URL:** `https://api.worldbank.org/v2/`

**Format:** Always append `?format=json`. Without it, the API returns XML.

**Response envelope:** `[{page, pages, per_page, total}, [...items]]` — a two-element JSON array, not an object. The data endpoint envelope includes two additional fields: `sourceid` (source dataset ID) and `lastupdated` (last data update date).

**Error envelope:** Invalid IDs (indicator, country) return HTTP 200 with a message object instead of a 404: `{"message": [{"id": "120", "key": "Invalid value", "value": "The provided parameter value is not valid"}]}`. The service layer must detect this shape and map it to `NotFound`.

**Pagination:** `?page=N&per_page=N`. Default per_page varies by endpoint (typically 50). Max per_page for data endpoint: 1000. Indicator listing has no fixed cap.

**Country codes:**
- ISO2 (2-letter, most common): `US`, `CN`, `DE`
- ISO3 (3-letter): `USA`, `CHN`, `DEU`
- Region codes (iso2Code from the countries endpoint): `EAS` (East Asia & Pacific), `ECS` (Europe & Central Asia), `LCN` (Latin America & Caribbean), `MEA` (Middle East & North Africa), `SAS` (South Asia), `SSF` (Sub-Saharan Africa), `NAC` (North America)
- Income groups: `HIC` (High income), `UMC` (Upper middle income), `LMC` (Lower middle income), `LIC` (Low income)
- Special: `WLD` (World), `1W` (alias for World), `all` (all entries)

**Key indicator IDs (reference):**

| Indicator | ID |
|:----------|:---|
| GDP (current US$) | `NY.GDP.MKTP.CD` |
| GDP per capita (current US$) | `NY.GDP.PCAP.CD` |
| GDP growth (annual %) | `NY.GDP.MKTP.KD.ZG` |
| Population, total | `SP.POP.TOTL` |
| Poverty headcount ratio at $2.15/day (%) | `SI.POV.DDAY` |
| Life expectancy at birth | `SP.DYN.LE00.IN` |
| CO2 emissions (metric tons per capita) | `EN.ATM.CO2E.PC` |
| Merchandise trade (% of GDP) | `TG.VAL.TOTL.GD.ZS` |
| Inflation, consumer prices (annual %) | `FP.CPI.TOTL.ZG` |
| Internet users (% of population) | `IT.NET.USER.ZS` |

### Poverty and Inequality Platform

**Base URL:** `https://api.worldbank.org/pip/v1/` — not `pip.worldbank.org/api/v1`, which is the web front-end and serves an HTML app shell.

**Endpoint used:** `/pip?country=&year=&povline=&welfare_type=&reporting_level=&fill_gaps=`. `country` takes one ISO3 code, a comma-separated batch, or `all`; `year` takes a year, `all`, or `MRV`. Codes are case-insensitive and unknown query parameters are ignored.

**Response envelope:** a flat JSON array of row objects. No pagination and no paging metadata — the whole result set arrives at once (`country=all&year=all` is ~2,600 survey rows, ~10,100 gap-filled).

**Error convention:** real HTTP status codes. A rejected parameter value is HTTP 404 with `{"error": [...], "details": {"<param>": {"msg": [...], "valid": [...]}}}`, one `details` entry per rejected parameter, `country` always first. One bad code fails the whole batch (`country=USA,ZZZ` → 404). A well-formed query matching nothing is HTTP 200 with `[]`. An aggregate country code is HTTP 500 with a body carrying no detail beyond `Internal Server Error`.

**Input leniency:** country codes and `year` are case-insensitive (`usa`, `mrv`), unknown query parameters are ignored, and `povline` accepts 0–2700. An empty or absent `country` is read as every economy, so a caller must never let an empty value reach the query string.

**Row grain:** country × reporting year × reporting level × welfare type. Ten economies publish more than one `reporting_level` (only China all three) and thirty-five publish both an income and a consumption series, so the country code alone does not identify a row. `survey_year` may be fractional when the survey spans a fiscal year (India's 2022 HCES reports `2022.58`).

**`estimation_type`:** `survey`, `interpolation`, `extrapolation`, or `CMD estimation` — the last for economies PIP holds no survey for. `is_interpolated` is `true` on the interpolated and extrapolated rows only, so it does not by itself separate survey rows from gap-filled ones.

**Mode asymmetry:** `fill_gaps=true` is a different series, not a superset. It spans 1981–2026 for every economy, drops the whole distributional block from every row it returns, and reports a slightly different `headcount` for a year both modes cover (`USA&year=2022`: `0.014` survey, `0.0132` gap-filled). `fill_gaps=false` spans only the survey years, which for some economies (`USA`) start well before 1981.

**Not exposed:** `/pip-grp` (regional and income-group aggregates), `/aux` (reference tables), `/versions` (data vintages).

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-05-23 | No auth, no API key in config | World Bank API is fully public. Including an API key env var would imply it's needed; it isn't. |
| 2026-05-23 | `countries` param accepts both string and string[] | Most comparison queries involve 2–6 countries. Array feels natural there; single string for the common single-country case. The service joins with `;` for the API call. |
| 2026-05-23 | `include_aggregates` defaults to false on `worldbank_list_countries` | Raw API mixes ~90 aggregates (regions, sub-regions, income groups, IDA/IBRD classifications) into the country listing. A researcher browsing "countries in South Asia" doesn't want those. Opt-in via flag. |
| 2026-05-23 | No `worldbank_compare_countries` tool | It would be a thin wrapper over `worldbank_get_data`. The comparison logic belongs to the agent. Adding it would grow the surface without adding capability. |
| 2026-05-23 | `mrv` and `date_range` are mutually exclusive inputs | When both are passed, the API silently lets `mrv` win and ignores `date`. Forcing the caller to choose one in the schema prevents silent surprise and reflects actual workflow intent. |
| 2026-05-23 | Topic/source-filter search routes to dedicated endpoints; combined keyword+filter uses client-side filtering *(superseded 2026-08-09)* | The WB `searchterm` param appeared to be ignored only when `topic` or `source` was present. Routing to `/topic/{id}/indicator` or `/indicator?source={id}` and filtering client-side by keyword was taken as the correct path for combined queries. |
| 2026-08-09 | Every keyword search matches client-side over an exhaustively fetched scope | Measured against the live API: `?searchterm=zzzz-no-such-indicator-xyz` returns the full catalog with `total: 29544`, so the parameter never filters — the earlier "only when topic/source is present" reading was too narrow. Keyword-only search now matches over the full catalog, and topic/source scopes are fetched across all upstream pages (topic 4 alone holds 1,014 rows, source 2 holds 1,498) instead of a single 1,000-row page. |
| 2026-08-09 | `isAggregate` resolves against a cached `/country` lookup, not a code list | The hardcoded 33 codes covered fewer than half of the 78 aggregates the World Bank publishes, so `EUU`, `ARB`, `LDC`, `LMY` and 42 others came back as individual countries and double-counted in any average or sum. The data endpoint's rows carry no `region`/`incomeLevel` field, so nothing in the payload can self-classify; the country listing is 295 entities in one request and caches on the same TTL as the indicator catalog. Both identifiers go in the set — a data row names an aggregate by ISO2 in `country.id` (`ZH`) and by its code in `countryiso3code` (`AFE`). |
| 2026-08-09 | Upstream error classification comes from the message count plus an indicator lookup | The envelope text is byte-identical whichever path segment was rejected, and the previous heuristic inspected the caller's own `indicator_id` for a `XX.YYY` shape, which inverted the answer in both directions. Upstream does emit one `message` entry per rejected segment: two entries prove both are invalid, and one entry is resolved by a single `/indicator/{id}` request on an already-failed path. A malformed `date_range` produces the same one-entry envelope, so rejecting it at the schema is what keeps the remaining case a two-way choice. |
| 2026-08-09 | A `date_range` the API drops is applied locally over the whole series | The API discards a window it can't apply — no overlap with the series (`1850:1900`), or a granularity the series doesn't carry (`2019:2021` against quarterly rows) — and returns everything, indistinguishable from a hit. Each returned period is compared against the requested one; periods overlap rather than match exactly, so a year window also selects the quarters and months inside it. Once any row falls outside, upstream's paging describes the unfiltered series, so a windowed query spanning more than one upstream page is re-read exhaustively and paginated locally — the same reason `include_aggregates=false` fetches every page. Judging the drop from one page alone reported the page-local match count as the total and, when the window sat behind page 1, claimed the series held nothing in it. A window that matches nothing reports as an empty result with a notice rather than a thrown error, because a single out-of-range period (`date=1800`) already comes back as an empty upstream envelope — the same request shape must not fail one way and succeed the other. |
| 2026-08-09 | `date_range` accepts quarterly and monthly periods, not just years | Quarterly and monthly series exist (`DP.DOD.DECD.CR.BC.CD` dates rows `2026Q1`, `CPTOTNSXN` carries 471 monthly rows) and `YYYYQn` / `YYYYMnn` are the only expressions the API honors against them — a plain year returns nothing and a year range is discarded. Restricting the pattern to `YYYY` would have made those series unfilterable. Both endpoints of a range must share a period type because the API rejects a mixed range outright, and an outright rejection is the one-message envelope the indicator/country classification depends on being unambiguous. |
| 2026-08-09 | PIP gets its own `PipService` rather than extending `WorldBankApiService` | The two APIs share a hostname and nothing else — flat array vs. `[paging, items]` tuple, no pagination vs. `page`/`per_page`, real HTTP status codes vs. an HTTP-200 sentinel envelope. Every reusable piece (`fetchWithTimeout`, `withRetry`, init/accessor, HTML-error detection) sits below the service layer and is used by both. |
| 2026-08-09 | Poverty and inequality ship as one tool, `worldbank_get_poverty` | Both arrive in the same upstream row and `poverty_line` does not affect the distributional fields, so a separate inequality tool would issue a second identical request for data already in hand. Discoverability is handled in the description, which names Gini, inequality, and decile distribution outright. |
| 2026-08-09 | `fill_gaps` defaults to `true`, and survey rows win the merge | Measured against the live API: `fill_gaps=false` answers `country=IND&year=2019` with `[]`, so the upstream default makes an ordinary query look like a missing-data bug. But `fill_gaps=true` nulls `gini`, `mld`, `polarization`, all ten deciles, and `survey_year` on *every* row it returns — `USA&year=2022` gives `gini: 0.417` without the flag and `gini: null` with it — so simply passing the flag through would kill the inequality half of the tool outright. Requesting survey rows first and merging the gap-filled pass around them gets both: real distributions where they exist, labelled estimates where they do not. |
| 2026-08-09 | The gap-fill merge keys on row grain for a multi-year request and on the country for a single-year one | Keying on the country throughout made `fill_gaps` a silent no-op for the most ordinary query there is. `countries=IND` with no `year` — which PIP reads as the full window — returned the 8 survey years and nothing else, because India was "covered" by having any survey row at all, while `appliedFilters.fillGaps` still reported `true`; the honest answer is 47 rows. `country=all&year=all` lost roughly 5,600 rows the same way. Keying on country × year × reporting level × welfare type fixes it, and is safe because a survey row and its gap-filled twin share that key exactly. A single reporting year keeps the country key: `year=MRV` resolves to the most recent *survey* year in one mode and 2026 in the other, so a grain key there would return one economy twice at two different years. |
| 2026-08-09 | `poverty_line` has no server-side default | PIP's default line follows its PPP vintage and has already moved from $2.15 (2017 PPPs) to $3.00 (2021 PPPs). A hardcoded default would keep expressing the applied threshold in a retired vintage; letting upstream decide and echoing `povertyLine` on every row stays correct across revisions. |
| 2026-08-09 | `mrv` ceiling raised from 10 to 100 | The cap was the server's; upstream accepts any count and clamps to the series length (`mrv=200` on a 66-year series returns 66). Ten values is a decade against series running 60+ years, and "most recent N" is the only way to read the tail of a sparse series without guessing a `date_range`. 100 spans every World Bank series with headroom while bounding the `mrv` × countries fan-out; `page`/`per_page` handle the rest (`mrv=60` at the default 50-row page returns 60 across two pages). |
| 2026-08-09 | Full catalog cached in-process, 1 h TTL, single-flight | The catalog is 14.9 MB / 29,544 rows, ~39 MB retained as a normalized projection, and a measured RSS step of roughly 140 MB on the first cold search. Fetching it per search is untenable; caching it on the service instance with a shared in-flight promise makes a warm keyword-only search a local scan in tens of milliseconds. TTL is configurable via `WORLDBANK_CATALOG_CACHE_TTL_MS`; `0` trades the memory back for a refetch per search. |
| 2026-08-09 | Token-AND keyword matching on alphanumeric terms, ranked by specificity | Word-order sensitivity was producing wrong-looking results ("per capita GDP" → 8 hits, "gdp per capita" → 38). Requiring each term independently makes both return 108. Terms are split on punctuation, not whitespace, so a pasted indicator name survives: `Unemployment, female (%)` split on whitespace yields the term `(%)`, which appears in no indicator name, and the search returns nothing. Punctuation-insensitive terms match more loosely, so exact-ID/name and whole-phrase hits are promoted ahead of the rest — `Population, total` puts `SP.POP.TOTL` first, `GDP (current US$)` puts `NY.GDP.MKTP.CD` first. |
| 2026-08-09 | `no_match` removed from `worldbank_search_indicators`; empty results stay structured | The declared error could never fire — empty searches already returned success with an `enrichment.notice`. A zero-hit search is a valid answer, and `worldbank_get_data` handles its empty case the same way, so the unreachable contract entry was dropped rather than wired up. `invalid_filter` was added in its place for genuinely bad topic/source IDs. |
| 2026-08-09 | `worldbank_list_countries` fetches all upstream pages when excluding aggregates | The fixed `page=1&per_page=300` fetch left five rows of headroom over upstream's 295 entities; crossing 300 would have dropped countries from every page with `totalCount` under-reporting and no notice. Reading `pages` from the first response removes the ceiling and costs one request today. |
| 2026-05-23 | DataCanvas deferred | Typical query sizes don't exceed context budget. DuckDB adds startup overhead and worker-mode incompatibility. Revisit if `all`-country queries with long date ranges prove costly in practice. |
| 2026-05-23 | `nullCount` field on data response | The WDI has significant data gaps — sparse series are the rule, not the exception. Surfacing `nullCount` gives the agent a quantitative sparsity signal without requiring it to count nulls manually. |
| 2026-05-23 | Seven tools total | Covers all discovery and data workflows without overlap. `worldbank_list_topics` and `worldbank_list_sources` are small reference tools that pay for themselves by enabling natural discovery flows and reducing indicator search failures. |
