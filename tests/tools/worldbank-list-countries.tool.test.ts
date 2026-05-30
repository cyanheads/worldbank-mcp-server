/**
 * @fileoverview Tests for worldbank_list_countries tool.
 * @module tests/tools/worldbank-list-countries.tool.test
 */

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
});
