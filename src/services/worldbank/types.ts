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
