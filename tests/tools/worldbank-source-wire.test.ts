/**
 * @fileoverview Selected-source data and pagination failures through the real fetch and tool boundaries.
 * @module tests/tools/worldbank-source-wire.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { initWorldBankApiService } from '@/services/worldbank/worldbank-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

describe('World Bank source and exhaustive pagination wire contracts', () => {
  const network = vi.fn<typeof fetch>();
  beforeEach(() => {
    network.mockReset();
    vi.stubGlobal('fetch', network);
    initWorldBankApiService({} as never, createInMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns malformed exhaustive pagination as an upstream error on both surfaces', async () => {
    network.mockImplementation(async () => Response.json([{ page: 1, total: 1 }, []]));
    const result = await runToolContract(worldbankGetData, {
      indicator_id: 'SP.POP.TOTL',
      countries: 'US',
      date_range: '2020:2021',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable },
    });
    expect(JSON.stringify(result.content)).toContain('invalid pagination metadata');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('reports a missing selected source with actionable recovery on both surfaces', async () => {
    network.mockImplementation(async () =>
      Response.json({ message: [{ id: '160', value: 'Data not found.' }] }),
    );
    const result = await runToolContract(worldbankGetData, {
      source_id: '99999991',
      indicator_id: 'SP.POP.TOTL',
      countries: 'US',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'source_not_found',
          recovery: { hint: expect.stringContaining('worldbank_list_sources') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('worldbank_list_sources');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 429, 500])(
    'preserves selected-source HTTP %i classification through real retries',
    async (status) => {
      vi.useFakeTimers();
      network.mockImplementation(async () => new Response('upstream unavailable', { status }));
      const pending = runToolContract(worldbankGetData, {
        source_id: '50',
        indicator_id: 'SP.POP.TOTL',
        countries: 'US',
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      if (status === 404) {
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'source_not_found' } },
        });
      } else {
        expect(result.structuredContent).toMatchObject({ error: { data: { status } } });
      }
      expect(network.mock.calls.length).toBe(status === 429 || status === 500 ? 4 : 1);
    },
  );

  it('never converts caller cancellation into an empty source result', async () => {
    const controller = new AbortController();
    network.mockImplementation(async (_url, init) => {
      controller.abort();
      throw init?.signal?.reason;
    });
    const result = await runToolContract(
      worldbankGetData,
      { source_id: '50', indicator_id: 'SP.POP.TOTL', countries: 'US' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not retry malformed source JSON or report a missing source', async () => {
    network.mockImplementation(async () => new Response('{broken'));
    const result = await runToolContract(worldbankGetData, {
      source_id: '50',
      indicator_id: 'SP.POP.TOTL',
      countries: 'US',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { errorSource: 'UpstreamJson' } },
    });
    expect(JSON.stringify(result)).not.toContain('source_not_found');
    expect(network).toHaveBeenCalledTimes(1);
  });

  describe('dimension_value by label on both surfaces', () => {
    const NBSP = ' ';
    const listing = (variables: Array<[id: string, label: string]>) => ({
      page: 1,
      pages: 1,
      source: [{ concept: [{ variable: variables.map(([id, value]) => ({ id, value })) }] }],
    });
    const catalogRow = (id: string, sourceId: string, sourceName: string) => [
      { page: 1, pages: 1, total: 1 },
      [{ id, name: id, source: { id: sourceId, value: sourceName }, sourceNote: '', topics: [] }],
    ];
    const observation = (id: string, label: string, value: number) => ({
      page: 1,
      pages: 1,
      lastupdated: '2025-12-01',
      source: {
        data: [
          {
            variable: [
              { concept: 'Country', id: 'ZMB', value: 'Zambia' },
              { concept: 'Counterpart-Area', id, value: label },
              { concept: 'Time', id: 'YR2023', value: '2023' },
            ],
            value,
          },
        ],
      },
    });
    const series = '/v2/sources/6/country/ZMB/series/DT.DOD.DPPG.CD/time/YR2023/counterpart-area';
    const IDA = `World Bank-IDA${NBSP.repeat(25)}`;
    const routes: Record<string, unknown> = {
      '/v2/source/6': [
        { page: 1, pages: 1, total: 1 },
        [{ id: '6', name: 'International Debt Statistics' }],
      ],
      '/v2/source/6/indicator/DT.DOD.DPPG.CD': catalogRow(
        'DT.DOD.DPPG.CD',
        '6',
        'International Debt Statistics',
      ),
      '/v2/sources/6/concepts': {
        source: [
          {
            name: 'International Debt Statistics',
            concept: ['Country', 'Counterpart-Area', 'Series', 'Time'].map((id) => ({ id })),
          },
        ],
      },
      '/v2/sources/6/counterpart-area': listing([
        ['005', 'Germany, Fed. Rep. of'],
        ['730', 'China'],
        ['905', IDA],
        ['WLD', 'World'],
      ]),
      '/v2/sources/6/country': listing([['ZMB', 'Zambia']]),
      '/v2/sources/6/time': listing([
        ['YR2022', '2022'],
        ['YR2023', '2023'],
      ]),
      '/v2/country': [{ page: 1, pages: 1, total: 0 }, []],
      [`${series}/730`]: observation('730', 'China', 5386396180.7),
      [`${series}/905`]: observation('905', IDA, 1),
      '/v2/source/57': [
        { page: 1, pages: 1, total: 1 },
        [{ id: '57', name: 'WDI Database Archives' }],
      ],
      '/v2/source/57/indicator/SM.POP.REFG.OR': catalogRow(
        'SM.POP.REFG.OR',
        '57',
        'WDI Database Archives',
      ),
      '/v2/sources/57/concepts': {
        source: [
          {
            name: 'WDI Database Archives',
            concept: ['Country', 'Series', 'Time', 'Version'].map((id) => ({ id })),
          },
        ],
      },
      '/v2/sources/57/version': listing([
        ['199309', '1994 Sep'],
        ['199409', '1994 Sep'],
      ]),
    };
    const ids = (dimension_value: string) => ({
      source_id: '6',
      indicator_id: 'DT.DOD.DPPG.CD',
      countries: 'ZMB',
      date_range: '2023',
      dimension_value,
    });
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

    beforeEach(() => {
      network.mockImplementation(async (url) => {
        const { pathname } = new URL(String(url));
        if (!(pathname in routes)) throw new Error(`Unrouted upstream request: ${url}`);
        return Response.json(routes[pathname]);
      });
    });

    it('serves a counterpart area named by its label, and its padded labels trimmed', async () => {
      const china = await runToolContract(worldbankGetData, ids('China'));
      expect(china.isError).not.toBe(true);
      expect(china.structuredContent).toMatchObject({
        sourceScoped: {
          dimension: { selection: 'requested', id: '730', label: 'China' },
        },
        data: [{ date: '2023', value: 5386396180.7 }],
      });
      expect(textOf(china)).toContain('**Counterpart-Area:** China (730) — selection: requested');
      expect(textOf(china)).toContain('- **2023:** 5386396180.7');

      const ida = await runToolContract(worldbankGetData, ids('905'));
      expect(ida.structuredContent).toMatchObject({
        sourceScoped: { dimension: { id: '905', label: 'World Bank-IDA' } },
        data: [{ dimension: { id: '905', label: 'World Bank-IDA' } }],
      });
      expect(textOf(ida)).toContain('**Counterpart-Area:** World Bank-IDA (905) — selection');
      expect(JSON.stringify(ida)).not.toMatch(/ |&#160;/);
    });

    it('pairs every id with its quoted label on both surfaces when nothing matches', async () => {
      const result = await runToolContract(worldbankGetData, ids('PRC'));
      const message =
        'dimension_value "PRC" is not a value "DT.DOD.DPPG.CD" can be queried at. Valid values — International Debt Statistics (source 6) Counterpart-Area: 005 "Germany, Fed. Rep. of", 730 "China", 905 "World Bank-IDA", WLD "World".';
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: {
            reason: 'unknown_dimension_value',
            validValues: [
              {
                sourceId: '6',
                concept: 'Counterpart-Area',
                ids: ['005', '730', '905', 'WLD'],
                values: [
                  { id: '005', label: 'Germany, Fed. Rep. of' },
                  { id: '730', label: 'China' },
                  { id: '905', label: 'World Bank-IDA' },
                  { id: 'WLD', label: 'World' },
                ],
              },
            ],
          },
        },
      });
      expect(textOf(result)).toContain(
        'Counterpart-Area: `005` "Germany, Fed. Rep. of", `730` "China", `905` "World Bank-IDA", `WLD` "World".',
      );
      expect(textOf(result)).toContain('reason unknown_dimension_value');
    });

    it('fails a label two releases share on both surfaces, before any data request', async () => {
      const result = await runToolContract(worldbankGetData, {
        source_id: '57',
        indicator_id: 'SM.POP.REFG.OR',
        countries: 'SDN',
        dimension_value: '1994 sep',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'ambiguous_dimension_value',
            sourceId: '57',
            concept: 'Version',
            ids: ['199309', '199409'],
            recovery: { hint: expect.stringContaining('ids the error message names') },
          },
        },
      });
      expect(textOf(result)).toContain('Version: `199309` "1994 Sep", `199409` "1994 Sep".');
      expect(textOf(result)).toContain('reason ambiguous_dimension_value');
      expect(network.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        '/v2/source/57',
        '/v2/sources/57/concepts',
        '/v2/source/57/indicator/SM.POP.REFG.OR',
        '/v2/sources/57/version',
      ]);
    });
  });

  it('surfaces exhausted source request timeouts instead of empty data', async () => {
    vi.useFakeTimers();
    network.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = runToolContract(worldbankGetData, {
      source_id: '50',
      indicator_id: 'SP.POP.TOTL',
      countries: 'US',
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(JSON.stringify(result)).not.toContain('source_not_found');
    expect(network).toHaveBeenCalledTimes(4);
  });
});
