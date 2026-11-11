/**
 * @fileoverview The `per_page` input every paged tool shares: its schema, and the
 * clamp that serves a larger size — or a larger server default — at the tool's
 * page maximum, logging and counting each reduction. Under
 * `WORLDBANK_CLAMP_LIMITS=false` the schema advertises the maximum and rejects a
 * larger value instead. `pageSizeReducedNotice` words the disclosure.
 * @module mcp-server/tools/per-page
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const clampedCalls = createCounter(
  'worldbank.per_page.clamped',
  'Tool calls whose per_page, or the server default, exceeded the page maximum and was served at it.',
  '{calls}',
);

/**
 * The optional `per_page` input of a tool whose pages hold at most `cap` rows.
 * While clamping it advertises no maximum and accepts any positive integer;
 * under `WORLDBANK_CLAMP_LIMITS=false` it advertises `maximum: cap` and rejects a
 * larger value with Zod's own `too_big` issue. The config is read when the schema
 * is serialized or a value is checked, never at import.
 */
export function perPageInput(cap: number) {
  const clamping = () => getServerConfig().clampLimits;
  return z
    .number()
    .int()
    .min(1)
    .check((payload) => {
      if (payload.value > cap && !clamping())
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: cap,
          inclusive: true,
          input: payload.value,
        });
    })
    .optional()
    .meta({
      /** Replaces the 2^53 − 1 that `.int()` advertises, which no page serves. */
      get maximum() {
        return clamping() ? undefined : cap;
      },
      get description() {
        return clamping()
          ? `Results per page (default: server default). Positive integers above ${cap} are served at that maximum with the requested and served sizes echoed and a notice. totalPages uses the served size.`
          : `Results per page (default: server default, max: ${cap}).`;
      },
    });
}

/** The page size a call asked for, and the size it is served at. */
export interface PageSize {
  /** `per_page` as sent, or the server default when it was omitted. */
  requested: number;
  /** `requested`, reduced to the tool's page maximum when larger. */
  served: number;
}

/**
 * The page size `tool`, whose pages hold at most `cap` rows, serves for `perPage`
 * or, when it is undefined, the server default. A reduction logs one notice and
 * adds one to `worldbank.per_page.clamped`, labelled with `tool`.
 */
export function resolvePerPage(
  limit: { tool: string; cap: number; perPage: number | undefined },
  ctx: Context,
): PageSize {
  const requested = limit.perPage ?? getServerConfig().defaultPerPage;
  if (requested <= limit.cap) return { requested, served: requested };
  ctx.log.notice('Page size reduced to the page maximum', {
    requestedPerPage: requested,
    servedPerPage: limit.cap,
    fromServerDefault: limit.perPage === undefined,
  });
  clampedCalls.add(1, { [ATTR_MCP_TOOL_NAME]: limit.tool });
  return { requested, served: limit.cap };
}
