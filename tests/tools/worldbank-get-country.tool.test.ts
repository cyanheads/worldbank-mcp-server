/**
 * @fileoverview Tests for worldbank_get_country tool.
 * @module tests/tools/worldbank-get-country.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

const mockCountry = {
  id: 'US',
  iso2: 'US',
  name: 'United States',
  region: { id: 'NAC', name: 'North America' },
  incomeLevel: { id: 'HIC', name: 'High income' },
  lendingType: 'Not classified',
  capitalCity: 'Washington D.C.',
  longitude: '-77.032',
  latitude: '38.8895',
  isAggregate: false,
};

describe('worldbankGetCountry', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockResolvedValue(mockCountry),
    } as never);
  });

  it('returns country metadata', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const ctx = createMockContext();
    const input = worldbankGetCountry.input.parse({ country_code: 'US' });
    const result = await worldbankGetCountry.handler(input, ctx);
    expect(result).toMatchObject({
      id: 'US',
      name: 'United States',
      isAggregate: false,
    });
    expect(result.region.id).toBe('NAC');
    expect(result.incomeLevel.id).toBe('HIC');
  });

  it('throws country_not_found for invalid code', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Country code "ZZ" not found.', {
          reason: 'country_not_found',
          countryCode: 'ZZ',
        }),
      ),
    } as never);

    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetCountry.errors });
    const input = worldbankGetCountry.input.parse({ country_code: 'ZZ' });
    await expect(worldbankGetCountry.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'country_not_found' },
    });
  });

  it('populates recovery.hint via ctx.fail for country_not_found', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Country code "ZZ" not found.', {
          reason: 'country_not_found',
          countryCode: 'ZZ',
        }),
      ),
    } as never);

    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetCountry.errors });
    const input = worldbankGetCountry.input.parse({ country_code: 'ZZ' });
    const err = await worldbankGetCountry.handler(input, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      data: {
        reason: 'country_not_found',
        recovery: { hint: expect.stringContaining('worldbank_list_countries') },
      },
    });
  });

  it('formats all output fields', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const blocks = worldbankGetCountry.format!(mockCountry);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('United States');
    expect(text).toContain('US');
    // region.id and region.name
    expect(text).toContain('North America');
    expect(text).toContain('NAC');
    // incomeLevel.id and incomeLevel.name
    expect(text).toContain('High income');
    expect(text).toContain('HIC');
    expect(text).toContain('Not classified');
    expect(text).toContain('Washington D.C.');
    expect(text).toContain('38.8895');
    expect(text).toContain('No'); // isAggregate: false
  });

  it('handles aggregate entries', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const aggregate = {
      ...mockCountry,
      id: 'EAS',
      name: 'East Asia & Pacific',
      region: { id: 'NA', name: 'Aggregates' },
      incomeLevel: { id: 'NA', name: 'Aggregates' },
      capitalCity: '',
      isAggregate: true,
    };
    const blocks = worldbankGetCountry.format!(aggregate);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Yes'); // isAggregate: true
    expect(text).toContain('EAS');
  });

  // ─── Zod input validation ─────────────────────────────────────────────────

  it('rejects empty country_code', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    expect(() => worldbankGetCountry.input.parse({ country_code: '' })).toThrow();
  });

  it('rejects missing country_code', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    expect(() => worldbankGetCountry.input.parse({})).toThrow();
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('passes injection-attempt country code to service log unmodified', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const getCountryMock = vi.fn().mockResolvedValue(mockCountry);
    vi.mocked(getWorldBankApiService).mockReturnValue({ getCountry: getCountryMock } as never);

    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetCountry.errors });
    // The tool should forward the raw input to the service without silently
    // sanitizing or truncating it — the service enforces validity.
    const injectionCode = "US'; DROP TABLE--";
    const input = worldbankGetCountry.input.parse({ country_code: injectionCode });
    await worldbankGetCountry.handler(input, ctx);
    expect(getCountryMock).toHaveBeenCalledWith(injectionCode, expect.anything());
  });

  it('format output never leaks env variable names or API keys', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const blocks = worldbankGetCountry.format!(mockCountry);
    const text = (blocks[0] as { text: string }).text;
    // No env variable names or patterns that look like API keys/tokens
    expect(text).not.toMatch(/WORLDBANK_API/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/Authorization/i);
  });

  // ─── Format edge cases ────────────────────────────────────────────────────

  it('format omits coordinates line when longitude/latitude are empty', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const sparseCountry = { ...mockCountry, longitude: '', latitude: '' };
    const blocks = worldbankGetCountry.format!(sparseCountry);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Coordinates');
  });

  it('format omits capital line when capitalCity is empty', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const sparseCountry = { ...mockCountry, capitalCity: '' };
    const blocks = worldbankGetCountry.format!(sparseCountry);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Capital:');
  });

  it('format renders N/A for empty lendingType', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const sparseCountry = { ...mockCountry, lendingType: '' };
    const blocks = worldbankGetCountry.format!(sparseCountry);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('N/A');
  });
});
