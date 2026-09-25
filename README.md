<div align="center">
  <h1>@cyanheads/worldbank-mcp-server</h1>
  <p><b>Query 29,500+ World Bank development indicators for 200+ countries across 60+ years via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/worldbank-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/worldbank-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/worldbank-mcp-server/releases/latest/download/worldbank-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=worldbank-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd29ybGRiYW5rLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22worldbank-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fworldbank-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://worldbank.caseyjhand.com/mcp](https://worldbank.caseyjhand.com/mcp)

</div>

---

## Overview

World Bank Open Data across three separate upstream APIs — development indicators, poverty and inequality estimates, and the Bank's lending portfolio. Search the 29,500+ indicator catalog, query country-level time series, pull poverty and inequality metrics from the Poverty and Inequality Platform, and search active and historical lending projects from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `worldbank_list_topics` | List all 21 World Bank thematic topics with descriptions |
| `worldbank_list_sources` | List 70+ World Bank data sources (datasets) with pagination |
| `worldbank_list_countries` | List countries and regional aggregates with ISO codes, region, income level, lending type, and coordinates, filterable by region, income level, and lending type |
| `worldbank_get_country` | Fetch full metadata for a specific country or aggregate by ISO2, ISO3, or aggregate code |
| `worldbank_search_indicators` | Search the 29,500+ indicator catalog by keyword, topic, or source |
| `worldbank_get_indicator` | Fetch complete metadata for a single indicator: name, description, source, unit, and topics |
| `worldbank_get_data` | Query indicator values for one or more countries across a time range, the most recent N periods, or each country's latest N non-empty values, annually, quarterly, or monthly |
| `worldbank_get_poverty` | Poverty headcount, gap, and severity at any poverty line for economies and PIP's regional, income-group, and lending-group aggregates, plus the Gini coefficient and decile shares, from the Poverty and Inequality Platform |
| `worldbank_search_projects` | Search the World Bank lending portfolio by text, country, region, status, financing window, and board approval date |

### Resources

| Resource | Description |
|:---|:---|
| `worldbank://indicator/{indicatorId}` | Indicator metadata by ID — name, description, source, unit, and topics |
| `worldbank://country/{countryCode}` | Country metadata by ISO2, ISO3, or aggregate code — region, income level, capital, coordinates |

## Capability reference

### `worldbank_list_topics` <sub>tool</sub>

- No input required — returns the complete fixed taxonomy of 21 thematic topics
- Topic IDs (e.g. `1` Agriculture, `3` Economy & Growth) feed `topic_id` on `worldbank_search_indicators`

---

### `worldbank_list_sources` <sub>tool</sub>

- Paginated list of the 70+ World Bank data sources (datasets); up to 100 per page
- Each entry carries ID, name, short code, last-updated date, and data/metadata availability
- Source IDs (e.g. `2` for World Development Indicators) feed `source_id` on `worldbank_search_indicators`

---

### `worldbank_list_countries` <sub>tool</sub>

- Filters by region code (`EAS`, `SSF`, … plus membership groupings such as `AFE`, `EUU`, `LDC`), income level (`LIC`, `LMC`, `UMC`, `HIC`), and lending type (`IDX`, `IBD`, `IDB`, `LNX`), combined by AND; up to 150 per page (~50 KB)
- Returns ISO codes, region, income level, lending type, capital, and coordinates; an invalid region or income code is a typed `invalid_filter` error
- Individual countries only by default — `include_aggregates=true` adds regional, income-group, and world aggregates, flagged `isAggregate`

---

### `worldbank_get_country` <sub>tool</sub>

- Accepts one ISO2 (`US`), ISO3 (`USA`), or World Bank aggregate code (`EAS`, `HIC`, `WLD`) — `all` or a list is rejected as `multiple_countries`
- Returns region, income level, lending type, capital, and coordinates
- Typed `country_not_found` error with a recovery hint pointing to `worldbank_list_countries`

---

### `worldbank_search_indicators` <sub>tool</sub>

- At least one of `query`, `topic_id`, or `source_id`; every keyword term must match the indicator ID, name, or description, in any order; up to 100 per page
- Ranked exact ID/name matches first, then names starting with the phrase, then looser matches, then description-only ones; World Development Indicators series lead each tier, and a series leads its own breakdowns (`SP.DYN.LE00.IN` ahead of `SP.DYN.LE00.FE.IN`)
- Each indicator ID appears once, with the first 150 characters of its description; `worldbank_get_indicator` returns the whole

---

### `worldbank_get_indicator` <sub>tool</sub>

- One indicator ID per call, made of letters, digits, `.`, `_`, or `-` — `all`, a list, or any other character is rejected
- Returns description, unit, source dataset, source organization, and topics; HTML line breaks in the description are preserved, other markup is stripped
- Typed `indicator_not_found` error pointing to `worldbank_search_indicators`

---

### `worldbank_get_data` <sub>tool</sub>

- `countries` as ISO2, ISO3, aggregate codes, `WLD`, or `all` alone; at most one of `date_range` (a year, quarter, or month, or a range of one type), `mrv` (the latest N periods across the countries), or `mrnev` (each country's own latest N values — Eritrea's GDP per capita at 2011, where `mrv` gives 2025 and null); `frequency` (`annual`, `quarterly`, `monthly`) picks the period form on series that publish several (`CPTOTSAXN` for Kenya, `monthly`, `mrv: 3` → 2026M07–M05); up to 200 observations a page (~50 KB)
- Rows carry both country codes, `isAggregate`, and `value: null` for a missing cell, with `nullCount` per page and `lastUpdated`, the source's data vintage; every `date_range`, `mrv`, and `mrnev` read is checked for another query's cached answer and re-read once, and one that fails twice is an `upstream_inconsistent` error rather than a served result
- Indicators the standard endpoint doesn't serve (WDI Database Archives, PEFA, ICP, GDLD, International Debt Statistics: DSSI, Food Prices for Nutrition) come from their own dataset, disclosed in `sourceScoped` with the release, classification, sector, or counterpart area applied (`dimension_value`)

---

### `worldbank_get_poverty` <sub>tool</sub>

- Economies by ISO3 or ISO2 code, including those PIP publishes only as model estimates (`AFG`), plus PIP's aggregates: `WLD`, regions (`SSF`, `AFE`), income groups (`LMIC`/`LMC`), and lending groups (`IDX`, `IDB`, `IBD`, `REST`); `year` as a year, `all`, or `MRV`; any `poverty_line`, defaulting to the applied PPP vintage's international line; up to 70 estimates a page (~50 KB)
- Headcount, gap, severity, and Watts index, plus the Gini coefficient, mean log deviation, polarization, and decile shares on survey rows; `estimationType` separates survey rows from gap-filled ones, whose inequality fields are null, and `isAggregate` flags aggregate rows
- `fill_gaps` (default `true`) includes gap-filled years; `welfare_type` and `reporting_level` narrow economy results, and `ppp_version` picks the PPP vintage

---

### `worldbank_search_projects` <sub>tool</sub>

- Free-text `query` combined by AND with `countries` (ISO3, ISO2, or a World Bank regional code such as `3A`), `region`, `status`, `financial_type`, and a board-approval window (`approved_from`/`approved_to`); up to 80 projects a page, newest approval first
- Returns ID, name, country, region, status, dates, the commitment amount with its IBRD, IDA, and grant parts, financing windows, sectors, and a URL; `countryCodes` chain into the other tools, a bad code or unparseable query is a typed `invalid_country_code` / `invalid_query` error, and an empty result names the filter that emptied it
- `include_abstract` (off by default) adds abstracts at 8 projects a page, each cut at 5,000 characters

---

### `worldbank://indicator/{indicatorId}` <sub>resource</sub>

- Indicator metadata as `application/json` — name, description, unit, source dataset, source organization, and topics
- `indicatorId` comes from `worldbank_search_indicators`; an unknown ID returns a typed not-found error with a recovery hint, while an upstream outage or timeout keeps its own classification instead of reading as a bad ID

---

### `worldbank://country/{countryCode}` <sub>resource</sub>

- Country/aggregate metadata as `application/json` — ISO codes, region, income level, capital, coordinates
- Accepts one ISO2, ISO3, or World Bank aggregate code — `all` or a list is rejected; an unknown code returns a typed not-found error, distinct from a transient upstream failure

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

World Bank-specific:

- Full World Bank Open Data coverage across three separate upstream APIs — the Indicators API, the Poverty and Inequality Platform, and the Projects lending portfolio
- 60+ years of development data (PIP coverage from 1963) across 29,500+ indicators for 200+ countries and regional aggregates
- Client-side keyword search over the indicator catalog, since the upstream `searchterm` parameter doesn't filter
- Null-value transparency — `null` observations and `nullCount` surfaced rather than silently dropped
- `isAggregate` flag on every country/data row to distinguish individual countries from aggregate entities

Agent-friendly output:

- Tool cross-references woven into descriptions — e.g. `worldbank_search_indicators` names `worldbank_list_topics` for topic IDs, `worldbank_get_data` names `worldbank_search_indicators` for indicator discovery
- Structured error contracts with typed `reason` codes and actionable `recovery` hints on every tool
- Consistent pagination metadata (`totalCount`, `currentPage`, `totalPages`) across all list/search/data tools, with a notice naming the pages that exist when a request runs past the end

## Getting started

### Public Hosted Instance

A public instance is available at `https://worldbank.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "worldbank-mcp-server": {
      "type": "streamable-http",
      "url": "https://worldbank.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "worldbank-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/worldbank-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "worldbank-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/worldbank-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "worldbank-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/worldbank-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js ≥24.0.0).
- No API key required — the World Bank Open Data API is public and unauthenticated.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/worldbank-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd worldbank-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env and set optional overrides
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_HOST` | HTTP server hostname | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateful`, `stateless`, or `auto`. The server declares `stateless` in code — it holds no per-session state — and a value set here overrides that declaration | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`) | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |
| `WORLDBANK_API_BASE_URL` | World Bank Indicators API base URL override | `https://api.worldbank.org/v2` |
| `WORLDBANK_PIP_BASE_URL` | Poverty and Inequality Platform API base URL override | `https://api.worldbank.org/pip/v1` |
| `WORLDBANK_PROJECTS_BASE_URL` | Projects API base URL override | `https://search.worldbank.org/api/v3` |
| `WORLDBANK_DEFAULT_PER_PAGE` | Default page size for list/search/data operations; `worldbank_get_data`, `worldbank_list_countries`, `worldbank_search_projects`, and `worldbank_get_poverty` still cap it at their own page limits | `50` |
| `WORLDBANK_CATALOG_CACHE_TTL_MS` | Lifetime of the in-process reference caches — the indicator catalog behind keyword-only search, the country index behind `isAggregate`, source-scoped country codes, and poverty ISO2 codes, each source-scoped dataset's concept/country/period/dimension listings, and PIP's versions listing behind `ppp_version`, regions table behind aggregate codes, and economy list behind model-estimate-only economies; `0` disables them all | `3600000` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck  # Lint, format, typecheck, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t worldbank-mcp-server .
docker run --rm -p 3010:3010 worldbank-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/worldbank-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Nine tools covering topics, sources, countries, indicators, data, poverty, and projects. |
| `src/mcp-server/resources` | Resource definitions. Indicator and country metadata resources. |
| `src/services/worldbank` | World Bank Indicators API service layer — API client and domain types. |
| `src/services/pip` | Poverty and Inequality Platform API service layer — separate client and domain types. |
| `src/services/projects` | Projects API service layer — separate client and domain types. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
