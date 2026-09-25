/**
 * @fileoverview Tests for worldbank_get_poverty — the fill_gaps default and its
 * echo, interpolation disclosure, country-code normalization, empty-result
 * notices, error mapping, and format() parity.
 * @module tests/tools/worldbank-get-poverty.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  surveyComparability: 3,
  comparableSpell: '2019 - 2023',
  estimationType: 'survey',
  isInterpolated: false,
  isAggregate: false,
  popInPoverty: null,
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
  surveyComparability: null,
  comparableSpell: null,
  estimationType: 'interpolation',
  isInterpolated: true,
};

/** Stub the service with a fixed result and hand back the spy for assertions. */
async function stubService(result: Record<string, unknown>) {
  const { getPipService } = await import('@/services/pip/pip-service.js');
  // The service echoes the page size it served and the codes it queried; a stub
  // that neither caps nor respells echoes the request, uppercased.
  const getPoverty = vi
    .fn()
    .mockImplementation(async (opts: { perPage: number; countries: string[] }) => ({
      rows: [],
      total: 0,
      page: 1,
      pages: 1,
      perPage: opts.perPage,
      countries: opts.countries.map((code) => code.toUpperCase()),
      gapFilled: false,
      modelOnly: [],
      pppVersion: '2021',
      releaseVersion: '20260324',
      ...result,
    }));
  vi.mocked(getPipService).mockReturnValue({ getPoverty } as never);
  return getPoverty;
}

/** Stub the service to reject with an McpError carrying a service-layer reason and data. */
async function stubServiceError(
  code: JsonRpcErrorCode,
  message: string,
  reason: string,
  data: Record<string, unknown> = {},
) {
  const { getPipService } = await import('@/services/pip/pip-service.js');
  vi.mocked(getPipService).mockReturnValue({
    getPoverty: vi.fn().mockRejectedValue(new McpError(code, message, { reason, ...data })),
  } as never);
}

/** Every text block of a tool result, joined — the whole content[] surface. */
function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((block) => block.text ?? '').join('\n');
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
    const ctx = createMockContext({ errors: tool.errors });
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
    await tool.handler(input, createMockContext({ errors: tool.errors }));
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
      createMockContext({ errors: tool.errors }),
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

  it('flags a page past the end on both surfaces, echoing the page it was asked for', async () => {
    await stubService({ rows: [], total: 1, page: 2, pages: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      countries: 'IND',
      year: '2022',
      fill_gaps: false,
      page: 2,
      per_page: 1,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      estimates: [],
      totalCount: 1,
      currentPage: 2,
      totalPages: 1,
    });
    expect(structured.notice).toMatch(
      /Page 2 is past the end of the results — 1 estimate spans 1 page at per_page=1\. Keep the same filters and request page 1\./,
    );
    expect(structured.notice).not.toMatch(/No estimates for the requested filter/);
    expect(textOf(result)).toContain('Page 2 is past the end of the results');
  });

  // ─── Output budget ────────────────────────────────────────────────────────

  it('discloses a page reduced to the cap on both surfaces, with the size that continues it', async () => {
    const getPoverty = await stubService({
      rows: [surveyRow],
      total: 2584,
      page: 1,
      pages: 37,
      perPage: 70,
    });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      countries: 'all',
      year: 'all',
      fill_gaps: false,
      per_page: 1000,
    });

    expect(getPoverty.mock.calls[0]?.[0]).toMatchObject({ perPage: 1000 });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      appliedFilters: { perPage: 70, requestedPerPage: 1000 },
      totalCount: 2584,
      totalPages: 37,
    });
    const notice = structured.notice as string;
    expect(notice).toMatch(/per_page=1000 was reduced to 70, the most one page holds/);
    expect(notice).toMatch(/50 KB/);
    expect(notice).toMatch(
      /totalPages counts pages of 70, so page 2 with the same filters continues/,
    );
    const text = textOf(result);
    expect(text).toContain('per_page=70 (requested 1000)');
    expect(text).toContain('per_page=1000 was reduced to 70');
  });

  it('keeps the gap-filled caveat alongside the reduction', async () => {
    await stubService({ rows: [gapFilledRow], total: 500, pages: 8, perPage: 70, gapFilled: true });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'IND', per_page: 500 }), ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/per_page=500 was reduced to 70/);
    expect(notice).toMatch(/Some rows are gap-filled/);
  });

  it('echoes no requestedPerPage when the requested size fit', async () => {
    await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'USA', per_page: 70 }), ctx);

    const enrichment = getEnrichment(ctx) as { appliedFilters: Record<string, unknown> };
    expect(enrichment.appliedFilters).toMatchObject({ perPage: 70 });
    expect(enrichment.appliedFilters).not.toHaveProperty('requestedPerPage');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('keeps accepting per_page up to 1000 at the schema', async () => {
    const tool = await loadTool();
    expect(tool.input.safeParse({ countries: 'all', per_page: 1000 }).success).toBe(true);
  });

  it('reads limit as per_page, on both surfaces', async () => {
    const getPoverty = await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'USA', limit: 5 } as never);

    expect(result.isError).toBeFalsy();
    expect(getPoverty.mock.calls[0]?.[0]).toMatchObject({ perPage: 5 });
    expect(result.structuredContent).toMatchObject({ appliedFilters: { perPage: 5 } });
    expect(textOf(result)).toContain('per_page=5');
  });

  it('holds limit to the page cap exactly as per_page, disclosing the reduction', async () => {
    await stubService({ rows: [surveyRow], total: 200, page: 1, pages: 3, perPage: 70 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'all', limit: 1000 } as never);

    expect(result.structuredContent).toMatchObject({
      appliedFilters: { perPage: 70, requestedPerPage: 1000 },
    });
    expect(textOf(result)).toContain('per_page=1000 was reduced to 70');
  });

  it('rejects a limit past the per_page maximum under the per_page bound', async () => {
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'USA', limit: 5000 } as never);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(result)).toContain('per_page');
  });

  it('flags a page past the end at the page size limit asked for', async () => {
    await stubService({ rows: [], total: 1, page: 2, pages: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'IND', page: 2, limit: 1 } as never);

    expect((result.structuredContent as { notice: string }).notice).toMatch(
      /Page 2 is past the end of the results — 1 estimate spans 1 page at per_page=1\./,
    );
  });

  it('still rejects limit sent alongside per_page', async () => {
    await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      countries: 'USA',
      per_page: 10,
      limit: 5,
    } as never);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(result)).toContain('limit');
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
    await tool.handler(input, createMockContext({ errors: tool.errors }));

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
      'PIP returned HTTP 500 for country code(s) "KEN", with no detail on the cause.',
      'upstream_unavailable',
    );
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await expect(tool.handler(tool.input.parse({ countries: 'KEN' }), ctx)).rejects.toMatchObject({
      data: {
        reason: 'upstream_unavailable',
        recovery: { hint: expect.stringContaining('retry the same request') },
      },
    });
  });

  it.each([
    ['country_not_found', JsonRpcErrorCode.NotFound],
    ['invalid_parameter', JsonRpcErrorCode.ValidationError],
    ['ppp_version_unavailable', JsonRpcErrorCode.ValidationError],
    ['upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable],
  ] as const)(
    'keeps the reason, its recovery, and the queried countries on a %s re-throw',
    async (reason, code) => {
      await stubServiceError(code, `PIP failed with ${reason}.`, reason);
      const tool = await loadTool();
      const result = await runToolContract(tool, { countries: 'KEN;UGA' });

      const error = (result.structuredContent as { error: { code: number; data: object } }).error;
      expect(error.code).toBe(code);
      expect(error.data).toMatchObject({
        reason,
        countries: ['KEN', 'UGA'],
        recovery: { hint: expect.any(String) },
      });
      expect(textOf(result)).toContain(`(reason ${reason}`);
    },
  );

  it('forwards the status of a PIP server error and leaves it retryable', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ServiceUnavailable,
      'PIP returned HTTP 503 for country code(s) "KEN".',
      'upstream_unavailable',
      { countryCodes: 'KEN', status: 503 },
    );
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'KEN' });

    const data = (result.structuredContent as { error: { data: Record<string, unknown> } }).error
      .data;
    expect(data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 503,
      countryCodes: 'KEN',
    });
    expect(data).not.toHaveProperty('retryable');
    expect(textOf(result).trimEnd()).toMatch(/\(reason upstream_unavailable\)$/);
  });

  it('lets the recovery the tool chooses win over any recovery in the service data', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ValidationError,
      'PIP rejected the value supplied for year.',
      'invalid_parameter',
      { parameters: ['year'], recovery: { hint: 'stale service hint' } },
    );
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'KEN', year: '1950' });

    const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
      .error.data.recovery.hint;
    expect(hint).not.toBe('stale service hint');
  });

  it('rethrows an unrecognized upstream error untouched', async () => {
    await stubServiceError(JsonRpcErrorCode.Timeout, 'Request timed out.', 'something_else');
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await expect(tool.handler(tool.input.parse({ countries: 'USA' }), ctx)).rejects.toMatchObject({
      data: { reason: 'something_else' },
    });
  });

  // ─── PPP vintage ──────────────────────────────────────────────────────────

  it('forwards ppp_version to the service and reads a blank one as absent', async () => {
    const getPoverty = await stubService({ rows: [surveyRow], total: 1 });
    const tool = await loadTool();

    await tool.handler(
      tool.input.parse({ countries: 'IND', ppp_version: '2017' }),
      createMockContext({ errors: tool.errors }),
    );
    expect(getPoverty.mock.calls[0]?.[0]).toMatchObject({ pppVersion: '2017' });

    await tool.handler(
      tool.input.parse({ countries: 'IND', ppp_version: '' }),
      createMockContext({ errors: tool.errors }),
    );
    expect(getPoverty.mock.calls[1]?.[0]).not.toHaveProperty('pppVersion');
  });

  it('accepts only a four-digit vintage year at the schema', async () => {
    const tool = await loadTool();
    expect(tool.input.safeParse({ countries: 'IND', ppp_version: '2021' }).success).toBe(true);
    expect(tool.input.safeParse({ countries: 'IND', ppp_version: '17' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'IND', ppp_version: '2017 PPP' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'IND', ppp_version: 2017 }).success).toBe(false);
  });

  it('echoes the resolved vintage and release on both surfaces, requested or not', async () => {
    await stubService({
      rows: [surveyRow],
      total: 1,
      pppVersion: '2017',
      releaseVersion: '20260324',
    });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'USA', year: '2022' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { pppVersion: '2017', releaseVersion: '20260324' },
    });
    expect(textOf(result)).toContain('ppp_version=2017');
    expect(textOf(result)).toContain('release_version=20260324');
  });

  it('maps ppp_version_unavailable to a declared failure with a recovery hint on both surfaces', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ValidationError,
      "PPP vintage 2011 is not available: PIP's current data release (20260324) is published at PPP vintages 2021, 2017.",
      'ppp_version_unavailable',
    );
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'USA', ppp_version: '2011' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'ppp_version_unavailable',
          recovery: { hint: expect.stringContaining('omit ppp_version') },
        },
      },
    });
    expect(textOf(result)).toMatch(/2021, 2017/);
    expect(textOf(result)).toMatch(/Recovery:.*omit ppp_version/);
  });

  // ─── Survey comparability ─────────────────────────────────────────────────

  it('carries survey comparability on both surfaces, null on a gap-filled row', async () => {
    await stubService({ rows: [surveyRow, gapFilledRow], total: 2, gapFilled: true });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: ['USA', 'IND'] });

    const estimates = (result.structuredContent as { estimates: Array<Record<string, unknown>> })
      .estimates;
    expect(estimates.map((row) => [row.surveyComparability, row.comparableSpell])).toEqual([
      [3, '2019 - 2023'],
      [null, null],
    ]);
    const text = textOf(result);
    expect(text).toContain('**surveyComparability:** 3 | **comparableSpell:** 2019 - 2023');
    expect(text).toContain('**surveyComparability:** null | **comparableSpell:** null');
  });

  // ─── Rendering ────────────────────────────────────────────────────────────

  it('renders the poverty and inequality fields into content[]', async () => {
    const tool = await loadTool();
    const [block] = tool.format?.({ estimates: [surveyRow, gapFilledRow] }) ?? [];
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
    const [block] = tool.format?.({ estimates: [] }) ?? [];
    expect((block as { text: string }).text).toContain('No estimates returned.');
  });
});
