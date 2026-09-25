/**
 * @fileoverview Tests for the notice every capped tool attaches when it serves a
 * smaller page than the one requested.
 * @module tests/tools/page-size-reduced-notice.test
 */

import { describe, expect, it } from 'vitest';
import { pageSizeReducedNotice } from '@/mcp-server/tools/page-size-reduced-notice.js';

describe('pageSizeReducedNotice', () => {
  it('names the served size and the page that continues this one', () => {
    expect(pageSizeReducedNotice({ requested: 1000, served: 200, page: 1, pages: 14 })).toBe(
      'per_page=1000 was reduced to 200, the most one page holds, to keep this response within about 50 KB. totalPages counts pages of 200, so page 2 with the same filters continues where this page ends.',
    );
  });

  it('names no continuation on the last page or past it', () => {
    for (const page of [14, 15]) {
      expect(pageSizeReducedNotice({ requested: 1000, served: 200, page, pages: 14 })).toBe(
        'per_page=1000 was reduced to 200, the most one page holds, to keep this response within about 50 KB. totalPages counts pages of 200.',
      );
    }
  });

  /**
   * A result that fits on one page at the served size is the page the requested
   * size would have served too, so there is no reduction to disclose.
   */
  it('says nothing when the whole result fits on one page at the served size', () => {
    for (const page of [1, 2]) {
      for (const pages of [0, 1]) {
        expect(
          pageSizeReducedNotice({ requested: 1000, served: 200, page, pages }),
        ).toBeUndefined();
      }
    }
  });

  it('says nothing when the requested size was served', () => {
    expect(
      pageSizeReducedNotice({ requested: 200, served: 200, page: 1, pages: 3 }),
    ).toBeUndefined();
  });

  it("carries a tool's own condition on the cap", () => {
    expect(
      pageSizeReducedNotice({
        requested: 50,
        served: 8,
        page: 1,
        pages: 3,
        condition: 'with include_abstract on (80 with include_abstract off)',
      }),
    ).toBe(
      'per_page=50 was reduced to 8, the most one page holds with include_abstract on (80 with include_abstract off), to keep this response within about 50 KB. totalPages counts pages of 8, so page 2 with the same filters continues where this page ends.',
    );
  });
});
