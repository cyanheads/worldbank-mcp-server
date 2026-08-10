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
 * 17%, `projectfinancialtype` on 36%, `closingdate` on 44%, `project_abstract`
 * on 48%, and `totalamt` on 52%.
 *
 * Monetary and date values arrive as strings, not numbers or timestamps.
 */
export interface RawProject {
  boardapprovaldate?: string | null;
  closingdate?: string | null;
  countrycode?: string[] | null;
  countryname?: string | null;
  id?: string | null;
  major_sectors?: RawMajorSector[] | null;
  project_abstract?: string | null;
  project_name?: string | null;
  projectfinancialtype?: string[] | null;
  regionname?: string | null;
  status?: string | null;
  totalamt?: string | null;
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
   * Two-character codes — the identifier this API keys on, not the ISO3 the
   * other tools take. ISO2 for an economy, a World Bank regional code such as
   * `3A` for a multi-country operation. Upstream publishes a list; every project
   * in the portfolio carries exactly one entry.
   */
  countryCodes: string[];
  countryName: string;
  /** `IBRD`, `IDA`, `Grants`, or `Other`; a project may carry more than one. */
  financialTypes: string[];
  /** World Bank project ID, e.g. `P513206`. */
  id: string;
  /** Major sector names, deduplicated, in the order upstream lists them. */
  majorSectors: string[];
  name: string;
  regionName: string;
  /** `Active`, `Closed`, `Dropped`, or `Pipeline`. */
  status: string;
  /** Total commitment in USD. Null on projects that publish no commitment amount. */
  totalCommitment: number | null;
  /** Canonical project page on projects.worldbank.org. */
  url: string;
}
