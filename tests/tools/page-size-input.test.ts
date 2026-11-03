/**
 * @fileoverview Positive integer page-size validation across the four paged domain tools.
 * @module tests/tools/page-size-input.test
 */
import { describe, expect, it } from 'vitest';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { worldbankGetPoverty } from '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { worldbankListCountries } from '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';

describe('page size inputs', () => {
  it.each([0, -1, 1.5, '50', NaN, Infinity])(
    'rejects invalid page size %s on every tool',
    (per_page) => {
      expect(
        worldbankGetData.input.safeParse({
          indicator_id: 'SP.POP.TOTL',
          countries: 'USA',
          per_page,
        }).success,
      ).toBe(false);
      expect(worldbankGetPoverty.input.safeParse({ countries: 'USA', per_page }).success).toBe(
        false,
      );
      expect(worldbankListCountries.input.safeParse({ per_page }).success).toBe(false);
      expect(worldbankSearchProjects.input.safeParse({ per_page }).success).toBe(false);
    },
  );
});
