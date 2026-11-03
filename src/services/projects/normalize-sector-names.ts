/**
 * @fileoverview Normalize the Projects API's bare and FY17 sector-name spellings.
 * @module services/projects/normalize-sector-names
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** Normalize caller names without treating the upstream facet as an exhaustive whitelist. */
export function normalizeSectorNames(names: readonly string[]): string[] {
  const normalized = names.map((name) => {
    const trimmed = name.trim();
    const bare =
      trimmed === 'FY17 -' ? '' : trimmed.startsWith('FY17 - ') ? trimmed.slice(7).trim() : trimmed;
    if (bare.length === 0 || bare.includes('^')) {
      throw validationError(
        'Sector names must be nonblank and cannot contain the caret separator; send each name as a separate array element.',
        { reason: 'invalid_sector_name', retryable: false },
      );
    }
    return bare;
  });
  return [...new Set(normalized)];
}
