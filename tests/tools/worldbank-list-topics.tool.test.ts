/**
 * @fileoverview Tests for worldbank_list_topics tool.
 * @module tests/tools/worldbank-list-topics.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

const mockTopics = [
  {
    id: '1',
    name: 'Agriculture & Rural Development',
    sourceNote: 'Covers farming and rural areas.',
  },
  { id: '3', name: 'Economy & Growth', sourceNote: 'GDP, income, and trade indicators.' },
];

describe('worldbankListTopics', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listTopics: vi.fn().mockResolvedValue(mockTopics),
    } as never);
  });

  it('returns all topics', async () => {
    const { worldbankListTopics } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListTopics.input.parse({});
    const result = await worldbankListTopics.handler(input, ctx);
    expect(result.topics).toHaveLength(2);
    expect(result.topics[0]).toMatchObject({ id: '1', name: 'Agriculture & Rural Development' });
  });

  it('formats output with topic names and IDs', async () => {
    const { worldbankListTopics } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js'
    );
    const blocks = worldbankListTopics.format!({ topics: mockTopics });
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Agriculture & Rural Development');
    expect(text).toContain('ID: 1');
    expect(text).toContain('Economy & Growth');
    expect(text).toContain('Covers farming and rural areas.');
  });
});
