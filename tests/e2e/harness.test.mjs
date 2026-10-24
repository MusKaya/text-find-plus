// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Harness tests: a command that can never be answered fails by name instead of hanging the run, a popup that
// is gone is named, and extension.test.mjs fails the test a popup crashed in.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, before, after } from './lib/test.mjs';
import { launch, openPage, assertPopupAlive, closeOpenedPopup } from './lib/chrome.mjs';

let browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLANK = 'data:text/html,<p>hi</p>';
/** A command in the page that never finishes, so it is still pending when its target goes. */
const hang = (session) => session.evaluate('new Promise(() => {})');
/** What a rejected promise says, or a complaint that it resolved. */
const failure = (promise) => promise.then(() => 'it resolved', (e) => e.message);
/** The sentence a failure must carry: the command, its session and its target, then what happened. */
const named = (page, what) => new RegExp(`^Runtime\\.evaluate on session ${page.session.id} \\(target ${page.targetId}\\): ${what}$`);

before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

test('a command still pending when its target closes fails at once, naming it', async () => {
  const page = await openPage(browser, BLANK);
  const pending = failure(hang(page.session));
  await sleep(100);
  const closed = Date.now();
  await browser.send('Target.closeTarget', { targetId: page.targetId });
  assert.match(await pending, named(page, 'the target went away \\(Target\\.detachedFromTarget\\) before it answered'));
  assert.ok(Date.now() - closed < 2000, 'it did not wait for a timeout');
});

test('a command sent to a target that has gone fails at once, naming it', async () => {
  const page = await openPage(browser, BLANK);
  const detached = browser.waitForEvent('Target.detachedFromTarget', (params) => params.sessionId === page.session.id);
  await browser.send('Target.closeTarget', { targetId: page.targetId });
  await detached;
  const sent = Date.now();
  assert.match(await failure(page.session.evaluate('1')), named(page, 'the target went away \\(Target\\.detachedFromTarget\\) before this command was sent'));
  assert.ok(Date.now() - sent < 1000, 'it did not wait for a timeout');
});

test('a target that crashes is named as crashed', async () => {
  const page = await openPage(browser, BLANK);
  const pending = failure(hang(page.session));
  await sleep(100);
  page.session.send('Page.crash').catch(() => {}); // the crash can cost the command its own answer
  assert.match(await pending, named(page, 'the target crashed \\(Inspector\\.targetCrashed\\) before it answered'));

  // A popup is such a target. A test that found its popup crashed says so, and why, instead of opening another one
  // (Chrome then exits), and the record is on the session for whatever runs after the test. Each message says which popup
  // it is in words that are true where it is raised: the popup may be one an earlier test opened.
  const why = 'the target crashed (Inspector.targetCrashed)';
  const gone = (which) => ({ message: `${which} is gone, and nothing closed it: ${why}.` });
  assert.equal(page.session.gone, why);
  assert.throws(() => assertPopupAlive(page), gone('The popup'));
  assert.throws(() => assertPopupAlive(page, 'The popup open at the end of this test'), gone('The popup open at the end of this test'));
  await assert.rejects(closeOpenedPopup(browser, page), gone('The popup being closed'));
});

test('a popup that is still there is closed, and is not mistaken for a gone one', async () => {
  const page = await openPage(browser, BLANK);
  assert.equal(page.session.gone, undefined);
  assertPopupAlive(page);
  const detached = browser.waitForEvent('Target.detachedFromTarget', (params) => params.sessionId === page.session.id);
  await closeOpenedPopup(browser, page);
  await detached;
  assert.equal(page.session.gone, 'the target went away (Target.detachedFromTarget)', 'it was closed');
});

test('a command Chrome never answers fails after the limit, naming it', async () => {
  const quick = await launch({ sendTimeoutMs: 2000 });
  try {
    const page = await openPage(quick, BLANK);
    const sent = Date.now();
    assert.match(await failure(hang(page.session)), named(page, 'no answer within 2000 ms'));
    const waited = Date.now() - sent;
    assert.ok(waited >= 1900 && waited < 6000, `failed after ${waited} ms`);
  } finally {
    await quick.close();
  }
});

// ---------- extension.test.mjs reports a popup that crashed ----------

const fixture = fileURLToPath(new URL('./popup-crash.fixture.mjs', import.meta.url));

/**
 * Run the tests of popup-crash.fixture.mjs whose names match `pattern` in a process of their own, with a browser of
 * their own (a crashed popup makes Chrome exit when the next one opens). Resolves with each test's TAP result by name,
 * { ok, error }, and the whole output (TAP, then stderr) for a failure message.
 */
function runFixture(pattern) {
  // Under `node --test` this process is told to report to its runner, and a child would inherit that and not print TAP.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return new Promise((done) => {
    execFile(process.execPath, ['--test-reporter=tap', `--test-name-pattern=${pattern}`, fixture], { env, timeout: 25000, killSignal: 'SIGTERM' }, (_, output, errors) => {
      const results = {};
      for (const [, failed, name, details] of output.matchAll(/^(not )?ok \d+ - (.+)\n((?:  .*\n)*)/gm)) {
        results[name] = { ok: !failed, ...(failed && { error: /^  error: '(.*)'$/m.exec(details)?.[1] }) };
      }
      done({ results, output: output + errors });
    });
  });
}

test('a popup that crashes after the last command of its test fails that test, naming the crash, and no other', async () => {
  const { results, output } = await runFixture('^crash fixture: (control|a popup that crashes after)');
  assert.deepEqual(results, {
    'crash fixture: control, a popup that opens and closes': { ok: true },
    'crash fixture: a popup that crashes after the last command of its test': {
      ok: false, error: `The afterEach hook in ${fileURLToPath(new URL('./extension.test.mjs', import.meta.url))} failed: `
        + 'The popup open at the end of this test is gone, and nothing closed it: the target crashed (Inspector.targetCrashed).',
    },
  }, output);
});

test('a popup that crashes before its test closes it fails that test, naming the crash', async () => {
  const { results, output } = await runFixture('^crash fixture: a popup that crashes before');
  assert.deepEqual(results, {
    'crash fixture: a popup that crashes before its test closes it': {
      ok: false, error: 'The popup being closed is gone, and nothing closed it: the target crashed (Inspector.targetCrashed).',
    },
  }, output);
});
