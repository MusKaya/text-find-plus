// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Assembles a browser's package: the shared extension code in src/, then that browser's own folder (chrome/, ...) on
// top, into build/<browser>/, and zips that folder's contents for the browser's store as
// build/text-find-plus-<browser>-<version>.zip, the version taken from <browser>/manifest.json. A browser's folder
// may only add files: one at the same path as a file in src/ stops the packager, naming it, rather than replacing it.
// Dotfiles are left out. Node built-ins and the system zip command only.
// Run: node tools/package.mjs [browser...]   (no browser: every top-level folder with a manifest.json)
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(repo, 'src');
const BUILD = join(repo, 'build');

/** The browsers there is a package for: every top-level folder with a manifest.json. */
function browsers() {
  return readdirSync(repo, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(repo, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort();
}

/** Every file under `dir`, as a '/'-separated path relative to it, leaving out dotfiles and dot-folders. */
function filesIn(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return filesIn(dir, path);
    if (e.isFile()) return [path];
    throw new Error(`${relative(repo, join(dir, path))} is neither a file nor a folder, and only those are packaged`);
  });
}

/**
 * Put src/ and then `browser`'s own folder into `outDir` (build/<browser>/ unless given), emptied first, and return
 * `outDir`. Stops, naming them, if the browser's folder has files at the same paths as files in src/ (compared
 * ignoring case, since macOS and Windows file systems do). A folder outside build/ is emptied only if it already is.
 */
export function assemble(browser, outDir = join(BUILD, browser)) {
  const known = browsers();
  if (!known.includes(browser)) throw new Error(`No browser folder named "${browser}" with a manifest.json (there is: ${known.join(', ') || 'none'})`);
  const own = join(repo, browser);
  const shared = filesIn(SRC), added = filesIn(own);
  const inSrc = new Set(shared.map((f) => f.toLowerCase()));
  const clashes = added.filter((f) => inSrc.has(f.toLowerCase())).map((f) => `${browser}/${f}`);
  if (clashes.length) throw new Error(`Not packaging ${browser}: ${clashes.join(', ')} would replace a file in src/. A browser's folder may only add files to src/.`);
  if (existsSync(outDir) && readdirSync(outDir).length) {
    if (!resolve(outDir).startsWith(BUILD + sep)) throw new Error(`Not emptying ${outDir}: it is not under build/`);
    rmSync(outDir, { recursive: true });
  }
  for (const [from, files] of [[SRC, shared], [own, added]]) {
    for (const file of files) {
      mkdirSync(dirname(join(outDir, file)), { recursive: true });
      copyFileSync(join(from, file), join(outDir, file), constants.COPYFILE_EXCL); // never replace a file already there
    }
  }
  return outDir;
}

/**
 * Assemble `browser`'s package into a new temporary folder and return its path, so the tests and the store images use
 * the current src/ and browser folder, never an old build/. The folder is removed when this process exits (the browser
 * tests' harness turns SIGINT and SIGTERM into an exit).
 */
export function assembleTemporary(browser) {
  const dir = mkdtempSync(join(tmpdir(), 'tfplus-package-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return assemble(browser, dir);
}

/** Assemble build/<browser>/ and zip its contents, with manifest.json at the zip's root; return the zip's path. */
function pack(browser) {
  const dir = assemble(browser);
  const { version } = JSON.parse(readFileSync(join(repo, browser, 'manifest.json'), 'utf8'));
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`${browser}/manifest.json: "${version}" is not a version like 1.0.0`);
  const zip = join(BUILD, `text-find-plus-${browser}-${version}.zip`);
  rmSync(zip, { force: true }); // zip adds to an archive that exists, which would keep files that are gone
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: dir, stdio: 'inherit' });
  return zip;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const asked = process.argv.slice(2);
    const all = asked.length ? asked : browsers();
    if (!all.length) throw new Error('No top-level folder has a manifest.json, so there is nothing to package');
    for (const browser of all) {
      const zip = pack(browser);
      console.log(`${relative(repo, join(BUILD, browser))}/  ${relative(repo, zip)}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
