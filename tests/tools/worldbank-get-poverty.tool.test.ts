/**
 * @fileoverview Tests for worldbank_get_poverty — the fill_gaps default and its
 * echo, interpolation disclosure, country-code normalization, empty-result
 * notices, error mapping, and format() parity.
 * @module tests/tools/worldbank-get-poverty.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/pip/pip-service.js', () => ({
  getPipService: vi.fn(),
  initPipService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    pipBaseUrl: 'https://api.worldbank.org/pip/v1',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

/** A survey-derived row, carrying the full distributional block. */
const surveyRow = {
  countryCode: 'USA',
  countryName: 'United States',
  regionCode: 'NAC',
  regionName: 'North America',
  reportingYear: 2022,
  reportingLevel: 'national',
  welfareType: 'income',
  povertyLine: 3,
  headcount: 0.014,
  povertyGap: 0.0104,
  povertySeverity: 0.0087,
  watts: 0.0249,
  mean: 89.9496,
  median: 67.7236,
  gini: 0.417,
  mld: 0.3475,
  polarization: 0.3757,
  decileShares: [0.0169, 0.0339, 0.0452, 0.0564, 0.0687, 0.0829, 0.1005, 0.1241, 0.1623, 0.3091],
  population: 334017321,
  surveyYear: 2022,
  surveyAcronym: 'CPS-ASEC-LIS',
  estimationType: 'survey',
  isInterpolated: false,
};

/** A gap-filled row: poverty measures present, distributional block absent. */
const gapFilledRow = {
  ...surveyRow,
  countryCode: 'IND',
  countryName: 'India',
  reportingYear: 2019,
  gini: null,
  mld: null,
  polarization: null,
  decileShares: null,
  surveyYear: null,
  surveyAcronym: '',
  estimationType: 'interpolation',
  isInterpolated: true,
};

/** Stub the service with a fixed result and hand back the spy for assertions. */
async function stubService(result: Record<string, unknown>) {
  const { getPipService } = await import('@/services/pip/pip-service.js');
  const getPoverty = vi.fn().mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pages: 1,
    gapFilled: false,
    ...result,
  });
  vi.mocked(getPipService).mockReturnValue({ getPoverty } as never);
  return getPoverty;
}

/** Stub the service to reject with an McpError carrying a service-layer reason. */
async function stubServiceError(code: JsonRpcErrorCode, message: string, reason: string) {
  const { getPipService } = await import('@/services/pip/pip-service.js');
  vi.mocked(getPipService).mockReturnValue({
    getPoverty: vi.fn().mockRejectedValue(new McpError(code, message, { reason })),
  } as never);
}

async function loadTool() {
  const { worldbankGetPoverty } = await import(
    '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js'
  );
  return worldbankGetPoverty;
}

describe('worldbankGetPoverty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Survey year ──────────────────────────────────────────────────────────

  it('returns the inequality block for a survey year', async () => {
    await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext();
    const input = tool.input.parse({ countries: 'USA', year: '2022', poverty_line: 3 });
    const result = await tool.handler(input, ctx);

    expect(result.estimates).toHaveLength(1);
    expect(result.estimates[0]).toMatchObject({
      gini: 0.417,
      estimationType: 'survey',
      surveyYear: 2022,
      isInterpolated: false,
    });
    expect(result.estimates[0]?.decileShares).toHaveLength(10);
  });

  // ─── fill_gaps default and echo ───────────────────────────────────────────

  it('defaults fill_gaps to true and passes it to the service', async () => {
    const getPoverty = await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    const input = tool.input.parse({ countries: 'USA', year: '2022' });

    expect(input.fill_gaps).toBe(true);
    await tool.handler(input, createMockContext());
    expect(getPoverty.mock.calls[0]?.[0]).toMatchObject({ fillGaps: true });
  });

  it('echoes the applied fill_gaps value in appliedFilters', async () => {
    await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();

    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'USA', year: '2022' }), ctx);
    expect(getEnrichment(ctx)).toMatchObject({ appliedFilters: { fillGaps: true } });

    const explicit = createMockContext({ errors: tool.errors });
    await tool.handler(
      tool.input.parse({ countries: 'USA', year: '2022', fill_gaps: false }),
      explicit,
    );
    expect(getEnrichment(explicit)).toMatchObject({ appliedFilters: { fillGaps: false } });
  });

  it('echoes the page size actually used, caller-supplied or server default', async () => {
    const getPoverty = await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();

    const explicit = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'USA', per_page: 250 }), explicit);
    expect(getPoverty.mock.calls[0]?.[0]).toMatchObject({ perPage: 250 });
    expect(getEnrichment(explicit)).toMatchObject({ appliedFilters: { perPage: 250, page: 1 } });

    const fallback = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'USA', page: 3 }), fallback);
    expect(getEnrichment(fallback)).toMatchObject({ appliedFilters: { perPage: 50, page: 3 } });
  });

  it('omits povertyLine from appliedFilters when the upstream default was used', async () => {
    await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'USA', year: '2022' }), ctx);

    const enrichment = getEnrichment(ctx) as { appliedFilters: Record<string, unknown> };
    expect(enrichment.appliedFilters).not.toHaveProperty('povertyLine');
  });

  // ─── Interpolation disclosure ─────────────────────────────────────────────

  it('surfaces a notice explaining the null inequality fields on a gap-filled result', async () => {
    await stubService({ rows: [gapFilledRow], total: 1, gapFilled: true });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    const result = await tool.handler(tool.input.parse({ countries: 'IND', year: '2019' }), ctx);

    expect(result.estimates[0]).toMatchObject({
      gini: null,
      decileShares: null,
      surveyYear: null,
      estimationType: 'interpolation',
    });
    const enrichment = getEnrichment(ctx) as { notice?: string };
    expect(enrichment.notice).toMatch(/gap-filled/);
    expect(enrichment.notice).toMatch(/null by design/);
  });

  it('does not raise the gap-filled notice when every row came from a survey', async () => {
    await stubService({ rows: [surveyRow], total: 1, gapFilled: false });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'USA', year: '2022' }), ctx);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // ─── Multi-country batches ────────────────────────────────────────────────

  it('normalizes an array batch to a comma-joined echo', async () => {
    const getPoverty = await stubService({
      rows: [gapFilledRow, surveyRow],
      total: 2,
      gapFilled: true,
    });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: ['IND', 'USA', 'BRA'], year: '2019' }), ctx);

    expect(getPoverty.mock.calls[0]?.[0]).toMatchObject({ countries: ['IND', 'USA', 'BRA'] });
    expect(getEnrichment(ctx)).toMatchObject({
      appliedFilters: { countries: 'IND,USA,BRA' },
    });
  });

  it("splits a single string on either separator this server's tools use", async () => {
    const getPoverty = await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    await tool.handler(
      tool.input.parse({ countries: 'IND;USA, BRA', year: '2019' }),
      createMockContext(),
    );
    expect(getPoverty.mock.calls[0]?.[0]).toMatchObject({ countries: ['IND', 'USA', 'BRA'] });
  });

  // ─── Empty results ────────────────────────────────────────────────────────

  it('returns an empty result with a broadening notice under gap-filling', async () => {
    await stubService({ rows: [], total: 0 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    const result = await tool.handler(tool.input.parse({ countries: 'TWN', year: '1970' }), ctx);

    expect(result.estimates).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/not every economy in every year/);
  });

  it('points an empty survey-only result at fill_gaps', async () => {
    await stubService({ rows: [], total: 0 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'IND', year: '2019', fill_gaps: false }), ctx);
    expect(getEnrichment(ctx).notice).toMatch(/fill_gaps is false/);
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it('rejects malformed input at the schema, before any request goes out', async () => {
    const tool = await loadTool();
    // An empty country must not widen to every economy the way a bare separator would.
    expect(tool.input.safeParse({ countries: '' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: ',' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: [] }).success).toBe(false);
    // PIP reads an empty `country` as every economy, so separators-only must not pass.
    expect(tool.input.safeParse({ countries: [','] }).success).toBe(false);
    expect(tool.input.safeParse({ countries: [';', ' '] }).success).toBe(false);
    expect(tool.input.safeParse({ countries: ['', 'USA'] }).success).toBe(true);
    expect(tool.input.safeParse({ countries: 'USA', year: '20x2' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'USA', poverty_line: -1 }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'USA', poverty_line: 5000 }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'USA', welfare_type: 'wealth' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'USA', reporting_level: 'county' }).success).toBe(
      false,
    );
    expect(tool.input.safeParse({ countries: 'USA', year: 'MRV' }).success).toBe(true);
    expect(tool.input.safeParse({ countries: 'USA', year: 'all' }).success).toBe(true);
  });

  it('accepts blank optional fields from form-based clients as absent', async () => {
    const getPoverty = await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    const input = tool.input.parse({
      countries: 'USA',
      year: '',
      welfare_type: '',
      reporting_level: '',
    });
    await tool.handler(input, createMockContext());

    const sent = getPoverty.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('year');
    expect(sent).not.toHaveProperty('welfareType');
    expect(sent).not.toHaveProperty('reportingLevel');
  });

  // ─── Error mapping ────────────────────────────────────────────────────────

  it('maps country_not_found to a declared failure with a recovery hint', async () => {
    await stubServiceError(
      JsonRpcErrorCode.NotFound,
      'PIP does not recognize the country code(s) "ZZZ".',
      'country_not_found',
    );
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await expect(tool.handler(tool.input.parse({ countries: 'ZZZ' }), ctx)).rejects.toMatchObject({
      data: {
        reason: 'country_not_found',
        recovery: { hint: expect.stringContaining('worldbank_list_countries') },
      },
    });
  });

  it('maps invalid_parameter through the error contract', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ValidationError,
      'PIP rejected the value supplied for welfare_type.',
      'invalid_parameter',
    );
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await expect(tool.handler(tool.input.parse({ countries: 'USA' }), ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_parameter' },
    });
  });

  it('maps a PIP server error to upstream_unavailable', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ServiceUnavailable,
      'PIP returned HTTP 500 for country code(s) "WLD".',
      'upstream_unavailable',
    );
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await expect(tool.handler(tool.input.parse({ countries: 'WLD' }), ctx)).rejects.toMatchObject({
      data: {
        reason: 'upstream_unavailable',
        recovery: { hint: expect.stringContaining('individual economy codes') },
      },
    });
  });

  it('rethrows an unrecognized upstream error untouched', async () => {
    await stubServiceError(JsonRpcErrorCode.Timeout, 'Request timed out.', 'something_else');
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await expect(tool.handler(tool.input.parse({ countries: 'USA' }), ctx)).rejects.toMatchObject({
      data: { reason: 'something_else' },
    });
  });

  // ─── Rendering ────────────────────────────────────────────────────────────

  it('renders the poverty and inequality fields into content[]', async () => {
    const tool = await loadTool();
    const [block] =
      tool.format?.({ estimates: [surveyRow, gapFilledRow] }, createMockContext()) ?? [];
    const text = (block as { text: string }).text;

    expect(text).toContain('United States (USA) — 2022, national');
    expect(text).toContain('**gini:** 0.417');
    expect(text).toContain('0.0169, 0.0339');
    expect(text).toContain('**estimationType:** survey');
    expect(text).toContain('**gini:** null');
    expect(text).toContain('**decileShares:** null');
    expect(text).toContain('**estimationType:** interpolation');
  });

  it('renders an empty result without throwing', async () => {
    const tool = await loadTool();
    const [block] = tool.format?.({ estimates: [] }, createMockContext()) ?? [];
    expect((block as { text: string }).text).toContain('No estimates returned.');
  });
});
