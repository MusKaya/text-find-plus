// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Build step 0 for live updates and web components (spec §7): checks, in the real extension, that
// highlights paint inside web components (a closed one included, which is why closed roots are not searched,
// spec §4.6), that a MutationObserver sees changes inside an open root, and what it costs to ask Chrome, for
// every element that could host one, whether it hosts a closed root (the engine's one question about them).
// It loads the Chrome package, assembled afresh from src/ and chrome/; nothing is added to either.
// Run: node tests/e2e/spike-components.mjs   → prints a JSON report and writes tests/e2e/out/spike-components.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/server.mjs';
import { launch, loadExtension, openPage, triggerPopup, isolatedContext } from './lib/chrome.mjs';
import { assembleTemporary } from '../../tools/package.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve(join(here, '..'));
const browser = await launch();
try {
  const extId = await loadExtension(browser, assembleTemporary('chrome'));
  const page = await openPage(browser, `${server.origin}/test.html`);
  const main = (expr) => page.session.evaluate(expr);
  const report = {};
  report.styleSheetsBefore = await main('[document.styleSheets.length, document.adoptedStyleSheets.length]');

  // Open the real popup: it injects the real engine and highlight.css.
  await browser.send('Target.activateTarget', { targetId: page.targetId });
  await triggerPopup(browser, extId, page.tabTargetId);
  for (let i = 0; i < 100 && !isolatedContext(page.session); i++) await sleep(20);
  const contextId = isolatedContext(page.session);
  const iso = (expr) => page.session.evaluate(expr, { contextId });
  report.isolatedWorld = contextId !== undefined;
  report.styleSheetsAfter = await main('[document.styleSheets.length, document.adoptedStyleSheets.length]');
  report.chromeDom = await iso('typeof chrome.dom?.openOrClosedShadowRoot');

  // 1. Painting: one range per "lantern", painted with the extension's own colours. The closed root's range is made
  // here by the probe, by reading the root through chrome.dom; the engine never does (spec §4.6), because a range
  // in the highlight registry hands the page the root it sits in.
  report.ranges = await iso(`(() => {
    const root = (id) => { const el = document.getElementById(id); return el.shadowRoot ?? chrome.dom.openOrClosedShadowRoot(el); };
    const word = (node) => { const r = document.createRange(); const at = node.data.indexOf('lantern'); r.setStart(node, at); r.setEnd(node, at + 7); return r; };
    const text = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode(); };
    const nested = root('wc-nested').querySelector('lantern-card').shadowRoot;
    globalThis.__spikeRanges = {
      open: word(text(root('wc-open'))),
      closed: word(text(root('wc-closed'))),
      nested: word(text(nested)),
      slotted: word(document.getElementById('wc-slotted').firstChild),
      fallback: word(root('wc-fallback').querySelector('slot').firstChild),
    };
    CSS.highlights.set('text-find-plus-match', new Highlight(...Object.values(__spikeRanges)));
    return Object.keys(__spikeRanges).length;
  })()`);
  await main(`document.getElementById('wc-open').scrollIntoView({ block: 'start' })`);
  const rects = await iso(`Object.fromEntries(Object.entries(__spikeRanges).map(([k, r]) => {
    const b = r.getBoundingClientRect(); return [k, { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }]; }))`);
  const shot = async (clip) => (await page.session.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })).data;
  const painted = {};
  for (const [k, clip] of Object.entries(rects)) painted[k] = await shot(clip);
  await iso(`CSS.highlights.delete('text-find-plus-match')`);
  for (const [k, clip] of Object.entries(rects)) painted[k] = painted[k] !== await shot(clip); // differs only if painted
  report.painted = painted;
  await iso(`CSS.highlights.set('text-find-plus-match', new Highlight(...Object.values(__spikeRanges)))`);
  const area = await main(`(() => { const a = document.getElementById('wc-open').getBoundingClientRect(), b = document.getElementById('p-hello').getBoundingClientRect();
    return { x: 0, y: a.top + scrollY - 8, width: innerWidth, height: b.bottom - a.top + 16 }; })()`);
  mkdirSync(join(here, 'out'), { recursive: true });
  writeFileSync(join(here, 'out', 'spike-components.png'), Buffer.from(await shot(area), 'base64'));
  await iso(`CSS.highlights.delete('text-find-plus-match')`);

  // 2. A MutationObserver created by the extension sees a change the page makes inside an open root (#wc-live).
  await iso(`(() => { globalThis.__spikeRecords = 0;
    new MutationObserver((records) => { __spikeRecords += records.length; })
      .observe(document.getElementById('wc-live').shadowRoot, { childList: true, subtree: true }); })()`);
  await main(`__live.add('spike', { inside: true })`);
  await sleep(50);
  report.openRootRecords = await iso('__spikeRecords');
  await main('__live.reset()');

  // 3. Cost of the engine's question about closed roots, on a ~1 MB page: chrome.dom.openOrClosedShadowRoot asked of
  // every element that could host a shadow root (lookupMs, for the calls alone), and a whole engine search, which
  // makes those calls itself (searchMs).
  await main(`(() => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt'.split(' ');
    const box = document.createElement('div'); box.id = 'perf'; let size = 0, i = 0;
    while (size < 1_000_000) { const p = document.createElement('p'); let t = '';
      for (let w = 0; w < 30; w++) t += words[(i * 7 + w) % words.length] + ' '; if (i % 50 === 0) t += 'flight ';
      p.textContent = t; box.append(p); size += t.length; i++; }
    document.body.append(box); })()`);
  report.cost = await iso(`(() => {
    const hosts = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);
    const els = [...document.body.querySelectorAll('*')].filter((el) => hosts.has(el.localName) || el.localName.includes('-'));
    let t = performance.now();
    for (const el of els) chrome.dom.openOrClosedShadowRoot(el);
    const lookupMs = performance.now() - t;
    t = performance.now();
    __textFindPlusEngine.search({ kind: 'flat', source: 'flight', flags: 'gui' });
    const searchMs = performance.now() - t;
    __textFindPlusEngine.clear(false);
    return { elementsAsked: els.length, lookupMs: Math.round(lookupMs * 10) / 10, searchMs: Math.round(searchMs * 10) / 10 };
  })()`);
  await main(`document.getElementById('perf').remove()`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await server.close();
}
