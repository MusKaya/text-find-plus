// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Popup: injects the page engine on demand, keeps one port per frame, and turns the form into
// searches. While it is open, a page change refreshes the search (live updates). When the popup
// closes, Chrome drops the ports and the page clears its highlights and stops watching.
import { compileQuery, regexTip } from './query.js';
import { combine, locate, countLabel, resultsFrom, keptIndex, nextRefreshAt } from './frames.js';

const PORT_NAME = 'text-find-plus';
const DEBOUNCE_MS = 150;
const REPLY_TIMEOUT_MS = 3000;
const CHEAT_KEY = 'cheatOpen'; // in the popup's own localStorage, as theme.js keeps the theme: '1' while the cheat sheet is open
const REGEX_IN_USE = 'The Regex box is in use, so the Any and All boxes are ignored. Empty the Regex box to use them again.';
const IGNORED_TITLE = 'Ignored while the Regex box has text. Empty the Regex box to use it again.';
const LOOKS_LIKE_REGEX = 'This looks like a regex, but this box searches for the exact characters you typed.';
const ALL_DESC = {
  plain: 'Only highlights if the page has every one of these words.',
  ordered: 'Only highlights them in this order, with any text in between.',
};

const $ = (id) => document.getElementById(id);
const textInputs = () => [$('any'), $('all'), $('regex')];

let tabId = null;
let ports = []; // [{ frameId, port }] in page order
let seq = 0;
let combined = null; // page-wide result of the last search
let current = -1; // page-wide index of the current match
let hasQuery = false;
let pending = null; // debounce timer
let refresh = null; // timer for a scheduled live refresh
let searchStartedAt = -Infinity; // when the most recent search of any kind started
let livePaused = false; // the last search stopped early, so page changes are ignored
let inFlight = null; // the seq of the search waiting for the frames' answers, if any
let changedInFlight = false; // a frame reported a change while it waited: handled when it lands, by its livePaused
let liveSeq = null; // the seq of the live refresh in flight, if any
let steps = 0; // Enter and arrow presses made while it runs, applied when it lands
let shownMessages = null; // a key for what #messages shows, so a refresh that changes nothing leaves it alone
let touched = false; // the user has typed, ticked, used the cheat sheet or a tip button, or pressed Clear here, so a remembered search that arrives later is ignored
const waiters = new Map(); // `${seq}:${frameId}` -> resolve

// ---------- form ----------

function readForm() {
  return {
    any: $('any').value,
    all: $('all').value,
    ordered: $('ordered').checked,
    regex: $('regex').value,
    matchCase: $('matchCase').checked,
    wholeWords: $('wholeWords').checked,
  };
}

function fillForm(form) {
  for (const id of ['any', 'all', 'regex']) $(id).value = form[id] || '';
  for (const id of ['ordered', 'matchCase', 'wholeWords']) $(id).checked = !!form[id];
  updateAllDesc();
  updateIgnored();
}

function updateAllDesc() {
  $('allDesc').textContent = $('ordered').checked ? ALL_DESC.ordered : ALL_DESC.plain;
}

/**
 * While the Regex box has text, compileQuery ignores the Any and All boxes and "in this order", so they are disabled
 * (keeping what they hold) and their cards greyed out; the cursor in one of them moves to the Regex box. Called
 * whenever the Regex box changes, before the search runs. Not a user action, so it leaves `touched` alone; on a page
 * that can't be searched it never enables anything.
 */
function updateIgnored() {
  if (document.body.dataset.state === 'cant-search') return;
  const ignored = $('regex').value.trim() !== '';
  for (const id of ['any', 'all', 'ordered']) {
    const control = $(id);
    if (ignored && control === document.activeElement) $('regex').focus(); // before it goes: a disabled box drops the focus
    control.disabled = ignored;
    if (ignored) control.title = IGNORED_TITLE;
    else control.removeAttribute('title');
    control.closest('.card').classList.toggle('ignored', ignored);
  }
}

// ---------- messages ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tipBox(parts, label, onClick) {
  const box = el('div', 'tip');
  const line = el('div');
  for (const part of parts) line.append(typeof part === 'string' ? part : el('code', '', part.code));
  const button = el('button', '', label);
  button.type = 'button';
  button.addEventListener('click', () => { touched = true; onClick(); }); // a tip button rewrites the form: the user acted
  box.append(line, button);
  return box;
}

function render(compiled, form) {
  renderCount();
  const tip = compiled.query && form.regex.trim()
    ? regexTip(form.regex, { count: combined?.total ?? 0, longest: combined?.longest ?? 0 })
    : null;
  // Rewriting #messages drops keyboard focus from a tip button and can make a screen reader read it all again,
  // so it is rewritten only when something it shows (or a tip button acts on) has changed.
  const shown = JSON.stringify([compiled.error, compiled.regexInUse, combined?.status, tip, compiled.regexyBox]);
  if (shown === shownMessages) return;
  shownMessages = shown;
  const box = $('messages');
  box.replaceChildren();
  if (compiled.error) {
    const err = el('div', 'error', compiled.error.friendly || compiled.error.message);
    if (compiled.error.friendly) err.append(el('span', 'raw', compiled.error.message));
    box.append(err);
  }
  if (compiled.regexInUse) box.append(el('div', 'status', REGEX_IN_USE));
  for (const line of combined?.status || []) box.append(el('div', 'status', line));

  if (tip) {
    box.append(tipBox(tip.parts, 'Try ' + tip.fix, () => { $('regex').value = tip.fix; updateIgnored(); search(); $('regex').focus(); }));
  } else if (compiled.regexyBox) {
    const from = compiled.regexyBox;
    box.append(tipBox([LOOKS_LIKE_REGEX], 'Move it to the Regex box', () => {
      $('regex').value = $(from).value;
      $(from).value = '';
      updateIgnored();
      search();
      $('regex').focus();
    }));
  }
}

/**
 * The count, and the ↑ ↓ arrows beside it: as in Chrome's own find bar, the arrows are greyed out while there is no
 * match to move to (empty boxes, no matches, an invalid regex, after Clear). Both come from the same total, so they
 * never disagree. On a page that can't be searched the arrows are never enabled.
 */
function renderCount() {
  const total = combined?.total ?? 0;
  const label = countLabel(current, total, combined?.capped ?? false, hasQuery);
  if ($('count').textContent !== label) $('count').textContent = label; // the same words are not announced again
  const nowhere = total === 0 || document.body.dataset.state === 'cant-search';
  for (const id of ['prev', 'next']) $(id).disabled = nowhere;
}

// ---------- talking to the page ----------

function post(entry, msg) {
  try {
    entry.port.postMessage(msg);
  } catch {
    // the frame went away; its port is dropped on disconnect
  }
}

function request(entry, msg) {
  return new Promise((resolve) => {
    const key = `${msg.seq}:${entry.frameId}`;
    const timer = setTimeout(() => { waiters.delete(key); resolve(null); }, REPLY_TIMEOUT_MS);
    waiters.set(key, (reply) => { clearTimeout(timer); waiters.delete(key); resolve(reply); });
    post(entry, msg);
  });
}

function connect(frameId) {
  const port = chrome.tabs.connect(tabId, { name: PORT_NAME, frameId });
  const entry = { frameId, port };
  port.onMessage.addListener((msg) => {
    if (msg.type === 'result' || msg.type === 'error') waiters.get(`${msg.seq}:${frameId}`)?.(msg);
    else if (msg.type === 'changed') onChanged();
    else if (msg.type === 'hello') restore(msg);
  });
  port.onDisconnect.addListener(() => { ports = ports.filter((p) => p !== entry); });
  ports.push(entry);
}

async function restore(hello) {
  if (touched) return;
  fillForm(hello.form);
  await search();
  if (hello.current > 0) goTo(hello.current);
}

// ---------- searching ----------

/**
 * Search every frame. A live refresh (`live`) keeps the current match and never scrolls; any other
 * search starts at the first match.
 */
async function search({ live = false } = {}) {
  clearTimeout(pending);
  pending = null;
  clearTimeout(refresh); // a typed search covers a scheduled refresh; a live one is that refresh
  refresh = null;
  searchStartedAt = performance.now();
  const form = readForm();
  const compiled = compileQuery(form);
  const mySeq = ++seq;
  changedInFlight = false; // this search reads the page as it is now
  // A typed search drops presses that a refresh it replaced had counted. A live refresh never finds any: it starts
  // only when no search is waiting, since a change reported while one waits is held until that search lands.
  if (!live) steps = 0;
  hasQuery = !!compiled.query;

  if (!compiled.query) {
    combined = null;
    current = -1;
    // Empty boxes forget the remembered search; an invalid regex just hides the highlights.
    for (const entry of ports) post(entry, compiled.error ? { type: 'show', current: -1, limit: 0 } : { type: 'clear' });
    render(compiled, form);
    return;
  }

  liveSeq = live ? mySeq : null;
  inFlight = mySeq;
  const kept = live ? locate(combined?.frames ?? [], current) : null; // the frame that owns the current match
  const previous = current;
  const targets = [...ports]; // ports can drop out while we wait
  const replies = await Promise.all(targets.map((entry) => request(entry, {
    type: 'search', seq: mySeq, query: compiled.query, form, keep: kept?.frameId === entry.frameId ? kept.local : -1,
  })));
  if (mySeq !== seq) return; // a newer search started while we waited
  inFlight = null;
  const moved = steps; // presses made while this refresh ran
  steps = 0;
  liveSeq = null;

  const results = resultsFrom(replies, targets.map((t) => t.frameId));
  combined = combine(results, compiled.query);
  livePaused = combined.timedOut;
  current = -1;
  if (combined.ok && combined.total > 0) {
    if (live) {
      const keepAt = results.find((r) => r.frameId === kept?.frameId)?.keepAt ?? -1;
      // Those presses are the user's navigation, so they move the page; a refresh alone never does.
      goTo(keptIndex(combined.frames, kept?.frameId, keepAt, previous, combined.total) + moved, { reveal: moved !== 0 });
    } else {
      goTo(0);
    }
  } else {
    for (const entry of ports) post(entry, { type: 'show', current: -1, limit: 0 });
  }
  const failed = replies.find((r) => r?.type === 'error');
  if (failed && !compiled.error) compiled.error = { message: failed.message, friendly: null };
  render(compiled, form);
  if (changedInFlight) onChanged();
}

/** Make match `index` current; `reveal: false` leaves the page where it is (live refreshes). */
function goTo(index, { reveal = true } = {}) {
  const total = combined?.total ?? 0;
  if (!total) return;
  current = ((index % total) + total) % total;
  const at = locate(combined.frames, current);
  for (const f of combined.frames) {
    const entry = ports.find((p) => p.frameId === f.frameId);
    if (entry) post(entry, { type: 'show', current: at && at.frameId === f.frameId ? at.local : -1, limit: f.limit, reveal });
  }
  renderCount();
}

/**
 * Enter and the arrows. While a live refresh is in flight the presses are counted, then applied to the match it
 * keeps; with no current match ("No matches") there is nothing to move from, so they are not counted.
 */
function step(delta) {
  if (liveSeq !== seq) goTo(current + delta);
  else if (current >= 0) steps += delta;
}

function schedule() {
  touched = true;
  clearTimeout(pending);
  clearTimeout(refresh); // the typed search will search the changed page anyway
  refresh = null;
  pending = setTimeout(search, DEBOUNCE_MS);
}

/**
 * A frame reports that the page changed: refresh the search soon, unless there's nothing to refresh. A frame reports
 * one change per search, so a report that comes while a search waits for the frames is kept until that search lands:
 * only then is it known whether the search paused live updates.
 */
function onChanged() {
  if (inFlight === seq) { changedInFlight = true; return; }
  changedInFlight = false;
  if (refresh || pending || livePaused || !hasQuery) return;
  const now = performance.now();
  refresh = setTimeout(() => search({ live: true }), nextRefreshAt(now, searchStartedAt) - now);
}

function clearAll() {
  touched = true;
  clearTimeout(pending);
  pending = null;
  clearTimeout(refresh);
  refresh = null;
  seq++;
  for (const input of textInputs()) input.value = '';
  updateIgnored(); // before Any takes the focus, which a disabled box can't
  for (const entry of ports) post(entry, { type: 'clear' });
  combined = null;
  current = -1;
  hasQuery = false;
  $('messages').replaceChildren();
  shownMessages = null;
  renderCount();
  $('any').focus();
}

// ---------- cheat sheet ----------

/** Show or hide the cheat-sheet panel; the popup widens to the left while it is open. */
function setCheatOpen(open) {
  const panel = $('cheatPanel');
  panel.hidden = !open;
  if (open && !panel.style.width) sizeCheatPanel(panel);
  const toggle = $('cheatToggle');
  toggle.setAttribute('aria-expanded', String(open));
  const arrow = el('span', 'arrow', open ? '▶\uFE0E' : '◀\uFE0E');
  arrow.setAttribute('aria-hidden', 'true');
  const label = open ? 'Close regex cheat sheet' : 'Open regex cheat sheet';
  toggle.replaceChildren(...(open ? [label, arrow] : [arrow, label]));
}

/**
 * Make the panel exactly as wide as its longest line plus its border. The measured width already
 * includes the scrollbar gutter, which .cheat-inner always reserves (scrollbar-gutter: stable).
 */
function sizeCheatPanel(panel) {
  const inner = panel.querySelector('.cheat-inner');
  inner.classList.add('measure');
  const natural = inner.getBoundingClientRect().width;
  inner.classList.remove('measure');
  const border = parseFloat(getComputedStyle(panel).borderRightWidth) || 0;
  panel.style.width = `${Math.ceil(natural + border)}px`;
}

/** The user opens or closes the cheat sheet, and the next popup opens it the same way. */
function chooseCheat(open) {
  setCheatOpen(open);
  try {
    if (open) localStorage.setItem(CHEAT_KEY, '1');
    else localStorage.removeItem(CHEAT_KEY);
  } catch { /* storage unavailable: the choice lasts until the popup closes */ }
}

/** Whether the user left the cheat sheet open; anything unreadable or unrecognised is closed. */
function cheatRemembered() {
  try {
    return localStorage.getItem(CHEAT_KEY) === '1';
  } catch {
    return false;
  }
}

function onCheatClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  const input = $('regex');
  if (button.dataset.set !== undefined) {
    input.value = button.dataset.set;
    if (button.dataset.case === 'match') $('matchCase').checked = true;
    input.focus();
  } else if (button.dataset.ins !== undefined) {
    const insert = button.dataset.ins;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + insert + input.value.slice(end);
    const caret = start + insert.length - Number(button.dataset.back || 0);
    input.focus();
    input.setSelectionRange(caret, caret);
  } else {
    return;
  }
  updateIgnored();
  schedule();
}

// ---------- collapse ----------

/**
 * Show only the header (the bar and the messages under it), or everything again. The cheat sheet keeps its state and
 * width underneath. Never remembered: every popup opens expanded.
 */
function setCollapsed(collapsed) {
  document.body.classList.toggle('collapsed', collapsed);
  const button = $('collapse');
  const label = collapsed ? 'Expand to show the search boxes' : 'Collapse to just this bar';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(!collapsed));
}

// ---------- setup ----------

function bindEvents() {
  for (const input of textInputs()) {
    input.addEventListener('input', schedule);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (pending) search();
      else step(event.shiftKey ? -1 : 1);
    });
  }
  for (const id of ['ordered', 'matchCase', 'wholeWords']) $(id).addEventListener('change', schedule);
  $('ordered').addEventListener('change', updateAllDesc);
  $('regex').addEventListener('input', updateIgnored);
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('clear').addEventListener('click', clearAll);
  $('close').addEventListener('click', () => window.close()); // the ports drop and the page clears its highlights
  $('cheatPanel').addEventListener('click', onCheatClick);
  $('cheatToggle').addEventListener('click', () => chooseCheat($('cheatPanel').hidden));
  $('cheatClose').addEventListener('click', () => { chooseCheat(false); $('cheatToggle').focus(); });
  $('collapse').addEventListener('click', () => setCollapsed(!document.body.classList.contains('collapsed')));
}

function cantSearch() {
  $('cantSearch').hidden = false;
  setCheatOpen(false); // its buttons would act on the disabled Regex box; what is remembered stays for other pages
  for (const node of document.querySelectorAll('main input, main button, #prev, #next, #clear')) node.disabled = true;
  document.body.dataset.state = 'cant-search';
}

async function inject(frameIds) {
  if (!frameIds.length) return;
  await chrome.scripting.insertCSS({ target: { tabId, frameIds }, files: ['content/highlight.css'] });
  await chrome.scripting.executeScript({ target: { tabId, frameIds }, files: ['content/highlighter.js'] });
}

async function init() {
  bindEvents();
  renderCount(); // nothing is searched yet, so the arrows start greyed out, before the popup first shows
  if (cheatRemembered()) setCheatOpen(true); // before the first await, so it is there when the popup first shows; not a user action
  $('any').focus();
  let frameIds;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
    const probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__textFindPlus === true,
    });
    frameIds = probe.map((r) => r.frameId).sort((a, b) => a - b); // main frame (0) first
    const missing = probe.filter((r) => r.result !== true).map((r) => r.frameId);
    try {
      await inject(missing);
    } catch {
      // A sub-frame refused injection (e.g. it navigated away): fall back to the main frame.
      await inject(missing.filter((id) => id === 0));
      frameIds = frameIds.filter((id) => id === 0);
    }
  } catch {
    cantSearch();
    return;
  }
  for (const frameId of frameIds) connect(frameId);
  document.body.dataset.state = 'ready';
}

init();
