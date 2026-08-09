/**
 * @fileoverview Server-specific configuration for worldbank-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .default('https://api.worldbank.org/v2')
    .describe('World Bank API base URL.'),
  defaultPerPage: z.coerce
    .number()
    .default(50)
    .describe('Default page size for list/search operations.'),
  catalogCacheTtlMs: z.coerce
    .number()
    .int()
    .min(0)
    .default(3_600_000)
    .describe(
      'Lifetime in ms of the in-process indicator-catalog cache used by keyword-only search. 0 disables caching.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'WORLDBANK_API_BASE_URL',
    defaultPerPage: 'WORLDBANK_DEFAULT_PER_PAGE',
    catalogCacheTtlMs: 'WORLDBANK_CATALOG_CACHE_TTL_MS',
  });
  return _config;
}
