/**
 * @fileoverview Tests for worldbank_search_indicators tool.
 * @module tests/tools/worldbank-search-indicators.tool.test
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

const mockSearchResult = {
  indicators: [
    {
      id: 'NY.GDP.PCAP.CD',
      name: 'GDP per capita (current US$)',
      sourceId: '2',
      sourceName: 'World Development Indicators',
      sourceNote: 'GDP per capita description.',
      topics: [{ id: '3', name: 'Economy & Growth' }],
    },
  ],
  total: 1,
  page: 1,
  pages: 1,
};

describe('worldbankSearchIndicators', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockResolvedValue(mockSearchResult),
    } as never);
  });

  it('returns matching indicators for a query', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ query: 'GDP per capita' });
    const result = await worldbankSearchIndicators.handler(input, ctx);
    expect(result.indicators).toHaveLength(1);
    expect(result.indicators[0].id).toBe('NY.GDP.PCAP.CD');
  });

  it('throws missing_filter when all three filter fields are absent', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    // Empty strings = form-client behaviour, treated as absent
    const input = worldbankSearchIndicators.input.parse({ query: '', topic_id: '', source_id: '' });
    await expect(worldbankSearchIndicators.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_filter' },
    });
  });

  it('returns message on empty results', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockResolvedValue({ indicators: [], total: 0, page: 1, pages: 0 }),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ query: 'nonexistent xyz' });
    const result = await worldbankSearchIndicators.handler(input, ctx);
    expect(result.indicators).toHaveLength(0);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('nonexistent xyz');
  });

  it('formats all fields including sourceId and topics with IDs', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const blocks = worldbankSearchIndicators.format!(mockSearchResult);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('NY.GDP.PCAP.CD');
    expect(text).toContain('GDP per capita (current US$)');
    // sourceId explicitly rendered
    expect(text).toContain('ID: 2');
    expect(text).toContain('World Development Indicators');
    // topic ID rendered
    expect(text).toContain('Economy & Growth (3)');
    expect(text).toContain('GDP per capita description.');
  });

  it('renders message field in format when present', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const emptyResult = {
      ...mockSearchResult,
      indicators: [],
      total: 0,
      message: 'No indicators matched "xyz". Try a synonym.',
    };
    const blocks = worldbankSearchIndicators.format!(emptyResult);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No indicators matched "xyz"');
  });
});
