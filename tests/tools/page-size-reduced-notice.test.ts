/**
 * @fileoverview Page maximum clamp notice tests.
 * @module tests/tools/page-size-reduced-notice.test
 */
import { describe, expect, it } from 'vitest';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';

describe('pageSizeReducedNotice', () => {
  it.each([0, 1, 3])('discloses a clamp with %i pages, including empty results', (pages) => {
    expect(pageSizeReducedNotice({ requested: 1001, served: 1000, page: 1, pages })).toBe(
      'per_page=1001 was reduced to 1000, the maximum page size. totalPages counts pages of 1000' +
        (pages > 1 ? ', so page 2 with the same filters continues where this page ends.' : '.'),
    );
  });
  it.each([3, 4])('does not suggest a continuation on page %i', (page) => {
    expect(pageSizeReducedNotice({ requested: 301, served: 300, page, pages: 3 })).toBe(
      'per_page=301 was reduced to 300, the maximum page size. totalPages counts pages of 300.',
    );
  });
  it('says nothing when the requested size was served', () => {
    expect(
      pageSizeReducedNotice({ requested: 200, served: 200, page: 1, pages: 3 }),
    ).toBeUndefined();
  });
});
