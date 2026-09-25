/**
 * @fileoverview Service errors as a client receives them. worldbank_get_poverty
 * and worldbank_search_projects run against their real services with only the
 * network stubbed, so each upstream rejection passes through the framework's
 * real error-body capture, the service's classification, the tool's re-throw,
 * and the framework's error assembly before anything is asserted.
 * @module tests/tools/service-errors-on-the-wire.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldbankGetPoverty } from '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';
import { initPipService } from '@/services/pip/pip-service.js';
import { initProjectsService } from '@/services/projects/projects-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    apiBaseUrl: 'https://api.worldbank.org/v2',
    pipBaseUrl: 'https://api.worldbank.org/pip/v1',
    projectsBaseUrl: 'https://search.worldbank.org/api/v3',
    defaultPerPage: 50,
    catalogCacheTtlMs: 60_000,
  }),
}));

// ─── PIP fixtures ─────────────────────────────────────────────────────────────

/** The newest release in the `/versions` listing, built at two PPP vintages. */
const VERSIONS = [
  {
    version: '20260922_2021_01_02_PROD',
    release_version: '20260922',
    ppp_version: '2021',
    identity: 'PROD',
  },
  {
    version: '20260922_2017_01_02_PROD',
    release_version: '20260922',
    ppp_version: '2017',
    identity: 'PROD',
  },
];

const YEARS = Array.from({ length: 64 }, (_, index) => String(1963 + index));

/** One `details` entry of a PIP 404, as PIP words it. */
function rejected(parameter: string, valid: unknown[]) {
  return {
    [parameter]: {
      msg: [`You supplied an invalid value for ${parameter}. Please use one of the valid values.`],
      valid,
    },
  };
}

/** A PIP 404 body rejecting the given parameters. */
function rejectionBody(details: Record<string, unknown>) {
  return JSON.stringify({ error: ['Invalid query arguments have been submitted.'], details });
}

/** PIP's 404 for a year outside release 20260922 — 635 bytes, past the framework's 500-byte capture. */
const YEAR_REJECTION = rejectionBody(rejected('year', ['all', 'MRV', ...YEARS]));

/** 200 three-letter codes, standing in for PIP's `country` list. */
const COUNTRY_CODES = Array.from(
  { length: 200 },
  (_, index) =>
    `C${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
);

// ─── Network stub ─────────────────────────────────────────────────────────────

const fetchMock = vi.fn<typeof fetch>();

/**
 * Answer `/versions` and the two `/aux` tables from fixtures and every `/pip`
 * request with `pip`. The regions table holds one aggregate and the economy list
 * holds `KEN` alone, so every other code reads as one PIP does not publish.
 */
function servePip(pip: () => Response) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.worldbank.org/pip/v1/versions')) {
      return Response.json(VERSIONS);
    }
    if (url.startsWith('https://api.worldbank.org/pip/v1/aux?table=regions')) {
      return Response.json([{ region_code: 'WLD', region: 'World', grouping_type: 'world' }]);
    }
    if (url.startsWith('https://api.worldbank.org/pip/v1/aux?table=country_list')) {
      return Response.json([{ country_code: 'KEN', country_name: 'Kenya' }]);
    }
    if (url.startsWith('https://api.worldbank.org/pip/v1/pip?')) return pip();
    throw new Error(`unmocked fetch: ${url}`);
  });
}

/** Answer every Projects API request with `projects`. */
function serveProjects(projects: () => Response) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://search.worldbank.org/api/v3/projects?')) return projects();
    throw new Error(`unmocked fetch: ${url}`);
  });
}

function notFoundResponse(body: string) {
  return new Response(body, { status: 404, headers: { 'content-type': 'application/json' } });
}

type WireError = { code: number; message: string; data: Record<string, unknown> };

/** The error envelope and the whole content[] text of a failed call. */
function failure(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: WireError }).error;
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
  return { error, text };
}

describe('service errors on the wire', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchMock);
    initPipService({} as never, createInMemoryStorage());
    initProjectsService({} as never, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── worldbank_get_poverty ────────────────────────────────────────────────

  it('uses a year fixture the size of the real rejection, past the default capture', () => {
    expect(YEAR_REJECTION).toHaveLength(635);
  });

  it('keeps reason, recovery, and the queried countries on a country rejection', async () => {
    servePip(() => notFoundResponse(rejectionBody(rejected('country', COUNTRY_CODES))));
    const { error, text } = failure(
      await runToolContract(worldbankGetPoverty, { countries: 'ZZZ' }),
    );

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'country_not_found',
      countries: ['ZZZ'],
      recovery: { hint: expect.stringContaining('worldbank_list_countries') },
    });
    expect(text).toContain('PIP does not recognize the country code(s) "ZZZ"');
  });

  it("forwards the service's retryable flag and country codes on a country rejection", async () => {
    servePip(() => notFoundResponse(rejectionBody(rejected('country', COUNTRY_CODES))));
    const { error, text } = failure(
      await runToolContract(worldbankGetPoverty, { countries: 'ZZZ' }),
    );

    expect(error.data).toMatchObject({ retryable: false, countryCodes: 'ZZZ' });
    expect(text.trimEnd()).toMatch(/\(reason country_not_found · not retryable\)$/);
  });

  it.each(['1950', '2027'])(
    'names the span PIP accepts when it rejects year %s, and points the recovery at it',
    async (year) => {
      servePip(() => notFoundResponse(YEAR_REJECTION));
      const { error, text } = failure(
        await runToolContract(worldbankGetPoverty, { countries: 'KEN', year }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toContain('year accepts all, MRV, 1963–2026');
      expect(error.data).toMatchObject({
        reason: 'invalid_parameter',
        parameters: ['year'],
        acceptedValues: { year: ['all', 'MRV', '1963–2026'] },
        retryable: false,
        countries: ['KEN'],
        recovery: {
          hint: expect.stringMatching(/Set year to one of the values the message lists/),
        },
      });
      expect(text).toMatch(/Recovery: Set year to one of the values the message lists/);
      expect(text.trimEnd()).toMatch(/\(reason invalid_parameter · not retryable\)$/);
    },
  );

  it('quotes every short list when PIP rejects several parameters at once', async () => {
    servePip(() =>
      notFoundResponse(
        rejectionBody({
          ...rejected('year', ['all', 'MRV', ...YEARS]),
          ...rejected('welfare_type', ['all', 'consumption', 'income']),
          ...rejected('reporting_level', ['all', 'national', 'rural', 'urban']),
        }),
      ),
    );
    const { error } = failure(
      await runToolContract(worldbankGetPoverty, { countries: 'KEN', year: '1950' }),
    );

    expect(error.message).toBe(
      'PIP rejected the value supplied for year, welfare_type, reporting_level. Accepted values: year accepts all, MRV, 1963–2026; welfare_type accepts all, consumption, income; reporting_level accepts all, national, rural, urban.',
    );
    expect(error.data.parameters).toEqual(['year', 'welfare_type', 'reporting_level']);
    expect((error.data.recovery as { hint: string }).hint).toMatch(
      /^Set year, welfare_type, reporting_level to one of the values the message lists/,
    );
  });

  it('keeps a recovery clear of listed values when the rejection lists none', async () => {
    const letters = Array.from({ length: 20 }, (_, index) => String.fromCharCode(97 + index));
    servePip(() => notFoundResponse(rejectionBody(rejected('year', letters))));
    const { error, text } = failure(
      await runToolContract(worldbankGetPoverty, { countries: 'KEN', year: '1950' }),
    );

    expect(error.message).toBe('PIP rejected the value supplied for year.');
    expect(error.data).not.toHaveProperty('acceptedValues');
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toBe(
      worldbankGetPoverty.errors?.find((entry) => entry.reason === 'invalid_parameter')?.recovery,
    );
    expect(hint).not.toMatch(/message/);
    expect(text).not.toMatch(/values the message lists/);
  });

  it('names only the parameter it can see listed values for, and asks for the rest to be corrected', async () => {
    const letters = Array.from({ length: 20 }, (_, index) => String.fromCharCode(97 + index));
    servePip(() =>
      notFoundResponse(
        rejectionBody({
          ...rejected('povline', letters),
          ...rejected('year', ['all', 'MRV', ...YEARS]),
        }),
      ),
    );
    const { error } = failure(
      await runToolContract(worldbankGetPoverty, { countries: 'KEN', year: '1950' }),
    );

    expect(error.data.acceptedValues).toEqual({ year: ['all', 'MRV', '1963–2026'] });
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toMatch(/^Set year to one of the values the message lists/);
    expect(hint).toMatch(/Correct povline/);
  });

  it('reports an unkeyed rejection as an unnamed parameter, never as one called details', async () => {
    servePip(() =>
      notFoundResponse(
        JSON.stringify({
          error: ['Invalid query arguments have been submitted.'],
          details: {
            msg: ['The selected value is not available.'],
            valid: VERSIONS,
          },
        }),
      ),
    );
    const { error } = failure(await runToolContract(worldbankGetPoverty, { countries: 'KEN' }));

    expect(error.message).toBe('PIP rejected the value supplied for a query parameter.');
    expect(error.data.parameters).toEqual([]);
    expect((error.data.recovery as { hint: string }).hint).not.toMatch(/message lists/);
  });

  it('still classifies a rejection naming country alongside other parameters as country_not_found', async () => {
    servePip(() =>
      notFoundResponse(
        rejectionBody({
          ...rejected('country', COUNTRY_CODES),
          ...rejected('year', ['all', 'MRV', ...YEARS]),
        }),
      ),
    );
    const { error } = failure(
      await runToolContract(worldbankGetPoverty, { countries: 'ZZZ', year: '1950' }),
    );
    expect(error.data.reason).toBe('country_not_found');
  });

  it("forwards the service's vintages and release when ppp_version is unavailable", async () => {
    servePip(() => {
      throw new Error('no /pip request expected');
    });
    const { error, text } = failure(
      await runToolContract(worldbankGetPoverty, { countries: 'KEN', ppp_version: '2011' }),
    );

    expect(error.data).toMatchObject({
      reason: 'ppp_version_unavailable',
      retryable: false,
      availablePppVersions: ['2021', '2017'],
      releaseVersion: '20260922',
      countries: ['KEN'],
      recovery: { hint: expect.stringContaining('omit ppp_version') },
    });
    expect(text.trimEnd()).toMatch(/\(reason ppp_version_unavailable · not retryable\)$/);
  });

  // ─── worldbank_search_projects ────────────────────────────────────────────

  it('forwards the status and retryable flag of a Projects API 4xx', async () => {
    serveProjects(() => new Response('{"error":"bad request"}', { status: 400 }));
    const { error, text } = failure(
      await runToolContract(worldbankSearchProjects, { query: 'water [' }),
    );

    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 400,
      retryable: false,
    });
    expect(text.trimEnd()).toMatch(/\(reason upstream_unavailable · not retryable\)$/);
    // A refused search fails the same way every time, and its query is what to change.
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).not.toMatch(/retry the same search/i);
    expect(hint).not.toMatch(/no change to the search will help/i);
    expect(hint).toMatch(/query/);
    expect(text).toContain(`Recovery: ${hint}`);
    // The upstream body names the search cluster behind the API and stays out.
    expect(JSON.stringify(error)).not.toContain('bad request');
  });

  it('forwards the page, page size, and retryable flag of a page past the offset limit', async () => {
    const { error, text } = failure(
      await runToolContract(worldbankSearchProjects, { page: 1252, per_page: 1000 }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.data).toMatchObject({
      reason: 'page_out_of_range',
      page: 1252,
      perPage: 80,
      retryable: false,
      recovery: { hint: expect.stringContaining('Lower the page number') },
    });
    expect(text.trimEnd()).toMatch(/\(reason page_out_of_range · not retryable\)$/);
  });
});
