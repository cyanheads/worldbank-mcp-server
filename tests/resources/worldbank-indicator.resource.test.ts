/**
 * @fileoverview Tests for worldbank-indicator resource.
 * @module tests/resources/worldbank-indicator.resource.test
 */

import {
  JsonRpcErrorCode,
  notFound,
  serviceUnavailable,
  timeout,
  validationError,
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

/** A resource's params schema — optional on the definition type, declared by this resource. */
function paramsOf<T extends { params?: unknown }>(definition: T): NonNullable<T['params']> {
  if (!definition.params) throw new Error('Resource declares no params schema');
  return definition.params;
}

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
    const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId: 'NY.GDP.PCAP.CD' });
    const result = await worldbankIndicatorResource.handler(params, ctx);
    expect(result).toMatchObject({
      id: 'NY.GDP.PCAP.CD',
      name: 'GDP per capita (current US$)',
      unit: 'US$',
      sourceName: 'World Development Indicators',
    });
    expect(result.topics).toHaveLength(2);
  });

  it.each([
    ['indicator_not_found', notFound],
    ['multiple_indicators', validationError],
  ] as const)("forwards the service's data on a %s re-throw", async (reason, factory) => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(
        factory(`Rejected: ${reason}.`, {
          reason,
          indicatorId: 'NY.GDP.PCAP.CD',
          detail: 'upstream detail',
          retryable: false,
        }),
      ),
    } as never);
    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId: 'NY.GDP.PCAP.CD' });
    const err = await Promise.resolve(worldbankIndicatorResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      data: {
        reason,
        indicatorId: 'NY.GDP.PCAP.CD',
        detail: 'upstream detail',
        retryable: false,
        recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
      },
    });
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
    const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId: 'INVALID.ID' });
    const err = await Promise.resolve(worldbankIndicatorResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );
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
    const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId: 'NY.GDP.PCAP.CD' });
    const err = await Promise.resolve(worldbankIndicatorResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );
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
    const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId: 'SH.XPD.CHEX.GD.ZS' });
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
    expect(() => paramsOf(worldbankIndicatorResource).parse({})).toThrow();
  });

  it.each([
    ['NY.GDP.PCAP.CD;SP.POP.TOTL'],
    ['NY.GDP.PCAP.CD,SP.POP.TOTL'],
    ['NY.GDP.PCAP.CD%3BSP.POP.TOTL'],
    ['a/b'],
  ])('rejects the multi-ID selector or out-of-charset ID %j in the URI', async (indicatorId) => {
    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const parsed = paramsOf(worldbankIndicatorResource).safeParse({ indicatorId });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('worldbank_search_indicators');
  });

  it.each([['NY.GDP.PCAP.CD'], ['CoCA_fexp'], ['1.1_YOUTH.LITERACY.RATE']])(
    'accepts the single indicator ID %j',
    async (indicatorId) => {
      const { worldbankIndicatorResource } = await import(
        '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
      );
      expect(paramsOf(worldbankIndicatorResource).safeParse({ indicatorId }).success).toBe(true);
    },
  );

  it.each([['all'], ['All']])(
    'rejects %j through its error path as multiple_indicators with the search-tool recovery',
    async (indicatorId) => {
      const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
      const getIndicator = vi.fn().mockResolvedValue(mockIndicator);
      vi.mocked(getWorldBankApiService).mockReturnValue({ getIndicator } as never);

      const { worldbankIndicatorResource } = await import(
        '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
      );
      const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
      const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId });
      await expect(worldbankIndicatorResource.handler(params, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(`"${indicatorId}"`),
        data: {
          reason: 'multiple_indicators',
          indicatorId,
          recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
        },
      });
      expect(getIndicator).not.toHaveBeenCalled();
    },
  );

  it('maps an ID the service resolves to several indicators to multiple_indicators', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(
        validationError('Indicator ID "XYZ" selects more than one indicator (A.B, C.D).', {
          reason: 'multiple_indicators',
          indicatorId: 'XYZ',
          matchedIds: ['A.B', 'C.D'],
        }),
      ),
    } as never);

    const { worldbankIndicatorResource } = await import(
      '@/mcp-server/resources/definitions/worldbank-indicator.resource.js'
    );
    const ctx = createMockContext({ errors: worldbankIndicatorResource.errors });
    const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId: 'XYZ' });
    await expect(worldbankIndicatorResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'multiple_indicators',
        indicatorId: 'XYZ',
        matchedIds: ['A.B', 'C.D'],
        recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
      },
    });
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
    const params = paramsOf(worldbankIndicatorResource).parse({ indicatorId: 'INVALID.XYZ' });
    const err = await Promise.resolve(worldbankIndicatorResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );
    const errStr = JSON.stringify(err);
    expect(errStr).not.toMatch(/WORLDBANK_API/);
    expect(errStr).not.toMatch(/Authorization/i);
  });
});
