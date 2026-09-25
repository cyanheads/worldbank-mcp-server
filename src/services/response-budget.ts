/**
 * @fileoverview The per-response budget and what keeps each paged tool inside
 * it: page-size caps for worldbank_get_data, worldbank_list_countries,
 * worldbank_search_projects, and worldbank_get_poverty, and text ceilings for
 * the long prose fields of worldbank_search_indicators and
 * worldbank_search_projects.
 *
 * The budget is {@link RESPONSE_BUDGET_KB} per response surface — `content[]`
 * text or serialized `structuredContent`, either of which a client may hand to
 * the model alone. Each cap is fixed per request shape rather than fitted to the
 * rows a page happens to hold: a cap that shrank with the data would change the
 * page size from page to page, and `page + 1` would skip or repeat rows. A fixed
 * cap keeps `(page - 1) × cap` contiguous whether a caller follows the echoed
 * page size or keeps sending its original `per_page`. The price is sizing to the
 * worst case — each cap is the largest whose heaviest run of consecutive rows in
 * the live data, or whose heaviest measured row times the cap, rendered under
 * the budget with headroom to spare. Where rows are too uneven for a useful cap,
 * the long field is shortened instead and the page keeps its size. The
 * measurements are recorded in docs/design.md.
 * @module services/response-budget
 */

/** Per-surface response budget the caps below are sized against. */
export const RESPONSE_BUDGET_KB = 50;

/**
 * Most observations one worldbank_get_data page holds, on every data path — the
 * standard endpoint, a re-read date window, and the source-scoped API.
 */
export const MAX_OBSERVATIONS_PER_PAGE = 200;

/** Most entries one worldbank_list_countries page holds. */
export const MAX_COUNTRIES_PER_PAGE = 150;

/** Most projects one worldbank_search_projects page holds without abstracts. */
export const MAX_PROJECTS_PER_PAGE = 80;

/** Most projects one worldbank_search_projects page holds with abstracts. */
export const MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT = 8;

/** Most estimates one worldbank_get_poverty page holds. */
export const MAX_ESTIMATES_PER_PAGE = 70;

/**
 * Characters of `sourceNote` a worldbank_search_indicators row carries. Matching
 * still reads the whole note, and worldbank_get_indicator returns it whole.
 */
export const INDICATOR_NOTE_EXCERPT_CHARS = 150;

/** Characters of an abstract a worldbank_search_projects row carries. */
export const MAX_ABSTRACT_CHARS = 5000;

/**
 * `text` cut to its first `maxChars` characters and marked with `…`, or unchanged
 * when it already fits. Whitespace the cut lands after is dropped before the mark.
 */
export function shorten(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}
