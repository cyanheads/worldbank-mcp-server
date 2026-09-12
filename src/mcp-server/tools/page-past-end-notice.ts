/**
 * @fileoverview The notice a paginated tool attaches to an empty page requested
 * past the end of a non-empty result. It is distinct from each tool's zero-match
 * notice, which only a total of zero may use: an empty page alone does not mean
 * the filters matched nothing.
 * @module mcp-server/tools/page-past-end-notice
 */

/** Describe a page past the end of `total` results, naming the page range that exists. */
export function pagePastEndNotice(opts: {
  /** Singular and plural of what the tool lists, e.g. `['estimate', 'estimates']`. */
  noun: readonly [singular: string, plural: string];
  page: number;
  pages: number;
  perPage: number;
  total: number;
}): string {
  const { noun, page, pages, perPage, total } = opts;
  const counted = total === 1 ? `1 ${noun[0]} spans` : `${total} ${noun[1]} span`;
  const range = pages === 1 ? '1 page' : `${pages} pages (1–${pages})`;
  const request = pages === 1 ? 'page 1' : `a page from 1 to ${pages}`;
  return `Page ${page} is past the end of the results — ${counted} ${range} at per_page=${perPage}. Keep the same filters and request ${request}.`;
}
