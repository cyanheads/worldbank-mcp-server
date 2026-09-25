/**
 * @fileoverview Tests for the latest-period selection behind worldbank_get_data's
 * `mrv` and `mrnev`: the first window, the period form a selection is made
 * within, and the selection itself over source-scoped rows.
 * @module tests/services/worldbank/latest-values.test
 */

import { describe, expect, it } from 'vitest';
import {
  fullSpan,
  latestWindow,
  selectionForm,
  selectLatest,
} from '@/services/worldbank/latest-values.js';
import { periodForm } from '@/services/worldbank/periods.js';
import { SCOPED_ROW_READER, type ScopedRow } from '@/services/worldbank/source-scoped.js';

function row(
  countryId: string,
  period: string,
  value: number | null,
  dimensionId?: string,
): ScopedRow {
  return {
    countryId,
    countryName: countryId,
    period,
    value,
    dimension: dimensionId ? { id: dimensionId, label: `label ${dimensionId}` } : undefined,
  };
}

const cellsOf = (rows: ScopedRow[]) =>
  rows.map((r) => `${r.countryId}/${r.period}${r.dimension ? `/${r.dimension.id}` : ''}`);

describe('periodForm', () => {
  it.each([
    ['2020', 'year'],
    ['2020Q2', 'quarter'],
    ['2020M03', 'month'],
    ['2020M3', 'month'],
    ['Jun.18', undefined],
    ['2020Q5', undefined],
  ])('reads %s as %s', (period, form) => {
    expect(periodForm(period)).toBe(form);
  });
});

describe('latestWindow', () => {
  it('reaches ten years back, open-ended', () => {
    expect(latestWindow(1, 2026)).toBe('2016:2100');
    expect(latestWindow(10, 2026)).toBe('2016:2100');
  });

  it('reaches N years back for a larger count', () => {
    expect(latestWindow(60, 2026)).toBe('1966:2100');
  });

  it('reaches ten years of quarters and three calendar years of months', () => {
    expect(latestWindow(3, 2026, 'quarter')).toBe('2016Q1:2100Q4');
    expect(latestWindow(3, 2026, 'month')).toBe('2024M01:2100M12');
  });

  it('reaches far enough back to hold N quarters or months', () => {
    expect(latestWindow(41, 2026, 'quarter')).toBe('2015Q1:2100Q4');
    expect(latestWindow(100, 2026, 'quarter')).toBe('2001Q1:2100Q4');
    expect(latestWindow(25, 2026, 'month')).toBe('2023M01:2100M12');
    expect(latestWindow(100, 2026, 'month')).toBe('2017M01:2100M12');
  });

  it('widens to a span covering every period at the form', () => {
    expect(fullSpan('year')).toBe('1900:2100');
    expect(fullSpan('quarter')).toBe('1900Q1:2100Q4');
    expect(fullSpan('month')).toBe('1900M01:2100M12');
  });
});

describe('selectionForm', () => {
  it('selects annually whenever a year is present', () => {
    expect(selectionForm(['2026M07', '2026Q2', '2026'])).toBe('year');
  });

  it('keeps the form of a series with no annual period', () => {
    expect(selectionForm(['2026Q2', '2026Q1'])).toBe('quarter');
  });

  it('has no form for no placeable period', () => {
    expect(selectionForm([])).toBeUndefined();
    expect(selectionForm(['Jun.18'])).toBeUndefined();
  });
});

describe('selectLatest — mrv', () => {
  const mrv = (count: number) => ({ mode: 'mrv' as const, count });

  /**
   * Measured against the standard endpoint: `country/ERI;SSD/.../mrv=2` returns
   * 2015 and 2014 for both countries — South Sudan's last two years with data —
   * with Eritrea null at both, not Eritrea's own last values (2011, 2010).
   */
  it('keeps the N most recent periods holding a value anywhere, nulls at those periods included', () => {
    const rows = [
      row('ERI', '2015', null),
      row('ERI', '2014', null),
      row('ERI', '2011', 688),
      row('SSD', '2015', 1080),
      row('SSD', '2014', 1242),
      row('SSD', '2013', 1300),
      row('SSD', '2016', null),
    ];
    const kept = selectLatest(rows, mrv(2), 'year', SCOPED_ROW_READER);
    expect(cellsOf(kept.rows).sort()).toEqual(['ERI/2014', 'ERI/2015', 'SSD/2014', 'SSD/2015']);
    expect(kept.complete).toBe(true);
  });

  it('counts periods across dimension values, within the one form selected', () => {
    const rows = [
      row('AGO', '2027M11', 5, 'WLD'),
      row('AGO', '2027', 3, 'WLD'),
      row('AGO', '2026M12', 2, '009'),
      row('AGO', '2026', null, '009'),
    ];
    const kept = selectLatest(rows, mrv(1), 'year', SCOPED_ROW_READER);
    expect(cellsOf(kept.rows)).toEqual(['AGO/2027/WLD']);
  });

  it('keeps nothing, and reports the selection incomplete, when no row holds a value', () => {
    const kept = selectLatest([row('ERI', '2015', null)], mrv(3), 'year', SCOPED_ROW_READER);
    expect(kept).toEqual({ rows: [], complete: false, short: [] });
  });

  it('reports a selection with fewer than N periods holding a value as incomplete', () => {
    const kept = selectLatest(
      [row('SSD', '2015', 1), row('SSD', '2014', 2)],
      mrv(3),
      'year',
      SCOPED_ROW_READER,
    );
    expect(cellsOf(kept.rows)).toEqual(['SSD/2015', 'SSD/2014']);
    expect(kept.complete).toBe(false);
  });
});

describe('selectLatest — mrnev', () => {
  const mrnev = (count: number) => ({ mode: 'mrnev' as const, count });

  it("keeps each series' own latest values, none null, in input order", () => {
    const rows = [
      row('BRA', '2025', 10713),
      row('BRA', '2024', 10000),
      row('ERI', '2025', null),
      row('ERI', '2011', 688),
      row('ERI', '2010', 642),
      row('SSD', '2015', 1080),
    ];
    const kept = selectLatest(rows, mrnev(1), 'year', SCOPED_ROW_READER);
    expect(cellsOf(kept.rows)).toEqual(['BRA/2025', 'ERI/2011', 'SSD/2015']);
    expect(kept).toMatchObject({ complete: true, short: [] });
  });

  it('names the series short of N values, including one with no value at all', () => {
    const rows = [
      row('BRA', '2025', 1),
      row('BRA', '2024', 2),
      row('ERI', '2025', null),
      row('SSD', '2015', 1080),
    ];
    const kept = selectLatest(rows, mrnev(2), 'year', SCOPED_ROW_READER);
    expect(cellsOf(kept.rows)).toEqual(['BRA/2025', 'BRA/2024', 'SSD/2015']);
    expect(kept).toMatchObject({ complete: false, short: ['ERI|', 'SSD|'] });
  });

  it('selects each dimension value of a country as its own series', () => {
    const rows = [
      row('AGO', '2024', 1, 'WLD'),
      row('AGO', '2023', 2, 'WLD'),
      row('AGO', '2020', 3, '009'),
    ];
    const kept = selectLatest(rows, mrnev(1), 'year', SCOPED_ROW_READER);
    expect(cellsOf(kept.rows)).toEqual(['AGO/2024/WLD', 'AGO/2020/009']);
  });

  it('never counts a row at another form, however recent', () => {
    const rows = [
      row('KEN', '2026M07', 289.76),
      row('KEN', '2026', 283.9),
      row('KEN', '2025', 271.59),
    ];
    const kept = selectLatest(rows, mrnev(2), 'year', SCOPED_ROW_READER);
    expect(cellsOf(kept.rows)).toEqual(['KEN/2026', 'KEN/2025']);
  });

  it('selects within a sub-annual form, never counting the annual or quarterly rows beside it', () => {
    const rows = [
      row('USA', '2026', 3300),
      row('USA', '2026Q2', 840),
      row('USA', '2026M07', 281),
      row('USA', '2026M06', 279),
    ];
    expect(cellsOf(selectLatest(rows, mrnev(1), 'month', SCOPED_ROW_READER).rows)).toEqual([
      'USA/2026M07',
    ]);
    expect(cellsOf(selectLatest(rows, mrnev(2), 'quarter', SCOPED_ROW_READER).rows)).toEqual([
      'USA/2026Q2',
    ]);
  });

  it('reports no rows as incomplete', () => {
    expect(selectLatest([], mrnev(1), 'year', SCOPED_ROW_READER).complete).toBe(false);
  });
});
