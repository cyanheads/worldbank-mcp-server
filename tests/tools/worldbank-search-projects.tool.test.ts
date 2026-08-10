/**
 * @fileoverview Tests for worldbank_search_projects — ISO2 enforcement at the
 * schema, country-code normalization and the applied-filter echo, the abstract
 * opt-in, the three empty-result notices the zero-hit probe distinguishes,
 * error mapping, and format() parity.
 * @module tests/tools/worldbank-search-projects.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
  const searchProjects = vi.fn().mockResolvedValue({
    projects: [],
    total: 0,
    page: 1,
    pages: 1,
    countryOnlyTotal: null,
    ...result,
  });
  vi.mocked(getProjectsService).mockReturnValue({ searchProjects } as never);
  return searchProjects;
}

/** Stub the service to reject with an McpError carrying a service-layer reason. */
async function stubServiceError(code: JsonRpcErrorCode, message: string, reason: string) {
  const { getProjectsService } = await import('@/services/projects/projects-service.js');
  vi.mocked(getProjectsService).mockReturnValue({
    searchProjects: vi.fn().mockRejectedValue(new McpError(code, message, { reason })),
  } as never);
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
      createMockContext(),
    );

    expect(result.projects).toHaveLength(2);
    expect(result.projects[0]).toMatchObject({ id: 'P513080', totalCommitment: 41_800_000 });
    expect(result.projects[1]).toMatchObject({ totalCommitment: null, majorSectors: [] });
  });

  // ─── Country codes ────────────────────────────────────────────────────────

  it('rejects ISO3 codes at the schema, naming the code system this API uses', async () => {
    const tool = await loadTool();
    const parsed = tool.input.safeParse({ countries: 'BRA' });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/ISO2/);
    expect(tool.input.safeParse({ countries: ['BRA', 'IND'] }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'BR,IND' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'B' }).success).toBe(false);
    expect(tool.input.safeParse({ countries: 'B-' }).success).toBe(false);
  });

  it('accepts the digit-bearing regional codes the portfolio files multi-country operations under', async () => {
    const tool = await loadTool();

    // 3A (Africa), 4E (East Asia and Pacific), 1W (World) are real filter values
    // — a letters-only rule would make them unreachable.
    for (const code of ['3A', '4E', '7E', '8S', '1W', 'E2', 'P3']) {
      expect(tool.input.safeParse({ countries: code }).success).toBe(true);
    }
    expect(tool.input.safeParse({ countries: 'BR,3A' }).success).toBe(true);

    const searchProjects = await stubService({ projects: [project], total: 1 });
    await tool.handler(tool.input.parse({ countries: '3a' }), createMockContext());
    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ countryCodes: ['3a'] });
  });

  it("splits a single string on either separator this server's tools use", async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    await tool.handler(tool.input.parse({ countries: 'br; in, ZA' }), createMockContext());

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
      createMockContext(),
    );

    const sent = searchProjects.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('query');
    expect(sent).not.toHaveProperty('approvedFrom');
    expect(sent).not.toHaveProperty('approvedTo');
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
      tool.format?.(
        { projects: [{ ...project, abstract: 'Rehabilitation of the dam.' }, sparseProject] },
        createMockContext(),
      ) ?? [];
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
    const [block] = tool.format?.({ projects: [] }, createMockContext()) ?? [];
    expect((block as { text: string }).text).toContain('No projects returned.');
  });
});
