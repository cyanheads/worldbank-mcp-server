/**
 * @fileoverview The four economies the Projects portfolio files under a legacy
 * code rather than the ISO2 code the World Bank country index holds. Measured
 * across all 28,153 projects on 2026-09-25: `countrycode_exact` on the ISO2 code
 * matches nothing for each of them, while the legacy code matches the economy's
 * whole portfolio. Every other economy in the portfolio is keyed on its ISO2.
 * @module services/projects/portfolio-country-codes
 */

/** WDI ISO2 code → the code the portfolio files the economy under. */
const LEGACY_PORTFOLIO_CODES: ReadonlyMap<string, string> = new Map([
  ['YE', 'RY'], // Yemen — 339 projects
  ['CD', 'ZR'], // Democratic Republic of Congo — 308
  ['PS', 'GZ'], // West Bank and Gaza — 196
  ['TL', 'TP'], // Timor-Leste — 60
]);

const WDI_ISO2_BY_PORTFOLIO_CODE: ReadonlyMap<string, string> = new Map(
  [...LEGACY_PORTFOLIO_CODES].map(([iso2, portfolio]) => [portfolio, iso2]),
);

/** The code to search the portfolio with for an uppercase two-character code. */
export function toPortfolioCode(code: string): string {
  return LEGACY_PORTFOLIO_CODES.get(code) ?? code;
}

/** The WDI ISO2 code for a code the portfolio publishes, so it chains into the Indicators tools. */
export function toWdiIso2(code: string): string {
  return WDI_ISO2_BY_PORTFOLIO_CODE.get(code) ?? code;
}
