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

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `WorldBankApiService` | World Bank Indicators API v2 (`https://api.worldbank.org/v2/`) | All tools and resources |

One service wrapping the entire API. All endpoints share the same base URL and response envelope pattern, so a single service with typed fetch methods covers the full surface.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `WORLDBANK_API_BASE_URL` | No | Override base URL (default: `https://api.worldbank.org/v2`). Useful for testing against local mirrors. |
| `WORLDBANK_DEFAULT_PER_PAGE` | No | Default page size for list/search operations (default: `50`). |

No API key. The World Bank API is fully public.

## Implementation Order

1. Config (`src/config/server-config.ts`) — base URL, default page size
2. `WorldBankApiService` — typed fetch methods for each endpoint category, retry/timeout wiring
3. `worldbank_list_topics` + `worldbank_list_sources` — static reference data, simple to verify
4. `worldbank_list_countries` + `worldbank_get_country` — country metadata
5. `worldbank_search_indicators` + `worldbank_get_indicator` — indicator discovery
6. `worldbank_get_data` — primary data tool; most complex due to multi-country and aggregate handling
7. Resources — `worldbank://indicator/{id}` and `worldbank://country/{code}`

Each step is independently testable against the live API.

---

## Domain Mapping

The API has four endpoint families. All return the same envelope: `[{ page, pages, per_page, total }, [...items]]`.

| Noun | Endpoint | Operations |
|:-----|:---------|:-----------|
| Indicator | `GET /v2/indicator` | list (paginated), search (`?searchterm=`), filter by topic (`?topic=`), filter by source (`?source=`) |
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
| `date` | `YYYY` or `YYYY:YYYY` | Filter to a year or range |
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
- `query: string` — keyword search passed to `?searchterm=`. Required unless `topic_id` or `source_id` is provided.
- `topic_id: string | undefined` — numeric topic ID (1–21) to filter by thematic area. Use `worldbank_list_topics` to browse.
- `source_id: string | undefined` — numeric source ID to filter by dataset origin (e.g., `"2"` for World Development Indicators). Use `worldbank_list_sources` to browse.
- `page: number` (default: 1) — pagination page
- `per_page: number` (default: 50, max: 100) — results per page

**Note:** The API's `searchterm` is silently ignored when `topic_id` or `source_id` is present — the topic or source filter takes over and returns all indicators for that topic/source regardless of the keyword. When `topic_id` is given without `query`, use `GET /v2/topic/{id}/indicator`. When `source_id` is given without `query`, use `GET /v2/indicator?source={id}`. When either filter is given *with* `query`, the service must fetch by the topic/source endpoint and filter client-side by the keyword term. This is a WB API quirk that the service layer must handle for both `topic_id` and `source_id`.

**Output:**
- `indicators: Array<{ id, name, sourceId, sourceName, topics[], sourceNote }>` — matching indicators
- `total: number` — total matches before pagination
- `page: number`, `pages: number` — pagination state

**Errors:**
- `no_match` (`NotFound`) — no indicators matched the query. Recovery: broaden the query or browse by topic.

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
  - `"all"` for all countries + aggregates (266 entries; use pagination)
  - `.describe()` on this parameter should include examples of each form and note that `"all"` returns 266 entries requiring pagination.
- `date_range: string | undefined` — year or range in `YYYY` or `YYYY:YYYY` format. Mutually exclusive with `mrv`.
- `mrv: number | undefined` — most recent N values (1–10). Mutually exclusive with `date_range`.
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
- `country_not_found` (`NotFound`) — one or more country codes are invalid. The API returns the same `{"message": [{"id": "120", ...}]}` envelope (HTTP 200) as invalid indicator IDs — the service must detect this pattern. Recovery: use `worldbank_list_countries` to find valid codes.
- `no_data` (`NotFound`) — the indicator exists but returned zero observations for the requested filter (common for sparse series). Recovery: broaden the date range or try `mrv=5` to get whatever recent data exists.

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

---

## Design Decisions

| Decision | Rationale |
|:---------|:----------|
| Single `worldbank_get_data` for all data queries | The API returns data in the same shape regardless of whether you query one country, many, a region, or `all`. Splitting by use case would be a 1:1 API-mirror mistake — the tool is already self-sufficient with flexible `countries` input. |
| `countries` accepts both single string and array | Agents most often query 2–6 countries for comparison; array input reads naturally for that case. The service layer joins the array with `;` before calling the API. |
| `include_aggregates` defaults to `false` in `worldbank_list_countries` | Aggregate entries (regions, income groups) look like real countries in the raw API response and confuse country-browsing workflows. A researcher asking "list Sub-Saharan countries" doesn't want `AFR`, `AFE`, `SSA` in the results. Aggregates are fully accessible by setting the flag or querying with aggregate codes directly. |
| `isAggregate` field on data rows | The WDI mixes individual country data with regional aggregates in `all` queries. The agent needs to split or label them correctly for analysis. Region entries have `incomeLevel.id = "NA"` in the raw API, so this is a cheap derived boolean. |
| `mrv` vs `date_range` as mutually exclusive | The API supports both `mrv` and `date` independently. They serve different workflows (explore recent trends vs. historical analysis) and combining them yields confusing results. Making them mutually exclusive in the schema forces clarity. |
| Topic/source indicator search routes to dedicated endpoints; combined keyword+filter queries use client-side filtering | The `searchterm` param is silently ignored when `topic` or `source` is also present — the API returns all indicators for the topic/source regardless of the keyword. The only correct path: topic-only → `/topic/{id}/indicator`; source-only → `/indicator?source={id}`; topic/source + keyword → fetch from the dedicated endpoint and filter client-side by the keyword term. |
| No `worldbank_compare_countries` workflow tool | A first-class comparison tool is tempting but adds no real value over `worldbank_get_data` with multiple countries — the agent can do the comparison logic. Keeping the surface tight avoids duplicating the data query with a thin wrapper. |
| DataCanvas not used | Data result sets are moderate-sized (200 countries × N years). The 1000-row `per_page` ceiling and typical query sizes (10–50 rows for focused country comparisons) don't warrant the DuckDB overhead. An agent doing deep tabular analysis can call multiple times. This can be revisited if large `all`-country time-series queries prove problematic in practice. |
| Resources for country and indicator | Stable, addressable by ID, read-only, useful as injectable context for agents that support resources. Both entities satisfy the resource criteria without redundancy — their tool path (`worldbank_get_country`, `worldbank_get_indicator`) also covers tool-only clients. |

## Known Limitations

- **Search is keyword-only.** The WB `searchterm` API is a simple keyword match — no semantic search, no fuzzy matching. An agent searching for "income inequality" won't find the Gini coefficient unless it also tries "Gini". Compound searches and synonyms require multiple calls.
- **Data sparsity is inherent.** Many indicators lack data for specific countries or years — the API returns `null` for those cells without warning. `nullCount` in the response quantifies this; the agent must interpret null values in context.
- **`searchterm` is ignored when topic or source filter is present.** Passing both a keyword and a topic/source filter causes the API to silently ignore the keyword and return all indicators for the topic/source. The service layer handles this with client-side filtering for combined queries.
- **`searchterm` returns all 29,500+ records when no match found.** The API falls back to returning everything when a search term hits zero exact matches. The tool caps `per_page` at 100 to prevent overwhelming responses.
- **Indicator IDs are opaque and hierarchical.** IDs like `NY.GDP.PCAP.CD` encode source, topic, and unit, but the encoding isn't documented for programmatic parsing. The agent should treat them as opaque strings.
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

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-05-23 | No auth, no API key in config | World Bank API is fully public. Including an API key env var would imply it's needed; it isn't. |
| 2026-05-23 | `countries` param accepts both string and string[] | Most comparison queries involve 2–6 countries. Array feels natural there; single string for the common single-country case. The service joins with `;` for the API call. |
| 2026-05-23 | `include_aggregates` defaults to false on `worldbank_list_countries` | Raw API mixes ~90 aggregates (regions, sub-regions, income groups, IDA/IBRD classifications) into the country listing. A researcher browsing "countries in South Asia" doesn't want those. Opt-in via flag. |
| 2026-05-23 | No `worldbank_compare_countries` tool | It would be a thin wrapper over `worldbank_get_data`. The comparison logic belongs to the agent. Adding it would grow the surface without adding capability. |
| 2026-05-23 | `mrv` and `date_range` are mutually exclusive inputs | When both are passed, the API silently lets `mrv` win and ignores `date`. Forcing the caller to choose one in the schema prevents silent surprise and reflects actual workflow intent. |
| 2026-05-23 | Topic/source-filter search routes to dedicated endpoints; combined keyword+filter uses client-side filtering | The WB `searchterm` param is silently ignored when `topic` or `source` is also present — both filters exhibit the same behavior. Routing to `/topic/{id}/indicator` or `/indicator?source={id}` and optionally filtering client-side by keyword is the only correct path. |
| 2026-05-23 | DataCanvas deferred | Typical query sizes don't exceed context budget. DuckDB adds startup overhead and worker-mode incompatibility. Revisit if `all`-country queries with long date ranges prove costly in practice. |
| 2026-05-23 | `nullCount` field on data response | The WDI has significant data gaps — sparse series are the rule, not the exception. Surfacing `nullCount` gives the agent a quantitative sparsity signal without requiring it to count nulls manually. |
| 2026-05-23 | Seven tools total | Covers all discovery and data workflows without overlap. `worldbank_list_topics` and `worldbank_list_sources` are small reference tools that pay for themselves by enabling natural discovery flows and reducing indicator search failures. |
