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
  getServerConfig: vi.fn().mockReturnValue({ defaultPerPage: 50, clampLimits: true }),
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
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({ defaultPerPage: 50, clampLimits: true } as never);
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
    const result = await runToolContract(
      worldbankSearchIndicators,
      { query: 'gdp', page: 99, per_page: 100 },
      { context: { errors: worldbankSearchIndicators.errors } },
    );
    /** The wording every other paged tool uses for the same situation, page size included. */
    const notice =
      'Page 99 is past the end of the results — 679 indicators span 7 pages (1–7) at per_page=100. Keep the same filters and request a page from 1 to 7.';
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(notice);
    expect(text).not.toContain('No indicators matched');
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
    const result = await runToolContract(worldbankSearchIndicators, { topic_id: '999' });
    const error = (result.structuredContent as { error: { message: string } }).error;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'invalid_filter',
        recovery: { hint: expect.stringContaining('worldbank_list_topics') },
      },
    });
    // The caller must never see internal output-schema field names.
    expect(error.message).not.toMatch(/totalCount|currentPage|totalPages/);
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
      data: { reason: 'empty_query', query: '!!!' },
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
    expect(getEnrichment(ctx).appliedFilters).toEqual({ topicId: '3', sourceId: '6', perPage: 50 });
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

  it.each([
    ['invalid_filter', JsonRpcErrorCode.NotFound, { topic_id: '999' }],
    ['empty_query', JsonRpcErrorCode.ValidationError, { query: '!!!' }],
  ] as const)("forwards the service's data on a %s re-throw", async (reason, code, input) => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockRejectedValue(
        new McpError(code, `Rejected: ${reason}.`, {
          reason,
          detail: 'upstream detail',
          retryable: false,
        }),
      ),
    } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(worldbankSearchIndicators, input);

    expect(result.structuredContent).toMatchObject({
      error: {
        code,
        data: {
          reason,
          detail: 'upstream detail',
          retryable: false,
          recovery: { hint: expect.any(String) },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text.trimEnd()).toMatch(new RegExp(`\\(reason ${reason} · not retryable\\)$`));
  });

  it('reads limit as per_page', async () => {
    const searchIndicators = vi.fn().mockResolvedValue(mockSearchResult);
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ searchIndicators } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(worldbankSearchIndicators, {
      query: 'gdp',
      limit: 5,
    } as never);

    expect(result.isError).toBeFalsy();
    expect(searchIndicators.mock.calls[0]?.[0]).toMatchObject({ query: 'gdp', perPage: 5 });
  });

  // ─── Zod input validation ─────────────────────────────────────────────────

  it('rejects page below minimum (0)', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    expect(() => worldbankSearchIndicators.input.parse({ query: 'GDP', page: 0 })).toThrow();
  });

  it('accepts per_page above the 3000 maximum for the handler to clamp', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    expect(worldbankSearchIndicators.input.safeParse({ query: 'GDP', per_page: 101 }).success).toBe(
      true,
    );
    expect(
      worldbankSearchIndicators.input.safeParse({ query: 'GDP', per_page: 5000 }).success,
    ).toBe(true);
  });

  it('rejects per_page above 3000 under WORLDBANK_CLAMP_LIMITS=false', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({ defaultPerPage: 50, clampLimits: false } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(worldbankSearchIndicators, {
      query: 'GDP',
      per_page: 3001,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        message:
          'Input validation error: Invalid arguments for tool worldbank_search_indicators: per_page: Too big: expected number to be <=3000',
      },
    });
    expect(
      worldbankSearchIndicators.input.safeParse({ query: 'GDP', per_page: 3000 }).success,
    ).toBe(true);
  });

  // ─── Page size ────────────────────────────────────────────────────────────

  /** The disclosure for a page size reduced to 3000, with or without a next page. */
  const reducedTo3000 = (requested: number, continues: boolean) =>
    `per_page=${requested} was reduced to 3000, the maximum page size. totalPages counts pages of 3000${continues ? ', so page 2 with the same filters continues where this page ends' : ''}.`;

  it('serves per_page 5000 at 3000, echoing both sizes and disclosing it on both surfaces', async () => {
    const searchIndicators = vi
      .fn()
      .mockResolvedValue({ indicators: [mockIndicator], total: 5295, page: 1, pages: 2 });
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ searchIndicators } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(
      worldbankSearchIndicators,
      { query: 'population', per_page: 5000 },
      { context: { errors: worldbankSearchIndicators.errors } },
    );

    expect(result.isError).toBeFalsy();
    expect(searchIndicators.mock.calls[0]?.[0]).toMatchObject({ page: 1, perPage: 3000 });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { query: 'population', perPage: 3000, requestedPerPage: 5000 },
      totalCount: 5295,
      totalPages: 2,
      notice: reducedTo3000(5000, true),
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(
      '**Applied Filters:** query="population", per_page=3000 (requested 5000)',
    );
    expect(text).toContain(reducedTo3000(5000, true));
  });

  it('clamps a server default of 5000 to 3000 the same way', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    vi.mocked(getServerConfig).mockReturnValue({
      defaultPerPage: 5000,
      clampLimits: true,
    } as never);
    const searchIndicators = vi
      .fn()
      .mockResolvedValue({ indicators: [mockIndicator], total: 1498, page: 1, pages: 1 });
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ searchIndicators } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    await worldbankSearchIndicators.handler(
      worldbankSearchIndicators.input.parse({ source_id: '2' }),
      ctx,
    );

    expect(searchIndicators.mock.calls[0]?.[0]).toMatchObject({ sourceId: '2', perPage: 3000 });
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      sourceId: '2',
      perPage: 3000,
      requestedPerPage: 5000,
    });
    expect(getEnrichment(ctx).notice).toBe(reducedTo3000(5000, false));
  });

  it('names the page range at the served size on a page past the end', async () => {
    const searchIndicators = vi
      .fn()
      .mockResolvedValue({ indicators: [], total: 5295, page: 3, pages: 2 });
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ searchIndicators } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(
      worldbankSearchIndicators,
      { query: 'population', page: 3, per_page: 5000 },
      { context: { errors: worldbankSearchIndicators.errors } },
    );

    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `Page 3 is past the end of the results — 5295 indicators span 2 pages (1–2) at per_page=3000. Keep the same filters and request a page from 1 to 2. ${reducedTo3000(5000, false)}`,
    );
  });

  it('adds no page-size notice when the requested size fits', async () => {
    const searchIndicators = vi.fn().mockResolvedValue(mockSearchResult);
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({ searchIndicators } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankSearchIndicators.errors });
    await worldbankSearchIndicators.handler(
      worldbankSearchIndicators.input.parse({ query: 'gdp', per_page: 3000 }),
      ctx,
    );

    expect(searchIndicators.mock.calls[0]?.[0]).toMatchObject({ perPage: 3000 });
    expect(getEnrichment(ctx).appliedFilters).toEqual({ query: 'gdp', perPage: 3000 });
    expect(getEnrichment(ctx).notice).toBeUndefined();
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
      perPage: 50,
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
    expect(render?.({ query: 'GDP', topicId: '3', perPage: 50 })).toBe(
      '**Applied Filters:** query="GDP", topic_id=3, per_page=50',
    );
    expect(render?.({ query: 'GDP', perPage: 3000, requestedPerPage: 5000 })).toBe(
      '**Applied Filters:** query="GDP", per_page=3000 (requested 5000)',
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
    /**
     * The note runs past the 150-character excerpt: the line break inside it
     * survives the cut, and the space the cut lands after is dropped before the mark.
     */
    const excerpt =
      'School survey.  Total score is the sum of whether a school has:   , Functional blackboard    - Pens, pencils, exercise books\n- Textbooks   - Fraction…';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      indicators: [{ id: 'SE.PRM.INPT', sourceNote: excerpt }],
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(excerpt.replace('\n-', '\\\n\\-'));
    expect(text).not.toMatch(/<\/?br/i);
  });

  // ─── Description excerpt ──────────────────────────────────────────────────

  /** Run the tool through the contract runner over one indicator carrying `sourceNote`. */
  async function searchWithNote(sourceNote: string) {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      searchIndicators: vi.fn().mockResolvedValue({
        ...mockSearchResult,
        indicators: [{ ...mockIndicator, sourceNote }],
      }),
    } as never);
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const result = await runToolContract(
      worldbankSearchIndicators,
      { query: 'GDP per capita' },
      { context: { errors: worldbankSearchIndicators.errors } },
    );
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { indicators: Array<{ sourceNote: string }> };
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    return { note: structured.indicators[0]?.sourceNote, text };
  }

  it.each([
    ['an empty note', ''],
    ['a note of exactly 150 characters', 'a'.repeat(150)],
  ])('returns %s unchanged', async (_label, sent) => {
    const { note, text } = await searchWithNote(sent);
    expect(note).toBe(sent);
    expect(text).not.toContain('…');
  });

  it('cuts a longer note to its first 150 characters and marks the cut, on both surfaces', async () => {
    const sent = `${'b'.repeat(150)}TAIL`;
    const { note, text } = await searchWithNote(sent);
    expect(note).toBe(`${'b'.repeat(150)}…`);
    expect(text).toContain(`${'b'.repeat(150)}…`);
    expect(text).not.toContain('TAIL');
  });

  it('cuts the longest note in the catalog to the same 151-character excerpt', async () => {
    const { note, text } = await searchWithNote('x'.repeat(3937));
    expect(note).toHaveLength(151);
    expect(text).not.toContain('x'.repeat(151));
  });

  it('describes sourceNote as an excerpt and points at worldbank_get_indicator for the whole note', async () => {
    const { worldbankSearchIndicators } = await import(
      '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js'
    );
    const item = (
      worldbankSearchIndicators.output.shape.indicators as unknown as {
        element: { shape: Record<string, { description?: string }> };
      }
    ).element.shape;
    expect(item.sourceNote?.description).toMatch(/150 characters/);
    expect(item.sourceNote?.description).toMatch(/worldbank_get_indicator/);
    expect(worldbankSearchIndicators.description).toMatch(/150 characters/);
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
