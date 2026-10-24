// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// The extension may ask Chrome whether a closed shadow root exists, and nothing more (spec §4.6). The browser test wraps the
// call at run time; this pins that there is exactly one call, written so the wrapper sees it: a reference bound when the
// engine loads would escape the wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));
const BINARY = /\.png$/; // every other file is read as text, so a kind of file added later is checked, not skipped
const sources = filesIn(root).filter((path) => !BINARY.test(path)).map((path) => [relative(root, path), readFileSync(path, 'utf8')]);
const occurrences = (pattern) => sources.flatMap(([name, source]) => [...source.matchAll(pattern)].map(() => name));

test('src/ has the call that asks about closed roots once, in the engine, written out in full', () => {
  assert.ok(sources.some(([name]) => name === 'content/highlighter.js'), 'the engine was found under src/');
  assert.deepEqual(occurrences(/openOrClosedShadowRoot/g), ['content/highlighter.js']); // an alias or a second call site is a second one
  assert.deepEqual(occurrences(/chrome\.dom\.openOrClosedShadowRoot\(/g), ['content/highlighter.js']); // not chrome.dom?.… or …Root?.(
});

test('src/ names the API object nowhere else', () => {
  // Any way to name it: chrome.dom, chrome?.dom, chrome["dom"]. The word dom in a comment or in text is no matter.
  assert.deepEqual(occurrences(/chrome\s*\??\.\s*dom\b|chrome\s*\??\.?\s*\[\s*['"`]dom/g), ['content/highlighter.js']);
});
