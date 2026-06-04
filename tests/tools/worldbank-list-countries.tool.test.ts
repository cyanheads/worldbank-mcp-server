/**
 * @fileoverview Tests for worldbank_list_countries tool.
 * @module tests/tools/worldbank-list-countries.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultPerPage: 50 }),
}));

const mockCountriesResult = {
  countries: [
    {
      id: 'US',
      iso2: 'US',
      name: 'United States',
      region: { id: 'NAC', name: 'North America' },
      incomeLevel: { id: 'HIC', name: 'High income' },
      lendingType: 'Not classified',
      capitalCity: 'Washington D.C.',
      longitude: '-77.032',
      latitude: '38.8895',
      isAggregate: false,
    },
    {
      id: 'EAS',
      iso2: 'Z4',
      name: 'East Asia & Pacific',
      region: { id: 'NA', name: 'Aggregates' },
      incomeLevel: { id: 'NA', name: 'Aggregates' },
      lendingType: '',
      capitalCity: '',
      longitude: '',
      latitude: '',
      isAggregate: true,
    },
  ],
  total: 2,
  page: 1,
  pages: 1,
};

describe('worldbankListCountries', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listCountries: vi.fn().mockResolvedValue(mockCountriesResult),
    } as never);
  });

  it('returns countries list', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListCountries.input.parse({});
    const result = await worldbankListCountries.handler(input, ctx);
    expect(result.countries).toHaveLength(2);
    expect(result.countries[0].id).toBe('US');
  });

  it('populates enrichment with totalCount and pagination', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListCountries.input.parse({});
    await worldbankListCountries.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
    expect(enrichment.currentPage).toBe(1);
    expect(enrichment.totalPages).toBe(1);
  });

  it('skips empty string region/income filters from form clients', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const listCountriesMock = vi.fn().mockResolvedValue(mockCountriesResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listCountries: listCountriesMock,
    } as never);

    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListCountries.input.parse({ region: '', income_level: '' });
    await worldbankListCountries.handler(input, ctx);
    // Verify no region/incomeLevel keys passed (empty string = absent)
    const callArgs = listCountriesMock.mock.calls[0][0];
    expect(callArgs.region).toBeUndefined();
    expect(callArgs.incomeLevel).toBeUndefined();
  });

  it('formats all fields including region.id, incomeLevel.id, lendingType', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const blocks = worldbankListCountries.format!({ countries: mockCountriesResult.countries });
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('United States');
    expect(text).toContain('NAC');
    expect(text).toContain('North America');
    expect(text).toContain('HIC');
    expect(text).toContain('High income');
    expect(text).toContain('Not classified');
    expect(text).toContain('Washington D.C.');
    // Aggregate tag
    expect(text).toContain('[Aggregate]');
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('throws invalid_filter with recovery.hint for bad region/income_level code', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listCountries: vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.NotFound,
            'Invalid region or income_level code. Use worldbank_list_countries without filters to browse valid codes.',
            { reason: 'invalid_filter', region: 'BADCODE' },
          ),
        ),
    } as never);

    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankListCountries.errors });
    const input = worldbankListCountries.input.parse({ region: 'BADCODE' });
    const err = await worldbankListCountries.handler(input, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      data: {
        reason: 'invalid_filter',
        recovery: { hint: expect.stringContaining('worldbank_list_countries') },
      },
    });
  });

  // ─── Zod input validation ─────────────────────────────────────────────────

  it('rejects page below minimum (0)', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    expect(() => worldbankListCountries.input.parse({ page: 0 })).toThrow();
  });

  it('rejects per_page above maximum (301)', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    expect(() => worldbankListCountries.input.parse({ per_page: 301 })).toThrow();
  });

  it('accepts include_aggregates=true', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    expect(() => worldbankListCountries.input.parse({ include_aggregates: true })).not.toThrow();
  });

  // ─── Handler: include_aggregates flag ────────────────────────────────────

  it('passes include_aggregates=true to service', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const listCountriesMock = vi.fn().mockResolvedValue(mockCountriesResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listCountries: listCountriesMock,
    } as never);

    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListCountries.input.parse({ include_aggregates: true });
    await worldbankListCountries.handler(input, ctx);
    const callArgs = listCountriesMock.mock.calls[0][0];
    expect(callArgs.includeAggregates).toBe(true);
  });

  // ─── Format edge cases ────────────────────────────────────────────────────

  it('format renders fallback message when countries list is empty', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const blocks = worldbankListCountries.format!({ countries: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No countries matched');
  });

  it('format omits capital line when capitalCity is empty', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const noCapital = mockCountriesResult.countries.filter((c) => !c.capitalCity);
    const blocks = worldbankListCountries.format!({ countries: noCapital });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Capital:');
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('format output never leaks env variable names or API keys', async () => {
    const { worldbankListCountries } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js'
    );
    const blocks = worldbankListCountries.format!({ countries: mockCountriesResult.countries });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toMatch(/WORLDBANK_API/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/Authorization/i);
  });
});
