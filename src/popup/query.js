// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Turns what the user typed into regex patterns for the page engine.
// Pure functions: no DOM, no Chrome APIs (unit-tested directly with Node).

/** One "word character": a letter in any language, a combining mark, a digit or underscore. */
export const WORD = '[\\p{L}\\p{M}\\p{N}_]';

const TURKISH_I = 'iIİı';
const escapeChar = (c) => ('.*+?^${}()|[]\\'.includes(c) ? '\\' + c : c);

/**
 * Split a word box into terms: spaces, commas and | separate; "quoted text" is one term;
 * a comma between digits (1,000) stays; terms made only of * are dropped.
 */
export function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|((?:[^\s,|"]|(?<=\d),(?=\d))+)/g;
  let m;
  while ((m = re.exec(text))) {
    const term = (m[1] !== undefined ? m[1] : m[2]).trim();
    if (term.replace(/\*/g, '')) out.push(term);
  }
  return out;
}

/**
 * Regex source for one friendly term: special characters are literal, * means any letters in a
 * word, spaces inside a phrase match any whitespace. Returns null when there is nothing to find.
 */
export function termSource(term, { wholeWords, matchCase }) {
  const words = term.trim().split(/\s+/).filter((w) => w.replace(/\*/g, ''));
  if (!words.length) return null;
  const literal = (part) => [...part].map((c) => (!matchCase && TURKISH_I.includes(c) ? '[iIİı]' : escapeChar(c))).join('');
  const src = words.map((w) => w.split('*').map(literal).join(WORD + '*')).join('\\s+');
  return wholeWords ? `(?<!${WORD})(?:${src})(?!${WORD})` : src;
}

/**
 * Compile the Regex box. The user's pattern is validated on its own first (so wrapping can't turn
 * an invalid pattern into a valid one), with the u flag if possible. Throws the pattern's SyntaxError.
 */
export function compileRegex(src, { matchCase, wholeWords }) {
  const ci = matchCase ? '' : 'i';
  let unicode = true;
  try {
    new RegExp(src, 'gu' + ci);
  } catch {
    unicode = false;
    new RegExp(src, 'g' + ci);
  }
  const word = unicode ? WORD : '\\w';
  return {
    source: wholeWords ? `(?<!${word})(?:${src})(?!${word})` : src,
    flags: (unicode ? 'gu' : 'g') + ci,
  };
}

const FRIENDLY_ERRORS = [
  [/Nothing to repeat/, '*, + or ? needs something before it to repeat. To find the symbol itself, put \\ in front, e.g. C\\+\\+'],
  [/Unterminated group/, 'A ( is missing its closing ). To find a ( itself, write \\('],
  [/Unmatched '\)'/, 'There is a ) without an opening (. To find a ) itself, write \\)'],
  [/Unterminated character class/, 'A [ is missing its closing ]. To find a [ itself, write \\['],
  [/\\ at end of pattern/, 'The pattern ends with a lone \\. Add the character it should escape, or remove it.'],
  [/Incomplete quantifier|Lone quantifier brackets/, '{ } must hold numbers, like \\d{3}. To find a { itself, write \\{'],
  [/Range out of order/, 'In a range like [a-z], the first character has to come first.'],
  [/Invalid group/, '(? must be followed by :, =, ! or <'],
];

/** Plain-language version of a regex error message, or null when there is none. */
export function friendlyError(message) {
  const hit = FRIENDLY_ERRORS.find(([re]) => re.test(message));
  return hit ? hit[1] : null;
}

const UNESCAPED = '(^|[^\\\\])'; // start of pattern, or any character except a backslash
const DOLLAR = '\x24';
const code = (c) => ({ code: c });

/**
 * The first regex tip that applies (spec §4.4), with a one-click fix, or null.
 * @param {{count: number, longest: number}} stats  matches found and the longest match length
 */
export function regexTip(src, { count, longest }) {
  const star = new RegExp(UNESCAPED + '([\\p{L}\\p{N}])\\*', 'gu');
  if (count === 0 && new RegExp(star.source, 'u').test(src)) {
    return {
      parts: ['No matches. In regex, ', code('*'), ' repeats the character before it, so ', code('st*n'),
        ' means sn, stn, sttn… For "any letters" use ', code('\\w*'), '.'],
      fix: src.replace(star, (m, before, ch) => before + ch + '\\w*'),
    };
  }
  const dotStar = new RegExp(UNESCAPED + '\\.([*+])(?!\\?)', 'g');
  if (longest > 30 && new RegExp(dotStar.source).test(src)) {
    return {
      parts: [code('.*'), ' matches anything, even across many words. For letters inside one word use ', code('\\w*'),
        '; to stop at the first possible end use ', code('.*?')],
      fix: src.replace(dotStar, (m, before, q) => before + '\\w' + q),
    };
  }
  const dollar = new RegExp(UNESCAPED + '\\' + DOLLAR + '(?!' + DOLLAR + ')', 'g');
  if (new RegExp(dollar.source).test(src)) {
    return {
      parts: [code(DOLLAR), ' means "end of the text", so it never matches in the middle. To find a real ' + DOLLAR + ' sign, write ',
        code('\\' + DOLLAR), '.'],
      fix: src.replace(dollar, (m, before) => before + '\\' + DOLLAR),
    };
  }
  const dot = /([\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu;
  if (new RegExp(dot.source, 'u').test(src)) {
    return {
      parts: [code('.'), ' means any character, so ', code('notes.txt'), ' also finds notesXtxt. For a real dot, write ', code('\\.')],
      fix: src.replace(dot, (m, ch) => ch + '\\.'),
    };
  }
  return null;
}

function looksLikeRegex(text) {
  return /\\[dwsbpDWSBP]|\.\*|\.\+|\[[^\]]+\]|\(\?|\{\d+(,\d*)?\}/.test(text);
}

function termsOf(text, opts) {
  return tokenize(text)
    .map((label) => ({ label, source: termSource(label, opts) }))
    .filter((t) => t.source);
}

/**
 * Compile the popup form into a query for the page (spec §5.4).
 * @returns {{ query: object|null, error: {message: string, friendly: string|null}|null, regexInUse: boolean, regexyBox: 'any'|'all'|null }}
 */
export function compileQuery(form) {
  const opts = { wholeWords: !!form.wholeWords, matchCase: !!form.matchCase };
  const flags = 'gu' + (opts.matchCase ? '' : 'i');
  const result = { query: null, error: null, regexInUse: false, regexyBox: null };

  if (form.regex.trim()) {
    result.regexInUse = !!(form.any.trim() || form.all.trim());
    try {
      result.query = { kind: 'flat', ...compileRegex(form.regex, opts) };
    } catch (e) {
      result.error = { message: e.message, friendly: friendlyError(e.message) };
    }
    return result;
  }

  result.regexyBox = looksLikeRegex(form.any) ? 'any' : looksLikeRegex(form.all) ? 'all' : null;
  const any = termsOf(form.any, opts);
  const all = termsOf(form.all, opts);
  if (!any.length && !all.length) return result;
  const anyPart = any.length ? { source: any.map((t) => t.source).join('|'), labels: any.map((t) => t.label) } : null;
  result.query = all.length
    ? { kind: 'all', flags, ordered: !!form.ordered, terms: all, any: anyPart }
    : { kind: 'flat', source: anyPart.source, flags };
  return result;
}
