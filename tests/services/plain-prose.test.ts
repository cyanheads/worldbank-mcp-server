/**
 * @fileoverview Tests for plainProse — the one rule that turns provider markup
 * in indicator source notes, project objectives, and project abstracts into
 * plain text — and its linear running time over upstream-sized text.
 * @module tests/services/plain-prose.test
 */

import { describe, expect, it } from 'vitest';
import { plainProse } from '@/services/plain-prose.js';
import { expectLinear } from '../helpers/linear-cpu-time.js';

describe('plainProse', () => {
  it.each([
    ['a <br> b', 'a\nb'],
    ['a<br/>b', 'a\nb'],
    ['a\t<br />\tb', 'a\nb'],
    ['a </br> - b', 'a\n- b'],
    ['a<BR>b', 'a\nb'],
    ['a<br><br>b', 'a\n\nb'],
  ])(
    'turns the break tag in %j into one line break, dropping the spaces beside it',
    (value, plain) => {
      expect(plainProse(value)).toBe(plain);
    },
  );

  it.each([
    ['<p>One aim.</p><p>Another.</p>', 'One aim.\nAnother.'],
    ['through:</p><p>(i) establishing', 'through:\n(i) establishing'],
    ['<ol><li>trade</li><li>productivity</li></ol>', 'trade\nproductivity'],
    // P145251's objective as upstream stores it: list closers with no openers, tabs before items.
    [
      ' \t improve trade</li>\t increase productivity</li>\t improve finance</li></ol>',
      ' \t improve trade\nincrease productivity\nimprove finance',
    ],
  ])('breaks lines at paragraph and list-item closers: %j', (value, plain) => {
    expect(plainProse(value)).toBe(plain);
  });

  it.each([
    ['<p>Only paragraph.</p>', 'Only paragraph.'],
    ['<br>both ends<br>', 'both ends'],
    ['  <br>  leading', 'leading'],
    ['<p>x<br></p>', 'x'],
    ['<br><br>', ''],
  ])('adds no line break for a break at either end of %j', (value, plain) => {
    expect(plainProse(value)).toBe(plain);
  });

  it.each([
    [
      "<span style='font-family:times new roman,serif'>Plan</span> <strong>now</strong>",
      'Plan now',
    ],
    ['<em>a</em> <u>b</u> <ul>c</ul> <h>d</h>', 'a b c d'],
    // 1990s records: SGML-style openers closed by a bare `</>`.
    ['<NC>The objective</> is <KL>clear</>.', 'The objective is clear.'],
  ])('drops other tags with their text kept: %j', (value, plain) => {
    expect(plainProse(value)).toBe(plain);
  });

  it.each([
    ['Government&rsquo;s &ldquo;plan&rdquo; &ndash; &lsquo;x&rsquo;', 'Government’s “plan” – ‘x’'],
    ['&Eacute;cole &eacute;t&eacute; &Aacute;rea &aacute;gua', 'École été Área água'],
    [
      'S&atilde;o &ccedil; &iacute; &oacute; &egrave; &ecirc; &agrave; &middot;',
      'São ç í ó è ê à ·',
    ],
    ['TERRA-MA&sup2; &amp; &quot;q&quot; &apos;s&nbsp;x', 'TERRA-MA² & "q" \'s x'],
    ['&#39;s &#8211; &#x2014; &#X41;', "'s – — A"],
    ['&lt;b&gt;bold&lt;/b&gt;', '<b>bold</b>'],
  ])('decodes the entities in %j after the tags are gone', (value, plain) => {
    expect(plainProse(value)).toBe(plain);
  });

  it.each([
    // Shorthand in project text that only looks like an entity.
    'M&E; framework, R&D; and &IRRIG; works on &SULAWESI;',
    // Named entities match case-sensitively: these spellings are not in the set.
    '&EACUTE; &AMP; &Nbsp;',
    // Names an object literal would resolve through its prototype.
    '&constructor; &toString; &hasOwnProperty;',
    '&#x110000; is past the last code point',
  ])('leaves %j as written', (value) => {
    expect(plainProse(value)).toBe(value);
  });

  it.each([
    'at least 60% of malaria of < 5 years old cases',
    'Share below the poverty line (<$2.15 a day); height <-2 standard deviations; 5 > 3.',
    '  total population). ',
    'one\n\n\ntwo\r\nthree',
  ])('returns %j, which carries no markup, byte-identical', (value) => {
    expect(plainProse(value)).toBe(value);
  });
});

// ─── Timing ───────────────────────────────────────────────────────────────────

describe('timing: plainProse over upstream-sized text', () => {
  /**
   * Upstream objectives and abstracts run to 8,000 characters. The digit run
   * never reaches Bun's slow-regex mode, so it carries the full 5k → 320k span;
   * every other shape stays at or below 64k.
   */
  const shapes: Array<[name: string, base: number, shape: (chars: number) => string]> = [
    ['a digit run', 5_000, (n) => '1'.repeat(n)],
    ['spaces and tabs with no break after them', 1_000, (n) => `${' \t'.repeat(n / 2)}x`],
    ['a break opener with no closer', 1_000, (n) => `<br${' '.repeat(n)}`],
    ['repeated break openers', 1_000, (n) => '<br '.repeat(n / 4)],
    ['breaks with spaces around them', 1_000, (n) => ' <br> '.repeat(n / 6)],
    ['a tag opener with no closer', 1_000, (n) => `<a${' x'.repeat(n / 2)}`],
    ['repeated tag openers', 1_000, (n) => '<a '.repeat(n / 3)],
    ['nested openers', 1_000, (n) => '<</'.repeat(n / 3)],
    ['overlapping break and tag prefixes', 1_000, (n) => '<br/<b</p'.repeat(n / 9)],
    ['an entity opener with no closer', 1_000, (n) => `&${'a'.repeat(n)}`],
    ['a numeric entity with no closer', 1_000, (n) => `&#x${'f'.repeat(n)}`],
    ['repeated entity openers', 1_000, (n) => '&#&a'.repeat(n / 4)],
    ['one long line ending in a break', 1_000, (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', 1_000, (n) => '  \r\n'.repeat(n / 4)],
  ];

  it.each(shapes)('runs in linear time over %s', (_name, base, shape) => {
    expectLinear(base, shape, (text) => plainProse(text));
  });
});
