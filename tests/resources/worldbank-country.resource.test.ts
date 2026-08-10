/**
 * @fileoverview Tests for worldbank-country resource.
 * @module tests/resources/worldbank-country.resource.test
 */

import {
  JsonRpcErrorCode,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
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

/** The rejection WorldBankApiService.getCountry throws for a code upstream rejects. */
function unknownCountry(countryCode: string) {
  return notFound(
    `Country code "${countryCode}" not found. Use worldbank_list_countries to browse valid codes.`,
    { reason: 'country_not_found', countryCode },
  );
}

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
    const ctx = createMockContext({ errors: worldbankCountryResource.errors });
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
    const ctx = createMockContext({ errors: worldbankCountryResource.errors });
    const params = worldbankCountryResource.params.parse({ countryCode: 'EAS' });
    const result = await worldbankCountryResource.handler(params, ctx);
    expect(result.isAggregate).toBe(true);
    expect(result.id).toBe('EAS');
  });

  it('throws notFound with a recovery hint when the country code is unknown', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue(unknownCountry('ZZZZ')),
    } as never);

    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankCountryResource.errors });
    const params = worldbankCountryResource.params.parse({ countryCode: 'ZZZZ' });
    const err = await worldbankCountryResource.handler(params, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'country_not_found', countryCode: 'ZZZZ' },
    });
    expect((err as { data: { recovery: { hint: string } } }).data.recovery.hint).toMatch(
      /worldbank_list_countries/,
    );
  });

  /**
   * A transient upstream failure must not be relabelled as a definitive miss —
   * an agent told the country does not exist changes its input instead of
   * retrying.
   */
  it.each([
    ['serviceUnavailable', serviceUnavailable('Network error during fetch'), -32000],
    ['timeout', timeout('Request timed out after 15000ms'), -32004],
  ])('propagates a %s rejection unchanged', async (_label, upstreamError, expectedCode) => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue(upstreamError),
    } as never);

    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankCountryResource.errors });
    const params = worldbankCountryResource.params.parse({ countryCode: 'BRA' });
    const err = await worldbankCountryResource.handler(params, ctx).catch((e: unknown) => e);
    expect(err).toBe(upstreamError);
    expect((err as { code: number }).code).toBe(expectedCode);
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
    const ctx = createMockContext({ errors: worldbankCountryResource.errors });
    const params = worldbankCountryResource.params.parse({ countryCode: 'TCA' });
    const result = await worldbankCountryResource.handler(params, ctx);
    expect(result.capitalCity).toBe('');
    expect(result.longitude).toBe('');
    expect(result.latitude).toBe('');
    expect(result.isAggregate).toBe(false);
  });

  // ─── Zod params validation ─────────────────────────────────────────────────

  it('rejects missing countryCode', async () => {
    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    expect(() => worldbankCountryResource.params.parse({})).toThrow();
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('notFound error message does not leak env variable names or API keys', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue(unknownCountry('ZZ')),
    } as never);

    const { worldbankCountryResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-country.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankCountryResource.errors });
    const params = worldbankCountryResource.params.parse({ countryCode: 'ZZ' });
    const err = await worldbankCountryResource.handler(params, ctx).catch((e: unknown) => e);
    const errStr = JSON.stringify(err);
    expect(errStr).not.toMatch(/WORLDBANK_API/);
    expect(errStr).not.toMatch(/Authorization/i);
  });
});
