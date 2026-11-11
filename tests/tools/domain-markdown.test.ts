/**
 * @fileoverview Literal upstream data in domain formatters and custom trailers.
 * @module tests/tools/domain-markdown.test
 */
import { expect, it } from 'vitest';
import { worldbankGetData } from '@/mcp-server/tools/definitions/worldbank-get-data.tool.js';
import { worldbankGetPoverty } from '@/mcp-server/tools/definitions/worldbank-get-poverty.tool.js';
import { worldbankListCountries } from '@/mcp-server/tools/definitions/worldbank-list-countries.tool.js';
import { worldbankSearchProjects } from '@/mcp-server/tools/definitions/worldbank-search-projects.tool.js';

const raw = 'name | #\n`code` <b>x</b>\n[ref]: /target\n[ref]';
const escaped = 'name \\| \\#\\\n\\`code\\` \\<b>x\\</b>\\\n\\[ref\\]: /target\\\n\\[ref\\]';
const data = {
  indicator: { id: raw, name: raw },
  nullCount: 0,
  data: [
    {
      countryCode: raw,
      countryName: raw,
      countryIso3: raw,
      date: raw,
      value: 0,
      obsStatus: raw,
      isAggregate: false,
    },
  ],
};
const country = { countries: [{ id: raw, name: raw, sourceId: raw }] };
const poverty = {
  estimates: [
    {
      countryCode: raw,
      countryName: raw,
      reportingYear: 2020,
      reportingLevel: raw,
      regionCode: raw,
      regionName: raw,
      welfareType: raw,
      povertyLine: 3,
      headcount: null,
      povertyGap: null,
      povertySeverity: null,
      watts: null,
      mean: null,
      median: null,
      population: null,
      popInPoverty: null,
      gini: null,
      mld: null,
      polarization: null,
      decileShares: null,
      estimationType: raw,
      isAggregate: false,
      isInterpolated: false,
      surveyYear: null,
      surveyAcronym: raw,
      surveyComparability: null,
      comparableSpell: raw,
      estimateType: raw,
      distributionType: raw,
    },
  ],
};
const projects = {
  projects: [
    {
      id: raw,
      name: raw,
      objective: raw,
      status: raw,
      countryName: raw,
      countryCodes: [raw],
      regionName: raw,
      boardApprovalDate: raw,
      closingDate: raw,
      totalCommitment: 0,
      ibrdCommitment: null,
      idaCommitment: 0,
      grantAmount: null,
      financialTypes: [raw],
      majorSectors: [raw],
      sectors: [{ name: raw, code: raw, majorSector: raw, percent: null }],
      url: raw,
      abstract: raw,
    },
  ],
};

it.each([
  ['data', () => worldbankGetData.format!(data), 7],
  ['countries', () => worldbankListCountries.format!(country), 3],
  ['poverty', () => worldbankGetPoverty.format!(poverty), 11],
  ['projects', () => worldbankSearchProjects.format!(projects), 17],
] as const)('preserves each hostile %s field at its rendering boundary', (_name, render, count) => {
  const before = JSON.stringify([data, country, poverty, projects]);
  const text = render()
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');
  expect(text.split(escaped).length - 1).toBe(count);
  expect(JSON.stringify([data, country, poverty, projects])).toBe(before);
});

it.each([worldbankGetData, worldbankListCountries, worldbankGetPoverty, worldbankSearchProjects])(
  'escapes custom notice trailers',
  (tool) => {
    expect(tool.enrichmentTrailer?.notice?.render?.(raw)).toBe(`**Notice:** ${escaped}`);
  },
);

it('escapes caller text in each custom applied-filter trailer', () => {
  const filters = [
    worldbankGetData.enrichmentTrailer!.appliedFilters!.render!({
      indicatorId: raw,
      countries: raw,
      dimensionValue: raw,
      page: 1,
      perPage: 1000,
      requestedPerPage: 2000,
    }),
    worldbankListCountries.enrichmentTrailer!.appliedFilters!.render!({
      region: raw,
      incomeLevel: raw,
      includeAggregates: false,
      page: 1,
      perPage: 300,
      requestedPerPage: 500,
    }),
    worldbankGetPoverty.enrichmentTrailer!.appliedFilters!.render!({
      countries: raw,
      pppVersion: '2021',
      releaseVersion: raw,
      fillGaps: true,
      page: 1,
      perPage: 1000,
      requestedPerPage: 2000,
    }),
    worldbankSearchProjects.enrichmentTrailer!.appliedFilters!.render!({
      query: raw,
      sector: [raw],
      includeAbstract: true,
      page: 1,
      perPage: 1000,
      requestedPerPage: 2000,
    }),
  ];
  expect(filters[0]).toContain(
    `indicator_id=${escaped}, countries=${escaped}, dimension_value=${escaped}`,
  );
  expect(filters[1]).toContain(`region=${escaped}, income_level=${escaped}`);
  expect(filters[2]).toContain(
    `countries=${escaped}, ppp_version=2021, release_version=${escaped}`,
  );
  expect(filters[3]).toContain(`query=${escaped}, sector=${escaped}`);
  for (const text of filters)
    expect(text).toMatch(/per_page=(?:1000 \(requested 2000\)|300 \(requested 500\))$/);
});

it('renders the raw project URL as both a safe link label and destination', () => {
  const url = 'https://example.com/[project]?q=<x>&literal=&copy;';
  const text = worldbankSearchProjects.format!({ projects: [{ ...projects.projects[0]!, url }] })
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');
  expect(text).toContain(
    '- **url:** [https://example.com/\\[project\\]?q=\\<x>&literal=\\&copy;](<https://example.com/[project]?q=\\<x\\>&literal=\\&copy;>)',
  );
});
