/**
 * @fileoverview Tests for worldbank_list_sources tool.
 * @module tests/tools/worldbank-list-sources.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultPerPage: 50, clampLimits: true }),
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
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({ defaultPerPage: 50, clampLimits: true } as never);
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
    expect(result.sources[0]?.id).toBe('2');
  });

  it('reads limit as per_page', async () => {
    const listSources = vi.fn().mockResolvedValue(mockSourcesResult);
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ listSources } as never);
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const result = await runToolContract(worldbankListSources, { page: 2, limit: 5 } as never);

    expect(result.isError).toBeFalsy();
    expect(listSources.mock.calls[0]?.slice(0, 2)).toEqual([2, 5]);
  });

  it('still rejects limit sent alongside per_page', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const result = await runToolContract(worldbankListSources, {
      per_page: 10,
      limit: 5,
    } as never);

    expect(result.isError).toBe(true);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('limit');
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

  it('flags a page past the end on both surfaces', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listSources: vi.fn().mockResolvedValue({ sources: [], total: 71, page: 2, pages: 1 }),
    } as never);
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const result = await runToolContract(worldbankListSources, { page: 2, per_page: 100 });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      sources: [],
      totalCount: 71,
      currentPage: 2,
      totalPages: 1,
    });
    expect(structured.notice).toBe(
      'Page 2 is past the end of the results — 71 sources span 1 page at per_page=100. Keep the same filters and request page 1.',
    );
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('Page 2 is past the end of the results');
  });

  it('says no sources came back when the listing itself is empty', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      listSources: vi.fn().mockResolvedValue({ sources: [], total: 0, page: 1, pages: 1 }),
    } as never);
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const ctx = createMockContext();
    await worldbankListSources.handler(worldbankListSources.input.parse({}), ctx);
    expect(getEnrichment(ctx).notice).toMatch(/returned no data sources/);
    expect(getEnrichment(ctx).notice).not.toMatch(/past the end/);
  });

  it('raises no notice on a page with sources', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const ctx = createMockContext();
    await worldbankListSources.handler(worldbankListSources.input.parse({ page: 1 }), ctx);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('formats all fields including metadataAvailability and concepts', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const blocks = worldbankListSources.format!({ sources: mockSourcesResult.sources });
    expect(blocks[0]?.type).toBe('text');
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

  it('accepts per_page above the 100 maximum for the handler to clamp', async () => {
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    expect(worldbankListSources.input.safeParse({ per_page: 101 }).success).toBe(true);
  });

  it('rejects per_page above 100 under WORLDBANK_CLAMP_LIMITS=false, as before the clamp', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({ defaultPerPage: 50, clampLimits: false } as never);
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const result = await runToolContract(worldbankListSources, { per_page: 101 });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32602,
        message:
          'Input validation error: Invalid arguments for tool worldbank_list_sources: per_page: Too big: expected number to be <=100',
      },
    });
  });

  // ─── Page size ────────────────────────────────────────────────────────────

  /** All 71 sources the API lists, as one page of 100 holds them. */
  const allSources = Array.from({ length: 71 }, (_, i) => ({
    ...mockSourcesResult.sources[0]!,
    id: String(i + 1),
    name: `Source ${i + 1}`,
  }));

  const reducedTo100 = (requested: number) =>
    `per_page=${requested} was reduced to 100, the maximum page size. totalPages counts pages of 100.`;

  it('serves per_page 101 at 100 — all 71 sources — and discloses it on both surfaces', async () => {
    const listSources = vi
      .fn()
      .mockResolvedValue({ sources: allSources, total: 71, page: 1, pages: 1 });
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ listSources } as never);
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const result = await runToolContract(worldbankListSources, { per_page: 101 });

    expect(result.isError).toBeFalsy();
    expect(listSources.mock.calls[0]?.slice(0, 2)).toEqual([1, 100]);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.sources).toHaveLength(71);
    expect(structured).toMatchObject({
      appliedFilters: { perPage: 100, requestedPerPage: 101 },
      totalCount: 71,
      totalPages: 1,
      notice: reducedTo100(101),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**Applied Filters:** per_page=100 (requested 101)');
    expect(text).toContain(reducedTo100(101));
  });

  it('clamps a server default of 5000 to 100 the same way', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      defaultPerPage: 5000,
      clampLimits: true,
    } as never);
    const listSources = vi
      .fn()
      .mockResolvedValue({ sources: allSources, total: 71, page: 1, pages: 1 });
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ listSources } as never);
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const ctx = createMockContext();
    await worldbankListSources.handler(worldbankListSources.input.parse({}), ctx);

    expect(listSources.mock.calls[0]?.slice(0, 2)).toEqual([1, 100]);
    expect(getEnrichment(ctx).appliedFilters).toEqual({ perPage: 100, requestedPerPage: 5000 });
    expect(getEnrichment(ctx).notice).toBe(reducedTo100(5000));
  });

  it('names the page range at the served size on a page past the end', async () => {
    const listSources = vi.fn().mockResolvedValue({ sources: [], total: 71, page: 2, pages: 1 });
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ listSources } as never);
    const { worldbankListSources } = await import(
      '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js'
    );
    const result = await runToolContract(worldbankListSources, { page: 2, per_page: 500 });

    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `Page 2 is past the end of the results — 71 sources span 1 page at per_page=100. Keep the same filters and request page 1. ${reducedTo100(500)}`,
    );
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
