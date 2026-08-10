/**
 * @fileoverview Tests for worldbank-indicator resource.
 * @module tests/resources/worldbank-indicator.resource.test
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

const mockIndicator = {
  id: 'NY.GDP.PCAP.CD',
  name: 'GDP per capita (current US$)',
  unit: 'US$',
  sourceId: '2',
  sourceName: 'World Development Indicators',
  sourceNote: 'GDP per capita is gross domestic product divided by midyear population.',
  sourceOrganization: 'World Bank national accounts data',
  topics: [
    { id: '3', name: 'Economy & Growth' },
    { id: '19', name: 'Private Sector' },
  ],
};

/** The rejection WorldBankApiService.getIndicator throws for an ID upstream rejects. */
function unknownIndicator(indicatorId: string) {
  return notFound(
    `Indicator "${indicatorId}" not found. Use worldbank_search_indicators to find valid IDs.`,
    { reason: 'indicator_not_found', indicatorId },
  );
}

describe('worldbankIndicatorResource', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockResolvedValue(mockIndicator),
    } as never);
  });

  it('returns indicator metadata for a valid ID', async () => {
    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const params = worldbankIndicatorResource.params.parse({ indicatorId: 'NY.GDP.PCAP.CD' });
    const result = await worldbankIndicatorResource.handler(params, ctx);
    expect(result).toMatchObject({
      id: 'NY.GDP.PCAP.CD',
      name: 'GDP per capita (current US$)',
      unit: 'US$',
      sourceName: 'World Development Indicators',
    });
    expect(result.topics).toHaveLength(2);
  });

  it('throws notFound with a recovery hint when the indicator ID is unknown', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(unknownIndicator('INVALID.ID')),
    } as never);

    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const params = worldbankIndicatorResource.params.parse({ indicatorId: 'INVALID.ID' });
    const err = await worldbankIndicatorResource.handler(params, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'indicator_not_found', indicatorId: 'INVALID.ID' },
    });
    expect((err as { data: { recovery: { hint: string } } }).data.recovery.hint).toMatch(
      /worldbank_search_indicators/,
    );
  });

  /**
   * A transient upstream failure must not be relabelled as a definitive miss —
   * an agent told the indicator does not exist changes its input instead of
   * retrying.
   */
  it.each([
    ['serviceUnavailable', serviceUnavailable('Network error during fetch'), -32000],
    ['timeout', timeout('Request timed out after 15000ms'), -32004],
  ])('propagates a %s rejection unchanged', async (_label, upstreamError, expectedCode) => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(upstreamError),
    } as never);

    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const params = worldbankIndicatorResource.params.parse({ indicatorId: 'NY.GDP.PCAP.CD' });
    const err = await worldbankIndicatorResource.handler(params, ctx).catch((e: unknown) => e);
    expect(err).toBe(upstreamError);
    expect((err as { code: number }).code).toBe(expectedCode);
  });

  it('handles sparse payload with empty topics array', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockResolvedValue({
        id: 'SH.XPD.CHEX.GD.ZS',
        name: 'Current health expenditure (% of GDP)',
        unit: '',
        sourceId: '2',
        sourceName: 'World Development Indicators',
        sourceNote: '',
        sourceOrganization: '',
        topics: [],
      }),
    } as never);

    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const params = worldbankIndicatorResource.params.parse({ indicatorId: 'SH.XPD.CHEX.GD.ZS' });
    const result = await worldbankIndicatorResource.handler(params, ctx);
    expect(result.topics).toHaveLength(0);
    expect(result.unit).toBe('');
    expect(result.sourceOrganization).toBe('');
  });

  // ─── Zod params validation ─────────────────────────────────────────────────

  it('rejects missing indicatorId', async () => {
    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    expect(() => worldbankIndicatorResource.params.parse({})).toThrow();
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('notFound error message does not leak env variable names or API keys', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(unknownIndicator('INVALID.XYZ')),
    } as never);

    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const params = worldbankIndicatorResource.params.parse({ indicatorId: 'INVALID.XYZ' });
    const err = await worldbankIndicatorResource.handler(params, ctx).catch((e: unknown) => e);
    const errStr = JSON.stringify(err);
    expect(errStr).not.toMatch(/WORLDBANK_API/);
    expect(errStr).not.toMatch(/Authorization/i);
  });
});
