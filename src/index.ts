#!/usr/bin/env node
/**
 * @fileoverview worldbank-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { worldbankCountryResource } from './mcp-server/resources/definitions/worldbank-country.resource.js';
import { worldbankIndicatorResource } from './mcp-server/resources/definitions/worldbank-indicator.resource.js';
import { worldbankGetCountry } from './mcp-server/tools/definitions/worldbank-get-country.tool.js';
import { worldbankGetData } from './mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { worldbankGetIndicator } from './mcp-server/tools/definitions/worldbank-get-indicator.tool.js';
import { worldbankGetPoverty } from './mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { worldbankListCountries } from './mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { worldbankListSources } from './mcp-server/tools/definitions/worldbank-list-sources.tool.js';
import { worldbankListTopics } from './mcp-server/tools/definitions/worldbank-list-topics.tool.js';
import { worldbankSearchIndicators } from './mcp-server/tools/definitions/worldbank-search-indicators.tool.js';
import { worldbankSearchProjects } from './mcp-server/tools/definitions/worldbank-search-projects.tool.js';
import { initPipService } from './services/pip/pip-service.js';
import { initProjectsService } from './services/projects/projects-service.js';
import { initWorldBankApiService } from './services/worldbank/worldbank-service.js';

await createApp({
  name: 'worldbank-mcp-server',
  title: 'worldbank-mcp-server',
  sessionMode: 'stateless',
  instructions:
    'Read-only, keyless access to three World Bank datasets: indicators through worldbank_search_indicators then worldbank_get_data, poverty and survey distributions through worldbank_get_poverty, and Bank lending operations through worldbank_search_projects. Discover topic/source IDs with worldbank_list_topics and worldbank_list_sources; treat indicator IDs as opaque. Standard indicator queries accept ISO2/ISO3 and World Bank aggregates; for a selected source, discover canonical entity IDs with worldbank_list_countries using that source and retain the source for data reads. PIP has its own aggregate coverage; Projects accepts economies and operational regional codes, not WDI aggregates. Follow pagination for complete results, preserve nulls as missing data, and inspect observation periods and source provenance before comparing values.',
  skills: 'skills',
  tools: [
    worldbankListTopics,
    worldbankListSources,
    worldbankListCountries,
    worldbankGetCountry,
    worldbankSearchIndicators,
    worldbankGetIndicator,
    worldbankGetData,
    worldbankGetPoverty,
    worldbankSearchProjects,
  ],
  resources: [worldbankIndicatorResource, worldbankCountryResource],
  prompts: [],
  landing: { requireAuth: false },
  setup(core) {
    getServerConfig();
    initWorldBankApiService(core.config, core.storage);
    initPipService(core.config, core.storage);
    initProjectsService(core.config, core.storage);
  },
});
