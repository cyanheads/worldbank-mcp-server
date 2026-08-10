/**
 * @fileoverview Types for the World Bank Poverty and Inequality Platform (PIP)
 * API: the raw `/pip` row as the endpoint returns it, the structured body PIP
 * sends with an HTTP 404 for a rejected query parameter, and the normalized
 * row the service hands to the tool layer.
 * @module services/pip/types
 */

/**
 * One row of the `/pip` response. Every measure is nullable: the distributional
 * block (`gini`, `mld`, `polarization`, `decile1`–`decile10`) is populated only
 * on rows PIP derives from a survey directly, and comes back null on every
 * gap-filled row — including gap-filled rows for years a survey does exist for.
 */
export interface RawPipRow {
  country_code?: string | null;
  country_name?: string | null;
  decile1?: number | null;
  decile2?: number | null;
  decile3?: number | null;
  decile4?: number | null;
  decile5?: number | null;
  decile6?: number | null;
  decile7?: number | null;
  decile8?: number | null;
  decile9?: number | null;
  decile10?: number | null;
  estimation_type?: string | null;
  gini?: number | null;
  headcount?: number | null;
  is_interpolated?: boolean | null;
  mean?: number | null;
  median?: number | null;
  mld?: number | null;
  polarization?: number | null;
  poverty_gap?: number | null;
  poverty_line?: number | null;
  poverty_severity?: number | null;
  region_code?: string | null;
  region_name?: string | null;
  reporting_level?: string | null;
  reporting_pop?: number | null;
  reporting_year?: number | null;
  survey_acronym?: string | null;
  survey_year?: number | null;
  watts?: number | null;
  welfare_type?: string | null;
}

/**
 * Body PIP returns with HTTP 404 when a query parameter carries a value it
 * rejects. `details` is keyed by parameter name — one entry per rejected
 * parameter — and each entry's `valid` enumerates the accepted values, which
 * for `country` and `year` runs to hundreds of entries.
 */
export interface PipValidationBody {
  details?: Record<string, { msg?: string[]; valid?: unknown[] }>;
  error?: string[];
}

/** A single country × year × reporting-level poverty and inequality estimate. */
export interface PovertyRow {
  countryCode: string;
  countryName: string;
  /** Ten income/consumption shares, poorest decile first, or null when absent. */
  decileShares: number[] | null;
  /**
   * How PIP produced the row: `survey` carries the distributional block;
   * `interpolation`, `extrapolation`, and `CMD estimation` are gap-filled and
   * carry none. The last covers economies PIP has no survey for at all.
   */
  estimationType: string;
  gini: number | null;
  headcount: number | null;
  isInterpolated: boolean;
  mean: number | null;
  median: number | null;
  mld: number | null;
  polarization: number | null;
  population: number | null;
  povertyGap: number | null;
  povertyLine: number;
  povertySeverity: number | null;
  regionCode: string;
  regionName: string;
  /**
   * `national`, `urban`, or `rural`. Ten economies publish a split; only China
   * publishes all three, the rest pair `national` with one of the other two.
   */
  reportingLevel: string;
  reportingYear: number;
  surveyAcronym: string;
  /**
   * Year of the survey the estimate derives from, fractional when the survey
   * spans a fiscal year (India's 2022 survey reports `2022.58`). Null on a
   * gap-filled row, which is tied to no single survey.
   */
  surveyYear: number | null;
  watts: number | null;
  /** `income` or `consumption`, whichever the underlying survey measures. */
  welfareType: string;
}
