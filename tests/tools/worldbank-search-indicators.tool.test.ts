/**
 * @fileoverview Tests for worldbank_search_indicators tool.
 * @module tests/tools/worldbank-search-indicators.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultPerPage: 50 }),
}));

const mockIndicator = {
  id: 'NY.GDP.PCAP.CD',
  name: 'GDP per capita (current US$)',
  sourceId: '2',
  sourceName: 'World Development Indicators',
  sourceNote: 'GDP per capita description.',
  topics: [{ id: '3', name: 'Economy & Growth' }],
};

const mockSearchResult = {
  indicators: [mockIndicator],
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
    expect(result.indicators[0]?.id).toBe('NY.GDP.PCAP.CD');
  });

  it('populates enrichment with totalCount, pagination, and effectiveQuery', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ query: 'GDP per capita' });
    await worldbankSearchIndicators.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.currentPage).toBe(1);
    expect(enrichment.totalPages).toBe(1);
    expect(enrichment.effectiveQuery).toContain('GDP per capita');
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

  it('sets enrichment notice on empty results', async () => {
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
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('nonexistent xyz');
  });

  it('distinguishes an out-of-range page from a query that matched nothing', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi
        .fn()
        .mockResolvedValue({ indicators: [], total: 679, page: 99, pages: 7 }),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ query: 'gdp', page: 99 });
    await worldbankSearchIndicators.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBe(
      'Page 99 is past the last page of 7. Request a page between 1 and 7.',
    );
    expect(enrichment.notice).not.toContain('No indicators matched');
  });

  it('maps an invalid topic/source filter to the invalid_filter contract error', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.NotFound,
            'Invalid topic_id or source_id. Use worldbank_list_topics or worldbank_list_sources to browse valid IDs.',
            { reason: 'invalid_filter', topicId: '999' },
          ),
        ),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ topic_id: '999' });
    const err = await Promise.resolve(worldbankSearchIndicators.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'invalid_filter',
        recovery: { hint: expect.stringContaining('worldbank_list_topics') },
      },
    });
    // The caller must never see internal output-schema field names.
    expect((err as McpError).message).not.toMatch(/totalCount|currentPage|totalPages/);
  });

  it('declares no error contract entry that the handler cannot reach', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    // Empty results are structured success with a notice, so no_match can never fire.
    expect(worldbankSearchIndicators.errors?.map((e) => e.reason)).toEqual([
      'missing_filter',
      'invalid_filter',
      'empty_query',
    ]);
  });

  // ─── Queries with no searchable terms ─────────────────────────────────────

  /** The rejection WorldBankApiService.searchIndicators throws for a punctuation-only query. */
  function emptyQuery(query: string) {
    return validationError(
      `Query "${query}" has no letters or digits to search for; punctuation is ignored when matching.`,
      { reason: 'empty_query', query },
    );
  }

  it('maps a punctuation-only query to the empty_query contract error', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockRejectedValue(emptyQuery('!!!')),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ query: '!!!', source_id: '2' });
    await expect(worldbankSearchIndicators.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'empty_query',
        query: '!!!',
        recovery: { hint: expect.stringMatching(/keyword.*omit query/) },
      },
    });
    expect(getEnrichment(ctx).totalCount).toBeUndefined();
  });

  it('renders the empty_query rejection with its recovery hint on both surfaces', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockRejectedValue(emptyQuery('???')),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(
      worldbankSearchIndicators,
      { query: '???', topic_id: '3' },
      { context: { errors: worldbankSearchIndicators.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'empty_query', recovery: { hint: expect.stringContaining('omit query') } },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('"???" has no letters or digits');
    expect(text).toMatch(/Recovery:.*omit query/);
  });

  it('declares empty_query as a validation error pointing at a keyword or a browse', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const entry = worldbankSearchIndicators.errors?.find((e) => e.reason === 'empty_query');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(entry?.recovery).toMatch(/keyword/);
    expect(entry?.recovery).toMatch(/omit query/);
  });

  // ─── Topic and source together ────────────────────────────────────────────

  it('forwards topic_id and source_id together and echoes both', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const searchIndicators = vi.fn().mockResolvedValue(mockSearchResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({ searchIndicators } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ topic_id: '3', source_id: '6' });
    await worldbankSearchIndicators.handler(input, ctx);
    expect(searchIndicators.mock.calls[0]?.[0]).toMatchObject({ topicId: '3', sourceId: '6' });
    expect(getEnrichment(ctx).appliedFilters).toEqual({ topicId: '3', sourceId: '6' });
  });

  it('renders an unknown source alongside a valid topic as invalid_filter on both surfaces', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi
        .fn()
        .mockRejectedValue(
          notFound(
            'Invalid topic_id or source_id. Use worldbank_list_topics or worldbank_list_sources to browse valid IDs.',
            { reason: 'invalid_filter', topicId: '3', sourceId: '999999' },
          ),
        ),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(
      worldbankSearchIndicators,
      { topic_id: '3', source_id: '999999' },
      { context: { errors: worldbankSearchIndicators.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'invalid_filter', topicId: '3', sourceId: '999999' },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toMatch(/Recovery:.*worldbank_list_sources/);
  });

  it('surfaces matches from a deep result page', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const deepMatch = {
      id: 'VC.IHR.PSRC.P5',
      name: 'Intentional homicides (per 100,000 people)',
      sourceId: '2',
      sourceName: 'World Development Indicators',
      sourceNote: 'Intentional homicides are estimates of unlawful homicides.',
      topics: [],
    };
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi
        .fn()
        .mockResolvedValue({ indicators: [deepMatch], total: 1201, page: 25, pages: 25 }),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({
      query: 'VC.IHR.PSRC.P5',
      source_id: '2',
      page: 25,
    });
    const result = await worldbankSearchIndicators.handler(input, ctx);
    expect(result.indicators.map((i) => i.id)).toEqual(['VC.IHR.PSRC.P5']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1201);
    expect(enrichment.currentPage).toBe(25);
    expect(enrichment.notice).toBeUndefined();
  });

  it('formats all fields including sourceId and topics with IDs', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const blocks = worldbankSearchIndicators.format!({ indicators: mockSearchResult.indicators });
    expect(blocks[0]?.type).toBe('text');
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

  // ─── Zod input validation ─────────────────────────────────────────────────

  it('rejects page below minimum (0)', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    expect(() => worldbankSearchIndicators.input.parse({ query: 'GDP', page: 0 })).toThrow();
  });

  it('rejects per_page above maximum (101)', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    expect(() => worldbankSearchIndicators.input.parse({ query: 'GDP', per_page: 101 })).toThrow();
  });

  /**
   * Every one of the 21 topics and 71 sources has a numeric ID. Blank and padded
   * values stay accepted: form clients submit every field, and the handler trims
   * and treats blank as absent.
   */
  it.each([
    ['topic_id', 'worldbank_list_topics'],
    ['source_id', 'worldbank_list_sources'],
  ])('rejects a non-numeric %s at the schema, pointing at %s', async (field, listTool) => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    for (const value of ['a/b', 'Economy', '3;4', '3,4', '3.0']) {
      const parsed = worldbankSearchIndicators.input.safeParse({ [field]: value });
      expect(parsed.success, value).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain(listTool);
    }
    for (const value of ['3', '21', '', '   ', ' 6 ']) {
      expect(worldbankSearchIndicators.input.safeParse({ [field]: value }).success, value).toBe(
        true,
      );
    }
    const property = z.toJSONSchema(worldbankSearchIndicators.input).properties?.[field];
    const pattern = typeof property === 'object' ? property.pattern : undefined;
    expect(pattern).toBeDefined();
    expect(new RegExp(pattern ?? '').test('a/b')).toBe(false);
  });

  it('defaults page to 1 when absent', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const parsed = worldbankSearchIndicators.input.parse({ query: 'GDP' });
    expect(parsed.page).toBe(1);
  });

  // ─── Handler: filter logic ────────────────────────────────────────────────

  it('succeeds with only topic_id (no query)', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ topic_id: '3' });
    const result = await worldbankSearchIndicators.handler(input, ctx);
    expect(result.indicators).toHaveLength(1);
  });

  it('succeeds with only source_id (no query)', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ source_id: '2' });
    const result = await worldbankSearchIndicators.handler(input, ctx);
    expect(result.indicators).toHaveLength(1);
  });

  it('trims whitespace from query before using it in enrichment echo', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ query: '  GDP per capita  ' });
    await worldbankSearchIndicators.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('GDP per capita');
    // Should not contain leading/trailing spaces
    expect(enrichment.effectiveQuery).not.toContain('  GDP');
  });

  it('echoes the applied filters field by field, omitting the ones not given', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({
      query: '  GDP per capita  ',
      source_id: '2',
    });
    await worldbankSearchIndicators.handler(input, ctx);
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      query: 'GDP per capita',
      sourceId: '2',
    });
  });

  /**
   * The trailer sits directly above the `effectiveQuery` line, which carries the
   * same pairs — without the label the two are indistinguishable in `content[]`.
   */
  it('renders the applied-filters trailer as a labelled run of key=value pairs', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const render = worldbankSearchIndicators.enrichmentTrailer?.appliedFilters?.render;
    expect(render?.({ query: 'GDP', topicId: '3' })).toBe(
      '**Applied Filters:** query="GDP", topic_id=3',
    );
  });

  it('sets non-query empty-results notice when only topic filter used', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockResolvedValue({ indicators: [], total: 0, page: 1, pages: 0 }),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const input = worldbankSearchIndicators.input.parse({ topic_id: '99' });
    await worldbankSearchIndicators.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).not.toContain('"'); // non-query branch doesn't echo a query string
  });

  // ─── Provider prose ───────────────────────────────────────────────────────

  it('renders a normalized multi-line source note identically on both surfaces', async () => {
    const cleanedNote =
      'School survey.  Total score is the sum of whether a school has:   , Functional blackboard    - Pens, pencils, exercise books\n- Textbooks   - Fraction of students in class with a desk    - Used ICT in class and have access to ICT in the school.';
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockResolvedValue({
        ...mockSearchResult,
        indicators: [{ ...mockIndicator, id: 'SE.PRM.INPT', sourceNote: cleanedNote }],
      }),
    } as never);

    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(
      worldbankSearchIndicators,
      { query: 'SE.PRM.INPT' },
      { context: { errors: worldbankSearchIndicators.errors } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      indicators: [{ id: 'SE.PRM.INPT', sourceNote: cleanedNote }],
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(cleanedNote);
    expect(text).not.toMatch(/<\/?br/i);
  });

  // ─── Format edge cases ────────────────────────────────────────────────────

  it('format omits topics line when indicator has no topics', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const noTopics = [{ ...mockIndicator, topics: [] }];
    const blocks = worldbankSearchIndicators.format!({ indicators: noTopics });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Topics:');
  });

  it('format omits sourceNote when empty', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const noNote = [{ ...mockIndicator, sourceNote: '' }];
    const blocks = worldbankSearchIndicators.format!({ indicators: noNote });
    const text = (blocks[0] as { text: string }).text;
    // Should still have the indicator name and ID, just no note
    expect(text).toContain('NY.GDP.PCAP.CD');
    expect(text).not.toContain('GDP per capita description.'); // the note text
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('format output never leaks env variable names or API keys', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const blocks = worldbankSearchIndicators.format!({ indicators: mockSearchResult.indicators });
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toMatch(/WORLDBANK_API/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/Authorization/i);
  });

  it('injection-attempt query does not cause handler to crash', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const injectionQuery = '<script>alert(1)</script>';
    const input = worldbankSearchIndicators.input.parse({ query: injectionQuery });
    // Should succeed (service mock returns normal data); no crash from injection chars
    const result = await worldbankSearchIndicators.handler(input, ctx);
    expect(result.indicators).toBeDefined();
  });

  it('oversized query string (5000 chars) does not crash handler', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    const oversized = 'a'.repeat(5000);
    const input = worldbankSearchIndicators.input.parse({ query: oversized });
    const result = await worldbankSearchIndicators.handler(input, ctx);
    expect(result.indicators).toBeDefined();
  });
});
