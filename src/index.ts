#!/usr/bin/env node
/**
 * @fileoverview worldbank-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
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
  instructions:
    'Use the worldbank_* tools to query the World Bank Open Data API for development indicators. No API key required. Workflow: worldbank_search_indicators (browse topic/source IDs via worldbank_list_topics and worldbank_list_sources) to find an indicator_id, then worldbank_get_data to fetch values. Indicators use dotted codes like NY.GDP.PCAP.CD; countries use ISO2/ISO3, regional/income aggregate codes (EAS, HIC), WLD, or "all". On worldbank_get_data, date_range and mrv are mutually exclusive, sparse cells return null, and "all" requires pagination. Poverty at a custom line, the Gini coefficient, and decile shares come from a separate dataset — use worldbank_get_poverty, which takes ISO3 codes for individual economies only (no aggregates) and returns null inequality fields on gap-filled years. The Bank\'s lending operations are a third dataset — use worldbank_search_projects, which identifies countries by ISO2 code and combines its filters by AND.',
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
    initWorldBankApiService(core.config, core.storage);
    initPipService(core.config, core.storage);
    initProjectsService(core.config, core.storage);
  },
});
