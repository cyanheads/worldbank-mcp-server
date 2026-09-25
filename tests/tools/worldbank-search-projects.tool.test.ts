/**
 * @fileoverview Tests for worldbank_search_projects — ISO2 enforcement in the
 * handler, country-code normalization and the applied-filter echo, the abstract
 * opt-in, the three empty-result notices the zero-hit probe distinguishes,
 * error mapping, and format() parity.
 * @module tests/tools/worldbank-search-projects.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/projects/projects-service.js', () => ({
  getProjectsService: vi.fn(),
  initProjectsService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    pipBaseUrl: 'https://api.worldbank.org/pip/v1',
    projectsBaseUrl: 'https://search.worldbank.org/api/v3',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

/** A fully-populated project, as the service normalizes one. */
const project = {
  id: 'P513080',
  name: 'MPA Phase III - Progestão Sergipe: Public Sector Management Efficiency Project',
  status: 'Active',
  countryCodes: ['BR'],
  countryName: 'Federative Republic of Brazil',
  regionName: 'Latin America and Caribbean',
  boardApprovalDate: '2026-03-30',
  closingDate: '2031-12-19',
  totalCommitment: 41_800_000,
  financialTypes: ['IBRD', 'Other'],
  majorSectors: ['Public Administration', 'Education'],
  abstract: null as string | null,
  url: 'https://projects.worldbank.org/en/projects-operations/project-detail/P513080',
};

/** A sparse project: the portfolio publishes no amount, closing date, or sectors for it. */
const sparseProject = {
  ...project,
  id: 'P072339',
  name: 'African Distance Learning Multi-Country Credit',
  status: 'Dropped',
  countryCodes: [] as string[],
  countryName: 'Other',
  regionName: 'Other',
  closingDate: null,
  totalCommitment: null,
  financialTypes: [] as string[],
  majorSectors: [] as string[],
  url: 'https://projects.worldbank.org/en/projects-operations/project-detail/P072339',
};

/** Stub the service with a fixed result and hand back the spy for assertions. */
async function stubService(result: Record<string, unknown>) {
  const { getProjectsService } = await import('@/services/projects/projects-service.js');
  // The service echoes the page size it served; a stub that doesn't cap echoes the request.
  const searchProjects = vi.fn().mockImplementation(async (opts: { perPage: number }) => ({
    projects: [],
    total: 0,
    page: 1,
    pages: 1,
    perPage: opts.perPage,
    countryOnlyTotal: null,
    ...result,
  }));
  vi.mocked(getProjectsService).mockReturnValue({ searchProjects } as never);
  return searchProjects;
}

/** Stub the service to reject with an McpError carrying a service-layer reason and data. */
async function stubServiceError(
  code: JsonRpcErrorCode,
  message: string,
  reason: string,
  data: Record<string, unknown> = {},
) {
  const { getProjectsService } = await import('@/services/projects/projects-service.js');
  vi.mocked(getProjectsService).mockReturnValue({
    searchProjects: vi.fn().mockRejectedValue(new McpError(code, message, { reason, ...data })),
  } as never);
}

/** Every text block of a tool result, joined — the whole content[] surface. */
function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((block) => block.text ?? '').join('\n');
}

async function loadTool() {
  const { worldbankSearchProjects } = await import(
    '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js'
  );
  return worldbankSearchProjects;
}

describe('worldbankSearchProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Results ──────────────────────────────────────────────────────────────

  it('returns the projects the service resolved', async () => {
    await stubService({ projects: [project, sparseProject], total: 2 });
    const tool = await loadTool();
    const result = await tool.handler(
      tool.input.parse({ query: 'climate', countries: 'BR' }),
      createMockContext({ errors: tool.errors }),
    );

    expect(result.projects).toHaveLength(2);
    expect(result.projects[0]).toMatchObject({ id: 'P513080', totalCommitment: 41_800_000 });
    expect(result.projects[1]).toMatchObject({ totalCommitment: null, majorSectors: [] });
  });

  // ─── Country codes ────────────────────────────────────────────────────────

  it.each([
    ['BRA', ['BRA']],
    [
      ['BRA', 'IND'],
      ['BRA', 'IND'],
    ],
    ['BR,IND', ['IND']],
    ['B', ['B']],
    ['B-', ['B-']],
  ])(
    'rejects countries=%j as invalid_country_code before any request, on both surfaces',
    async (countries, invalidCodes) => {
      const searchProjects = await stubService({ projects: [project], total: 1 });
      const tool = await loadTool();

      // Shape-valid, so the schema lets it through to the handler's code check.
      expect(tool.input.safeParse({ countries }).success).toBe(true);
      const result = await runToolContract(tool, { countries });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_country_code',
            invalidCodes,
            recovery: { hint: expect.stringContaining('worldbank_get_country') },
          },
        },
      });
      const text = textOf(result);
      expect(text).toContain(`"${invalidCodes.join(', ')}"`);
      expect(text).toMatch(/ISO2/);
      expect(text).toMatch(/Recovery:.*worldbank_get_country/);
      expect(searchProjects).not.toHaveBeenCalled();
    },
  );

  it('accepts the digit-bearing regional codes the portfolio files multi-country operations under', async () => {
    const tool = await loadTool();

    // 3A (Africa), 4E (East Asia and Pacific), 1W (World) are real filter values
    // — a letters-only rule would make them unreachable.
    for (const code of ['3A', '4E', '7E', '8S', '1W', 'E2', 'P3']) {
      expect(tool.input.safeParse({ countries: code }).success).toBe(true);
    }
    expect(tool.input.safeParse({ countries: 'BR,3A' }).success).toBe(true);

    const searchProjects = await stubService({ projects: [project], total: 1 });
    await tool.handler(
      tool.input.parse({ countries: '3a' }),
      createMockContext({ errors: tool.errors }),
    );
    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ countryCodes: ['3a'] });
  });

  it("splits a single string on either separator this server's tools use", async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    await tool.handler(
      tool.input.parse({ countries: 'br; in, ZA' }),
      createMockContext({ errors: tool.errors }),
    );

    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({
      countryCodes: ['br', 'in', 'ZA'],
    });
  });

  it('reads a blank countries value as no country filter rather than an error', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();

    expect(tool.input.safeParse({ countries: '' }).success).toBe(true);
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: '' }), ctx);

    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ countryCodes: [] });
    const enrichment = getEnrichment(ctx) as { appliedFilters: Record<string, unknown> };
    expect(enrichment.appliedFilters).not.toHaveProperty('countries');
  });

  it('echoes country codes uppercased and comma-joined', async () => {
    await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: ['br', 'in'] }), ctx);

    expect(getEnrichment(ctx)).toMatchObject({ appliedFilters: { countries: 'BR,IN' } });
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it('rejects values outside the closed sets the portfolio publishes', async () => {
    const tool = await loadTool();

    expect(tool.input.safeParse({ status: ['Active', 'Pipeline'] }).success).toBe(true);
    expect(tool.input.safeParse({ status: ['active'] }).success).toBe(false);
    expect(tool.input.safeParse({ status: ['Completed'] }).success).toBe(false);
    expect(tool.input.safeParse({ region: ['South Asia'] }).success).toBe(true);
    expect(tool.input.safeParse({ region: ['Sub-Saharan Africa'] }).success).toBe(false);
    expect(tool.input.safeParse({ approved_from: '2020-01-01' }).success).toBe(true);
    expect(tool.input.safeParse({ approved_from: '2020' }).success).toBe(false);
    expect(tool.input.safeParse({ approved_to: '01/01/2020' }).success).toBe(false);
    expect(tool.input.safeParse({ per_page: 1001 }).success).toBe(false);
    expect(tool.input.safeParse({ page: 0 }).success).toBe(false);
  });

  it('accepts blank optional fields from form-based clients as absent', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    await tool.handler(
      tool.input.parse({ query: '   ', approved_from: '', approved_to: '' }),
      createMockContext({ errors: tool.errors }),
    );

    const sent = searchProjects.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('query');
    expect(sent).not.toHaveProperty('approvedFrom');
    expect(sent).not.toHaveProperty('approvedTo');
  });

  // ─── Board approval window ────────────────────────────────────────────────

  it('passes a one-sided window and a single-day inclusive window through', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();

    await tool.handler(
      tool.input.parse({ approved_from: '2020-01-01' }),
      createMockContext({ errors: tool.errors }),
    );
    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ approvedFrom: '2020-01-01' });
    expect(searchProjects.mock.calls[0]?.[0]).not.toHaveProperty('approvedTo');

    await tool.handler(
      tool.input.parse({ approved_to: '2024-02-29' }),
      createMockContext({ errors: tool.errors }),
    );
    expect(searchProjects.mock.calls[1]?.[0]).toMatchObject({ approvedTo: '2024-02-29' });

    await tool.handler(
      tool.input.parse({ approved_from: '2021-06-30', approved_to: '2021-06-30' }),
      createMockContext({ errors: tool.errors }),
    );
    expect(searchProjects.mock.calls[2]?.[0]).toMatchObject({
      approvedFrom: '2021-06-30',
      approvedTo: '2021-06-30',
    });
  });

  it.each([
    ['approved_from', '2020-13-01'],
    ['approved_from', '2020-00-15'],
    ['approved_to', '0000-00-00'],
    ['approved_from', '2020-02-30'],
    ['approved_to', '2023-02-29'],
    ['approved_from', '2021-04-31'],
  ])('rejects %s=%s as invalid_date before any request, on both surfaces', async (field, value) => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();

    // Shape-valid, so the schema lets it through to the handler's calendar check.
    expect(tool.input.safeParse({ [field]: value }).success).toBe(true);
    const result = await runToolContract(tool, { [field]: value });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_date',
          field,
          value,
          recovery: { hint: expect.stringContaining('YYYY-MM-DD') },
        },
      },
    });
    const text = textOf(result);
    expect(text).toContain(`${field} "${value}"`);
    expect(text).toMatch(/Recovery:.*YYYY-MM-DD/);
    expect(searchProjects).not.toHaveBeenCalled();
  });

  it('rejects approved_from after approved_to as reversed_date_range, on both surfaces', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      approved_from: '2025-01-01',
      approved_to: '2020-01-01',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'reversed_date_range',
          approvedFrom: '2025-01-01',
          approvedTo: '2020-01-01',
          recovery: { hint: expect.stringContaining('on or before') },
        },
      },
    });
    expect(textOf(result)).toMatch(/approved_from "2025-01-01" is after approved_to "2020-01-01"/);
    expect(textOf(result)).toMatch(/Recovery:.*on or before/);
    expect(searchProjects).not.toHaveBeenCalled();
  });

  it('checks the calendar before the ordering, so a bad date is not reported as reversed', async () => {
    await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      approved_from: '2025-02-30',
      approved_to: '2020-01-01',
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_date', field: 'approved_from' } },
    });
  });

  // ─── Abstract opt-in ──────────────────────────────────────────────────────

  it('leaves abstracts out by default and echoes the applied choice', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const input = tool.input.parse({ countries: 'BR' });

    expect(input.include_abstract).toBe(false);
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(input, ctx);

    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ includeAbstract: false });
    expect(getEnrichment(ctx)).toMatchObject({ appliedFilters: { includeAbstract: false } });

    const opted = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR', include_abstract: true }), opted);
    expect(getEnrichment(opted)).toMatchObject({ appliedFilters: { includeAbstract: true } });
  });

  // ─── Applied-filter echo and pagination ───────────────────────────────────

  it('echoes every filter it sent and the page size actually used', async () => {
    const searchProjects = await stubService({ projects: [project], total: 61, pages: 2 });
    const tool = await loadTool();

    const explicit = createMockContext({ errors: tool.errors });
    await tool.handler(
      tool.input.parse({
        query: 'climate',
        countries: 'BR',
        status: ['Active'],
        region: ['Latin America and Caribbean'],
        approved_from: '2020-01-01',
        approved_to: '2024-12-31',
        page: 2,
        per_page: 40,
      }),
      explicit,
    );

    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ perPage: 40, page: 2 });
    expect(getEnrichment(explicit)).toMatchObject({
      appliedFilters: {
        query: 'climate',
        countries: 'BR',
        status: 'Active',
        region: 'Latin America and Caribbean',
        approvedFrom: '2020-01-01',
        approvedTo: '2024-12-31',
        page: 2,
        perPage: 40,
      },
      totalCount: 61,
      totalPages: 2,
    });

    const fallback = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR' }), fallback);
    expect(getEnrichment(fallback)).toMatchObject({ appliedFilters: { perPage: 50, page: 1 } });
  });

  it('omits filters the caller did not supply from the echo', async () => {
    await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR' }), ctx);

    const enrichment = getEnrichment(ctx) as { appliedFilters: Record<string, unknown> };
    for (const key of ['query', 'status', 'region', 'approvedFrom', 'approvedTo']) {
      expect(enrichment.appliedFilters).not.toHaveProperty(key);
    }
  });

  // ─── Empty results ────────────────────────────────────────────────────────

  it('says so when the country filter matches nothing on its own', async () => {
    await stubService({ projects: [], total: 0, countryOnlyTotal: 0 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    const result = await tool.handler(tool.input.parse({ countries: 'qq' }), ctx);

    expect(result.projects).toEqual([]);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/No project carries country code\(s\) QQ/);
    expect(notice).toMatch(/ISO2/);
    expect(notice).toMatch(/no World Bank lending history/);
  });

  it('blames the other filters when the country codes match on their own', async () => {
    await stubService({ projects: [], total: 0, countryOnlyTotal: 1946 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(
      tool.input.parse({
        countries: ['BR', 'IN'],
        status: ['Pipeline'],
        approved_from: '1970-01-01',
      }),
      ctx,
    );

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/BR, IN match 1946 projects with every other filter removed/);
    expect(notice).toMatch(/status, approved_from/);
  });

  it('says the probe count covers the codes jointly when more than one is in force', async () => {
    const tool = await loadTool();

    // The probe asks the codes as one OR-set, so a positive count proves the set
    // matches — BR alone can carry it while a bogus sibling matches nothing.
    await stubService({ projects: [], total: 0, countryOnlyTotal: 831 });
    const many = createMockContext({ errors: tool.errors });
    await tool.handler(
      tool.input.parse({ countries: ['BR', 'QQ'], approved_from: '2030-01-01' }),
      many,
    );
    expect(getEnrichment(many).notice).toMatch(/codes combined.*re-run with a single code/);

    // A single code needs no such caveat — the count settles it outright.
    await stubService({ projects: [], total: 0, countryOnlyTotal: 831 });
    const one = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR', approved_from: '2030-01-01' }), one);
    expect(getEnrichment(one).notice).not.toMatch(/codes combined/);
  });

  it('names the country filter too when there is no probe count to lean on', async () => {
    // The probe can also come back null because it failed, so the fallback notice
    // must not silently drop the country filter from what it says was applied.
    await stubService({ projects: [], total: 0, countryOnlyTotal: null });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR', status: ['Pipeline'] }), ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/No project matches this search/);
    expect(notice).toMatch(/countries, status were applied/);
  });

  it('explains an empty result that had no country filter to probe', async () => {
    await stubService({ projects: [], total: 0, countryOnlyTotal: null });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ query: 'zzzqqqnotarealword' }), ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/No project matches this search/);
    // One applied filter, so the sentence has to read as singular.
    expect(notice).toMatch(/query was applied/);
  });

  it('flags a page requested past the end of the results', async () => {
    await stubService({ projects: [], total: 18, page: 900, pages: 18 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR', page: 900 }), ctx);

    expect(getEnrichment(ctx).notice).toMatch(
      /Page 900 is past the end.*18 projects span 18 pages/,
    );
  });

  // ─── Output budget ────────────────────────────────────────────────────────

  it('discloses a page reduced to the abstract cap on both surfaces, with the size that continues it', async () => {
    const searchProjects = await stubService({
      projects: [{ ...project, abstract: 'Rehabilitation of the dam.' }],
      total: 28_113,
      page: 1,
      pages: 3515,
      perPage: 8,
    });
    const tool = await loadTool();
    const result = await runToolContract(tool, { per_page: 1000, include_abstract: true });

    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({
      perPage: 1000,
      includeAbstract: true,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      appliedFilters: { perPage: 8, requestedPerPage: 1000, includeAbstract: true },
      totalCount: 28_113,
      totalPages: 3515,
    });
    const notice = structured.notice as string;
    expect(notice).toMatch(/per_page=1000 was reduced to 8/);
    expect(notice).toMatch(/80 with include_abstract off/);
    expect(notice).toMatch(/50 KB/);
    expect(notice).toMatch(
      /totalPages counts pages of 8, so page 2 with the same filters continues/,
    );
    expect(notice).toMatch(/Abstracts are never shortened/);
    const text = textOf(result);
    expect(text).toContain('per_page=8 (requested 1000)');
    expect(text).toContain('per_page=1000 was reduced to 8');
  });

  it('holds the server default to the same cap', async () => {
    await stubService({ projects: [project], total: 100, pages: 13, perPage: 8 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ include_abstract: true }), ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ appliedFilters: { perPage: 8, requestedPerPage: 50 } });
    expect(enrichment.notice).toMatch(/per_page=50 was reduced to 8/);
  });

  it('keeps the page-past-end notice alongside the reduction', async () => {
    await stubService({ projects: [], total: 100, page: 90, pages: 2, perPage: 80 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ page: 90, per_page: 1000 }), ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(
      /^Page 90 is past the end of the results — 100 projects span 2 pages \(1–2\) at per_page=80\./,
    );
    expect(notice).toMatch(/per_page=1000 was reduced to 80, the most one page holds/);
    expect(notice).not.toMatch(/include_abstract off/);
  });

  it('echoes no requestedPerPage when the requested size fit', async () => {
    await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ per_page: 80 }), ctx);

    const enrichment = getEnrichment(ctx) as { appliedFilters: Record<string, unknown> };
    expect(enrichment.appliedFilters).toMatchObject({ perPage: 80 });
    expect(enrichment.appliedFilters).not.toHaveProperty('requestedPerPage');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('keeps accepting per_page up to 1000 at the schema', async () => {
    const tool = await loadTool();
    expect(tool.input.safeParse({ per_page: 1000 }).success).toBe(true);
  });

  it('reads limit as per_page, on both surfaces', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'BR', limit: 5 } as never);

    expect(result.isError).toBeFalsy();
    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ perPage: 5 });
    expect(result.structuredContent).toMatchObject({ appliedFilters: { perPage: 5 } });
    expect(textOf(result)).toContain('per_page=5');
  });

  it('raises no notice when the search returned results', async () => {
    await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR' }), ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // ─── Error mapping ────────────────────────────────────────────────────────

  it('maps page_out_of_range to a declared failure with a recovery hint', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ValidationError,
      'Page 200 at 1000 results per page starts past the 100,000-result offset.',
      'page_out_of_range',
    );
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });

    await expect(
      tool.handler(tool.input.parse({ page: 200, per_page: 1000 }), ctx),
    ).rejects.toMatchObject({
      data: {
        reason: 'page_out_of_range',
        recovery: { hint: expect.stringContaining('Lower the page number') },
      },
    });
  });

  it('maps an upstream failure to upstream_unavailable', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ServiceUnavailable,
      'The World Bank Projects API answered HTTP 500.',
      'upstream_unavailable',
    );
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });

    await expect(tool.handler(tool.input.parse({ countries: 'BR' }), ctx)).rejects.toMatchObject({
      data: {
        reason: 'upstream_unavailable',
        recovery: { hint: expect.stringContaining('Retry the same search once') },
      },
    });
  });

  it('forwards the status of an upstream 5xx and leaves it retryable', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ServiceUnavailable,
      'The World Bank Projects API answered HTTP 503.',
      'upstream_unavailable',
      { status: 503 },
    );
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'BR' });

    const data = (result.structuredContent as { error: { data: Record<string, unknown> } }).error
      .data;
    expect(data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 503,
      recovery: { hint: expect.stringContaining('Retry the same search once') },
    });
    expect(data).not.toHaveProperty('retryable');
    expect(textOf(result).trimEnd()).toMatch(/\(reason upstream_unavailable\)$/);
  });

  it('rethrows an unrecognized upstream error untouched', async () => {
    await stubServiceError(JsonRpcErrorCode.Timeout, 'Request timed out.', 'something_else');
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });

    await expect(tool.handler(tool.input.parse({ countries: 'BR' }), ctx)).rejects.toMatchObject({
      data: { reason: 'something_else' },
    });
  });

  // ─── Rendering ────────────────────────────────────────────────────────────

  it('renders every project field into content[]', async () => {
    const tool = await loadTool();
    const [block] =
      tool.format?.({
        projects: [{ ...project, abstract: 'Rehabilitation of the dam.' }, sparseProject],
      }) ?? [];
    const text = (block as { text: string }).text;

    expect(text).toContain('(P513080)');
    expect(text).toContain('**status:** Active');
    expect(text).toContain('**countryCodes:** BR');
    expect(text).toContain('**boardApprovalDate:** 2026-03-30');
    expect(text).toContain('**closingDate:** 2031-12-19');
    expect(text).toContain('**totalCommitment:** 41,800,000 USD');
    expect(text).toContain('**financialTypes:** IBRD, Other');
    expect(text).toContain('**majorSectors:** Public Administration, Education');
    expect(text).toContain('projects.worldbank.org/en/projects-operations/project-detail/P513080');
    expect(text).toContain('**abstract:** Rehabilitation of the dam.');

    // The sparse row reports its gaps rather than rendering blanks.
    expect(text).toContain('**closingDate:** null');
    expect(text).toContain('**totalCommitment:** null');
    expect(text).toContain('**majorSectors:** none');
    expect(text).toContain('**countryCodes:** none');
    expect(text).toContain('**abstract:** null');
  });

  it('renders an empty result without throwing', async () => {
    const tool = await loadTool();
    const [block] = tool.format?.({ projects: [] }) ?? [];
    expect((block as { text: string }).text).toContain('No projects returned.');
  });
});
