// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Combines per-frame search results into one page-wide result (spec §7.3).
// Pure functions: no DOM, no Chrome APIs.

export const CAP = 5000;
export const LIVE_DELAY_MS = 500; // a live refresh waits this long after the first change...
export const LIVE_GAP_MS = 1000; // ...and starts at least this long after the previous search started
export const LIVE_PAUSED = 'Live updates are paused because this page is very large.';

const sum = (results, pick) => results.reduce((total, r) => total + pick(r), 0);

/**
 * Decide the page-wide outcome of a search. `results` are per-frame SearchResults (with frameId),
 * already in page order. When `ok` is false nothing should be painted.
 */
export function combine(results, query) {
  const status = [];
  let ok = true;
  // A search that stopped early saw only part of the page, so "missing" words prove nothing.
  const timedOut = results.some((r) => r.timedOut);

  if (query.kind === 'all' && timedOut) {
    if (query.ordered) status.push('Each match is one in-order sequence');
  } else if (query.kind === 'all') {
    const missing = query.terms.filter((t, k) => sum(results, (r) => r.termCounts[k] || 0) === 0).map((t) => t.label);
    if (missing.length) {
      ok = false;
      status.push(`Not on this page: ${missing.join(', ')}`);
    } else if (query.ordered && sum(results, (r) => Math.max(0, r.count - r.anyCount)) === 0) {
      ok = false;
      status.push('All words are on the page, but never in this order');
    } else if (query.any && sum(results, (r) => r.anyCount) === 0) {
      ok = false;
      status.push(`None of these are on this page: ${query.any.labels.join(', ')}`);
    } else if (query.ordered) {
      status.push('Each match is one in-order sequence');
    }
  }

  let remaining = ok ? CAP : 0;
  const frames = results.map((r) => {
    const limit = Math.min(r.count, remaining);
    remaining -= limit;
    return { frameId: r.frameId, limit, count: r.count };
  });
  const total = sum(frames, (f) => f.limit);
  const capped = ok && (results.some((r) => r.capped) || sum(results, (r) => r.count) > CAP);
  if (capped) status.push(`Showing the first ${CAP} matches`);
  if (ok && timedOut) status.push(`Stopped early because this page is very large. Showing the first ${total} matches.`, LIVE_PAUSED);

  return { ok, total, capped, timedOut, longest: Math.max(0, ...results.map((r) => r.longest)), status, frames };
}

/**
 * Turn per-frame replies (null = no answer in time) into SearchResults for `combine`.
 * `frameIds[i]` is the frame that `replies[i]` was requested from. A frame that didn't answer
 * counts as stopped early, never as "no matches".
 */
export function resultsFrom(replies, frameIds) {
  return replies.map((reply, i) => ({
    count: 0, capped: false, termCounts: [], anyCount: 0, longest: 0, keepAt: -1,
    ...(reply?.type === 'result' ? reply : {}),
    timedOut: reply?.type === 'result' ? !!reply.timedOut : reply == null,
    frameId: frameIds[i],
  }));
}

/** Map a page-wide match index to the frame that owns it and the index inside that frame. */
export function locate(frames, globalIndex) {
  if (globalIndex < 0) return null;
  let start = 0;
  for (const f of frames) {
    if (globalIndex < start + f.limit) return { frameId: f.frameId, local: globalIndex - start };
    start += f.limit;
  }
  return null;
}

/**
 * The page-wide index of the current match after a live refresh (spec §3.4). `frameId` owned the current
 * match and `keepAt` is that frame's answer: the first new match at or after it, or -1 when its text is gone.
 * `previous` is the current index before the refresh (-1 if there was none).
 */
export function keptIndex(frames, frameId, keepAt, previous, total) {
  if (total === 0) return -1;
  let start = 0;
  for (const f of frames) {
    if (f.frameId === frameId) {
      if (keepAt < 0) break;
      const index = start + Math.min(keepAt, f.limit); // past this frame's last match: the next frame's first
      return index >= total ? 0 : index;
    }
    start += f.limit;
  }
  return Math.max(0, Math.min(previous, total - 1));
}

/** When a live refresh runs: half a second after the change, and at most once a second (spec §3.3). */
export function nextRefreshAt(changedAt, lastSearchStartedAt) {
  return Math.max(changedAt + LIVE_DELAY_MS, lastSearchStartedAt + LIVE_GAP_MS);
}

/** "3 of 27", "1 of 5000+", "No matches", or "" when nothing is being searched. */
export function countLabel(current, total, capped, hasQuery) {
  if (total > 0) return `${current + 1} of ${total}${capped ? '+' : ''}`;
  return hasQuery ? 'No matches' : '';
}
