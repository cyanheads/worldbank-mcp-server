# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-08-25

Packaging-only patch — the Dockerfile build stage now runs on the native builder platform, so the linux/amd64 image no longer compiles TypeScript under QEMU emulation. No runtime or API change.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-08-24

Adopts mcp-ts-core 0.12.3 and the MCP SDK v2 wire it brings — HTTP endpoints serve protocol revision 2026-07-28 alongside the 2025 era, tool arguments are strict, and the advertised outputSchema declares the error envelope.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-08-09

Add worldbank_search_projects — search the World Bank lending portfolio by text, country, region, status, and board approval date (#8)

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-08-09

Add worldbank_get_poverty — poverty and inequality estimates from the Poverty and Inequality Platform (#8)

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-08-09

Add appliedFilters echo to worldbank_search_indicators/worldbank_get_data; fix resource not-found misclassification and duplicate indicator IDs (#12, #19, #23)

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-08-09

Fix worldbank_get_data error classification, date_range/countries validation, aggregate detection, and mrv ceiling (#13, #17, #18, #20, #22)

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-08-09

Fix indicator search truncation and invalid-filter handling, exhaustive country listing (#14, #15, #16, #21); sync mcp-ts-core to ^0.11.1

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-06-20

Sync @cyanheads/mcp-ts-core ^0.10.9 maintenance scripts, skills, and devcheck guards

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-06-15

Server-level instructions on createApp(); unscope agent-facing plugin identity fields to worldbank-mcp-server

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6; explicit createApp name/title identity; Dockerfile healthcheck + version label; .mcpbignore anchoring and bundle-content lint guards

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-04

Typed error contracts: ctx.fail() re-throws for country_not_found, indicator_not_found, invalid_filter; empty getData returns structured result instead of throwing

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.16 → ^0.9.21 — per-request log context fix, secret scrubbing from error messages, withRetry fail-fast

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-30

enrichment adoption — search/list/data tools surface query echoes, result totals, pagination, and empty-result guidance in a typed enrichment block

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-28

mcp-ts-core ^0.9.9 → ^0.9.13: 413 body cap, HTTP session-init gate, quieter expected-error logging, GET /mcp keywords

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Bug fixes: notFound() cause arg position in 2 resources; error code corrections; code simplification; mcp-ts-core ^0.9.7 → ^0.9.9; skills synced

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-24

Fix TypeError on invalid indicator/country, isAggregate lookup for aggregate codes, and inaccurate total/pages when filtering aggregates

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Add hosted server endpoint: remotes block in server.json, public URL in README

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Metadata alignment: package.json scripts/fields, Dockerfile LABEL, manifest.json fields, server.json runtimeHint

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Sync tagline to canonical form across package.json, server.json, manifest.json, Dockerfile, and GitHub description

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-24

Bug fixes: array-wrapped error envelopes in list_countries, string pagination coercion in list_sources, internal implementation detail removed from search_indicators description; metadata polish

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

npm publish and GitHub Release for the initial public launch of worldbank-mcp-server — 7 tools, 2 resources, 29,500+ indicators, 200+ countries

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — World Bank Open Data API: 7 tools, 2 resources covering 29,500+ indicators for 200+ countries
