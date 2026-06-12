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
import { worldbankListCountries } from './mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { worldbankListSources } from './mcp-server/tools/definitions/worldbank-list-sources.tool.js';
import { worldbankListTopics } from './mcp-server/tools/definitions/worldbank-list-topics.tool.js';
import { worldbankSearchIndicators } from './mcp-server/tools/definitions/worldbank-search-indicators.tool.js';
import { initWorldBankApiService } from './services/worldbank/worldbank-service.js';

await createApp({
  name: 'worldbank-mcp-server',
  title: 'worldbank-mcp-server',
  tools: [
    worldbankListTopics,
    worldbankListSources,
    worldbankListCountries,
    worldbankGetCountry,
    worldbankSearchIndicators,
    worldbankGetIndicator,
    worldbankGetData,
  ],
  resources: [worldbankIndicatorResource, worldbankCountryResource],
  prompts: [],
  landing: { requireAuth: false },
  setup(core) {
    initWorldBankApiService(core.config, core.storage);
  },
});
