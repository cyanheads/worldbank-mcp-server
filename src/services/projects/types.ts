/**
 * @fileoverview Types for the World Bank Projects API: the raw project record as
 * the endpoint returns it, the envelope it arrives in — which keys its results by
 * project ID rather than listing them — and the normalized summary the service
 * hands to the tool layer.
 * @module services/projects/types
 */

/**
 * One sub-sector a project lists under a major sector. Measured over all 57,987
 * entries (2026-11-11): every entry carries all three fields, and the share is a
 * numeric string (`"38.0"`, `"0"`). Eight current names are stored with a
 * trailing space (`"Other - Industry, Trade, and Services "`), which the
 * `sector_exact` filter matches only as stored.
 */
export interface RawSector {
  sector_code?: string | null;
  sector_name?: string | null;
  sector_percent?: string | null;
}

/** One entry of a project's `major_sectors` array, nested a level deeper than it needs to be. */
export interface RawMajorSector {
  major_sector?: {
    major_sector_code?: string | null;
    major_sector_name?: string | null;
    sectors?: RawSector[] | null;
  } | null;
}

/**
 * One theme a project is tagged with, at any of `theme_list`'s three levels.
 * Measured over 2,646 active projects (2026-11-19): every entry carries a name
 * and a code, while the share, a numeric string, is absent on 942 of 49,497
 * entries and exceeds 100 on a few FY17 ones (`"300"`). Two taxonomies never mix
 * on one project — current names with six-digit codes (`240102`) and `FY17 - `
 * names with two- or three-digit codes (`812`) — and 23 current names are stored
 * only with a leading space, which `theme_exact` matches only as stored. The
 * upstream `seqno` ordinal is not read.
 */
export interface RawTheme {
  code?: string | null;
  name?: string | null;
  percent?: string | null;
}

/** A level-2 `theme2` entry, with the level-3 themes listed under it. */
export interface RawTheme2 extends RawTheme {
  theme3?: RawTheme[] | null;
}

/** A level-1 `theme_list` entry, with the level-2 themes listed under it. */
export interface RawTheme1 extends RawTheme {
  theme2?: RawTheme2[] | null;
}

/**
 * One project record, as the endpoint returns it under the requested `fl` field
 * list. Every field is optional: coverage is uneven across a portfolio that
 * reaches back to 1947. Measured over all 28,074 records, only `id`,
 * `project_name`, `status`, `countryname`, `countrycode`, and `regionname` are
 * present on every row; `boardapprovaldate` is absent on 2%, `major_sectors` on
 * 17%, `projectfinancialtype` on 36%, `closingdate` on 44%, and
 * `project_abstract` on 48%. `curr_total_commitment` and `grantamt` are absent
 * on 35.8% of 28,153 records (2026-09-25), always on the same rows. `pdo`, the
 * development objective, comes back only when `fl` names it, and is absent on
 * 42% of 28,238 records (2026-11-11) — on 6% of active operations; 163 values
 * carry HTML tags or entities. `theme_list` is absent on 159 of 2,646 active
 * operations (2026-11-19), most of them approved this year, though the index
 * still tags some of those under `theme_exact`.
 *
 * `curr_total_commitment` is the project page's "Commitment Amount": IBRD plus
 * IDA (`curr_ibrd_commitment` + `curr_ida_commitment`, IDA grants included)
 * plus `grantamt`, which holds trust-fund grants and, on some operations, other
 * agencies' co-financing. It is not requested as `totalamt`, the IBRD + IDA
 * figure alone, which is null on grant-only operations.
 *
 * Monetary and date values arrive as strings, not numbers or timestamps.
 */
export interface RawProject {
  boardapprovaldate?: string | null;
  borrower?: string | null;
  closingdate?: string | null;
  countrycode?: string[] | null;
  countryname?: string | null;
  curr_ibrd_commitment?: string | null;
  curr_ida_commitment?: string | null;
  curr_project_cost?: string | null;
  curr_total_commitment?: string | null;
  esrc_ovrl_risk_rate?: string | null;
  grantamt?: string | null;
  id?: string | null;
  impagency?: string | null;
  major_sectors?: RawMajorSector[] | null;
  parentprojid?: string | null;
  pdo?: string | null;
  project_abstract?: string | null;
  project_name?: string | null;
  projectfinancialtype?: string[] | null;
  regionname?: string | null;
  status?: string | null;
  theme_list?: RawTheme1[] | null;
}

/**
 * The Projects API response envelope. `projects` is an object keyed by project
 * ID rather than an array, and `total`, `os`, and `page` are strings — the
 * service normalizes both before anything downstream sees the payload.
 */
export interface RawProjectsEnvelope {
  os?: string;
  page?: string;
  projects?: Record<string, RawProject>;
  rows?: number;
  total?: string;
}

/** One sub-sector of a project, as the tool layer consumes it. */
export interface ProjectSector {
  /** Sector code, e.g. `EEP`. */
  code: string;
  /** The major sector name it is listed under, as `majorSectors` spells it. */
  majorSector: string;
  /** Sector name, trimmed, any `FY17 - ` prefix kept: the value the `sector` filter takes. */
  name: string;
  /**
   * Share of the project's commitment, in percent. Null on every entry of a
   * project whose shares are all zero, which publishes no split — 6,227 of
   * 23,377 sectored projects (2026-11-11); a zero inside a published split stays 0.
   */
  percent: number | null;
}

/** One theme of a project, any level, as the tool layer consumes it. */
export interface ProjectTheme {
  /** Theme code: six digits in the current taxonomy (`240102`), two or three in FY17 (`812`). */
  code: string;
  /** Theme name, trimmed, any `FY17 - ` prefix kept: the value the `theme` filter takes. */
  name: string;
  /**
   * Name of the theme one level up, trimmed; null at level 1. A name listed at
   * two levels (`Rural Development`) yields two entries this tells apart.
   */
  parent: string | null;
  /**
   * The share upstream publishes, in percent. Shares overlap rather than split:
   * they sum past 100 within a level, and a few FY17 entries exceed 100 on
   * their own. Null where none is published, and on every entry of a project
   * whose shares are all zero or absent; a zero inside a published split stays 0.
   */
  percent: number | null;
}

/** One project as the tool layer consumes it. */
export interface ProjectSummary {
  /**
   * Project abstract as plain text. Null when `includeAbstract` was not
   * requested and when the project publishes none, which the echoed
   * `includeAbstract` filter separates.
   */
  abstract: string | null;
  /** Board approval date as `YYYY-MM-DD`, narrowed from the upstream timestamp. */
  boardApprovalDate: string | null;
  borrower: string | null;
  closingDate: string | null;
  /**
   * Two-character codes: the WDI ISO2 code for an economy — the four legacy
   * portfolio codes (`RY`, `ZR`, `GZ`, `TP`) translated back to it — or a World
   * Bank regional code such as `3W` for a multi-country operation. Upstream
   * publishes a list; every project in the portfolio carries exactly one entry.
   */
  countryCodes: string[];
  countryName: string;
  /** Overall environmental and social risk code as published. */
  esRiskRating: string | null;
  /** `IBRD`, `IDA`, `Grants`, or `Other`; a project may carry more than one. */
  financialTypes: string[];
  /**
   * `grantamt` in USD: trust-fund grants and, on some operations, other
   * agencies' co-financing. Not the amount behind the `Grants` financing window.
   */
  grantAmount: number | null;
  /** IBRD commitment in USD. */
  ibrdCommitment: number | null;
  /** World Bank project ID, e.g. `P513206`. */
  id: string;
  /** IDA commitment in USD, IDA grants included. */
  idaCommitment: number | null;
  implementingAgency: string | null;
  /** Major sector names, deduplicated, in the order upstream lists them. */
  majorSectors: string[];
  name: string;
  /** Project development objective (`pdo`) as plain text, trimmed; null when none is published. */
  objective: string | null;
  parentProjectId: string | null;
  /** Reported cost in USD, including Bank and non-Bank funding. */
  projectCost: number | null;
  regionName: string;
  /** Sub-sectors in upstream order, each under its major sector; empty when none are published. */
  sectors: ProjectSector[];
  /** `Active`, `Closed`, `Dropped`, or `Pipeline`. */
  status: string;
  /**
   * The three-level theme classification flattened depth-first in upstream
   * order, each entry naming its parent. Null when `includeThemes` was not
   * requested; empty when the project publishes no `theme_list`.
   */
  themes: ProjectTheme[] | null;
  /**
   * Commitment amount in USD as the project page reports it: IBRD + IDA + the
   * grant amount. Null on projects that publish no commitment amount.
   */
  totalCommitment: number | null;
  /** Canonical project page on projects.worldbank.org. */
  url: string;
}
