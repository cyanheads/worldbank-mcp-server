/**
 * @fileoverview Page-size caps for worldbank_search_projects and
 * worldbank_get_poverty, the two tools whose rows are large enough to push one
 * response past a practical context budget.
 *
 * The budget is {@link RESPONSE_BUDGET_KB} per response surface — `content[]`
 * text or serialized `structuredContent`, either of which a client may hand to
 * the model alone. Each cap is fixed per request shape rather than fitted to the
 * rows a page happens to hold: a cap that shrank with the data would change the
 * page size from page to page, and `page + 1` would skip or repeat rows. A fixed
 * cap keeps `(page - 1) × cap` contiguous whether a caller follows the echoed
 * page size or keeps sending its original `per_page`. The price is sizing to the
 * worst case — each cap is the largest whose heaviest run of consecutive rows in
 * the live data rendered under the budget with headroom to spare. The
 * measurements are recorded in docs/design.md.
 * @module services/response-budget
 */

/** Per-surface response budget the caps below are sized against. */
export const RESPONSE_BUDGET_KB = 50;

/** Most projects one worldbank_search_projects page holds without abstracts. */
export const MAX_PROJECTS_PER_PAGE = 80;

/**
 * Most projects one worldbank_search_projects page holds with abstracts. Abstracts
 * are never shortened; the budget is met with fewer rows instead.
 */
export const MAX_PROJECTS_PER_PAGE_WITH_ABSTRACT = 8;

/** Most estimates one worldbank_get_poverty page holds. */
export const MAX_ESTIMATES_PER_PAGE = 70;
