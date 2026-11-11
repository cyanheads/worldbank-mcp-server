/**
 * @fileoverview Reduce provider-authored prose — indicator source notes, project
 * objectives and abstracts — to plain text before it reaches either response
 * surface, where markup would otherwise arrive as literal tags (`SE.PRM.INPT`
 * breaks a dash list with `</br>`; project objectives carry `<p>`, `<li>`,
 * `&rsquo;`): break tags become line breaks, other tags go with their text
 * kept, and HTML entities decode.
 * @module services/plain-prose
 */

/**
 * Named entities decoded, case-sensitively as HTML defines them (`&Eacute;` is
 * É, `&eacute;` é): the names measured across the portfolio's project objectives
 * (2026-11-11), plus `apos`. A name outside the set — including the `M&E;`-style
 * shorthand project text carries (`&E;`, `&M;`, `&IRRIG;`) — stays as written.
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['Aacute', 'Á'],
  ['Eacute', 'É'],
  ['aacute', 'á'],
  ['agrave', 'à'],
  ['amp', '&'],
  ['apos', "'"],
  ['atilde', 'ã'],
  ['ccedil', 'ç'],
  ['eacute', 'é'],
  ['ecirc', 'ê'],
  ['egrave', 'è'],
  ['gt', '>'],
  ['iacute', 'í'],
  ['ldquo', '“'],
  ['lsquo', '‘'],
  ['lt', '<'],
  ['middot', '·'],
  ['nbsp', ' '],
  ['ndash', '–'],
  ['oacute', 'ó'],
  ['quot', '"'],
  ['rdquo', '”'],
  ['rsquo', '’'],
  ['sup2', '²'],
]);

/** A tag that ends a line: `<br>` in any of its forms, and the closers of a paragraph or list item. */
const BREAK = /<(?:\/?br\s*\/?|\/(?:p|li)\s*)>/gi;

/**
 * Any other tag, and the bare `</>` closer 1990s records use after SGML-style
 * tags (`<NC>…</>`). Only a `<` followed by a letter or `/` reads as one, so
 * literal brackets in prose (`< 5 years`, `<$2.15 a day`) pass through.
 */
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<\/>/g;

const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;

function decodeEntity(entity: string, body: string): string {
  if (!body.startsWith('#')) return NAMED_ENTITIES.get(body) ?? entity;
  const codePoint =
    body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

/** `text` without the spaces and tabs at the ends named, in time linear in its length. */
function trimHorizontal(text: string, leading: boolean, trailing: boolean): string {
  let start = 0;
  let end = text.length;
  while (leading && start < end && (text[start] === ' ' || text[start] === '\t')) start++;
  while (trailing && end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(start, end);
}

/**
 * Plain text of provider prose. Each break tag becomes one line break, with the
 * spaces and tabs beside it dropped, except at either end of the text, where it
 * adds nothing — so `<p>…</p>` leaves no trailing line break. Other tags are
 * dropped with their text kept, and entities are decoded after the tags are
 * gone, so an encoded `&lt;b&gt;` survives as text. Text without markup comes
 * back unchanged, edge whitespace included; callers that want it gone trim.
 */
export function plainProse(value: string): string {
  const segments = value.split(BREAK);
  const last = segments.length - 1;
  const lines = segments.map((segment, index) =>
    trimHorizontal(segment.replace(TAG, ''), index > 0, index < last),
  );
  let start = 0;
  let end = lines.length;
  while (start < end - 1 && lines[start] === '') start++;
  while (end > start + 1 && lines[end - 1] === '') end--;
  return lines.slice(start, end).join('\n').replace(ENTITY, decodeEntity);
}
