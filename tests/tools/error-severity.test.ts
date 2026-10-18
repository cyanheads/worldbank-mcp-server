/**
 * @fileoverview Tool error severity and severity-only wire parity.
 * @module tests/tools/error-severity.test
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { describe, expect, it } from 'vitest';
import { worldbankGetCountry } from '@/mcp-server/tools/definitions/worldbank-get-country.tool.js';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { worldbankGetIndicator } from '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js';
import { worldbankGetPoverty } from '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { worldbankListCountries } from '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { worldbankListSources } from '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js';
import { worldbankListTopics } from '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js';
import { worldbankSearchIndicators } from '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';

const cases: Array<[AnyToolDefinition, string[], string[]]> = [
  [
    worldbankGetData,
    [
      'invalid_params',
      'mixed_all_selector',
      'reversed_date_range',
      'multiple_indicators',
      'indicator_not_found',
      'indicator_not_queryable',
      'unknown_dimension_value',
      'dimension_not_applicable',
      'source_scope_too_large',
      'country_not_found',
      'indicator_and_country_not_found',
    ],
    ['upstream_inconsistent'],
  ],
  [
    worldbankGetPoverty,
    [
      'country_not_found',
      'ambiguous_aggregate',
      'unserved_aggregate',
      'aggregate_filter_conflict',
      'invalid_parameter',
      'ppp_version_unavailable',
    ],
    ['upstream_unavailable'],
  ],
  [worldbankGetCountry, ['country_not_found', 'multiple_countries'], []],
  [worldbankGetIndicator, ['indicator_not_found', 'multiple_indicators'], []],
  [
    worldbankSearchProjects,
    [
      'invalid_country_code',
      'invalid_date',
      'reversed_date_range',
      'invalid_query',
      'page_out_of_range',
    ],
    ['upstream_unavailable'],
  ],
  [worldbankSearchIndicators, ['missing_filter', 'invalid_filter', 'empty_query'], []],
  [worldbankListCountries, ['invalid_filter'], []],
  [worldbankListSources, [], []],
  [worldbankListTopics, [], []],
];

describe('tool error severity', () => {
  it('keeps the invalid_params code, message and recovery on both surfaces', async () => {
    const result = await runToolContract(worldbankGetData, {
      indicator_id: 'SP.POP.TOTL',
      countries: 'USA',
      mrv: 1,
      date_range: '2024',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message:
          'Provide at most one of date_range, mrv, and mrnev; this call sets date_range and mrv.',
        data: {
          reason: 'invalid_params',
          recovery: { hint: expect.stringContaining('Keep one of date_range') },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(
      'Provide at most one of date_range, mrv, and mrnev; this call sets date_range and mrv.',
    );
    expect(text).toContain('reason invalid_params');
    expect(text).toContain('Recovery: Keep one of date_range');
  });

  it.each(
    cases.map(([definition, notice, error]) => ({
      name: definition.name,
      definition,
      notice,
      error,
    })),
  )('$name declares the complete intended severity map', ({ definition, notice, error }) => {
    const entries = definition.errors ?? [];
    expect(entries.map((entry) => entry.reason).sort()).toEqual([...notice, ...error].sort());
    for (const entry of entries)
      expect(entry.severity).toBe(notice.includes(entry.reason) ? 'notice' : undefined);
  });

  it.each(
    cases
      .filter(([definition]) => (definition.errors?.length ?? 0) > 0)
      .map(([definition]) => ({ name: definition.name, definition })),
  )(
    '$name preserves every modeled wire failure when severity alone changes',
    async ({ definition }) => {
      for (const entry of definition.errors ?? []) {
        const fixture = {
          ...definition,
          handler: async () => {
            throw new McpError(entry.code, `Rejected ${entry.reason}`, {
              reason: entry.reason,
              retryable: false,
            });
          },
        };
        // The parsed input is valid for the actual definition; only the throw is supplied here.
        const input =
          definition === worldbankGetCountry
            ? { country_code: 'USA' }
            : definition === worldbankGetData
              ? { indicator_id: 'SP.POP.TOTL', countries: 'USA' }
              : definition === worldbankGetIndicator
                ? { indicator_id: 'SP.POP.TOTL' }
                : definition === worldbankGetPoverty
                  ? { countries: 'USA' }
                  : {};
        const before = await runToolContract(
          {
            ...fixture,
            errors: definition.errors?.map(({ severity: _severity, ...rest }) => rest),
          },
          input,
        );
        const after = await runToolContract(fixture, input);
        expect(after.isError).toBe(true);
        expect(after).toEqual(before);
        expect(after.structuredContent).toMatchObject({
          error: {
            code: entry.code,
            message: `Rejected ${entry.reason}`,
            data: { reason: entry.reason, recovery: { hint: entry.recovery } },
          },
        });
      }
    },
  );
});
