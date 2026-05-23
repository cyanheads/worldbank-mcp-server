/**
 * @fileoverview Tests for worldbank-country resource.
 * @module tests/resources/worldbank-country.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

const mockCountry = {
  id: 'USA',
  iso2: 'US',
  name: 'United States',
  region: { id: 'NAC', name: 'North America' },
  incomeLevel: { id: 'HIC', name: 'High income' },
  lendingType: 'Not classified',
  capitalCity: 'Washington D.C.',
  longitude: '-77.032',
  latitude: '38.8895',
  isAggregate: false,
};

const mockAggregate = {
  id: 'EAS',
  iso2: 'Z4',
  name: 'East Asia & Pacific',
  region: { id: 'NA', name: '' },
  incomeLevel: { id: 'NA', name: '' },
  lendingType: '',
  capitalCity: '',
  longitude: '',
  latitude: '',
  isAggregate: true,
};

describe('worldbankCountryResource', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockResolvedValue(mockCountry),
    } as never);
  });

  it('returns country metadata for a valid ISO3 code', async () => {
    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    const ctx = createMockContext();
    const params = worldbankCountryResource.params.parse({ countryCode: 'USA' });
    const result = await worldbankCountryResource.handler(params, ctx);
    expect(result).toMatchObject({
      id: 'USA',
      iso2: 'US',
      name: 'United States',
      isAggregate: false,
    });
    expect(result.region.id).toBe('NAC');
    expect(result.incomeLevel.id).toBe('HIC');
  });

  it('returns aggregate metadata for a WB aggregate code', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockResolvedValue(mockAggregate),
    } as never);

    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    const ctx = createMockContext();
    const params = worldbankCountryResource.params.parse({ countryCode: 'EAS' });
    const result = await worldbankCountryResource.handler(params, ctx);
    expect(result.isAggregate).toBe(true);
    expect(result.id).toBe('EAS');
  });

  it('throws notFound when the service rejects', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue(new Error('not found')),
    } as never);

    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    const ctx = createMockContext();
    const params = worldbankCountryResource.params.parse({ countryCode: 'ZZZZ' });
    await expect(worldbankCountryResource.handler(params, ctx)).rejects.toThrow('ZZZZ" not found');
  });

  it('handles sparse payload with empty optional fields', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockResolvedValue({
        id: 'TCA',
        iso2: 'TC',
        name: 'Turks and Caicos Islands',
        region: { id: 'LCN', name: 'Latin America & Caribbean' },
        incomeLevel: { id: 'HIC', name: 'High income' },
        lendingType: '',
        capitalCity: '',
        longitude: '',
        latitude: '',
        isAggregate: false,
      }),
    } as never);

    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    const ctx = createMockContext();
    const params = worldbankCountryResource.params.parse({ countryCode: 'TCA' });
    const result = await worldbankCountryResource.handler(params, ctx);
    expect(result.capitalCity).toBe('');
    expect(result.longitude).toBe('');
    expect(result.latitude).toBe('');
    expect(result.isAggregate).toBe(false);
  });
});
