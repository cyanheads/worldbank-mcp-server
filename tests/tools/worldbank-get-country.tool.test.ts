/**
 * @fileoverview Tests for worldbank_get_country tool.
 * @module tests/tools/worldbank-get-country.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext({ errors: worldbankGetCountry.errors });
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
    const err = await Promise.resolve(worldbankGetCountry.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
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
    expect(blocks[0]?.type).toBe('text');
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

  it('rejects an injection-shaped country code at the schema, before the service', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    expect(worldbankGetCountry.input.safeParse({ country_code: "US'; DROP TABLE--" }).success).toBe(
      false,
    );
  });

  it('forwards a valid country code to the service unmodified', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    const getCountryMock = vi.fn().mockResolvedValue(mockCountry);
    vi.mocked(getWorldBankApiService).mockReturnValue({ getCountry: getCountryMock } as never);

    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetCountry.errors });
    await worldbankGetCountry.handler(worldbankGetCountry.input.parse({ country_code: 'us' }), ctx);
    expect(getCountryMock).toHaveBeenCalledWith('us', expect.anything());
  });

  // ─── Single-country lookups only ──────────────────────────────────────────

  /**
   * Every one of the 295 entities `/country` lists has a three-character ID and
   * a two-character ISO2 code, letters and digits only (`USA`/`US`, `WLD`/`1W`).
   * `all` fits that shape; it is a collection keyword, rejected in the handler
   * with a declared reason rather than by the pattern.
   */
  it.each([['US'], ['USA'], ['usa'], ['EAS'], ['WLD'], ['1W'], ['Z4']])(
    'accepts the single code %j',
    async (code) => {
      const { worldbankGetCountry } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
      );
      expect(worldbankGetCountry.input.safeParse({ country_code: code }).success).toBe(true);
    },
  );

  it.each([['USA;CAN'], ['USA,CAN'], ['US CA'], ['USAA'], ['U'], ['a/b']])(
    'rejects the malformed or multi-code selector %j at the schema',
    async (code) => {
      const { worldbankGetCountry } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
      );
      const parsed = worldbankGetCountry.input.safeParse({ country_code: code });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('worldbank_list_countries');
    },
  );

  it('advertises the single-code constraint as a JSON Schema pattern', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const property = z.toJSONSchema(worldbankGetCountry.input).properties?.country_code;
    const pattern = typeof property === 'object' ? property.pattern : undefined;
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern ?? '');
    expect(['USA', 'US', '1W', 'all'].every((code) => re.test(code))).toBe(true);
    expect(['USA;CAN', 'USA,CAN', 'USAA'].some((code) => re.test(code))).toBe(false);
  });

  /**
   * A schema rejection carries no declared reason, so `all` — the selector a
   * caller is most likely to try — is refused in the handler, where it reports
   * multiple_countries and the list tool, before any upstream request.
   */
  it.each([['all'], ['ALL'], ['All']])(
    'rejects %j in the handler as multiple_countries with its recovery on both surfaces',
    async (code) => {
      const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
      const getCountry = vi.fn().mockResolvedValue(mockCountry);
      vi.mocked(getWorldBankApiService).mockReturnValue({ getCountry } as never);

      const { worldbankGetCountry } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
      );
      const result = await runToolContract(
        worldbankGetCountry,
        { country_code: code },
        { context: { errors: worldbankGetCountry.errors } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'multiple_countries',
            countryCode: code,
            recovery: { hint: expect.stringContaining('worldbank_list_countries') },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain(`"${code}"`);
      expect(text).toMatch(/Recovery:.*worldbank_list_countries/);
      expect(getCountry).not.toHaveBeenCalled();
    },
  );

  it('returns a schema rejection naming the list tool for a multi-code selector', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const result = await runToolContract(
      worldbankGetCountry,
      { country_code: 'USA;CAN' },
      { context: { errors: worldbankGetCountry.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('worldbank_list_countries');
  });

  it('maps a selector the service resolves to several countries to multiple_countries', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getCountry: vi.fn().mockRejectedValue(
        validationError('Country code "XYZ" selects more than one country (CAN, USA).', {
          reason: 'multiple_countries',
          countryCode: 'XYZ',
          matchedIds: ['CAN', 'USA'],
        }),
      ),
    } as never);

    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    const result = await runToolContract(
      worldbankGetCountry,
      { country_code: 'XYZ' },
      { context: { errors: worldbankGetCountry.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'multiple_countries',
          countryCode: 'XYZ',
          matchedIds: ['CAN', 'USA'],
          recovery: { hint: expect.stringContaining('worldbank_list_countries') },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('(CAN, USA)');
    expect(text).toMatch(/Recovery:.*worldbank_list_countries/);
  });

  it('declares multiple_countries in the error contract', async () => {
    const { worldbankGetCountry } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-country.tool.js'
    );
    expect(worldbankGetCountry.errors?.map((e) => e.reason)).toEqual([
      'country_not_found',
      'multiple_countries',
    ]);
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
