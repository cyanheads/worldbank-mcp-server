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
    clampLimits: true,
    catalogCacheTtlMs: 60_000,
  }),
}));

/** A fully-populated project, as the service normalizes one. */
const project = {
  id: 'P513080',
  name: 'MPA Phase III - Progestão Sergipe: Public Sector Management Efficiency Project',
  objective: 'To improve the efficiency of public sector management in Sergipe.' as string | null,
  status: 'Active',
  countryCodes: ['BR'],
  countryName: 'Federative Republic of Brazil',
  regionName: 'Latin America and Caribbean',
  boardApprovalDate: '2026-03-30',
  closingDate: '2031-12-19',
  totalCommitment: 41_800_000,
  ibrdCommitment: 41_800_000,
  idaCommitment: 0,
  grantAmount: null as number | null,
  financialTypes: ['IBRD', 'Other'],
  majorSectors: ['Public Administration', 'Education'],
  sectors: [
    {
      name: 'Central Government (Central Agencies)',
      code: 'BCA',
      majorSector: 'Public Administration',
      percent: 85,
    },
    {
      name: 'Public Administration - Education',
      code: 'EEF',
      majorSector: 'Education',
      percent: 15,
    },
  ] as Array<{ name: string; code: string; majorSector: string; percent: number | null }>,
  abstract: null as string | null,
  url: 'https://projects.worldbank.org/en/projects-operations/project-detail/P513080',
};

/** A sparse project: the portfolio publishes no objective, amount, closing date, or sectors for it. */
const sparseProject = {
  ...project,
  id: 'P072339',
  name: 'African Distance Learning Multi-Country Credit',
  objective: null,
  status: 'Dropped',
  countryCodes: [] as string[],
  countryName: 'Other',
  regionName: 'Other',
  closingDate: null,
  totalCommitment: null,
  ibrdCommitment: null,
  idaCommitment: null,
  grantAmount: null,
  financialTypes: [] as string[],
  majorSectors: [] as string[],
  sectors: [],
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

  it('passes normalized sector names and echoes them on both surfaces', async () => {
    const search = await stubService({ projects: [project], total: 77, pages: 8, page: 2 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      sector: ['FY17 - Social Protection', 'Social Protection', ' Primary Education '],
      region: ['South Asia'],
      page: 2,
      per_page: 10,
    });
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      sectors: ['Social Protection', 'Primary Education'],
      regions: ['South Asia'],
      page: 2,
      perPage: 10,
    });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { sector: ['Social Protection', 'Primary Education'] },
      totalCount: 77,
      totalPages: 8,
      currentPage: 2,
    });
    expect(textOf(result)).toContain('sector=Social Protection, Primary Education');
  });

  it('offers an actionable notice when a sector name has no matches', async () => {
    await stubService({ projects: [], total: 0 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { sector: ['Invented Sector'] });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { sector: ['Invented Sector'] },
      totalCount: 0,
    });
    expect(textOf(result)).toContain('sector');
    expect(textOf(result)).toContain('remove');
  });

  it('retains country diagnostics when a sector search is empty', async () => {
    await stubService({ projects: [], total: 0, countryOnlyTotal: 10 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'BR', sector: ['Invented Sector'] });
    expect(textOf(result)).toContain('match 10 projects');
    expect(textOf(result)).toContain('sector narrowed');
    expect(textOf(result)).toContain('remove the sector filter');
  });

  it.each(['', ' ', 'FY17 - ', 'Education^Health'])(
    'reports invalid sector name %j with recovery on both surfaces',
    async (sector) => {
      const search = await stubService({});
      const tool = await loadTool();
      const result = await runToolContract(tool, { sector: [sector] });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_sector_name',
            retryable: false,
            recovery: {
              hint: 'Send each nonblank sector name in its own array element, without caret separators.',
            },
          },
        },
      });
      expect(textOf(result)).toContain('reason invalid_sector_name');
      expect(textOf(result)).toContain('Send each nonblank sector name');
      expect(search).not.toHaveBeenCalled();
    },
  );

  it('leaves an empty sector array unset', async () => {
    const search = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { sector: [] });
    expect(search.mock.calls[0]?.[0]).not.toHaveProperty('sectors');
    expect(result.structuredContent).not.toHaveProperty('appliedFilters.sector');
    expect(textOf(result)).not.toContain('sector=');
  });

  it('preserves the sector filter and continuation for a page past the end', async () => {
    await stubService({ projects: [], total: 3, page: 3, pages: 2 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      sector: ['FY17 - Education'],
      page: 3,
      per_page: 2,
    });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { sector: ['Education'], page: 3, perPage: 2 },
      totalCount: 3,
      currentPage: 3,
      totalPages: 2,
    });
    expect(textOf(result)).toContain('sector=Education');
    expect(textOf(result)).toContain('Page 3 is past the end');
  });

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
    ['BRAZ', ['BRAZ']],
    [
      ['BRAZ', 'B'],
      ['BRAZ', 'B'],
    ],
    ['BR,INDIA', ['INDIA']],
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
            recovery: { hint: expect.stringContaining('worldbank_list_countries') },
          },
        },
      });
      const text = textOf(result);
      expect(text).toContain(`"${invalidCodes.join(', ')}"`);
      expect(text).toMatch(/two or three letters or digits/);
      expect(text).toMatch(/Recovery:.*worldbank_list_countries/);
      expect(searchProjects).not.toHaveBeenCalled();
    },
  );

  it('accepts the digit-bearing regional codes the portfolio files multi-country operations under', async () => {
    const tool = await loadTool();

    // 3A (pre-split Africa), 4E (East Asia and Pacific), 1W (World) are real filter values
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
    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ countryCodes: ['3A'] });
  });

  it('splits a single string on the comma and semicolon separators', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    await tool.handler(
      tool.input.parse({ countries: 'br; in, ZA' }),
      createMockContext({ errors: tool.errors }),
    );

    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({
      countryCodes: ['BR', 'IN', 'ZA'],
    });
  });

  it.each([
    ['BJ|BF', ['BJ', 'BF']],
    ['bj | bf', ['BJ', 'BF']],
    [['BJ|BF'], ['BJ', 'BF']],
    ['BJ|BF;IN, ZA', ['BJ', 'BF', 'IN', 'ZA']],
  ])(
    'splits the pipe-joined countries %j and echoes them comma-joined',
    async (countries, codes) => {
      const searchProjects = await stubService({ projects: [project], total: 1 });
      const tool = await loadTool();
      const result = await runToolContract(tool, { countries });

      expect(result.isError).toBeFalsy();
      expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ countryCodes: codes });
      expect(result.structuredContent).toMatchObject({
        appliedFilters: { countries: codes.join(',') },
      });
      expect(textOf(result)).toContain(`countries=${codes.join(',')}`);
    },
  );

  it.each([[','], ['|'], [' ; '], ['|;,'], [['|']], [[',', ' ']]])(
    'rejects countries=%j, which names no code, as invalid_country_code before any request, on both surfaces',
    async (countries) => {
      const searchProjects = await stubService({ projects: [project], total: 1 });
      const tool = await loadTool();
      const result = await runToolContract(tool, { countries });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_country_code',
            recovery: { hint: expect.stringContaining('omit countries') },
          },
        },
      });
      const text = textOf(result);
      expect(text).toMatch(/names no country code/);
      expect(text).toMatch(/Recovery:.*omit countries/);
      expect(text.trimEnd()).toMatch(/\(reason invalid_country_code\)$/);
      expect(searchProjects).not.toHaveBeenCalled();
    },
  );

  it.each([[''], ['   '], [[]], [['']], [['  ', '']]])(
    'reads the blank countries value %j as no country filter',
    async (countries) => {
      const searchProjects = await stubService({ projects: [project], total: 1 });
      const tool = await loadTool();
      const result = await runToolContract(tool, { countries });

      expect(result.isError).toBeFalsy();
      expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ countryCodes: [] });
      expect(
        (result.structuredContent as { appliedFilters: Record<string, unknown> }).appliedFilters,
      ).not.toHaveProperty('countries');
    },
  );

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
    expect(tool.input.safeParse({ per_page: 1001 }).success).toBe(true);
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

  it('filters by financing window and echoes it on both surfaces', async () => {
    const searchProjects = await stubService({
      projects: [{ ...project, financialTypes: ['IDA', 'Other'] }],
      total: 243,
    });
    const tool = await loadTool();
    const result = await runToolContract(tool, {
      countries: 'ET',
      financial_type: ['IDA', 'Grants'],
    });

    expect(result.isError).toBeFalsy();
    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ financialTypes: ['IDA', 'Grants'] });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { countries: 'ET', financialType: 'IDA,Grants' },
    });
    expect(textOf(result)).toContain('financial_type=IDA,Grants');
  });

  it('accepts exactly the financing windows financialTypes reports, case-sensitive', async () => {
    const tool = await loadTool();
    expect(
      tool.input.safeParse({ financial_type: ['IBRD', 'IDA', 'Grants', 'Other'] }).success,
    ).toBe(true);
    for (const value of ['ida', 'grants', 'Grant', 'Trust Funds']) {
      expect(tool.input.safeParse({ financial_type: [value] }).success).toBe(false);
    }
  });

  it('sends no financing-window filter when none is asked for', async () => {
    const searchProjects = await stubService({ projects: [project], total: 1 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'BR', financial_type: [] }), ctx);

    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ financialTypes: [] });
    const enrichment = getEnrichment(ctx) as { appliedFilters: Record<string, unknown> };
    expect(enrichment.appliedFilters).not.toHaveProperty('financialType');
  });

  it('names financial_type among the filters that emptied a country search', async () => {
    await stubService({ projects: [], total: 0, countryOnlyTotal: 387 });
    const tool = await loadTool();
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ countries: 'ET', financial_type: ['IBRD'] }), ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/ET match 387 projects with every other filter removed/);
    expect(notice).toMatch(/so financial_type narrowed the result to nothing/);
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

  it.each([false, true])(
    'serves the maximum with complete abstracts: %s',
    async (includeAbstract) => {
      const abstract = 'b'.repeat(5000) + 'TAIL';
      const searchProjects = await stubService({ projects: [{ ...project, abstract }], total: 1 });
      const tool = await loadTool();
      const result = await runToolContract(tool, {
        per_page: 1001,
        include_abstract: includeAbstract,
      });
      expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ perPage: 1000, includeAbstract });
      expect(result.structuredContent).toMatchObject({
        projects: [{ abstract }],
        appliedFilters: { perPage: 1000, requestedPerPage: 1001, includeAbstract },
      });
      expect(textOf(result)).toContain(abstract);
      expect(textOf(result)).toContain('per_page=1001 was reduced to 1000');
    },
  );

  it.each([0, 1])('discloses maximum clamping with total %i', async (total) => {
    await stubService({ projects: [], total, page: 2, pages: 1, perPage: 1000 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { page: 2, per_page: 1001 });
    expect(result.structuredContent).toMatchObject({
      appliedFilters: { perPage: 1000, requestedPerPage: 1001 },
    });
    expect(textOf(result)).toContain('per_page=1001 was reduced to 1000');
    expect(textOf(result)).toContain(total === 0 ? 'No project matches' : 'Page 2 is past the end');
  });

  it('serves the default 50 with abstracts', async () => {
    const searchProjects = await stubService({ projects: [project], total: 100, pages: 2 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { include_abstract: true });
    expect(searchProjects.mock.calls[0]?.[0]).toMatchObject({ perPage: 50 });
    expect(result.structuredContent).toMatchObject({ appliedFilters: { perPage: 50 } });
    expect(textOf(result)).not.toContain('was reduced');
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
    const result = await runToolContract(tool, { page: 200, per_page: 1000 });

    expect((result.structuredContent as { error: { data: object } }).error.data).toMatchObject({
      reason: 'page_out_of_range',
      recovery: { hint: expect.stringContaining('Lower the page number') },
    });
  });

  it('maps an upstream failure to upstream_unavailable', async () => {
    await stubServiceError(
      JsonRpcErrorCode.ServiceUnavailable,
      'The World Bank Projects API answered HTTP 500.',
      'upstream_unavailable',
    );
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'BR' });

    expect((result.structuredContent as { error: { data: object } }).error.data).toMatchObject({
      reason: 'upstream_unavailable',
      recovery: { hint: expect.stringContaining('Retry the same search once') },
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
    const blended = {
      ...project,
      abstract: 'Rehabilitation of the dam.',
      totalCommitment: 49_300_000,
      idaCommitment: 5_000_000,
      grantAmount: 2_500_000,
    };
    const [block] = tool.format?.({ projects: [blended, sparseProject] }) ?? [];
    const text = (block as { text: string }).text;

    expect(text).toContain('(P513080)');
    expect(text).toContain(
      '- **status:** Active | **countryName:** Federative Republic of Brazil | **countryCodes:** BR | **regionName:** Latin America and Caribbean\n',
    );
    expect(text).toContain('**boardApprovalDate:** 2026-03-30');
    expect(text).toContain('**closingDate:** 2031-12-19');
    expect(text).toContain(
      '**totalCommitment:** 49,300,000 USD (ibrdCommitment 41,800,000 · idaCommitment 5,000,000 · grantAmount 2,500,000)',
    );
    expect(text).toContain('**financialTypes:** IBRD, Other');
    expect(text).toContain('**majorSectors:** Public Administration; Education');
    expect(text).toContain(
      '- **sectors:** Central Government (Central Agencies) (BCA · Public Administration · 85%); Public Administration - Education (EEF · Education · 15%)\n',
    );
    expect(text).toContain(
      'Public Sector Management Efficiency Project (P513080)\n- **objective:** To improve the efficiency of public sector management in Sergipe.\n- **status:** Active',
    );
    expect(text).toContain('projects.worldbank.org/en/projects-operations/project-detail/P513080');
    expect(text).toContain('**abstract:** Rehabilitation of the dam.');

    // The sparse row reports its gaps rather than rendering blanks.
    expect(text).toContain('**closingDate:** null');
    expect(text).toContain(
      '**totalCommitment:** null (ibrdCommitment null · idaCommitment null · grantAmount null) | **financialTypes:** none',
    );
    expect(text).toContain('**majorSectors:** none\n- **sectors:** none\n');
    expect(text).toContain('**countryCodes:** none | **regionName:** Other');
  });

  it('prints no abstract line for a row without one, and one for a row that has one', async () => {
    const tool = await loadTool();
    const [block] =
      tool.format?.({
        projects: [sparseProject, { ...project, abstract: 'Rehabilitation of the dam.' }, project],
      }) ?? [];
    const text = (block as { text: string }).text;

    expect(text).not.toContain('**abstract:** null');
    expect(text.match(/\*\*abstract:\*\*/g)).toHaveLength(1);
    expect(text).not.toMatch(/^- \*\*regionName:\*\*/m);
  });

  // ─── Objective and sub-sectors ────────────────────────────────────────────

  it('carries the same objective on both surfaces, under its heading, and no line for a null one', async () => {
    // Plain text with a line break from an upstream paragraph, a prose `<`, and Markdown-active characters.
    const objective =
      'Support the strategy through:\n(i) *green* growth for children < 5 years [phase 1]';
    await stubService({
      projects: [{ ...project, objective }, sparseProject],
      total: 2,
    });
    const tool = await loadTool();
    const result = await runToolContract(tool, { countries: 'BR' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      projects: [{ objective }, { objective: null }],
    });
    const text = textOf(result);
    expect(text).toContain(
      '(P513080)\n- **objective:** Support the strategy through:\\\n(i) \\*green\\* growth for children < 5 years \\[phase 1\\]\n- **status:** Active',
    );
    expect(text).toContain('(P072339)\n- **status:** Dropped');
    expect(text.match(/\*\*objective:\*\*/g)).toHaveLength(1);
  });

  it('carries the same sub-sectors on both surfaces, with null shares and an empty list', async () => {
    const unsplit = {
      ...project,
      id: 'P514519',
      majorSectors: ['Water, Sanitation and Waste Management', 'Social Protection'],
      sectors: [
        {
          name: 'Public Administration - Water, Sanitation, and Solid Waste Management',
          code: 'WWF',
          majorSector: 'Water, Sanitation and Waste Management',
          percent: null,
        },
        { name: 'Social Protection', code: 'SSA', majorSector: 'Social Protection', percent: null },
      ],
    };
    const split = {
      ...project,
      id: 'P507029',
      majorSectors: ['Transportation'],
      sectors: [
        { name: 'Urban Transport', code: 'TTC', majorSector: 'Transportation', percent: 53 },
        {
          name: 'Public Administration - Transportation',
          code: 'TTF',
          majorSector: 'Transportation',
          percent: 0,
        },
      ],
    };
    await stubService({ projects: [unsplit, split, sparseProject], total: 3 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      projects: [{ sectors: unsplit.sectors }, { sectors: split.sectors }, { sectors: [] }],
    });
    const text = textOf(result);
    // Names and major sectors carry commas, so items join with `; `.
    expect(text).toContain(
      '- **majorSectors:** Water, Sanitation and Waste Management; Social Protection\n- **sectors:** Public Administration - Water, Sanitation, and Solid Waste Management (WWF · Water, Sanitation and Waste Management · percent null); Social Protection (SSA · Social Protection · percent null)\n',
    );
    expect(text).toContain(
      '- **sectors:** Urban Transport (TTC · Transportation · 53%); Public Administration - Transportation (TTF · Transportation · 0%)\n',
    );
    expect(text).toContain('- **majorSectors:** none\n- **sectors:** none\n');
  });

  it('escapes Markdown in sub-sector fields on content[] only', async () => {
    const hostile = { name: 'A *b* [c]', code: 'X|Y', majorSector: '`m`', percent: 12.5 };
    await stubService({ projects: [{ ...project, sectors: [hostile] }], total: 1 });
    const tool = await loadTool();
    const result = await runToolContract(tool, {});

    expect(result.structuredContent).toMatchObject({ projects: [{ sectors: [hostile] }] });
    expect(textOf(result)).toContain(
      '- **sectors:** A \\*b\\* \\[c\\] (X\\|Y · \\`m\\` · 12.5%)\n',
    );
  });

  // ─── Descriptions ─────────────────────────────────────────────────────────

  /** Sub-sector names that return active operations through the sector filter, measured 2026-11-11. */
  const SECTOR_NAMES_WITH_ACTIVE_OPERATIONS = new Set([
    'Primary Education',
    'Secondary Education',
    'Tertiary Education',
    'Public Administration - Education',
    'Social Protection',
    'FY17 - Social Protection',
    'Health',
  ]);

  it('cites only sector names that return operations, and points at sectors[].name', async () => {
    const tool = await loadTool();
    const sectorInput = (tool.input.shape.sector as unknown as { description: string }).description;
    const cited = [
      ...[...tool.description.matchAll(/sector: (\[[^\]]*\])/g)].flatMap(
        ([, list]) => JSON.parse(list as string) as string[],
      ),
      ...(/such as (.+?) or (.+?)(?: —|,|\.)/.exec(sectorInput)?.slice(1) ?? []),
    ];

    expect(cited.length).toBeGreaterThan(2);
    for (const name of cited) expect(SECTOR_NAMES_WITH_ACTIVE_OPERATIONS).toContain(name);
    expect(tool.description).toMatch(/sectors\[\]\.name/);
    expect(sectorInput).toMatch(/sectors\[\]\.name/);
    expect(sectorInput).toMatch(/at any share/);

    await stubService({ projects: [], total: 0 });
    const ctx = createMockContext({ errors: tool.errors });
    await tool.handler(tool.input.parse({ sector: ['Invented Sector'] }), ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/sectors\[\]\.name/);
    expect(notice).toMatch(/not the majorSectors names/);
  });

  /**
   * Regional codes with at least one active operation, from a sweep of all
   * 28,238 projects (2026-11-11). 3A, the pre-split Africa code, has none.
   */
  const REGIONAL_CODES_WITH_ACTIVE_OPERATIONS = new Set(
    '1M 1W 3E 3S 3T 3W 4E 5M 6C 6L 6O 6R 7B 7C 7E 8S'.split(' '),
  );

  it('presents no retired regional code or region as current in any text it shows the caller', async () => {
    const tool = await loadTool();
    const { z } = await import('@cyanheads/mcp-ts-core');
    const malformed = await runToolContract(tool, { countries: 'B-' });
    await stubService({ projects: [], total: 0, countryOnlyTotal: 0 });
    const noSuchCode = await runToolContract(tool, { countries: 'QQ' });
    /** Every description string in a JSON Schema, nested ones included. */
    const descriptions = (node: unknown): string[] =>
      typeof node !== 'object' || node === null
        ? []
        : Object.entries(node).flatMap(([key, value]) =>
            key === 'description' && typeof value === 'string' ? [value] : descriptions(value),
          );
    const texts = [
      tool.description,
      ...descriptions(z.toJSONSchema(tool.input)),
      ...descriptions(z.toJSONSchema(tool.output)),
      ...(tool.errors ?? []).flatMap((entry) => [entry.when, entry.recovery]),
      textOf(malformed),
      textOf(noSuchCode),
    ];

    const sentences = texts.flatMap((text) => text.split(/(?<=[.;:])\s+/));
    const citing = sentences.filter((sentence) => /\b\d[A-Z]\b/.test(sentence));
    expect(citing.length).toBeGreaterThan(4);
    for (const sentence of citing) {
      if (/pre-split/.test(sentence)) continue;
      for (const [code] of sentence.matchAll(/\b\d[A-Z]\b/g)) {
        expect(REGIONAL_CODES_WITH_ACTIVE_OPERATIONS, sentence).toContain(code);
      }
    }
    const describe = (field: 'countries' | 'region') =>
      (tool.input.shape[field] as unknown as { description: string }).description;
    expect(describe('countries')).toMatch(/3A is the pre-split Africa code/);
    expect(describe('region')).toMatch(/Africa is the pre-split region/);
  });

  it('carries the commitment breakdown on both surfaces, a grant-only operation included', async () => {
    const grantOnly = {
      ...project,
      id: 'P516289',
      name: 'Second Kenya Social and Economic Inclusion Project',
      totalCommitment: 22_000_000,
      ibrdCommitment: null,
      idaCommitment: null,
      grantAmount: 22_000_000,
      financialTypes: ['Grants'],
    };
    const blended = {
      ...project,
      id: 'P510631',
      name: 'Chao Phraya Flood Management Plan 2',
      totalCommitment: 880_000_000,
      ibrdCommitment: 610_000_000,
      idaCommitment: 0,
      grantAmount: 270_000_000,
    };
    await stubService({ projects: [grantOnly, blended], total: 2 });
    const tool = await loadTool();
    const result = await runToolContract(tool, { query: 'P516289' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      projects: [
        { totalCommitment: 22_000_000, ibrdCommitment: null, idaCommitment: null },
        { totalCommitment: 880_000_000, ibrdCommitment: 610_000_000, idaCommitment: 0 },
      ],
    });
    const text = textOf(result);
    expect(text).toContain(
      '**totalCommitment:** 22,000,000 USD (ibrdCommitment null · idaCommitment null · grantAmount 22,000,000) | **financialTypes:** Grants',
    );
    // Both surfaces preserve the published zero.
    expect(text).toContain(
      '**totalCommitment:** 880,000,000 USD (ibrdCommitment 610,000,000 · idaCommitment 0 · grantAmount 270,000,000)',
    );
  });

  it('prints null, zero, and sole-equal-total commitment components', async () => {
    const tool = await loadTool();
    const ibrdOnly = {
      ...project,
      id: 'P100001',
      totalCommitment: 50_000_000,
      ibrdCommitment: 50_000_000,
      idaCommitment: null,
      grantAmount: null,
      financialTypes: ['IBRD'],
    };
    const [block] = tool.format?.({ projects: [ibrdOnly, project, sparseProject] }) ?? [];
    const text = (block as { text: string }).text;

    // A single component retains its identity even when equal to the total.
    expect(text).toContain(
      '**totalCommitment:** 50,000,000 USD (ibrdCommitment 50,000,000 · idaCommitment null · grantAmount null) | **financialTypes:** IBRD',
    );
    // Zero and null are distinct published values.
    expect(text).toContain(
      '**totalCommitment:** 41,800,000 USD (ibrdCommitment 41,800,000 · idaCommitment 0 · grantAmount null) | **financialTypes:** IBRD, Other',
    );
    expect(text).toContain(
      '**totalCommitment:** null (ibrdCommitment null · idaCommitment null · grantAmount null) | **financialTypes:** none',
    );
    expect(text).toContain('idaCommitment 0');
    expect(text).toContain('grantAmount null');
  });

  it('describes the grant amount apart from the Grants financing window', async () => {
    const tool = await loadTool();
    const item = (
      tool.output.shape.projects as unknown as {
        element: { shape: Record<string, { description?: string }> };
      }
    ).element.shape;

    expect(item.totalCommitment?.description).not.toMatch(/Total World Bank commitment/);
    expect(item.totalCommitment?.description).toMatch(/35\.8%/);
    expect(item.grantAmount?.description).toMatch(/co-financ/);
    expect(item.grantAmount?.description).not.toMatch(/Grants window/i);
    expect(tool.description).toMatch(/financing windows/);
    expect(tool.description).not.toMatch(/financing instrument/);
  });

  it('renders an empty result without throwing', async () => {
    const tool = await loadTool();
    const [block] = tool.format?.({ projects: [] }) ?? [];
    expect((block as { text: string }).text).toContain('No projects returned.');
  });
});
