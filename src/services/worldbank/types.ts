/**
 * @fileoverview Domain types for the World Bank API service.
 * @module services/worldbank/types
 */

/** World Bank API response envelope: [paginationInfo, items[]] */
export type WbEnvelope<T> = [WbPage, T[]];

export type WbPage = {
  page: number;
  pages: number;
  per_page: number | string;
  total: number;
  sourceid?: string;
  lastupdated?: string;
};

/** Raw indicator object from the World Bank API */
export type RawIndicator = {
  id: string;
  name?: string;
  unit?: string;
  source?: { id?: string; value?: string };
  sourceNote?: string;
  sourceOrganization?: string;
  topics?: Array<{ id?: string; value?: string }>;
};

/** Raw country object from the World Bank API */
export type RawCountry = {
  id?: string;
  iso2Code?: string;
  name?: string;
  region?: { id?: string; value?: string };
  incomeLevel?: { id?: string; value?: string };
  lendingType?: { id?: string; value?: string };
  capitalCity?: string;
  longitude?: string;
  latitude?: string;
};

/** Raw data observation from the World Bank API */
export type RawDataPoint = {
  indicator?: { id?: string; value?: string };
  country?: { id?: string; value?: string };
  countryiso3code?: string;
  date?: string;
  value?: number | null;
  unit?: string;
  obs_status?: string;
  decimal?: number;
};

/** Raw topic object from the World Bank API */
export type RawTopic = {
  id?: string;
  value?: string;
  sourceNote?: string;
};

/** Raw source object from the World Bank API */
export type RawSource = {
  id?: string;
  name?: string;
  code?: string;
  description?: string;
  url?: string;
  dataavailability?: string;
  metadataavailability?: string;
  concepts?: string;
  lastupdated?: string;
};

/** Normalized indicator for tool output */
export type Indicator = {
  id: string;
  name: string;
  sourceId: string;
  sourceName: string;
  sourceNote: string;
  topics: Array<{ id: string; name: string }>;
};

/** Normalized indicator with full metadata */
export type IndicatorDetail = Indicator & {
  unit: string;
  sourceOrganization: string;
};

/** Normalized country for tool output */
export type Country = {
  id: string;
  iso2: string;
  name: string;
  region: { id: string; name: string };
  incomeLevel: { id: string; name: string };
  lendingType: string;
  capitalCity: string;
  longitude: string;
  latitude: string;
  isAggregate: boolean;
};

/** Normalized data observation for tool output */
export type DataPoint = {
  countryCode: string;
  countryIso3: string;
  countryName: string;
  date: string;
  value: number | null;
  obsStatus: string;
  isAggregate: boolean;
  /** The source's extra-dimension value this row belongs to — source-scoped rows only. */
  dimension?: DimensionValue;
};

// ─── Source-scoped data API ──────────────────────────────────────────────────

/** A `{ page, pages, per_page, total }` envelope, as every `/sources/...` response opens. */
type SourcePaging = {
  page?: number | string;
  pages?: number | string;
  per_page?: number | string;
  total?: number | string;
};

/** One `{ id, value }` pair from a source-scoped listing or data row. */
export type RawSourceVariable = { concept?: string; id?: string; value?: string };

/**
 * A source-scoped listing — `/sources/{id}/concepts`, `/sources/{id}/country`,
 * `/sources/{id}/time`, `/sources/{id}/{concept}`. The concept list carries
 * `concept[].id`; the value lists carry `concept[0].variable[]`.
 */
export type RawSourceListing = SourcePaging & {
  source?: Array<{
    id?: string;
    name?: string;
    concept?: Array<{ id?: string; value?: string; variable?: RawSourceVariable[] }>;
  }>;
};

/** One source-scoped observation: its concept/id/value tuple and the cell value. */
export type RawSourceObservation = { variable?: RawSourceVariable[]; value?: number | null };

/** A source-scoped data response: a single object, one `variable[]` per observation. */
export type RawSourceData = SourcePaging & {
  lastupdated?: string;
  source?: { id?: string; name?: string; data?: RawSourceObservation[] };
};

/** One value of a source's extra dimension, as `/sources/{id}/{concept}` lists it. */
export type DimensionValue = { id: string; label: string };

/**
 * How the dimension value behind source-scoped rows was chosen: named by the
 * caller, the only value the source publishes, the World total across counterpart
 * areas, the newest version holding a value in the requested scope, the newest
 * version when none does, or every value with each row labelled.
 */
export type DimensionSelection =
  | 'requested'
  | 'only_value'
  | 'world_total'
  | 'newest_with_data'
  | 'newest'
  | 'every_value';

/** Which source served a source-scoped result and which dimension value applied. */
export type SourceScopedDisclosure = {
  sourceId: string;
  sourceName: string;
  dimension: {
    concept: string;
    selection: DimensionSelection;
    id: string | null;
    label: string | null;
  } | null;
  note: string;
};

/** Normalized topic for tool output */
export type Topic = {
  id: string;
  name: string;
  sourceNote: string;
};

/** Normalized source for tool output */
export type Source = {
  id: string;
  name: string;
  code: string;
  lastUpdated: string;
  dataAvailability: string;
  metadataAvailability: string;
  concepts: string;
};
