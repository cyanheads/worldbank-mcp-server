/**
 * @fileoverview Normalize the Projects API's bare and FY17 spellings of the
 * sector and theme names its `sector` and `theme` filters take.
 * @module services/projects/normalize-sector-names
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Trim each name, strip a leading `FY17 - `, and deduplicate, without treating
 * the upstream facet as an exhaustive whitelist. A name blank after that, or
 * holding the caret the filter joins names with, is rejected rather than sent.
 */
function normalizeNames(names: readonly string[], filter: 'sector' | 'theme'): string[] {
  const normalized = names.map((name) => {
    const trimmed = name.trim();
    const bare =
      trimmed === 'FY17 -' ? '' : trimmed.startsWith('FY17 - ') ? trimmed.slice(7).trim() : trimmed;
    if (bare.length === 0 || bare.includes('^')) {
      throw validationError(
        `${filter === 'sector' ? 'Sector' : 'Theme'} names must be nonblank and cannot contain the caret separator; send each name as a separate array element.`,
        { reason: `invalid_${filter}_name`, retryable: false },
      );
    }
    return bare;
  });
  return [...new Set(normalized)];
}

/** Sector names as the `sector` filter sends them; throws `invalid_sector_name`. */
export function normalizeSectorNames(names: readonly string[]): string[] {
  return normalizeNames(names, 'sector');
}

/** Theme names as the `theme` filter sends them; throws `invalid_theme_name`. */
export function normalizeThemeNames(names: readonly string[]): string[] {
  return normalizeNames(names, 'theme');
}
