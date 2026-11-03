/**
 * @fileoverview Endpoint page maxima and indicator search note excerpts.
 * @module services/response-budget
 */

/**
 * Most observations one worldbank_get_data page holds, on every data path — an
 * upstream page of the whole series, the rows a date window or `mrv`/`mrnev`
 * selects, and the source-scoped API's.
 */
export const MAX_OBSERVATIONS_PER_PAGE = 1000;

/** Most entries one worldbank_list_countries page holds. */
export const MAX_COUNTRIES_PER_PAGE = 300;

/** Most projects one worldbank_search_projects page holds, abstracts included. */
export const MAX_PROJECTS_PER_PAGE = 1000;

/** Most estimates one worldbank_get_poverty page holds. */
export const MAX_ESTIMATES_PER_PAGE = 1000;

/**
 * Characters of `sourceNote` a worldbank_search_indicators row carries. Matching
 * still reads the whole note, and worldbank_get_indicator returns it whole.
 */
export const INDICATOR_NOTE_EXCERPT_CHARS = 150;

/**
 * `text` cut to its first `maxChars` characters and marked with `…`, or unchanged
 * when it already fits. Whitespace the cut lands after is dropped before the mark.
 */
export function shorten(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}
