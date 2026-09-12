/**
 * @fileoverview Tests for worldbank_get_data tool.
 * @module tests/tools/worldbank-get-data.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultPerPage: 50 }),
}));

const usRow = {
  countryCode: 'US',
  countryIso3: 'USA',
  countryName: 'United States',
  date: '2022',
  value: 76399.42,
  obsStatus: '',
  isAggregate: false,
};

const mockDataResult = {
  data: [
    usRow,
    {
      countryCode: 'CN',
      countryIso3: 'CHN',
      countryName: 'China',
      date: '2022',
      value: 12720.04,
      obsStatus: '',
      isAggregate: false,
    },
    {
      countryCode: 'ZW',
      countryIso3: 'ZWE',
      countryName: 'Zimbabwe',
      date: '2022',
      value: null,
      obsStatus: '',
      isAggregate: false,
    },
  ],
  indicator: { id: 'NY.GDP.PCAP.CD', name: 'GDP per capita (current US$)' },
  total: 3,
  page: 1,
  pages: 1,
  nullCount: 1,
  dateFilterDropped: false,
};

describe('worldbankGetData', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockResolvedValue(mockDataResult),
    } as never);
  });

  it('returns data with null count and indicator metadata', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: ['US', 'CN', 'ZW'],
    });
    const result = await worldbankGetData.handler(input, ctx);
    expect(result.data).toHaveLength(3);
    expect(result.nullCount).toBe(1);
    expect(result.indicator.id).toBe('NY.GDP.PCAP.CD');
  });

  it('populates enrichment with totalCount and pagination', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: ['US', 'CN', 'ZW'],
    });
    await worldbankGetData.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(3);
    expect(enrichment.currentPage).toBe(1);
    expect(enrichment.totalPages).toBe(1);
  });

  it('echoes the applied filters, with an array of countries semicolon-joined', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: ['US', 'CN', 'ZW'],
      date_range: ' 2010:2023 ',
    });
    await worldbankGetData.handler(input, ctx);
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      indicatorId: 'NY.GDP.PCAP.CD',
      countries: 'US;CN;ZW',
      dateRange: '2010:2023',
      page: 1,
      perPage: 50,
    });
  });

  it('omits date_range and mrv from the filter echo when neither was requested', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'USA',
      per_page: 10,
    });
    await worldbankGetData.handler(input, ctx);
    expect(getEnrichment(ctx).appliedFilters).toEqual({
      indicatorId: 'NY.GDP.PCAP.CD',
      countries: 'USA',
      page: 1,
      perPage: 10,
    });
  });

  it('renders the applied-filters trailer as a labelled run of key=value pairs', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const render = worldbankGetData.enrichmentTrailer?.appliedFilters?.render;
    expect(
      render?.({ indicatorId: 'SP.POP.TOTL', countries: 'USA', mrv: 5, page: 2, perPage: 50 }),
    ).toBe(
      '**Applied Filters:** indicator_id=SP.POP.TOTL, countries=USA, mrv=5, page=2, per_page=50',
    );
  });

  it('sets enrichment notice on empty data', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockResolvedValue({
        ...mockDataResult,
        data: [],
        total: 0,
        nullCount: 0,
      }),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'US',
    });
    const result = await worldbankGetData.handler(input, ctx);
    expect(result.data).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('broaden');
  });

  it('accepts a single country string', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'SP.POP.TOTL',
      countries: 'US',
    });
    const result = await worldbankGetData.handler(input, ctx);
    expect(result.data).toBeDefined();
  });

  it('throws when both date_range and mrv are provided', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'US',
      date_range: '2020:2022',
      mrv: 3,
    });
    await expect(worldbankGetData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_params' },
    });
  });

  it('rethrows indicator_not_found via ctx.fail with recovery.hint', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Indicator "INVALID.ID" not found.', {
          reason: 'indicator_not_found',
          indicatorId: 'INVALID.ID',
        }),
      ),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'INVALID.ID',
      countries: 'US',
    });
    const err = await Promise.resolve(worldbankGetData.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      data: {
        reason: 'indicator_not_found',
        recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
      },
    });
  });

  it('rethrows country_not_found via ctx.fail with recovery.hint', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Invalid country code.', {
          reason: 'country_not_found',
          countryCodes: 'ZZ',
        }),
      ),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'ZZ',
    });
    const err = await Promise.resolve(worldbankGetData.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      data: {
        reason: 'country_not_found',
        recovery: { hint: expect.stringContaining('worldbank_list_countries') },
      },
    });
  });

  it('rethrows indicator_and_country_not_found via ctx.fail with recovery.hint', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Neither the indicator nor the codes are valid.', {
          reason: 'indicator_and_country_not_found',
          indicatorId: 'NOT.A.REAL.CODE',
          countryCodes: 'ZZZ',
        }),
      ),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NOT.A.REAL.CODE',
      countries: 'ZZZ',
    });
    const err = await Promise.resolve(worldbankGetData.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'indicator_and_country_not_found',
        recovery: { hint: expect.stringContaining('worldbank_list_countries') },
      },
    });
    expect((err as McpError).data?.recovery).toMatchObject({
      hint: expect.stringContaining('worldbank_search_indicators'),
    });
  });

  it('rethrows indicator_not_queryable via ctx.fail, pointing at search, not the country list', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.NotFound,
          'Indicator "SM.POP.REFG.OR" is catalogued under WDI Database Archives, but the data endpoint does not serve it.',
          {
            reason: 'indicator_not_queryable',
            indicatorId: 'SM.POP.REFG.OR',
            sourceNames: ['WDI Database Archives'],
          },
        ),
      ),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'SM.POP.REFG.OR',
      countries: 'SDN',
      mrv: 3,
    });
    const err = await Promise.resolve(worldbankGetData.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'indicator_not_queryable',
        indicatorId: 'SM.POP.REFG.OR',
        sourceNames: ['WDI Database Archives'],
        recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
      },
    });
    const data = (err as McpError).data ?? {};
    expect(data).not.toHaveProperty('countries');
    expect(JSON.stringify(data.recovery)).not.toContain('worldbank_list_countries');
  });

  it('delivers indicator_not_queryable on both error surfaces through the tool contract', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.NotFound,
            'Indicator "SM.POP.REFG.OR" is not served by the data endpoint for any country or date.',
            { reason: 'indicator_not_queryable', indicatorId: 'SM.POP.REFG.OR' },
          ),
        ),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const result = await runToolContract(
      worldbankGetData,
      { indicator_id: 'SM.POP.REFG.OR', countries: 'SDN' },
      { context: { errors: worldbankGetData.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'indicator_not_queryable',
          recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('SM.POP.REFG.OR');
    expect(text).toMatch(/Recovery:.*worldbank_search_indicators/);
    expect(text).not.toContain('SDN');
  });

  it('declares indicator_not_queryable in the error contract with a search recovery', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const entry = worldbankGetData.errors?.find((e) => e.reason === 'indicator_not_queryable');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(entry?.recovery).toContain('worldbank_search_indicators');
    expect(entry?.recovery).not.toContain('worldbank_list_countries');
  });

  it('notices that a dropped date_range matched nothing', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockResolvedValue({
        data: [],
        indicator: { id: 'SP.POP.TOTL', name: 'Population, total' },
        total: 0,
        page: 1,
        pages: 1,
        nullCount: 0,
        dateFilterDropped: true,
      }),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'SP.POP.TOTL',
      countries: 'KEN',
      date_range: '1850:1900',
    });
    const result = await worldbankGetData.handler(input, ctx);
    expect(result.data).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('1850:1900');
    expect(enrichment.notice).toContain('outside');
  });

  it('flags a page past the end rather than claiming the window matched nothing, on both surfaces', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockResolvedValue({
        data: [],
        indicator: { id: 'DP.DOD.DECD.CR.BC.CD', name: 'Gross PSD' },
        total: 12,
        page: 5,
        pages: 4,
        nullCount: 0,
        dateFilterDropped: true,
      }),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const result = await runToolContract(worldbankGetData, {
      indicator_id: 'DP.DOD.DECD.CR.BC.CD',
      countries: 'CHL',
      date_range: '2019:2021',
      page: 5,
      per_page: 3,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ totalCount: 12, currentPage: 5, totalPages: 4 });
    const notice = structured.notice as string;
    expect(notice).toMatch(
      /Page 5 is past the end of the results — 12 observations span 4 pages \(1–4\) at per_page=3/,
    );
    expect(notice).toMatch(/Keep the same filters and request a page from 1 to 4\./);
    expect(notice).not.toMatch(/No observations fall inside/);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('Page 5 is past the end of the results');
    expect(text).not.toContain('No observations fall inside');
  });

  it('keeps the zero-match wording for a window that matched nothing', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockResolvedValue({
        data: [],
        indicator: { id: 'SP.POP.TOTL', name: 'Population, total' },
        total: 0,
        page: 3,
        pages: 1,
        nullCount: 0,
        dateFilterDropped: true,
      }),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    await worldbankGetData.handler(
      worldbankGetData.input.parse({
        indicator_id: 'SP.POP.TOTL',
        countries: 'KEN',
        date_range: '1850:1900',
        page: 3,
      }),
      ctx,
    );
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No observations fall inside date_range "1850:1900"');
    expect(notice).not.toMatch(/past the end/);
  });

  it('returns empty data (no throw) when service returns no observations', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockResolvedValue({
        data: [],
        indicator: { id: 'NY.GDP.PCAP.CD', name: '' },
        total: 0,
        page: 1,
        pages: 1,
        nullCount: 0,
      }),
    } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'US',
      date_range: '1800:1801',
    });
    const result = await worldbankGetData.handler(input, ctx);
    expect(result.data).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('broaden');
  });

  it('formats all output fields including null values and iso3', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const domainResult = {
      data: mockDataResult.data,
      indicator: mockDataResult.indicator,
      nullCount: mockDataResult.nullCount,
    };
    const blocks = worldbankGetData.format!(domainResult);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    // Indicator fields
    expect(text).toContain('NY.GDP.PCAP.CD');
    expect(text).toContain('GDP per capita (current US$)');
    // Country with iso3
    expect(text).toContain('USA');
    expect(text).toContain('CHN');
    // Values
    expect(text).toContain('76399.42');
    // Null value rendered as "No data"
    expect(text).toContain('No data');
    // nullCount surfaced
    expect(text).toContain('Null values this page:**');
  });

  it('renders aggregate tag for aggregate rows', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const domainResult = {
      data: [
        {
          countryCode: 'EAS',
          countryIso3: '',
          countryName: 'East Asia & Pacific',
          date: '2022',
          value: 13500,
          obsStatus: '',
          isAggregate: true,
        },
      ],
      indicator: mockDataResult.indicator,
      nullCount: 0,
    };
    const blocks = worldbankGetData.format!(domainResult);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('[Aggregate]');
    expect(text).toContain('EAS');
  });

  it('handles sparse upstream payload with missing value', () => {
    // Sparse test: verify format handles null values without fabricating data
    const sparseResult = {
      data: [
        {
          countryCode: 'AF',
          countryIso3: 'AFG',
          countryName: 'Afghanistan',
          date: '2020',
          value: null,
          obsStatus: '',
          isAggregate: false,
        },
      ],
      indicator: mockDataResult.indicator,
      nullCount: 1,
    };
    const formatFn = (result: typeof sparseResult) => {
      const lines: string[] = [];
      for (const d of result.data) {
        const valStr = d.value !== null ? String(d.value) : 'No data';
        lines.push(valStr);
      }
      return lines.join('\n');
    };
    const rendered = formatFn(sparseResult);
    expect(rendered).toBe('No data');
    expect(rendered).not.toContain('0'); // must not fabricate 0 for null
  });

  // ─── Zod input validation ─────────────────────────────────────────────────

  /**
   * `/country/{codes}/indicator/all` answers the invalid-value envelope, and the
   * catalog lookup that places it finds rows for `all`, which blamed valid country
   * codes. `/` and `%` reach a path upstream answers with HTTP 404.
   */
  it.each([['a/b'], ['NY.GDP.PCAP.CD%3BSP.POP.TOTL'], ['NY.GDP.PCAP.CD;SP.POP.TOTL']])(
    'rejects indicator_id %j at the schema, pointing at the search tool',
    async (indicatorId) => {
      const { worldbankGetData } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
      );
      const parsed = worldbankGetData.input.safeParse({
        indicator_id: indicatorId,
        countries: 'US',
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('worldbank_search_indicators');
    },
  );

  it.each([['all'], ['ALL']])(
    'rejects indicator_id %j in the handler as multiple_indicators with its recovery on both surfaces',
    async (indicatorId) => {
      const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
      const getData = vi.fn().mockResolvedValue(mockDataResult);
      vi.mocked(getWorldBankApiService).mockReturnValue({ getData } as never);

      const { worldbankGetData } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
      );
      const result = await runToolContract(
        worldbankGetData,
        { indicator_id: indicatorId, countries: 'US', mrv: 1 },
        { context: { errors: worldbankGetData.errors } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'multiple_indicators',
            indicatorId,
            recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toMatch(/Recovery:.*worldbank_search_indicators/);
      expect(text).not.toContain('worldbank_list_countries');
      expect(getData).not.toHaveBeenCalled();
    },
  );

  it.each([['NY.GDP.PCAP.CD'], ['CoCA_fexp'], ['3.0.Rate75-25'], ['UNEMPSA_']])(
    'accepts the catalog indicator ID %j',
    async (indicatorId) => {
      const { worldbankGetData } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
      );
      expect(
        worldbankGetData.input.safeParse({ indicator_id: indicatorId, countries: 'US' }).success,
      ).toBe(true);
    },
  );

  it('advertises the indicator ID constraint as a JSON Schema pattern', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const property = z.toJSONSchema(worldbankGetData.input).properties?.indicator_id;
    const pattern = typeof property === 'object' ? property.pattern : undefined;
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern ?? '');
    expect(re.test('NY.GDP.PCAP.CD')).toBe(true);
    expect(['a/b', 'A%3BB'].some((id) => re.test(id))).toBe(false);
  });

  it('rejects empty indicator_id', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() => worldbankGetData.input.parse({ indicator_id: '', countries: 'US' })).toThrow();
  });

  it('rejects mrv below minimum (0)', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() =>
      worldbankGetData.input.parse({ indicator_id: 'NY.GDP.PCAP.CD', countries: 'US', mrv: 0 }),
    ).toThrow();
  });

  it('rejects mrv above maximum (101)', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() =>
      worldbankGetData.input.parse({ indicator_id: 'NY.GDP.PCAP.CD', countries: 'US', mrv: 101 }),
    ).toThrow();
  });

  it('accepts mrv at boundary values 1 and 100', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() =>
      worldbankGetData.input.parse({ indicator_id: 'NY.GDP.PCAP.CD', countries: 'US', mrv: 1 }),
    ).not.toThrow();
    expect(() =>
      worldbankGetData.input.parse({ indicator_id: 'NY.GDP.PCAP.CD', countries: 'US', mrv: 100 }),
    ).not.toThrow();
  });

  it('forwards an mrv above the former ceiling of 10 to the service', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const getDataMock = vi.fn().mockResolvedValue(mockDataResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({ getData: getDataMock } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'SP.POP.TOTL',
      countries: 'KEN',
      mrv: 60,
    });
    await worldbankGetData.handler(input, ctx);
    expect(getDataMock.mock.calls[0]?.[0].mrv).toBe(60);
  });

  it.each([
    [[]],
    [['']],
    [['  ']],
    [''],
    ['   '],
    [' ; '],
    [','],
    [' , ; , '],
    [[',']],
    [[';']],
    [[',', ' ; ', '']],
  ])('rejects an empty countries value: %j', async (countries) => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() => worldbankGetData.input.parse({ indicator_id: 'SP.POP.TOTL', countries })).toThrow(
      'Provide at least one country code',
    );
  });

  it('still accepts a populated countries value', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    for (const countries of ['US', 'all', 'ALL', ['all'], ['US', 'DE']]) {
      expect(() =>
        worldbankGetData.input.parse({ indicator_id: 'SP.POP.TOTL', countries }),
      ).not.toThrow();
    }
  });

  it.each([
    ['US,JP,KR', ['US', 'JP', 'KR'], 'US;JP;KR'],
    [' US , JP ', ['US', 'JP'], 'US;JP'],
    ['US,', ['US'], 'US'],
    ['US;JP', ['US', 'JP'], 'US;JP'],
    ['USA, CHN; DEU', ['USA', 'CHN', 'DEU'], 'USA;CHN;DEU'],
    [['US,', ''], ['US'], 'US'],
    [['US,JP', 'KR'], ['US', 'JP', 'KR'], 'US;JP;KR'],
    [['US', 'CN', 'ZW'], ['US', 'CN', 'ZW'], 'US;CN;ZW'],
    ['all', ['all'], 'all'],
  ])('splits countries %j into the codes sent upstream', async (countries, codes, echoed) => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const getDataMock = vi.fn().mockResolvedValue(mockDataResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({ getData: getDataMock } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({ indicator_id: 'NY.GDP.PCAP.CD', countries });
    await worldbankGetData.handler(input, ctx);

    expect(getDataMock).toHaveBeenCalledTimes(1);
    expect(getDataMock.mock.calls[0]?.[0].countries).toEqual(codes);
    expect(getEnrichment(ctx).appliedFilters).toMatchObject({ countries: echoed });
  });

  it('echoes split countries on both surfaces through the tool contract', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const result = await runToolContract(
      worldbankGetData,
      { indicator_id: 'NY.GDP.PCAP.CD', countries: 'US,JP,KR', mrv: 1 },
      { context: { errors: worldbankGetData.errors } },
    );
    expect(result.isError).toBeFalsy();
    const parsed = worldbankGetData.output
      .extend({ appliedFilters: z.object({ countries: z.string() }).passthrough() })
      .parse(result.structuredContent);
    expect(parsed.appliedFilters.countries).toBe('US;JP;KR');
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('countries=US;JP;KR');
    expect(text).not.toContain('US,JP,KR');
  });

  it.each([['all,US'], ['US;all'], [' ALL , us '], [['all', 'US']], [['US', 'all,JP']]])(
    'rejects "all" mixed with other codes as mixed_all_selector, on both surfaces: %j',
    async (countries) => {
      const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
      const getDataMock = vi.fn().mockResolvedValue(mockDataResult);
      vi.mocked(getWorldBankApiService).mockReturnValue({ getData: getDataMock } as never);

      const { worldbankGetData } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
      );
      // A recoverable mistake, so the schema lets it through to a declared reason.
      expect(
        worldbankGetData.input.safeParse({ indicator_id: 'NY.GDP.PCAP.CD', countries }).success,
      ).toBe(true);
      const result = await runToolContract(
        worldbankGetData,
        { indicator_id: 'NY.GDP.PCAP.CD', countries },
        { context: { errors: worldbankGetData.errors } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'mixed_all_selector',
            recovery: { hint: expect.stringContaining('"all" on its own') },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain('cannot be combined with other country codes');
      expect(text).toMatch(/Recovery:.*"all" on its own/);
      expect(text).not.toMatch(/"US" .*not valid|Country code\(s\)/);
      expect(getDataMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['2030:2020', '2030', '2020'],
    ['2020:2010', '2020', '2010'],
    ['2021Q4:2020Q1', '2021Q4', '2020Q1'],
    [' 2020m06:2020m01 ', '2020M06', '2020M01'],
  ])(
    'rejects the reversed date_range %j as reversed_date_range before any request, on both surfaces',
    async (date_range, start, end) => {
      const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
      const getDataMock = vi.fn().mockResolvedValue(mockDataResult);
      vi.mocked(getWorldBankApiService).mockReturnValue({ getData: getDataMock } as never);

      const { worldbankGetData } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
      );
      // Well-shaped, so the schema passes it to the handler's ordering check.
      expect(
        worldbankGetData.input.safeParse({
          indicator_id: 'SP.POP.TOTL',
          countries: 'US',
          date_range,
        }).success,
      ).toBe(true);
      const result = await runToolContract(
        worldbankGetData,
        { indicator_id: 'SP.POP.TOTL', countries: 'US', date_range },
        { context: { errors: worldbankGetData.errors } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'reversed_date_range',
            dateRange: date_range.trim(),
            recovery: { hint: expect.stringContaining('earliest period first') },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain(`${start} comes after ${end}`);
      expect(text).toMatch(/Recovery:.*earliest period first/);
      expect(getDataMock).not.toHaveBeenCalled();
    },
  );

  it('accepts a single-period range whose endpoints are equal', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const getDataMock = vi.fn().mockResolvedValue(mockDataResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({ getData: getDataMock } as never);
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const result = await runToolContract(
      worldbankGetData,
      { indicator_id: 'SP.POP.TOTL', countries: 'US', date_range: '2020Q2:2020Q2' },
      { context: { errors: worldbankGetData.errors } },
    );
    expect(result.isError).toBeFalsy();
    expect(getDataMock.mock.calls[0]?.[0].dateRange).toBe('2020Q2:2020Q2');
  });

  it('reports both date_range and mrv as invalid_params before checking the range order', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const result = await runToolContract(
      worldbankGetData,
      { indicator_id: 'SP.POP.TOTL', countries: 'US', date_range: '2020:2010', mrv: 5 },
      { context: { errors: worldbankGetData.errors } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_params' } },
    });
  });

  it('declares no error reason the handler cannot reach', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const source = worldbankGetData.handler.toString();
    for (const { reason } of worldbankGetData.errors ?? []) {
      expect(source).toContain(reason);
    }
  });

  it.each([
    '2020/2023',
    '20-2023',
    '202',
    '2020:202',
    'last five years',
    '2020Q5',
    '2020M13',
    '2020M3', // upstream rejects an unpadded month
    '2020Q1:2021', // upstream rejects a range mixing period types
    '2020:2021Q4',
  ])('rejects a malformed date_range: %s', async (date_range) => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() =>
      worldbankGetData.input.parse({
        indicator_id: 'SP.POP.TOTL',
        countries: 'US',
        date_range,
      }),
    ).toThrow();
  });

  it.each([
    '2020',
    '2010:2023',
    '  2010:2023  ',
    '',
    '   ',
    '2020Q1',
    '2020q1',
    '2020Q1:2021Q4',
    '2020M03',
    '2020m03',
    '2020M01:2020M06',
  ])('accepts a well-formed date_range: %j', async (date_range) => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() =>
      worldbankGetData.input.parse({
        indicator_id: 'SP.POP.TOTL',
        countries: 'US',
        date_range,
      }),
    ).not.toThrow();
  });

  it('rejects per_page above maximum (1001)', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() =>
      worldbankGetData.input.parse({
        indicator_id: 'NY.GDP.PCAP.CD',
        countries: 'US',
        per_page: 1001,
      }),
    ).toThrow();
  });

  it('rejects page below minimum (0)', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    expect(() =>
      worldbankGetData.input.parse({ indicator_id: 'NY.GDP.PCAP.CD', countries: 'US', page: 0 }),
    ).toThrow();
  });

  // ─── Handler edge cases ────────────────────────────────────────────────────

  it('trims whitespace from date_range before using it', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const getDataMock = vi.fn().mockResolvedValue(mockDataResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({ getData: getDataMock } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'US',
      date_range: '  2020:2022  ',
    });
    await worldbankGetData.handler(input, ctx);
    const callArgs = getDataMock.mock.calls[0]?.[0];
    expect(callArgs.dateRange).toBe('2020:2022');
  });

  it('treats whitespace-only date_range as absent', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const getDataMock = vi.fn().mockResolvedValue(mockDataResult);
    vi.mocked(getWorldBankApiService).mockReturnValue({ getData: getDataMock } as never);

    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetData.errors });
    const input = worldbankGetData.input.parse({
      indicator_id: 'NY.GDP.PCAP.CD',
      countries: 'US',
      date_range: '   ',
    });
    await worldbankGetData.handler(input, ctx);
    const callArgs = getDataMock.mock.calls[0]?.[0];
    expect(callArgs.dateRange).toBeUndefined();
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('format output never leaks env variable names or API keys', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const domainResult = {
      data: mockDataResult.data,
      indicator: mockDataResult.indicator,
      nullCount: mockDataResult.nullCount,
    };
    const blocks = worldbankGetData.format!(domainResult);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toMatch(/WORLDBANK_API/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/Authorization/i);
  });

  it('format renders obsStatus when non-empty', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const withStatus = {
      data: [{ ...usRow, obsStatus: 'E', value: 12345.67 }],
      indicator: mockDataResult.indicator,
      nullCount: 0,
    };
    const blocks = worldbankGetData.format!(withStatus);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('obs_status: E');
  });
});
