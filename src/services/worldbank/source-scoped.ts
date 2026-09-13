/**
 * @fileoverview Pure logic behind worldbank_get_data's source-scoped path — the
 * `/v2/sources/{id}/...` data API that serves the indicators the standard data
 * endpoint rejects with message id 175. Reads a source's concept layout, picks
 * the default value of its extra dimension, normalizes the concept/id/value rows
 * the API returns, and applies `mrv` and ordering locally: the default WDI
 * Database Archives release is resolved from the rows before `mrv` can apply,
 * and upstream's row order changes with the shape of the request.
 * @module services/worldbank/source-scoped
 */

import { comparePeriodsDesc, periodFromToken } from './periods.js';
import type {
  DimensionValue,
  RawSourceListing,
  RawSourceObservation,
  RawSourceVariable,
} from './types.js';

/** The concepts every routable source carries, which map onto the tool's own inputs. */
const CORE_CONCEPTS = new Set(['country', 'series', 'time']);

/**
 * How a source's data is addressed: its display name and, when it has one, the
 * concept beyond Country/Series/Time (`Version`, `Classification`, `Sector`,
 * `Counterpart-Area`), spelled as upstream reports it.
 */
export type SourceLayout = { sourceId: string; sourceName: string; dimension: string | undefined };

/**
 * Read `/sources/{id}/concepts` into a layout. A source is routable when it
 * carries Country, Series, and Time plus at most one further concept; anything
 * else — a subnational geography, a `Year` axis, two extra dimensions — has no
 * mapping onto the tool's inputs and yields `undefined`.
 */
export function layoutFromConcepts(
  sourceId: string,
  listing: RawSourceListing,
): SourceLayout | undefined {
  const source = listing.source?.[0];
  const concepts = (source?.concept ?? []).map((c) => c.id ?? '').filter(Boolean);
  const lowered = new Set(concepts.map((c) => c.toLowerCase()));
  if (![...CORE_CONCEPTS].every((core) => lowered.has(core))) return;
  const extra = concepts.filter((c) => !CORE_CONCEPTS.has(c.toLowerCase()));
  if (extra.length > 1) return;
  return { sourceId, sourceName: (source?.name ?? '').trim(), dimension: extra[0] };
}

/** Flatten a value listing (`/sources/{id}/{concept}`) into id/label pairs. */
export function valuesFromListing(listing: RawSourceListing): DimensionValue[] {
  return (listing.source?.[0]?.concept?.[0]?.variable ?? [])
    .filter((v): v is RawSourceVariable & { id: string } => typeof v.id === 'string' && v.id !== '')
    .map((v) => ({ id: v.id, label: v.value ?? '' }));
}

/**
 * The value to pin when the caller names none, or how to resolve one:
 *
 * - a dimension with a single value pins it;
 * - `Counterpart-Area` pins `WLD`, the World total across counterparts — the
 *   counterpart the standard endpoint reports for International Debt Statistics
 *   series;
 * - `Version` is resolved from the data (`resolve_version`), because a series an
 *   archive retired carries only nulls in every later version;
 * - any other dimension — ICP measures, GDLD sectors, FPN methodology releases —
 *   is left unpinned, and every value comes back with each row labelled.
 */
export function defaultSelection(
  concept: string,
  values: readonly DimensionValue[],
):
  | { selection: 'only_value' | 'world_total'; value: DimensionValue }
  | { selection: 'resolve_version' | 'every_value' } {
  const [only] = values;
  if (values.length === 1 && only) return { selection: 'only_value', value: only };
  const name = concept.toLowerCase();
  if (name === 'counterpart-area') {
    const world = values.find((v) => v.id.toUpperCase() === 'WLD');
    if (world) return { selection: 'world_total', value: world };
  }
  if (name === 'version' && values.length > 1) return { selection: 'resolve_version' };
  return { selection: 'every_value' };
}

/** One source-scoped observation, normalized. */
export type ScopedRow = {
  countryId: string;
  countryName: string;
  period: string;
  dimension: DimensionValue | undefined;
  value: number | null;
};

/**
 * Pick a row's country, time, and dimension out of its `variable[]` by concept
 * name — upstream orders the tuple differently from one request to the next. A
 * row without a country or a time can't be placed and yields `undefined`.
 */
export function readRow(
  raw: RawSourceObservation,
  dimensionConcept: string | undefined,
): ScopedRow | undefined {
  const byConcept = new Map(
    (raw.variable ?? []).map((v) => [(v.concept ?? '').toLowerCase(), v] as const),
  );
  const country = byConcept.get('country');
  const time = byConcept.get('time');
  if (!country?.id || !time?.id) return;
  const extra = dimensionConcept ? byConcept.get(dimensionConcept.toLowerCase()) : undefined;
  return {
    countryId: country.id,
    countryName: country.value ?? '',
    period: periodFromToken(time.id),
    dimension: extra?.id ? { id: extra.id, label: extra.value ?? '' } : undefined,
    value: typeof raw.value === 'number' ? raw.value : null,
  };
}

/**
 * The newest version, by its position in the source's own ascending listing,
 * that holds at least one value among the rows. `undefined` when every row is null.
 */
export function newestVersionWithData(
  rows: readonly ScopedRow[],
  versions: readonly DimensionValue[],
): DimensionValue | undefined {
  const withData = new Set(
    rows.filter((row) => row.value !== null).map((row) => row.dimension?.id.toLowerCase()),
  );
  return versions.findLast((version) => withData.has(version.id.toLowerCase()));
}

/**
 * Apply the standard endpoint's `mrv` rule locally, after the default release is
 * resolved — upstream's own `mrv` would pick periods across every release: keep
 * the N most recent periods holding a value for any requested country (and
 * dimension value), and every row at those periods — nulls included, as upstream
 * returns them for a country with no value at a period another country fills.
 */
export function keepMostRecentPeriods(rows: readonly ScopedRow[], count: number): ScopedRow[] {
  const recent = new Set(
    [...new Set(rows.filter((row) => row.value !== null).map((row) => row.period))]
      .sort(comparePeriodsDesc)
      .slice(0, count),
  );
  return rows.filter((row) => recent.has(row.period));
}

/**
 * Order rows the way the standard endpoint does — country name, then newest period
 * first — with dimension values in the source's listing order. Upstream's own
 * order changes with the shape of the request, so it can't be paginated as-is.
 */
export function sortRows(
  rows: readonly ScopedRow[],
  values: readonly DimensionValue[],
): ScopedRow[] {
  const position = new Map(values.map((value, index) => [value.id.toLowerCase(), index]));
  const rank = (row: ScopedRow) => position.get(row.dimension?.id.toLowerCase() ?? '') ?? -1;
  return [...rows].sort(
    (a, b) =>
      a.countryName.localeCompare(b.countryName, 'en') ||
      a.countryId.localeCompare(b.countryId) ||
      comparePeriodsDesc(a.period, b.period) ||
      rank(a) - rank(b),
  );
}
