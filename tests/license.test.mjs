// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, relative } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'SPDX-License-Identifier: GPL-3.0-or-later';
const HOLDER = 'Copyright (C) 2026 The Text Find+ contributors';

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'out') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (['.js', '.mjs', '.css', '.html', '.py'].includes(extname(name))) out.push(path);
  }
  return out;
}

test('LICENSE is the GNU GPL version 3', () => {
  const text = readFileSync(join(repo, 'LICENSE'), 'utf8');
  assert.match(text, /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(text, /END OF TERMS AND CONDITIONS/);
});

test('every source file carries the license tag', () => {
  const files = ['src', 'chrome', 'tests', 'tools'].flatMap((d) => sourceFiles(join(repo, d)));
  assert.ok(files.length > 10);
  const missing = files.filter((f) => !readFileSync(f, 'utf8').slice(0, 400).includes(TAG)).map((f) => relative(repo, f));
  assert.deepEqual(missing, []);
});

test('every source file and the README name the copyright holder', () => {
  const files = ['src', 'chrome', 'tests', 'tools'].flatMap((d) => sourceFiles(join(repo, d)));
  const missing = files.filter((f) => !readFileSync(f, 'utf8').slice(0, 400).includes(HOLDER)).map((f) => relative(repo, f));
  assert.deepEqual(missing, []);
  assert.ok(readFileSync(join(repo, 'README.md'), 'utf8').includes(HOLDER));
});
