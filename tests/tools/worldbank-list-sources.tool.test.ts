/**
 * @fileoverview Tests for worldbank_list_sources tool.
 * @module tests/tools/worldbank-list-sources.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

  it('returns sources list', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListSources.input.parse({ page: 1 });
    const result = await worldbankListSources.handler(input, ctx);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].id).toBe('2');
  });

  it('populates enrichment with totalCount and pagination', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankListSources.input.parse({ page: 1 });
    await worldbankListSources.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(71);
    expect(enrichment.currentPage).toBe(1);
    expect(enrichment.totalPages).toBe(2);
  });

  it('formats all fields including metadataAvailability and concepts', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const blocks = worldbankListSources.format!({ sources: mockSourcesResult.sources });
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('World Development Indicators');
    expect(text).toContain('ID: 2');
    expect(text).toContain('WDI');
    expect(text).toContain('2024-01-15');
    expect(text).toContain('Metadata availability');
    expect(text).toContain('Concepts');
    expect(text).toContain('1400');
  });

  // ─── Zod input validation ─────────────────────────────────────────────────

  it('rejects page below minimum (0)', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    expect(() => worldbankListSources.input.parse({ page: 0 })).toThrow();
  });

  it('rejects per_page above maximum (101)', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    expect(() => worldbankListSources.input.parse({ per_page: 101 })).toThrow();
  });

  it('defaults page to 1 when absent', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const parsed = worldbankListSources.input.parse({});
    expect(parsed.page).toBe(1);
  });

  // ─── Format edge cases ────────────────────────────────────────────────────

  it('format omits optional fields for sparse source entries', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const sparseSource = [
      {
        id: '99',
        name: 'Sparse Source',
        code: '',
        lastUpdated: '',
        dataAvailability: '',
        metadataAvailability: '',
        concepts: '',
      },
    ];
    const blocks = worldbankListSources.format!({ sources: sparseSource });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Sparse Source');
    // Optional fields without values are omitted by the format function
    expect(text).not.toContain('Last updated:');
    expect(text).not.toContain('Data availability:');
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('format output never leaks env variable names or API keys', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const blocks = worldbankListSources.format!({ sources: mockSourcesResult.sources });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toMatch(/WORLDBANK_API/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/Authorization/i);
  });
});
