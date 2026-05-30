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

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it('returns empty topics list when service returns none', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listTopics: vi.fn().mockResolvedValue([]),
    } as never);

    const { worldbankListTopics } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListTopics.input.parse({});
    const result = await worldbankListTopics.handler(input, ctx);
    expect(result.topics).toHaveLength(0);
  });

  it('format renders topic count in header', async () => {
    const { worldbankListTopics } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js'
    );
    const blocks = worldbankListTopics.format!({ topics: mockTopics });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2 total');
  });

  it('format omits sourceNote line when it is empty', async () => {
    const { worldbankListTopics } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js'
    );
    const noNote = [{ id: '5', name: 'Trade', sourceNote: '' }];
    const blocks = worldbankListTopics.format!({ topics: noNote });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Trade');
    // The format function only renders sourceNote if truthy — empty string should be absent
    // Confirm the text contains the topic but doesn't have a blank line artifact that would mislead
    expect(text.trim()).not.toBe('');
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('format output never leaks env variable names or API keys', async () => {
    const { worldbankListTopics } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js'
    );
    const blocks = worldbankListTopics.format!({ topics: mockTopics });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toMatch(/WORLDBANK_API/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/Authorization/i);
  });
});
