// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Full-extension tests: loads the Chrome package, assembled afresh from src/ and chrome/, unpacked, clicks the toolbar
// action (grants activeTab like a real click) and drives the real popup against tests/test.html.
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/server.mjs';
import { test, before, after, afterEach } from './lib/test.mjs';
import { launch, loadExtension, openPage, navigate, triggerPopup, pageHighlightSize, isolatedContext, assertPopupAlive, closeOpenedPopup } from './lib/chrome.mjs';
import { PINNED, drawn } from './lib/drawn.mjs';
import { assembleTemporary } from '../../tools/package.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ORDERED_DESC = 'Only highlights them in this order, with any text in between.';
const CANT_SEARCH = 'Text Find+ can\'t search this page. Chrome doesn\'t allow extensions on chrome:// pages, the Chrome Web Store or other extensions\' pages. For files on your computer, turn on "Allow access to file URLs" for Text Find+ in chrome://extensions.';

let server, browser, extId, page, pageUrl, popup = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (expr) => popup.session.evaluate(expr);
const text = (id) => P(`document.getElementById(${JSON.stringify(id)}).textContent`);
const value = (id) => P(`document.getElementById(${JSON.stringify(id)}).value`);
const count = () => text('count');
const hl = () => pageHighlightSize(page.session, 'text-find-plus-match');
const run = (expr) => page.session.evaluate(expr); // in the page's main world
const LIVE_PAUSED = 'Live updates are paused because this page is very large.';

/** Poll until `get()` returns `expected` (or time out with a useful assertion). */
async function eventually(get, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await get();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await sleep(25);
  }
  assert.deepEqual(last, expected);
}

async function closePopup() {
  if (!popup) return;
  const closing = popup;
  popup = null; // a popup that is gone is reported once, so the tests after it are not failed for it as well
  await closeOpenedPopup(browser, closing); // throws if the popup crashed, before anything opens another one
  await sleep(100);
}

// A popup that crashes after a test's last command fails no command, so it is reported against that test here.
afterEach(() => {
  const finished = popup;
  if (finished?.session.gone) popup = null; // reported here, by the test it went in, and not again by the next one
  assertPopupAlive(finished, 'The popup open at the end of this test');
});

async function open(target = page) {
  await closePopup();
  await browser.send('Target.activateTarget', { targetId: target.targetId });
  popup = await triggerPopup(browser, extId, target.tabTargetId);
  await eventually(() => P('document.body.dataset.state || ""').then((s) => s !== ''), true);
}

// popup-crash.fixture.mjs runs this file's hooks around tests that crash the popup, to check that the crash is reported.
export { browser, popup, open, closePopup };

/** Open the popup with nothing remembered and nothing highlighted. */
async function fresh() {
  await open();
  await P(`document.getElementById('clear').click()`);
  await eventually(count, '');
}

/** Replace the text in an input the way a user would (select all, then type). */
async function type(id, str) {
  await P(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.focus(); el.select(); })()`);
  if (str) await popup.session.send('Input.insertText', { text: str });
  else await P(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

async function key(name, { shift = false } = {}) {
  const base = { key: name, code: name, windowsVirtualKeyCode: name === 'Enter' ? 13 : 0, modifiers: shift ? 8 : 0 };
  await popup.session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await popup.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const click = (selector) => P(`document.querySelector(${JSON.stringify(selector)}).click()`);
const tick = (id) => click(`#${id}`);
const clickButtonWithText = (label) => P(`(() => {
  const b = [...document.querySelectorAll('#messages button')].find((x) => x.textContent === ${JSON.stringify(label)});
  if (!b) return false; b.click(); return true; })()`);

before(async () => {
  server = await serve(join(here, '..'));
  browser = await launch();
  extId = await loadExtension(browser, assembleTemporary('chrome'));
  pageUrl = `${server.origin}/test.html?xorigin=http://localhost:${server.port}`;
  page = await openPage(browser, pageUrl);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('plain match', async () => {
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
  assert.equal(await hl(), 3);
});

test('regex with groups', async () => {
  await fresh();
  await type('regex', '(cheap|deals) (flight|page)');
  await eventually(count, '1 of 3');
});

test('case toggle', async () => {
  await fresh();
  await type('any', 'Cheap');
  await eventually(count, '1 of 3');
  await tick('matchCase');
  await eventually(count, '1 of 1');
  await tick('matchCase');
  await eventually(count, '1 of 3');
});

test('invalid regex', async () => {
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
  await type('any', '');
  await type('regex', '(abc');
  await eventually(async () => (await text('messages')).includes('A ( is missing its closing )'), true);
  await eventually(hl, 0);
});

test('no matches', async () => {
  await fresh();
  await type('any', 'zebra');
  await eventually(count, 'No matches');
  assert.equal(await hl(), 0);
});

test('next/prev wraparound', async () => {
  await fresh();
  await type('any', 'colo*r');
  await eventually(count, '1 of 5');
  await key('Enter', { shift: true });
  await eventually(count, '5 of 5');
  await key('Enter');
  await eventually(count, '1 of 5');
  await click('#next');
  await eventually(count, '2 of 5');
  await click('#prev');
  await eventually(count, '1 of 5');
});

test('all words status', async () => {
  await fresh();
  await type('all', 'cheap zebra');
  await eventually(async () => (await text('messages')).includes('Not on this page: zebra'), true);
  assert.equal(await hl(), 0);
});

test('in-order description', async () => {
  await fresh();
  await tick('ordered');
  assert.equal(await text('allDesc'), ORDERED_DESC);
  await tick('ordered');
  assert.equal(await text('allDesc'), 'Only highlights if the page has every one of these words.');
});

test('looks like regex', async () => {
  await fresh();
  await type('any', '\\d+');
  await eventually(() => clickButtonWithText('Move it to the Regex box'), true);
  assert.equal(await value('regex'), '\\d+');
  assert.equal(await value('any'), '');
  await eventually(count, '1 of 13');
});

test('regex tip fix', async () => {
  await fresh();
  await type('regex', 'st*n');
  await eventually(() => clickButtonWithText('Try st\\w*n'), true);
  await eventually(count, '1 of 2');
});

test('regex overrides boxes', async () => {
  await fresh();
  await type('any', 'cheap');
  await type('regex', 'fl.ght');
  await eventually(async () => (await text('messages')).includes('The Regex box is in use, so the Any and All boxes are ignored. Empty the Regex box to use them again.'), true);
  await eventually(count, '1 of 5');
});

/** Forget that the cheat sheet was open (the popup remembers it), so the next popup opens without it. */
const forgetCheat = () => P(`localStorage.removeItem('cheatOpen')`);

test('cheat sheet opens as a panel on the left and inserts examples', async () => {
  await fresh();
  try {
    const layout = () => P(`(() => {
      const panel = document.getElementById('cheatPanel'), app = document.querySelector('.app');
      const p = panel.getBoundingClientRect(), a = app.getBoundingClientRect(), b = document.body.getBoundingClientRect();
      return { open: !panel.hidden, expanded: document.getElementById('cheatToggle').getAttribute('aria-expanded'),
        leftOfMain: p.right <= a.left + 1, width: Math.round(b.width), height: Math.ceil(b.height), appWidth: Math.round(a.width) };
    })()`);
    const closed = await layout();
    assert.deepEqual([closed.open, closed.expanded, closed.width], [false, 'false', closed.appWidth]);

    await click('#cheatToggle');
    const opened = await layout();
    assert.equal(opened.open, true);
    assert.equal(opened.expanded, 'true');
    assert.equal(opened.leftOfMain, true);
    assert.equal(opened.appWidth, closed.appWidth, 'the main window keeps its width');
    assert.ok(opened.width <= 800, `popup is ${opened.width}px wide`);
    assert.ok(opened.height <= 600, `popup is ${opened.height}px tall`);

    await P(`[...document.querySelectorAll('#cheatPanel button')].find((b) => b.textContent.includes('Phone numbers like 555-1234')).click()`);
    assert.equal(await value('regex'), '\\d{3}-\\d{4}');
    await eventually(count, '1 of 2');

    assert.match(await text('cheatClose'), /Close/);
    await click('#cheatClose');
    assert.deepEqual(await layout().then((l) => [l.open, l.expanded, l.width]), [false, 'false', closed.appWidth]);
    await click('#cheatToggle');
    await click('#cheatToggle');
    assert.deepEqual(await layout().then((l) => [l.open, l.expanded]), [false, 'false']);
  } finally {
    await forgetCheat();
  }
});

test('cheat sheet panel is exactly as wide as its longest symbol row', async () => {
  await fresh();
  try {
    await click('#cheatToggle');
    const m = await P(`(() => {
      const cs = document.querySelector('#cheatPanel .cs');
      const inner = cs.getBoundingClientRect().width - parseFloat(getComputedStyle(cs).paddingLeft) - parseFloat(getComputedStyle(cs).paddingRight);
      const rowWidth = (span) => { const r = document.createRange(); r.selectNodeContents(span); return span.previousElementSibling.getBoundingClientRect().width + parseFloat(getComputedStyle(span.parentElement).columnGap) + r.getBoundingClientRect().width; };
      const rows = [...document.querySelectorAll('#cheatPanel .grp > span')].map((s) => [Math.round(rowWidth(s)), s.textContent]).sort((a, b) => b[0] - a[0]);
      const heading = [...document.querySelectorAll('#cheatPanel .head')].find((h) => h.textContent.startsWith('Ready-made'));
      const lit = document.querySelector('#cheatPanel .lit');
      const oneLine = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) === 1;
      return { inner: Math.round(inner), widestRow: rows[0], heading: Math.round(heading.getBoundingClientRect().width),
        lit: Math.round(lit.getBoundingClientRect().width), litFits: lit.scrollWidth <= lit.clientWidth + 1, litOneLine: lit.getBoundingClientRect().height < 24,
        rowsOneLine: [...document.querySelectorAll('#cheatPanel .grp > span, #cheatPanel .cheat-hint')].every(oneLine) };
    })()`);
    assert.equal(m.widestRow[1], 'a letter, digit or _ (English letters)');
    assert.ok(Math.abs(m.inner - m.widestRow[0]) <= 2, `panel content ${m.inner}px vs widest row ${m.widestRow[0]}px`);
    assert.equal(m.heading, m.inner);
    assert.equal(m.lit, m.inner);
    assert.equal(m.litFits, true);
    assert.equal(m.litOneLine, true);
    assert.equal(m.rowsOneLine, true);
  } finally {
    await forgetCheat();
  }
});

test('cheat sheet header matches the main header', async () => {
  await fresh();
  try {
    await click('#cheatToggle');
    const m = await P(`(() => {
      const cs = (el) => getComputedStyle(el);
      const top = document.querySelector('.top'), head = document.querySelector('.cheat-head');
      const close = document.getElementById('close'), cheatClose = document.getElementById('cheatClose');
      const h1 = document.querySelector('.bar h1'), h2 = head.querySelector('h2');
      const box = (b) => ({ height: Math.round(b.getBoundingClientRect().height * 10) / 10, padding: cs(b).padding, font: cs(b).fontSize + ' ' + cs(b).fontWeight, radius: cs(b).borderRadius });
      return {
        heights: [Math.round(top.getBoundingClientRect().height * 10) / 10, Math.round(head.getBoundingClientRect().height * 10) / 10],
        bottoms: [Math.round(top.getBoundingClientRect().bottom), Math.round(head.getBoundingClientRect().bottom)],
        colours: [[cs(top).backgroundColor, cs(top).borderBottomColor], [cs(head).backgroundColor, cs(head).borderBottomColor]],
        titles: [cs(h1).fontSize + ' ' + cs(h1).fontWeight, cs(h2).fontSize + ' ' + cs(h2).fontWeight],
        buttons: [box(close), box(cheatClose)],
      };
    })()`);
    assert.equal(m.heights[1], m.heights[0], `header heights ${m.heights}`);
    assert.equal(m.bottoms[1], m.bottoms[0], 'the two header dividers line up');
    assert.deepEqual(m.colours[1], m.colours[0]);
    assert.equal(m.titles[1], m.titles[0]);
    assert.deepEqual(m.buttons[1], m.buttons[0]);
  } finally {
    await forgetCheat();
  }
});

test('main window is just wide enough: nothing wraps, no spare space', async () => {
  await fresh();
  const check = () => P(`(() => {
    const lines = [...document.querySelectorAll('.desc, .howto-row .rule, .howto-row .finds, .opt .check, .head, .bar h1')];
    const wrapped = lines.filter((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) > 1)
      .map((el) => el.textContent.trim().slice(0, 40));
    const natural = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
    const widest = Math.max(...[...document.querySelectorAll('.howto-row, .opt, .desc')].map((el) => natural(el) + (el.closest('.howto, .opts, .card').getBoundingClientRect().width - el.getBoundingClientRect().width)));
    const main = document.querySelector('main'), mcs = getComputedStyle(main);
    const room = main.getBoundingClientRect().width - parseFloat(mcs.paddingLeft) - parseFloat(mcs.paddingRight);
    return { wrapped, spare: Math.round(room - widest) };
  })()`);
  const plain = await check();
  assert.deepEqual(plain.wrapped, []);
  assert.ok(plain.spare <= 4, `${plain.spare}px of unused width`);
  await tick('ordered');
  assert.deepEqual((await check()).wrapped, [], 'the in-order description fits on one line');
});

test('accent colours: green arrows, yellow cheat sheet, pronounced toggle arrow', async () => {
  await fresh();
  const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
  const c = await P(`(() => { const s = (id, p) => getComputedStyle(document.getElementById(id))[p];
    return { prev: s('prev', 'borderTopColor'), next: s('next', 'borderTopColor'), toggle: s('cheatToggle', 'borderTopColor'),
      panel: getComputedStyle(document.getElementById('cheatPanel')).borderRightColor,
      arrowSize: parseFloat(getComputedStyle(document.querySelector('#cheatToggle .arrow')).fontSize),
      labelSize: parseFloat(getComputedStyle(document.getElementById('cheatToggle')).fontSize) }; })()`);
  for (const key of ['prev', 'next']) { const [r, g, b] = rgb(c[key]); assert.ok(g > r && g > b, `${key} border ${c[key]} is not green`); }
  for (const key of ['toggle', 'panel']) { const [r, g, b] = rgb(c[key]); assert.ok(r > b + 60 && g > b + 40, `${key} border ${c[key]} is not yellow`); }
  assert.ok(c.arrowSize > c.labelSize, `arrow ${c.arrowSize}px should be larger than label ${c.labelSize}px`);
});

test('clear', async () => {
  await fresh();
  await type('any', 'cheap');
  await type('all', 'flight');
  await eventually(async () => (await hl()) > 0, true);
  await click('#clear');
  for (const id of ['any', 'all', 'regex']) assert.equal(await value(id), '');
  await eventually(count, '');
  await eventually(hl, 0);
});

test('clear, then the same search shows its message again', async () => {
  await fresh();
  const tips = () => P(`document.querySelectorAll('#messages .tip button').length`);
  await type('regex', 'st*n'); // no matches, so a tip with a button
  await eventually(tips, 1);
  await click('#clear');
  await eventually(tips, 0);
  await type('regex', 'st*n');
  await eventually(tips, 1);
});

test('a tip button always acts on what is typed now, not on what was drawn first', async () => {
  await fresh();
  const label = () => P(`document.querySelector('#messages .tip button')?.textContent ?? ''`);
  await type('regex', 'st*n');
  await eventually(label, 'Try st\\w*n');
  await type('regex', 'zq*y'); // also finds nothing, and its fix is another text
  await eventually(label, 'Try zq\\w*y');
  await type('regex', '');
  await type('all', '\\d+');
  await type('any', '\\d+'); // both look like regex; the Any box is the one offered to move
  await eventually(() => text('messages').then((t) => t.includes('Not on this page: \\d+')), true);
  await sleep(300);
  await type('any', 'cheap'); // now the All box is the one, and the lines above the button are word for word the same
  await sleep(400);
  assert.equal(await label(), 'Move it to the Regex box');
  await click('#messages .tip button');
  assert.equal(await value('regex'), '\\d+');
  assert.equal(await value('all'), '');
  assert.equal(await value('any'), 'cheap');
});

test('fits without scrolling, even with a one-line message', async () => {
  await fresh();
  const contentHeight = () => P(`Math.ceil(document.querySelector('main').getBoundingClientRect().bottom)`);
  const opened = await contentHeight();
  assert.ok(opened <= 600, `popup content is ${opened}px tall when it opens`);
  await type('all', 'cheap zebra');
  await eventually(async () => (await text('messages')).includes('Not on this page: zebra'), true);
  const withMessage = await contentHeight();
  assert.ok(withMessage <= 600, `popup content is ${withMessage}px tall with a message`);
});

test('layout keeps related controls together', async () => {
  await fresh();
  assert.equal(await P(`document.getElementById('ordered').closest('.headrow')?.querySelector('label[for="all"]') !== null`), true);
  const sameLine = await P(`[...document.querySelectorAll('.opt')].every((opt) => {
    const a = opt.querySelector('label').getBoundingClientRect(), b = opt.querySelector('.desc').getBoundingClientRect();
    return Math.abs(a.top - b.top) < 8; })`);
  assert.equal(sameLine, true);
});

test('visual hierarchy: count stands out, tips stay quiet, options before regex', async () => {
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
  const look = await P(`(() => {
    const cs = (el) => getComputedStyle(el);
    const count = document.getElementById('count'), rule = document.querySelector('.howto-row .rule');
    const kids = [...document.querySelector('main').children];
    const regexCard = document.getElementById('regex').closest('.card');
    return {
      countIsTextColour: cs(count).color === cs(document.body).color,
      countWeight: Number(cs(count).fontWeight),
      ruleWeight: Number(cs(rule).fontWeight),
      ruleIsMuted: cs(rule).color !== cs(document.body).color,
      optionsBeforeRegex: kids.indexOf(document.querySelector('.opts')) < kids.indexOf(regexCard),
    };
  })()`);
  assert.deepEqual(look, { countIsTextColour: true, countWeight: look.countWeight, ruleWeight: look.ruleWeight, ruleIsMuted: true, optionsBeforeRegex: true });
  assert.ok(look.countWeight >= 600, `count weight ${look.countWeight}`);
  assert.ok(look.ruleWeight <= 400, `tips rule weight ${look.ruleWeight}`);
});

test('header buttons have their own colours', async () => {
  await fresh();
  assert.equal(await P(`document.getElementById('clear').nextElementSibling?.id`), 'close');
  const colours = await P(`['prev', 'clear', 'close', 'any'].map((id) => getComputedStyle(document.getElementById(id)).backgroundColor)`);
  const [nav, clear, close, plain] = colours;
  assert.equal(new Set([nav, clear, close, plain]).size, 4, colours.join(' | '));
  assert.equal(await P(`getComputedStyle(document.getElementById('next')).backgroundColor`), nav);
});

test('the Close button closes the popup and removes highlights', async () => {
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
  const popupTarget = popup.targetId;
  await click('#close');
  popup = null;
  await eventually(hl, 0, 1000);
  await eventually(async () => (await browser.send('Target.getTargets')).targetInfos.some((t) => t.targetId === popupTarget), false);
});

test('closing the popup removes highlights', async () => {
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
  assert.equal(await hl(), 3);
  await browser.send('Target.closeTarget', { targetId: popup.targetId });
  popup = null;
  await eventually(hl, 0, 1000);
});

test('reopen restores the search', async () => {
  await open();
  await eventually(() => value('any'), 'cheap');
  await eventually(count, '1 of 3');
  await eventually(hl, 3);
});

/**
 * Open the popup on a page that remembers "cheap", with the page holding that search back for 1.2 s after the popup
 * connects. The page sends it the moment the popup connects, so a busy loop there delays it while the popup, which
 * is another process, carries on. The page notes when it held the search and what it was, so a test can check that
 * it acted inside that time. Call `releaseHeldSearch()` when done.
 */
async function openWithRememberedSearchHeld() {
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3'); // the page remembers it
  await closePopup();
  await iso(`(() => { const engine = __textFindPlusEngine, remembered = engine.remembered;
    globalThis.__held = undefined;
    engine.remembered = () => {
      const memo = remembered();
      const from = Date.now();
      while (Date.now() < from + 1200);
      globalThis.__held = [from, Date.now(), memo?.form.any];
      return memo;
    };
    globalThis.__unwrap = () => { engine.remembered = remembered; }; })()`);
  await open();
}
const releaseHeldSearch = () => page.session.evaluate('globalThis.__unwrap?.()', { contextId: isolatedContext(page.session) });
/** [when the page began holding the search, when it sent it, what it held], once it has sent it. */
const heldSearch = () => page.session.evaluate(
  'new Promise((done) => { const wait = () => (globalThis.__held ? done(__held) : setTimeout(wait, 20)); wait(); })',
  { contextId: isolatedContext(page.session) },
);
const boxes = () => P(`['any', 'all', 'regex'].map((id) => document.getElementById(id).value)`);

test('a remembered search that arrives after Clear does not come back', async () => {
  try {
    await openWithRememberedSearchHeld();
    await click('#clear');
    const acted = Date.now();
    const [from, to, held] = await heldSearch(); // waits until the page has sent it
    assert.equal(held, 'cheap', 'the page held back the remembered search');
    assert.ok(acted < to, `Clear at ${acted} came after the page sent the remembered search (${from} to ${to})`);
    await sleep(500); // it reaches the popup
    assert.deepEqual(await boxes(), ['', '', '']);
    assert.equal(await count(), '');
    assert.equal(await hl(), 0);
  } finally {
    await releaseHeldSearch();
  }
});

test('a remembered search that arrives after the user typed does not replace it', async () => {
  try {
    await openWithRememberedSearchHeld();
    await type('any', 'zebra');
    const acted = Date.now();
    const [from, to, held] = await heldSearch();
    assert.equal(held, 'cheap', 'the page held back the remembered search');
    assert.ok(acted < to, `Typing at ${acted} came after the page sent the remembered search (${from} to ${to})`);
    await sleep(700); // it reaches the popup, and the search that was typed is answered
    assert.deepEqual(await boxes(), ['zebra', '', '']);
    assert.equal(await count(), 'No matches');
    assert.equal(await hl(), 0);
  } finally {
    await releaseHeldSearch();
  }
});

test('a remembered search that arrives after the user ticked a box does not replace it', async () => {
  try {
    await openWithRememberedSearchHeld();
    await tick('matchCase');
    const acted = Date.now();
    const [from, to, held] = await heldSearch();
    assert.equal(held, 'cheap', 'the page held back the remembered search');
    assert.ok(acted < to, `Ticking at ${acted} came after the page sent the remembered search (${from} to ${to})`);
    await sleep(700); // it reaches the popup
    assert.deepEqual(await boxes(), ['', '', '']);
    assert.equal(await P(`document.getElementById('matchCase').checked`), true, 'the box the user ticked is still ticked');
    assert.equal(await count(), '');
    assert.equal(await hl(), 0);
  } finally {
    await releaseHeldSearch();
  }
});

test('fast typing shows only the latest result', async () => {
  await fresh();
  await P(`document.getElementById('any').focus()`);
  for (const ch of 'cheap') {
    await popup.session.send('Input.insertText', { text: ch });
    await sleep(10);
  }
  await sleep(400);
  await eventually(count, '1 of 3');
});

test('frames: same-origin frame is searched, cross-origin is not', async () => {
  await fresh();
  await type('any', 'framed');
  await eventually(count, '1 of 1');
});

test('reload clears the remembered search', async () => {
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
  await closePopup();
  await navigate(browser, page.session, `${server.origin}/test.html?xorigin=http://localhost:${server.port}`);
  await open();
  await sleep(200);
  assert.equal(await value('any'), '');
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
});

test('restricted page', async () => {
  await closePopup();
  const restricted = await openPage(browser, 'chrome://version');
  await open(restricted);
  assert.equal(await P(`document.getElementById('cantSearch').hidden`), false);
  assert.equal((await text('cantSearch')).replace(/\s+/g, ' ').trim(), CANT_SEARCH);
  assert.equal(await P(`document.getElementById('any').disabled`), true);
  assert.equal(await P(`document.getElementById('close').disabled`), false);
  await closePopup();
  await browser.send('Target.closeTarget', { targetId: restricted.targetId });
});

test('restricted page: no checkbox label shows the hand cursor there, and all of them do on an ordinary page', async () => {
  await fresh();
  const cursors = () => P(`['matchCase', 'wholeWords', 'ordered'].map((id) => getComputedStyle(document.getElementById(id).closest('label')).cursor)`);
  assert.deepEqual(await cursors(), ['pointer', 'pointer', 'pointer']);
  await closePopup();
  const restricted = await openPage(browser, 'chrome://version');
  try {
    await open(restricted);
    assert.equal(await P('document.body.dataset.state'), 'cant-search');
    assert.deepEqual(await cursors(), ['default', 'default', 'default']);
  } finally {
    await closePopup();
    await browser.send('Target.closeTarget', { targetId: restricted.targetId });
  }
});

// ---------- web components (spec §4) ----------

test('web components: open, nested, slotted and fallback text is found and painted, closed components are skipped', async () => {
  await fresh();
  // The page really holds a closed component with the words in it, and its host gives the page no way in.
  assert.deepEqual(await run(`[document.getElementById('wc-closed').shadowRoot, __closedRoots[0].textContent]`), [null, 'A closed lantern.']);
  await type('regex', '\\w+ lantern');
  await eventually(count, '1 of 4');
  // Each painted range, as the page sees it: its text and whether it sits inside a shadow root.
  const painted = await run(`[...CSS.highlights.get('text-find-plus-match')].map((r) => [r.toString(), r.startContainer.getRootNode() instanceof ShadowRoot])
    .sort((a, b) => a[0].localeCompare(b[0]))`);
  assert.deepEqual(painted, [['fallback lantern', true], ['nested lantern', true], ['open lantern', true], ['slotted lantern', false]]);
  // Nothing the page can read from the highlight registry (every highlight, both ends of every range) is in a closed root.
  const reachable = await run(`[...CSS.highlights.values()].flatMap((h) => [...h]).flatMap((r) => [r.startContainer, r.endContainer, r.commonAncestorContainer])
    .filter((node) => __closedRoots.includes(node.getRootNode())).length`);
  assert.equal(reachable, 0, 'a range in the registry has a closed root as its root node');
});

test('web components: a closed component and the page text inside it are skipped, the control beside them is found', async () => {
  await fresh();
  // The fixture: closed hosts with the word in their light DOM, each with nothing the page can reach: no slot, a hidden slot,
  // a plain slot, an undisplayed slot, a <div>, and one holding an element and an open component with slotted text; and a
  // seventh, inside an open root, which the page finds through that root.
  assert.deepEqual(await run(`[...document.querySelectorAll('[id^="wc-z-"]'), document.getElementById('wc-zo-outer').shadowRoot.getElementById('wc-z-inner')]
    .map((host) => [host.id, host.textContent.includes('zircon'), host.shadowRoot])`),
  [['wc-z-boxless', true, null], ['wc-z-veiled', true, null], ['wc-z-slotted', true, null], ['wc-z-unshown', true, null],
    ['wc-z-div', true, null], ['wc-z-mixed', true, null], ['wc-z-inner', true, null]]);
  await type('regex', '\\w+ zircon');
  await eventually(count, '1 of 1');
  assert.deepEqual(await run(`[...CSS.highlights.get('text-find-plus-match')].map((r) => r.toString())`), ['control zircon']);
  // No highlighted range starts or ends inside a closed host.
  const inside = await run(`[...CSS.highlights.values()].flatMap((h) => [...h]).flatMap((r) => [r.startContainer, r.endContainer])
    .filter((node) => (node.parentElement ?? node).closest('#wc-closed, [id^="wc-z-"]')).length`);
  assert.equal(inside, 0, 'a highlighted range is inside a closed component');
});

test('web components: the extension only asks whether a closed root exists, and never reads one', async () => {
  await fresh();
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  try {
    // In the extension's world, wrap the call that tells whether a closed root exists. The engine is handed a Proxy in
    // place of the root, which records every way it could be used, and a null where Chrome has none.
    await iso(`(() => {
      const dom = chrome.dom, real = dom.openOrClosedShadowRoot;
      globalThis.__asked = []; // [host id, whether Chrome had a root for it]
      globalThis.__touched = []; // every access to a root that was handed out
      const handler = {};
      for (const trap of ['get', 'set', 'has', 'deleteProperty', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty',
        'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions']) {
        handler[trap] = (target, ...args) => { __touched.push(trap + ' ' + String(args[0])); return Reflect[trap](target, ...(trap === 'get' ? args.slice(0, 1) : args)); };
      }
      dom.openOrClosedShadowRoot = (el) => {
        const root = real.call(dom, el);
        __asked.push([el.id || el.localName, root !== null]);
        return root === null ? null : new Proxy(root, handler);
      };
      globalThis.__unwrapDom = () => { dom.openOrClosedShadowRoot = real; };
    })()`);
    // The recorder works: the ways of testing for null record nothing, and reading from the root records the read.
    assert.deepEqual(await iso(`(() => {
      const root = chrome.dom.openOrClosedShadowRoot(document.getElementById('wc-closed'));
      const answers = [Boolean(root), !root, root !== null, root != null, root === undefined, typeof root, root ? 1 : 0, root ?? 0];
      const quiet = __touched.length;
      root.childNodes;
      const read = __touched.length - quiet;
      __asked.length = 0;
      __touched.length = 0;
      return { quiet, read, isRoot: answers[0] };
    })()`), { quiet: 0, read: 1, isRoot: true });

    await type('regex', '\\w+ zircon');
    await eventually(count, '1 of 1');
    await run(`__live.add('beacon zircon', { inside: true })`); // a live refresh searches again
    await eventually(count, '1 of 2', 1500);
    const closedHosts = (await iso('__asked')).filter(([, hadRoot]) => hadRoot).map(([id]) => id);
    assert.deepEqual([...new Set(closedHosts)].sort(),
      ['wc-closed', 'wc-z-boxless', 'wc-z-div', 'wc-z-inner', 'wc-z-mixed', 'wc-z-slotted', 'wc-z-unshown', 'wc-z-veiled']);
    assert.deepEqual(await iso('__touched'), [], 'the engine used a closed root for more than asking whether one exists');
  } finally {
    await iso('globalThis.__unwrapDom?.()');
    await run('__live.reset()');
  }
});

test('web components: when Chrome cannot say what a host holds, the search stops with an error and highlights nothing', async () => {
  await fresh();
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  try {
    // In the extension's world the call is missing. Reading that as "no element is closed" would count the "zircon" text
    // that closed components hide, so the search must stop instead.
    await iso(`(() => { const dom = chrome.dom, real = dom.openOrClosedShadowRoot; dom.openOrClosedShadowRoot = undefined;
      globalThis.__unwrapDom = () => { dom.openOrClosedShadowRoot = real; }; })()`);
    assert.equal(await iso('typeof chrome.dom.openOrClosedShadowRoot'), 'undefined', 'the call is still there in the extension\'s world');
    await type('regex', '\\w+ zircon');
    await eventually(() => P(`document.querySelector('#messages .error')?.textContent ?? ''`).then((message) => /openOrClosedShadowRoot/.test(message)), true);
    assert.equal(await hl(), 0, 'the main frame has highlights although its search stopped');
  } finally {
    await iso('globalThis.__unwrapDom?.()');
  }
});

test('web components: a match on both sides of a closed component paints none of the page text inside it', async () => {
  await fresh();
  // "tamarind", then a closed component that shows the page text inside it, then "quince": one match, two words.
  await run(`(() => { const p = document.createElement('p'); p.id = 'p-between';
    const host = document.createElement('lantern-card'); host.append('secretword');
    host.attachShadow({ mode: 'closed' }).innerHTML = '<b><slot></slot></b>';
    p.append('tamarind', host, 'quince');
    document.getElementById('p-zircon').after(p); })()`);
  try {
    assert.deepEqual(await run(`(() => { const host = document.querySelector('#p-between > lantern-card'); return [host.shadowRoot, host.textContent]; })()`),
      [null, 'secretword']);
    await type('regex', 'tamarindquince');
    await eventually(count, '1 of 1');
    assert.deepEqual(await run(`[...CSS.highlights.get('text-find-plus-match')].map((r) => r.toString())`), ['tamarind', 'quince']);
    const covering = await run(`[...CSS.highlights.values()].flatMap((h) => [...h]).filter((r) => r.intersectsNode(document.querySelector('#p-between > lantern-card'))).length`);
    assert.equal(covering, 0, 'a highlighted range covers the closed component and the page text inside it');
  } finally {
    await run(`document.getElementById('p-between').remove()`);
  }
});

test('web components: a bar the page placed inside a closed component is not cleared, and nothing below its host is read', async () => {
  await fresh();
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  // A cookie banner in a closed host's light DOM, shown through the closed root's slot, covers a match near the bottom.
  await run(`(() => { const box = document.createElement('div'); box.id = 'closed-bar';
    box.innerHTML = Array.from({ length: 60 }, (_, i) => '<p style="margin: 4px 0">line ' + i + (i === 30 ? ' tsavorite' : '') + '</p>').join('')
      + '<lantern-card id="closed-bar-host"><div id="closed-bar-banner" style="position: fixed; bottom: 0; left: 0; right: 0; height: 80px;'
      + ' background: white; z-index: 2147483646">Cookies</div></lantern-card>';
    box.lastChild.attachShadow({ mode: 'closed' }).innerHTML = '<slot></slot>';
    document.getElementById('p-zircon').after(box);
    const p = box.querySelectorAll('p')[30];
    scrollTo({ top: scrollY + p.getBoundingClientRect().top - (innerHeight - 50), behavior: 'instant' }); })()`);
  /** The id of what is on top of the current match's middle, as the page's hit test gives it, and the page's scroll position. */
  const state = () => run(`(() => { const r = [...CSS.highlights.get('text-find-plus-current')][0].getBoundingClientRect();
    return { top: document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)?.id ?? null, scrollY }; })()`);
  try {
    // In the extension's world, count each style read, rect read and closed-root question about the banner, and about
    // anything else below the host.
    await iso(`(() => {
      const host = document.getElementById('closed-bar-host'), banner = document.getElementById('closed-bar-banner');
      const watched = (e) => e === banner || (e !== host && host.contains(e));
      const style = window.getComputedStyle, rect = Element.prototype.getBoundingClientRect, dom = chrome.dom, ask = dom.openOrClosedShadowRoot;
      globalThis.__below = { style: 0, rect: 0, asked: 0 };
      window.getComputedStyle = function (e, ...rest) { if (watched(e)) __below.style++; return style.call(this, e, ...rest); };
      Element.prototype.getBoundingClientRect = function () { if (watched(this)) __below.rect++; return rect.call(this); };
      dom.openOrClosedShadowRoot = (e) => { if (watched(e)) __below.asked++; return ask.call(dom, e); };
      globalThis.__unwrapReads = () => { window.getComputedStyle = style; Element.prototype.getBoundingClientRect = rect; dom.openOrClosedShadowRoot = ask; };
    })()`);
    const y = await run('scrollY');
    await type('any', 'tsavorite');
    await eventually(count, '1 of 1');
    await eventually(() => run(`CSS.highlights.get('text-find-plus-current')?.size ?? 0`), 1); // show() ran, and its scroll with it
    assert.deepEqual(await state(), { top: 'closed-bar-banner', scrollY: y }, 'the page scrolled for a bar inside a closed component');
    assert.deepEqual(await iso('__below'), { style: 0, rect: 0, asked: 0 }, 'the extension looked below the closed host');

    // The control: moved out of the host, the same banner is a bar like any other, and the counts see it read.
    await run(`document.getElementById('closed-bar').append(document.getElementById('closed-bar-banner'))`);
    await sleep(1200); // the live refresh this causes lands first, and leaves the page where it is
    await key('Enter');
    await eventually(() => run('scrollY').then((now) => now > y), true);
    assert.notEqual((await state()).top, 'closed-bar-banner', 'the banner still covers the match');
    assert.ok((await iso('__below.style')) > 0, 'the counts saw nothing read');
  } finally {
    await iso('globalThis.__unwrapReads?.()');
    await run(`document.getElementById('closed-bar')?.remove(); scrollTo({ top: 0, behavior: 'instant' })`);
  }
});

// Chrome's openOrClosedShadowRoot() answers for open roots as well as closed ones, and the extension's world is the only
// one that asks it (the engine tests run in the page's world, where no element counts as closed). So only here can an open
// component be taken for a closed one, and stand in for the bar that covers a match.
const FIXED_BAR = 'position: fixed; bottom: 0; left: 0; right: 0; height: 80px; background: white; z-index: 2147483646';
const STICKY_BAR = 'position: sticky; top: 0; height: 60px; background: white; z-index: 2147483646';
const barLines = (word) => Array.from({ length: 60 }, (_, i) => '<p style="margin: 4px 0">line ' + i + (i === 30 ? ' ' + word : '') + '</p>').join('');

/**
 * Put `markup` (60 lines of text, the match on line 30, and an open component) on the page with its bar `bar` (an
 * expression) over the match, search for `word`, and require that the page moved the match out from under the bar.
 * `setup` attaches the open root; `y` is where the match starts in the viewport.
 */
async function assertBarCleared({ markup, setup, word, y, bar }) {
  await fresh();
  /** Whether the bar covers `target`'s box (an expression), and the page's scroll position. */
  const where = (target) => run(`(() => { const r = (${target}).getBoundingClientRect(), b = (${bar}).getBoundingClientRect();
    return { covered: r.bottom > b.top && r.top < b.bottom, scrollY }; })()`);
  try {
    await run(`(() => { const box = document.createElement('div'); box.id = 'open-bar'; box.innerHTML = ${JSON.stringify(markup)};
      document.getElementById('p-zircon').after(box); ${setup};
      scrollTo({ top: scrollY + box.querySelectorAll('p')[30].getBoundingClientRect().top - (${y}), behavior: 'instant' }); })()`);
    const start = await where(`document.querySelectorAll('#open-bar p')[30]`);
    assert.equal(start.covered, true, 'the bar does not cover the match before the search');
    await type('any', word);
    await eventually(count, '1 of 1');
    await eventually(() => run(`CSS.highlights.get('text-find-plus-current')?.size ?? 0`), 1); // show() ran, and its scroll with it
    const end = await where(`[...CSS.highlights.get('text-find-plus-current')][0]`);
    assert.equal(end.covered, false, 'the bar still covers the match');
    assert.notEqual(end.scrollY, start.scrollY, 'the page did not scroll');
  } finally {
    await run(`document.getElementById('open-bar')?.remove(); scrollTo({ top: 0, behavior: 'instant' })`);
  }
}

test('web components: a bar inside an open component, on a plain div, is cleared in the extension', async () => {
  await assertBarCleared({
    markup: `<div id="host"></div>${barLines('jadeite')}`,
    setup: `document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(`<div id="banner" style="${FIXED_BAR}">Cookies</div>`)}`,
    word: 'jadeite', y: 'innerHeight - 50', bar: `document.getElementById('host').shadowRoot.getElementById('banner')`,
  });
});

test('web components: a bar the page slotted into an open component is cleared in the extension', async () => {
  await assertBarCleared({
    markup: `<cookie-widget id="host"><div id="banner" style="${FIXED_BAR}">Cookies</div></cookie-widget>${barLines('prehnite')}`,
    setup: `document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>'`,
    word: 'prehnite', y: 'innerHeight - 50', bar: `document.getElementById('banner')`,
  });
});

test('web components: a sticky header over page text laid out through an open component is cleared in the extension', async () => {
  await assertBarCleared({
    markup: `<my-layout id="host" style="display: block"><header id="banner" style="${STICKY_BAR}">Header</header>${barLines('rhodonite')}</my-layout>`,
    setup: `document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<div class="frame"><slot></slot></div>'`,
    word: 'rhodonite', y: 20, bar: `document.getElementById('banner')`,
  });
});

test('web components: an element outside HTML that could host a root is skipped with its page text; SVG and MathML text is found', async () => {
  await fresh();
  // Chrome attaches a shadow root to a <div> in another namespace, but can't say whether such an element has a closed one.
  await run(`(() => { const box = document.createElement('div'); box.id = 'foreign';
    box.innerHTML = '<p>control xenolith</p><p><svg width="300" height="30"><text x="2" y="20">svg xenolith</text></svg></p>'
      + '<p><math><mtext>math xenolith</mtext></math></p>';
    const host = document.createElementNS('urn:x', 'div'); host.append('foreign xenolith');
    host.attachShadow({ mode: 'closed' }).innerHTML = '<p><slot></slot></p>';
    box.append(host);
    document.getElementById('p-zircon').after(box); })()`);
  try {
    assert.deepEqual(await run(`(() => { const host = document.getElementById('foreign').lastChild; return [host.namespaceURI, host.localName, host.shadowRoot, host.textContent]; })()`),
      ['urn:x', 'div', null, 'foreign xenolith']);
    await type('regex', '\\w+ xenolith');
    await eventually(count, '1 of 3');
    assert.deepEqual(await run(`[...CSS.highlights.get('text-find-plus-match')].map((r) => r.toString()).sort()`), ['control xenolith', 'math xenolith', 'svg xenolith']);
  } finally {
    await run(`document.getElementById('foreign').remove()`);
  }
});

test('web components: an element outside HTML with a "-" in its name, which can host no root, is searched', async () => {
  await fresh();
  // Chrome attaches a root to no element outside HTML whose name has a "-", so one is walked like any other. Inside
  // <math> the parser makes <x-note> and <annotation-xml> MathML elements, drawn with the token they hold; a script can
  // make one in any namespace.
  await run(`(() => { const box = document.createElement('div'); box.id = 'foreign-hyphen'; box.style.cssText = ${JSON.stringify(PINNED)};
    box.innerHTML = '<p>control quillwort</p><p><math><x-note><mi>mathml quillwort</mi></x-note></math></p>'
      + '<p><math><annotation-xml><mi>annotation quillwort</mi></annotation-xml></math></p>';
    box.appendChild(document.createElement('p')).appendChild(document.createElementNS('urn:x', 'x-note')).append('urn quillwort');
    document.getElementById('p-zircon').after(box); })()`);
  try {
    assert.deepEqual(await run(`[...document.querySelectorAll('#foreign-hyphen *')].filter((el) => el.localName.includes('-')).map((el) => {
      let hosts = true; try { document.createElementNS(el.namespaceURI, el.localName).attachShadow({ mode: 'open' }); } catch { hosts = false; }
      return [el.localName, el.namespaceURI, hosts]; })`),
    [['x-note', 'http://www.w3.org/1998/Math/MathML', false], ['annotation-xml', 'http://www.w3.org/1998/Math/MathML', false], ['x-note', 'urn:x', false]]);
    assert.deepEqual(await drawn(page.session, ['mathml quillwort', 'annotation quillwort', 'urn quillwort']),
      { 'mathml quillwort': true, 'annotation quillwort': true, 'urn quillwort': true });
    await type('regex', '\\w+ quillwort');
    await eventually(count, '1 of 4');
    assert.deepEqual(await run(`[...CSS.highlights.get('text-find-plus-match')].map((r) => r.toString()).sort()`),
      ['annotation quillwort', 'control quillwort', 'mathml quillwort', 'urn quillwort']);
  } finally {
    await run(`document.getElementById('foreign-hyphen').remove()`);
  }
});

test('web components: searching in the extension keeps the performance target', async () => {
  await fresh(); // the engine is injected
  await run(`(() => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt'.split(' ');
    const box = document.createElement('div');
    box.id = 'perf';
    let size = 0, i = 0;
    while (size < 1_000_000) {
      const p = document.createElement('p');
      let text = '';
      for (let w = 0; w < 30; w++) text += words[(i * 7 + w) % words.length] + ' ';
      if (i % 50 === 0) text += 'flight ';
      p.textContent = text;
      box.append(p);
      size += text.length;
      i++;
    }
    document.body.append(box);
  })()`);
  try {
    const query = JSON.stringify({ kind: 'flat', source: 'flight', flags: 'gui' });
    const ms = await page.session.evaluate(`(() => { const t = performance.now(); __textFindPlusEngine.search(${query}); __textFindPlusEngine.clear(false);
      return performance.now() - t; })()`, { contextId: isolatedContext(page.session) });
    console.log(`# performance in the extension: ~1 MB page searched in ${ms.toFixed(1)} ms`);
    assert.ok(ms < 300, `took ${ms} ms`);
  } finally {
    await run(`document.getElementById('perf').remove()`);
  }
});

// ---------- live updates (spec §3) ----------

/** The data-id of the line holding the current match, as the page sees it. */
const currentLine = () => run(`[...CSS.highlights.get('text-find-plus-current') ?? []][0]?.startContainer.parentElement.dataset.id ?? null`);

test('live: matches added and removed, in the page and inside a component', async () => {
  await fresh();
  await run(`(() => { const s = document.createElement('div'); s.id = 'spacer'; s.style.height = '3000px';
    document.getElementById('live').before(s); __live.add('beacon', { id: 'a' }); __live.add('beacon', { id: 'b' }); })()`);
  try {
    await type('any', 'beacon');
    await eventually(count, '1 of 2');
    await key('Enter');
    await eventually(count, '2 of 2');
    assert.equal(await currentLine(), 'b');
    await run('scrollTo(0, 0)');

    await run(`__live.add('beacon', { id: 'c', first: true })`);
    await eventually(count, '3 of 3', 1500); // b is still current, now third
    assert.equal(await currentLine(), 'b');
    assert.equal(await run('scrollY'), 0, 'a live refresh never scrolls');

    await run(`__live.remove('c')`);
    await eventually(count, '2 of 2', 1500);
    assert.equal(await currentLine(), 'b');

    await run(`__live.add('beacon', { id: 'd', inside: true })`);
    await eventually(count, '2 of 3', 1500);
    assert.equal(await currentLine(), 'b');
    assert.equal(await run('scrollY'), 0);

    await run(`__live.remove('b')`); // the current match itself goes: the same number stays current
    await eventually(count, '2 of 2', 1500);
    assert.equal(await currentLine(), 'd');
    assert.equal(await run('scrollY'), 0);
  } finally {
    await run(`__live.reset(); document.getElementById('spacer').remove(); scrollTo(0, 0)`);
  }
});

test('live: "Not on this page" turns into matches when the word appears', async () => {
  await fresh();
  try {
    await type('all', 'lantern beacon');
    await eventually(async () => (await text('messages')).includes('Not on this page: beacon'), true);
    await run(`__live.add('beacon')`);
    await eventually(count, '1 of 5', 1500);
    assert.equal((await text('messages')).includes('Not on this page'), false);
    await run('__live.reset()');
    await eventually(async () => (await text('messages')).includes('Not on this page: beacon'), true, 1500);
    assert.equal(await count(), 'No matches');
    await eventually(hl, 0);
  } finally {
    await run('__live.reset()');
  }
});

test('live: paused while the last search stopped early, back on after one that finished', async () => {
  await fresh();
  try {
    await type('any', 'beacon');
    await eventually(count, 'No matches');
    // Keep the page busy past the popup's 3 s wait, so the next search counts as stopped early (spec §3.5).
    await run('setTimeout(() => { const end = Date.now() + 4500; while (Date.now() < end); })');
    await sleep(100);
    await type('any', 'lantern');
    await eventually(async () => (await text('messages')).includes(LIVE_PAUSED), true, 6000);
    await run(`__live.add('lantern')`);
    await sleep(1500);
    assert.equal(await count(), 'No matches', 'paused: the change is ignored');
    await type('any', 'beacon lantern');
    await eventually(count, '1 of 5');
    assert.equal((await text('messages')).includes(LIVE_PAUSED), false);
    await run(`__live.add('beacon')`);
    await eventually(count, '1 of 6', 1500);
  } finally {
    await run('__live.reset()');
  }
});

/** `iso(expr, frameId?)` evaluates in the extension's world of the page, or of the same-origin frame whose id comes with it. */
async function isolatedWorlds() {
  const { frameTree } = await page.session.send('Page.getFrameTree');
  const frameId = frameTree.childFrames.find((f) => f.frame.url === `${server.origin}/frame.html`).frame.id;
  assert.ok(isolatedContext(page.session, frameId), 'the engine is in the same-origin frame');
  return { frameId, iso: (expr, frame) => page.session.evaluate(expr, { contextId: isolatedContext(page.session, frame) }) };
}

/**
 * Stage a search that waits for a frame (spec §3.3). In the page, each search does what __plan says next: 'pause'
 * answers as if it stopped early, 'change' adds a line once it has searched (so the page reports the change at once),
 * 'both' does both; the page counts its searches and notes when it changed. In the same-origin frame, the next search
 * first waits __stallMs when that is set, so the page's answer and its change report reach the popup while the popup
 * still waits for the frame; the frame notes when it waited. Undo it with `__unwrap()` in each.
 */
async function stageFrameWait(iso, frameId) {
  await iso(`(() => { const engine = __textFindPlusEngine, search = engine.search; globalThis.__plan = []; globalThis.__searches = 0;
    engine.search = (...args) => {
      __searches++;
      const result = search(...args);
      const step = __plan.shift();
      if (step === 'change' || step === 'both') {
        const p = document.createElement('p'); p.textContent = 'beacon'; document.getElementById('live').append(p);
        globalThis.__changedAt = Date.now();
      }
      return step === 'pause' || step === 'both' ? { ...result, timedOut: true } : result;
    };
    globalThis.__unwrap = () => { engine.search = search; }; })()`);
  await iso(`(() => { const engine = __textFindPlusEngine, search = engine.search; globalThis.__stallMs = 0;
    engine.search = (...args) => {
      if (__stallMs) { const from = Date.now(); while (Date.now() < from + __stallMs); globalThis.__stall = [from, Date.now()]; __stallMs = 0; }
      return search(...args);
    };
    globalThis.__unwrap = () => { engine.search = search; }; })()`, frameId);
}

test('live: a change reported while a search waits for a frame is refreshed once it lands, unless that search paused', async () => {
  await fresh();
  const { iso, frameId } = await isolatedWorlds();
  try {
    await stageFrameWait(iso, frameId);
    await run(`__live.add('beacon', { id: 'a' })`);

    // The last search stopped early, so live updates are paused.
    await iso(`__plan.push('pause')`);
    await type('any', 'beacon');
    await eventually(async () => (await text('messages')).includes(LIVE_PAUSED), true);
    assert.equal(await count(), '1 of 1');

    // A search that finishes in time turns them back on. The page changes while it waits for the frame.
    await iso(`__plan.push('change')`);
    await iso('__stallMs = 1000', frameId);
    await tick('matchCase');
    await eventually(async () => (await text('messages')).includes(LIVE_PAUSED), false, 3000);
    await eventually(count, '1 of 2', 3000); // the refresh the change asks for
    let [from] = await iso('__stall', frameId);
    assert.ok((await iso('__changedAt')) <= from, 'the page changed after the frame had begun to answer');

    // A search that stops early, while the page changes as it waits for the frame: no refresh follows it.
    await iso(`__searches = 0; __plan.push('both')`);
    await iso('__stallMs = 1000', frameId);
    await tick('matchCase');
    await eventually(async () => (await text('messages')).includes(LIVE_PAUSED), true, 3000);
    await sleep(2000); // well past when a refresh would have run
    assert.equal(await iso('__searches'), 1, 'a live refresh ran after a search that paused live updates');
    assert.equal(await count(), '1 of 2');
    [from] = await iso('__stall', frameId);
    assert.ok((await iso('__changedAt')) <= from, 'the page changed after the frame had begun to answer');
  } finally {
    await iso('globalThis.__unwrap?.()');
    await iso('globalThis.__unwrap?.()', frameId);
    await run('__live.reset()');
  }
});

test('live: a change reported while a live refresh waits for a frame is refreshed once that refresh lands', async () => {
  await fresh();
  const { iso, frameId } = await isolatedWorlds();
  try {
    await stageFrameWait(iso, frameId);
    await run(`__live.add('beacon', { id: 'a' })`);
    await type('any', 'beacon');
    await eventually(count, '1 of 1');
    // A change starts a live refresh, and the page changes again while that refresh waits 1.5 s for the frame: long
    // enough that a refresh scheduled for the second change, 1 s after the first one started, would replace it.
    await iso(`__searches = 0; __plan.push('change')`);
    await iso('__stallMs = 1500', frameId);
    await run(`__live.add('beacon', { id: 'b' })`);
    await eventually(count, '1 of 2', 4000); // the refresh lands with what it found
    await eventually(count, '1 of 3', 3000); // then the change held while it waited is refreshed
    assert.equal(await iso('__searches'), 2);
    const [from] = await iso('__stall', frameId);
    assert.ok((await iso('__changedAt')) <= from, 'the page changed after the frame had begun to answer');
  } finally {
    await iso('globalThis.__unwrap?.()');
    await iso('globalThis.__unwrap?.()', frameId);
    await run('__live.reset()');
  }
});

test('live: a change reported while a live refresh that stops early waits for a frame is dropped', async () => {
  await fresh();
  const { iso, frameId } = await isolatedWorlds();
  try {
    await stageFrameWait(iso, frameId);
    await run(`__live.add('beacon', { id: 'a' })`);
    await type('any', 'beacon');
    await eventually(count, '1 of 1');
    // A change starts a live refresh that stops early, and the page changes again while it waits for the frame.
    await iso(`__searches = 0; __plan.push('both')`);
    await iso('__stallMs = 1500', frameId);
    await run(`__live.add('beacon', { id: 'b' })`);
    await eventually(async () => (await text('messages')).includes(LIVE_PAUSED), true, 4000);
    await sleep(2000); // well past when a refresh would have run
    assert.equal(await iso('__searches'), 1, 'a live refresh ran after a refresh that paused live updates');
    assert.equal(await count(), '1 of 2');
    const [from] = await iso('__stall', frameId);
    assert.ok((await iso('__changedAt')) <= from, 'the page changed after the frame had begun to answer');
  } finally {
    await iso('globalThis.__unwrap?.()');
    await iso('globalThis.__unwrap?.()', frameId);
    await run('__live.reset()');
  }
});

test('live: a change that two frames report together is refreshed once', async () => {
  await fresh();
  const { iso, frameId } = await isolatedWorlds();
  const frameBody = `document.getElementById('same').contentDocument.body`;
  const wrapSearch = `(() => { const engine = __textFindPlusEngine, search = engine.search; globalThis.__searches = 0;
    engine.search = (...args) => { __searches++; return search(...args); };
    globalThis.__unwrap = () => { engine.search = search; }; })()`;
  try {
    await type('any', 'beacon');
    await eventually(count, 'No matches');
    await iso(wrapSearch);
    await iso(wrapSearch, frameId);
    // One script changes the page and its frame, so each reports the change to the popup at about the same moment.
    await run(`__live.add('beacon', { id: 'm' }); ${frameBody}.append(Object.assign(document.createElement('p'), { id: 'frame-beacon', textContent: 'beacon' }))`);
    await eventually(count, '1 of 2', 3000);
    await sleep(1500); // well past when a second refresh would have run
    assert.deepEqual([await iso('__searches'), await iso('__searches', frameId)], [1, 1], 'searches the page and its frame made for one change');
  } finally {
    await iso('globalThis.__unwrap?.()');
    await iso('globalThis.__unwrap?.()', frameId);
    await run(`${frameBody}.querySelector('#frame-beacon')?.remove(); __live.reset()`);
  }
});

test('live: closing the popup stops watching', async () => {
  await fresh();
  try {
    await type('any', 'beacon');
    await eventually(count, 'No matches');
    assert.equal(await page.session.evaluate('__textFindPlusEngine._watching', { contextId: isolatedContext(page.session) }), true);
    await closePopup();
    assert.equal(await page.session.evaluate('__textFindPlusEngine._watching', { contextId: isolatedContext(page.session) }), false);
    await run(`__live.add('beacon')`);
    await sleep(1000);
    assert.equal(await hl(), 0);
  } finally {
    await run('__live.reset()');
  }
});

test('live: hidden text that is shown later is found', async () => {
  await fresh();
  try {
    await type('any', 'lantern');
    await eventually(count, '1 of 4');
    await run(`document.getElementById('wc-hidden').hidden = false`);
    await eventually(count, '1 of 5', 1500);
  } finally {
    await run(`document.getElementById('wc-hidden').hidden = true`);
  }
});

test('live: a change inside a same-origin frame', async () => {
  await fresh();
  const frameBody = `document.getElementById('same').contentDocument.body`;
  try {
    await type('any', 'beacon');
    await eventually(count, 'No matches');
    await run(`${frameBody}.append(Object.assign(document.createElement('p'), { id: 'frame-beacon', textContent: 'beacon' }))`);
    await eventually(count, '1 of 1', 1500);
  } finally {
    await run(`${frameBody}.querySelector('#frame-beacon')?.remove()`);
  }
});

test('live: a page that keeps changing is refreshed about once a second', async () => {
  await fresh();
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  try {
    await type('any', 'tick');
    await eventually(count, 'No matches');
    await iso(`(() => { const engine = __textFindPlusEngine, search = engine.search; globalThis.__searches = 0;
      engine.search = (...args) => { __searches++; return search(...args); };
      globalThis.__unwrap = () => { engine.search = search; }; })()`);
    await run(`globalThis.__churn = setInterval(() => __live.add('tick'), 100)`);
    await sleep(3000);
    await run('clearInterval(__churn)');
    const searches = await iso('__searches');
    assert.ok(searches >= 2 && searches <= 4, `${searches} refreshes in 3 s`);
    const lines = await run(`document.querySelectorAll('#live p').length`);
    await eventually(count, `1 of ${lines}`, 2000);
  } finally {
    await run('clearInterval(globalThis.__churn); __live.reset()');
    await iso('globalThis.__unwrap?.()');
  }
});

test('live: Enter during a refresh is not undone', async () => {
  await fresh();
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  try {
    await run(`__live.add('beacon', { id: 'a' }); __live.add('beacon', { id: 'b' })`);
    await type('any', 'beacon');
    await eventually(count, '1 of 2');
    assert.equal(await currentLine(), 'a');
    // Make the next search take 1 s in the page, so a refresh is in flight for a while, and well inside
    // the popup's 3 s wait for an answer even if another search queues behind it. The page notes when.
    await iso(`(() => { const engine = __textFindPlusEngine, search = engine.search;
      engine.search = (...args) => {
        const from = Date.now();
        while (Date.now() < from + 1000);
        const result = search(...args);
        globalThis.__stall = [from, Date.now()];
        return result;
      };
      globalThis.__unwrap = () => { engine.search = search; }; })()`);
    await sleep(1200); // past the 1 s gap since the search, so the refresh starts 0.5 s after the change
    await run(`__live.add('beacon', { id: 'c' })`);
    await sleep(900); // the refresh started at 0.5 s and ends at about 1.5 s
    const pressed = Date.now();
    await key('Enter');
    await eventually(count, '2 of 3', 4000); // the press counts from the match the refresh kept
    await eventually(currentLine, 'b');
    await sleep(1500); // clearly after the refresh landed
    assert.equal(await count(), '2 of 3', 'the press is not undone');
    assert.equal(await currentLine(), 'b');
    const [from, to] = await iso('__stall');
    assert.ok(from < pressed && pressed < to, `Enter at ${pressed} was not inside the refresh (${from} to ${to})`);
  } finally {
    await iso('globalThis.__unwrap?.()');
    await run('__live.reset()');
  }
});

test('live: Enter on "No matches" during a refresh is not carried over to the matches it finds', async () => {
  await fresh();
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  try {
    await type('any', 'beacon');
    await eventually(count, 'No matches');
    // Make the next search take 1 s in the page, so a refresh is in flight for a while. The page notes when.
    await iso(`(() => { const engine = __textFindPlusEngine, search = engine.search;
      engine.search = (...args) => {
        const from = Date.now();
        while (Date.now() < from + 1000);
        const result = search(...args);
        globalThis.__stall = [from, Date.now()];
        return result;
      };
      globalThis.__unwrap = () => { engine.search = search; }; })()`);
    await sleep(1200); // past the 1 s gap since the search, so the refresh starts 0.5 s after the change
    await run(`__live.add('beacon', { id: 'a' }); __live.add('beacon', { id: 'b' })`);
    await sleep(900); // the refresh started at 0.5 s and ends at about 1.5 s
    const pressed = Date.now();
    await key('Enter'); // nothing is current, so there is nothing for this press to move
    await eventually(count, '1 of 2', 4000);
    await eventually(currentLine, 'a');
    await sleep(1500); // clearly after the refresh landed
    assert.equal(await count(), '1 of 2', 'the press did not land on match 2');
    assert.equal(await currentLine(), 'a');
    const [from, to] = await iso('__stall');
    assert.ok(from < pressed && pressed < to, `Enter at ${pressed} was not inside the refresh (${from} to ${to})`);
  } finally {
    await iso('globalThis.__unwrap?.()');
    await run('__live.reset()');
  }
});

test('live: a refresh that changes nothing visible leaves the messages and the count alone', async () => {
  await fresh();
  const iso = (expr) => page.session.evaluate(expr, { contextId: isolatedContext(page.session) });
  try {
    await type('regex', 'st*n'); // no matches, so the popup shows a tip with a button
    await eventually(count, 'No matches');
    await eventually(() => P(`document.querySelectorAll('#messages .tip button').length`), 1);
    // Focus the tip button and watch #messages and #count for any write at all.
    await P(`(() => {
      globalThis.__tipButton = document.querySelector('#messages .tip button');
      __tipButton.focus();
      globalThis.__writes = 0;
      const watch = new MutationObserver((records) => { __writes += records.length; });
      for (const id of ['messages', 'count']) watch.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true, attributes: true });
    })()`);
    await iso(`(() => { const engine = __textFindPlusEngine, search = engine.search; globalThis.__searches = 0;
      engine.search = (...args) => { __searches++; return search(...args); };
      globalThis.__unwrap = () => { engine.search = search; }; })()`);
    await run(`__live.add('xyz')`); // matches nothing, so the refresh finds exactly what was there
    await eventually(() => iso('__searches'), 1, 3000);
    await sleep(300); // the answer reaches the popup and is drawn
    assert.deepEqual(await P(`({ writes: __writes, focused: document.activeElement === __tipButton,
      sameButton: document.querySelector('#messages .tip button') === __tipButton, count: document.getElementById('count').textContent })`),
    { writes: 0, focused: true, sameButton: true, count: 'No matches' });
  } finally {
    await iso('globalThis.__unwrap?.()');
    await run('__live.reset()');
  }
});

// ---------- the rule (spec §2) ----------

test('the rule: opening, searching, live refreshes, clearing and closing never change the page', async () => {
  await closePopup();
  await navigate(browser, page.session, pageUrl); // a fresh page, so injecting the engine is watched too
  try {
    await run(`(() => {
      globalThis.__records = [];
      globalThis.__observers = [];
      globalThis.__added = [];
      const frame = document.getElementById('same').contentDocument; // the same-origin frame is part of the page
      // Form controls with state of their own, in the document, the frame and every shadow root (closed ones too, which the page
      // keeps in __closedRoots): a typed text box, a ticked box, a select moved off its first option, and a typed textarea.
      // The root of #wc-live is left out: __live.reset() below empties it, controls and all.
      const live = document.getElementById('wc-live').shadowRoot;
      globalThis.__formRoots = () => [document, frame, ...__shadowRoots().filter((root) => root !== live)];
      const addControls = (root) => {
        const doc = root.ownerDocument ?? root;
        const [text, box, select, area] = ['input', 'input', 'select', 'textarea'].map((tag) => doc.createElement(tag));
        text.value = 'typed by a user';
        box.type = 'checkbox';
        box.checked = true;
        for (const label of ['first', 'second']) select.append(Object.assign(doc.createElement('option'), { textContent: label }));
        select.selectedIndex = 1;
        area.value = 'typed in a textarea';
        (root.body ?? root).append(text, box, select, area);
        __added.push(text, box, select, area);
      };
      __formRoots().forEach(addControls);
      const watch = (node) => {
        const observer = new MutationObserver((records) => {
          for (const r of records) __records.push(r.type + ' ' + r.target.nodeName + ' ' + (r.attributeName ?? ''));
        });
        observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
        __observers.push(observer);
      };
      watch(document);
      watch(frame);
      __shadowRoots().forEach(watch);
      // Everything about a document that the rule keeps as it is: its contents (getHTML leaves out <html> itself, so its
      // attributes and the doctype are listed on their own), the rules inside its stylesheets (editing those is not a DOM
      // change, so no observer sees it) and the stylesheets it adopted.
      const describe = (doc, roots) => [
        doc.documentElement.getHTML({ shadowRoots: roots }),
        [...doc.documentElement.attributes].map((a) => [a.name, a.value]),
        doc.doctype && [doc.doctype.name, doc.doctype.publicId, doc.doctype.systemId],
        [...doc.styleSheets].map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)),
        doc.adoptedStyleSheets.length,
      ];
      globalThis.__snapshot = () => JSON.stringify([describe(document, __shadowRoots()), describe(frame, []),
        __shadowRoots().map((r) => r.adoptedStyleSheets.length)]);
      globalThis.__before = __snapshot();
      // What no attribute or child shows: the state of every form control, in the same places.
      globalThis.__controls = () => __formRoots().map((root) =>
        [...root.querySelectorAll('input, textarea, select')].map((c) => [c.localName, c.type, c.value, c.checked, c.selectedIndex]));
      globalThis.__controlsBefore = __controls();
    })()`);
    // The snapshot sees what it was built to see: a typed value, a ticked box and a chosen option in the document, in the frame
    // and in every root, closed ones among them.
    assert.deepEqual(await run(`(() => {
      const everywhere = (found) => __controlsBefore.every((controls) => controls.some(found));
      return { closedRoots: __closedRoots.every((root) => __formRoots().includes(root)), openRoots: __formRoots().length - 2 > __closedRoots.length,
        typed: everywhere(([, , value]) => value === 'typed by a user'), ticked: everywhere(([, type, , checked]) => type === 'checkbox' && checked),
        chosen: everywhere(([name, , , , selected]) => name === 'select' && selected === 1) };
    })()`), { closedRoots: true, openRoots: true, typed: true, ticked: true, chosen: true }, 'the form controls the test compares');
    const records = () => run('__records');
    /**
     * Make a change of the test's own. Its records are taken from every observer in the same moment, before any callback can
     * run, so a write the extension makes in reaction to it, which the observers deliver afterwards, is still recorded.
     */
    const change = (expr) => run(`(async () => { ${expr}; __observers.forEach((observer) => observer.takeRecords()); await new Promise((done) => setTimeout(done)); })()`);

    await open();
    await type('any', 'cheap');
    await eventually(count, '1 of 3');
    await type('any', 'framed'); // the extension also paints inside the same-origin frame
    await eventually(count, '1 of 1');
    assert.equal(await run(`document.getElementById('same').contentWindow.CSS.highlights.get('text-find-plus-match')?.size ?? 0`), 1);
    await type('any', '');
    await tick('ordered');
    await type('all', 'flight cheap');
    await eventually(count, '1 of 2');
    await type('all', '');
    await type('regex', '\\w+ lantern');
    await eventually(count, '1 of 4');
    await key('Enter');
    await key('Enter', { shift: true });
    await click('#next');
    await click('#prev');
    await eventually(count, '1 of 4');
    assert.deepEqual(await records(), []);

    await change(`__live.add('beacon lantern', { inside: true })`);
    await eventually(count, '1 of 5', 1500);
    await sleep(100);
    assert.deepEqual(await records(), [], 'a live refresh changes nothing');
    await change('__live.reset()');
    await eventually(count, '1 of 4', 1500);
    await sleep(100);

    // Moving to a match runs reveal()'s two scrolling paths, which test.html alone never reaches: a pane that hides the match is
    // scrolled, and the page is scrolled to clear a sticky header that covers it. The pane and the header are the test's own,
    // put in and taken out with change().
    await change(`(() => {
      const line = (i, at, word) => '<p style="margin: 4px 0">line ' + i + (i === at ? ' ' + word : '') + '</p>';
      const pane = document.createElement('div'); pane.id = 'rule-pane'; pane.style.cssText = 'height: 100px; overflow: auto; width: 300px';
      pane.innerHTML = Array.from({ length: 30 }, (_, i) => line(i, 8, 'rubellite')).join('');
      const bars = document.createElement('div'); bars.id = 'rule-bars';
      bars.innerHTML = '<header id="rule-header" style="position: sticky; top: 0; height: 60px; background: white; z-index: 5">Header</header>'
        + Array.from({ length: 60 }, (_, i) => line(i, 30, 'verdelite')).join('');
      document.getElementById('p-zircon').after(pane, bars);
      scrollTo({ top: scrollY + pane.getBoundingClientRect().top - 100, behavior: 'instant' });
    })()`);
    // The pane: the match's line is in the viewport, below the part of the pane that shows.
    assert.deepEqual(await run(`(() => { const pane = document.getElementById('rule-pane'), r = pane.querySelectorAll('p')[8].getBoundingClientRect();
      return [pane.scrollTop, r.top > pane.getBoundingClientRect().bottom, r.bottom < innerHeight]; })()`), [0, true, true], 'the pane does not hide the match');
    let y = await run('scrollY');
    await type('regex', 'rubellite');
    await eventually(count, '1 of 1');
    await eventually(() => run(`document.getElementById('rule-pane').scrollTop > 0`), true);
    assert.equal(await run('scrollY'), y, 'the page moved for a match that only the pane hid');
    // The sticky header: the match's line is 20 px down the viewport, under the header.
    await run(`(() => { const p = document.querySelectorAll('#rule-bars p')[30]; scrollTo({ top: scrollY + p.getBoundingClientRect().top - 20, behavior: 'instant' }); })()`);
    const headerOver = (expr) => run(`(() => { const r = ${expr}.getBoundingClientRect(); return document.elementFromPoint(r.left + 10, (r.top + r.bottom) / 2)?.id === 'rule-header'; })()`);
    assert.equal(await headerOver(`document.querySelectorAll('#rule-bars p')[30]`), true, 'the header does not cover the match');
    y = await run('scrollY');
    await type('regex', 'verdelite');
    await eventually(count, '1 of 1');
    await eventually(() => run('scrollY').then((now) => now < y), true);
    assert.equal(await headerOver(`[...CSS.highlights.get('text-find-plus-current')][0]`), false, 'the header still covers the match');
    await sleep(100);
    assert.deepEqual(await records(), [], 'scrolling a pane or the page to a match changes nothing');
    await change(`document.getElementById('rule-pane').remove(); document.getElementById('rule-bars').remove()`);
    await sleep(100);

    await click('#clear');
    await eventually(count, '');
    await closePopup();
    await sleep(200);
    assert.deepEqual(await records(), []);
    assert.equal(await run('__snapshot() === __before'), true, 'the document, its frame and every shadow root are as they were');
    assert.deepEqual(await run('__controls()'), await run('__controlsBefore'), 'a form control in the document, its frame or a shadow root has another value, state or selection');
  } finally {
    // The page is shared with the tests after this one: take back the controls, the pane and the header, and stop watching.
    await run(`(globalThis.__added ?? []).forEach((control) => control.remove()); (globalThis.__observers ?? []).forEach((observer) => observer.disconnect());
      document.getElementById('rule-pane')?.remove(); document.getElementById('rule-bars')?.remove(); scrollTo({ top: 0, behavior: 'instant' })`);
  }
});

// ---------- theme ----------

const THEME_AUTO = 'Theme: Automatic (follows Chrome). Click for Light.';
const THEME_LIGHT = 'Theme: Light. Click for Dark.';
const THEME_DARK = 'Theme: Dark. Click for Automatic.';
const GLYPH_AUTO = 'A\u25D0\uFE0E', GLYPH_LIGHT = '\u2600\uFE0E', GLYPH_DARK = '\u263E\uFE0E';
const BG_LIGHT = 'rgb(255, 255, 255)', BG_DARK = 'rgb(31, 31, 33)'; // --bg in popup.css
/**
 * Make the popup see Chrome's setting as 'light' or 'dark' ('' clears it). Chrome resets this emulation once, a few
 * hundred ms after a popup opens, so it is applied again until it has held for 800 ms.
 */
async function emulateScheme(value) {
  const apply = () => popup.session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  await apply();
  if (!value) return;
  const deadline = Date.now() + 5000;
  let heldSince = Date.now();
  while (Date.now() - heldSince < 800) {
    assert.ok(Date.now() < deadline, `prefers-color-scheme: ${value} would not hold`);
    await sleep(50);
    if ((await P(`matchMedia('(prefers-color-scheme: dark)').matches`)) !== (value === 'dark')) { await apply(); heldSince = Date.now(); }
  }
}
/** What the popup shows about its theme: the button, the root attribute, the stored choice, and a colour that uses var(--bg). */
const themeState = () => P(`(() => {
  const b = document.getElementById('theme');
  return { label: b.getAttribute('aria-label'), title: b.title, glyph: b.textContent,
    attr: document.documentElement.getAttribute('data-theme'), stored: localStorage.getItem('theme'),
    bg: getComputedStyle(document.body).backgroundColor };
})()`);

test('theme: the button moves Automatic → Light → Dark → Automatic and the colours follow', async () => {
  await open();
  try {
    await emulateScheme('dark');
    const auto = { label: THEME_AUTO, title: THEME_AUTO, glyph: GLYPH_AUTO, attr: null, stored: null };
    await eventually(themeState, { ...auto, bg: BG_DARK });
    await click('#theme');
    await eventually(themeState, { label: THEME_LIGHT, title: THEME_LIGHT, glyph: GLYPH_LIGHT, attr: 'light', stored: 'light', bg: BG_LIGHT });
    await click('#theme');
    await eventually(themeState, { label: THEME_DARK, title: THEME_DARK, glyph: GLYPH_DARK, attr: 'dark', stored: 'dark', bg: BG_DARK });
    await click('#theme');
    await eventually(themeState, { ...auto, bg: BG_DARK });
    await emulateScheme('light');
    await eventually(themeState, { ...auto, bg: BG_LIGHT });
  } finally {
    await P(`localStorage.removeItem('theme')`);
    await emulateScheme('');
  }
});

test('theme: the choice is remembered when the popup reopens', async () => {
  await open();
  try {
    await click('#theme');
    await click('#theme');
    await eventually(themeState, { label: THEME_DARK, title: THEME_DARK, glyph: GLYPH_DARK, attr: 'dark', stored: 'dark', bg: BG_DARK });
    await closePopup();
    await open();
    await emulateScheme('light'); // this popup has its own emulation; Chrome now says light, so the dark below is the saved choice
    assert.equal(await P(`matchMedia('(prefers-color-scheme: dark)').matches`), false);
    await eventually(themeState, { label: THEME_DARK, title: THEME_DARK, glyph: GLYPH_DARK, attr: 'dark', stored: 'dark', bg: BG_DARK });
  } finally {
    if (popup) {
      await P(`localStorage.removeItem('theme')`);
      await emulateScheme('');
    }
  }
});

test('theme: a stored value nobody recognises reads as Automatic', async () => {
  await open();
  try {
    await P(`localStorage.setItem('theme', 'blue')`);
    await closePopup();
    await open();
    await emulateScheme('dark');
    await eventually(themeState, { label: THEME_AUTO, title: THEME_AUTO, glyph: GLYPH_AUTO, attr: null, stored: 'blue', bg: BG_DARK });
    await click('#theme');
    await eventually(themeState, { label: THEME_LIGHT, title: THEME_LIGHT, glyph: GLYPH_LIGHT, attr: 'light', stored: 'light', bg: BG_LIGHT });
  } finally {
    if (popup) {
      await P(`localStorage.removeItem('theme')`);
      await emulateScheme('');
    }
  }
});

test('theme: with storage refused the button still works for as long as the popup is open', async () => {
  await open();
  try {
    // Reload the popup with localStorage throwing from the first line of the document, as Chrome does when site data is blocked.
    await popup.session.send('Page.enable');
    await popup.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } })`,
    });
    const loaded = browser.waitForEvent('Page.loadEventFired', (_, sid) => sid === popup.session.id, 10000);
    await popup.session.send('Page.reload');
    await loaded;
    const shown = () => P(`(() => { const b = document.getElementById('theme');
      return { label: b.getAttribute('aria-label'), glyph: b.textContent, attr: document.documentElement.getAttribute('data-theme') }; })()`);
    await eventually(shown, { label: THEME_AUTO, glyph: GLYPH_AUTO, attr: null });
    assert.equal(await P(`(() => { try { localStorage; return 'readable'; } catch { return 'refused'; } })()`), 'refused');
    await click('#theme');
    await eventually(shown, { label: THEME_LIGHT, glyph: GLYPH_LIGHT, attr: 'light' });
    await click('#theme');
    await eventually(shown, { label: THEME_DARK, glyph: GLYPH_DARK, attr: 'dark' });
    await click('#theme');
    await eventually(shown, { label: THEME_AUTO, glyph: GLYPH_AUTO, attr: null });
  } finally {
    await closePopup(); // the injected script belongs to this popup's session and goes with it
  }
});

test('theme: the button is the same size in all three modes', async () => {
  await open();
  try {
    const shown = () => P(`(() => { const b = document.getElementById('theme'), r = b.getBoundingClientRect();
      return { glyph: b.textContent, size: [r.width, r.height] }; })()`);
    const modes = [];
    for (let i = 0; i < 3; i++) {
      modes.push(await shown());
      await click('#theme');
    }
    assert.deepEqual(modes.map((m) => m.glyph), [GLYPH_AUTO, GLYPH_LIGHT, GLYPH_DARK]);
    for (const m of modes) assert.deepEqual(m.size, modes[0].size, `${m.glyph} makes the button ${m.size.join(' × ')} px, ${modes[0].glyph} ${modes[0].size.join(' × ')} px`);
  } finally {
    await P(`localStorage.removeItem('theme')`);
  }
});

test('theme: Automatic shows its A with a small raised ◐, and the other modes show no badge', async () => {
  await open();
  try {
    const look = () => P(`(() => {
      const b = document.getElementById('theme'), sup = b.querySelector('sup');
      if (!sup) return { sup: null };
      const a = document.createRange();
      a.selectNodeContents(b.firstChild);
      const ar = a.getBoundingClientRect(), sr = sup.getBoundingClientRect();
      return { sup: sup.textContent, supSize: parseFloat(getComputedStyle(sup).fontSize), aSize: parseFloat(getComputedStyle(b).fontSize),
        supMiddle: (sr.top + sr.bottom) / 2, aMiddle: (ar.top + ar.bottom) / 2 };
    })()`);
    const auto = await look();
    assert.equal(auto.sup, '\u25D0\uFE0E');
    assert.ok(auto.supSize < auto.aSize, `the ◐ is ${auto.supSize} px, the A ${auto.aSize} px`);
    assert.ok(auto.supMiddle < auto.aMiddle, `the ◐ is centred at ${auto.supMiddle}, the A's middle is at ${auto.aMiddle}`);
    await click('#theme');
    assert.deepEqual(await look(), { sup: null }, 'Light has no badge');
    await click('#theme');
    assert.deepEqual(await look(), { sup: null }, 'Dark has no badge');
  } finally {
    await P(`localStorage.removeItem('theme')`);
  }
});

// ---------- collapse, and the cheat sheet remembered ----------

const COLLAPSE = 'Collapse to just this bar', EXPAND = 'Expand to show the search boxes';
/**
 * The #collapse button as [what it holds, title, aria-label, aria-expanded, which way its triangle points], expanded and
 * collapsed. It holds one svg and no text; the triangle is drawn pointing up and turned half way round while collapsed.
 */
const COLLAPSE_BUTTON = ['svg, no text', COLLAPSE, COLLAPSE, 'true', 'up'], EXPAND_BUTTON = ['svg, no text', EXPAND, EXPAND, 'false', 'down'];
/**
 * What the popup shows: the #collapse button, what has focus, whatever outside the header takes up room, whether main
 * shows, the cheat-sheet panel's width (0 when it doesn't show) and the cheat sheet's own state, the document's and the
 * header's heights, the popup's and the header's widths, and how much wider the title is than its words.
 */
const shape = () => P(`(() => {
  const b = document.getElementById('collapse'), top = document.querySelector('.top'), panel = document.getElementById('cheatPanel');
  const toggle = document.getElementById('cheatToggle'), h1 = document.querySelector('.bar h1');
  const tenth = (n) => Math.round(n * 10) / 10;
  const shows = (el) => el.getClientRects().length > 0;
  const words = document.createRange();
  words.selectNodeContents(h1);
  return {
    button: [b.children.length === 1 && b.firstElementChild.localName === 'svg' && b.textContent === '' ? 'svg, no text' : 'other: ' + b.innerHTML,
      b.title, b.getAttribute('aria-label'), b.getAttribute('aria-expanded'),
      { 'none': 'up', 'matrix(-1, 0, 0, -1, 0, 0)': 'down' }[getComputedStyle(b.firstElementChild).transform] ?? getComputedStyle(b.firstElementChild).transform],
    focused: document.activeElement?.id ?? null,
    outside: [...document.body.querySelectorAll('*')].filter((el) => shows(el) && !top.contains(el) && !el.contains(top)).map((el) => el.id || el.localName),
    main: shows(document.querySelector('main')),
    panel: shows(panel) ? tenth(panel.getBoundingClientRect().width) : 0,
    cheat: [panel.hidden, toggle.getAttribute('aria-expanded'), toggle.textContent.replace(/[^A-Za-z ]/g, '').trim(), localStorage.getItem('cheatOpen')],
    heights: [tenth(document.documentElement.getBoundingClientRect().height), tenth(top.getBoundingClientRect().height)],
    widths: [tenth(document.body.getBoundingClientRect().width), tenth(top.getBoundingClientRect().width)],
    titleSpare: tenth(h1.getBoundingClientRect().width - words.getBoundingClientRect().width),
  };
})()`);
const CHEAT_OPEN = [false, 'true', 'Close regex cheat sheet', '1'], CHEAT_CLOSED = [true, 'false', 'Open regex cheat sheet', null];

test('collapse: only the bar and the messages under it show, and expanding brings back the cheat sheet only if it was open', async () => {
  await fresh();
  try {
    assert.deepEqual(await P(`(() => { const b = document.getElementById('collapse'); return [b.previousElementSibling.id, b.nextElementSibling.id]; })()`), ['next', 'theme']);
    await type('any', 'cheap');
    await eventually(count, '1 of 3');
    /** Collapse and expand again, clicking #collapse as it has focus; returns the shapes before and while collapsed. */
    const roundTrip = async () => {
      const expanded = await shape();
      assert.deepEqual([expanded.button, expanded.main], [COLLAPSE_BUTTON, true]);
      await P(`document.getElementById('collapse').focus()`);
      await click('#collapse');
      const collapsed = await shape();
      assert.deepEqual(collapsed.button, EXPAND_BUTTON);
      assert.equal(collapsed.focused, 'collapse');
      assert.deepEqual(collapsed.outside, [], 'only the header takes up room');
      assert.deepEqual([collapsed.main, collapsed.panel], [false, 0]);
      assert.equal(collapsed.heights[0], collapsed.heights[1], `the document is ${collapsed.heights[0]} px tall, the header ${collapsed.heights[1]} px`);
      assert.equal(collapsed.widths[0], collapsed.widths[1], 'the popup is as wide as the header');
      assert.ok(collapsed.titleSpare <= 0.5, `the header is ${collapsed.titleSpare} px wider than it needs`);
      assert.deepEqual(collapsed.cheat, expanded.cheat, 'collapsing leaves the cheat sheet as it was');
      assert.equal(await count(), '1 of 3');
      await click('#collapse');
      const back = await shape();
      assert.deepEqual(back.button, COLLAPSE_BUTTON);
      assert.equal(back.focused, 'collapse');
      assert.deepEqual([back.main, back.panel, back.cheat, back.widths, back.heights], [true, expanded.panel, expanded.cheat, expanded.widths, expanded.heights]);
      return [expanded, collapsed];
    };

    await click('#cheatToggle');
    const [withSheet, shrunk] = await roundTrip();
    assert.deepEqual(withSheet.cheat, CHEAT_OPEN);
    assert.ok(withSheet.panel > 0, 'the cheat sheet is open');
    assert.ok(shrunk.widths[0] < withSheet.widths[0], `the popup is ${shrunk.widths[0]} px wide collapsed and ${withSheet.widths[0]} px with the cheat sheet`);

    await click('#cheatClose');
    const [withoutSheet] = await roundTrip();
    assert.deepEqual([withoutSheet.cheat, withoutSheet.panel], [CHEAT_CLOSED, 0]);
  } finally {
    await forgetCheat();
  }
});

test('collapse: the triangle is about as big as the arrows beside it, and the button is the size of the other icon buttons', async () => {
  await fresh();
  const m = await P(`(() => {
    const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.width, r.height]; };
    const svg = document.querySelector('#collapse svg'), path = svg.querySelector('path');
    // The triangle's ink: the path's own box plus the stroke on both sides, in the drawing's scale.
    const scale = path.getScreenCTM().a;
    const triangle = path.getBoundingClientRect().height + parseFloat(getComputedStyle(path).strokeWidth) * scale;
    // The ↓ glyph's ink: its font's own measure of where it draws, not its line box.
    const next = document.getElementById('next'), cs = getComputedStyle(next);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const t = ctx.measureText(next.textContent.trim());
    return { triangle, arrow: t.actualBoundingBoxAscent + t.actualBoundingBoxDescent, collapse: box('collapse'), next: box('next'), prev: box('prev'), theme: box('theme') };
  })()`);
  assert.ok(m.arrow > 5, `the ↓ glyph's ink is ${m.arrow} px tall`);
  assert.ok(m.triangle >= 0.8 * m.arrow && m.triangle <= 1.2 * m.arrow, `the triangle is ${m.triangle} px tall, the ↓ glyph's ink ${m.arrow} px; it should be 0.8 to 1.2 times that`);
  assert.deepEqual([m.collapse, m.prev, m.theme], [m.next, m.next, m.next], '#collapse is the size of the other icon buttons');
});

test('collapse: the triangle is very dark grey in the light theme and soft light grey in the dark theme', async () => {
  await fresh();
  const colour = (theme) => P(`(() => { document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); return getComputedStyle(document.getElementById('collapse')).color; })()`);
  try {
    assert.equal(await colour('light'), 'rgb(72, 72, 74)');
    assert.equal(await colour('dark'), 'rgb(199, 199, 204)');
  } finally {
    await P(`document.documentElement.removeAttribute('data-theme')`);
  }
});

test('collapse: while collapsed the arrows, Clear, the theme, live updates and the messages under the bar keep working', async () => {
  await fresh();
  /** Where the current match starts, as the page sees it. */
  const match = () => run(`(() => { const r = [...CSS.highlights.get('text-find-plus-current') ?? []][0];
    return r ? [r.startContainer.parentElement.id || r.startContainer.parentElement.localName, r.startOffset, r.toString()] : null; })()`);
  try {
    await type('any', 'colo*r');
    await eventually(count, '1 of 5');
    const first = await match();
    await click('#collapse');
    assert.deepEqual((await shape()).button, EXPAND_BUTTON);
    await click('#next');
    await eventually(count, '2 of 5');
    assert.notDeepEqual(await match(), first, 'the current match moved');
    await click('#prev');
    await eventually(count, '1 of 5');
    assert.deepEqual(await match(), first);

    await run(`__live.add('colour')`);
    await eventually(count, '1 of 6', 1500);

    await click('#theme');
    assert.equal(await P(`document.documentElement.getAttribute('data-theme')`), 'light');
    await click('#theme');
    await click('#theme');
    assert.equal(await P(`document.documentElement.getAttribute('data-theme')`), null);

    await click('#clear');
    assert.deepEqual(await boxes(), ['', '', '']);
    await eventually(count, '');
    await eventually(hl, 0);
    assert.deepEqual((await shape()).button, EXPAND_BUTTON, 'Clear leaves the popup collapsed');

    await click('#collapse');
    await type('regex', '(abc');
    await eventually(async () => (await text('messages')).includes('A ( is missing its closing )'), true);
    await click('#collapse');
    const collapsed = await shape();
    assert.deepEqual([collapsed.button, collapsed.outside, collapsed.heights[0]], [EXPAND_BUTTON, [], collapsed.heights[1]]);
    assert.equal(await P(`(() => { const m = document.getElementById('messages').getBoundingClientRect();
      return m.height > 0 && m.bottom <= document.documentElement.getBoundingClientRect().bottom; })()`), true, 'the message shows under the bar');
    assert.ok((await text('messages')).includes('A ( is missing its closing )'));
  } finally {
    await run('__live.reset()');
    await P(`localStorage.removeItem('theme')`);
  }
});

test('collapse: a popup closed while collapsed opens expanded, with the cursor in the Any box', async () => {
  await fresh();
  await type('any', 'cheap');
  await eventually(count, '1 of 3');
  await click('#collapse');
  assert.deepEqual((await shape()).button, EXPAND_BUTTON);
  const popupTarget = popup.targetId;
  await click('#close'); // Close works while collapsed
  popup = null;
  await eventually(hl, 0, 1000);
  await eventually(async () => (await browser.send('Target.getTargets')).targetInfos.some((t) => t.targetId === popupTarget), false);
  await open();
  const reopened = await shape();
  assert.deepEqual([reopened.button, reopened.main, reopened.focused], [COLLAPSE_BUTTON, true, 'any']);
  assert.equal(await P(`document.body.classList.contains('collapsed')`), false);
  await eventually(count, '1 of 3'); // and the search comes back
});

test('cheat sheet: whether it was open is remembered when the popup reopens', async () => {
  await fresh();
  const cheat = () => shape().then((s) => [...s.cheat, s.panel]);
  const reopen = async () => { await closePopup(); await open(); };
  try {
    assert.deepEqual(await cheat(), [...CHEAT_CLOSED, 0]);
    await click('#cheatToggle');
    const opened = await cheat();
    assert.deepEqual(opened.slice(0, 4), CHEAT_OPEN);
    await reopen();
    assert.deepEqual(await cheat(), opened, 'it opens again, as wide as before');

    await click('#cheatClose');
    assert.deepEqual(await cheat(), [...CHEAT_CLOSED, 0]);
    await reopen();
    assert.deepEqual(await cheat(), [...CHEAT_CLOSED, 0]);

    await click('#cheatToggle');
    await click('#cheatToggle'); // closed with the toggle this time
    assert.deepEqual(await cheat(), [...CHEAT_CLOSED, 0]);
    await reopen();
    assert.deepEqual(await cheat(), [...CHEAT_CLOSED, 0]);

    await P(`localStorage.setItem('cheatOpen', 'blue')`);
    await reopen();
    assert.deepEqual(await cheat(), [true, 'false', 'Open regex cheat sheet', 'blue', 0], 'a value nobody recognises reads as closed');
  } finally {
    if (popup) await forgetCheat();
  }
});

test('cheat sheet: opening it from memory is not the user acting, so a remembered search still fills the form', async () => {
  await fresh();
  try {
    await click('#cheatToggle');
    await type('any', 'cheap');
    await eventually(count, '1 of 3');
    await closePopup();
    await open();
    assert.deepEqual((await shape()).cheat, CHEAT_OPEN);
    await eventually(() => value('any'), 'cheap');
    await eventually(count, '1 of 3');
    await eventually(hl, 3);
  } finally {
    if (popup) await forgetCheat();
  }
});

test('cheat sheet: with storage refused, the popup still searches and the cheat sheet still opens and closes', async () => {
  await open();
  try {
    // Reload the popup with localStorage throwing from the first line of the document, as Chrome does when site data is blocked.
    await popup.session.send('Page.enable');
    await popup.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } })`,
    });
    const loaded = browser.waitForEvent('Page.loadEventFired', (_, sid) => sid === popup.session.id, 10000);
    await popup.session.send('Page.reload');
    await loaded;
    await eventually(() => P('document.body.dataset.state || ""'), 'ready');
    const cheat = () => P(`[document.getElementById('cheatPanel').hidden, document.getElementById('cheatToggle').getAttribute('aria-expanded')]`);
    assert.deepEqual(await cheat(), [true, 'false']);
    await type('any', 'cheap');
    await eventually(count, '1 of 3');
    await click('#cheatToggle');
    assert.deepEqual(await cheat(), [false, 'true']);
    await click('#cheatClose');
    assert.deepEqual(await cheat(), [true, 'false']);
  } finally {
    await closePopup(); // the injected script belongs to this popup's session and goes with it
  }
});

test('restricted page: a cheat sheet left open stays closed there and is still remembered, and the bar still collapses', async () => {
  await open();
  await P(`localStorage.setItem('cheatOpen', '1')`);
  await closePopup();
  const restricted = await openPage(browser, 'chrome://version');
  try {
    await open(restricted);
    assert.equal(await P('document.body.dataset.state'), 'cant-search');
    assert.deepEqual((await shape()).cheat, [true, 'false', 'Open regex cheat sheet', '1']);
    await click('#collapse');
    const collapsed = await shape();
    assert.deepEqual([collapsed.button, collapsed.main, collapsed.outside], [EXPAND_BUTTON, false, []]);
    await click('#collapse');
    const expanded = await shape();
    assert.deepEqual([expanded.button, expanded.main], [COLLAPSE_BUTTON, true]);
    assert.equal(await P(`document.getElementById('cantSearch').getClientRects().length > 0`), true);
  } finally {
    if (popup) await forgetCheat();
    await closePopup();
    await browser.send('Target.closeTarget', { targetId: restricted.targetId });
  }
});

// ---------- the Regex box greys out the boxes it overrides ----------

const IGNORED_TITLE = 'Ignored while the Regex box has text. Empty the Regex box to use it again.';
/** An expression for [disabled, title] of the Any box, the All box and "in this order". */
const IGNORED_STATE = `['any', 'all', 'ordered'].map((id) => { const el = document.getElementById(id); return [el.disabled, el.getAttribute('title')]; })`;
const IGNORED = Array(3).fill([true, IGNORED_TITLE]), IN_EFFECT = Array(3).fill([false, null]);
const ignoredState = () => P(IGNORED_STATE);
/** Run `action` in the popup and read the three controls in the same task, before any timer (the search's debounce too) can run. */
const ignoredRightAfter = (action) => P(`(() => { ${action}; return ${IGNORED_STATE}; })()`);
const EMPTY_REGEX = `const r = document.getElementById('regex'); r.value = ''; r.dispatchEvent(new Event('input', { bubbles: true }))`;
const tipLabel = () => P(`document.querySelector('#messages .tip button')?.textContent ?? ''`);

test('regex greys out: typing in the Regex box disables Any, All and "in this order" at once; emptying it brings them back as they were', async () => {
  await fresh();
  await type('any', 'cheap');
  await type('all', 'flight');
  await tick('ordered');
  assert.deepEqual(await ignoredState(), IN_EFFECT);
  // A listener added after the popup's own reads them while the typed character's input event is still being handled.
  await P(`document.getElementById('regex').addEventListener('input', () => { window.__seen = ${IGNORED_STATE}; }, { once: true })`);
  await type('regex', 'fl.ght');
  assert.deepEqual(await P('window.__seen'), IGNORED);
  await eventually(count, '1 of 5');
  assert.deepEqual(await ignoredState(), IGNORED);
  assert.deepEqual(await P(`['matchCase', 'wholeWords', 'regex'].map((id) => document.getElementById(id).disabled)`), [false, false, false]);
  await key('Enter'); // still moves on from the Regex box
  await eventually(count, '2 of 5');

  assert.deepEqual(await ignoredRightAfter(EMPTY_REGEX), IN_EFFECT);
  assert.deepEqual(await P(`[document.getElementById('any').value, document.getElementById('all').value, document.getElementById('ordered').checked]`), ['cheap', 'flight', true]);
});

test('regex greys out: a Regex box holding only spaces disables nothing', async () => {
  await fresh();
  await type('any', 'cheap');
  await type('regex', '   ');
  assert.deepEqual(await ignoredState(), IN_EFFECT);
  await sleep(300);
  assert.equal(await count(), '1 of 3', 'the Any box is still the search');
  assert.deepEqual(await ignoredState(), IN_EFFECT);
});

test('regex greys out: a cheat-sheet example, and a symbol put into an empty Regex box, grey the boxes out at once', async () => {
  await fresh();
  try {
    await click('#cheatToggle');
    assert.deepEqual(await ignoredRightAfter(`[...document.querySelectorAll('#cheatPanel .example')].find((b) => b.textContent.includes('color or colour')).click()`), IGNORED);
    assert.equal(await value('regex'), 'colou?r');
    assert.deepEqual(await ignoredRightAfter(EMPTY_REGEX), IN_EFFECT);
    assert.deepEqual(await ignoredRightAfter(`document.querySelector('#cheatPanel .tok[data-ins="."]').click()`), IGNORED);
    assert.equal(await value('regex'), '.');
  } finally {
    await forgetCheat();
  }
});

test('regex greys out: the "Try …" tip greys the boxes out at once', async () => {
  await fresh();
  await type('any', 'cheap');
  await type('regex', 'st*n');
  await eventually(tipLabel, 'Try st\\w*n');
  assert.deepEqual(await ignoredState(), IGNORED);
  // The tip shows only while the Regex box has text, so the boxes are greyed out already. Emptying the box and clicking
  // the tip before the search that would take it away shows the tip itself greying them out.
  const seen = await P(`(() => {
    ${EMPTY_REGEX};
    const between = ${IGNORED_STATE};
    document.querySelector('#messages .tip button').click();
    return [between, ${IGNORED_STATE}];
  })()`);
  assert.deepEqual(seen, [IN_EFFECT, IGNORED]);
  assert.equal(await value('regex'), 'st\\w*n');
  await eventually(count, '1 of 2');
});

test('regex greys out: "Move it to the Regex box" greys the boxes out at once', async () => {
  await fresh();
  await type('all', 'flight');
  await type('any', '\\d+');
  await eventually(tipLabel, 'Move it to the Regex box');
  assert.deepEqual(await ignoredState(), IN_EFFECT);
  assert.deepEqual(await ignoredRightAfter(`document.querySelector('#messages .tip button').click()`), IGNORED);
  assert.deepEqual(await boxes(), ['', 'flight', '\\d+']);
  await eventually(count, '1 of 13');
});

test('regex greys out: Clear brings the boxes back at once, with the cursor in the Any box', async () => {
  await fresh();
  await type('any', 'cheap');
  await type('regex', 'fl.ght');
  assert.deepEqual(await ignoredState(), IGNORED);
  assert.deepEqual(await ignoredRightAfter(`document.getElementById('clear').click()`), IN_EFFECT);
  assert.equal(await P('document.activeElement?.id'), 'any');
  assert.deepEqual(await boxes(), ['', '', '']);
});

test('regex greys out: a remembered search with Regex text greys the boxes out when the popup reopens, and the cursor moves to the Regex box', async () => {
  await fresh();
  await type('any', 'cheap');
  await type('regex', 'fl.ght');
  await eventually(count, '1 of 5'); // the page remembers it
  await closePopup();
  await open();
  await eventually(boxes, ['cheap', '', 'fl.ght']);
  assert.deepEqual(await ignoredState(), IGNORED);
  assert.equal(await P('document.activeElement?.id'), 'regex', 'the cursor the popup put in the Any box moves to the Regex box');
  await eventually(count, '1 of 5');
});

test('regex greys out: the Any and All cards are dimmed whole, as a disabled box is, and nothing is dimmed twice', async () => {
  await fresh();
  /** How opaque each part shows: its own opacity times its ancestors'. */
  const shown = () => P(`(() => {
    const seen = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return Math.round(o * 1000) / 1000; };
    const $ = (id) => document.getElementById(id), any = $('any').closest('.card'), all = $('all').closest('.card');
    return {
      overridden: [any.querySelector('.head'), $('any'), any.querySelector('.desc'),
        all.querySelector('.head'), $('ordered').closest('label'), $('ordered'), $('all'), $('allDesc')].map(seen),
      rest: ['regex', 'cheatToggle', 'matchCase', 'wholeWords'].map((id) => seen($(id))),
    };
  })()`);
  assert.deepEqual(await shown(), { overridden: Array(8).fill(1), rest: Array(4).fill(1) });
  await type('regex', 'fl.ght');
  assert.deepEqual(await shown(), { overridden: Array(8).fill(0.5), rest: Array(4).fill(1) });
  await type('regex', '');
  assert.deepEqual(await shown(), { overridden: Array(8).fill(1), rest: Array(4).fill(1) });
});

test('regex greys out: the Regex label says the Any and All boxes are ignored until it is empty', async () => {
  await fresh();
  assert.equal(await P(`document.querySelector('label[for="regex"]').textContent`), 'Regex (advanced; Any and All are ignored until this Regex box is empty)');
});

test('regex greys out: the "in this order" label shows the pointer only while it can be ticked', async () => {
  await fresh();
  const cursor = () => P(`getComputedStyle(document.getElementById('ordered').closest('label')).cursor`);
  assert.equal(await cursor(), 'pointer');
  await type('regex', 'fl.ght');
  assert.equal(await cursor(), 'default');
  await type('regex', '');
  assert.equal(await cursor(), 'pointer');
});

test('regex greys out: on a page Text Find+ can\'t search, nothing the Regex box does enables a control', async () => {
  await closePopup();
  const restricted = await openPage(browser, 'chrome://version');
  try {
    await open(restricted);
    assert.equal(await P('document.body.dataset.state'), 'cant-search');
    // There the Regex box, Clear and the cheat sheet are disabled, so nothing a user does can change the Regex box:
    // its input event is sent directly instead.
    const enabledAfter = (regex) => P(`(() => {
      const r = document.getElementById('regex'); r.value = ${JSON.stringify(regex)}; r.dispatchEvent(new Event('input', { bubbles: true }));
      return [...document.querySelectorAll('main input, main button, #prev, #next, #clear')].filter((el) => !el.disabled).map((el) => el.id);
    })()`);
    assert.deepEqual(await enabledAfter('fl.ght'), []);
    assert.deepEqual(await enabledAfter(''), []);
  } finally {
    await closePopup();
    await browser.send('Target.closeTarget', { targetId: restricted.targetId });
  }
});

// ---------- the arrows grey out while there is nothing to move to, as in Chrome's own find bar ----------

/** An expression for what the bar shows: the count, and whether ↑ and ↓ are disabled, read together. */
const BAR = `['count', 'prev', 'next'].map((id, i) => (i ? document.getElementById(id).disabled : document.getElementById(id).textContent))`;
const bar = () => P(BAR);
/** The bar showing `label` with both arrows greyed out, or with both enabled. */
const greyed = (label) => [label, true, true], enabled = (label) => [label, false, false];
/** Click Clear and read the bar in the same task, before anything else can run. */
const barRightAfterClear = () => P(`(() => { document.getElementById('clear').click(); return ${BAR}; })()`);

test('arrows grey out: while the boxes are empty, nothing matches, the regex is invalid and after Clear; enabled by any match, a remembered one too', async () => {
  await fresh();
  await closePopup();
  await open(); // nothing is remembered, and nothing has been done in this popup
  assert.deepEqual([await bar(), await boxes()], [greyed(''), ['', '', '']]);

  await type('any', 'cheap');
  await eventually(bar, enabled('1 of 3'));
  await click('#next');
  await eventually(bar, enabled('2 of 3'));
  await type('any', 'zebra');
  await eventually(bar, greyed('No matches'));
  await type('any', 'cheap');
  await eventually(bar, enabled('1 of 3'));
  await type('any', '');
  await eventually(bar, greyed(''));

  await type('any', 'cheap');
  await eventually(bar, enabled('1 of 3'));
  await type('regex', '(abc');
  await eventually(async () => (await text('messages')).includes('A ( is missing its closing )'), true);
  assert.deepEqual(await bar(), greyed(''));
  await type('regex', '');
  await eventually(bar, enabled('1 of 3'));

  await closePopup();
  await open(); // the page remembers "cheap"
  await eventually(bar, enabled('1 of 3'));
  assert.deepEqual(await barRightAfterClear(), greyed(''));
});

test('arrows grey out: a match the page adds enables them, and taking it away greys them out again', async () => {
  await fresh();
  try {
    await type('any', 'beacon');
    await eventually(bar, greyed('No matches'));
    await run(`__live.add('beacon')`);
    await eventually(bar, enabled('1 of 1'), 1500); // one match is enough: the arrows wrap around onto it
    await run('__live.reset()');
    await eventually(bar, greyed('No matches'), 1500);
  } finally {
    await run('__live.reset()');
  }
});

test('arrows grey out: the same while the popup is collapsed', async () => {
  await fresh();
  try {
    await type('any', 'beacon');
    await eventually(bar, greyed('No matches'));
    await click('#collapse');
    assert.deepEqual((await shape()).button, EXPAND_BUTTON);
    assert.deepEqual(await bar(), greyed('No matches'));
    await run(`__live.add('beacon'); __live.add('beacon')`);
    await eventually(bar, enabled('1 of 2'), 1500);
    await click('#next');
    await eventually(bar, enabled('2 of 2'));
    assert.deepEqual(await barRightAfterClear(), greyed(''));
    assert.deepEqual((await shape()).button, EXPAND_BUTTON, 'Clear leaves the popup collapsed');
  } finally {
    await run('__live.reset()');
  }
});

test('arrows grey out: dimmed as a disabled box is, with the arrow pointer and no hover effect; nothing else about them changes', async () => {
  await fresh();
  /** Each arrow's opacity, cursor and filter, and the rest of its look. */
  const look = () => P(`['prev', 'next'].map((id) => { const cs = getComputedStyle(document.getElementById(id));
    return [[cs.opacity, cs.cursor, cs.filter], [cs.color, cs.backgroundColor, cs.borderTopColor, cs.fontWeight, cs.width, cs.height]]; })`);
  /** Move the mouse off the bar, then onto the middle of ↓, and wait until the popup sees it there. */
  const hoverNext = async () => {
    const [x, y] = await P(`(() => { const r = document.getElementById('next').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    for (const [mx, my] of [[0, 0], [x, y]]) await popup.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my });
    await eventually(() => P(`document.getElementById('next').matches(':hover')`), true);
  };

  await hoverNext();
  assert.deepEqual(await bar(), greyed(''));
  const off = await look();
  assert.deepEqual(off.map(([state]) => state), [['0.5', 'default', 'none'], ['0.5', 'default', 'none']]);
  assert.equal(await P(`(() => { const any = document.getElementById('any'); any.disabled = true; const o = getComputedStyle(any).opacity; any.disabled = false; return o; })()`), '0.5', 'as dimmed as a disabled box');

  await type('any', 'cheap');
  await eventually(bar, enabled('1 of 3'));
  await hoverNext();
  const on = await look();
  assert.deepEqual(on.map(([state]) => state), [['1', 'pointer', 'none'], ['1', 'pointer', 'brightness(0.96)']]);
  assert.deepEqual(on.map(([, rest]) => rest), off.map(([, rest]) => rest));
});
