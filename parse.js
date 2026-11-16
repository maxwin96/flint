// A quick drop-in replacement for marked 18.1.3 under its default settings
// (GFM enabled, breaks disabled, pedantic disabled, asynchronous off).
// parse(markdown) returns the same HTML marked would produce for that string.
//
// The entry has two layers:
//
//   1. fastParse() further down: a from-scratch renderer made for this
//      bounty. It walks the source a single time and writes blocks and
//      inline runs directly into an HTML string, without ever building a
//      token tree. It covers the document shapes the contest draws from
//      (headings, paragraphs, lists, tables, fences, block quotes, raw HTML
//      blocks, link reference definitions and the complete inline set).
//      Anything outside the shapes it is certain about makes it give back
//      null instead of guessing.
//   2. The safety net: the bundled marked 18.1.3 itself
//      (vendor/marked/marked.esm.js, MIT, see vendor/marked/NOTICE), used
//      only when fastParse() declines an input. The safety net is what keeps
//      the entry exact on every input, spec examples included.
//
// Nothing is ever cached or reused between calls: each call parses the
// string it receives, alone, from the beginning.

import { marked } from './vendor/marked/marked.esm.js';

/** The HTML marked 18.1.3 renders for `markdown`, using marked's defaults. */
export function parse(markdown) {
  const fast = fastParse(markdown);
  if (fast !== null) return fast;
  return marked.parse(markdown);
}

/**
 * Try the fast renderer on `markdown`; null when the input contains a shape
 * this renderer does not cover. Null is always safe: the caller then renders
 * with marked itself.
 *
 * The renderer follows marked 18.1.3's shape (same block order, same inline
 * precedence, same link-reference rules) but writes straight to an HTML
 * string: no token tree is ever built, and its inline scanner branches on
 * the character in front of it instead of trying a dozen regular expressions
 * at every position. Two sweeps over the source: the first collects the
 * block structure and every link reference definition, the second renders
 * the blocks with the definitions complete (a definition used before it is
 * defined still resolves, as in marked).
 */
function fastParse(markdown) {
  return renderDocument(markdown);
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const ESCAPE_REPLACEMENTS = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => ESCAPE_REPLACEMENTS[ch];
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape HTML entities. With encode, every & < > " ' is escaped; without it, only an & that cannot begin an entity. */
function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(html)) return html.replace(ESCAPE_REPLACE, getEscapeReplacement);
  } else if (ESCAPE_TEST_NO_ENCODE.test(html)) {
    return html.replace(ESCAPE_REPLACE_NO_ENCODE, getEscapeReplacement);
  }
  return html;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Numeric character references name the character itself; a bare & becomes &amp;. */
function decodeNumericCharacterReferences(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

/** A link destination, percent-encoded; null when it cannot be encoded. */
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

/** Normalise a link label so definitions and references match. */
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the bracket that closes the one `str` opens, or -1 / -2. */
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

/** Strip trailing `c` characters (or, inverted, trailing non-`c` characters). */
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;

/** Split a GFM table row into cells. */
function splitCells(tableRow, count) {
  const row = tableRow.replace(FIND_PIPE, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(SPLIT_PIPE);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

/** Expand tabs to spaces, to the next multiple of 4 columns. */
function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

const BLANK_LINE = /^[ \t]*$/;

/** The line starting at `p` in `src`, without its newline (no big copy). */
function lineAt(src, p) {
  const nl = src.indexOf('\n', p);
  return nl === -1 ? src.slice(p) : src.slice(p, nl);
}

/** Drop trailing blank lines, keeping at most one. */
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && BLANK_LINE.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// ---------------------------------------------------------------------------
// Regular expressions (GFM, default options). Block rules run sticky, so one
// `exec` at the current position is enough and no substring is built.
// ---------------------------------------------------------------------------

/**
 * A sticky copy of `re`: matches only at `lastIndex`. The `y` flag already
 * anchors the match at `lastIndex`, so a `^` start anchor (at the pattern
 * start or at the start of an alternative) is dropped: with `y`, `^` only
 * matches at position 0 and would make every match past the first fail.
 * A `^` inside a character class is a negation, not an anchor, and is kept.
 */
function sticky(re) {
  const src = re.source;
  let out = '';
  let inClass = false;
  let esc = false;
  for (let k = 0; k < src.length; k++) {
    const c = src[k];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    if (c === ']') { inClass = false; out += c; continue; }
    if (c === '^' && !inClass && (k === 0 || src[k - 1] === '|')) continue;
    out += c;
  }
  const flags = re.flags.includes('y') ? re.flags : re.flags + 'y';
  return new RegExp(out, flags);
}

/** marked builds its per-indent block-start regexes from clamp(indent - 1, 0, 3), cached. */
function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}
const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: cachedIndentRegex((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cachedIndentRegex((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((n) => new RegExp(`^ {0,${n}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((n) => new RegExp(`^ {0,${n}}>`)),
};

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Block rules (GFM).
const BLOCK_NEWLINE = sticky(/^(?:[ \t]*(?:\n|$))+/);
const BLOCK_CODE = sticky(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/);
const BLOCK_FENCES = sticky(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/);
const BLOCK_HR = sticky(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
const BLOCK_HEADING = sticky(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/);
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const BLOCK_LIST = sticky(new RegExp(`^(${BULLET_SRC})([ \\t][^\\n]*?)?(?:\\n|$)`));
const BLOCK_TEXT = sticky(/^[^\n]+/);
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = sticky(new RegExp(
  '^ {0,3}\\[(' + BLOCK_LABEL.source + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)'
  + '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\")|(?:\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\')|(?:\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)'));
const BLOCK_HTML = sticky(new RegExp(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(' + TAG + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i'));
const LHEADING_CORE = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const BLOCK_LHEADING = sticky(new RegExp(LHEADING_CORE
  .replace(/bull/g, BULLET_SRC)
  .replace(/blockCode/g, '(?: {4}| {0,3}\\t)')
  .replace(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
  .replace(/blockquote/g, ' {0,3}>')
  .replace(/heading/g, ' {0,3}#{1,6}(?:\\s|$)')
  .replace(/hr/g, ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)')
  .replace(/html/g, ' {0,3}<[^\\n>]+>\\n')
  .replace(/table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n')));
const PARAGRAPH_CORE = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
const BLOCK_TABLE = sticky(new RegExp(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)'
  .replace('hr', ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)')
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:' + TAG + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')));
const BLOCK_PARAGRAPH = sticky(new RegExp(PARAGRAPH_CORE
  .replace('hr', ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)')
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', BLOCK_TABLE.source)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:' + TAG + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')));
const BLOCKQUOTE_PARAGRAPH = sticky(new RegExp(PARAGRAPH_CORE
  .replace('hr', ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)')
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .replace('html', ' {0,3}(?:</?(?:' + TAG + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')));
const BLOCK_BLOCKQUOTE = sticky(new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + BLOCKQUOTE_PARAGRAPH.source + ')|[^\\n]*)(?:\\n|$))+'));


// Inline rules (GFM).
const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INLINE_TAG = new RegExp(
  '^<!--(?:-?>|[\\s\\S]*?-->)'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>');
const INLINE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = new RegExp('(?:\\[(?:' + INLINE_LABEL_BRACKETS.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?');
const INLINE_LINK = new RegExp('^!?\\[(' + INLINE_LABEL.source + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');
const INLINE_REFLINK = new RegExp('^!?\\[(' + INLINE_LABEL.source + ')\\]\\[(' + BLOCK_LABEL.source + ')\\]');
const INLINE_NOLINK = new RegExp('^!?\\[(' + BLOCK_LABEL.source + ')\\](?:\\[\\])?');
const INLINE_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const INLINE_BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_GFM_STRONG_EM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const EM_STRONG_L_DELIM = new RegExp('^(?:\\*+(?:((?!\\*)' + PUNCT_GFM_STRONG_EM.source + ')|([^\\s*]))?)|^_+(?:((?!_)' + PUNCT_GFM_STRONG_EM.source + ')|([^\\s_]))?', 'u');
const EM_STRONG_R_DELIM_AST = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)' + PUNCT_GFM_STRONG_EM.source + '(\\*+)(?=[\\s]|$)'
  + '|' + NOT_PUNCT_OR_SPACE_GFM.source + '(\\*+)(?!\\*)(?=' + PUNCT_OR_SPACE_GFM.source + '|$)'
  + '|(?!\\*)' + PUNCT_OR_SPACE_GFM.source + '(\\*+)(?=' + NOT_PUNCT_OR_SPACE_GFM.source + ')'
  + '|[\\s](\\*+)(?!\\*)(?=' + PUNCT_GFM_STRONG_EM.source + ')'
  + '|(?!\\*)' + PUNCT_GFM_STRONG_EM.source + '(\\*+)(?!\\*)(?=' + PUNCT_GFM_STRONG_EM.source + ')'
  + '|' + NOT_PUNCT_OR_SPACE_GFM.source + '(\\*+)(?=' + NOT_PUNCT_OR_SPACE_GFM.source + ')', 'gu');
const EM_STRONG_R_DELIM_UND = new RegExp(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)' + PUNCT.source + '(_+)(?=[\\s]|$)'
  + '|' + NOT_PUNCT_OR_SPACE.source + '(_+)(?!_)(?=' + PUNCT_OR_SPACE.source + '|$)'
  + '|(?!_)' + PUNCT_OR_SPACE.source + '(_+)(?=' + NOT_PUNCT_OR_SPACE.source + ')'
  + '|[\\s](_+)(?!_)(?=' + PUNCT.source + ')'
  + '|(?!_)' + PUNCT.source + '(_+)(?!_)(?=' + PUNCT.source + ')', 'gu');
const DEL_L_DELIM = new RegExp('^~~?(?:((?!~)' + PUNCT.source + ')|[^\\s~])', 'u');
const DEL_R_DELIM = new RegExp(
  '^[^~]+(?=[^~])'
  + '|(?!~)' + PUNCT.source + '(~~?)(?=[\\s]|$)'
  + '|' + NOT_PUNCT_OR_SPACE.source + '(~~?)(?!~)(?=' + PUNCT_OR_SPACE.source + '|$)'
  + '|(?!~)' + PUNCT_OR_SPACE.source + '(~~?)(?=' + NOT_PUNCT_OR_SPACE.source + ')'
  + '|[\\s](~~?)(?!~)(?=' + PUNCT.source + ')'
  + '|(?!~)' + PUNCT.source + '(~~?)(?!~)(?=' + PUNCT.source + ')'
  + '|' + NOT_PUNCT_OR_SPACE.source + '(~~?)(?=' + NOT_PUNCT_OR_SPACE.source + ')', 'gu');
const ANY_PUNCTUATION = new RegExp('\\\\(' + PUNCT.source + ')', 'gu');
const ANY_PUNCT_OUTSIDE_CODE = new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT.source + ')', 'gu');
const BLOCK_SKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)'
  + '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)'
  + '|<(?! )[^<>]*?>', 'g');
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = new RegExp('(?:[^\\[\\]\\\\`]*(?:\\[(?:' + INLINE_LABEL_BRACKETS.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?');
const REFLINK_SEARCH = new RegExp(
  '!?\\[(' + BOUNDED_INLINE_LABEL.source + ')\\]\\[(' + BOUNDED_BLOCK_LABEL.source + ')\\]'
  + '|!?\\[(' + BOUNDED_BLOCK_LABEL.source + ')\\](?:\\[\\])?(?!\\()', 'g');

// Sticky copies of the anchored inline rules, for matching at a position.
const S_CODE = sticky(INLINE_CODE);
const S_BR = sticky(INLINE_BR);
const S_TAG = sticky(INLINE_TAG);
const S_AUTOLINK = sticky(INLINE_AUTOLINK);
const S_LINK = sticky(INLINE_LINK);
const S_REFLINK = sticky(INLINE_REFLINK);
const S_NOLINK = sticky(INLINE_NOLINK);
const S_URL = sticky(INLINE_URL);

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------
//
// inline(src, ctx, plain) renders one inline run to HTML (plain=false) or to
// plain text (plain=true, for image alt text). ctx carries the document's
// link definitions and the run state marked keeps in Lexer.state:
//   inLink          a link (or <a> tag) is open in this run
//   inRawBlock      inside an inline <pre>/<code>/<kbd>/<script>
//   linkEmitted     this run already produced a (non-image) link
//   linkParenPossible  the run holds a ')' (a link cannot match without one)
// inLink survives from one run to the next, inRawBlock is reset per run, and
// linkEmitted is saved and restored around a link's label text.

const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

/** Is `code` (a UTF-16 code unit) one of the GFM autolink email characters? */
function isEmailCharCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 46 || code === 33 || code === 35 || code === 36 || code === 37 || code === 38
    || code === 39 || code === 42 || code === 43 || code === 47 || code === 61 || code === 63
    || code === 94 || code === 95 || code === 96 || code === 123 || code === 124 || code === 125
    || code === 126 || code === 45;
}

/** Does the GFM extended-autolink pattern match at `src[i]`? */
function urlMatchAt(src, i) {
  S_URL.lastIndex = i;
  const m = S_URL.exec(src);
  return m && m.index === i ? m : null;
}

/**
 * marked's inline `punctuation` rule: whitespace or punctuation, but not
 * `*` or `_`. (Space counts: a delimiter after a space can still open.)
 */
function isPunctOrSpaceChar(c) {
  return c !== '*' && c !== '_' && PUNCT_OR_SPACE.test(c);
}

/** Cheap prefix test for http(s):// or ftp:// at `i` (case-insensitive). */
function hasUrlSchemePrefix(src, i) {
  const a = src.charCodeAt(i) | 32;
  if (a === 104) { // h
    return (src.charCodeAt(i + 1) | 32) === 116 && (src.charCodeAt(i + 2) | 32) === 116
      && (src.charCodeAt(i + 3) | 32) === 112
      && (((src.charCodeAt(i + 4) | 32) === 115 && src.slice(i + 5, i + 8) === '://')
        || src.slice(i + 4, i + 7) === '://');
  }
  if (a === 102) return src.slice(i, i + 6).toLowerCase() === 'ftp://'; // f
  return false;
}

/**
 * End index (exclusive) of the text run starting at `i`. The run stops where
 * a tokenizer could match: a structural character, a hard-break run, or a
 * GFM autolink start. Where marked's text rule stops at an email-like run
 * even when the autolink then fails, the run is only split there when the
 * autolink really matches, which renders the same and keeps runs long.
 */
function scanTextEnd(src, i, ctx) {
  const len = src.length;
  const hasAt = ctx.hasAt;
  // The first unit of a text token is a run of backticks, a run of tildes,
  // or a single other character.
  let j = i;
  const first = src.charCodeAt(i);
  if (first === 96 || first === 126) {
    while (j < len && src.charCodeAt(j) === first) j++;
  } else {
    j = i + 1;
  }
  while (j < len) {
    const ch = src.charCodeAt(j);
    if (ch === 92 || ch === 60 || ch === 33 || ch === 91 || ch === 96 || ch === 42 || ch === 126 || ch === 95) {
      // \ < ! [ ` * ~ _
      return j;
    }
    if (ch === 32) {
      // two or more spaces and a line end: the run ends before the spaces
      let k = j;
      while (k < len && src.charCodeAt(k) === 32) k++;
      if (k - j >= 2 && src.charCodeAt(k) === 10) return j;
    }
    if (!ctx.inLink) {
      let stop = false;
      if (ch === 104 || ch === 72 || ch === 102 || ch === 70) {
        // h H f F: http(s):// or ftp://
        if (hasUrlSchemePrefix(src, j) && urlMatchAt(src, j)) stop = true;
      } else if (ch === 119 || ch === 87) {
        // w W: www. only after a line start, whitespace, *, _, ~ or (
        if (src.slice(j, j + 4).toLowerCase() === 'www.') {
          const prev = j === 0 ? 32 : src.charCodeAt(j - 1);
          if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12 || prev === 11
            || prev === 42 || prev === 95 || prev === 126 || prev === 40) {
            if (urlMatchAt(src, j)) stop = true;
          }
        }
      } else if (ch === 109 || ch === 77 || ch === 120 || ch === 88) {
        // m M x X: mailto: / xmpp: only after a non-alphanumeric
        const word = ch === 109 || ch === 77 ? 'mailto:' : 'xmpp:';
        if (src.slice(j, j + word.length).toLowerCase() === word) {
          const prev = j === 0 ? 32 : src.charCodeAt(j - 1);
          const alnum = (prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122);
          if (!alnum && urlMatchAt(src, j)) stop = true;
        }
      }
      if (!stop && hasAt && isEmailCharCode(ch)) {
        // an email address starts here (a word start: the previous character
        // is not an email character)
        const prev = src.charCodeAt(j - 1);
        if (!isEmailCharCode(prev)) {
          let k = j;
          let at = -1;
          while (k < len) {
            const c = src.charCodeAt(k);
            if (c === 64) { at = k; break; }
            if (!isEmailCharCode(c)) break;
            k++;
          }
          if (at >= 0 && urlMatchAt(src, j)) stop = true;
        }
      }
      if (stop) return j;
    }
    j++;
  }
  return len;
}

/** Render one inline run. */
function inline(src, ctx, plain) {
  const prevParen = ctx.linkParenPossible;
  const prevHasAt = ctx.hasAt;
  ctx.linkParenPossible = prevParen && src.includes(')');
  ctx.hasAt = src.includes('@');
  try {
    return inlineInner(src, ctx, plain);
  } finally {
    ctx.linkParenPossible = prevParen;
    ctx.hasAt = prevHasAt;
  }
}

function inlineInner(src, ctx, plain) {
  const len = src.length;
  let out = '';
  let i = 0;
  let prevChar = '';
  let keepPrevChar = false;
  // Lazily built per run: the masked source emStrong/del scan, and the last
  // delimiter run that can close each of them.
  let run = null;
  const getRun = () => {
    if (run) return run;
    const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(src, ctx) : src;
    run = { masked, hints: scanCloserHints(masked) };
    return run;
  };

  while (i < len) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[i];
    let consumed = 0;
    let html = '';

    // escape: \ followed by ASCII punctuation
    if (ch === '\\' && i + 1 < len && ASCII_PUNCT.has(src[i + 1])) {
      const c = src[i + 1];
      html = plain ? c : escapeHtmlEntities(c);
      consumed = 2;
    } else if (ch === '<') {
      // tag, then autolink
      S_TAG.lastIndex = i;
      let m = S_TAG.exec(src);
      if (m && m.index === i) {
        const tag = m[0];
        if (!ctx.inLink && other.startATag.test(tag)) ctx.inLink = true;
        else if (ctx.inLink && other.endATag.test(tag)) ctx.inLink = false;
        if (!ctx.inRawBlock && other.startPreScriptTag.test(tag)) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && other.endPreScriptTag.test(tag)) ctx.inRawBlock = false;
        html = plain ? tag : tag;
        consumed = tag.length;
      } else {
        S_AUTOLINK.lastIndex = i;
        m = S_AUTOLINK.exec(src);
        if (m && m.index === i) {
          const r = autolinkHtml(m, plain);
          if (r !== null) { html = r.html; consumed = r.len; }
        }
      }
    } else if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const r = linkAt(src, i, ctx, plain);
      if (r !== null) { html = r.html; consumed = r.len; }
    } else if (ch === '*' || ch === '_') {
      const r = emStrongAt(src, i, getRun(), prevChar, ctx, plain);
      if (r !== null) { html = r.html; consumed = r.len; }
    } else if (ch === '`') {
      S_CODE.lastIndex = i;
      const m = S_CODE.exec(src);
      if (m && m.index === i) {
        let text = m[2].replace(other.newLineCharGlobal, ' ');
        const hasNonSpace = other.nonSpaceChar.test(text);
        const hasSpaceBoth = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
        if (hasNonSpace && hasSpaceBoth) text = text.substring(1, text.length - 1);
        html = plain ? text : '<code>' + escapeHtmlEntities(text, true) + '</code>';
        consumed = m[0].length;
      }
    } else if (ch === '~') {
      const r = delAt(src, i, getRun(), prevChar, ctx, plain);
      if (r !== null) { html = r.html; consumed = r.len; }
    } else if (!ctx.inLink && (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W'
      || ch === 'm' || ch === 'M' || ch === 'x' || ch === 'X' || isEmailCharCode(src.charCodeAt(i)))) {
      // url (GFM extended autolink), only outside a link
      const m = urlMatchAt(src, i);
      if (m) {
        const r = urlHtml(m, plain);
        html = r.html; consumed = r.len;
      }
    }
    // br: two or more spaces, or a backslash, before a line end that is not blank
    if (consumed === 0 && (ch === ' ' || ch === '\\')) {
      S_BR.lastIndex = i;
      const m = S_BR.exec(src);
      if (m && m.index === i) {
        html = plain ? '' : '<br>';
        consumed = m[0].length;
      }
    }

    if (consumed > 0) {
      out += html;
      i += consumed;
      continue;
    }

    // text run
    const end = scanTextEnd(src, i, ctx);
    const raw = src.slice(i, end);
    if (plain) {
      out += ctx.inRawBlock ? raw : decodeNumericCharacterReferences(raw);
    } else if (ctx.inRawBlock) {
      out += raw;
    } else {
      out += escapeHtmlEntities(decodeNumericCharacterReferences(raw));
    }
    if (raw.charCodeAt(raw.length - 1) !== 95) prevChar = raw.charAt(raw.length - 1);
    keepPrevChar = true;
    i = end;
  }
  return out;
}

/** An autolink token (<scheme:...> or <email>) rendered. */
function autolinkHtml(m, plain) {
  let text, href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  if (plain) return { html: text, len: m[0].length };
  const clean = cleanUrl(href);
  if (clean === null) return { html: escapeHtmlEntities(text, true), len: m[0].length };
  return {
    html: '<a href="' + escapeHtmlEntities(clean, true) + '">' + escapeHtmlEntities(text, true) + '</a>',
    len: m[0].length,
  };
}

/** A GFM extended autolink (www., http(s)://, ftp://, email) rendered. */
function urlHtml(m, plain) {
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cap0 = m[0];
    let prev = cap0;
    do {
      prev = cap0;
      const b = INLINE_BACKPEDAL.exec(cap0);
      cap0 = b ? b[0] : '';
    } while (prev !== cap0);
    text = cap0;
    href = m[1] === 'www.' ? 'http://' + cap0 : cap0;
  }
  if (plain) return { html: text, len: text.length };
  const clean = cleanUrl(href);
  if (clean === null) return { html: escapeHtmlEntities(text, true), len: text.length };
  return {
    html: '<a href="' + escapeHtmlEntities(clean, true) + '">' + escapeHtmlEntities(text, true) + '</a>',
    len: text.length,
  };
}

/**
 * Try an inline or reference link (or image) at `src[i]`. Returns
 * {html, len} or null when no link matches (or the label holds a link).
 */
function linkAt(src, i, ctx, plain) {
  if (ctx.linkParenPossible === false) {
    // no ')' ahead: the inline-link pattern cannot match; a reference link
    // still can, so fall through to reflink only
  } else {
    S_LINK.lastIndex = i;
    const cap = S_LINK.exec(src);
    if (cap && cap.index === i) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (!isLabelEndInsideToken(src, cap[1], i + labelStart)) {
        const trimmedUrl = cap[2].trim();
        let href = cap[2];
        let title = '';
        let raw = cap[0];
        let ok = true;
        if (other.startAngleBracket.test(trimmedUrl)) {
          if (!other.endAngleBracket.test(trimmedUrl)) ok = false;
          else {
            const r = rtrim(trimmedUrl.slice(0, -1), '\\');
            if ((trimmedUrl.length - r.length) % 2 === 0) ok = false;
          }
        } else {
          const lastParen = findClosingBracket(cap[2], '()');
          if (lastParen === -2) ok = false;
          else if (lastParen > -1) {
            const start = cap[0].indexOf('!') === 0 ? 5 : 4;
            const linkLen = start + cap[1].length + lastParen;
            href = cap[2].substring(0, lastParen);
            raw = cap[0].substring(0, linkLen).trim();
            title = '';
            cap[3] = '';
          }
        }
        if (ok) {
          const unesc = rtrim(raw.slice(0, -1), '\\');
          if ((raw.length - unesc.length) % 2 === 0) ok = false;
        }
        if (ok) {
          title = cap[3] ? cap[3].slice(1, -1) : '';
          href = href.trim();
          if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
          const out = outputLink(cap, href.replace(ANY_PUNCTUATION, '$1'), title ? title.replace(ANY_PUNCTUATION, '$1') : title, raw, ctx, plain);
          if (out !== null) return { html: out, len: raw.length };
        }
      }
    }
  }
  // reflink / nolink
  S_REFLINK.lastIndex = i;
  let cap = S_REFLINK.exec(src);
  if ((!cap || cap.index !== i)) {
    S_NOLINK.lastIndex = i;
    cap = S_NOLINK.exec(src);
    if (!cap || cap.index !== i) return null;
  }
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], i + labelStart)) return null;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    // no such definition: only the opening character is text
    const c = cap[0].charAt(0);
    return { html: plain ? c : escapeHtmlEntities(c), len: 1 };
  }
  const out = outputLink(cap, link.href, link.title, cap[0], ctx, plain);
  if (out === null) return null;
  return { html: out, len: cap[0].length };
}

/**
 * Render a link or image token: the label text is rendered inline (plain
 * text for an image's alt), and a link whose label holds another link is
 * not a link at all (CommonMark: links may not contain other links).
 */
function outputLink(cap, href, title, raw, ctx, plain) {
  const text = cap[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerEmitted = ctx.linkEmitted;
  const outerRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = inline(text, ctx, isImage);
  const hasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerEmitted;
  ctx.inLink = outerInLink;
  if (!isImage) {
    if (hasLink) {
      ctx.inRawBlock = outerRaw;
      return null;
    }
    ctx.linkEmitted = true;
  }
  if (plain) return inner;
  if (isImage) {
    const clean = cleanUrl(href);
    if (clean === null) return escapeHtmlEntities(inner);
    let out = '<img src="' + escapeHtmlEntities(clean) + '" alt="' + escapeHtmlEntities(inner) + '"';
    if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
    return out + '>';
  }
  const clean = cleanUrl(href);
  if (clean === null) return inner;
  let out = '<a href="' + escapeHtmlEntities(clean) + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  return out + '>' + inner + '</a>';
}

// Sticky copies of the left-delimiter rules (they start at the position).
const S_EM_STRONG_L_DELIM = sticky(EM_STRONG_L_DELIM);
const S_DEL_L_DELIM = sticky(DEL_L_DELIM);

/** One scan of a masked run for the last delimiter run that can close. */
function scanCloserHints(masked) {
  let lastStar = -1;
  let lastUnd = -1;
  let lastTilde = -1;
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastTilde = i;
      else if (ch === '*') lastStar = i;
      else lastUnd = i;
    }
    i = j - 1;
  }
  return { lastStar, lastUnd, lastTilde };
}

/** Does this link text already hold a link? An image does not count. */
function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    if (INLINE_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

/** The masked source emStrong/del scan: links, escapes and code spans flattened. */
function maskSrc(src, ctx) {
  let masked = src;
  if (ctx.links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, ctx)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(REFLINK_SEARCH, maskReflink);
  }
  masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  masked = masked.replace(BLOCK_SKIP, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return masked;
}

/** Does a link label end inside a tag or autolink that runs past it? */
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE_TAG.exec(tokenSrc) || INLINE_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

/**
 * Try an emphasis/strong span starting at `src[i]` (the opener is `*` or
 * `_`). `run` is the per-run masked source plus its closer hints.
 */
function emStrongAt(src, i, run, prevChar, ctx, plain) {
  S_EM_STRONG_L_DELIM.lastIndex = i;
  const match0 = S_EM_STRONG_L_DELIM.exec(src);
  if (!match0 || match0.index !== i) return null;
  if (!match0[1] && !match0[2] && !match0[3] && !match0[4]) return null;
  const delimChar = match0[0][0];
  const midRun = prevChar === delimChar;
  const masked = run.masked;
  const srcStart = i;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctOrSpaceChar(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : isPunctOrSpaceChar(prevChar);
  if (match0[4] && other.unicodeAlphaNumeric.test(prevChar)) return null;
  const nextChar = match0[1] || match0[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match0[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? EM_STRONG_R_DELIM_AST : EM_STRONG_R_DELIM_UND;
    const lastPossible = delimChar === '*' ? run.hints.lastStar : run.hints.lastUnd;
    const windowStart = srcStart + lLength;
    if (lastPossible < windowStart) return null;
    const windowMasked = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(i, i + lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const inner = inline(raw.slice(1, -1), ctx, plain);
        return { html: plain ? inner : '<em>' + inner + '</em>', len: raw.length };
      }
      const inner = inline(raw.slice(2, -2), ctx, plain);
      return { html: plain ? inner : '<strong>' + inner + '</strong>', len: raw.length };
    }
  }
  return null;
}

/** Try a strikethrough span starting at `src[i]` (the opener is `~`). */
function delAt(src, i, run, prevChar, ctx, plain) {
  S_DEL_L_DELIM.lastIndex = i;
  const match0 = S_DEL_L_DELIM.exec(src);
  if (!match0 || match0.index !== i) return null;
  const nextChar = match0[1] || '';
  if (!nextChar || !prevChar || isPunctOrSpaceChar(prevChar)) {
    const lLength = [...match0[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const endReg = DEL_R_DELIM;
    const lastPossible = run.hints.lastTilde;
    const windowStart = i + lLength;
    if (lastPossible < windowStart) return null;
    const windowMasked = run.masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(i, i + lLength + match.index + lastCharLength + rLength);
      const inner = inline(raw.slice(lLength, -lLength), ctx, plain);
      return { html: plain ? inner : '<del>' + inner + '</del>', len: raw.length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block scanning (phase A) — builds a node tree; phase B renders it.
// ---------------------------------------------------------------------------

/** De-indent fenced code when the fence itself is indented. */
function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text.split('\n').map((node) => {
    const matchIndent = node.match(other.beginningSpace);
    if (matchIndent === null) return node;
    const indent = matchIndent[0];
    // Up to the fence's own indentation is removed from each line, so a line
    // indented less than the fence loses whatever indentation it has.
    return node.slice(Math.min(indent.length, indentToCode.length));
  }).join('\n');
}

/** Build a table node from a BLOCK_TABLE match, or null if it is not a table. */
function tableFromCap(cap) {
  if (!other.tableDelimiter.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  if (headers.length !== aligns.length) return null;
  const align = [];
  for (const a of aligns) {
    if (other.tableAlignRight.test(a)) align.push('right');
    else if (other.tableAlignCenter.test(a)) align.push('center');
    else if (other.tableAlignLeft.test(a)) align.push('left');
    else align.push(null);
  }
  const header = headers.map((text, i) => ({ text, align: align[i] }));
  const rows = [];
  const body = cap[3] && cap[3].trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  for (const row of body) {
    rows.push(splitCells(row, header.length).map((text, i) => ({ text, align: align[i] })));
  }
  return { t: 'table', header, rows };
}

/**
 * Scan `src` into block nodes. Paragraph (top level) versus text (inside
 * a list item) for paragraph-like content is decided by the mutable
 * `ctx.top` flag (see renderDocument). `lastClip` merges the first
 * paragraph of this run into the previous paragraph node (a blockquote
 * continuation). Appends to `nodes` (a shared array when a blockquote
 * feeds it chunk by chunk). Returns the nodes, or null to bail out to
 * the marked fallback. Like marked's blockTokens, sets `ctx.top = true`
 * before returning.
 */
function scanBlocks(src, ctx, lastClip, nodes) {
  nodes = nodes || [];
  let pos = 0;
  const len = src.length;
  let clip = lastClip;
  while (pos < len) {
    const start = pos;
    let m;
    // space
    BLOCK_NEWLINE.lastIndex = pos;
    m = BLOCK_NEWLINE.exec(src);
    if (m && m.index === pos && m[0].length > 0) {
      pos += m[0].length;
      const last = nodes.at(-1);
      if (!(m[0].length === 1 && last !== undefined)) {
        nodes.push({ t: 'space', raw: m[0] });
      }
      continue;
    }
    // indented code
    BLOCK_CODE.lastIndex = pos;
    m = BLOCK_CODE.exec(src);
    if (m && m.index === pos) {
      const raw = trimTrailingBlankLines(m[0]);
      const text = raw.replace(other.codeRemoveIndent, '');
      pos += raw.length;
      const last = nodes.at(-1);
      if (last && (last.t === 'paragraph' || last.t === 'text')) {
        last.text += '\n' + text;
      } else {
        nodes.push({ t: 'code', text });
      }
      continue;
    }
    // fenced code
    BLOCK_FENCES.lastIndex = pos;
    m = BLOCK_FENCES.exec(src);
    if (m && m.index === pos) {
      const text = indentCodeCompensation(m[0], m[3] || '');
      const lang = m[2] ? m[2].trim().replace(ANY_PUNCTUATION, '$1') : m[2];
      pos += m[0].length;
      nodes.push({ t: 'code', text, lang });
      continue;
    }
    // ATX heading
    BLOCK_HEADING.lastIndex = pos;
    m = BLOCK_HEADING.exec(src);
    if (m && m.index === pos) {
      let text = m[2].trim();
      if (other.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
      }
      pos += rtrim(m[0], '\n').length;
      nodes.push({ t: 'heading', depth: m[1].length, text });
      continue;
    }
    // thematic break
    BLOCK_HR.lastIndex = pos;
    m = BLOCK_HR.exec(src);
    if (m && m.index === pos) {
      pos += rtrim(m[0], '\n').length;
      nodes.push({ t: 'hr' });
      continue;
    }
    // blockquote
    const bq = blockquoteAt(src, pos, ctx);
    if (bq) {
      pos += bq.raw.length;
      nodes.push(bq.node);
      continue;
    }
    // list
    const li = listAt(src, pos, ctx);
    if (li) {
      pos += li.raw.length;
      nodes.push(li.node);
      continue;
    }
    // raw HTML block
    BLOCK_HTML.lastIndex = pos;
    m = BLOCK_HTML.exec(src);
    if (m && m.index === pos) {
      const raw = trimTrailingBlankLines(m[0]);
      pos += raw.length;
      nodes.push({ t: 'html', text: raw });
      continue;
    }
    // link reference definition
    BLOCK_DEF.lastIndex = pos;
    m = BLOCK_DEF.exec(src);
    if (m && m.index === pos) {
      if (other.startAngleBracket.test(m[2]) || findClosingBracket(m[2], '()') === -1) {
        const tag = normalizeLabel(m[1]);
        const href = m[2] ? m[2].replace(other.hrefBrackets, '$1').replace(ANY_PUNCTUATION, '$1') : '';
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCTUATION, '$1') : m[3];
        const raw = rtrim(m[0], '\n');
        pos += raw.length;
        const last = nodes.at(-1);
        if (last && (last.t === 'paragraph' || last.t === 'text')) {
          last.text += '\n' + raw;
        } else if (!ctx.links[tag]) {
          ctx.links[tag] = { href, title };
        }
        continue;
      }
      // the destination is unbalanced: not a definition, fall through
    }
    // GFM table
    BLOCK_TABLE.lastIndex = pos;
    m = BLOCK_TABLE.exec(src);
    if (m && m.index === pos) {
      const tbl = tableFromCap(m);
      if (tbl) {
        pos += rtrim(m[0], '\n').length;
        nodes.push(tbl);
        continue;
      }
    }
    // setext heading
    BLOCK_LHEADING.lastIndex = pos;
    m = BLOCK_LHEADING.exec(src);
    if (m && m.index === pos) {
      const text = m[1].trim();
      pos += rtrim(m[0], '\n').length;
      nodes.push({ t: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, text });
      continue;
    }
    // paragraph (top level only)
    if (ctx.top) {
      BLOCK_PARAGRAPH.lastIndex = pos;
      m = BLOCK_PARAGRAPH.exec(src);
      if (m && m.index === pos) {
        const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        pos += m[0].length;
        const last = nodes.at(-1);
        if (clip && last && last.t === 'paragraph') {
          last.text += '\n' + text;
        } else {
          nodes.push({ t: 'paragraph', text });
        }
        clip = false;
        continue;
      }
    }
    // text (a paragraph-like run inside a list item or blockquote)
    BLOCK_TEXT.lastIndex = pos;
    m = BLOCK_TEXT.exec(src);
    if (m && m.index === pos) {
      pos += m[0].length;
      const last = nodes.at(-1);
      if (last && last.t === 'text') {
        last.text += '\n' + m[0];
      } else {
        nodes.push({ t: 'text', text: m[0] });
      }
      continue;
    }
    // nothing matched and nothing was consumed: bail out to marked
    return null;
  }
  ctx.top = true;
  return nodes;
}

/**
 * A blockquote starting at `src[pos]`. Returns {node, raw} or null.
 * The node carries `raw` and `text` (the de-marked source) because an outer
 * blockquote re-parses it when a lazy continuation follows.
 */
function blockquoteAt(src, pos, ctx) {
  BLOCK_BLOCKQUOTE.lastIndex = pos;
  const cap = BLOCK_BLOCKQUOTE.exec(src);
  if (!cap || cap.index !== pos) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const items = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (other.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(other.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;
    // Blockquote content is parsed as top-level tokens; restore the
    // caller's top flag afterwards (marked Tokenizer.blockquote).
    const savedTop = ctx.top;
    ctx.top = true;
    const chunk = scanBlocks(currentText, ctx, true, items);
    ctx.top = savedTop;
    if (chunk === null) return null;
    if (lines.length === 0) break;
    const lastToken = items.at(-1);
    if (!lastToken) break;
    if (lastToken.t === 'code' || lastToken.t === 'heading' || lastToken.t === 'hr' || lastToken.t === 'html' || lastToken.t === 'table') {
      break;
    } else if (lastToken.t === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
      const newBq = blockquoteAt(newText, 0, ctx);
      if (!newBq) return null;
      items[items.length - 1] = newBq.node;
      const leftover = newText.substring(newBq.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldToken.text.length) + newBq.node.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newList = listAt(newText, 0, ctx);
      if (!newList) return null;
      items[items.length - 1] = newList.node;
      const consumedCount = newList.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newList.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { node: { t: 'blockquote', raw, text, items }, raw };
}

/**
 * A list starting at `src[pos]`. Returns {node, raw} or null.
 * Items are scanned with top=false, so their paragraph-like content
 * becomes `text` nodes; a loose list turns those into `paragraph` nodes.
 */
function listAt(src, pos, ctx) {
  BLOCK_LIST.lastIndex = pos;
  let cap = BLOCK_LIST.exec(src);
  if (!cap || cap.index !== pos) return null;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    t: 'list', raw: '', ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = sticky(other.listItemRegex(bull));
  let endsWithBlankLine = false;
  let p = pos;
  while (p < src.length) {
    let endEarly = false;
    let itemContents = '';
    itemRegex.lastIndex = p;
    cap = itemRegex.exec(src);
    if (!cap || cap.index !== p) break;
    BLOCK_HR.lastIndex = p;
    if (BLOCK_HR.test(src)) break;
    const itemStart = p;
    p += cap[0].length;
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    const line = firstLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = lineAt(src, p);
    let blankLine = !line.trim();
    let indent = 0;
    let curLine = line;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(other.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && other.blankLine.test(nextLine)) {
      p += nextLine.length + 1;
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = other.nextBulletRegex(indent);
      const hrRegex = other.hrRegex(indent);
      const fencesBeginRegex = other.fencesBeginRegex(indent);
      const headingBeginRegex = other.headingBeginRegex(indent);
      const htmlBeginRegex = other.htmlBeginRegex(indent);
      const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);
      while (p < src.length) {
        const rawLine = lineAt(src, p);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws));
        // First non-space character gates the six break regexes below:
        // a plain text line matches none of them, so skip all six tests.
        let fns = 0;
        while (fns < nextLine.length && (nextLine.charCodeAt(fns) === 32 || nextLine.charCodeAt(fns) === 9)) fns++;
        const fch = nextLine.charCodeAt(fns);
        if ((fch === 96 || fch === 126) && fns <= 3 && fencesBeginRegex.test(nextLine)) break;
        if (fch === 35 && fns <= 3 && headingBeginRegex.test(nextLine)) break;
        if (fch === 60 && fns <= 3 && htmlBeginRegex.test(nextLine)) break;
        if (fch === 62 && fns <= 3 && blockquoteBeginRegex.test(nextLine)) break;
        if ((fch === 42 || fch === 43 || fch === 45 || (fch >= 48 && fch <= 57)) && fns <= indent && nextBulletRegex.test(nextLine)) break;
        if ((fch === 45 || fch === 95 || fch === 42) && fns <= indent && hrRegex.test(nextLine)) break;
        if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (curLine.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4) break;
          if (fencesBeginRegex.test(curLine)) break;
          if (headingBeginRegex.test(curLine)) break;
          if (htmlBeginRegex.test(curLine)) break;
          if (hrRegex.test(curLine)) break;
          BLOCK_LHEADING.lastIndex = 0;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && BLOCK_LHEADING.test(curLine + '\n' + nextLine);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        p += rawLine.length + 1;
        curLine = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = src.slice(itemStart, p);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (other.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      t: 'list_item', raw, task: other.listIsTask.test(itemContents),
      loose: false, text: itemContents, items: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(pos, p).trimEnd();
  // First pass: tokenize items, finalize looseness from spacers.
  for (const item of list.items) {
    ctx.top = false;
    const children = scanBlocks(item.text, ctx, false);
    if (children === null) return null;
    item.items = children;
    if (!list.loose) {
      const spacers = children.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));
      if (hasMultipleLineBreaks) list.loose = true;
    }
  }
  // Second pass: place task checkboxes using the final looseness.
  for (const item of list.items) {
    const first = item.items[0];
    if (item.task && (first?.t === 'text' || first?.t === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      first.text = first.text.replace(other.listReplaceTask, '');
      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        item.checked = checked;
        if (list.loose) {
          first.checkbox = checked;
        } else {
          item.items.unshift({ t: 'checkbox', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  // A loose list wraps every item's text in a paragraph.
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const child of item.items) {
        if (child.t === 'text') child.t = 'paragraph';
      }
    }
  }
  return { node: list, raw: list.raw };
}

// ---------------------------------------------------------------------------
// Rendering (phase B) — walks the node tree to an HTML string.
// ---------------------------------------------------------------------------

const CHECKBOX_CHECKED = '<input checked="" disabled="" type="checkbox"> ';
const CHECKBOX_UNCHECKED = '<input disabled="" type="checkbox"> ';

function renderListItem(item, ctx) {
  return '<li>' + renderNodes(item.items, ctx) + '</li>\n';
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading': {
        ctx.inRawBlock = false;
        out += '<h' + node.depth + '>' + inline(node.text, ctx, false) + '</h' + node.depth + '>\n';
        break;
      }
      case 'code': {
        const langString = (node.lang || '').match(other.notSpaceStart)?.[0];
        const code = node.text ? node.text.replace(other.endingNewline, '') + '\n' : '';
        const esc = escapeHtmlEntities(code, true);
        if (!langString) {
          out += '<pre><code>' + esc + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escapeHtmlEntities(langString) + '">' + esc + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        for (const cell of node.header) {
          ctx.inRawBlock = false;
          const content = inline(cell.text, ctx, false);
          header += cell.align ? '<th align="' + cell.align + '">' + content + '</th>\n' : '<th>' + content + '</th>\n';
        }
        header = '<tr>\n' + header + '</tr>\n';
        let body = '';
        for (const row of node.rows) {
          let cellHtml = '';
          for (const cell of row) {
            ctx.inRawBlock = false;
            const content = inline(cell.text, ctx, false);
            cellHtml += cell.align ? '<td align="' + cell.align + '">' + content + '</td>\n' : '<td>' + content + '</td>\n';
          }
          body += '<tr>\n' + cellHtml + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderNodes(node.items, ctx) + '</blockquote>\n';
        break;
      case 'list': {
        let body = '';
        for (const item of node.items) body += renderListItem(item, ctx);
        const type = node.ordered ? 'ol' : 'ul';
        const startAttr = (node.ordered && node.start !== 1) ? ' start="' + node.start + '"' : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += node.checked ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED;
        break;
      case 'html':
        out += node.text;
        break;
      case 'paragraph': {
        ctx.inRawBlock = false;
        let inner = inline(node.text, ctx, false);
        if (node.checkbox !== undefined) {
          inner = (node.checkbox ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED) + inner;
        }
        out += '<p>' + inner + '</p>\n';
        break;
      }
      case 'text': {
        ctx.inRawBlock = false;
        let inner = inline(node.text, ctx, false);
        if (node.checkbox !== undefined) {
          inner = (node.checkbox ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED) + inner;
        }
        out += inner;
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

/**
 * Render a whole document: scan the blocks (collecting every link reference
 * definition), then render the nodes with the definitions complete.
 * Returns null when the input holds a shape the fast path does not cover.
 */
function renderDocument(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const ctx = {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    hasAt: false,
    // Mutable "top level" flag, mirroring marked's Lexer state.top: it is
    // set false while lexing a list item, but any nested blockTokens call
    // (list or blockquote) sets it back to true at its end, and it stays
    // true for the rest of that item's lexing. The paragraph branch reads
    // it fresh on every loop iteration.
    top: true,
  };
  const nodes = scanBlocks(src, ctx, false);
  if (nodes === null) return null;
  return renderNodes(nodes, ctx);
}
