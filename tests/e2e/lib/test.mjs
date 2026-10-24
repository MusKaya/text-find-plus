// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// node:test with a time limit on every test and every hook, so one that stalls fails under its own name.
import { fileURLToPath } from 'node:url';
import { test as nodeTest, before as nodeBefore, after as nodeAfter, beforeEach as nodeBeforeEach, afterEach as nodeAfterEach } from 'node:test';

/** The slowest test takes about 8 s. */
export const TEST_TIMEOUT_MS = 30000;
/** The slowest hook launches a browser, which takes about 2 s. */
export const HOOK_TIMEOUT_MS = 60000;

export const test = (name, fn) => nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);

/** The file that registered a hook: the first frame of the stack that is not this file. */
function registeredBy() {
  for (const line of new Error().stack.split('\n').slice(1)) {
    const frame = /(file:\/\/[^\s)]+?):\d+:\d+\)?$/.exec(line)?.[1];
    if (frame && frame !== import.meta.url) return fileURLToPath(frame);
  }
  return 'an unknown file';
}

/**
 * `hook` with a time limit, and with the file that registered it in what it throws: node's own report names this file
 * for an `after` hook, and says only "test timed out" for the limit. A hook that runs longer than the limit fails with
 * a message that names it and its file; any other error it throws is passed on in a message that names them, with the
 * original as its `cause`.
 */
const limited = (hook, kind) => (fn) => {
  const where = `The ${kind} hook in ${registeredBy()}`;
  return hook(async (...args) => {
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${where} ran for more than ${HOOK_TIMEOUT_MS / 1000} s.`)), HOOK_TIMEOUT_MS);
    });
    const finished = Promise.resolve().then(() => fn(...args)).catch((cause) => {
      throw new Error(`${where} failed: ${cause?.message ?? cause}`, { cause });
    });
    try {
      return await Promise.race([finished, expired]);
    } finally {
      clearTimeout(timer);
    }
  });
};

export const before = limited(nodeBefore, 'before');
export const after = limited(nodeAfter, 'after');
export const beforeEach = limited(nodeBeforeEach, 'beforeEach');
export const afterEach = limited(nodeAfterEach, 'afterEach');
