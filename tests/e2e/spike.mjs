// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Feasibility spike: checks the four platform assumptions in spec §11 with a throwaway extension
// built in a temp dir from the real manifest and icons (nothing is added to src/ or chrome/).
// Run: node tests/e2e/spike.mjs   → prints a JSON report and writes tests/e2e/out/spike.png
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/server.mjs';
import { launch, loadExtension, openPage, triggerPopup } from './lib/chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

function buildSpikeExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'tfplus-spike-'));
  cpSync(join(repo, 'chrome', 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(repo, 'src', 'icons'), join(dir, 'icons'), { recursive: true });
  mkdirSync(join(dir, 'popup'));
  writeFileSync(join(dir, 'popup', 'popup.html'), '<!doctype html><meta charset="utf-8"><title>spike</title><p>spike</p><script type="module" src="popup.js"></script>\n');
  writeFileSync(join(dir, 'popup', 'popup.js'), `
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
try {
  const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['spike-content.js'] });
  await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, css: '::highlight(spike) { background-color: #ff9632; }' });
  window.spikeResults = res.map((r) => ({ frameId: r.frameId, ...r.result }));
} catch (e) {
  window.spikeResults = { error: String(e) };
}
`);
  writeFileSync(join(dir, 'spike-content.js'), `(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const m = /colour|framed/.exec(n.data);
    if (!m) continue;
    const r = new Range();
    r.setStart(n, m.index);
    r.setEnd(n, m.index + m[0].length);
    CSS.highlights.set('spike', new Highlight(r));
    return { href: location.href, ok: true, word: m[0] };
  }
  return { href: location.href, ok: false };
})();
`);
  return dir;
}

async function attempt(headless, server, extDir) {
  const report = { headless, loaded: false, popupOpened: false };
  const browser = await launch({ headless });
  try {
    report.chrome = (await browser.send('Browser.getVersion')).product;
    let extId;
    try {
      extId = await loadExtension(browser, extDir);
      report.loaded = true;
    } catch (e) {
      report.loadError = e.message;
      return report;
    }
    const page = await openPage(browser, `${server.origin}/test.html?xorigin=http://localhost:${server.port}`);
    let popup;
    try {
      popup = await triggerPopup(browser, extId, page.tabTargetId);
      report.popupOpened = true;
    } catch (e) {
      report.popupError = e.message;
      return report;
    }
    let results;
    for (let i = 0; i < 100 && results === undefined; i++) {
      results = await popup.session.evaluate('window.spikeResults');
      if (results === undefined) await new Promise((r) => setTimeout(r, 50));
    }
    report.frames = results;
    const expr = "CSS.highlights.get('spike')?.size ?? 0";
    report.registryMain = await page.session.evaluate(expr);
    const isolated = page.session.contexts.find((c) => c.auxData?.type === 'isolated' && c.auxData?.frameId === page.targetId);
    report.isolatedContextName = isolated?.name ?? null;
    report.registryIsolated = isolated ? await page.session.evaluate(expr, { contextId: isolated.id }) : null;
    mkdirSync(join(here, 'out'), { recursive: true });
    const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(here, 'out', 'spike.png'), Buffer.from(shot.data, 'base64'));
    report.screenshot = 'tests/e2e/out/spike.png';
    return report;
  } finally {
    await browser.close();
  }
}

const server = await serve(join(repo, 'tests'));
const extDir = buildSpikeExtension();
try {
  const reports = [await attempt(true, server, extDir)];
  if (!reports[0].popupOpened && reports[0].loaded) reports.push(await attempt(false, server, extDir));
  console.log(JSON.stringify(reports, null, 2));
  const best = reports[reports.length - 1];
  const gate = best.loaded && best.popupOpened && (best.registryMain > 0 || best.registryIsolated > 0);
  console.log(gate ? 'GATE PASSED' : 'GATE FAILED: stop and report to the owner (spec §11)');
  if (!gate) process.exitCode = 1;
} finally {
  await server.close();
  rmSync(extDir, { recursive: true, force: true });
}
