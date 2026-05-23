/**
 * @fileoverview Tests for worldbank_get_country tool.
 * @module tests/tools/worldbank-get-country.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

const mockCountry = {
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
};

describe('worldbankGetCountry', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockResolvedValue(mockCountry),
    } as never);
  });

  it('returns country metadata', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankGetCountry.input.parse({ country_code: 'US' });
    const result = await worldbankGetCountry.handler(input, ctx);
    expect(result).toMatchObject({
      id: 'US',
      name: 'United States',
      isAggregate: false,
    });
    expect(result.region.id).toBe('NAC');
    expect(result.incomeLevel.id).toBe('HIC');
  });

  it('throws country_not_found for invalid code', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'country_not_found' },
      }),
    } as never);

    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetCountry.errors });
    const input = worldbankGetCountry.input.parse({ country_code: 'ZZ' });
    await expect(worldbankGetCountry.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'country_not_found' },
    });
  });

  it('formats all output fields', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const blocks = worldbankGetCountry.format!(mockCountry);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('United States');
    expect(text).toContain('US');
    // region.id and region.name
    expect(text).toContain('North America');
    expect(text).toContain('NAC');
    // incomeLevel.id and incomeLevel.name
    expect(text).toContain('High income');
    expect(text).toContain('HIC');
    expect(text).toContain('Not classified');
    expect(text).toContain('Washington D.C.');
    expect(text).toContain('38.8895');
    expect(text).toContain('No'); // isAggregate: false
  });

  it('handles aggregate entries', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const aggregate = {
      ...mockCountry,
      id: 'EAS',
      name: 'East Asia & Pacific',
      region: { id: 'NA', name: 'Aggregates' },
      incomeLevel: { id: 'NA', name: 'Aggregates' },
      capitalCity: '',
      isAggregate: true,
    };
    const blocks = worldbankGetCountry.format!(aggregate);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Yes'); // isAggregate: true
    expect(text).toContain('EAS');
  });
});
