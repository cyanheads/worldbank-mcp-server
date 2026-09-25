/**
 * @fileoverview Tests for worldbank_get_indicator tool.
 * @module tests/tools/worldbank-get-indicator.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: vi.fn(),
  initWorldBankApiService: vi.fn(),
}));

const mockIndicator = {
  id: 'NY.GDP.PCAP.CD',
  name: 'GDP per capita (current US$)',
  unit: 'US$',
  sourceId: '2',
  sourceName: 'World Development Indicators',
  sourceNote: 'GDP per capita is gross domestic product divided by midyear population.',
  sourceOrganization: 'World Bank national accounts data',
  topics: [
    { id: '3', name: 'Economy & Growth' },
    { id: '19', name: 'Private Sector' },
  ],
};

describe('worldbankGetIndicator', () => {
  beforeEach(async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockResolvedValue(mockIndicator),
    } as never);
  });

  it.each([
    ['indicator_not_found', JsonRpcErrorCode.NotFound],
    ['multiple_indicators', JsonRpcErrorCode.ValidationError],
  ] as const)("forwards the service's data on a %s re-throw", async (reason, code) => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(
        new McpError(code, `Rejected: ${reason}.`, {
          reason,
          indicatorId: 'NY.GDP.PCAP.CD',
          detail: 'upstream detail',
          retryable: false,
        }),
      ),
    } as never);
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const result = await runToolContract(worldbankGetIndicator, { indicator_id: 'NY.GDP.PCAP.CD' });

    expect(result.structuredContent).toMatchObject({
      error: {
        code,
        data: {
          reason,
          indicatorId: 'NY.GDP.PCAP.CD',
          detail: 'upstream detail',
          retryable: false,
          recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text.trimEnd()).toMatch(new RegExp(`\\(reason ${reason} · not retryable\\)$`));
  });

  it('returns indicator metadata', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetIndicator.errors });
    const input = worldbankGetIndicator.input.parse({ indicator_id: 'NY.GDP.PCAP.CD' });
    const result = await worldbankGetIndicator.handler(input, ctx);
    expect(result).toMatchObject({
      id: 'NY.GDP.PCAP.CD',
      name: 'GDP per capita (current US$)',
      unit: 'US$',
    });
    expect(result.topics).toHaveLength(2);
  });

  it('throws indicator_not_found for invalid ID', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Indicator "INVALID.ID" not found.', {
          reason: 'indicator_not_found',
          indicatorId: 'INVALID.ID',
        }),
      ),
    } as never);

    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetIndicator.errors });
    const input = worldbankGetIndicator.input.parse({ indicator_id: 'INVALID.ID' });
    await expect(worldbankGetIndicator.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'indicator_not_found' },
    });
  });

  it('populates recovery.hint via ctx.fail for indicator_not_found', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'Indicator "INVALID.ID" not found.', {
          reason: 'indicator_not_found',
          indicatorId: 'INVALID.ID',
        }),
      ),
    } as never);

    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const ctx = createMockContext({ errors: worldbankGetIndicator.errors });
    const input = worldbankGetIndicator.input.parse({ indicator_id: 'INVALID.ID' });
    const err = await Promise.resolve(worldbankGetIndicator.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      data: {
        reason: 'indicator_not_found',
        recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
      },
    });
  });

  it('formats all output fields including topics with IDs', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const blocks = worldbankGetIndicator.format!(mockIndicator);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('NY.GDP.PCAP.CD');
    expect(text).toContain('GDP per capita (current US$)');
    expect(text).toContain('US$');
    expect(text).toContain('World Development Indicators');
    expect(text).toContain('World Bank national accounts data');
    // Topics render with both name and ID
    expect(text).toContain('Economy & Growth (3)');
    expect(text).toContain('Private Sector (19)');
    expect(text).toContain('GDP per capita is gross domestic product');
  });

  // ─── Zod input validation ─────────────────────────────────────────────────

  it('rejects empty indicator_id', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    expect(() => worldbankGetIndicator.input.parse({ indicator_id: '' })).toThrow();
  });

  it('rejects missing indicator_id', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    expect(() => worldbankGetIndicator.input.parse({})).toThrow();
  });

  // ─── Single-indicator lookups only ────────────────────────────────────────

  /** All 29,544 catalog IDs use only letters, digits, `.`, `_`, and `-`; none is `all`. */
  it.each([
    ['NY.GDP.PCAP.CD'],
    ['CoCA_fexp'],
    ['1.1_YOUTH.LITERACY.RATE'],
    ['3.0.Rate75-25'],
    ['UNEMPSA_'],
    ['ny.gdp.pcap.cd'],
    ['allowance'],
  ])('accepts the single indicator ID %j', async (id) => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    expect(worldbankGetIndicator.input.safeParse({ indicator_id: id }).success).toBe(true);
  });

  it.each([['NY.GDP.PCAP.CD;SP.POP.TOTL'], ['NY.GDP.PCAP.CD,SP.POP.TOTL']])(
    'rejects the multi-ID selector %j at the schema',
    async (id) => {
      const { worldbankGetIndicator } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
      );
      const parsed = worldbankGetIndicator.input.safeParse({ indicator_id: id });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('worldbank_search_indicators');
    },
  );

  /**
   * An ID that escapes to `/` or `%` reaches a path upstream answers with HTTP
   * 404, and `?` with a 403; no catalog ID contains any of them.
   */
  it.each([['a/b'], ['NY.GDP.PCAP.CD%3BSP.POP.TOTL'], ['x?y'], ['GDP (current US$)'], ['NY GDP']])(
    'rejects %j, which uses characters no indicator ID contains',
    async (id) => {
      const { worldbankGetIndicator } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
      );
      const parsed = worldbankGetIndicator.input.safeParse({ indicator_id: id });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('worldbank_search_indicators');
    },
  );

  it('advertises the single-ID constraint as a JSON Schema pattern', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const property = z.toJSONSchema(worldbankGetIndicator.input).properties?.indicator_id;
    const pattern = typeof property === 'object' ? property.pattern : undefined;
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern ?? '');
    expect(['NY.GDP.PCAP.CD', 'CoCA_fexp', 'all'].every((id) => re.test(id))).toBe(true);
    expect(['A;B', 'A,B', 'a/b', 'A%3BB'].some((id) => re.test(id))).toBe(false);
  });

  /** `all` fits the character set; the handler refuses it with a declared reason. */
  it.each([['all'], ['ALL'], ['All']])(
    'rejects %j in the handler as multiple_indicators with its recovery on both surfaces',
    async (id) => {
      const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
      const getIndicator = vi.fn().mockResolvedValue(mockIndicator);
      vi.mocked(getWorldBankApiService).mockReturnValue({ getIndicator } as never);

      const { worldbankGetIndicator } = await import(
        '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
      );
      const result = await runToolContract(
        worldbankGetIndicator,
        { indicator_id: id },
        { context: { errors: worldbankGetIndicator.errors } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'multiple_indicators',
            indicatorId: id,
            recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
          },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain(`"${id}"`);
      expect(text).toMatch(/Recovery:.*worldbank_search_indicators/);
      expect(getIndicator).not.toHaveBeenCalled();
    },
  );

  it('maps a selector the service resolves to several indicators to multiple_indicators', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockRejectedValue(
        validationError('Indicator ID "XYZ" selects more than one indicator (A.B, C.D).', {
          reason: 'multiple_indicators',
          indicatorId: 'XYZ',
          matchedIds: ['A.B', 'C.D'],
        }),
      ),
    } as never);

    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const result = await runToolContract(
      worldbankGetIndicator,
      { indicator_id: 'XYZ' },
      { context: { errors: worldbankGetIndicator.errors } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'multiple_indicators',
          indicatorId: 'XYZ',
          matchedIds: ['A.B', 'C.D'],
          recovery: { hint: expect.stringContaining('worldbank_search_indicators') },
        },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('(A.B, C.D)');
    expect(text).toMatch(/Recovery:.*worldbank_search_indicators/);
  });

  it('declares multiple_indicators in the error contract', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    expect(worldbankGetIndicator.errors?.map((e) => e.reason)).toEqual([
      'indicator_not_found',
      'multiple_indicators',
    ]);
  });

  // ─── Provider prose ───────────────────────────────────────────────────────

  /** SE.PRM.INPT as the service normalizes it: the provider's `</br>` is now a line break. */
  const cleanedNote =
    'School survey.  Total score is the sum of whether a school has:   , Functional blackboard    - Pens, pencils, exercise books\n- Textbooks   - Fraction of students in class with a desk    - Used ICT in class and have access to ICT in the school.';

  it('renders a normalized multi-line source note identically on both surfaces', async () => {
    const { getWorldBankApiService } = await import('@/services/worldbank/worldbank-service.js');
    vi.mocked(getWorldBankApiService).mockReturnValue({
      getIndicator: vi.fn().mockResolvedValue({
        ...mockIndicator,
        id: 'SE.PRM.INPT',
        name: 'Basic Inputs',
        sourceNote: cleanedNote,
      }),
    } as never);

    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const result = await runToolContract(
      worldbankGetIndicator,
      { indicator_id: 'SE.PRM.INPT' },
      { context: { errors: worldbankGetIndicator.errors } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ sourceNote: cleanedNote });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(`**Description:**\n${cleanedNote}`);
    expect(text).toContain('exercise books\n- Textbooks');
    expect(text).not.toMatch(/<\/?br/i);
  });

  // ─── Format edge cases ────────────────────────────────────────────────────

  it('format omits Topics line when topics array is empty', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const noTopics = { ...mockIndicator, topics: [] };
    const blocks = worldbankGetIndicator.format!(noTopics);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Topics:');
  });

  it('format omits Unit line when unit is empty', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const noUnit = { ...mockIndicator, unit: '' };
    const blocks = worldbankGetIndicator.format!(noUnit);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Unit:');
  });

  it('format omits Organization line when sourceOrganization is empty', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const noOrg = { ...mockIndicator, sourceOrganization: '' };
    const blocks = worldbankGetIndicator.format!(noOrg);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Organization:');
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('format output never leaks env variable names or API keys', async () => {
    const { worldbankGetIndicator } = await import(
      '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js'
    );
    const blocks = worldbankGetIndicator.format!(mockIndicator);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toMatch(/WORLDBANK_API/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/Authorization/i);
  });
});
