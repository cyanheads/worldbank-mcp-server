/**
 * @fileoverview Latest-period selection behind worldbank_get_data's `mrv` and
 * `mrnev`, shared by both data paths. Upstream's own `mrv`, `mrnev`, and
 * `frequency` are never sent: the Indicators API's response cache does not key
 * on them, so a request carrying one can be answered with the body computed for
 * another. The standard path reads the `date` window {@link latestWindow}
 * computes at the selected period form and, when that falls short, the
 * {@link fullSpan} at that form; both paths reduce what they read with
 * {@link selectLatest}.
 * @module services/worldbank/latest-values
 */

import { comparePeriodsDesc, type PeriodForm, periodForm } from './periods.js';

/**
 * Which latest periods to keep: `mrv`, the N most recent periods holding a value
 * for any series in the set, every series at each; `mrnev`, each series' own N
 * most recent periods holding a value.
 */
export type LatestSelection = { mode: 'mrv' | 'mrnev'; count: number };

/**
 * Every period a series carries at `form`, as a `date` span. A span's form
 * selects which periods a series publishing several forms returns — Global
 * Economic Monitor answers `1900:2100` with its annual rows only, and
 * `1900M01:2100M12` with its months — while a series with one form answers a
 * span at any other form with its whole series. `1900:2100` returns the same rows
 * as a request without `date`.
 */
export function fullSpan(form: PeriodForm): string {
  if (form === 'quarter') return '1900Q1:2100Q4';
  if (form === 'month') return '1900M01:2100M12';
  return '1900:2100';
}

/**
 * Years back from the current year the first window reaches, at least, per form:
 * about ten years of years or quarters, three calendar years of months.
 */
const WINDOW_YEARS: Record<PeriodForm, number> = { year: 10, quarter: 10, month: 2 };

/** Periods a form packs into one year. */
const PERIODS_PER_YEAR: Record<PeriodForm, number> = { year: 1, quarter: 4, month: 12 };

/**
 * The window a latest-value read asks for first, at `form`, open-ended: from
 * {@link WINDOW_YEARS} years before `year`, or far enough back to hold `count`
 * periods when that is further — `2016:2100`, `2016Q1:2100Q4`, or
 * `2024M01:2100M12` in 2026. It holds the answer for nearly every series and
 * country; a series short of `count` values inside it is read again over the
 * {@link fullSpan} at the same form.
 */
export function latestWindow(count: number, year: number, form: PeriodForm = 'year'): string {
  const back = Math.max(WINDOW_YEARS[form], Math.ceil(count / PERIODS_PER_YEAR[form]));
  const start = year - back;
  if (form === 'quarter') return `${start}Q1:2100Q4`;
  if (form === 'month') return `${start}M01:2100M12`;
  return `${start}:2100`;
}

/**
 * The period form a selection is made within when the caller names none: annual
 * whenever the periods include a year, otherwise the first form they carry. A
 * series that publishes an annual value beside monthly or quarterly ones is
 * selected annually; a quarterly-only series keeps its quarters.
 */
export function selectionForm(periods: Iterable<string>): PeriodForm | undefined {
  let found: PeriodForm | undefined;
  for (const period of periods) {
    const form = periodForm(period);
    if (form === 'year') return form;
    found ??= form;
  }
  return found;
}

/** How to read a row of either data path. */
export type RowReader<T> = {
  /** The series a row belongs to: its country, plus any further dimension value. */
  series: (row: T) => string;
  period: (row: T) => string;
  hasValue: (row: T) => boolean;
};

/** The rows a selection keeps, in input order, and whether the rows held enough to make it. */
export type LatestRows<T> = {
  rows: T[];
  /**
   * True when the rows answered the selection in full: `mrv` found `count` periods
   * holding a value, `mrnev` found `count` values for every series. False on no rows.
   */
  complete: boolean;
  /** For `mrnev`, the series holding fewer than `count` values at the form, in input order. */
  short: string[];
};

/**
 * Keep the latest periods `selection` asks for out of `rows`, counting only rows
 * at `form`: a row at any other form never matches. A series with no value at all
 * keeps no row under `mrnev`, and under `mrv` a series is kept at each selected
 * period, null or not, as the standard endpoint's own `mrv` returns it.
 */
export function selectLatest<T>(
  rows: readonly T[],
  selection: LatestSelection,
  form: PeriodForm | undefined,
  read: RowReader<T>,
): LatestRows<T> {
  const { mode, count } = selection;
  const atForm = rows.filter((row) => periodForm(read.period(row)) === form);

  if (mode === 'mrv') {
    const periods = [...new Set(atForm.filter(read.hasValue).map(read.period))]
      .sort(comparePeriodsDesc)
      .slice(0, count);
    const kept = new Set(periods);
    return {
      rows: atForm.filter((row) => kept.has(read.period(row))),
      complete: periods.length === count,
      short: [],
    };
  }

  const valuesBySeries = new Map<string, T[]>(rows.map((row) => [read.series(row), []]));
  for (const row of atForm) {
    if (read.hasValue(row)) valuesBySeries.get(read.series(row))?.push(row);
  }
  const kept = new Set<T>();
  const short: string[] = [];
  for (const [series, values] of valuesBySeries) {
    const latest = values
      .sort((a, b) => comparePeriodsDesc(read.period(a), read.period(b)))
      .slice(0, count);
    for (const row of latest) kept.add(row);
    if (latest.length < count) short.push(series);
  }
  return {
    rows: rows.filter((row) => kept.has(row)),
    complete: rows.length > 0 && short.length === 0,
    short,
  };
}
