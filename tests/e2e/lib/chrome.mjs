// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Drives Chrome for Testing over the DevTools protocol pipe (Node built-ins only).
// The pipe is stdio fd 3 (commands to Chrome) and fd 4 (replies and events), each message JSON + "\0".
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

/** A command Chrome has not answered by then fails, naming the command and its session. */
const SEND_TIMEOUT_MS = 10000;
const CRASHED = 'the target crashed (Inspector.targetCrashed)';
const DETACHED = 'the target went away (Target.detachedFromTarget)';

/** Path to Chrome for Testing: CHROME_PATH, else the newest build in the Playwright cache. */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = [];
  for (const cache of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache)) {
      const m = /^chromium-(\d+)$/.exec(dir);
      if (!m) continue;
      const builds = [
        ...['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64'].map((s) => join(cache, dir, s, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
        ...['chrome-linux64', 'chrome-linux'].map((s) => join(cache, dir, s, 'chrome')),
      ];
      for (const path of builds) if (existsSync(path)) found.push([Number(m[1]), path]);
    }
  }
  if (!found.length) throw new Error('No Chrome for Testing found. Set CHROME_PATH or run `npx playwright install chromium`.');
  return found.sort((a, b) => b[0] - a[0])[0][1];
}

const stoppers = new Set(); // for each running browser: stop Chrome, then remove its profile
let listening = false;

// The signals that end a run early, with their numbers.
const TERMINATING = { SIGINT: 2, SIGTERM: 15 };

/**
 * `--test-timeout` ends a file that is still running by sending its process SIGTERM, and Ctrl-C sends SIGINT, so no
 * `after` runs and Chrome would leave its profile behind. On either signal this process stops every browser it
 * launched, removes their profiles (its own, never another run's), and exits as that signal would have ended it
 * (128 plus its number, so 143 and 130). Chrome is killed first because it keeps writing into the profile until it
 * notices that its pipe is closed.
 */
function stopOnTerminate(stop) {
  stoppers.add(stop);
  if (listening) return;
  listening = true;
  for (const [signal, number] of Object.entries(TERMINATING)) {
    process.once(signal, () => {
      for (const stopOne of stoppers) {
        try {
          stopOne();
        } catch (e) {
          console.error(`Could not remove a browser profile: ${e.message}`);
        }
      }
      process.exit(128 + number);
    });
  }
}

/**
 * Launch Chrome with extension debugging enabled.
 * `screen` ('<width>x<height>', headless only) sets the size of the screen Chrome reports, 800x600 when not given.
 * Chrome keeps a popup between its toolbar button and the edge of the screen, so on the default screen a popup
 * taller than about 500px is cut short and given a scrollbar.
 * @returns {Promise<{ send, on, waitForEvent, attach, close }>}
 */
export async function launch({ headless = true, sendTimeoutMs = SEND_TIMEOUT_MS, screen } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'tfplus-profile-'));
  const args = [
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1280,900',
  ];
  if (headless) args.push('--headless=new');
  if (headless && screen) args.push(`--screen-info={${screen}}`);
  args.push('about:blank');
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const removeProfile = () => rmSync(profile, { recursive: true, force: true });
  const stop = () => { proc.kill('SIGKILL'); removeProfile(); };
  stopOnTerminate(stop);
  const writer = proc.stdio[3];
  const reader = proc.stdio[4];

  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, method, sessionId, timer }
  const listeners = new Map();
  const gone = new Map(); // session id -> why its target is no more (the first reason Chrome gave)
  const targetOf = new Map(); // session id -> target id, for error messages
  const named = (method, sessionId) => (sessionId ? `${method} on session ${sessionId} (target ${targetOf.get(sessionId) ?? 'unknown'})` : method);
  /** Settle one pending command; a command that already settled (or timed out) is left alone. */
  const settle = (id, how, value) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p[how](value);
  };
  /** Fail every pending command that `matches`, so a vanished target or a dead Chrome is a failure, never a wait. */
  const failPending = (matches, why) => {
    for (const [id, p] of [...pending]) if (matches(p)) settle(id, 'reject', new Error(`${named(p.method, p.sessionId)}: ${why}`));
  };
  /** A session's target is no more: fail what it still owes, and every later command on it. */
  const markGone = (sessionId, reason) => {
    if (gone.has(sessionId)) return;
    gone.set(sessionId, reason);
    failPending((p) => p.sessionId === sessionId, `${reason} before it answered`);
  };
  let buf = Buffer.alloc(0);
  reader.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let end;
    while ((end = buf.indexOf(0)) !== -1) {
      const msg = JSON.parse(buf.subarray(0, end).toString('utf8'));
      buf = buf.subarray(end + 1);
      if (msg.id) {
        const p = pending.get(msg.id);
        if (!p) continue;
        if (msg.error) settle(msg.id, 'reject', new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
        else settle(msg.id, 'resolve', msg.result);
      } else {
        if (msg.method === 'Inspector.targetCrashed' && msg.sessionId) markGone(msg.sessionId, CRASHED);
        if (msg.method === 'Target.detachedFromTarget') markGone(msg.params.sessionId, DETACHED);
        for (const fn of listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
      }
    }
  });
  writer.on('error', () => {}); // Chrome may close the pipe first on shutdown
  let exited = false;
  proc.once('exit', () => {
    exited = true;
    failPending(() => true, 'Chrome exited before it answered');
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (exited) {
      reject(new Error(`${named(method, sessionId)}: Chrome had already exited`));
      return;
    }
    if (sessionId && gone.has(sessionId)) {
      reject(new Error(`${named(method, sessionId)}: ${gone.get(sessionId)} before this command was sent`));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => failPending((p) => p.id === id, `no answer within ${sendTimeoutMs} ms`), sendTimeoutMs);
    pending.set(id, { id, resolve, reject, method, sessionId, timer });
    writer.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0');
  });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };
  const waitForEvent = (method, predicate = () => true, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
    const off = on(method, (params, sessionId) => {
      if (!predicate(params, sessionId)) return;
      clearTimeout(timer);
      off();
      resolve(params);
    });
  });

  /** Attach to a target. The session tracks its execution contexts (for isolated worlds). */
  async function attach(targetId) {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    targetOf.set(sessionId, targetId);
    const contexts = [];
    on('Runtime.executionContextCreated', (p, sid) => { if (sid === sessionId) contexts.push(p.context); });
    on('Runtime.executionContextsCleared', (p, sid) => { if (sid === sessionId) contexts.length = 0; });
    return {
      id: sessionId,
      targetId,
      contexts,
      /** Why this session's target is no more (the first reason Chrome gave), or undefined while it is there. */
      get gone() { return gone.get(sessionId); },
      send: (method, params) => send(method, params, sessionId),
      async evaluate(expression, { contextId } = {}) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, sessionId);
        if (r.exceptionDetails) throw new Error(`Evaluation failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      },
    };
  }

  async function close() {
    const exited = new Promise((done) => proc.once('exit', done));
    send('Browser.close').catch(() => {});
    await Promise.race([exited, new Promise((done) => setTimeout(done, 3000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    stoppers.delete(stop);
    removeProfile();
  }

  return { send, on, waitForEvent, attach, close };
}

/** Install an unpacked extension; returns its id. */
export async function loadExtension(browser, dir) {
  const { id } = await browser.send('Extensions.loadUnpacked', { path: dir });
  return id;
}

const tabTargets = async (browser) => (await browser.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.map((t) => t.targetId);

/**
 * Open a new tab, wait for it to load, and return its page target id, its tab target id
 * (Extensions.triggerAction only accepts tab targets) and an attached page session.
 */
export async function openPage(browser, url) {
  const tabsBefore = new Set(await tabTargets(browser));
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const tabTargetId = (await tabTargets(browser)).find((id) => !tabsBefore.has(id));
  const session = await browser.attach(targetId);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await navigate(browser, session, url);
  return { targetId, tabTargetId, session };
}

/** Navigate an attached page session and wait for its load event. */
export async function navigate(browser, session, url) {
  const loaded = browser.waitForEvent('Page.loadEventFired', (_, sid) => sid === session.id, 10000);
  await session.send('Page.navigate', { url });
  await loaded;
}

async function findTarget(browser, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const hit = targetInfos.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** Click the toolbar action for a tab (grants activeTab like a real click) and attach to the popup. */
export async function triggerPopup(browser, extensionId, tabTargetId, timeoutMs = 5000) {
  const before = new Set((await browser.send('Target.getTargets')).targetInfos.map((t) => t.targetId));
  await browser.send('Extensions.triggerAction', { id: extensionId, targetId: tabTargetId });
  const info = await findTarget(browser, (t) => !before.has(t.targetId) && t.url.endsWith('/popup/popup.html'), timeoutMs);
  if (!info) throw new Error('Popup did not open');
  const session = await browser.attach(info.targetId);
  await session.send('Runtime.enable');
  const deadline = Date.now() + timeoutMs;
  while ((await session.evaluate('document.readyState')) !== 'complete') {
    if (Date.now() > deadline) throw new Error('Popup did not finish loading');
    await new Promise((r) => setTimeout(r, 20));
  }
  return { targetId: info.targetId, session };
}

/**
 * Throw if a popup a test opened is gone although nothing closed it (a crash, most likely), saying so and why.
 * A command that was not running when the popup went is not told, and Chrome exits if another popup is opened
 * after a crash, so without this the next test reports only that Chrome exited. `which` says which popup it is, in
 * words that are true where the check is made: the popup may be one an earlier test opened.
 */
export function assertPopupAlive(popup, which = 'The popup') {
  const why = popup?.session.gone;
  if (why) throw new Error(`${which} is gone, and nothing closed it: ${why}.`);
}

/** Close a popup the test opened, unless it is already gone, which is an error (see assertPopupAlive). */
export async function closeOpenedPopup(browser, popup) {
  assertPopupAlive(popup, 'The popup being closed');
  // A popup that went in the last instant is not reported yet; closing it again must not fail every test after it.
  await browser.send('Target.closeTarget', { targetId: popup.targetId }).catch((e) => { if (!/No target with given id/.test(e.message)) throw e; });
}

/** Size of a named CSS highlight as seen from the page (main world unless a context id is given). */
export async function pageHighlightSize(session, name, contextId) {
  return session.evaluate(`CSS.highlights.get(${JSON.stringify(name)})?.size ?? 0`, { contextId });
}

/**
 * Id of the extension's isolated world in a frame of an attached page (the main frame by default), where
 * the injected engine runs; undefined until the popup has injected it.
 */
export function isolatedContext(session, frameId = session.targetId) {
  return session.contexts.find((c) => c.auxData?.type === 'isolated' && c.auxData.frameId === frameId && c.name === 'Text Find+')?.id;
}
