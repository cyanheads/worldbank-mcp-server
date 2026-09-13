/**
 * @fileoverview World Bank period arithmetic shared by both data paths: placing a
 * period (`2020`, `2020Q2`, `2020M03`) on a month axis, testing it against a
 * requested `date_range`, ordering periods newest first, and translating the
 * time tokens the source-scoped data API uses (`YR2015`, `YR201806`,
 * `YR2027-M11`) into that same period grammar.
 * @module services/worldbank/periods
 */

/** An inclusive span of calendar months, each numbered `year * 12 + monthIndex`. */
export type MonthSpan = { start: number; end: number };

/**
 * Expand one World Bank period into the months it covers: `2020` is the whole
 * year, `2020Q2` is April–June, `2020M03` is March alone. Anything else yields
 * `undefined` — the tool's schema is the validator for the input's shape, and an
 * observation whose date can't be placed is kept rather than discarded.
 */
export function monthSpan(period: string): MonthSpan | undefined {
  const match = /^(\d{4})(?:([QMqm])(\d{1,2}))?$/.exec(period.trim());
  if (!match) return;
  const firstMonth = Number(match[1]) * 12;
  if (!match[2]) return { start: firstMonth, end: firstMonth + 11 };

  const ordinal = Number(match[3]);
  if (match[2].toUpperCase() === 'Q') {
    if (ordinal < 1 || ordinal > 4) return;
    return { start: firstMonth + (ordinal - 1) * 3, end: firstMonth + ordinal * 3 - 1 };
  }
  if (ordinal < 1 || ordinal > 12) return;
  return { start: firstMonth + ordinal - 1, end: firstMonth + ordinal - 1 };
}

/** Parse the requested `date` filter into the span of months it asks for. */
export function parseDateWindow(dateRange: string | undefined): MonthSpan | undefined {
  if (!dateRange) return;
  const [startPeriod, endPeriod, ...rest] = dateRange.trim().split(':');
  if (rest.length > 0 || startPeriod === undefined) return;
  const start = monthSpan(startPeriod);
  const end = endPeriod === undefined ? start : monthSpan(endPeriod);
  if (!start || !end || start.start > end.end) return;
  return { start: start.start, end: end.end };
}

/** True when a period overlaps the requested window. A period that can't be placed is kept. */
export function isWithinWindow(period: string, window: MonthSpan): boolean {
  const span = monthSpan(period);
  if (!span) return true;
  return span.start <= window.end && span.end >= window.start;
}

/**
 * Translate a source-scoped time token into the period grammar the standard data
 * endpoint and the `date_range` input use. Sources spell periods three ways:
 * `YR2015` (a year), `YR201806` (a PEFA assessment month), and `YR2027-M11` (a
 * monthly projection in International Debt Statistics: DSSI). An unrecognized
 * token keeps its own spelling without the `YR` prefix.
 */
export function periodFromToken(token: string): string {
  const year = /^YR(\d{4})$/i.exec(token);
  if (year) return year[1] as string;
  const month = /^YR(\d{4})-?M?(\d{2})$/i.exec(token);
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) return `${month[1]}M${month[2]}`;
  const quarter = /^YR(\d{4})-?Q([1-4])$/i.exec(token);
  if (quarter) return `${quarter[1]}Q${quarter[2]}`;
  return token.replace(/^YR/i, '');
}

/**
 * Order periods newest first: by the last month each covers, then by the first,
 * so a month sorts ahead of the year that ends with it. Periods that can't be
 * placed sort after every placeable one.
 */
export function comparePeriodsDesc(a: string, b: string): number {
  const spanA = monthSpan(a);
  const spanB = monthSpan(b);
  if (!spanA || !spanB) {
    if (spanA) return -1;
    if (spanB) return 1;
    return b.localeCompare(a);
  }
  return spanB.end - spanA.end || spanB.start - spanA.start;
}
