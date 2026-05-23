/**
 * @fileoverview Tests for worldbank_list_sources tool.
 * @module tests/tools/worldbank-list-sources.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultPerPage: 50 }),
}));

const mockSourcesResult = {
  sources: [
    {
      id: '2',
      name: 'World Development Indicators',
      code: 'WDI',
      lastUpdated: '2024-01-15',
      dataAvailability: 'Y',
      metadataAvailability: 'Y',
      concepts: '1400',
    },
    {
      id: '6',
      name: 'International Debt Statistics',
      code: 'IDS',
      lastUpdated: '2023-12-01',
      dataAvailability: 'Y',
      metadataAvailability: 'N',
      concepts: '200',
    },
  ],
  total: 71,
  page: 1,
  pages: 2,
};

describe('worldbankListSources', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listSources: vi.fn().mockResolvedValue(mockSourcesResult),
    } as never);
  });

  it('returns sources list with pagination', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListSources.input.parse({ page: 1 });
    const result = await worldbankListSources.handler(input, ctx);
    expect(result.sources).toHaveLength(2);
    expect(result.total).toBe(71);
    expect(result.sources[0].id).toBe('2');
  });

  it('formats all fields including metadataAvailability and concepts', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const blocks = worldbankListSources.format!(mockSourcesResult);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('World Development Indicators');
    expect(text).toContain('ID: 2');
    expect(text).toContain('WDI');
    expect(text).toContain('2024-01-15');
    expect(text).toContain('Metadata availability');
    expect(text).toContain('Concepts');
    expect(text).toContain('1400');
    // Pagination hint on non-last page
    expect(text).toContain('page=2');
  });
});
