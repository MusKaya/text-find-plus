// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'popup', 'popup.html'), 'utf8');

test('status and error messages are announced to screen readers', () => {
  assert.match(html, /<div id="messages"[^>]*aria-live="polite"/);
});

test('theme.js is a classic, render-blocking script in <head>, and #theme sits between #next and #clear', () => {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
  const tags = head.match(/<script\b[^>]*\bsrc="theme\.js"[^>]*>/g) ?? [];
  assert.equal(tags.length, 1, 'theme.js is loaded once, in <head>');
  assert.doesNotMatch(tags[0], /\b(type|defer|async)\b/, 'it must block rendering so the saved theme is applied before the first paint');
  const at = (id) => html.indexOf(`<button id="${id}"`);
  assert.ok(at('next') > -1 && at('next') < at('theme') && at('theme') < at('clear'), '#theme is between #next and #clear');
  assert.match(html, /<button id="theme" type="button" class="icon"/);
});
