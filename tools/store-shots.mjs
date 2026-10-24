// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Makes the Chrome Web Store images in store/chrome/: three 1280x800 screenshots of store/chrome/demo.html and the
// 440x280 small promo tile drawn from store/chrome/promo-tile.html. Chrome for Testing loads the Chrome package,
// assembled afresh from src/ and chrome/, unpacked through the test harness, the real popup is opened with the toolbar
// action and used as a person would, and the highlights on the page are the real engine's. The popup is drawn over the
// page at the top right, where Chrome shows it under its icon.
// Run: node tools/store-shots.mjs   (headless; leaves no browser, profile or temporary file behind)
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../tests/e2e/lib/server.mjs';
import { launch, loadExtension, openPage, navigate, triggerPopup, closeOpenedPopup } from '../tests/e2e/lib/chrome.mjs';
import { assembleTemporary } from './package.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = 'store/chrome'; // the Chrome Web Store listing, relative to the repo
const SHOT = { width: 1280, height: 800 }; // the store's screenshot size
const TILE = { width: 440, height: 280 }; // the store's small promo tile
// Headless Chrome reports an 800x600 screen and keeps popups inside it, which cuts the popup short (with a scrollbar)
// once it sits under the toolbar. A larger screen lets it take its real size, up to Chrome's 800x600 popup limit.
const SCREEN = '1600x1200';
const PRICES = { example: 'Prices like $4 or $2.50', regex: String.raw`\$\d+(\.\d\d)?` }; // a cheat-sheet example
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `get()` returns something `ok` accepts, and return it; fail naming what it last saw. */
async function until(get, ok, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await get();
    if (ok(last)) return last;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

/** Size and colour type of a PNG, from its IHDR chunk. */
function pngInfo(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bitDepth: png[24], colorType: png[25] };
}

/** Write a PNG the store accepts: exactly `size`, 8-bit RGB with no alpha channel. */
function writePng(name, base64, size) {
  const png = Buffer.from(base64, 'base64');
  const info = pngInfo(png);
  assert.deepEqual(info, { ...size, bitDepth: 8, colorType: 2 }, `${name}: not a ${size.width}x${size.height} RGB PNG`);
  writeFileSync(join(repo, STORE, name), png);
  console.log(`${STORE}/${name}  ${info.width}x${info.height}`);
}

/**
 * Open `url` in a new tab whose viewport is `size`, at 1x, with no page scrollbar drawn (macOS shows one only while
 * the page scrolls).
 */
async function openTab(browser, url, size) {
  const tab = await openPage(browser, url);
  await tab.session.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
  await tab.session.send('Emulation.setScrollbarsHidden', { hidden: true });
  await navigate(browser, tab.session, url); // a scrollbar the page already had stays drawn until it loads again
  await browser.send('Target.activateTarget', { targetId: tab.targetId });
  return tab;
}

/** Click the toolbar action on `tab` and return the popup, ready, with its colour theme set to `theme`. */
async function openPopup(browser, extId, tab, theme) {
  const popup = await triggerPopup(browser, extId, tab.tabTargetId);
  const P = (expr) => popup.session.evaluate(expr);
  await until(() => P(`document.body.dataset.state || ''`), (s) => s === 'ready', 'the popup to be ready');
  // The theme button cycles Automatic, Light, Dark; the choice is remembered, so set it the way a person would.
  for (let i = 0; i < 3 && (await P(`document.documentElement.dataset.theme || ''`)) !== theme; i++) await P(`document.getElementById('theme').click()`);
  assert.equal(await P(`document.documentElement.dataset.theme || ''`), theme, 'the popup theme');
  return {
    ...popup,
    P,
    count: () => P(`document.getElementById('count').textContent`),
    click: (selector) => P(`document.querySelector(${JSON.stringify(selector)}).click()`),
    /** Type into a box as a person would: focus it, select what is there, type. */
    async type(id, text) {
      await P(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.focus(); el.select(); })()`);
      await popup.session.send('Input.insertText', { text });
    },
  };
}

/**
 * Photograph the page and the popup, and fail if the popup is not exactly as big as its content: a popup cut short
 * (with a scrollbar) or wider than its content would not be the popup a person sees.
 */
async function capture(tab, popup) {
  // Headless Chrome draws a popup's new size ("463px × 39px") over it for a moment after it resizes, as it opens,
  // collapses or opens the cheat sheet. Wait until it has kept one size long enough for that label to go; by then the
  // search, any live refresh and the page's scrolling are long done.
  const popupSize = () => popup.P(`innerWidth + 'x' + innerHeight`);
  let was = await popupSize(), since = Date.now();
  while (Date.now() - since < 2000) {
    await sleep(100);
    const now = await popupSize();
    if (now !== was) [was, since] = [now, Date.now()];
  }
  const size = JSON.parse(await popup.P(`JSON.stringify((() => {
    const b = document.body.getBoundingClientRect(), d = document.documentElement;
    return { width: innerWidth, height: innerHeight, clientWidth: d.clientWidth, clientHeight: d.clientHeight, bodyWidth: b.width, bodyHeight: b.height };
  })())`));
  // Chrome sizes a popup to its content in whole pixels, dropping a fraction; a scrollbar would take client space.
  assert.ok(Math.abs(size.width - size.bodyWidth) < 1 && Math.abs(size.height - size.bodyHeight) < 1
    && size.clientWidth === size.width && size.clientHeight === size.height, `the popup is not its content's size: ${JSON.stringify(size)}`);
  const popupPng = (await popup.session.send('Page.captureScreenshot', { format: 'png' })).data;
  const pagePng = (await tab.session.send('Page.captureScreenshot', { format: 'png' })).data;
  return { pagePng, popupPng, popupSize: { width: size.width, height: size.height } };
}

/** Draw the popup over the page at the top right, as Chrome shows it, in a tab of its own, and photograph that. */
async function compose(browser, { pagePng, popupPng, popupSize }) {
  const tab = await openTab(browser, 'data:text/html,', SHOT);
  const html = `<style>
      html, body { margin: 0; width: ${SHOT.width}px; height: ${SHOT.height}px; overflow: hidden; background: #fff; }
      img { display: block; }
      .popup { position: absolute; top: 6px; right: 10px; overflow: hidden; border: 1px solid rgba(0, 0, 0, 0.22);
        border-radius: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2), 0 1px 4px rgba(0, 0, 0, 0.12); }
    </style>
    <img src="data:image/png;base64,${pagePng}" width="${SHOT.width}" height="${SHOT.height}" alt="">
    <div class="popup"><img src="data:image/png;base64,${popupPng}" width="${popupSize.width}" height="${popupSize.height}" alt=""></div>`;
  await tab.session.evaluate(`(async () => {
    document.documentElement.innerHTML = ${JSON.stringify(html)};
    await Promise.all([...document.images].map((img) => img.decode()));
  })()`);
  const shot = (await tab.session.send('Page.captureScreenshot', { format: 'png' })).data;
  await browser.send('Target.closeTarget', { targetId: tab.targetId });
  return shot;
}

const server = await serve(repo);
const browser = await launch({ screen: SCREEN });
try {
  const extId = await loadExtension(browser, assembleTemporary('chrome'));
  const demo = `/${STORE}/demo.html`;

  // 1. The Any box with two words: every match highlighted, the second one current.
  {
    const tab = await openTab(browser, server.origin + demo, SHOT);
    const popup = await openPopup(browser, extId, tab, 'light');
    await popup.type('any', 'coffee, ferry');
    const total = (await until(popup.count, (c) => /^1 of \d+$/.test(c), 'the first match')).split(' of ')[1];
    await popup.click('#next');
    await until(popup.count, (c) => c === `2 of ${total}`, 'the second match');
    const shots = await capture(tab, popup);
    await closeOpenedPopup(browser, popup); // another tab coming to the front would close it anyway
    writePng('screenshot-1-words.png', await compose(browser, shots), SHOT);
  }

  // 2. A regex for prices, from the cheat sheet's ready-made examples (scrolled to, then clicked), stepped on to a part
  //    of the page with several prices; the Any and All boxes are greyed out. In the dark theme.
  {
    const tab = await openTab(browser, server.origin + demo, SHOT);
    const popup = await openPopup(browser, extId, tab, 'dark');
    await popup.click('#cheatToggle');
    await popup.P(`(() => {
      const example = [...document.querySelectorAll('#cheatPanel .example')].find((b) => b.querySelector('.what').textContent === ${JSON.stringify(PRICES.example)});
      example.scrollIntoView({ block: 'center' });
      example.click();
    })()`);
    assert.equal(await popup.P(`document.getElementById('regex').value`), PRICES.regex);
    const total = (await until(popup.count, (c) => /^1 of \d+$/.test(c), 'the first price')).split(' of ')[1];
    for (let i = 0; i < 5; i++) await popup.click('#next'); // to the bus fare in the Sunday section
    await until(popup.count, (c) => c === `6 of ${total}`, 'the sixth price');
    assert.equal(await popup.P(`document.querySelectorAll('.card.ignored').length`), 2, 'the Any and All boxes are greyed out');
    const shots = await capture(tab, popup);
    await popup.P(`localStorage.removeItem('cheatOpen')`); // so the next popup opens without it
    await closeOpenedPopup(browser, popup);
    writePng('screenshot-2-regex.png', await compose(browser, shots), SHOT);
  }

  // 3. Collapsed to its bar after stepping on to a match further down: the page stays almost fully in view.
  {
    const tab = await openTab(browser, server.origin + demo, SHOT);
    const popup = await openPopup(browser, extId, tab, 'light');
    await popup.type('any', 'coffee, ferry');
    const total = (await until(popup.count, (c) => /^1 of \d+$/.test(c), 'the first match')).split(' of ')[1];
    for (let i = 0; i < 7; i++) await popup.click('#next'); // to the last ferry back from the island
    await until(popup.count, (c) => c === `8 of ${total}`, 'the eighth match');
    await popup.click('#collapse');
    await until(() => popup.P(`innerHeight < 100`), (small) => small, 'the popup to collapse');
    const shots = await capture(tab, popup);
    await closeOpenedPopup(browser, popup);
    writePng('screenshot-3-collapsed.png', await compose(browser, shots), SHOT);
  }

  // The small promo tile.
  {
    const tab = await openTab(browser, `${server.origin}/${STORE}/promo-tile.html`, TILE);
    await tab.session.evaluate(`Promise.all([...document.images].map((img) => img.decode()))`);
    writePng('promo-small-440x280.png', (await tab.session.send('Page.captureScreenshot', { format: 'png' })).data, TILE);
  }
} finally {
  await browser.close();
  await server.close();
}
