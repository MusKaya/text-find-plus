// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAP, combine, locate, countLabel, resultsFrom, keptIndex, nextRefreshAt, LIVE_PAUSED } from '../src/popup/frames.js';

const result = (over = {}) => ({ frameId: 0, count: 0, capped: false, timedOut: false, termCounts: [], anyCount: 0, longest: 0, ...over });
const flat = { kind: 'flat', source: 'x', flags: 'gui' };
const allQuery = (labels, extra = {}) => ({ kind: 'all', flags: 'gui', ordered: false, terms: labels.map((label) => ({ label, source: label })), any: null, ...extra });

test('sums and fills limits in page order', () => {
  assert.equal(CAP, 5000);
  const c = combine([result({ frameId: 0, count: 3000 }), result({ frameId: 4, count: 2500 }), result({ frameId: 9, count: 10 })], flat);
  assert.equal(c.ok, true);
  assert.equal(c.total, 5000);
  assert.equal(c.capped, true);
  assert.deepEqual(c.frames.map((f) => f.limit), [3000, 2000, 0]);
  assert.deepEqual(c.frames.map((f) => f.frameId), [0, 4, 9]);
  assert.ok(c.status.includes('Showing the first 5000 matches'));
});

test('all words missing across frames', () => {
  const c = combine([result({ count: 3, termCounts: [3, 0] }), result({ frameId: 4, count: 1, termCounts: [1, 0] })], allQuery(['cheap', 'zebra']));
  assert.equal(c.ok, false);
  assert.equal(c.total, 0);
  assert.deepEqual(c.status, ['Not on this page: zebra']);
});

test('present across frames', () => {
  const c = combine([result({ count: 3, termCounts: [3, 0] }), result({ frameId: 4, count: 2, termCounts: [0, 2] })], allQuery(['cheap', 'zebra']));
  assert.equal(c.ok, true);
  assert.equal(c.total, 5);
  assert.deepEqual(c.status, []);
});

test('never in order', () => {
  const c = combine([result({ count: 0, termCounts: [1, 3] })], allQuery(['fox', 'colour'], { ordered: true }));
  assert.equal(c.ok, false);
  assert.deepEqual(c.status, ['All words are on the page, but never in this order']);
});

test('in-order hint', () => {
  const c = combine([result({ count: 2, termCounts: [5, 3] })], allQuery(['flight', 'cheap'], { ordered: true }));
  assert.equal(c.ok, true);
  assert.ok(c.status.includes('Each match is one in-order sequence'));
});

test('any missing', () => {
  const c = combine([result({ count: 8, termCounts: [3, 5], anyCount: 0 })],
    allQuery(['cheap', 'flight'], { any: { source: 'berlin|paris', labels: ['berlin', 'paris'] } }));
  assert.equal(c.ok, false);
  assert.deepEqual(c.status, ['None of these are on this page: berlin, paris']);
});

test('timed out', () => {
  const c = combine([result({ count: 800, timedOut: true }), result({ frameId: 3, count: 12 })], flat);
  assert.equal(c.total, 812);
  assert.equal(c.timedOut, true);
  assert.ok(c.status.includes('Stopped early because this page is very large. Showing the first 812 matches.'));
});

test('longest is the maximum across frames', () => {
  assert.equal(combine([result({ count: 1, longest: 9 }), result({ frameId: 2, count: 1, longest: 40 })], flat).longest, 40);
});

test('locate', () => {
  const frames = [{ frameId: 0, limit: 3 }, { frameId: 7, limit: 2 }];
  assert.deepEqual(locate(frames, 0), { frameId: 0, local: 0 });
  assert.deepEqual(locate(frames, 4), { frameId: 7, local: 1 });
  assert.equal(locate(frames, 5), null);
  assert.equal(locate(frames, -1), null);
});

test('countLabel', () => {
  assert.equal(countLabel(0, 27, false, true), '1 of 27');
  assert.equal(countLabel(0, 5000, true, true), '1 of 5000+');
  assert.equal(countLabel(-1, 0, false, true), 'No matches');
  assert.equal(countLabel(-1, 0, false, false), '');
});

test('a timed-out search never claims words are missing', () => {
  const c = combine([result({ count: 2, termCounts: [2, 0], timedOut: true })], allQuery(['cheap', 'istanbul']));
  assert.equal(c.ok, true);
  assert.ok(!c.status.some((s) => s.startsWith('Not on this page')), c.status.join(' | '));
  assert.ok(c.status.includes('Stopped early because this page is very large. Showing the first 2 matches.'));
  const any = combine([result({ count: 8, termCounts: [3, 5], anyCount: 0, timedOut: true })],
    allQuery(['cheap', 'flight'], { any: { source: 'berlin', labels: ['berlin'] } }));
  assert.ok(!any.status.some((s) => s.startsWith('None of these')), any.status.join(' | '));
});

test('frames that did not answer count as stopped early', () => {
  const results = resultsFrom([null, { type: 'result', seq: 1, count: 3, capped: false, timedOut: false, termCounts: [], anyCount: 0, longest: 5 }], [0, 4]);
  assert.deepEqual(results.map((r) => [r.frameId, r.count, r.timedOut]), [[0, 0, true], [4, 3, false]]);
  assert.equal(combine(results, flat).timedOut, true);
});

test('a search that stopped early pauses live updates, and says so right after', () => {
  assert.equal(LIVE_PAUSED, 'Live updates are paused because this page is very large.');
  const c = combine([result({ count: 3, timedOut: true })], flat);
  assert.deepEqual(c.status.slice(-2), ['Stopped early because this page is very large. Showing the first 3 matches.', LIVE_PAUSED]);
  assert.ok(!combine([result({ count: 3 })], flat).status.includes(LIVE_PAUSED));
});

test('frames that did not answer keep nothing', () => {
  assert.equal(resultsFrom([null], [0])[0].keepAt, -1);
  assert.equal(resultsFrom([{ type: 'result', seq: 1, count: 2, keepAt: 1 }], [0])[0].keepAt, 1);
});

test('keptIndex', () => {
  const frames = [{ frameId: 0, limit: 3 }, { frameId: 7, limit: 2 }];
  assert.equal(keptIndex(frames, 0, 1, 1, 5), 1, 'kept in the same frame');
  assert.equal(keptIndex(frames, 7, 1, 0, 5), 4, 'kept in a later frame');
  assert.equal(keptIndex(frames, 0, 3, 2, 5), 3, 'past the last match in its frame: the next frame\'s first');
  assert.equal(keptIndex(frames, 7, 2, 4, 5), 0, 'past the very last match: wrap to the first');
  assert.equal(keptIndex(frames, 0, -1, 4, 5), 4, 'text gone: same number');
  assert.equal(keptIndex(frames, 0, -1, 9, 5), 4, 'text gone: clamped to the last');
  assert.equal(keptIndex(frames, 3, 0, 2, 5), 2, 'owning frame gone: same number');
  assert.equal(keptIndex([{ frameId: 0, limit: 2 }, { frameId: 7, limit: 2 }], 0, 5, 0, 4), 2, 'the frame has more matches than the cap let through: the next frame\'s first, not a wrap');
  assert.equal(keptIndex(frames, undefined, -1, -1, 5), 0, 'nothing was current: the first');
  assert.equal(keptIndex([], 0, 0, 3, 0), -1, 'no matches');
});

test('nextRefreshAt', () => {
  assert.equal(nextRefreshAt(10_000, 2_000), 10_500, 'half a second after the change');
  assert.equal(nextRefreshAt(10_000, 9_800), 10_800, 'at least a second after the last search started');
});
