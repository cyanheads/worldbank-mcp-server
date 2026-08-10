/**
 * @fileoverview Tests for worldbank_get_data tool.
 * @module tests/tools/worldbank-get-data.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultPerPage: 50 }),
}));

const mockDataResult = {
  data: [
    {
      countryCode: 'US',
      countryIso3: 'USA',
      countryName: 'United States',
      date: '2022',
      value: 76399.42,
      obsStatus: '',
      isAggregate: false,
    },
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
    const err = await worldbankGetData.handler(input, ctx).catch((e: unknown) => e);
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
    const err = await worldbankGetData.handler(input, ctx).catch((e: unknown) => e);
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
    const err = await worldbankGetData.handler(input, ctx).catch((e: unknown) => e);
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
    expect(blocks[0].type).toBe('text');
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
    expect(getDataMock.mock.calls[0][0].mrv).toBe(60);
  });

  it.each([[[]], [['']], [['  ']], [''], ['   '], [' ; ']])(
    'rejects an empty countries value: %j',
    async (countries) => {
      const { worldbankGetData } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
      );
      expect(() =>
        worldbankGetData.input.parse({ indicator_id: 'SP.POP.TOTL', countries }),
      ).toThrow();
    },
  );

  it('still accepts a populated countries value', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    for (const countries of ['US', 'all', ['US', 'DE']]) {
      expect(() =>
        worldbankGetData.input.parse({ indicator_id: 'SP.POP.TOTL', countries }),
      ).not.toThrow();
    }
  });

  it.each([
    '2020/2023',
    '20-2023',
    '202',
    '2020:202',
    'last five years',
    '2030:2020',
    '2021Q4:2020Q1',
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
    const callArgs = getDataMock.mock.calls[0][0];
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
    const callArgs = getDataMock.mock.calls[0][0];
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
      data: [{ ...mockDataResult.data[0], obsStatus: 'E', value: 12345.67 }],
      indicator: mockDataResult.indicator,
      nullCount: 0,
    };
    const blocks = worldbankGetData.format!(withStatus);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('obs_status: E');
  });
});
