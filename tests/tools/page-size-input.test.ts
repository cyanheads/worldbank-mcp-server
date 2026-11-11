/**
 * @fileoverview The `per_page` input shared by the six paged tools: positive
 * integer validation in both `WORLDBANK_CLAMP_LIMITS` modes, and each tool's
 * wiring of the clamp — the served size sent upstream, the echo, and the notice
 * on both surfaces.
 * @module tests/tools/page-size-input.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { worldbankGetPoverty } from '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { worldbankListCountries } from '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { worldbankListSources } from '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js';
import { worldbankSearchIndicators } from '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';
import { perPageInput, resolvePerPage } from '@/mcp-server/tools/per-page.js';

const config = vi.hoisted(() => ({ defaultPerPage: 50, clampLimits: true }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

/** The one counter the clamp records on, in place of the OTel instrument. */
const clampCounter = vi.hoisted(() => ({ add: vi.fn() }));
const createCounter = vi.hoisted(() => vi.fn(() => clampCounter));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter,
}));

/**
 * One fake behind all three services. Each read returns an empty result and
 * echoes the page size it was sent without capping it, so a served size equal
 * to the cap can only come from the tool's own clamp.
 */
const services = vi.hoisted(() => ({
  getData: vi.fn(async (opts: { indicatorId: string; page: number; perPage: number }) => ({
    data: [],
    indicator: { id: opts.indicatorId, name: 'Population, total' },
    total: 0,
    page: opts.page,
    pages: 1,
    perPage: opts.perPage,
    nullCount: 0,
    dateFilterDropped: false,
  })),
  getPoverty: vi.fn(async (opts: { countries: string[]; page: number; perPage: number }) => ({
    rows: [],
    total: 0,
    page: opts.page,
    pages: 1,
    perPage: opts.perPage,
    countries: opts.countries,
    gapFilled: false,
    gapFillUnavailable: false,
    modelOnly: [],
    pppVersion: '2021',
    releaseVersion: '20260922',
  })),
  listCountries: vi.fn(async (opts: { page: number; perPage: number }) => ({
    countries: [],
    total: 0,
    page: opts.page,
    pages: 1,
    perPage: opts.perPage,
  })),
  listSources: vi.fn(async (page: number, _perPage: number) => ({
    sources: [],
    total: 0,
    page,
    pages: 1,
  })),
  searchIndicators: vi.fn(async (opts: { page: number; perPage: number }) => ({
    indicators: [],
    total: 0,
    page: opts.page,
    pages: 0,
  })),
  searchProjects: vi.fn(async (opts: { page: number; perPage: number }) => ({
    projects: [],
    total: 0,
    page: opts.page,
    pages: 1,
    perPage: opts.perPage,
    countryOnlyTotal: null,
  })),
}));
vi.mock('@/services/worldbank/worldbank-service.js', () => ({
  getWorldBankApiService: () => services,
}));
vi.mock('@/services/pip/pip-service.js', () => ({ getPipService: () => services }));
vi.mock('@/services/projects/projects-service.js', () => ({
  getProjectsService: () => services,
}));

/** The counters created at import, read before any test clears mock state. */
const countersCreated = createCounter.mock.calls.slice();

afterEach(() => {
  config.defaultPerPage = 50;
  config.clampLimits = true;
  for (const read of Object.values(services)) read.mockClear();
  clampCounter.add.mockClear();
});

// ─── The mechanism ──────────────────────────────────────────────────────────

describe('resolvePerPage', () => {
  /** Resolve with a fresh context and return the size, the clamp log lines, and the counter adds. */
  function resolve(perPage: number | undefined, cap: number) {
    const ctx = createMockContext();
    const size = resolvePerPage({ tool: 'worldbank_test_tool', cap, perPage }, ctx);
    const logged = (ctx.log as MockContextLogger).calls.filter(
      (entry) => entry.msg === 'Page size reduced to the page maximum',
    );
    return { size, logged, adds: clampCounter.add.mock.calls };
  }

  it.each([
    ['a size below the cap', 99, 50, { requested: 99, served: 99 }],
    ['the cap itself', 100, 50, { requested: 100, served: 100 }],
    ['the smallest size', 1, 50, { requested: 1, served: 1 }],
    ['an omitted size, at the default', undefined, 50, { requested: 50, served: 50 }],
    [
      'an omitted size, at a default equal to the cap',
      undefined,
      100,
      { requested: 100, served: 100 },
    ],
  ])('serves %s as asked, without logging or counting', (_label, perPage, fallback, expected) => {
    config.defaultPerPage = fallback;
    const { size, logged, adds } = resolve(perPage, 100);
    expect(size).toEqual(expected);
    expect(logged).toEqual([]);
    expect(adds).toEqual([]);
  });

  it.each([
    ['one above the cap', 101, 50, false],
    ['far above the cap', 5000, 50, false],
    ['an omitted size, at a default above the cap', undefined, 5000, true],
  ])(
    'serves %s at the cap, logging once and counting once',
    (_label, perPage, fallback, fromServerDefault) => {
      config.defaultPerPage = fallback;
      const requested = perPage ?? fallback;
      const { size, logged, adds } = resolve(perPage, 100);
      expect(size).toEqual({ requested, served: 100 });
      expect(logged).toEqual([
        {
          level: 'notice',
          msg: 'Page size reduced to the page maximum',
          data: { requestedPerPage: requested, servedPerPage: 100, fromServerDefault },
        },
      ]);
      expect(adds).toEqual([[1, { 'mcp.tool.name': 'worldbank_test_tool' }]]);
    },
  );

  it('counts reductions on worldbank.per_page.clamped, in calls', () => {
    expect(countersCreated).toContainEqual([
      'worldbank.per_page.clamped',
      expect.any(String),
      '{calls}',
    ]);
  });

  it('still serves a server default above the cap at the cap under WORLDBANK_CLAMP_LIMITS=false', () => {
    config.clampLimits = false;
    config.defaultPerPage = 5000;
    const { size, logged, adds } = resolve(undefined, 100);
    expect(size).toEqual({ requested: 5000, served: 100 });
    expect(logged).toHaveLength(1);
    expect(adds).toHaveLength(1);
  });
});

describe('perPageInput', () => {
  const input = z.object({ per_page: perPageInput(100) });
  const accepts = (per_page: unknown) => input.safeParse({ per_page }).success;

  it('advertises an integer of at least 1 with no maximum while clamping', () => {
    expect(z.toJSONSchema(input).properties?.per_page).toEqual({
      type: 'integer',
      minimum: 1,
      description:
        'Results per page (default: server default). Positive integers above 100 are served at that maximum with the requested and served sizes echoed and a notice. totalPages uses the served size.',
    });
  });

  it('advertises the cap as the maximum under WORLDBANK_CLAMP_LIMITS=false', () => {
    config.clampLimits = false;
    expect(z.toJSONSchema(input).properties?.per_page).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Results per page (default: server default, max: 100).',
    });
  });

  it.each([true, false])(
    'accepts an omitted size and 1 through the cap with clampLimits %s',
    (clampLimits) => {
      config.clampLimits = clampLimits;
      for (const per_page of [undefined, 1, 50, 100])
        expect(accepts(per_page), String(per_page)).toBe(true);
    },
  );

  it('accepts sizes above the cap while clamping', () => {
    for (const per_page of [101, 5000, Number.MAX_SAFE_INTEGER])
      expect(accepts(per_page)).toBe(true);
  });

  it('rejects sizes above the cap with the too_big issue under WORLDBANK_CLAMP_LIMITS=false', () => {
    config.clampLimits = false;
    for (const per_page of [101, 5000]) {
      const parsed = input.safeParse({ per_page });
      expect(parsed.error?.issues).toEqual([
        expect.objectContaining({
          code: 'too_big',
          maximum: 100,
          path: ['per_page'],
          message: 'Too big: expected number to be <=100',
        }),
      ]);
    }
  });

  it.each([true, false])(
    'rejects zero, negative, fractional, and non-numeric sizes with clampLimits %s',
    (clampLimits) => {
      config.clampLimits = clampLimits;
      for (const per_page of [0, -1, 1.5, 100.5, '50', NaN, Infinity, null])
        expect(accepts(per_page), String(per_page)).toBe(false);
    },
  );
});

// ─── Each tool's wiring ─────────────────────────────────────────────────────

/**
 * Each tool, its page maximum, the arguments it needs beside `per_page`, the
 * page size its service was sent, and what an empty result says before the
 * page-size notice. `filters` is the applied-filters echo without the page size.
 */
const TOOLS = [
  {
    tool: worldbankGetData,
    cap: 1000,
    args: { indicator_id: 'SP.POP.TOTL', countries: 'USA' },
    sent: () => services.getData.mock.calls[0]?.[0].perPage,
    filters: { indicatorId: 'SP.POP.TOTL', countries: 'USA', page: 1 },
    trailer: 'indicator_id=SP.POP.TOTL, countries=USA, page=1',
    empty:
      "No observations returned for the requested filter. Try broadening the date range, removing date filters, or using mrnev=1 to fetch each country's latest available value.",
  },
  {
    tool: worldbankGetPoverty,
    cap: 1000,
    args: { countries: 'USA' },
    sent: () => services.getPoverty.mock.calls[0]?.[0].perPage,
    filters: {
      countries: 'USA',
      pppVersion: '2021',
      releaseVersion: '20260922',
      fillGaps: true,
      page: 1,
    },
    trailer: 'countries=USA, ppp_version=2021, release_version=20260922, fill_gaps=true, page=1',
    empty:
      'No estimates for the requested filter. PIP covers economies from 1963 onward and its aggregates from 1981, but not every economy in every year; widen the year, drop welfare_type or reporting_level, or check the country code.',
  },
  {
    tool: worldbankListCountries,
    cap: 300,
    args: {},
    sent: () => services.listCountries.mock.calls[0]?.[0].perPage,
    filters: { includeAggregates: false, page: 1 },
    trailer: 'include_aggregates=false, page=1',
    empty: 'The World Bank returned no countries.',
  },
  {
    tool: worldbankSearchProjects,
    cap: 1000,
    args: {},
    sent: () => services.searchProjects.mock.calls[0]?.[0].perPage,
    filters: { includeAbstract: false, page: 1 },
    trailer: 'include_abstract=false, page=1',
    empty:
      'No project matches this search. Filters combine by AND and match exactly. Widen the date window, add statuses, or drop words from the query, which requires every word to appear.',
  },
  {
    tool: worldbankSearchIndicators,
    cap: 3000,
    args: { query: 'gdp' },
    sent: () => services.searchIndicators.mock.calls[0]?.[0].perPage,
    filters: { query: 'gdp' },
    trailer: 'query="gdp"',
    empty:
      'No indicators matched "gdp". Try a synonym or browse by topic using worldbank_list_topics.',
  },
  {
    tool: worldbankListSources,
    cap: 100,
    args: {},
    sent: () => services.listSources.mock.calls[0]?.[1],
    filters: {},
    trailer: '',
    empty: 'The World Bank returned no data sources.',
  },
] as const;

/** Call one tool through the contract runner: schema, handler, enrichment, and format. */
async function call(entry: (typeof TOOLS)[number], perPage?: number) {
  const result = await runToolContract(
    entry.tool as never,
    {
      ...entry.args,
      ...(perPage !== undefined && { per_page: perPage }),
    } as never,
  );
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  return { result, structured: result.structuredContent as Record<string, unknown>, text };
}

/** The applied-filters trailer line `content[]` carries for a served and requested size. */
function trailerLine(entry: (typeof TOOLS)[number], served: number, requested?: number) {
  const size = `per_page=${served}${requested === undefined ? '' : ` (requested ${requested})`}`;
  return `**Applied Filters:** ${entry.trailer ? `${entry.trailer}, ` : ''}${size}`;
}

describe.each(TOOLS)('$tool.name routes per_page through the shared clamp', (entry) => {
  const reduced = (requested: number) =>
    `per_page=${requested} was reduced to ${entry.cap}, the maximum page size. totalPages counts pages of ${entry.cap}.`;

  it('serves a size above the cap at the cap, echoed and disclosed on both surfaces', async () => {
    const { result, structured, text } = await call(entry, entry.cap + 1);
    expect(result.isError).toBeFalsy();
    expect(entry.sent()).toBe(entry.cap);
    expect(structured.appliedFilters).toEqual({
      ...entry.filters,
      perPage: entry.cap,
      requestedPerPage: entry.cap + 1,
    });
    expect(structured.notice).toBe(`${entry.empty} ${reduced(entry.cap + 1)}`);
    expect(text).toContain(trailerLine(entry, entry.cap, entry.cap + 1));
    expect(text).toContain(reduced(entry.cap + 1));
  });

  it('counts the clamped call once, under its own tool name', async () => {
    await call(entry, entry.cap + 1);
    expect(clampCounter.add.mock.calls).toEqual([[1, { 'mcp.tool.name': entry.tool.name }]]);
  });

  it('serves the cap itself as asked, with no page-size notice', async () => {
    const { structured, text } = await call(entry, entry.cap);
    expect(entry.sent()).toBe(entry.cap);
    expect(structured.appliedFilters).toEqual({ ...entry.filters, perPage: entry.cap });
    expect(structured.notice).toBe(entry.empty);
    expect(text).toContain(trailerLine(entry, entry.cap));
    expect(clampCounter.add).not.toHaveBeenCalled();
  });

  it('clamps a server default above the cap the same way', async () => {
    config.defaultPerPage = 5000;
    const { structured, text } = await call(entry);
    expect(entry.sent()).toBe(entry.cap);
    expect(structured.appliedFilters).toEqual({
      ...entry.filters,
      perPage: entry.cap,
      requestedPerPage: 5000,
    });
    expect(structured.notice).toBe(`${entry.empty} ${reduced(5000)}`);
    expect(text).toContain(trailerLine(entry, entry.cap, 5000));
  });
});

/**
 * The served MCP surface: `tools/list` and `tools/call` through the framework's
 * HTTP app and the SDK, at the 2026-07-28 revision, so the advertised schema is
 * the one a client reads and an over-cap value meets the real argument check.
 */
describe('per_page on the wire', () => {
  const worker = createWorkerHandler({
    name: 'worldbank-mcp-server',
    title: 'worldbank-mcp-server',
    tools: TOOLS.map(({ tool }) => tool) as never,
  });

  async function rpc(method: string, params: Record<string, unknown>, name?: string) {
    const response = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': method,
          ...(name !== undefined && { 'Mcp-Name': name }),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
      {} as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    const body = await response.text();
    const frame = body.trimStart().startsWith('{')
      ? body
      : (body
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5) ?? '');
    return JSON.parse(frame) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  }

  async function advertised() {
    const listed = await rpc('tools/list', {});
    const tools = (listed.result?.tools ?? []) as Array<{
      name: string;
      inputSchema: { properties: Record<string, Record<string, unknown>> };
    }>;
    return new Map(tools.map((tool) => [tool.name, tool.inputSchema.properties.per_page]));
  }

  it('advertises no maximum while clamping, and describes the clamp', async () => {
    const schemas = await advertised();
    for (const { tool, cap } of TOOLS) {
      const schema = schemas.get(tool.name);
      expect(schema, tool.name).toEqual({
        type: 'integer',
        minimum: 1,
        description: `Results per page (default: server default). Positive integers above ${cap} are served at that maximum with the requested and served sizes echoed and a notice. totalPages uses the served size.`,
      });
    }
  });

  it('advertises the cap as the maximum under WORLDBANK_CLAMP_LIMITS=false', async () => {
    config.clampLimits = false;
    const schemas = await advertised();
    for (const { tool, cap } of TOOLS) {
      expect(schemas.get(tool.name), tool.name).toEqual({
        type: 'integer',
        minimum: 1,
        maximum: cap,
        description: `Results per page (default: server default, max: ${cap}).`,
      });
    }
  });

  it.each(TOOLS)(
    'rejects $tool.name per_page one above the cap with -32602 under WORLDBANK_CLAMP_LIMITS=false',
    async ({ tool, cap, args }) => {
      config.clampLimits = false;
      const over = await rpc(
        'tools/call',
        { name: tool.name, arguments: { ...args, per_page: cap + 1 } },
        tool.name,
      );
      expect(over.result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: -32602,
            message: `Input validation error: Invalid arguments for tool ${tool.name}: per_page: Too big: expected number to be <=${cap}`,
          },
        },
      });
      expect(JSON.stringify(over.result?.content)).toContain(
        `per_page: Too big: expected number to be <=${cap}`,
      );
      const at = await rpc(
        'tools/call',
        { name: tool.name, arguments: { ...args, per_page: cap } },
        tool.name,
      );
      expect(at.error).toBeUndefined();
      expect(at.result?.isError).toBeFalsy();
    },
  );

  it.each(TOOLS)(
    'serves $tool.name per_page one above the cap while clamping',
    async ({ tool, cap, args }) => {
      const over = await rpc(
        'tools/call',
        { name: tool.name, arguments: { ...args, per_page: cap + 1 } },
        tool.name,
      );
      expect(over.error).toBeUndefined();
      expect(over.result?.isError).toBeFalsy();
      expect(over.result?.structuredContent).toMatchObject({
        appliedFilters: { perPage: cap, requestedPerPage: cap + 1 },
      });
    },
  );
});

describe('page size inputs', () => {
  it.each([true, false])(
    'rejects invalid page sizes on every tool with clampLimits %s',
    (clampLimits) => {
      config.clampLimits = clampLimits;
      for (const per_page of [0, -1, 1.5, '50', NaN, Infinity]) {
        for (const { tool, args } of TOOLS) {
          expect(
            tool.input.safeParse({ ...args, per_page }).success,
            `${tool.name} ${per_page}`,
          ).toBe(false);
        }
      }
    },
  );
});
