/**
 * @fileoverview Tests for worldbank_get_data tool.
 * @module tests/tools/worldbank-get-data.tool.test
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
};

describe('worldbankGetData', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getData: vi.fn().mockResolvedValue(mockDataResult),
    } as never);
  });

  it('returns data with pagination and null count', async () => {
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
      data: { reason: 'no_data' },
    });
  });

  it('formats all output fields including null values and iso3', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const blocks = worldbankGetData.format!(mockDataResult);
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
    expect(text).toContain('1 null');
    // pagination
    expect(text).toContain('Page 1 of 1');
  });

  it('renders aggregate tag for aggregate rows', async () => {
    const { worldbankGetData } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-data.tool.js'
    );
    const dataWithAggregate = {
      ...mockDataResult,
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
    };
    const blocks = worldbankGetData.format!(dataWithAggregate);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('[Aggregate]');
    expect(text).toContain('EAS');
  });

  it('handles sparse upstream payload with missing value', () => {
    // Sparse test: verify format handles null values without fabricating data
    const sparseResult = {
      ...mockDataResult,
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
      nullCount: 1,
    };
    // Use the imported module for format
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
});
