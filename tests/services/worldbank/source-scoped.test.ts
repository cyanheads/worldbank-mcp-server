/**
 * @fileoverview Tests for the pure source-scoped helpers and period arithmetic:
 * concept layouts, per-concept default dimension values, row normalization,
 * version resolution, `mrv` emulation, ordering, and time-token translation.
 * @module tests/services/worldbank/source-scoped.test
 */

import { describe, expect, it } from 'vitest';
import {
  comparePeriodsDesc,
  isWithinWindow,
  parseDateWindow,
  periodFromToken,
} from '@/services/worldbank/periods.js';
import {
  defaultSelection,
  keepMostRecentPeriods,
  layoutFromConcepts,
  newestVersionWithData,
  readRow,
  type ScopedRow,
  sortRows,
  valuesFromListing,
} from '@/services/worldbank/source-scoped.js';

/** A `/sources/{id}/concepts` listing, concepts in the order given. */
function concepts(name: string, ids: string[]) {
  return {
    page: 1,
    pages: 1,
    total: ids.length,
    source: [{ id: '1', name, concept: ids.map((id) => ({ id, value: id })) }],
  };
}

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

describe('periodFromToken', () => {
  it.each([
    ['YR2015', '2015'],
    ['yr1960', '1960'],
    ['YR201806', '2018M06'],
    ['YR2027-M11', '2027M11'],
    ['YR2020Q3', '2020Q3'],
    ['YR201813', '201813'],
    ['2019', '2019'],
  ])('translates the source time token %s to the period %s', (token, period) => {
    expect(periodFromToken(token)).toBe(period);
  });

  it('places every translated token form on the month axis the date_range check uses', () => {
    const window = parseDateWindow('2018');
    if (!window) throw new Error('window did not parse');
    expect(isWithinWindow(periodFromToken('YR201806'), window)).toBe(true);
    expect(isWithinWindow(periodFromToken('YR2019-M01'), window)).toBe(false);
    expect(isWithinWindow(periodFromToken('YR2018'), window)).toBe(true);
  });
});

describe('comparePeriodsDesc', () => {
  it('orders newest first, a month ahead of the year that ends with it, unplaceable last', () => {
    const sorted = ['2026', '2027M12', '2027', 'n/a', '2027M01', '2025Q4'].sort(comparePeriodsDesc);
    expect(sorted).toEqual(['2027M12', '2027', '2027M01', '2026', '2025Q4', 'n/a']);
  });
});

describe('layoutFromConcepts', () => {
  it('reads the extra concept whatever position upstream lists it in', () => {
    expect(
      layoutFromConcepts(
        '71',
        concepts('ICP 2005', ['Classification', 'Country', 'Series', 'Time']),
      ),
    ).toEqual({
      sourceId: '71',
      sourceName: 'ICP 2005',
      dimension: 'Classification',
    });
  });

  it('trims the source name, which upstream pads for International Debt Statistics: DSSI', () => {
    expect(
      layoutFromConcepts(
        '81',
        concepts(' International Debt Statistics: DSSI', [
          'Country',
          'Counterpart-Area',
          'Series',
          'Time',
        ]),
      )?.sourceName,
    ).toBe('International Debt Statistics: DSSI');
  });

  it('gives a three-concept source no dimension', () => {
    expect(
      layoutFromConcepts('2', concepts('WDI', ['Country', 'Series', 'Time']))?.dimension,
    ).toBeUndefined();
  });

  it.each([
    [['Provinces', 'Series', 'Time']],
    [['Country', 'Series', 'Year']],
    [['Country', 'Series', 'Time', 'Version', 'Sector']],
    [[]],
  ])('refuses a layout it cannot address: %j', (ids) => {
    expect(layoutFromConcepts('9', concepts('X', ids))).toBeUndefined();
  });
});

describe('valuesFromListing', () => {
  it('flattens a value listing and drops entries with no id', () => {
    const listing = {
      source: [
        {
          concept: [
            {
              id: 'version',
              variable: [
                { id: '202503', value: '2025 Mar' },
                { value: 'orphan' },
                { id: '202601' },
              ],
            },
          ],
        },
      ],
    };
    expect(valuesFromListing(listing)).toEqual([
      { id: '202503', label: '2025 Mar' },
      { id: '202601', label: '' },
    ]);
  });

  it('reads an empty or malformed listing as no values', () => {
    expect(valuesFromListing({})).toEqual([]);
    expect(valuesFromListing({ source: [{ concept: [] }] })).toEqual([]);
  });
});

describe('defaultSelection', () => {
  const versions = [
    { id: '202407', label: '2024 Jul' },
    { id: '202503', label: '2025 Mar' },
  ];

  it('pins the only value a dimension lists, whatever its concept', () => {
    expect(defaultSelection('Version', [versions[0] as never])).toEqual({
      selection: 'only_value',
      value: versions[0],
    });
    expect(defaultSelection('Classification', [{ id: 'PUB', label: 'Public' }])).toMatchObject({
      selection: 'only_value',
    });
  });

  it('pins WLD for a counterpart area, matching the id case-insensitively', () => {
    const areas = [
      { id: '265', label: 'Zimbabwe' },
      { id: 'wld', label: 'World' },
    ];
    expect(defaultSelection('Counterpart-Area', areas)).toEqual({
      selection: 'world_total',
      value: areas[1],
    });
  });

  it('returns every counterpart area when no World total is listed', () => {
    expect(
      defaultSelection('counterpart-area', [
        { id: '001', label: 'Austria' },
        { id: '002', label: 'Belgium' },
      ]),
    ).toEqual({
      selection: 'every_value',
    });
  });

  it('resolves a multi-release Version from the data', () => {
    expect(defaultSelection('Version', versions)).toEqual({ selection: 'resolve_version' });
  });

  it.each(['Classification', 'Sector'])('returns every value of a multi-valued %s', (concept) => {
    expect(defaultSelection(concept, versions)).toEqual({ selection: 'every_value' });
  });
});

describe('readRow', () => {
  it('picks concepts by name regardless of tuple order, translating the time token', () => {
    const raw = {
      variable: [
        { concept: 'Version', id: '202503', value: '2025 Mar' },
        { concept: 'Time', id: 'YR2015', value: '2015' },
        { concept: 'Series', id: 'SM.POP.REFG.OR', value: 'Refugees' },
        { concept: 'Country', id: 'SDN', value: 'Sudan' },
      ],
      value: 627080,
    };
    expect(readRow(raw, 'Version')).toEqual({
      countryId: 'SDN',
      countryName: 'Sudan',
      period: '2015',
      dimension: { id: '202503', label: '2025 Mar' },
      value: 627080,
    });
  });

  it('keeps a null cell null and a missing label empty', () => {
    const raw = {
      variable: [
        { concept: 'Country', id: 'AGO' },
        { concept: 'Time', id: 'YR2027-M11' },
      ],
      value: null,
    };
    expect(readRow(raw, 'Counterpart-Area')).toEqual({
      countryId: 'AGO',
      countryName: '',
      period: '2027M11',
      dimension: undefined,
      value: null,
    });
  });

  it('cannot place a row with no country or no time', () => {
    expect(
      readRow({ variable: [{ concept: 'Time', id: 'YR2015' }], value: 1 }, undefined),
    ).toBeUndefined();
    expect(
      readRow({ variable: [{ concept: 'Country', id: 'USA' }], value: 1 }, undefined),
    ).toBeUndefined();
    expect(readRow({ value: 1 }, undefined)).toBeUndefined();
  });
});

describe('newestVersionWithData', () => {
  const versions = ['202407', '202503', '202601'].map((id) => ({ id, label: id }));

  it('takes the newest release by listing position that holds any value', () => {
    const rows = [
      row('SDN', '2015', 5, '202407'),
      row('SDN', '2015', 7, '202503'),
      row('SDN', '2015', null, '202601'),
    ];
    expect(newestVersionWithData(rows, versions)?.id).toBe('202503');
  });

  it('counts a value for any country in scope', () => {
    const rows = [row('SDN', '2015', null, '202601'), row('USA', '2015', 1, '202601')];
    expect(newestVersionWithData(rows, versions)?.id).toBe('202601');
  });

  it('is undefined when every row is null', () => {
    expect(newestVersionWithData([row('SDN', '2015', null, '202601')], versions)).toBeUndefined();
  });
});

describe('keepMostRecentPeriods', () => {
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
    const kept = keepMostRecentPeriods(rows, 2);
    expect(kept.map((r) => `${r.countryId}/${r.period}`).sort()).toEqual([
      'ERI/2014',
      'ERI/2015',
      'SSD/2014',
      'SSD/2015',
    ]);
  });

  it('counts periods across dimension values and granularities', () => {
    const rows = [
      row('AGO', '2027M11', null, 'WLD'),
      row('AGO', '2027', 3, 'WLD'),
      row('AGO', '2026M12', 2, '009'),
    ];
    expect(keepMostRecentPeriods(rows, 1).map((r) => r.period)).toEqual(['2027']);
  });

  it('keeps nothing when no row holds a value', () => {
    expect(keepMostRecentPeriods([row('ERI', '2015', null)], 3)).toEqual([]);
  });
});

describe('sortRows', () => {
  it('orders by country name, then newest period, then the listing order of dimension values', () => {
    const values = [
      { id: 'CD', label: '' },
      { id: 'ZS', label: '' },
      { id: 'PPPGlob', label: '' },
    ];
    const rows = [
      { ...row('USA', '2016', 1, 'PPPGlob'), countryName: 'United States' },
      { ...row('CHN', '2017', 1, 'ZS'), countryName: 'China' },
      { ...row('USA', '2017', 1, 'ZS'), countryName: 'United States' },
      { ...row('USA', '2017', 1, 'CD'), countryName: 'United States' },
    ];
    expect(
      sortRows(rows, values).map((r) => `${r.countryId}/${r.period}/${r.dimension?.id}`),
    ).toEqual(['CHN/2017/ZS', 'USA/2017/CD', 'USA/2017/ZS', 'USA/2016/PPPGlob']);
  });
});
