/**
 * @fileoverview The server-authored prose a client loads with `tools/list`
 * before its first call: each tool's description, every description in its
 * served input and output schemas outside the framework's error envelope, and
 * the `when` text of its declared errors, in UTF-8 bytes. Measured on the
 * served surface, through the framework's HTTP app, and held under a ceiling.
 * @module tests/tools/tools-list-prose.test
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { describe, expect, it, vi } from 'vitest';
import { worldbankGetCountry } from '@/mcp-server/tools/definitions/worldbank-get-country.tool.js';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { worldbankGetIndicator } from '@/mcp-server/tools/definitions/worldbank-get-indicator.tool.js';
import { worldbankGetPoverty } from '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { worldbankListCountries } from '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { worldbankListSources } from '@/mcp-server/tools/definitions/worldbank-list-sources.tool.js';
import { worldbankListTopics } from '@/mcp-server/tools/definitions/worldbank-list-topics.tool.js';
import { worldbankSearchIndicators } from '@/mcp-server/tools/definitions/worldbank-search-indicators.tool.js';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';
import { type ServedTool, servedProseBytes } from '../helpers/served-prose.js';

/** The served defaults: `per_page` describes the clamp, as it does when no override is set. */
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ defaultPerPage: 50, clampLimits: true }),
}));

/**
 * Ceiling on the nine tools' server-authored prose, in UTF-8 bytes: the served
 * figure when the ceiling was last set, rounded up to the next 1,000 B. Prose
 * added past that slack fails here; a wording pass that cuts the figure lowers
 * the ceiling to the new figure, rounded the same way.
 */
const PROSE_CEILING_BYTES = 31_000;

const TOOLS = [
  worldbankListTopics,
  worldbankListSources,
  worldbankListCountries,
  worldbankGetCountry,
  worldbankSearchIndicators,
  worldbankGetIndicator,
  worldbankGetData,
  worldbankGetPoverty,
  worldbankSearchProjects,
];

/** The `tools/list` result a 2026-07-28 client reads for `tools`. */
async function servedTools(tools: readonly unknown[]): Promise<ServedTool[]> {
  const worker = createWorkerHandler({
    name: 'worldbank-mcp-server',
    title: 'worldbank-mcp-server',
    tools: tools as never,
  });
  const response = await worker.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
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
  return (JSON.parse(frame) as { result: { tools: ServedTool[] } }).result.tools;
}

describe('served tools/list prose', () => {
  it('counts the descriptions and when clauses a tool authors, and none of the framework envelope', async () => {
    const fixture = tool('fixture_tool', {
      description: 'Fixture prose.',
      annotations: { readOnlyHint: true },
      input: z.object({ query: z.string().describe('Query text.') }),
      output: z.object({
        rows: z
          .array(z.object({ description: z.string().describe('Café name.') }).describe('A row.'))
          .describe('Rows.'),
      }),
      errors: [
        {
          reason: 'first_reason',
          code: JsonRpcErrorCode.NotFound,
          when: 'First case',
          recovery: 'Take the first recovery step and retry.',
        },
        {
          reason: 'second_reason',
          code: JsonRpcErrorCode.ValidationError,
          when: 'Second case.',
          recovery: 'Take the second recovery step and retry.',
        },
      ],
      handler: async () => ({ rows: [] }),
    });
    const [served] = await servedTools([fixture]);

    /**
     * 'Fixture prose.' 14; 'Query text.' 11; 'Café name.' 11 (é is two bytes),
     * 'A row.' 6, 'Rows.' 5; 'First case.' 11 (the framework's terminating
     * period counted, as served), 'Second case.' 12.
     */
    expect(servedProseBytes(served as ServedTool)).toEqual({
      description: 14,
      input: 11,
      output: 22,
      when: 23,
      total: 70,
    });
  });

  it('keeps the nine tools under PROSE_CEILING_BYTES', async () => {
    const served = await servedTools(TOOLS);
    expect(served.map((entry) => entry.name).sort()).toEqual(TOOLS.map((def) => def.name).sort());

    const byTool = served.map((entry) => ({ name: entry.name, ...servedProseBytes(entry) }));
    const total = byTool.reduce((sum, row) => sum + row.total, 0);
    expect(total, JSON.stringify(byTool, null, 1)).toBeLessThanOrEqual(PROSE_CEILING_BYTES);
  });
});
