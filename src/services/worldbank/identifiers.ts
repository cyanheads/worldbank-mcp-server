/**
 * @fileoverview Input shapes for World Bank identifiers. Each pattern admits the
 * shape real identifiers take and nothing wider, since an ID that escapes into a
 * path upstream can't route answers with an error page rather than the
 * invalid-value envelope. The `all` collection keyword fits the country and
 * indicator shapes, so it is refused in the handlers, where the rejection carries
 * a declared reason and recovery hint a schema rejection cannot.
 * @module services/worldbank/identifiers
 */

/**
 * One country or aggregate code. Every entity `/country` lists has a
 * three-character ID and a two-character ISO2 code of letters and digits
 * (`USA`/`US`, `WLD`/`1W`).
 */
export const COUNTRY_CODE = /^[A-Za-z0-9]{2,3}$/;

export const COUNTRY_CODE_MESSAGE =
  'Pass one ISO2, ISO3, or aggregate code of 2–3 letters or digits, not a list of codes. Use worldbank_list_countries to browse countries, or worldbank_get_data to query several at once.';

/**
 * A `countries` value that holds at least one code: some character that is
 * neither whitespace nor one of the separators {@link splitCountryCodes} splits
 * on. The schema pattern of the tools that require a code.
 */
export const COUNTRY_LIST_CONTENT = /[^\s;,|]/;

/**
 * Split a `countries` value, a string or every element of an array, into codes.
 * Comma, semicolon, and pipe all separate codes, since no country or aggregate
 * code contains any of them; surrounding whitespace and blank segments drop out.
 */
export function splitCountryCodes(value: string | readonly string[]): string[] {
  return [value]
    .flat()
    .flatMap((part) => part.split(/[;,|]/))
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

/**
 * One indicator ID. All 29,544 catalog IDs use only letters, digits, `.`, `_`,
 * and `-` (`NY.GDP.PCAP.CD`, `CoCA_fexp`, `3.0.Rate75-25`). Anything else is
 * either a list, or a character that escapes into a path upstream answers with
 * HTTP 404 (`/`, `%`) or 403 (`?`).
 */
export const INDICATOR_ID = /^[A-Za-z0-9._-]+$/;

export const INDICATOR_ID_MESSAGE =
  'Pass one indicator ID made of letters, digits, ".", "_", or "-" (e.g. NY.GDP.PCAP.CD), not a list of IDs. Use worldbank_search_indicators to find indicator IDs.';

/** True for the `all` keyword, which selects a whole collection rather than one item. */
export function isAllSelector(value: string): boolean {
  return value.toLowerCase() === 'all';
}

/**
 * A topic or source ID filter. All 21 topics and 71 sources have numeric IDs.
 * Blank and surrounding whitespace pass because form clients submit every field
 * and the handler trims, reading blank as no filter.
 */
export const CATALOG_FILTER_ID = /^\s*\d*\s*$/;

export const TOPIC_ID_MESSAGE =
  'topic_id is a numeric topic ID (e.g. "3"). Use worldbank_list_topics to browse valid IDs.';

export const SOURCE_ID_MESSAGE =
  'source_id is a numeric source ID (e.g. "2"). Use worldbank_list_sources to browse valid IDs.';
