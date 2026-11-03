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
