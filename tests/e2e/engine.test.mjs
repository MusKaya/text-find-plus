// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Engine tests: highlighter.js evaluated in tests/test.html (main world, so the port layer is skipped).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/server.mjs';
import { test, before, after } from './lib/test.mjs';
import { launch, openPage } from './lib/chrome.mjs';
import { PINNED, drawn as drawnIn } from './lib/drawn.mjs';
import { compileQuery } from '../../src/popup/query.js';

const here = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(here, '..', '..', 'src', 'content', 'highlighter.js'), 'utf8');
const form = (over = {}) => ({ any: '', all: '', ordered: false, regex: '', matchCase: false, wholeWords: false, ...over });
const queryOf = (over) => JSON.stringify(compileQuery(form(over)).query);

let server, browser, page;
const run = (expr) => page.session.evaluate(expr);
const search = (over) => run(`__textFindPlusEngine.search(${queryOf(over)})`);
const count = async (over) => (await search(over)).count;

before(async () => {
  server = await serve(join(here, '..'));
  browser = await launch();
  page = await openPage(browser, `${server.origin}/test.html`);
  await run(engineSource);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('plain words', async () => {
  assert.equal(await count({ any: 'cheap' }), 3);
  assert.equal(await count({ any: 'flight' }), 5);
  assert.equal(await count({ any: '"cheap flight"' }), 2);
  assert.equal(await count({ any: 'colo*r' }), 5);
});

test('exclusions', async () => {
  // display:none, visibility:hidden, [hidden], textarea, input, noscript, style, script, template, select
  assert.equal(await count({ any: 'zebra' }), 0);
});

test('phrases cross inline tags and br, never blocks', async () => {
  assert.equal(await count({ any: '"quick brown"' }), 1);
  assert.equal(await count({ any: '"jumps. Line"' }), 1);
  assert.equal(await count({ regex: 'theme\\W*Pick' }), 0);
});

test('whole words and case', async () => {
  assert.equal(await count({ any: 'run' }), 4);
  assert.equal(await count({ any: 'run', wholeWords: true }), 1);
  assert.equal(await count({ any: 'Cheap', matchCase: true }), 1);
  assert.equal(await count({ any: 'istanbul' }), 2);
});

test('regex', async () => {
  assert.equal(await count({ regex: '\\d{3}-\\d{4}' }), 2);
  assert.equal(await count({ regex: '(cheap|deals) (flight|page)' }), 3);
});

test('all words', async () => {
  const both = await search({ all: 'istanbul, çiçek' });
  assert.equal(both.count, 4);
  assert.deepEqual(both.termCounts, [2, 2]);
  assert.deepEqual((await search({ all: 'cheap zebra' })).termCounts, [3, 0]);
});

test('in-order sequences', async () => {
  const seq = await search({ all: 'flight cheap', ordered: true });
  assert.equal(seq.count, 2);
  assert.deepEqual(await run('__textFindPlusEngine._lastMatches[0]'), ['Flight', 'cheap']);
  const never = await search({ all: 'fox colour', ordered: true });
  assert.equal(never.count, 0);
  assert.deepEqual(never.termCounts, [1, 3]);
});

test('any + all', async () => {
  const r = await search({ any: 'istanbul', all: 'cheap flight' });
  assert.equal(r.count, 10);
  assert.equal(r.anyCount, 2);
});

test('zero-length patterns return 0 and terminate', async () => {
  for (const regex of ['\\b', '(?=a)', '^']) {
    const started = Date.now();
    assert.equal(await count({ regex }), 0, regex);
    assert.ok(Date.now() - started < 1000, `${regex} took too long`);
  }
});

test('cap', async () => {
  await run(`(() => { const d = document.createElement('div'); d.id = 'cap'; d.textContent = 'a '.repeat(6000); document.body.append(d); })()`);
  try {
    const r = await search({ any: 'a', wholeWords: true });
    assert.equal(r.count, 5000);
    assert.equal(r.capped, true);
  } finally {
    await run(`document.getElementById('cap').remove()`);
  }
});

test('time guard', async () => {
  const r = await run(`(() => {
    let t = 0;
    const engine = __textFindPlusEngine.createEngine(document, { timeBudgetMs: 0, now: () => t++ });
    return engine.search(${queryOf({ any: 'flight' })});
  })()`);
  assert.equal(r.timedOut, true);
  assert.ok(r.count < 5, `count ${r.count}`);
});

test('performance', async () => {
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
    const ms = await run(`(() => { const t = performance.now(); __textFindPlusEngine.search(${queryOf({ any: 'flight' })}); return performance.now() - t; })()`);
    console.log(`# performance: ~1 MB page searched in ${ms.toFixed(1)} ms`);
    assert.ok(ms < 300, `took ${ms} ms`);
  } finally {
    await run(`document.getElementById('perf').remove()`);
  }
});

const highlightSize = (name) => run(`CSS.highlights.get(${JSON.stringify(name)})?.size ?? 0`);

test('show paints and current is separate', async () => {
  await search({ any: 'cheap' });
  await run('__textFindPlusEngine.show(1, 5000)');
  assert.equal(await highlightSize('text-find-plus-match'), 3);
  assert.equal(await highlightSize('text-find-plus-current'), 1);
  assert.equal(await run(`CSS.highlights.get('text-find-plus-current').priority`), 1);
  await run('__textFindPlusEngine.show(-1, 0)');
  assert.equal(await highlightSize('text-find-plus-match'), 0);
  assert.equal(await highlightSize('text-find-plus-current'), 0);
});

test('limit caps painting', async () => {
  await search({ any: 'cheap' });
  await run('__textFindPlusEngine.show(0, 2)');
  assert.equal(await highlightSize('text-find-plus-match'), 2);
});

test('scrolls current into view', async () => {
  await run(`(() => { const s = document.createElement('div'); s.id = 'spacer'; s.style.height = '3000px';
    document.getElementById('p-split').before(s); scrollTo(0, 0); })()`);
  try {
    await search({ any: 'quick' });
    await run('__textFindPlusEngine.show(0, 5000)');
    const inView = await run(`(() => { const r = [...CSS.highlights.get('text-find-plus-current')][0].getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight; })()`);
    assert.equal(inView, true);
  } finally {
    await run(`document.getElementById('spacer').remove(); scrollTo(0, 0)`);
  }
});

test('clear forgets only when asked', async () => {
  await run(`__textFindPlusEngine.search(${queryOf({ any: 'cheap' })}, { any: 'cheap' })`);
  await run('__textFindPlusEngine.show(1, 5000)');
  await run('__textFindPlusEngine.clear(false)');
  assert.equal(await highlightSize('text-find-plus-match'), 0);
  assert.equal(await highlightSize('text-find-plus-current'), 0);
  assert.deepEqual(await run('__textFindPlusEngine.remembered()'), { form: { any: 'cheap' }, current: 1 });
  await run('__textFindPlusEngine.clear(true)');
  assert.equal(await run('__textFindPlusEngine.remembered()'), null);
});

test('show survives removed nodes', async () => {
  await search({ any: 'cheap' });
  await run(`(() => { const el = document.getElementById('p-deals'); globalThis.__restore = [el, el.nextSibling]; el.remove(); })()`);
  try {
    await run('__textFindPlusEngine.show(2, 5000)');
    await run('__textFindPlusEngine.show(0, 5000)');
  } finally {
    await run(`(() => { const [el, next] = globalThis.__restore; next.parentNode.insertBefore(el, next); })()`);
  }
});

test('double injection is harmless', async () => {
  await run('globalThis.__previousEngine = __textFindPlusEngine');
  await run(engineSource);
  assert.equal(await run('__previousEngine === __textFindPlusEngine'), true);
});

test('text collection stays within the time budget', async () => {
  await run(`(() => { const box = document.createElement('div'); box.id = 'many';
    for (let i = 0; i < 2000; i++) { const p = document.createElement('p'); p.textContent = 'needle'; box.append(p); }
    document.body.append(box); })()`);
  try {
    const r = await run(`(() => {
      let t = 0;
      const engine = __textFindPlusEngine.createEngine(document, { timeBudgetMs: 2, now: () => t++ });
      return engine.search(${queryOf({ any: 'needle' })});
    })()`);
    assert.equal(r.timedOut, true);
    assert.ok(r.count > 0 && r.count < 2000, `partial results expected, got ${r.count}`);
  } finally {
    await run(`document.getElementById('many').remove()`);
  }
});

// ---------- web components (spec §4) ----------

test('web components: open ones are read in display order, hidden and undisplayed text is not', async () => {
  // The closed component is not among them: a page can't read a closed root, and the extension skips one (its test checks that).
  await search({ regex: '\\w+ lantern' });
  assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['open lantern'], ['nested lantern'], ['slotted lantern'], ['fallback lantern']]);
});

test('a phrase crosses into a web component: one match, two ranges', async () => {
  assert.equal(await count({ any: '"Hello World"' }), 1);
  assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['Hello ', 'World']]);
  await run('__textFindPlusEngine.show(0, 5000)');
  assert.equal(await highlightSize('text-find-plus-match'), 2);
});

test('slotted text takes its visibility from where it is shown', async () => {
  assert.equal(await count({ any: 'ghost' }), 0);
});

test('text inside a display: contents wrapper is found', async () => {
  assert.equal(await count({ any: 'compass' }), 1);
});

test('named slots are read in the order they show their content', async () => {
  await run(`(() => { const host = document.createElement('div'); host.id = 'reorder';
    for (const [slot, word] of [['b', 'omega'], ['a', 'alpha']]) { const s = document.createElement('span'); s.slot = slot; s.textContent = word; host.append(s); }
    host.attachShadow({ mode: 'open' }).innerHTML = '<slot name="a"></slot><slot name="b"></slot>';
    document.body.append(host); })()`);
  try {
    assert.equal(await count({ regex: 'alphaomega' }), 1);
    // "omega" comes first in the document, so the match needs a range for each word.
    assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['alpha', 'omega']]);
  } finally {
    await run(`document.getElementById('reorder').remove()`);
  }
});

test('text whose parent hides its content is not found, display: contents wrappers included', async () => {
  // A closed <details> shows only its <summary>; hidden="until-found" is content-visibility: hidden.
  await run(`(() => { const box = document.createElement('div'); box.id = 'hides';
    box.innerHTML = '<details><summary>sepiatone</summary><div style="display:contents">cinnabar</div>verdigris</details>'
      + '<details open><summary>heading</summary><div style="display:contents">ochreous</div>madderlake</details>'
      + '<div hidden="until-found"><div style="display:contents">umbermist</div>carmine</div>';
    document.body.append(box); })()`);
  try {
    assert.equal(await count({ any: 'cinnabar' }), 0); // wrapper in a closed details
    assert.equal(await count({ any: 'verdigris' }), 0); // bare text in a closed details
    assert.equal(await count({ any: 'umbermist' }), 0); // wrapper under hidden="until-found"
    assert.equal(await count({ any: 'carmine' }), 0); // bare text under hidden="until-found"
    assert.equal(await count({ any: 'sepiatone' }), 1); // the closed details' summary
    assert.equal(await count({ any: 'ochreous' }), 1); // wrapper in an open details
    assert.equal(await count({ any: 'madderlake' }), 1); // bare text in an open details
  } finally {
    await run(`document.getElementById('hides').remove()`);
  }
});

const drawn = (words) => drawnIn(page.session, words);

test('content-visibility hides nothing on a display: contents element, so the text inside one is found', async () => {
  // display: contents gives an element no box for content-visibility to apply to, so Chrome draws what is inside it.
  // hidden="until-found" is content-visibility: hidden. The last box has a box of its own: the control.
  await run(`(() => { const box = document.createElement('div'); box.id = 'cv-contents'; box.style.cssText = ${JSON.stringify(PINNED)};
    box.innerHTML = '<div><div style="display:contents;content-visibility:hidden">saffronite<span style="display:contents">sorrelwood</span></div></div>'
      + '<div><div hidden="until-found" style="display:contents">tamarisk</div></div>'
      + '<div><div style="content-visibility:hidden">ultramarine</div></div>';
    document.body.append(box); })()`);
  try {
    assert.deepEqual(await drawn(['saffronite', 'sorrelwood', 'tamarisk', 'ultramarine']),
      { saffronite: true, sorrelwood: true, tamarisk: true, ultramarine: false });
    assert.equal(await count({ any: 'saffronite' }), 1); // bare text
    assert.equal(await count({ any: 'sorrelwood' }), 1); // inside a display: contents wrapper
    assert.equal(await count({ any: 'tamarisk' }), 1); // hidden="until-found" on a display: contents element
    assert.equal(await count({ any: 'ultramarine' }), 0);
  } finally {
    await run(`document.getElementById('cv-contents').remove()`);
  }
});

test('content-visibility hides only where Chrome applies it, and a table caption or column hides what Chrome hides', async () => {
  // Chrome ignores content-visibility on an inline element, an inline list item, a ruby and its annotation, a table, an
  // inline table, and a table's rows and row groups (as on display: contents), and draws what is inside; on an
  // inline-block and a table cell it applies.
  // In a caption it hides, yet checkVisibility() calls the element inside visible. A table column draws nothing inside
  // it, with or without content-visibility.
  await run(`(() => { const box = document.createElement('div'); box.id = 'cv-boxes'; box.style.cssText = ${JSON.stringify(PINNED)};
    box.innerHTML = '<p>aa <span style="content-visibility:hidden">bergamot</span> bb</p>'
      + '<p>cc <span hidden="until-found">cardamom</span> dd</p>'
      + '<div style="display:table"><div style="display:table-row;content-visibility:hidden">juniper</div></div>'
      + '<p>ee <span style="display:inline-block;content-visibility:hidden">fennelseed</span> ff</p>'
      + '<table><caption hidden="until-found">galangal<i>hyssop</i></caption><tbody><tr><td>cell</td></tr></tbody></table>'
      + '<div style="display:table"><div style="display:table-column">lovage</div><div style="display:table-row"><div style="display:table-cell">cell</div></div></div>'
      + '<table><tbody><tr><td hidden="until-found">marjoram</td><td>cell</td></tr></tbody></table>'
      + '<p>gg <span style="display:inline-table;content-visibility:hidden">nutmeg</span> hh</p>'
      + '<p>ii <ruby>base<rt style="content-visibility:hidden">oregano</rt></ruby> jj</p>'
      + '<table style="content-visibility:hidden"><tbody><tr><td>paprika</td></tr></tbody></table>'
      + '<p>kk <span style="display:inline list-item;content-visibility:hidden">angelica</span> ll</p>'
      + '<p>mm <ruby style="content-visibility:hidden">caraway<rt>x</rt></ruby> nn</p>'
      + '<table><tbody style="content-visibility:hidden"><tr><td>chicory</td></tr></tbody></table>'
      + '<table><thead style="content-visibility:hidden"><tr><td>chamomile</td></tr></thead></table>'
      + '<table><tfoot style="content-visibility:hidden"><tr><td>sassafras</td></tr></tfoot></table>';
    document.body.append(box); })()`);
  try {
    assert.deepEqual(await drawn(['bergamot', 'cardamom', 'juniper', 'fennelseed', 'galangal', 'hyssop', 'lovage', 'marjoram', 'nutmeg', 'oregano', 'paprika',
      'angelica', 'caraway', 'chicory', 'chamomile', 'sassafras']),
    { bergamot: true, cardamom: true, juniper: true, fennelseed: false, galangal: false, hyssop: false, lovage: false,
      marjoram: false, nutmeg: true, oregano: true, paprika: true, angelica: true, caraway: true, chicory: true, chamomile: true, sassafras: true });
    assert.equal(await run(`document.querySelector('#cv-boxes i').checkVisibility()`), true, 'Chrome calls the hidden caption\'s <i> visible');
    assert.equal(await count({ any: 'bergamot' }), 1); // inline
    assert.equal(await count({ any: 'cardamom' }), 1); // hidden="until-found" on an inline element
    assert.equal(await count({ any: 'juniper' }), 1); // a table row
    assert.equal(await count({ any: 'fennelseed' }), 0); // inline-block: content-visibility applies
    assert.equal(await count({ any: 'galangal' }), 0); // a caption's own text
    assert.equal(await count({ any: 'hyssop' }), 0); // an element in a caption
    assert.equal(await count({ any: 'lovage' }), 0); // a table column
    assert.equal(await count({ any: 'marjoram' }), 0); // hidden="until-found" on a table cell: content-visibility applies
    assert.equal(await count({ any: 'nutmeg' }), 1); // an inline table
    assert.equal(await count({ any: 'oregano' }), 1); // a ruby annotation (<rt>)
    assert.equal(await count({ any: 'paprika' }), 1); // a table, its text in a cell
    assert.equal(await count({ any: 'angelica' }), 1); // an inline list item
    assert.equal(await count({ any: 'caraway' }), 1); // a <ruby>, its base text
    assert.equal(await count({ any: 'chicory' }), 1); // a <tbody>
    assert.equal(await count({ any: 'chamomile' }), 1); // a <thead>
    assert.equal(await count({ any: 'sassafras' }), 1); // a <tfoot>
  } finally {
    await run(`document.getElementById('cv-boxes').remove()`);
  }
});

test('an element named slot outside HTML is walked like any other element', async () => {
  // Inside <math>, the parser makes <slot> a MathML element, which has no assignedNodes().
  await run(`(() => { const host = document.createElement('div'); host.id = 'foreign-slot'; host.style.cssText = ${JSON.stringify(PINNED)};
    host.attachShadow({ mode: 'open' }).innerHTML = '<p>pre <math><slot><mi>chervil</mi></slot></math></p>';
    document.body.append(host); })()`);
  try {
    assert.equal(await run(`document.getElementById('foreign-slot').shadowRoot.querySelector('slot').namespaceURI`),
      'http://www.w3.org/1998/Math/MathML');
    assert.deepEqual(await drawn(['chervil']), { chervil: true });
    assert.equal(await count({ any: 'chervil' }), 1);
  } finally {
    await run(`document.getElementById('foreign-slot').remove()`);
  }
});

test('an element outside HTML with the name of one the walk treats specially is walked like any other element', async () => {
  // Inside <math> the parser makes <details> and <style> MathML elements, which have none of the HTML meaning; a script
  // can make a MathML <br>. Each holds a token, which Chrome draws. An SVG <style> or <script> is never drawn.
  await run(`(() => { const box = document.createElement('div'); box.id = 'foreign-names'; box.style.cssText = ${JSON.stringify(PINNED)};
    box.innerHTML = '<p><math><details><mi>quassia</mi></details></math></p><p><math><style><mi>rampion</mi></style></math></p>'
      + '<p><math></math></p><p><svg width="200" height="20"><style>umbellifer</style><script>verbena</script></svg></p>';
    const M = 'http://www.w3.org/1998/Math/MathML';
    const br = box.querySelectorAll('math')[2].appendChild(document.createElementNS(M, 'br'));
    br.appendChild(document.createElementNS(M, 'mi')).append('tansy');
    document.body.append(box); })()`);
  try {
    assert.deepEqual(await run(`[...document.querySelectorAll('#foreign-names details, #foreign-names style, #foreign-names script, #foreign-names math > *')]
      .map((el) => el.localName + ' ' + el.namespaceURI.split('/').pop())`),
    ['details MathML', 'style MathML', 'br MathML', 'style svg', 'script svg']);
    assert.deepEqual(await drawn(['quassia', 'rampion', 'tansy', 'umbellifer', 'verbena']),
      { quassia: true, rampion: true, tansy: true, umbellifer: false, verbena: false });
    assert.equal(await count({ any: 'quassia' }), 1); // in a MathML <details>
    assert.equal(await count({ any: 'rampion' }), 1); // in a MathML <style>
    assert.equal(await count({ any: 'tansy' }), 1); // in a MathML <br>
    assert.equal(await count({ any: 'umbellifer' }), 0); // an SVG <style>
    assert.equal(await count({ any: 'verbena' }), 0); // an SVG <script>
  } finally {
    await run(`document.getElementById('foreign-names').remove()`);
  }
});

test('text placed directly in a MathML element is found in a token, or once its display is not a math one, as Chrome draws it', async () => {
  // The rule goes by layout: a token draws its text, and any other MathML element draws the text placed directly in it
  // unless its display is a math one. A table element (<mtable>, <mtr>, <mtd>) has a table display unless an author sets a
  // math one; given another display, an element lays out its text like any box.
  await run(`(() => { const box = document.createElement('div'); box.id = 'math-text'; box.style.cssText = ${JSON.stringify(PINNED)};
    box.innerHTML = '<p><math>vervain<mrow>woad</mrow><mi>yarrow</mi><mtable><mtr><mtd>zedoary</mtd></mtr></mtable>'
      + '<style>alkanet</style><details>borage</details></math></p>'
      + '<p><math><mrow style="display:block">cicely</mrow></math></p><p><math style="display:inline-block">cumin</math></p>'
      + '<p><math><mtable><mtr><mtd style="display:math">abelia</mtd></mtr></mtable></math></p>'
      + '<p><math><mtable><mtr><mtd style="display:block math">bluebell</mtd></mtr></mtable></math></p>'
      + '<p><math><mtable style="display:math">candytuft</mtable></math></p>'
      + '<p><math><mtable><mtr style="display:math">daphne</mtr></mtable></math></p>'
      + '<p><math><mtable><mtr><mtd style="display:block">edelweiss</mtd></mtr></mtable></math></p>'
      + '<p><math><mtable><mtr>freesia</mtr></mtable></math></p><p><math><mtable>gentian</mtable></math></p>'
      + '<p><math><mi style="display:block">heather</mi></math></p>';
    document.body.append(box); })()`);
  try {
    assert.deepEqual(await drawn(['vervain', 'woad', 'yarrow', 'zedoary', 'alkanet', 'borage', 'cicely', 'cumin', 'abelia', 'bluebell',
      'candytuft', 'daphne', 'edelweiss', 'freesia', 'gentian', 'heather']),
    { vervain: false, woad: false, yarrow: true, zedoary: true, alkanet: false, borage: false, cicely: true, cumin: true, abelia: false, bluebell: false,
      candytuft: false, daphne: false, edelweiss: true, freesia: true, gentian: true, heather: true });
    assert.equal(await count({ any: 'vervain' }), 0); // directly in <math>
    assert.equal(await count({ any: 'woad' }), 0); // in an <mrow>
    assert.equal(await count({ any: 'yarrow' }), 1); // in a token, <mi>
    assert.equal(await count({ any: 'zedoary' }), 1); // in a table cell, <mtd>, with its own display
    assert.equal(await count({ any: 'alkanet' }), 0); // in a MathML <style>
    assert.equal(await count({ any: 'borage' }), 0); // in a MathML <details>
    assert.equal(await count({ any: 'cicely' }), 1); // in an <mrow> with display: block
    assert.equal(await count({ any: 'cumin' }), 1); // in a <math> with display: inline-block
    assert.equal(await count({ any: 'abelia' }), 0); // in an <mtd> given display: math
    assert.equal(await count({ any: 'bluebell' }), 0); // in an <mtd> given display: block math
    assert.equal(await count({ any: 'candytuft' }), 0); // directly in an <mtable> given display: math
    assert.equal(await count({ any: 'daphne' }), 0); // directly in an <mtr> given display: math
    assert.equal(await count({ any: 'edelweiss' }), 1); // in an <mtd> given display: block
    assert.equal(await count({ any: 'freesia' }), 1); // directly in an <mtr> with its own display
    assert.equal(await count({ any: 'gentian' }), 1); // directly in an <mtable> with its own display
    assert.equal(await count({ any: 'heather' }), 1); // in a token given display: block
  } finally {
    await run(`document.getElementById('math-text').remove()`);
  }
});

test('a closed <details> shows only its first <summary>; any other one is hidden with the rest', async () => {
  await run(`(() => { const box = document.createElement('div'); box.id = 'summaries'; box.style.cssText = ${JSON.stringify(PINNED)};
    box.innerHTML = '<details><summary>larkspur</summary><summary style="display:contents">mignonette</summary><summary>nasturtium</summary></details>'
      + '<details open><summary>oleander</summary><summary style="display:contents">primrose</summary></details>';
    document.body.append(box); })()`);
  try {
    assert.deepEqual(await drawn(['larkspur', 'mignonette', 'nasturtium', 'oleander', 'primrose']),
      { larkspur: true, mignonette: false, nasturtium: false, oleander: true, primrose: true });
    assert.equal(await count({ any: 'larkspur' }), 1); // the closed details' summary
    assert.equal(await count({ any: 'mignonette' }), 0); // a second summary, display: contents
    assert.equal(await count({ any: 'nasturtium' }), 0); // a second summary with a box
    assert.equal(await count({ any: 'primrose' }), 1); // a second summary in an open details
  } finally {
    await run(`document.getElementById('summaries').remove()`);
  }
});

test('a slot that shows another slot is read one level at a time, so the slot in the middle can hide what it forwards', async () => {
  // Each host's shadow root puts its own slot (the middle one) inside an inner component, whose slot shows that slot.
  await run(`(() => { const box = document.createElement('div'); box.id = 'forwarded'; box.style.cssText = ${JSON.stringify(PINNED)};
    const forward = (host, word, middle, inner = '<p><slot></slot></p>') => {
      if (word) host.append(word);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<fwd-inner>' + middle + '</fwd-inner>';
      root.firstChild.attachShadow({ mode: 'open' }).innerHTML = inner;
      return host;
    };
    const div = () => box.appendChild(document.createElement('div'));
    forward(div(), 'pumice', '<slot style="display:none"></slot>');
    forward(div(), 'obsidian', '<slot style="visibility:hidden"></slot>');
    forward(div(), 'basalt', '<slot></slot>');
    forward(div(), '', '<slot>granite</slot>'); // nothing assigned: the middle slot shows its fallback
    const p = box.appendChild(document.createElement('p'));
    p.append('sea ', forward(document.createElement('span'), 'glass', '<slot></slot>', '<i><slot></slot></i>'));
    div().innerHTML = '<slot>feldspar</slot>'; // a slot in the document itself shows its own children
    document.body.append(box); })()`);
  try {
    assert.deepEqual(await drawn(['pumice', 'obsidian', 'basalt', 'granite', 'glass', 'feldspar']),
      { pumice: false, obsidian: false, basalt: true, granite: true, glass: true, feldspar: true });
    assert.equal(await count({ any: 'pumice' }), 0);
    assert.equal(await count({ any: 'obsidian' }), 0);
    assert.equal(await count({ any: 'basalt' }), 1);
    assert.equal(await count({ any: 'granite' }), 1);
    assert.equal(await count({ any: 'feldspar' }), 1);
    assert.equal(await count({ any: '"sea glass"' }), 1); // forwarded text stays in its sentence
    assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['sea glass']]);
  } finally {
    await run(`document.getElementById('forwarded').remove()`);
  }
});

test('a match whose words named slots bring together paints only its own words', async () => {
  // The slot named "a" shows the first and third spans, so the second one's word sits between them in the document only.
  await run(`(() => { const host = document.createElement('div'); host.id = 'regroup';
    host.innerHTML = '<span slot="a">wisteria</span><span slot="b">heliotrope</span><span slot="a">jonquil</span>';
    host.attachShadow({ mode: 'open' }).innerHTML = '<p><slot name="a"></slot> <slot name="b"></slot></p>';
    document.body.append(host); })()`);
  try {
    assert.equal(await count({ regex: 'wisteriajonquil' }), 1);
    assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['wisteria', 'jonquil']]);
  } finally {
    await run(`document.getElementById('regroup').remove()`);
  }
});

test('an inline component at the top of a shadow root stays in its sentence', async () => {
  await run(`(() => { const box = document.createElement('div'); box.id = 'inline-edge';
    box.innerHTML = '<p>Hola <span id="ie-a"></span></p><p>Ciao <span id="ie-b">Bella</span></p>';
    box.querySelector('#ie-a').attachShadow({ mode: 'open' }).innerHTML = '<span>Mundo</span>';
    box.querySelector('#ie-b').attachShadow({ mode: 'open' }).innerHTML = '<b><slot></slot></b>';
    document.body.append(box); })()`);
  try {
    assert.equal(await count({ any: '"Hola Mundo"' }), 1);
    assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['Hola ', 'Mundo']]);
    assert.equal(await count({ any: '"Ciao Bella"' }), 1);
    assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['Ciao Bella']]);
  } finally {
    await run(`document.getElementById('inline-edge').remove()`);
  }
});

test('a match that crosses page text, a component\'s text and page text again is painted exactly, one range per tree', async () => {
  // Three text nodes in three runs: the paragraph's own, the one directly in the span's shadow root, the paragraph's again.
  // The words around the match show that no range reaches past it.
  await run(`(() => { const p = document.createElement('p'); p.id = 'three-trees';
    p.append('before quartz ');
    p.appendChild(document.createElement('span')).attachShadow({ mode: 'open' }).append('amethyst');
    p.append(' mica after');
    document.body.append(p); })()`);
  try {
    assert.equal(await count({ regex: 'quartz amethyst mica' }), 1);
    assert.deepEqual(await run('__textFindPlusEngine._lastMatches'), [['quartz ', 'amethyst', ' mica']]);
    await run('__textFindPlusEngine.show(0, 5000)');
    assert.equal(await highlightSize('text-find-plus-match'), 3, 'one range for each tree');
    // Each range, as the page sees it: the text node it lies in and where in it, in the order they were painted. Together
    // they cover the match's own characters: no gap, nothing before or after them.
    const painted = await run(`[...CSS.highlights.get('text-find-plus-match')].map((r) => [r.startContainer.data, r.startOffset, r.endContainer === r.startContainer, r.endOffset])`);
    assert.deepEqual(painted, [['before quartz ', 7, true, 14], ['amethyst', 0, true, 8], [' mica after', 0, true, 5]]);
  } finally {
    await run(`document.getElementById('three-trees').remove()`);
  }
});

test('scrolling reaches a match inside a component that sits in a scrollable box', async () => {
  // Text directly in a shadow root has no parentElement, so reveal() scrolls the root's host (spec §4.5). The box is pinned
  // in the viewport, and the component sits far below the part of it that shows, outside the viewport too.
  await run(`(() => { const box = document.createElement('div'); box.id = 'scroll-box';
    box.style.cssText = 'position: fixed; top: 0; left: 0; width: 300px; height: 100px; overflow: auto; z-index: 2147483647; background: white';
    box.innerHTML = '<div style="height: 3000px"></div><lantern-card style="display: block"></lantern-card>';
    box.lastChild.attachShadow({ mode: 'open' }).append('chalcedony');
    document.body.append(box); })()`);
  try {
    assert.equal(await run(`document.querySelector('#scroll-box lantern-card').shadowRoot.firstChild.parentElement`), null, 'the text has no parent element');
    assert.equal(await count({ any: 'chalcedony' }), 1);
    assert.equal(await run(`document.getElementById('scroll-box').scrollTop`), 0);
    await run('__textFindPlusEngine.show(0, 5000)');
    const shown = await run(`(() => { const box = document.getElementById('scroll-box'), room = box.getBoundingClientRect();
      const r = [...CSS.highlights.get('text-find-plus-current')][0].getBoundingClientRect();
      return { scrolled: box.scrollTop > 0, drawn: r.width > 0 && r.height > 0,
        inside: r.top >= room.top && r.bottom <= room.bottom && r.left >= room.left && r.right <= room.right }; })()`);
    assert.deepEqual(shown, { scrolled: true, drawn: true, inside: true }, 'the box scrolled until the match is inside it');
  } finally {
    await run(`document.getElementById('scroll-box').remove(); scrollTo(0, 0)`);
  }
});

/** Add a box pinned in the viewport that scrolls (overflow: auto, 300 x 100 unless `style` says otherwise), holding `html`. */
const addBox = (id, html, style = '') => run(`(() => { const box = document.createElement('div'); box.id = ${JSON.stringify(id)};
  box.style.cssText = 'position: fixed; top: 0; left: 0; width: 300px; height: 100px; overflow: auto; z-index: 2147483647; background: white; ' + ${JSON.stringify(style)};
  box.innerHTML = ${JSON.stringify(html)}; document.body.append(box); })()`);
/** Whether an element's rect is inside the viewport, and inside the visible part of each box in `ids`. */
const placed = (selector, ids) => run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  const inside = (b) => r.top >= b.top && r.bottom <= b.bottom && r.left >= b.left && r.right <= b.right;
  return { viewport: inside({ top: 0, bottom: innerHeight, left: 0, right: innerWidth }),
    boxes: ${JSON.stringify(ids)}.map((id) => inside(document.getElementById(id).getBoundingClientRect())) }; })()`);
const removeBoxes = (...ids) => run(`${JSON.stringify(ids)}.forEach((id) => document.getElementById(id)?.remove()); scrollTo(0, 0)`);

test('a match that a box inside the viewport clips is scrolled into the box, in page text and bare in a component', async () => {
  // Chrome's rects ignore clipping: each match is 300 px down a 100 px box, inside the viewport and outside the box.
  await addBox('clip-page', '<div style="height: 300px"></div><p style="margin: 0">sardonyx</p><div style="height: 300px"></div>');
  await addBox('clip-root', '<div style="height: 300px"></div><lantern-card style="display: block"></lantern-card><div style="height: 300px"></div>', 'left: 320px');
  await run(`document.querySelector('#clip-root lantern-card').attachShadow({ mode: 'open' }).append('carnelian')`);
  try {
    for (const [id, target, word] of [['clip-page', '#clip-page p', 'sardonyx'], ['clip-root', '#clip-root lantern-card', 'carnelian']]) {
      assert.deepEqual(await placed(target, [id]), { viewport: true, boxes: [false] }, `${word} starts in the viewport and out of its box`);
      assert.equal(await count({ any: word }), 1);
      await run('__textFindPlusEngine.show(0, 5000)');
      assert.deepEqual(await placed(target, [id]), { viewport: true, boxes: [true] }, `${word} is inside its box`);
      assert.ok((await run(`document.getElementById(${JSON.stringify(id)}).scrollTop`)) > 0, `${word}'s box scrolled`);
    }
  } finally {
    await removeBoxes('clip-page', 'clip-root');
  }
});

test('a match that is already visible scrolls nothing, in a box, in a scrolled box, or escaping a box that clips', async () => {
  // The last two are outside the overflow: hidden box they sit in and visible: an absolutely positioned element is clipped
  // by the ancestor that contains it (the fixed wrapper) and not by the static box between, and a fixed one by the viewport only.
  await addBox('seen-top', '<p style="margin: 0">peridot</p><div style="height: 500px"></div>');
  await addBox('seen-scrolled', '<div style="height: 150px"></div><p style="margin: 0">chrysoprase</p><div style="height: 400px"></div>', 'left: 320px');
  await addBox('seen-abs', '<div style="overflow: hidden; height: 40px"><div style="position: absolute; top: 120px">tourmaline</div></div>', 'left: 640px; height: 200px; overflow: visible');
  await addBox('seen-fixed', '<div style="position: fixed; top: 150px; left: 960px">zoisite</div>', 'left: 960px; height: 40px; overflow: hidden');
  await run(`document.getElementById('seen-scrolled').scrollTop = 120; scrollTo(0, 40);
    globalThis.__revealed = 0; globalThis.__scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) { __revealed++; return __scrollIntoView.apply(this, args); };`);
  try {
    const state = () => run(`[scrollY, ...['seen-top', 'seen-scrolled'].map((id) => document.getElementById(id).scrollTop)]`);
    assert.deepEqual(await state(), [40, 0, 120]);
    for (const [target, word] of [['#seen-top p', 'peridot'], ['#seen-scrolled p', 'chrysoprase'], ['#seen-abs div div', 'tourmaline'], ['#seen-fixed div', 'zoisite']]) {
      assert.equal((await placed(target, [])).viewport, true, `${word} starts in the viewport`);
      assert.equal(await count({ any: word }), 1);
      await run('__textFindPlusEngine.show(0, 5000)');
      assert.equal(await run('__revealed'), 0, `${word} was scrolled to although it shows`);
      assert.deepEqual(await state(), [40, 0, 120], `${word} moved a scroller although it shows`);
    }
    // The two that escape a box really are outside it, so this tests the rule and not the layout.
    assert.deepEqual(await placed('#seen-abs div div', ['seen-abs']), { viewport: true, boxes: [true] });
    assert.equal(await run(`document.querySelector('#seen-abs div div').getBoundingClientRect().top > document.querySelector('#seen-abs div').getBoundingClientRect().bottom`), true);
    assert.equal(await run(`document.querySelector('#seen-fixed div').getBoundingClientRect().top > document.getElementById('seen-fixed').getBoundingClientRect().bottom`), true);
  } finally {
    await run('Element.prototype.scrollIntoView = __scrollIntoView; delete globalThis.__scrollIntoView; delete globalThis.__revealed');
    await removeBoxes('seen-top', 'seen-scrolled', 'seen-abs', 'seen-fixed');
  }
});

test('a match in a box in a box scrolls both', async () => {
  // The inner box is 300 px down the outer one, the match 150 px down the inner one: in the viewport, outside both boxes.
  await addBox('outer', '<div style="height: 300px"></div><div id="inner" style="width: 250px; height: 80px; overflow: auto"><div style="height: 150px"></div><p style="margin: 0">amazonite</p><div style="height: 200px"></div></div><div style="height: 300px"></div>', 'height: 150px');
  try {
    assert.deepEqual(await placed('#inner p', ['outer', 'inner']), { viewport: true, boxes: [false, false] });
    assert.equal(await count({ any: 'amazonite' }), 1);
    await run('__textFindPlusEngine.show(0, 5000)');
    assert.deepEqual(await placed('#inner p', ['outer', 'inner']), { viewport: true, boxes: [true, true] });
    assert.deepEqual(await run(`['outer', 'inner'].map((id) => document.getElementById(id).scrollTop > 0)`), [true, true]);
  } finally {
    await removeBoxes('outer');
  }
});

test('a match in a parent taller than its box, or than the viewport, is brought into view', async () => {
  // Scrolling the parent to the middle of the box (or viewport) leaves a match near its top out of sight.
  const tall = (word) => `<p class="tall" style="width: 80px; margin: 0">${'line<br>'.repeat(20)}${word}${'<br>line'.repeat(150)}</p>`;
  await addBox('tall-box', tall('tanzanite'));
  await run(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<div id="tall-page">${tall('spodumene')}</div>`)})`);
  try {
    const inBox = await revealed('tanzanite', ['tall-box']);
    assert.deepEqual([inBox.start.place.viewport, inBox.start.place.boxes], [true, [false]], 'tanzanite starts in the viewport and out of the box');
    assert.deepEqual(inBox.place.boxes, [true], 'inside the box');
    const inPage = await revealed('spodumene', []);
    assert.equal(inPage.start.place.viewport, false, 'spodumene starts outside the viewport');
    assert.equal(inPage.place.viewport, true, 'inside the viewport');
  } finally {
    await run(`document.getElementById('tall-page').remove()`);
    await removeBoxes('tall-box');
  }
});

// Boxes in the page's own flow, which scrolling the page can move, unlike the pinned ones above.

/** Put an element made from `html` in the page's flow (before #p-contents) and scroll the page so its top is `at` px down. */
const addFlow = (id, html, at = 120) => run(`(() => { const box = document.createElement('div'); box.id = ${JSON.stringify(id)};
  box.innerHTML = ${JSON.stringify(html)}; document.getElementById('p-contents').before(box);
  document.body.style.paddingBottom = innerHeight + 'px'; // room to scroll the box to \`at\` however short the page is
  scrollTo({ top: box.offsetTop - ${at}, behavior: 'instant' });
  if (Math.round(box.getBoundingClientRect().top) !== ${at}) {
    // What removeFlow() does: the caller's finally, which would call it, is not reached.
    box.remove(); document.body.style.paddingBottom = ''; scrollTo({ top: 0, behavior: 'instant' });
    throw new Error(\`the page could not put \${box.id} \${${at}} px down\`);
  } })()`);
/** Search for `word`, show the match without scrolling and then with scrolling; resolves with the scroll positions of the page
 * and of the elements `ids` (by id) before, and after, and where the match is after: see `matchPlace`. */
async function revealed(word, ids, boxes = ids.map((id) => `document.getElementById(${JSON.stringify(id)})`), bars = []) {
  assert.equal(await count({ any: word }), 1);
  const state = () => run(`[scrollX, scrollY, ...[${boxes.join(', ')}].flatMap((e) => [e.scrollLeft, e.scrollTop])]`);
  await run('__textFindPlusEngine.show(0, 5000, false)');
  const start = { scrolls: await state(), place: await matchPlace(boxes, bars) };
  await run('__textFindPlusEngine.show(0, 5000)');
  return { start, scrolls: await state(), place: await matchPlace(boxes, bars) };
}
/**
 * Whether the current match's rect is inside the viewport and inside each of the elements the expressions `boxes` give,
 * and whether what is on top of the match's middle is inside each of the elements the selectors `bars` name. placeOf()
 * is the expression, to evaluate in the same task as something else.
 */
const placeOf = (boxes, bars = []) => `(() => { const r = [...CSS.highlights.get('text-find-plus-current')][0].getBoundingClientRect();
  const inside = (b) => r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1 && r.right <= b.right + 1; // text ends mid-pixel
  const top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  return { viewport: inside({ top: 0, bottom: innerHeight, left: 0, right: innerWidth }), boxes: [${boxes.join(', ')}].map((e) => inside(e.getBoundingClientRect())),
    covered: ${JSON.stringify(bars)}.map((selector) => Boolean(top?.closest(selector))), rect: [r.top, r.bottom] }; })()`;
const matchPlace = (boxes, bars = []) => run(placeOf(boxes, bars));
const lines = (n, at, word, tag = 'p') => Array.from({ length: n }, (_, i) => `<${tag} style="margin: 4px 0">message ${i} ${i === at ? word : 'plain'} text</${tag}>`).join('');
const removeFlow = (...ids) => run(`${JSON.stringify(ids)}.forEach((id) => document.getElementById(id)?.remove());
  document.body.style.paddingBottom = ''; scrollTo({ top: 0, behavior: 'instant' })`);

test('a match that shows in a tight line box against a pane\'s edge is left where it is', async () => {
  // The glyph box of a line with line-height: 1 is a pixel or two taller than the line box, so against the pane's top edge its
  // rect sticks out of the pane, although the text shows in full. The pane is scrolled until the heading is flush with its edge.
  await addFlow('tight', `<div id="tight-pane" style="height: 100px; overflow: auto; width: 300px">${lines(8, -1, '')}<h2 style="margin: 0; line-height: 1; font-size: 32px">tektite heading</h2>${lines(20, -1, '')}</div>`);
  try {
    assert.equal(await run(`(() => { const pane = document.getElementById('tight-pane'), h2 = pane.querySelector('h2');
      pane.scrollTop = h2.offsetTop - pane.offsetTop;
      const range = document.createRange(); range.selectNodeContents(h2.firstChild);
      return range.getBoundingClientRect().top < pane.getBoundingClientRect().top; })()`), true, 'the glyph box sticks out above the pane');
    const { start, scrolls, place } = await revealed('tektite', ['tight-pane']);
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled although the match shows');
    assert.equal(place.viewport, true);
  } finally {
    await removeFlow('tight');
  }
});

test('a match in a box clipped sideways, with its text directly in a pre, is scrolled sideways to', async () => {
  const long = (i) => `line ${i}: ${'x'.repeat(120)} ${i === 3 ? 'obsidian' : 'plain'} end\n`;
  await addFlow('wide', `<pre id="wide-pre" style="overflow: auto; margin: 0; width: 300px">${Array.from({ length: 6 }, (_, i) => long(i)).join('')}</pre>`);
  try {
    const { start, scrolls, place } = await revealed('obsidian', ['wide-pre']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts clipped by the pre only');
    assert.ok(scrolls[2] > 0, 'the pre scrolled sideways');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
    assert.equal(scrolls[1], start.scrolls[1], 'the page stayed');
  } finally {
    await removeFlow('wide');
  }
});

test('a match hidden in a box drawn at half size is scrolled to', async () => {
  // The box's own pixels (clientHeight, scrollTop) are twice what is drawn.
  await addFlow('half', `<div style="transform: scale(0.5); transform-origin: 0 0; width: 600px"><div id="half-pane" style="height: 400px; overflow: auto; width: 600px">${lines(40, 28, 'jacinth')}</div></div>`);
  try {
    const { start, place } = await revealed('jacinth', ['half-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]]);
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('half');
  }
});

test('a match that shows in a box drawn at one and a half times its size is left where it is', async () => {
  await addFlow('big', `<div style="transform: scale(1.5); transform-origin: 0 0; width: 300px"><div id="big-pane" style="height: 200px; overflow: auto; width: 300px">${lines(30, 6, 'sphalerite')}</div></div>`);
  try {
    const { start, scrolls, place } = await revealed('sphalerite', ['big-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [true]], 'the match starts in the part of the drawn box that shows');
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled although the match shows');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('big');
  }
});

test('a match inside the viewport that only a box hides scrolls the box and not the page', async () => {
  await addFlow('chat', `<div id="chat-pane" style="height: 200px; overflow: auto; width: 300px; border: 1px solid">${lines(50, 25, 'feldspar')}</div>`, 100);
  try {
    // Scrolled until the match is 60 px above the pane's top edge: out of the pane, inside the viewport.
    await run(`(() => { const pane = document.getElementById('chat-pane'); pane.scrollTop = pane.children[25].offsetTop - pane.offsetTop + 60; })()`);
    const { start, scrolls, place } = await revealed('feldspar', ['chat-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.ok(start.scrolls[1] > 0, 'the page is scrolled');
    assert.deepEqual(scrolls.slice(0, 3), start.scrolls.slice(0, 3), 'the page or its x moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('chat');
  }
});

test('an overflow: clip box that hides a match is not scrolled to, and nothing else is either', async () => {
  // overflow: clip can't be scrolled, so there is nothing to do; the page stays where it is.
  await addFlow('clipped', `<div id="clip-pane" style="height: 60px; overflow: clip; width: 300px">${lines(10, 6, 'sunstone')}</div>`);
  try {
    await run(`globalThis.__revealed = 0; globalThis.__scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) { __revealed++; return __scrollIntoView.apply(this, args); };`);
    const { start, scrolls, place } = await revealed('sunstone', ['clip-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the box');
    assert.deepEqual(scrolls, start.scrolls);
    assert.equal(await run('__revealed'), 0);
    assert.deepEqual([place.viewport, place.boxes], [true, [false]]);
  } finally {
    await run('Element.prototype.scrollIntoView = __scrollIntoView; delete globalThis.__scrollIntoView; delete globalThis.__revealed');
    await removeFlow('clipped');
  }
});

test('a box that hides part of its content with overflow: hidden is scrolled to show the match: an ellipsis cell, a line clamp, a collapsed read-more', async () => {
  // Chrome's find scrolls such a box so the match shows, though the user has no way to. The page stays where it is.
  await addFlow('ellipsis', `<div id="cell" style="width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">A long row title that ends with sardonyx</div>`);
  await addFlow('clamp', `<p id="clamp-pane" style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 200px; margin: 0">${'lorem '.repeat(25)}carnelian ${'lorem '.repeat(10)}</p>`);
  await addFlow('more', `<div id="more-pane" style="max-height: 100px; overflow: hidden; width: 400px">${lines(12, 8, 'chalcedony')}</div>`);
  try {
    for (const [word, id, axis] of [['sardonyx', 'cell', 2], ['carnelian', 'clamp-pane', 3], ['chalcedony', 'more-pane', 3]]) {
      await run(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: 'start' }); scrollBy(0, -120)`);
      const { start, scrolls, place } = await revealed(word, [id]);
      assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], `${word} starts hidden by its box, in the viewport`);
      assert.ok(scrolls[axis] > 0, `${id} scrolled`);
      assert.deepEqual(scrolls.slice(0, 2), start.scrolls.slice(0, 2), `the page moved for ${word}`);
      assert.deepEqual([place.viewport, place.boxes], [true, [true]], `${word} shows`);
    }
  } finally {
    await removeFlow('ellipsis', 'clamp', 'more');
  }
});

test('slotted content in a box in a shadow root is scrolled to, as an element and as bare text', async () => {
  const pane = '<div id="slot-pane" style="height: 150px; overflow: auto; width: 300px"><slot></slot></div>';
  await addFlow('slotted', `<lantern-card id="slot-host" style="display: block">${lines(40, 12, 'peridot')}</lantern-card>`
    + `<lantern-card id="slot-bare" style="display: block">${'plain '.repeat(80)}hematite ${'plain '.repeat(200)}</lantern-card>`);
  await run(`for (const id of ['slot-host', 'slot-bare']) document.getElementById(id).attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(pane)}`);
  try {
    for (const [word, host] of [['peridot', 'slot-host'], ['hematite', 'slot-bare']]) {
      const scroller = `document.getElementById(${JSON.stringify(host)}).shadowRoot.firstChild`;
      await run(`document.getElementById(${JSON.stringify(host)}).scrollIntoView({ block: 'start' }); scrollBy(0, -120)`);
      const { start, scrolls, place } = await revealed(word, [], [scroller]);
      assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], `${word} starts hidden by the box in the shadow root`);
      assert.ok(scrolls[3] > 0, `the box in the shadow root scrolled for ${word}`);
      assert.deepEqual([place.viewport, place.boxes], [true, [true]], `${word} shows`);
    }
  } finally {
    await removeFlow('slotted');
  }
});

test('a match under a pane that reaches above the viewport is centred in the part that shows, and the page stays', async () => {
  // The pane's bottom edge is 55% down the viewport and the match 60 px below it: in the viewport, out of the pane. Centring
  // it in the whole pane would put it off screen, and the page would have to follow.
  await addFlow('above', `<div id="above-pane" style="height: 1500px; overflow: auto; width: 300px">${lines(100, -1, '')}</div>`);
  try {
    await run(`(() => { const pane = document.getElementById('above-pane');
      [...pane.children].find((p) => p.offsetTop - pane.offsetTop >= 1560).append(' mookaite');
      scrollTo(0, pane.offsetTop + 1500 - Math.round(innerHeight * 0.55)); })()`);
    const { start, scrolls, place } = await revealed('mookaite', ['above-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.ok(start.scrolls[1] > 0);
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('above');
  }
});

test('a match above a pane that reaches below the viewport is centred in the part that shows, and the page stays', async () => {
  // The pane's top edge is 45% down the viewport and the match 60 px above it, 1000 px into the pane's content: the middle of
  // the whole pane is below the viewport, and the match would have to be scrolled there.
  await addFlow('below', `<div id="below-pane" style="height: 1500px; overflow: auto; width: 300px">${lines(120, -1, '')}</div>`);
  try {
    await run(`(() => { const pane = document.getElementById('below-pane');
      const line = [...pane.children].find((p) => p.offsetTop - pane.offsetTop >= 1000);
      line.append(' kunzite');
      pane.scrollTop = line.offsetTop - pane.offsetTop + 60;
      scrollTo(0, pane.offsetTop - Math.round(innerHeight * 0.45)); })()`);
    const { start, scrolls, place } = await revealed('kunzite', ['below-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('below');
  }
});

// A fixed or absolutely positioned element belongs to the first ancestor that contains it, and what clips that clips it.

/** A pane 150 px tall with a div of the given style inside it, and in that a fixed element 450 px down holding `word`. */
const fixedUnder = (id, style, word) => `<div style="position: relative"><div id="${id}" style="height: 150px; overflow: auto; width: 300px">`
  + `<div style="${style}; height: 600px"><div id="${id}-fixed" style="position: fixed; top: 450px; left: 0">${word}</div></div></div></div>`;

test('a fixed element under an ancestor with a filter is clipped by the box that ancestor sits in', async () => {
  await addFlow('filter', fixedUnder('filter-pane', 'filter: opacity(1)', 'amblygonite'), 60);
  try {
    const { start, scrolls, place } = await revealed('amblygonite', ['filter-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('filter');
  }
});

test('a fixed element under an ancestor with only will-change: opacity is not clipped by the box, and is left where it is', async () => {
  // will-change: opacity contains nothing, so the element is placed against the viewport, 450 px down, and shows.
  await addFlow('opacity', fixedUnder('opacity-pane', 'will-change: opacity', 'spodumene'), 60);
  try {
    const { start, scrolls, place } = await revealed('spodumene', ['opacity-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport, out of the pane\'s rect');
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled although the match shows');
    assert.deepEqual([place.viewport, place.boxes], [true, [false]]);
  } finally {
    await removeFlow('opacity');
  }
});

test('a fixed element under an ancestor with a transform is clipped by the box that ancestor sits in', async () => {
  await addFlow('transform', fixedUnder('transform-pane', 'transform: translateX(0)', 'labradorite'), 60);
  try {
    const { start, scrolls, place } = await revealed('labradorite', ['transform-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('transform');
  }
});

test('a fixed element under an ancestor with an offset-path, an offset-position, or a will-change that names one, is clipped by the box that ancestor sits in', async () => {
  // offset-anchor: 0 0 keeps the block where it is; offset-position alone does not move it.
  for (const [style, word] of [['will-change: offset-path', 'pezzottaite'], ["offset-path: path('M0 0'); offset-anchor: 0 0", 'painite'],
    ['offset-position: 0 0', 'sugilite'], ['will-change: offset-position', 'charoite']]) {
    await addFlow('offset', fixedUnder('offset-pane', style, word), 60);
    try {
      const { start, scrolls, place } = await revealed(word, ['offset-pane']);
      assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], `${word} starts in the viewport and out of the pane`);
      assert.equal(scrolls[1], start.scrolls[1], `the page moved for ${word}`);
      assert.notEqual(scrolls[3], start.scrolls[3], `the pane did not scroll for ${word}`);
      assert.deepEqual([place.viewport, place.boxes], [true, [true]], `${word} shows`);
    } finally {
      await removeFlow('offset');
    }
  }
});

// will-change names are matched whole, and in any case: Chrome keeps the case they were written in.

test('a fixed element under an ancestor with will-change: offset, the shorthand, is clipped by the box that ancestor sits in', async () => {
  await addFlow('willoffset', fixedUnder('will-offset-pane', 'will-change: offset', 'jeremejevite'), 60);
  try {
    const { start, scrolls, place } = await revealed('jeremejevite', ['will-offset-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('willoffset');
  }
});

test('a fixed element under an ancestor with will-change: contain is clipped by the box that ancestor sits in', async () => {
  await addFlow('willcontain', fixedUnder('will-contain-pane', 'will-change: contain', 'kornerupine'), 60);
  try {
    const { start, scrolls, place } = await revealed('kornerupine', ['will-contain-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('willcontain');
  }
});

test('a fixed element under an ancestor with will-change: TRANSFORM, in capitals, is clipped by the box that ancestor sits in', async () => {
  await addFlow('willcaps', fixedUnder('will-caps-pane', 'will-change: TRANSFORM', 'sinhalite'), 60);
  try {
    assert.equal(await run(`getComputedStyle(document.getElementById('will-caps-pane').firstChild).willChange`), 'TRANSFORM',
      'Chrome no longer keeps the case of a will-change name, so this tests nothing');
    const { start, scrolls, place } = await revealed('sinhalite', ['will-caps-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('willcaps');
  }
});

test('a fixed element under an ancestor with will-change: transform-origin, which contains nothing, is not clipped by the box, and is left where it is', async () => {
  // transform-origin begins with the name transform but is another property: the element is placed against the viewport,
  // 450 px down, and shows.
  await addFlow('willorigin', fixedUnder('will-origin-pane', 'will-change: transform-origin', 'tugtupite'), 60);
  try {
    assert.equal(await run(`document.getElementById('will-origin-pane-fixed').getBoundingClientRect().top`), 450, 'the element is not placed against the viewport');
    const { start, scrolls, place } = await revealed('tugtupite', ['will-origin-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport, out of the pane\'s rect');
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled although the match shows');
    assert.deepEqual([place.viewport, place.boxes], [true, [false]]);
  } finally {
    await removeFlow('willorigin');
  }
});

/**
 * A pane 150 px tall with an element `tag` of the given style at its top, holding a fixed element 450 px down that holds
 * `word`, and 600 px of content after it.
 */
const fixedUnderTag = (id, tag, style, word) => `<div id="${id}" style="height: 150px; overflow: auto; width: 300px">`
  + `<${tag} style="${style}">x<span id="${id}-fixed" style="position: fixed; top: 450px; left: 0">${word}</span></${tag}><div style="height: 600px"></div></div>`;

test('a fixed element under an inline element with will-change: filter is clipped by the box that element sits in', async () => {
  // On an inline element a filter, or a will-change that names one, is all that contains a fixed element.
  await addFlow('inlinefilter', fixedUnderTag('inline-filter-pane', 'span', 'will-change: filter', 'smithsonite'), 60);
  try {
    assert.equal(await run(`(() => { const fixed = document.getElementById('inline-filter-pane-fixed');
      return Math.round(fixed.getBoundingClientRect().top - fixed.parentElement.getBoundingClientRect().top); })()`), 450, 'the element is not placed against the span');
    const { start, scrolls, place } = await revealed('smithsonite', ['inline-filter-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('inlinefilter');
  }
});

test('a fixed element under an inline element with a transform, or a display: contents one with a filter, is not clipped by the box, and is left where it is', async () => {
  // A transform does not apply to an inline element, and a display: contents element has no box, so neither contains
  // anything: the element is placed against the viewport, 450 px down, and shows.
  for (const [id, tag, style, word] of [['inline-pane', 'span', 'transform: translateX(0)', 'chrysocolla'],
    ['contents-pane', 'div', 'display: contents; filter: opacity(1)', 'rhodochrosite']]) {
    await addFlow('uncontained', fixedUnderTag(id, tag, style, word), 60);
    try {
      assert.equal(await run(`document.getElementById('${id}-fixed').getBoundingClientRect().top`), 450, `${word} is not placed against the viewport`);
      const { start, scrolls, place } = await revealed(word, [id]);
      assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], `${word} starts in the viewport, out of the pane's rect`);
      assert.deepEqual(scrolls, start.scrolls, `something scrolled although ${word} shows`);
      assert.deepEqual([place.viewport, place.boxes], [true, [false]]);
    } finally {
      await removeFlow('uncontained');
    }
  }
});

test('a fixed element under a ruby, a ruby text or an inline list item with a transform is not clipped by the box, and is left where it is', async () => {
  // Each is a non-atomic inline box, as an inline element is: a transform does not apply to it, so it contains nothing, and
  // the element is placed against the viewport, 450 px down, and shows.
  for (const [id, word, html] of [
    ['ruby-pane', 'danburite', fixedUnderTag('ruby-pane', 'ruby', 'transform: translateX(0)', 'danburite')],
    ['rt-pane', 'taaffeite', '<div id="rt-pane" style="height: 150px; overflow: auto; width: 300px"><ruby>base<rt style="transform: translateX(0)">x'
      + '<span id="rt-pane-fixed" style="position: fixed; top: 450px; left: 0">taaffeite</span></rt></ruby><div style="height: 600px"></div></div>'],
    ['list-pane', 'grandidierite', fixedUnderTag('list-pane', 'span', 'display: inline list-item; transform: translateX(0)', 'grandidierite')]]) {
    await addFlow('nonatomic', html, 60);
    try {
      assert.equal(await run(`document.getElementById('${id}-fixed').getBoundingClientRect().top`), 450, `${word} is not placed against the viewport`);
      const { start, scrolls, place } = await revealed(word, [id]);
      assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], `${word} starts in the viewport, out of the pane's rect`);
      assert.deepEqual(scrolls, start.scrolls, `something scrolled although ${word} shows`);
      assert.deepEqual([place.viewport, place.boxes], [true, [false]]);
    } finally {
      await removeFlow('nonatomic');
    }
  }
});

test('a fixed element under an inline-block with a transform is clipped by the box that element sits in', async () => {
  // An inline-block is an atomic inline box, so a transform applies to it and contains the element, as on a block.
  await addFlow('inlineblock', fixedUnderTag('inline-block-pane', 'span', 'display: inline-block; transform: translateX(0)', 'pollucite'), 60);
  try {
    assert.equal(await run(`(() => { const fixed = document.getElementById('inline-block-pane-fixed');
      return Math.round(fixed.getBoundingClientRect().top - fixed.parentElement.getBoundingClientRect().top); })()`), 450, 'the element is not placed against the inline-block');
    const { start, scrolls, place } = await revealed('pollucite', ['inline-block-pane']);
    assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], 'the match starts in the viewport and out of the pane');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.notEqual(scrolls[3], start.scrolls[3], 'the pane did not scroll');
    assert.deepEqual([place.viewport, place.boxes], [true, [true]]);
  } finally {
    await removeFlow('inlineblock');
  }
});

test('a fixed element under a table row or row group with containment is not clipped by the box, and is left where it is', async () => {
  // Containment does not apply to a table row or row group, so neither contain, content-visibility: auto nor a will-change
  // that names contain contains anything there: the element is placed against the viewport, 450 px down, and shows.
  for (const [group, row, word] of [['<tbody>', '<tr style="content-visibility: auto">', 'morganite'],
    ['<tbody style="contain: paint">', '<tr>', 'serendibite'], ['<thead style="will-change: contain">', '<tr>', 'musgravite'],
    ['<tfoot style="contain: layout">', '<tr>', 'poudretteite']]) {
    await addFlow('row', `<div id="row-pane" style="height: 150px; overflow: auto; width: 300px"><table>${group}${row}`
      + `<td>x<span id="row-pane-fixed" style="position: fixed; top: 450px; left: 0">${word}</span></td></table>` // </table> ends the row and group
      + '<div style="height: 600px"></div></div>', 60);
    try {
      assert.equal(await run(`document.getElementById('row-pane-fixed').getBoundingClientRect().top`), 450, `${word} is not placed against the viewport`);
      const { start, scrolls, place } = await revealed(word, ['row-pane']);
      assert.deepEqual([start.place.viewport, start.place.boxes], [true, [false]], `${word} starts in the viewport, out of the pane's rect`);
      assert.deepEqual(scrolls, start.scrolls, `something scrolled although ${word} shows`);
      assert.deepEqual([place.viewport, place.boxes], [true, [false]]);
    } finally {
      await removeFlow('row');
    }
  }
});

// A sticky or fixed bar that covers a match counts as not seen: the scroller it sticks to moves just clear of it.

/** Put the paragraph `n` of `#<id> p` `y` px down the viewport. */
const lineAt = (id, n, y) => run(`(() => { const p = document.querySelectorAll('#${id} p')[${n}]; scrollTo(0, p.offsetTop - ${y}); })()`);
/** Whether the current match is a line's height clear of the bar, on the side given, and inside the viewport. */
const clearOf = (bar, side) => run(`(() => { const r = [...CSS.highlights.get('text-find-plus-current')][0].getBoundingClientRect(), b = document.querySelector(${JSON.stringify(bar)}).getBoundingClientRect();
  return ${JSON.stringify(side)} === 'below' ? r.top >= b.bottom - 1 && r.bottom <= innerHeight : r.bottom <= b.top + 1 && r.top >= 0; })()`);

test('a match under a sticky header is scrolled clear of it', async () => {
  await addFlow('sticky', `<header id="sticky-bar" style="position: sticky; top: 0; height: 60px; background: white; z-index: 5">Site header</header>${lines(60, 30, 'rhodonite')}`);
  try {
    await lineAt('sticky', 30, 20);
    const { start, scrolls, place } = await revealed('rhodonite', [], [], ['#sticky-bar']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the header covers the match');
    assert.ok(scrolls[1] < start.scrolls[1], 'the page did not scroll up');
    assert.equal(await clearOf('#sticky-bar', 'below'), true);
    assert.deepEqual(place.covered, [false]);
  } finally {
    await removeFlow('sticky');
  }
});

test('a match in an inline element or a ruby that says overflow: hidden, under a sticky header, is scrolled clear of it', async () => {
  // A non-atomic inline box has no box to clip with, so the element hides nothing and only the header covers the match.
  for (const [tag, word] of [['span', 'kyanite'], ['ruby', 'hiddenite']]) {
    await addFlow('inlineclip', `<header id="inline-clip-bar" style="position: sticky; top: 0; height: 60px; background: white; z-index: 5">Site header</header>`
      + lines(60, 30, `<${tag} style="overflow: hidden">${word}</${tag}>`));
    try {
      await lineAt('inlineclip', 30, 20);
      const { start, scrolls, place } = await revealed(word, [], [], ['#inline-clip-bar']);
      assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], `the header covers ${word}`);
      assert.ok(scrolls[1] < start.scrolls[1], `the page did not scroll up for ${word}`);
      assert.equal(await clearOf('#inline-clip-bar', 'below'), true);
      assert.deepEqual(place.covered, [false]);
    } finally {
      await removeFlow('inlineclip');
    }
  }
});

test('a match under a fixed header is scrolled clear of it', async () => {
  await addFlow('fixedtop', `<div id="fixed-top" style="position: fixed; top: 0; left: 0; right: 0; height: 60px; background: white; z-index: 2147483646">Fixed header</div>${lines(60, 30, 'prehnite')}`);
  try {
    await lineAt('fixedtop', 30, 20);
    const { start, scrolls, place } = await revealed('prehnite', [], [], ['#fixed-top']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the header covers the match');
    assert.ok(scrolls[1] < start.scrolls[1], 'the page did not scroll up');
    assert.equal(await clearOf('#fixed-top', 'below'), true);
    assert.deepEqual(place.covered, [false]);
  } finally {
    await removeFlow('fixedtop');
  }
});

test('a match under a cookie banner along the bottom is scrolled clear of it', async () => {
  await addFlow('banner', `<div id="cookie-bar" style="position: fixed; bottom: 0; left: 0; right: 0; height: 80px; background: white; z-index: 2147483646">Cookies</div>${lines(60, 30, 'jadeite')}`);
  try {
    await run(`(() => { const p = document.querySelectorAll('#banner p')[30]; scrollTo(0, p.offsetTop - (innerHeight - 50)); })()`);
    const { start, scrolls, place } = await revealed('jadeite', [], [], ['#cookie-bar']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the banner covers the match');
    assert.ok(scrolls[1] > start.scrolls[1], 'the page did not scroll down');
    assert.equal(await clearOf('#cookie-bar', 'above'), true);
    assert.deepEqual(place.covered, [false]);
  } finally {
    await removeFlow('banner');
  }
});

// A fixed bar is cleared by whatever can move the match against it: the viewport, a <body> that scrolls itself, then the
// match's boxes from the outside in, each by what is left of the distance; one that moves nothing of the match is put back.

const HEADER = 'position: fixed; top: 0; left: 0; right: 0; height: 60px; background: white; z-index: 2147483646';

test('a match under a fixed header over a full-height <main> that scrolls is cleared by the main, the page behind stays, and a seen match moves nothing', async () => {
  await addFlow('fixedmain', `<header id="main-bar" style="${HEADER}">Header</header><main id="main-pane" style="position: fixed; inset: 0;`
    + ` overflow: auto; background: white; z-index: 2147483645">${lines(80, 40, 'almandine').replace('message 46 plain', 'message 46 pyrope')}</main>`);
  try {
    await run(`(() => { const pane = document.getElementById('main-pane'); pane.scrollTop += pane.querySelectorAll('p')[40].getBoundingClientRect().top - 20; })()`);
    const seen = await revealed('pyrope', ['main-pane'], undefined, ['#main-bar']);
    assert.deepEqual([seen.start.place.viewport, seen.start.place.covered], [true, [false]], 'pyrope starts in the viewport, uncovered');
    assert.deepEqual(seen.scrolls, seen.start.scrolls, 'something scrolled for a match that is seen');
    const { start, scrolls, place } = await revealed('almandine', ['main-pane'], undefined, ['#main-bar']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the header covers the match');
    assert.ok(start.scrolls[1] > 0, 'the page behind the main is not scrolled, so this tests nothing about it');
    assert.deepEqual(scrolls.slice(0, 2), start.scrolls.slice(0, 2), 'the page behind the main moved');
    assert.ok(scrolls[3] < start.scrolls[3], 'the main did not scroll up');
    assert.equal(await clearOf('#main-bar', 'below'), true);
    assert.deepEqual(place.covered, [false]);
  } finally {
    await removeFlow('fixedmain');
  }
});

test('a match under a fixed header that the page can scroll only part of the way clear of is cleared by the page and then the <main> it is in', async () => {
  // The page is 20 px down, and the match has to move about 50: the page moves the 20 it can, the main the rest.
  await run(`(() => { const box = document.createElement('div'); box.id = 'partial';
    box.innerHTML = ${JSON.stringify(`<header id="partial-bar" style="${HEADER}">Header</header><main id="partial-pane" style="height: 100vh; overflow: auto">${lines(80, 40, 'demantoid')}</main>`)};
    document.body.prepend(box); scrollTo({ top: 20, behavior: 'instant' });
    const pane = document.getElementById('partial-pane'); pane.scrollTop += pane.querySelectorAll('p')[40].getBoundingClientRect().top - 20; })()`);
  try {
    const { start, scrolls, place } = await revealed('demantoid', ['partial-pane'], undefined, ['#partial-bar']);
    assert.deepEqual([start.place.viewport, start.place.covered, start.scrolls[1]], [true, [true], 20], 'the header covers the match, the page 20 px down');
    assert.equal(scrolls[1], 0, 'the page did not scroll up as far as it can');
    assert.ok(scrolls[3] < start.scrolls[3], 'the main did not scroll up');
    assert.equal(await clearOf('#partial-bar', 'below'), true);
    assert.deepEqual(place.covered, [false]);
  } finally {
    await removeFlow('partial');
  }
});

test('on a page whose <body> scrolls, a match under a fixed or a sticky header is cleared by the body, and a seen match moves nothing', async () => {
  // <html> has overflow: hidden, so the <body> scrolls itself and the viewport cannot.
  for (const position of ['fixed', 'sticky']) {
    await run(`(() => { document.documentElement.style.cssText = 'height: 100%; overflow: hidden'; document.body.style.cssText = 'height: 100%; overflow: auto; margin: 0';
      const box = document.createElement('div'); box.id = 'bodyscroll';
      box.innerHTML = ${JSON.stringify(`<header id="body-bar" style="${HEADER.replace('fixed', position)}">Header</header>`
        + lines(60, 30, 'uvarovite').replace('message 36 plain', 'message 36 spessartine'))};
      document.getElementById('p-contents').before(box);
      document.body.scrollTop += box.querySelectorAll('p')[30].getBoundingClientRect().top - 20; })()`);
    try {
      const seen = await revealed('spessartine', [], ['document.body'], ['#body-bar']);
      assert.deepEqual([seen.start.place.viewport, seen.start.place.covered], [true, [false]], `spessartine starts in the viewport, uncovered by the ${position} header`);
      assert.deepEqual(seen.scrolls, seen.start.scrolls, `something scrolled for a match that is seen, ${position}`);
      const { start, scrolls, place } = await revealed('uvarovite', [], ['document.body'], ['#body-bar']);
      assert.deepEqual([start.place.viewport, start.place.covered, start.scrolls[1]], [true, [true], 0], `the ${position} header covers the match`);
      assert.ok(start.scrolls[3] > 0, 'the body is not scrolled');
      assert.equal(scrolls[1], 0);
      assert.ok(scrolls[3] < start.scrolls[3], `the body did not scroll up for the ${position} header`);
      assert.equal(await clearOf('#body-bar', 'below'), true, `the ${position} header still covers the match`);
      assert.deepEqual(place.covered, [false]);
    } finally {
      await run(`document.getElementById('bodyscroll')?.remove(); document.body.scrollTop = 0;
        document.documentElement.style.cssText = ''; document.body.style.cssText = ''; scrollTo({ top: 0, behavior: 'instant' })`);
    }
  }
});

test('a match under a sticky table heading in a pane scrolls the pane clear of it, and the page stays', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => `<tr><td style="height: 24px">row ${i} ${i === 12 ? 'turquoise' : 'plain'}</td></tr>`).join('');
  await addFlow('th', `<div id="th-pane" style="height: 200px; overflow: auto; width: 400px"><table style="border-collapse: collapse; width: 100%">`
    + `<thead><tr><th id="th-bar" style="position: sticky; top: 0; height: 30px; background: white; z-index: 2">Name</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  try {
    await run(`(() => { const pane = document.getElementById('th-pane'), row = pane.querySelectorAll('tbody tr')[12];
      pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 10; })()`);
    const { start, scrolls, place } = await revealed('turquoise', ['th-pane'], undefined, ['#th-bar']);
    assert.deepEqual([start.place.viewport, start.place.boxes, start.place.covered], [true, [true], [true]], 'the heading covers the match');
    assert.equal(scrolls[1], start.scrolls[1], 'the page moved');
    assert.ok(scrolls[3] < start.scrolls[3], 'the pane did not scroll up');
    assert.equal(await clearOf('#th-bar', 'below'), true);
    assert.deepEqual(place.covered, [false]);
  } finally {
    await removeFlow('th');
  }
});

test('a match under a transparent full-page overlay is left where it is', async () => {
  await addFlow('veil', `<div id="veil" style="position: fixed; inset: 0; z-index: 2147483646"></div>${lines(60, 30, 'zoisite')}`);
  try {
    await lineAt('veil', 30, 150);
    const { start, scrolls, place } = await revealed('zoisite', [], [], ['#veil']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the overlay is over the match');
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled although the overlay is not a bar');
    assert.equal(place.viewport, true);
  } finally {
    await removeFlow('veil');
  }
});

test('a match behind a modal backdrop is left where it is', async () => {
  await addFlow('modal', `<div id="backdrop" style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 2147483646"><div style="width: 200px; height: 100px; margin: 100px auto; background: white">Dialog</div></div>${lines(60, 30, 'sunstone')}`);
  try {
    await lineAt('modal', 30, 300);
    const { start, scrolls } = await revealed('sunstone', [], [], ['#backdrop']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the backdrop is over the match');
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled although the backdrop is not a bar');
  } finally {
    await removeFlow('modal');
  }
});

test('a match whose text takes no pointer events, in a sticky toolbar, is left where it is', async () => {
  // The toolbar is what is on top of the label's middle, and the label is inside it.
  await addFlow('ghost', `<div id="toolbar" style="position: sticky; top: 0; height: 40px; background: white; z-index: 5"><span style="pointer-events: none">pyrite label</span></div>${lines(60, -1, '')}`);
  try {
    await run(`(() => { scrollTo(0, document.querySelectorAll('#ghost p')[20].offsetTop - 200); })()`);
    const { start, scrolls } = await revealed('pyrite', [], [], ['#toolbar']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the toolbar is on top of the label');
    assert.deepEqual(scrolls, start.scrolls);
  } finally {
    await removeFlow('ghost');
  }
});

test('a match inside the sticky header itself is left where it is', async () => {
  await addFlow('inside', `<header id="inside-bar" style="position: sticky; top: 0; height: 60px; background: white; z-index: 5">marcasite header</header>${lines(60, -1, '')}`);
  try {
    await run(`(() => { scrollTo(0, document.querySelectorAll('#inside p')[20].offsetTop - 200); })()`);
    const { start, scrolls } = await revealed('marcasite', [], [], ['#inside-bar']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]]);
    assert.deepEqual(scrolls, start.scrolls);
  } finally {
    await removeFlow('inside');
  }
});

test('a match under a dropdown that hangs from a sticky header is left where it is', async () => {
  await addFlow('drop', `<header id="drop-bar" style="position: sticky; top: 0; height: 60px; background: white; z-index: 5">Menu`
    + `<div id="drop-menu" style="position: absolute; top: 60px; left: 0; width: 300px; height: 100px; background: #eee">Items</div></header>${lines(60, 30, 'hematite')}`);
  try {
    await lineAt('drop', 30, 100);
    const { start, scrolls } = await revealed('hematite', [], [], ['#drop-menu']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the dropdown is over the match');
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled for a dropdown');
  } finally {
    await removeFlow('drop');
  }
});

test('a match in a cookie banner, under the banner\'s own button, is left where it is', async () => {
  // The banner holds the match and moves with it, so no scroll clears the button.
  await addFlow('holder', `<div id="holder-bar" style="position: fixed; bottom: 0; left: 0; right: 0; height: 80px; background: white; z-index: 2147483646">`
    + `<span>We use cordierite cookies</span><button id="holder-button" style="position: absolute; left: 0; top: 0; width: 300px; height: 40px">OK</button></div>${lines(60, -1, '')}`);
  try {
    await run(`scrollTo(0, document.querySelectorAll('#holder p')[20].offsetTop - 200)`);
    const { start, scrolls } = await revealed('cordierite', [], [], ['#holder-button']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the button covers the match');
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled for a bar that holds the match');
  } finally {
    await removeFlow('holder');
  }
});

// A bar inside an open web component: from outside, the hit test gives only the component's host.

const BANNER = 'position: fixed; bottom: 0; left: 0; right: 0; height: 80px; background: white; z-index: 2147483646';
/**
 * Where the current match is against `bar` (an expression giving an element): whether the bar's own tree, hit-tested at the
 * match's middle, gives the bar or something in it; whether the match is inside the viewport; and the id of what the
 * document's hit test gives there.
 */
const against = (bar) => run(`(() => { const r = [...CSS.highlights.get('text-find-plus-current')][0].getBoundingClientRect(), b = ${bar};
  const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2, top = b.getRootNode().elementFromPoint(x, y);
  return { covered: Boolean(top && (top === b || b.contains(top))), viewport: r.top >= 0 && r.bottom <= innerHeight,
    page: document.elementFromPoint(x, y)?.id ?? null }; })()`);

test('a match under a cookie banner inside a component on a plain div is scrolled clear of it', async () => {
  await addFlow('cbanner', `<div id="cbanner-host"></div>${lines(60, 30, 'hambergite')}`);
  await run(`document.getElementById('cbanner-host').attachShadow({ mode: 'open' }).innerHTML = '<div style="${BANNER}">Cookies</div>'`);
  const banner = `document.getElementById('cbanner-host').shadowRoot.firstChild`;
  try {
    await run(`(() => { const p = document.querySelectorAll('#cbanner p')[30]; scrollTo(0, p.offsetTop - (innerHeight - 50)); })()`);
    assert.equal(await count({ any: 'hambergite' }), 1);
    await run('__textFindPlusEngine.show(0, 5000, false)');
    const y = await run('scrollY');
    assert.deepEqual(await against(banner), { covered: true, viewport: true, page: 'cbanner-host' }, 'the banner covers the match, and the page sees only its host');
    await run('__textFindPlusEngine.show(0, 5000)');
    assert.ok((await run('scrollY')) > y, 'the page did not scroll down');
    assert.deepEqual(await against(banner), { covered: false, viewport: true, page: '' });
  } finally {
    await removeFlow('cbanner');
  }
});

test('a match shown through a slot, under a fixed or sticky header inside an app shell\'s open root, is scrolled clear of it', async () => {
  for (const position of ['fixed', 'sticky']) {
    await addFlow('shell', `<app-shell id="shell-host" style="display: block">${lines(60, 30, 'eudialyte')}</app-shell>`);
    await run(`document.getElementById('shell-host').attachShadow({ mode: 'open' }).innerHTML = '<header style="position: ${position}; top: 0; left: 0; right: 0;`
      + ` height: 60px; background: white; z-index: 5">Header</header><main><slot></slot></main>'`);
    const header = `document.getElementById('shell-host').shadowRoot.firstChild`;
    try {
      await run(`(() => { const p = document.querySelectorAll('#shell p')[30]; scrollTo(0, scrollY + p.getBoundingClientRect().top - 20); })()`);
      assert.equal(await count({ any: 'eudialyte' }), 1);
      await run('__textFindPlusEngine.show(0, 5000, false)');
      const y = await run('scrollY');
      assert.deepEqual(await against(header), { covered: true, viewport: true, page: 'shell-host' }, `the ${position} header covers the match, and the page sees only its host`);
      await run('__textFindPlusEngine.show(0, 5000)');
      assert.ok((await run('scrollY')) < y, `the page did not scroll up for the ${position} header`);
      assert.deepEqual(await against(header), { covered: false, viewport: true, page: '' }, `the ${position} header still covers the match`);
    } finally {
      await removeFlow('shell');
    }
  }
});

test('a fixed bar inside the match\'s own paragraph is left where it is, in its light DOM or in a component there', async () => {
  // The match's element and whatever is inside it in the flat tree are no cover, as the spec has it. The descent into the
  // component passes its host, which is inside the paragraph.
  for (const [word, bar] of [[`clinohumite <span id="own-bar" style="${BANNER}">Tip</span>`, `document.getElementById('own-bar')`],
    ['andradite <x-tip id="own-tip"></x-tip>', `document.getElementById('own-tip').shadowRoot.firstChild`]]) {
    const name = word.split(' ')[0];
    await addFlow('ownbar', lines(60, 30, word));
    await run(`document.getElementById('own-tip')?.attachShadow({ mode: 'open' }).append(Object.assign(document.createElement('div'), { textContent: 'Tip' }));
      document.getElementById('own-tip')?.shadowRoot.firstChild.setAttribute('style', ${JSON.stringify(BANNER)})`);
    try {
      await run(`(() => { const p = document.querySelectorAll('#ownbar p')[30]; scrollTo(0, p.offsetTop - (innerHeight - 50)); })()`);
      assert.equal(await count({ any: name }), 1);
      await run('__textFindPlusEngine.show(0, 5000, false)');
      const y = await run('scrollY');
      assert.deepEqual((await against(bar)).covered, true, `the bar covers ${name}`);
      await run('__textFindPlusEngine.show(0, 5000)');
      assert.equal(await run('scrollY'), y, `the page scrolled for a bar inside the paragraph that holds ${name}`);
    } finally {
      await removeFlow('ownbar');
    }
  }
});

/** A pane 300 px tall holding a table whose first column sticks to its left edge, with `word` in row 12's second cell. */
const stickyColumn = (id, word) => `<div id="${id}" style="height: 300px; overflow: auto; width: 400px"><table style="border-collapse: collapse">`
  + Array.from({ length: 40 }, (_, i) => `<tr><td class="first" style="position: sticky; left: 0; min-width: 120px; background: #ccc">row ${i}</td>`
    + `<td style="min-width: 120px">${i === 12 ? word : 'cell'}</td>${'<td style="min-width: 120px">cell</td>'.repeat(6)}</tr>`).join('') + '</table></div>';

test('a match under a first column that sticks only sideways is left where it is', async () => {
  // The column's top and bottom are auto: it sticks to the pane's left edge and scrolls up and down with its row, so no
  // scroll clears it. The pane is scrolled both ways, so a scroll either way would show.
  await addFlow('column', stickyColumn('column-pane', 'vesuvianite'));
  try {
    await run(`(() => { const pane = document.getElementById('column-pane'); pane.scrollLeft = 100; pane.scrollTop = 150; })()`);
    const { start, scrolls } = await revealed('vesuvianite', ['column-pane'], undefined, ['#column-pane .first']);
    assert.deepEqual([start.place.viewport, start.place.boxes, start.place.covered], [true, [true], [true]], 'the column covers the match');
    assert.deepEqual(start.scrolls.slice(2), [100, 150]);
    assert.deepEqual(scrolls, start.scrolls, 'something scrolled for a column that sticks only sideways');
  } finally {
    await removeFlow('column');
  }
});

test('a match under a part of a sticky header that sticks only sideways is scrolled clear of the header', async () => {
  // The logo sticks to the left of a header that scrolls sideways, and is passed over: the header sticks to the top.
  await addFlow('logo', `<header id="logo-bar" style="position: sticky; top: 0; height: 60px; background: white; z-index: 5; display: flex; overflow-x: auto">`
    + `<div id="logo-mark" style="position: sticky; left: 0; flex: none; width: 300px; height: 60px; background: #ccc">Logo</div>`
    + `<div style="flex: none; width: 2000px">Menu</div></header>${lines(60, 30, 'scapolite')}`);
  try {
    await lineAt('logo', 30, 20);
    const { start, scrolls, place } = await revealed('scapolite', [], [], ['#logo-mark']);
    assert.deepEqual([start.place.viewport, start.place.covered], [true, [true]], 'the logo covers the match');
    assert.ok(scrolls[1] < start.scrolls[1], 'the page did not scroll up');
    assert.equal(await clearOf('#logo-bar', 'below'), true);
    assert.deepEqual(place.covered, [false]);
  } finally {
    await removeFlow('logo');
  }
});

// Every scroll is instant, whatever the page's scroll-behavior says, as desktop Chrome's find scrolls: a smooth one
// would still be on its way when the next box is measured.

/** Show the current match and, in the same task, say where it is (see matchPlace). */
const showNow = (boxes, bars = []) => run(`(() => { __textFindPlusEngine.show(0, 5000); return ${placeOf(boxes, bars)}; })()`);

test('a match in a smooth pane inside a box is in both as soon as show() returns', async () => {
  await addFlow('smooth', '<div id="smooth-outer" style="height: 150px; overflow: auto; width: 400px"><div style="height: 300px"></div>'
    + '<div id="smooth-inner" style="width: 300px; height: 80px; overflow: auto; scroll-behavior: smooth"><div style="height: 150px"></div>'
    + '<p style="margin: 0">benitoite</p><div style="height: 200px"></div></div><div style="height: 300px"></div></div>', 100);
  try {
    const boxes = ['smooth-outer', 'smooth-inner'].map((id) => `document.getElementById('${id}')`);
    assert.equal(await count({ any: 'benitoite' }), 1);
    await run('__textFindPlusEngine.show(0, 5000, false)');
    const start = await matchPlace(boxes);
    assert.deepEqual([start.viewport, start.boxes], [true, [false, false]], 'the match starts in the viewport and out of both');
    const now = await showNow(boxes);
    assert.deepEqual([now.viewport, now.boxes], [true, [true, true]]);
  } finally {
    await removeFlow('smooth');
  }
});

test('a match under a sticky header on a smooth page is clear of it as soon as show() returns', async () => {
  await addFlow('smoothbar', `<header id="smooth-bar" style="position: sticky; top: 0; height: 60px; background: white; z-index: 5">Site header</header>${lines(60, 30, 'enstatite')}`);
  try {
    await lineAt('smoothbar', 30, 20);
    await run(`document.documentElement.style.scrollBehavior = 'smooth'`);
    assert.equal(await count({ any: 'enstatite' }), 1);
    await run('__textFindPlusEngine.show(0, 5000, false)');
    assert.deepEqual((await matchPlace([], ['#smooth-bar'])).covered, [true], 'the header covers the match');
    const now = await showNow([], ['#smooth-bar']);
    assert.deepEqual([now.viewport, now.covered], [true, [false]]);
  } finally {
    await run(`document.documentElement.style.scrollBehavior = ''`);
    await removeFlow('smoothbar');
  }
});

test('a match in a frame below the fold of a smooth page is on screen as soon as show() returns', async () => {
  // The engine in the frame can't measure the page around the frame: only its scrollIntoView moves that page.
  const win = `document.getElementById('same').contentWindow`;
  await run(`(() => { const box = ${win}.document.createElement('div'); box.id = 'fold-box';
    box.innerHTML = '<div style="height: 1000px"></div><p>diopside</p><div style="height: 1000px"></div>';
    ${win}.document.body.append(box); ${win}.eval(${JSON.stringify(engineSource)}); })()`);
  try {
    assert.equal(await run(`document.getElementById('same').getBoundingClientRect().top > innerHeight`), true, 'the frame starts below the fold');
    await run(`document.documentElement.style.scrollBehavior = 'smooth'`);
    assert.equal((await run(`${win}.__textFindPlusEngine.search(${queryOf({ any: 'diopside' })})`)).count, 1);
    const now = await run(`(() => { ${win}.__textFindPlusEngine.show(0, 5000);
      const r = [...${win}.CSS.highlights.get('text-find-plus-current')][0].getBoundingClientRect();
      const frame = document.getElementById('same').getBoundingClientRect();
      return { page: frame.top + r.top >= 0 && frame.top + r.bottom <= innerHeight, frame: r.top >= 0 && r.bottom <= ${win}.innerHeight }; })()`);
    assert.deepEqual(now, { page: true, frame: true });
  } finally {
    await run(`(() => { ${win}.__textFindPlusEngine?.clear(true); delete ${win}.__textFindPlusEngine; delete ${win}.__textFindPlus;
      ${win}.document.getElementById('fold-box')?.remove(); document.documentElement.style.scrollBehavior = ''; scrollTo({ top: 0, behavior: 'instant' }); })()`);
  }
});

// ---------- live updates (spec §3) ----------

const nextTask = 'new Promise((done) => setTimeout(done))'; // MutationObserver records have been delivered by then

test('the first change after a search is reported once, until the next search, in the page, a component or one nested in it', async () => {
  // #wc-nested's root holds a component with a root of its own: the observer watches that inner root too.
  const nested = `document.getElementById('wc-nested').shadowRoot.firstElementChild.shadowRoot`;
  try {
    const seen = await run(`(async () => {
      let changes = 0;
      const engine = __textFindPlusEngine.createEngine(document, { onChange: () => changes++ });
      const q = ${queryOf({ any: 'cheap' })};
      const counts = [];
      engine.search(q);
      engine.show(2, 5000); // paints and scrolls
      await ${nextTask};
      counts.push(changes); // ...and changes nothing
      __live.add('beacon one');
      await ${nextTask};
      __live.add('beacon two');
      await ${nextTask};
      counts.push(changes);
      engine.search(q);
      const p = document.createElement('p');
      p.id = 'beacon-inside';
      p.textContent = 'beacon inside';
      document.getElementById('wc-open').shadowRoot.append(p);
      await ${nextTask};
      counts.push(changes, engine._watching);
      engine.search(q);
      const deep = document.createElement('p');
      deep.id = 'beacon-nested';
      deep.textContent = 'beacon nested';
      ${nested}.append(deep);
      await ${nextTask};
      counts.push(changes);
      engine.clear(false);
      __live.add('beacon three');
      await ${nextTask};
      counts.push(changes, engine._watching);
      engine.search(q);
      engine.clear(false); // before anything was reported: only a disconnected observer stays silent
      __live.add('beacon four');
      await ${nextTask};
      counts.push(changes);
      return counts;
    })()`);
    assert.deepEqual(seen, [0, 1, 2, true, 3, 3, false, 3]);
  } finally {
    await run(`__live.reset(); document.getElementById('wc-open').shadowRoot.getElementById('beacon-inside')?.remove();
      ${nested}.getElementById('beacon-nested')?.remove(); scrollTo(0, 0)`);
  }
});

test('keepAt finds the kept match again after the page changes', async () => {
  try {
    const kept = await run(`(() => {
      const engine = __textFindPlusEngine.createEngine(document);
      const q = ${queryOf({ any: 'beacon' })};
      __live.add('beacon a', { id: 'a' });
      __live.add('beacon b', { id: 'b' });
      const out = [engine.search(q).keepAt];             // [a, b]; nothing kept
      __live.add('beacon c', { id: 'c', first: true });  // [c, a, b]
      out.push(engine.search(q, null, 1).keepAt);        // b moved from 1 to 2
      __live.remove('b');                                 // [c, a]
      out.push(engine.search(q, null, 2).keepAt);        // b's text is gone
      document.querySelector('[data-id="a"]').firstChild.data = 'nothing here'; // [c]
      out.push(engine.search(q, null, 1).keepAt);        // a was edited away: the next one along
      engine.clear(true);
      return out;
    })()`);
    assert.deepEqual(kept, [-1, 2, -1, 1]);
  } finally {
    await run('__live.reset()');
  }
});

test('show can leave the page where it is', async () => {
  await run(`(() => { const s = document.createElement('div'); s.id = 'spacer'; s.style.height = '3000px';
    document.getElementById('p-split').before(s); scrollTo(0, 0); })()`);
  try {
    await search({ any: 'quick' });
    await run('__textFindPlusEngine.show(0, 5000, false)');
    assert.equal(await run('scrollY'), 0);
    await run('__textFindPlusEngine.show(0, 5000)');
    assert.ok((await run('scrollY')) > 0, 'a normal show scrolls');
  } finally {
    await run(`document.getElementById('spacer').remove(); scrollTo(0, 0)`);
  }
});

test('the observer sees text, hidden, class, style and open changes, and ignores other attributes', async () => {
  await run(`(() => { const box = document.createElement('div'); box.id = 'watched';
    box.innerHTML = '<p id="w-text">quillfeather</p><p id="w-hide">marlinspike</p><p id="w-class">tidewrack</p>'
      + '<p id="w-style">brindlemoss</p><details id="w-open"><summary>fernhollow</summary>thistledown</details>';
    document.body.append(box); })()`);
  try {
    const reports = await run(`(async () => {
      let changes = 0;
      const engine = __textFindPlusEngine.createEngine(document, { onChange: () => changes++ });
      const q = ${queryOf({ any: 'quillfeather' })};
      const el = (id) => document.getElementById(id);
      const edits = [
        () => { el('w-text').firstChild.data = 'quillfeather again'; }, // characterData
        () => { el('w-hide').hidden = true; },
        () => { el('w-class').className = 'shouty'; },
        () => { el('w-style').style.color = 'red'; },
        () => { el('w-open').open = true; },
        () => { el('w-text').setAttribute('data-foo', 'bar'); }, // not an attribute worth a refresh
      ];
      const reports = [];
      for (const edit of edits) {
        const before = changes;
        engine.search(q); // a fresh search each time: a search re-arms the one report
        edit();
        await ${nextTask};
        reports.push(changes - before);
      }
      engine.clear(false);
      return reports;
    })()`);
    assert.deepEqual(reports, [1, 1, 1, 1, 1, 0]);
  } finally {
    await run(`document.getElementById('watched').remove()`);
  }
});
