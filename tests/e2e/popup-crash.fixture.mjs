// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Not a test of its own (its name doesn't end in .test.mjs, so `tests/e2e/*.test.mjs` skips it): harness.test.mjs runs it
// in a child process, to check that extension.test.mjs reports a popup that crashed. It imports that file whole, so the
// hooks it registers are the ones the real tests run under, and adds tests that crash the popup, which fail on purpose.
// A crashed popup makes Chrome 151 exit when another popup opens, so each child runs the control and at most one
// crash, chosen with --test-name-pattern.
import { test } from './lib/test.mjs';
import { browser, popup, open, closePopup } from './extension.test.mjs';

/** Crash the popup that is open and wait until the harness has seen it go. */
async function crashPopup() {
  const crashed = browser.waitForEvent('Inspector.targetCrashed', (_, sessionId) => sessionId === popup.session.id);
  popup.session.send('Page.crash').catch(() => {}); // the crash can cost the command its own answer
  await crashed;
}

test('crash fixture: control, a popup that opens and closes', async () => {
  await open();
  await closePopup();
});

test('crash fixture: a popup that crashes after the last command of its test', async () => {
  await open();
  await crashPopup();
});

test('crash fixture: a popup that crashes before its test closes it', async () => {
  await open();
  await crashPopup();
  await closePopup();
});
