// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as q from '../src/popup/query.js';

const form = (over = {}) => ({ any: '', all: '', ordered: false, regex: '', matchCase: false, wholeWords: false, ...over });
const off = { wholeWords: false, matchCase: false };

test('tokenize handles separators', () => {
  for (const input of ['apple,pear', 'apple pear', 'apple, pear', 'apple , pear', 'apple ,pear , ',
    'apple|pear', 'apple | pear', 'apple |pear |', '| apple ,| pear']) {
    assert.deepEqual(q.tokenize(input), ['apple', 'pear'], input);
  }
});

test('tokenize keeps quotes and numbers', () => {
  assert.deepEqual(q.tokenize('"New York, NY", boston'), ['New York, NY', 'boston']);
  assert.deepEqual(q.tokenize('"a|b" c'), ['a|b', 'c']);
  assert.deepEqual(q.tokenize('1,000 apple'), ['1,000', 'apple']);
  assert.deepEqual(q.tokenize('walk* *'), ['walk*']);
});

test('separator-only input compiles to no query', () => {
  for (const input of [',,', '""', '" "', '*', '|', '   ']) {
    for (const box of ['any', 'all']) {
      const c = q.compileQuery(form({ [box]: input }));
      assert.equal(c.query, null, `${box}: ${JSON.stringify(input)}`);
      assert.equal(c.error, null, `${box}: ${JSON.stringify(input)}`);
    }
  }
});

test('termSource escapes and wildcards', () => {
  assert.equal(q.termSource('C++', off), 'C\\+\\+');
  assert.equal(q.termSource('$10', off), '\\$10');
  assert.equal(q.termSource('walk*', { wholeWords: false, matchCase: true }), 'walk' + q.WORD + '*');
  assert.equal(q.termSource('ice cream', { wholeWords: false, matchCase: true }), 'ice\\s+cream');
  assert.equal(q.termSource('**', off), null);
});

test('whole words use Unicode guards', () => {
  // Assertions use non-global regexes: a 'g' regex keeps lastIndex between calls.
  const run = new RegExp(q.termSource('run', { wholeWords: true, matchCase: true }), 'u');
  assert.match('a run', run);
  assert.doesNotMatch('Rerun', run);
  assert.doesNotMatch('running', run);
  const flower = new RegExp(q.termSource('çiçek', { wholeWords: true, matchCase: true }), 'u');
  assert.match('çiçek (x)', flower);
  assert.doesNotMatch('çiçekçi', flower);
});

test('turkish i when match case is off', () => {
  const re = new RegExp(q.termSource('istanbul', { wholeWords: false, matchCase: false }), 'ui');
  for (const s of ['İSTANBUL', 'Istanbul', 'ıstanbul']) assert.match(s, re, s);
  assert.ok(!q.termSource('istanbul', { wholeWords: false, matchCase: true }).includes('[iIİı]'));
});

test('compileQuery kinds', () => {
  const flat = q.compileQuery(form({ any: 'cheap flight' })).query;
  assert.equal(flat.kind, 'flat');
  assert.equal(flat.flags, 'gui');
  const re = new RegExp(flat.source, flat.flags.replace('g', ''));
  assert.match('cheap', re);
  assert.match('flight', re);

  const ordered = q.compileQuery(form({ all: 'cheap, flight', ordered: true })).query;
  assert.equal(ordered.kind, 'all');
  assert.equal(ordered.ordered, true);
  assert.deepEqual(ordered.terms.map((t) => t.label), ['cheap', 'flight']);
  assert.equal(ordered.any, null);

  const both = q.compileQuery(form({ any: 'istanbul', all: 'cheap flight' })).query;
  assert.equal(both.kind, 'all');
  assert.deepEqual(both.any.labels, ['istanbul']);

  assert.equal(q.compileQuery(form({ any: 'cheap', matchCase: true })).query.flags, 'gu');
});

test('looks-like-regex box is reported', () => {
  assert.equal(q.compileQuery(form({ any: '\\d+' })).regexyBox, 'any');
  assert.equal(q.compileQuery(form({ all: 'a.*b' })).regexyBox, 'all');
  assert.equal(q.compileQuery(form({ any: 'C++ $10' })).regexyBox, null);
});

const v8Message = (pattern) => { try { new RegExp(pattern, 'u'); } catch (e) { return e.message; } throw new Error(`${pattern} is valid`); };
const joinParts = (parts) => parts.map((p) => (typeof p === 'string' ? p : '`' + p.code + '`')).join('');

test('compileRegex validates the raw pattern first', () => {
  assert.throws(() => q.compileRegex('a)(?:b', { matchCase: false, wholeWords: true }), SyntaxError);
  assert.ok(q.compileRegex('\\p{L}+', { matchCase: false, wholeWords: false }).flags.includes('u'));
  assert.equal(q.compileRegex('\\-', { matchCase: false, wholeWords: false }).flags, 'gi');
});

test('whole words wraps regex', () => {
  const { source, flags } = q.compileRegex('run\\w*', { wholeWords: true, matchCase: false });
  const re = new RegExp(source, flags.replace('g', ''));
  assert.match('run', re);
  assert.match('Running', re);
  assert.doesNotMatch('Rerun', re);
});

test('friendly errors', () => {
  const rows = [
    ['C++', '*, + or ? needs something before it to repeat. To find the symbol itself, put \\ in front, e.g. C\\+\\+'],
    ['(abc', 'A ( is missing its closing ). To find a ( itself, write \\('],
    ['a)', 'There is a ) without an opening (. To find a ) itself, write \\)'],
    ['[abc', 'A [ is missing its closing ]. To find a [ itself, write \\['],
    ['abc\\', 'The pattern ends with a lone \\. Add the character it should escape, or remove it.'],
    ['a{2', '{ } must hold numbers, like \\d{3}. To find a { itself, write \\{'],
    ['[z-a]', 'In a range like [a-z], the first character has to come first.'],
    ['(?abc)', '(? must be followed by :, =, ! or <'],
  ];
  for (const [pattern, friendly] of rows) assert.equal(q.friendlyError(v8Message(pattern)), friendly, pattern);
  assert.equal(q.friendlyError('weird'), null);
});

test('tips', () => {
  assert.equal(q.regexTip('st*n', { count: 0, longest: 0 }).fix, 'st\\w*n');
  assert.equal(q.regexTip('st.*n', { count: 3, longest: 52 }).fix, 'st\\w*n');
  assert.equal(q.regexTip('st.*n', { count: 3, longest: 10 }), null);
  assert.equal(q.regexTip('$10', { count: 0, longest: 0 }).fix, '\\$10');
  assert.equal(q.regexTip('notes.txt', { count: 2, longest: 9 }).fix, 'notes\\.txt');
  assert.equal(q.regexTip('colou?r', { count: 5, longest: 6 }), null);
  assert.equal(q.regexTip('\\d*', { count: 0, longest: 0 }), null);
  assert.equal(joinParts(q.regexTip('st*n', { count: 0, longest: 0 }).parts),
    'No matches. In regex, `*` repeats the character before it, so `st*n` means sn, stn, sttn… For "any letters" use `\\w*`.');
});

test('regex box overrides', () => {
  const c = q.compileQuery(form({ any: 'cheap', regex: 'fl.ght' }));
  assert.equal(c.regexInUse, true);
  assert.equal(c.query.kind, 'flat');
  assert.equal(c.query.source, 'fl.ght');
  const bad = q.compileQuery(form({ regex: '(abc' }));
  assert.equal(bad.query, null);
  assert.ok(bad.error.friendly.startsWith('A ( is missing'));
  assert.equal(q.compileQuery(form({ regex: '   ', any: 'cheap' })).regexInUse, false);
});
