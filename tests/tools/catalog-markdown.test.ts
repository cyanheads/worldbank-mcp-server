/**
 * @fileoverview Literal upstream text in catalog Markdown rendering.
 * @module tests/tools/catalog-markdown.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { worldbankGetCountry } from '@/mcp-server/tools/definitions/worldbank-get-country.tool.js';
import { worldbankGetIndicator } from '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js';
import { worldbankListSources } from '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js';
import { worldbankListTopics } from '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js';
import { worldbankSearchIndicators } from '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js';

const hostile = 'title #\n`code` **bold** <b>html</b>\n[ref]: https://example.com\n[ref]';
const encoded =
  'title \\#\\\n\\`code\\` \\*\\*bold\\*\\* \\<b>html\\</b>\\\n\\[ref\\]: https://example.com\\\n\\[ref\\]';
const indicator = {
  id: hostile,
  name: hostile,
  unit: hostile,
  sourceId: hostile,
  sourceName: hostile,
  sourceOrganization: hostile,
  sourceNote: hostile,
  topics: [{ id: hostile, name: hostile }],
};

vi.mock('@/services/worldbank/worldbank-service.js', () => ({ getWorldBankApiService: vi.fn() }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => ({ defaultPerPage: 50 }) }));

describe('catalog Markdown literals', () => {
  it('preserves hostile indicator metadata byte for byte through the contract boundary', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockResolvedValue(indicator),
    } as never);
    const result = await runToolContract(worldbankGetIndicator, { indicator_id: 'TEST' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(indicator);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text.split(encoded)).toHaveLength(10);
  });
  it.each([
    [
      'country',
      () =>
        worldbankGetCountry.format!({
          id: hostile,
          iso2: hostile,
          name: hostile,
          region: { id: hostile, name: hostile },
          incomeLevel: { id: hostile, name: hostile },
          lendingType: hostile,
          capitalCity: hostile,
          longitude: hostile,
          latitude: hostile,
          isAggregate: false,
        }),
    ],
    ['indicator', () => worldbankGetIndicator.format!(indicator)],
    [
      'sources',
      () =>
        worldbankListSources.format!({
          sources: [
            {
              id: hostile,
              name: hostile,
              code: hostile,
              lastUpdated: hostile,
              dataAvailability: hostile,
              metadataAvailability: hostile,
              concepts: hostile,
            },
          ],
        }),
    ],
    [
      'topics',
      () =>
        worldbankListTopics.format!({
          topics: [{ id: hostile, name: hostile, sourceNote: hostile }],
        }),
    ],
    ['search', () => worldbankSearchIndicators.format!({ indicators: [indicator] })],
  ] as const)('escapes %s without changing its input', (_name, render) => {
    const before = JSON.stringify(indicator);
    const blocks = render();
    const text = blocks.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(encoded);
    expect(text).not.toContain(hostile);
    expect(JSON.stringify(indicator)).toBe(before);
  });

  it('keeps raw query and notices on structuredContent while escaping custom trailers', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockResolvedValue({ indicators: [], total: 0, page: 1, pages: 0 }),
    } as never);
    const result = await runToolContract(worldbankSearchIndicators, { query: hostile });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      indicators: [],
      appliedFilters: { query: hostile },
      effectiveQuery: `query="${hostile}"`,
      notice: `No indicators matched "${hostile}". Try a synonym or browse by topic using worldbank_list_topics.`,
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(`**Applied Filters:** query="${encoded}"`);
    expect(text).toContain(
      `**Notice:** No indicators matched "${encoded}". Try a synonym or browse by topic using worldbank_list_topics.`,
    );
  });
});
