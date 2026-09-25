/**
 * @fileoverview Types for the World Bank Projects API: the raw project record as
 * the endpoint returns it, the envelope it arrives in — which keys its results by
 * project ID rather than listing them — and the normalized summary the service
 * hands to the tool layer.
 * @module services/projects/types
 */

/** One entry of a project's `major_sectors` array, nested a level deeper than it needs to be. */
export interface RawMajorSector {
  major_sector?: {
    major_sector_code?: string | null;
    major_sector_name?: string | null;
  } | null;
}

/**
 * One project record, as the endpoint returns it under the requested `fl` field
 * list. Every field is optional: coverage is uneven across a portfolio that
 * reaches back to 1947. Measured over all 28,074 records, only `id`,
 * `project_name`, `status`, `countryname`, `countrycode`, and `regionname` are
 * present on every row; `boardapprovaldate` is absent on 2%, `major_sectors` on
 * 17%, `projectfinancialtype` on 36%, `closingdate` on 44%, and
 * `project_abstract` on 48%. `curr_total_commitment` and `grantamt` are absent
 * on 35.8% of 28,153 records (2026-09-25), always on the same rows.
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
  closingdate?: string | null;
  countrycode?: string[] | null;
  countryname?: string | null;
  curr_ibrd_commitment?: string | null;
  curr_ida_commitment?: string | null;
  curr_total_commitment?: string | null;
  grantamt?: string | null;
  id?: string | null;
  major_sectors?: RawMajorSector[] | null;
  project_abstract?: string | null;
  project_name?: string | null;
  projectfinancialtype?: string[] | null;
  regionname?: string | null;
  status?: string | null;
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

/** One project as the tool layer consumes it. */
export interface ProjectSummary {
  /**
   * Project abstract. Null when `includeAbstract` was not requested and when the
   * project publishes none, which the echoed `includeAbstract` filter separates.
   */
  abstract: string | null;
  /** Board approval date as `YYYY-MM-DD`, narrowed from the upstream timestamp. */
  boardApprovalDate: string | null;
  closingDate: string | null;
  /**
   * Two-character codes: the WDI ISO2 code for an economy — the four legacy
   * portfolio codes (`RY`, `ZR`, `GZ`, `TP`) translated back to it — or a World
   * Bank regional code such as `3A` for a multi-country operation. Upstream
   * publishes a list; every project in the portfolio carries exactly one entry.
   */
  countryCodes: string[];
  countryName: string;
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
  /** Major sector names, deduplicated, in the order upstream lists them. */
  majorSectors: string[];
  name: string;
  regionName: string;
  /** `Active`, `Closed`, `Dropped`, or `Pipeline`. */
  status: string;
  /**
   * Commitment amount in USD as the project page reports it: IBRD + IDA + the
   * grant amount. Null on projects that publish no commitment amount.
   */
  totalCommitment: number | null;
  /** Canonical project page on projects.worldbank.org. */
  url: string;
}
