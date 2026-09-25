/**
 * @fileoverview Types for the World Bank Poverty and Inequality Platform (PIP)
 * API: the raw `/pip` and `/pip-grp` rows as the endpoints return them, the two
 * `/aux` reference tables the service reads, the structured body PIP sends with
 * an HTTP 404 for a rejected query parameter, and the normalized row the
 * service hands to the tool layer.
 * @module services/pip/types
 */

/**
 * One row of the `/pip` response. Every measure is nullable: the distributional
 * block (`gini`, `mld`, `polarization`, `decile1`–`decile10`) is populated only
 * on rows PIP derives from a survey directly, and comes back null on every
 * gap-filled row — including gap-filled rows for years a survey does exist for.
 */
export interface RawPipRow {
  comparable_spell?: string | null;
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
  survey_comparability?: number | null;
  survey_year?: number | null;
  watts?: number | null;
  welfare_type?: string | null;
}

/**
 * One entry of `/versions`: a data release (`release_version`, a `YYYYMMDD`
 * stamp) built at one PPP vintage (`ppp_version`), joined into the opaque
 * `version` string `/pip` accepts. Every release is listed once per vintage it
 * was built at.
 */
export interface RawPipVersion {
  identity?: string | null;
  ppp_version?: string | null;
  release_version?: string | null;
  version?: string | null;
}

/**
 * One row of `/pip-grp`: a regional, income-group, or lending-group aggregate
 * for one year. It carries the poverty measures, mean, and population, but no
 * median, distributional block, survey fields, welfare type, or reporting level.
 */
export interface RawPipGroupRow {
  estimate_type?: string | null;
  headcount?: number | null;
  mean?: number | null;
  pop_in_poverty?: number | null;
  poverty_gap?: number | null;
  poverty_line?: number | null;
  poverty_severity?: number | null;
  region_code?: string | null;
  region_name?: string | null;
  reporting_pop?: number | null;
  reporting_year?: number | null;
  watts?: number | null;
}

/**
 * One entry of `/aux?table=regions`: an aggregate code and the grouping it
 * belongs to — `region`, `africa_split`, `world`, `incgroup`, `ida`, `fcv`, or
 * `regionpcn`.
 */
export interface RawPipRegion {
  grouping_type?: string | null;
  region?: string | null;
  region_code?: string | null;
}

/**
 * One entry of `/aux?table=country_list`: an economy PIP publishes estimates
 * for, including those it publishes only as model estimates.
 */
export interface RawPipEconomy {
  country_code?: string | null;
  country_name?: string | null;
}

/** One rejected parameter's entry in a PIP 404 body. */
interface PipRejectedValue {
  msg?: string[];
  valid?: unknown[];
}

/**
 * Body PIP returns with HTTP 404 when a query parameter carries a value it
 * rejects. `details` is keyed by parameter name — one entry per rejected
 * parameter — and each entry's `valid` enumerates the accepted values: 200
 * codes for `country`, 66 for `year`. A rejected `version` breaks the shape and
 * answers with a single unkeyed entry that names no parameter.
 */
export interface PipValidationBody {
  details?: Record<string, PipRejectedValue> | PipRejectedValue;
  error?: string[];
}

/**
 * A single poverty and inequality estimate: one economy × year × reporting
 * level × welfare type, or one aggregate × year.
 */
export interface PovertyRow {
  /**
   * The span of years the row's comparable series covers, as PIP labels it
   * (`"2022"`, `"2011 - 2022"`). Null on a gap-filled row.
   */
  comparableSpell: string | null;
  /** The economy's ISO3 code, or the aggregate's code on an aggregate row. */
  countryCode: string;
  countryName: string;
  /** Ten income/consumption shares, poorest decile first, or null when absent. */
  decileShares: number[] | null;
  /**
   * How PIP produced the row. On an economy: `survey` carries the
   * distributional block; `interpolation`, `extrapolation`, and `CMD estimation`
   * are gap-filled and carry none, the last covering economies PIP has no
   * survey for at all. On an aggregate: `actual`, `nowcast`, or `projection`.
   */
  estimationType: string;
  gini: number | null;
  headcount: number | null;
  /** True on an aggregate row from `/pip-grp`, false on an economy row. */
  isAggregate: boolean;
  /** Null on an aggregate row, which publishes no such flag. */
  isInterpolated: boolean | null;
  mean: number | null;
  median: number | null;
  mld: number | null;
  polarization: number | null;
  /** People below the line, as PIP publishes it on aggregate rows; null on economy rows. */
  popInPoverty: number | null;
  population: number | null;
  povertyGap: number | null;
  povertyLine: number;
  povertySeverity: number | null;
  /** The economy's PIP region; null on an aggregate row. */
  regionCode: string | null;
  regionName: string | null;
  /**
   * `national`, `urban`, or `rural`. Ten economies publish a split; only China
   * publishes all three, the rest pair `national` with one of the other two.
   * Null on an aggregate row.
   */
  reportingLevel: string | null;
  reportingYear: number;
  surveyAcronym: string;
  /**
   * PIP's series comparability code within an economy: 0 is its oldest
   * comparable series, and the code steps up each time comparability breaks, so
   * two survey rows of one economy compare over time only when they share it.
   * Null on a gap-filled row.
   */
  surveyComparability: number | null;
  /**
   * Year of the survey the estimate derives from, fractional when the survey
   * spans a fiscal year (India's 2022 survey reports `2022.58`). Null on a
   * gap-filled row, which is tied to no single survey.
   */
  surveyYear: number | null;
  watts: number | null;
  /** `income` or `consumption`, whichever the underlying survey measures; null on an aggregate row. */
  welfareType: string | null;
}
