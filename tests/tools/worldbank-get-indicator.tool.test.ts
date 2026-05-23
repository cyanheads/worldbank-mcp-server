/**
 * @fileoverview Tests for worldbank_get_indicator tool.
 * @module tests/tools/worldbank-get-indicator.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

describe('worldbankGetIndicator', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockResolvedValue(mockIndicator),
    } as never);
  });

  it('returns indicator metadata', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankGetIndicator.input.parse({ indicator_id: 'NY.GDP.PCAP.CD' });
    const result = await worldbankGetIndicator.handler(input, ctx);
    expect(result).toMatchObject({
      id: 'NY.GDP.PCAP.CD',
      name: 'GDP per capita (current US$)',
      unit: 'US$',
    });
    expect(result.topics).toHaveLength(2);
  });

  it('throws indicator_not_found for invalid ID', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'indicator_not_found' },
      }),
    } as never);

    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetIndicator.errors });
    const input = worldbankGetIndicator.input.parse({ indicator_id: 'INVALID.ID' });
    await expect(worldbankGetIndicator.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'indicator_not_found' },
    });
  });

  it('formats all output fields including topics with IDs', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const blocks = worldbankGetIndicator.format!(mockIndicator);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('NY.GDP.PCAP.CD');
    expect(text).toContain('GDP per capita (current US$)');
    expect(text).toContain('US$');
    expect(text).toContain('World Development Indicators');
    expect(text).toContain('World Bank national accounts data');
    // Topics render with both name and ID
    expect(text).toContain('Economy & Growth (3)');
    expect(text).toContain('Private Sector (19)');
    expect(text).toContain('GDP per capita is gross domestic product');
  });
});
