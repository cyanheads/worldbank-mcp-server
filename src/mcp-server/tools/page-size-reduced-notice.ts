/**
 * @fileoverview The notice a capped tool attaches when it serves a smaller page
 * than the caller asked for, so every tool that reduces a page size discloses it
 * in the same words, and only when the reduction changed what the caller got.
 * @module mcp-server/tools/page-size-reduced-notice
 */

/**
 * Disclose a page size reduced to the cap, naming the page that continues this
 * one. Empty and past-end results also disclose the clamp. Undefined when the
 * requested size was served.
 */
export function pageSizeReducedNotice(opts: {
  /** The page size asked for, requested or the server default. */
  requested: number;
  /** The page size served. */
  served: number;
  page: number;
  pages: number;
}): string | undefined {
  const { requested, served, page, pages } = opts;
  if (served >= requested) return;
  const continues =
    page < pages
      ? `, so page ${page + 1} with the same filters continues where this page ends`
      : '';
  return `per_page=${requested} was reduced to ${served}, the maximum page size. totalPages counts pages of ${served}${continues}.`;
}
