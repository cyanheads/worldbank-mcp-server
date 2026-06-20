<div align="center">
  <h1>@cyanheads/worldbank-mcp-server</h1>
  <p><b>Query 29,500+ World Bank development indicators for 200+ countries across 60+ years via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.14-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/worldbank-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/worldbank-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/worldbank-mcp-server/releases/latest/download/worldbank-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=worldbank-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd29ybGRiYW5rLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22worldbank-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fworldbank-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://worldbank.caseyjhand.com/mcp](https://worldbank.caseyjhand.com/mcp)

</div>

---

## Tools

7 tools for browsing and querying the World Bank Open Data API:

| Tool | Description |
|:---|:---|
| `worldbank_list_topics` | List all 21 World Bank thematic topics with descriptions |
| `worldbank_list_sources` | List 70+ World Bank data sources (datasets) with pagination |
| `worldbank_list_countries` | List countries and regional aggregates with ISO codes, region, income level, and coordinates |
| `worldbank_get_country` | Fetch full metadata for a specific country or aggregate by ISO2, ISO3, or aggregate code |
| `worldbank_search_indicators` | Search the 29,500+ indicator catalog by keyword, topic, or source |
| `worldbank_get_indicator` | Fetch complete metadata for a single indicator: name, description, source, unit, and topics |
| `worldbank_get_data` | Query indicator values for one or more countries across a time range or most-recent N values |

### `worldbank_list_topics`

List all 21 World Bank thematic topic categories.

- No input required — returns the complete fixed taxonomy
- Topics include Agriculture, Economy & Growth, Education, Energy & Mining, Environment, Financial Sector, Health, Infrastructure, Poverty, Private Sector, Public Sector, Science & Technology, Social Development, Social Protection & Labor, Trade, Urban Development, and more
- Returns topic IDs used to filter `worldbank_search_indicators`

---

### `worldbank_list_sources`

List the 70+ World Bank data sources (datasets).

- Paginated with configurable page size (up to 100 per page)
- Each source includes ID, name, short code, last-updated date, and data/metadata availability status
- Source IDs used to filter `worldbank_search_indicators` by dataset origin (e.g. "2" for World Development Indicators, "6" for IDS)

---

### `worldbank_list_countries`

List countries and regional aggregates with metadata.

- Returns ISO codes, World Bank region, income level, capital city, and coordinates
- Filterable by region code (EAS, ECS, LCN, MEA, NAC, SAS, SSF) and income level (LIC, LMC, UMC, HIC)
- By default returns individual countries only; set `include_aggregates=true` to include regional, income-group, and world aggregate entities
- Paginated with up to 300 entries per page

---

### `worldbank_get_country`

Fetch full metadata for a single country or aggregate entity.

- Accepts ISO2 (US), ISO3 (USA), or World Bank aggregate codes (EAS, HIC, WLD)
- Returns region, income level, lending type, capital city, and coordinates
- Structured error with recovery hint when code is not found

---

### `worldbank_search_indicators`

Search the 29,500+ World Bank indicator catalog.

- Keyword search, topic filter, source filter — at least one required
- When `topic_id` or `source_id` is combined with a keyword query, client-side filtering is applied (the upstream API ignores `searchterm` when a topic/source filter is active)
- Returns indicator IDs, names, source dataset, and thematic topics
- Indicator IDs (e.g. `NY.GDP.PCAP.CD`, `SP.POP.TOTL`) feed directly into `worldbank_get_data`
- Paginated with up to 100 results per page

---

### `worldbank_get_indicator`

Fetch complete metadata for a known indicator ID.

- Returns full description, unit of measurement, source dataset, source organization, and thematic topics
- Structured error with recovery hint when ID is not found

---

### `worldbank_get_data`

Query indicator values for countries across time. The primary data-access tool.

- Single country, array of countries, regional codes (EAS, LCN, …), income codes (HIC, LMC, …), world code (WLD), or `"all"` for all ~266 entries
- Time filtering: `date_range` for historical analysis (YYYY or YYYY:YYYY format), or `mrv` for the N most recent available values (1–10). Mutually exclusive.
- Returns observations with `null` values when data is not available for a country×year cell — common for sparse series
- Includes `nullCount` per page to surface data sparsity
- Output grouped by country for readability; `isAggregate` flag distinguishes regional aggregates from individual countries
- Paginated with up to 1000 entries per page

## Resources

| Type | Name | Description |
|:---|:---|:---|
| Resource | `worldbank://indicator/{indicatorId}` | Indicator metadata by ID — name, description, source, unit, and topics |
| Resource | `worldbank://country/{countryCode}` | Country metadata by ISO2, ISO3, or aggregate code — region, income level, capital, coordinates |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

World Bank-specific:

- Full World Bank Open Data API v2 coverage — topics, sources, countries, indicators, and observations
- 60+ years of development data across 29,500+ indicators for 200+ countries and regional aggregates
- Client-side topic/source + keyword compound filtering (works around upstream API limitation)
- Null-value transparency — `null` observations and `nullCount` surfaced rather than silently dropped
- `isAggregate` flag on every country/data row to distinguish individual countries from aggregate entities

Agent-friendly output:

- Tool cross-references woven into descriptions — e.g. `worldbank_search_indicators` names `worldbank_list_topics` for topic IDs, `worldbank_get_data` names `worldbank_search_indicators` for indicator discovery
- Structured error contracts with typed `reason` codes and actionable `recovery` hints on every tool
- Consistent pagination metadata (`page`, `pages`, `total`) across all list/search/data tools

## Getting started

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

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js ≥24.0.0).
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
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`) | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP exporter endpoint | none |
| `WORLDBANK_API_BASE_URL` | World Bank API base URL override | `https://api.worldbank.org/v2` |
| `WORLDBANK_DEFAULT_PER_PAGE` | Default page size for list/search/data operations | `50` |

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools covering topics, sources, countries, indicators, and data. |
| `src/mcp-server/resources` | Resource definitions. Indicator and country metadata resources. |
| `src/services/worldbank` | World Bank API service layer — API client and domain types. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
