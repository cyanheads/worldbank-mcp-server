/**
 * @fileoverview The notice a capped tool attaches when it serves a smaller page
 * than the caller asked for, so every tool that reduces a page size discloses it
 * in the same words, and only when the reduction changed what the caller got.
 * @module mcp-server/tools/page-size-reduced-notice
 */

import { RESPONSE_BUDGET_KB } from '@/services/response-budget.js';

/**
 * Disclose a page size reduced to the cap, naming the page that continues this
 * one. `undefined` when there is nothing to disclose: the requested size was
 * served, or the whole result fits on one page at the served size, which is the
 * page the requested size would have served too.
 */
export function pageSizeReducedNotice(opts: {
  /** The page size asked for, requested or the server default. */
  requested: number;
  /** The page size served. */
  served: number;
  page: number;
  pages: number;
  /** When the cap applies, after "the most one page holds", e.g. `with include_abstract on`. */
  condition?: string;
}): string | undefined {
  const { requested, served, page, pages, condition } = opts;
  if (served >= requested || pages <= 1) return;
  const holds = condition ? `the most one page holds ${condition}` : 'the most one page holds';
  const continues =
    page < pages
      ? `, so page ${page + 1} with the same filters continues where this page ends`
      : '';
  return `per_page=${requested} was reduced to ${served}, ${holds}, to keep this response within about ${RESPONSE_BUDGET_KB} KB. totalPages counts pages of ${served}${continues}.`;
}
