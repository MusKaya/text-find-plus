// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assembleTemporary } from '../tools/package.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'chrome');
const pkg = assembleTemporary('chrome'); // the files the manifest names come from src/, so look for them in the package
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const manifest = () => JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// Minimal PNG reader: returns { width, height, colours } for 8-bit RGBA, non-interlaced images.
function readPng(file) {
  const buf = readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} is not a PNG`);
  let pos = 8, width = 0, height = 0, colourType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colourType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  assert.equal(colourType, 6, 'expected RGBA');
  const raw = inflateSync(Buffer.concat(idat)), bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  const colours = new Set();
  for (let i = 0; i < out.length; i += 4) colours.add(out.readUInt32BE(i));
  return { width, height, colours: colours.size };
}

test('manifest is MV3 with exactly activeTab and scripting', () => {
  const m = manifest();
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.permissions, ['activeTab', 'scripting']);
  for (const key of ['host_permissions', 'optional_host_permissions', 'optional_permissions', 'content_scripts']) {
    assert.ok(!(key in m), `manifest must not have ${key}`);
  }
});

test('manifest name, minimum version, CSP, popup and shortcut', () => {
  const m = manifest();
  assert.equal(m.name, 'Text Find+');
  assert.equal(m.version, '1.0.0');
  assert.equal(m.minimum_chrome_version, '123');
  assert.equal(m.content_security_policy.extension_pages, CSP);
  assert.equal(m.action.default_popup, 'popup/popup.html');
  assert.ok(existsSync(join(pkg, m.action.default_popup)), `${m.action.default_popup} missing from the package`);
  assert.deepEqual(m.commands._execute_action.suggested_key, { default: 'Ctrl+Shift+F', mac: 'MacCtrl+Shift+F' });
});

test('icons exist, have the right sizes and are not blank', () => {
  const m = manifest();
  for (const [size, path] of Object.entries(m.icons)) {
    const file = join(pkg, path);
    assert.ok(existsSync(file), `${path} missing from the package`);
    const png = readPng(file);
    assert.equal(png.width, Number(size));
    assert.equal(png.height, Number(size));
    assert.ok(png.colours > 1, `${path} is a single colour`);
  }
});
