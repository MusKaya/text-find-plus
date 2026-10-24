# Text Find+ — live updates and web components (Chrome) design

- **Date:** 2026-10-11
- **Status:** Approved (2026-10-12). Probing while planning corrected sections 3.4, 4.2–4.5 and 8.
  Amended (2026-10-12, owner decision): closed web components, and page text placed inside them, are
  not searched; see §4.6. Amended (2026-10-12) for rare page cases found in review: §3.3, §4.2, §4.4,
  §4.6, §7 and §8.3. Amended (2026-10-13) in review: §4.2 (MathML table elements), §4.3
  (`assignedSlot`), §4.5 (scrolling to a match: the boxes that hide it, the owner's decisions on boxes
  the user can't scroll and on sticky and fixed bars, and bars inside web components), §4.6 (the bar
  search looks at nothing below a closed host) and §8.3 (the rule test).
- **Repo:** `~/code/extensions/text-find-plus/`, branch `feat/live-updates-web-components`
- **Builds on:** [`2026-10-11-text-find-plus-design.md`](2026-10-11-text-find-plus-design.md)
  (version 1, "the v1 spec" below). Everything there still holds unless this document changes it.

## 1. Purpose and success criteria

Two features for the Chrome version:

1. **Live updates.** While the popup is open, the count and highlights follow the page when it adds,
   removes, edits, shows or hides text.
2. **Search inside web components.** Text inside web components (shadow DOM), open and closed, is
   found, counted and highlighted like any other text, in the order it is displayed.
   *Amended: open components only; closed ones, and page text placed inside them, are not searched (§4.6).*

Done means:

- Both features work in Chrome for Testing and pass the tests in section 8.
- The rule in section 2 is written in the README and enforced by a test.
- No new permissions: still `activeTab` and `scripting` only, still no install warning.
- Every v1 test still passes.

## 2. Constraints

- **The rule: Text Find+ only finds and highlights.** It never changes, adds to, removes from or
  replaces anything on a page: no text, elements, attributes or stylesheets in the page's DOM,
  including inside web components. Highlights are painted with the CSS Custom Highlight API, which
  leaves the page as it is; their colours come from a stylesheet Chrome attaches for the extension
  (`scripting.insertCSS`), which is not part of the page's DOM. Find-and-replace will never be built.
- **Chrome only.** The Firefox version starts after these features are validated in Chrome and the
  owner gives the go-ahead, as a port of finished code. Nothing here is designed around Firefox.
- **Declined:** saved patterns or history, an options page.
- **Live updates run only while the popup is open** (owner's choice). Closing the popup still removes
  every highlight and stops all watching, as in v1.
- Node.js 22 built-ins only for tests and tools, as in v1.

## 3. Live updates

### 3.1 What the user sees

- With the popup open, when the page changes, the count and highlights refresh about half a second
  after the first change, and at most once a second.
- **The current match stays the same match**, even when matches appear before it (section 3.4).
- **The page never scrolls by itself during a refresh.** Only Enter, the arrows or a new search move
  it.
- A word reported "Not on this page" is highlighted once it appears; the status line updates with
  every refresh.
- When nothing is being searched (empty boxes) or the regex is invalid, changes are ignored.

### 3.2 Watching (page engine, each frame)

- One `MutationObserver` per frame, options:
  `{ childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] }`.
- **Armed at the start of every `search`:** `disconnect()`, then `observe(document, …)`, then
  `observe(root, …)` for every shadow root the walk enters (section 4.2). A `reported` flag is reset
  to false.
- **On the first batch of records after arming:** post `{ type: 'changed' }` once and set
  `reported`. Later records are ignored until the next `search` re-arms. This keeps a busy page from
  flooding the port.
- **Disarmed** (`disconnect()`) by `clear` in both forms: the Clear button / empty boxes, and port
  disconnect when the popup closes.
- The engine never causes a record itself: highlights and scrolling don't change the DOM. So a
  refresh cannot trigger another refresh.

### 3.3 Refreshing (popup)

- On `changed` from any frame, the popup schedules a **live refresh** unless one is already
  scheduled, and only if all of these hold: the last compiled query is valid (`compiled.query`), no
  typed search is waiting (`pending` debounce timer), and live updates are not paused (section 3.5).
  *Amended (2026-10-12): a `changed` that arrives while a search waits for the frames' answers is held
  until that search lands, and then handled as above, with the `livePaused` that search sets. Before,
  the previous search's value decided it: a report that came while a search that turned live updates
  back on was waiting for another frame was dropped, and because a frame reports one change per
  search, the highlights stayed stale until the next search; and a refresh scheduled while a search
  that stopped early was waiting still ran, while live updates were paused. No live refresh is
  scheduled while a search waits, so a slow refresh (up to the 3 s reply timeout) always lands before
  the next one starts; only a typed search or Clear replaces it.*
- **When:** `refreshAt = max(changedAt + 500 ms, lastSearchStartedAt + 1000 ms)`, where
  `lastSearchStartedAt` is the start of the most recent search of any kind. This is a pure function
  in `frames.js` (`nextRefreshAt`) with a unit test.
- A live refresh is the normal `search()` with `live: true`. It uses the same `seq` rule as v1, so a
  newer search always wins. Differences from a typed search: the current match is kept (3.4) and
  `show` is sent with `reveal: false`.
- **A typed search cancels a scheduled live refresh** (it searches the same page anyway).
- Frames are the ones connected when the popup opened (v1 §7.1). A frame added later is not searched
  until the popup is reopened (section 9).

### 3.4 Keeping the current match

1. Before a live refresh, the popup maps the current global index to `(frameId, local)` with
   `locate()` (v1). The `search` message to that frame carries `keep: local`; every other frame gets
   `keep: -1`.
2. The engine keeps a parallel array `starts[i]`: the page position (`g`, v1 §6.2) of match `i`'s
   first hit.
3. **Anchor:** before replacing its matches, the engine takes `matches[keep][0]`, a live `Range`
   that the browser has already moved with the DOM changes. After building the new text model, it
   looks up the anchor's `startContainer` among the new model's pieces (a `Map` from text node to
   `{ block, start }`, filled while building the model):
   - **found:** `pos = block * POS + start + startOffset`, and `keepAt = firstAtOrAfter(starts, pos)`.
     That is the index of the first new match at or after the old one; it equals `starts.length`
     when no match follows it in this frame;
   - **not found** (the text was removed): `keepAt = -1`.
4. The result carries `keepAt` (only from the owning frame). The popup picks the new current index
   with a pure function in `frames.js`, `keptIndex(frames, frameId, keepAt, previous, total)`:
   - `total === 0` → `-1`;
   - `keepAt >= 0` → the frame's start plus `min(keepAt, frame.limit)`. When `keepAt` reaches the
     frame's limit, this is the first match of the next frame, which is what "the next one along"
     means. If the result is `total` or more, wrap to `0`;
   - `keepAt === -1`, or the owning frame no longer answers → `max(0, min(previous, total - 1))`.
     `previous` is -1 when nothing was current (the last search found nothing); the first match then
     becomes current.
5. The popup sends `show` with that index and `reveal: false`. Nothing scrolls.

### 3.5 Large pages

- After every search, typed or live, the popup sets `livePaused = combined.timedOut`. That includes
  a frame that ran out of its 1.5 s budget and a frame that didn't answer within 3 s (v1).
- While `livePaused`, `changed` is ignored and the status area shows the line in section 6.
- A typed search that finishes in time clears `livePaused`, which turns live updates back on. A live
  refresh can't, because none runs while paused.

## 4. Web components

### 4.1 What the user sees

- Text inside open and closed web components is searched, counted and highlighted.
  *Amended: open components only; closed ones, and page text placed inside them, are not searched (§4.6).*
- It is read in display order. Text a component places through a `<slot>` is read where the slot
  displays it, and a slot's fallback text is read when nothing is assigned to it.
- A component's inline text joins its sentence: "Hello" followed by a `<fancy-name>` component that
  shows "World" matches the phrase "Hello World".
- Hidden components, and light-DOM children that a component doesn't display (no slot takes them),
  are skipped, like hidden text in v1.
  *Amended: a closed component's light DOM is skipped whatever it shows (§4.6).*

### 4.2 Reading the page as displayed

The model builder (v1 §6.1) replaces its `TreeWalker` with an iterative walk of the **flat tree**,
with the same filters: `SKIP` elements and elements that fail `checkVisibility()` are skipped with
their subtree; `<br>` adds `"\n"`; other elements are walked through. One exception: a
`display: contents` element fails `checkVisibility()` because it has no box of its own, but it still
shows its children, so it is walked through. Every `<slot>` is `display: contents` by default. (v1
skipped text inside such wrappers; this fixes that too.) Children of a node are:

1. **A shadow host:** the shadow root's `childNodes`. The root is `el.shadowRoot`, or for a closed
   root `chrome.dom.openOrClosedShadowRoot(el)` (no permission needed; available to the injected
   script, section 4.4). Only elements that can host a shadow root are asked: names
   containing `-`, and `article`, `aside`, `blockquote`, `body`, `div`, `footer`, `h1`–`h6`,
   `header`, `main`, `nav`, `p`, `section`, `span`. Outside the extension's world (the engine tests
   evaluate the engine in the page's main world), only open roots are read.
   *Amended: only open roots are ever read: the root is `el.shadowRoot`. An HTML element with none that
   could host one (the names above) is asked, through `chrome.dom`, one yes/no question: does Chrome have a
   closed root for it? If so it is skipped with its light DOM, and the root itself is never read. An
   element outside the HTML namespace with one of the built-in names (`div`, `span`, …) is skipped the
   same way without being asked; outside HTML a name with `-` can host no root, so it is walked
   (amended 2026-10-12, §4.6). The
   extension's world is told by `chrome.runtime.id`, not by whether `chrome.dom` exists: there, a missing
   `chrome.dom.openOrClosedShadowRoot` is an error that stops the search, never "no element is closed"
   (§4.6).*
2. **A `<slot>` inside a shadow tree:** `slot.assignedNodes({ flatten: true })`, which gives the
   fallback content when nothing is assigned.
   *Amended (2026-10-12): `slot.assignedNodes()`, one level, or the slot's own `childNodes` (its
   fallback) when nothing is assigned. A slot assigned to another slot is then walked like any other
   element, so its own style counts and it is the flat-tree parent of what it shows. With
   `flatten: true` the walk went straight to the light DOM, and found text that a hidden slot in the
   middle keeps off the screen. An element named `slot` outside the HTML namespace (the parser makes
   one inside `<math>`) is not a slot: its `childNodes` are walked.*
3. **Anything else:** `childNodes`.

The light-DOM children of a host are never walked directly: they are reached through the slots that
display them, or not at all.
*Amended: a closed host's are not walked at all, shown or not (§4.6).*

The walk records every shadow root it enters (for section 3.2), checks the clock every 256 nodes
(v1), and keeps the v1 performance target.

*Amended (2026-10-12): a node is also skipped when its flat-tree parent hides its content, as Chrome
draws it (measured in Chrome for Testing 151; a port measures its own browser):*

- *`content-visibility: hidden` (which `hidden="until-found"` sets) hides the parent's content unless
  the parent's computed `display` is one Chrome ignores it on: `contents`, `inline`,
  `inline list-item`, `ruby`, `ruby-text`, `table`, `inline-table`, `table-row`, `table-row-group`,
  `table-header-group` or `table-footer-group`. It hides on every other display measured: `block`,
  `inline-block`, `flow-root`, `list-item`, `flex`, `inline-flex`, `grid`, `inline-grid`,
  `table-cell`, `table-caption`, `block ruby` and `math`;*
- *a `table-column` or `table-column-group` element draws nothing inside it, with or without
  `content-visibility`;*
- *a closed `<details>` shows only its first `<summary>` child, so a second `<summary>` is hidden with
  the rest;*
- *a MathML token (`mi`, `mn`, `mo`, `ms`, `mtext`) draws text placed directly in it under any display
  that draws the element at all, so its display only has to draw something (`none` does not, nor does
  `contents`, which Chrome computes to `none` on a MathML element); the rule that follows is not
  applied to it. Any other MathML element, `<math>` itself and the table ones (`mtable`, `mtr`, `mtd`)
  included, draws such text only when its display is not a math one (its computed `display` contains
  `math`); while it is, none is drawn. The table ones have table displays by default, so their text is
  found until an author gives them a math one. Given another display (`block`, `inline-block`,
  `flex`, …), an element lays out its text like any box, and the text is found.*

*Amended (2026-10-13): `mtable`, `mtr` and `mtd` were exempt from the last rule by name, so text
placed directly in one that an author had given `display: math` or `display: block math` was found
although Chrome draws none of it. They now follow the display rule like any element but a token
(measured in Chrome for Testing 151: each draws its text in every display tried that gives it a box,
except `math`, `block math` and `inline math`).*

*This applies to elements as well as text, before `checkVisibility()`, which misses one case: it is
true for an element inside a table caption that `content-visibility` hides. Every element the walk
treats by name (the v1 `SKIP` set, `<br>`, `<details>`, `<summary>`, `<slot>`) is one only in the
HTML namespace: a MathML element with one of those names holding a token is drawn, and an SVG one is
never drawn, which `checkVisibility()` reports. (Asking about closed roots goes by name: the
built-in host names in any namespace, and names with `-` in HTML, §4.6.) Before, a parent with
`content-visibility: hidden` counted as hiding its text whatever its display, a column's text was
found, every `<summary>` child of a closed `<details>` counted as shown, those names were matched in
any namespace, and text placed directly in any MathML element was found.*

### 4.3 Paragraphs (blocks)

v1 groups text by its nearest non-inline ancestor, found through `parentElement`. That stops at a
shadow root. Both the block lookup and the visibility check for a text node now use the **flat-tree
parent**, which the walk records as it descends: the host for a shadow root's children, the slot for
the nodes it shows, and the element itself otherwise. (`assignedSlot` can't be used: it is null when
the slot is in a closed root.)
*Amended (2026-10-13): closed hosts are now skipped whole, with the page content placed inside them
(§4.6), so no text the walk collects is shown through a slot in a closed root, and the walk still records
each parent as it descends. Scrolling to a match (§4.5) does use `assignedSlot`: its walks up the flat
tree, from the match and from what covers it, take a node's parent from it. That is safe only because
closed hosts are skipped whole: no match is inside one, and from a node placed inside one the null leads
up to the host itself, which the bar search takes in its place.*

So an inline component stays in its sentence, and slotted text inherits `visibility` from where it is
displayed. `<slot>` is `display: contents` by default and is walked through, as v1 does for inline
elements.

### 4.4 Highlighting across a component's edge

A `Range` cannot have its start and end in different trees. For a hit, the pieces it covers are
grouped into runs of consecutive pieces in the same tree (`node.getRootNode()`) and in document order,
and each run becomes one `Range`. (Named slots can show nodes in a different order from the
document's, and a `Range` whose end comes before its start is empty.) Usually that is one range. A match that crosses
an edge becomes several, and v1 already paints and counts a match as an array of ranges.
*Amended (2026-10-12): a run joins two consecutive pieces only when the second's text node is the next
text node after the first's in their tree; otherwise the run splits there. A `Range` covers, and
paints, every text node between its ends, so before this, text that a named slot shows elsewhere but
that sits between two pieces in the document, or page text that a closed component between them shows,
was painted as part of the match.*

**Probe finding (Chrome for Testing 151, author-origin `insertCSS`, the one v1 uses):** the
document-level `::highlight()` rules paint text in an open root, in a closed root, and in light-DOM
text displayed through a slot. No stylesheet has to go into a component, so section 2's rule holds.
`chrome.dom.openOrClosedShadowRoot` was available to a script injected with
`scripting.executeScript`. User-origin CSS painted nothing, so the origin stays as it is.
*Amended: painting in a closed root works, and that is why closed roots are not searched (§4.6).*

### 4.5 Scrolling to a match

`reveal()` (v1 §6.3) scrolls `range.startContainer`'s parent element into view, or the shadow root's
host when the text node sits directly in a shadow root and so has no `parentElement`.

*Amended (2026-10-13): `reveal()` scrolls a match only when it can't be seen, and moves only what has to
move. v1 counted a match as seen whenever its rect lay inside the viewport, so a match hidden by a box on
screen (a chat pane, a code block, a sidebar) was never scrolled to.*

- *A match is seen when it lies inside the viewport and inside the visible part of every box that clips
  it, on the axes that box clips, and no sticky or fixed bar covers it (below). A box is a flat-tree
  ancestor (through a shadow root to its host, and from slotted content to its slot) whose computed
  `overflow-x` or `overflow-y` is not `visible`; a non-atomic inline element (`display: inline`, `ruby`,
  `ruby-text` or `inline list-item`) or a `contents` one has no box to clip with, and `<body>` and
  `<html>` are the viewport. The visible part is the padding box, measured as it is
  drawn: the client sizes are scaled by the ratio of the box's rect to its offset size, so a box under
  `transform: scale()` is judged at its drawn size. Only the middle half of the match's height is judged
  against an edge, because the glyph box of a line can stick out of a tight line box (line-height 1) by a
  pixel or two while the text shows in full.*
- *A fixed element belongs to the first ancestor that contains it, and an absolutely positioned one to the
  first that contains it or is positioned; what clips that ancestor clips them, and the boxes between are
  skipped. An ancestor contains them with a `transform`, `translate`, `rotate` or `scale` other than
  `none`, a `perspective`, an `offset-path` other than `none` or an `offset-position` other than `normal`
  or `auto`, a `filter` or `backdrop-filter`, or `transform-style: preserve-3d`, or with a `will-change`
  that names one of those or the `offset` shorthand, the names matched as whole names and in any case
  (Chrome keeps the case they were written in): `transform-origin` or `offset-rotate` names none of them,
  and of the `-webkit-` names `-webkit-transform`, `-webkit-transform-style`, `-webkit-perspective` and
  `-webkit-filter` count and `-webkit-backdrop-filter` does not; and, unless it is a table row or row
  group (`table-row`, `table-row-group`, `table-header-group` or `table-footer-group`), which takes no
  containment, with paint or layout containment (`contain` with `paint`, `layout`, `strict` or
  `content`), a `will-change` that names `contain`, or `content-visibility: auto`. Measured in Chrome
  for Testing 151 (`opacity`, `clip-path`, `mask`, `isolation`, `mix-blend-mode`, `contain: size` and
  `style`, both `container-type`s and `will-change: opacity` contain nothing), and Chromium's
  `LayoutObject::ComputeIsFixedContainer` at 123 lists the same, `backdrop-filter` included. On a
  non-atomic inline element (`display: inline`, `ruby`, `ruby-text` or `inline list-item`) only a
  `filter` or `backdrop-filter`, or a `will-change` that names one, contains them, as the same function
  has it, and a `display: contents` element, which has no box, contains nothing; both measured.*
- *A match that is seen scrolls nothing.*
- *A match outside the viewport is centred with `scrollIntoView`, as in v1, which moves every scroller
  above it.*
- *A match inside the viewport that only boxes hide scrolls those boxes and leaves the page where it is.
  Each box the match is still outside of, the innermost first and the viewport last, is scrolled on each
  axis that hides it to put the match at the middle of the part of the box that the viewport shows (the
  whole box when the viewport shows none of it), so a pane that reaches past the viewport does not push
  the match out of it. The scroll amount is in the box's own pixels (a scaled box scrolls by the drawn
  distance divided by its scale). This also finishes the job after `scrollIntoView` for a parent taller
  than its box, which it centres, not the match. A box that can't scroll (`overflow: clip`) is left
  alone.*
- *Owner decision (2026-10-13): a box that hides part of its content and gives the user no way to
  scroll it (`overflow: hidden`: a line-clamped preview, a collapsed "read more", a cell cut off with an
  ellipsis) is scrolled so the match shows, as Chrome's find does, and stays scrolled until the page
  reloads. Hidden, scroll and auto boxes are treated alike.*
- *Owner decision (2026-10-13): a match covered by a sticky or fixed bar (a header, a cookie banner, a
  sticky table heading) counts as not seen. When the boxes say a match is seen, a hit test at its
  middle, in its own tree and then inside each open shadow root it lands on, finds what is on top: from
  outside a component the hit test gives only its host, and the bar can be inside one (an app shell's
  header over the page text it shows through a slot, a cookie banner in a component). Nothing below a
  closed host is looked at (§4.6): when what is on top is inside one, in its root or in the page content
  placed inside it, the outermost such host stands for it, as the hit test itself gives the host for
  anything inside a closed root. If that is neither the match's element, a flat-tree ancestor of it nor
  a flat-tree descendant of it, its nearest fixed or sticky flat-tree ancestor is the bar, if one comes
  before the first flat-tree ancestor it shares with the match's element: a bar that holds the match
  (text in a cookie banner under the banner's own button) moves with it, and no scroll clears it. A
  sticky element whose `top` and `bottom` are both `auto` sticks only sideways (the first column of a
  table scrolled sideways), scrolls up and down like any other element, and is passed over. A bar a
  third of the viewport tall or more (an overlay, a backdrop, a full-height sidebar) is left alone, and
  so is one that doesn't overlap the match vertically (a dropdown hanging from a header). Otherwise the
  match is moved just far enough to put it a line's height clear of the bar, below a bar in the top half
  of the viewport and above one in the bottom half. A sticky bar is cleared by the nearest clipping box
  of the match above it, which is what it sticks to. A fixed bar, or a sticky one with no such box above
  it, is cleared by the viewport, then the `<body>` when it scrolls itself (`<html>` has an `overflow`
  other than `visible`), then the match's boxes from the outside in (a fixed header over a full-height
  `<main>` that scrolls), each scrolled by what is left of the distance until the match has moved all of
  it; one that moves nothing of the match (the page behind a fixed `<main>`) is scrolled back.*
- *Every scroll is instant (`behavior: 'instant'`), whatever the page's `scroll-behavior` says, as
  desktop Chrome's find scrolls (`TextFinder::ScrollToVisible` at 123): each step measures where the
  step before left the match, and a smooth scroll would not have moved it yet, so a match in a smooth
  pane inside a box would end hidden.*
- *Not handled: a match covered by something that is neither fixed nor sticky (an absolutely positioned
  popup), by a bar in the page around a frame, or by a bar placed inside a closed component, in its root
  or in the page content placed inside it (only the host is looked at: what is cleared then is the host
  itself, or an element above it, when that is fixed or sticky); and an overlay a third of the viewport
  tall or more, which is left alone on purpose.*

### 4.6 Closed components

Closed web components are **not searched, and neither is any page text placed inside one** (owner
decision, 2026-10-12; sections 1, 4.1, 4.2, 4.4, 7 and 8 promised otherwise before it). A match inside a
closed root puts a `Range` into the page-wide `CSS.highlights` registry, which the page's own scripts can
read, and from `range.startContainer.getRootNode()` the page then holds the closed root itself, keeps it
after the popup closes, and can read and change it. Closed roots are how other extensions (password
managers, for example) hide their on-page panels from pages, and content scripts run in isolated worlds,
so the page cannot reach those roots any other way.

The walk therefore enters open roots only (`el.shadowRoot`). An element with no open root that could
host one (a custom element, or one of the built-ins `attachShadow` accepts, in the HTML namespace) is
asked a single yes/no question, `chrome.dom.openOrClosedShadowRoot(el)`; when Chrome has a closed root
for it, the host is skipped together with its light DOM (amended 2026-10-12, owner decision: the first
version of this section skipped only the root). The light DOM goes too because what a closed root shows,
and whether it hides a slot, can't be known without reading the root, so walking it as plain children
counts text the user cannot see. The answer is tested for null and never read, stored or passed on. An
element outside the HTML namespace with one of the built-in host names is skipped the same way,
unasked, because Chrome answers only for HTML elements yet attaches roots to those, such as a `<div>` in
another namespace; outside HTML it attaches none to a name with `-`, so such an element is walked like
any other (amended 2026-10-12). The
cost is accepted: page text that a closed component shows on screen is not found (Chrome's own find
still finds it). Frames inside a closed component are still searched, each being its own page whose
highlights stay in its own document. Whether the engine is in the extension's own world is decided by
`chrome.runtime.id`, not by whether `chrome.dom` exists: there, a missing
`chrome.dom.openOrClosedShadowRoot` is an error that stops the search (fail closed), never "no element
is closed", which would count the text closed components hide. Only outside the extension's world, where
the engine tests run, does no element count as closed. A port to another browser keeps the rule and uses
that browser's equivalent for the yes/no question only. `tests/test.html` keeps `#wc-closed` and seven
closed hosts with "zircon" in their light DOM, and the README lists the limit. A page whose `<body>`
hosts a closed root is skipped whole.

*Amended (2026-10-13): moving a match out from under a sticky or fixed bar (§4.5) looks at nothing below
a closed host either. When what covers the match is inside one, in its root or in the page content placed
inside it, the outermost such host stands for it, and the search for the bar starts there. To find that
host, the covering element and the elements above it are asked the yes/no question from the top down,
but only those with no open root (an element has at most one root, and Chrome's answer covers open ones
too), and the asking stops at the first closed host, so nothing below it is asked even that. A bar placed
inside a closed component is therefore not cleared; what is cleared then is the host itself, or an
element above it, when that is fixed or sticky.*

## 5. Messages (changes to v1 §7.2)

Popup → page:

- `search` gains `keep`: a frame-local match index, or `-1`.
- `show` gains `reveal` (boolean). `true` for typed searches and navigation, `false` for live
  refreshes.

Page → popup:

- `result` gains `keepAt` (section 3.4).
- New: `{ type: 'changed' }`, at most once per `search` (section 3.2).

## 6. Copy (exact)

- Paused status line: **"Live updates are paused because this page is very large."** It is shown
  after v1's "Stopped early because this page is very large. …" line when both apply.

## 7. Build step 0 (spike, before the real code)

Confirm in the real extension, against `tests/test.html` with the new section (section 8.1):

- painting inside open, closed, nested and slotted components (the probe in 4.4 used a separate
  probe extension);
- a `MutationObserver` created in the injected script reports changes inside a closed root reached
  through `chrome.dom`;
- the cost of the shadow-root lookup on the v1 ~1 MB performance page stays within the v1 target.

*Amended: the product does not search closed roots (§4.6), but it still asks the lookup's yes/no for every
HTML element that could host one (one outside HTML with a built-in host name is skipped unasked, amended
2026-10-12), so the cost
check above stays relevant. The spike now observes an open root
(`#wc-live`): the engine watches open roots only, so observing a closed one is no longer a requirement.*

If painting inside components fails, stop and report. Don't put stylesheets into components, because
that would break section 2's rule.

## 8. Testing

### 8.1 Test page (`tests/test.html`)

- **Web components section:** each entry contains the word "lantern":
  - shown, so matched (5): an open component; a closed component; an open component inside
    another open component; light-DOM text displayed through a slot; a slot's fallback text;
  - not matched (3): a hidden component; a light-DOM child that no slot displays; light-DOM text
    displayed through a slot whose wrapper inside the component is `visibility: hidden`.
  - A light-DOM "Hello" followed by a component showing "World".
  - "compass" inside a `display: contents` wrapper.
  - The page keeps references to its closed roots in a page global, for the test in 8.3.
  - *Amended: the closed component is kept to pin that it is not matched, so 4 entries match, not 5. Seven
    more closed hosts have "zircon" in their light DOM (no slot; a slot under `visibility: hidden`; a plain
    slot; a slot under `display: none`; a `<div>`; one inside an open root; one whose light DOM holds an
    element and an open component with slotted text), and one ordinary paragraph has it as the control:
    only the control is found (§4.6).*
- **Live section:** a button "Add a line every 2 seconds" that starts a timer adding a line
  containing "tick" (for the manual plan: clicking the page closes the popup, so the page must change
  on its own), and page functions the automated tests call to add and remove text, both in the
  light DOM and inside a closed component. The button is an `<input type="button">`, so the "2" in
  its label isn't page text and v1's `\d+` count stays the same.
  *Amended: the component the live tests change (`#wc-live`) is an open one (§4.6).*

### 8.2 Unit (`tests/frames.test.mjs`)

- `keptIndex`: kept in the same frame, the following frame, wrap to 0, anchor gone (same number,
  clamped), total 0.
- `nextRefreshAt`: the 500 ms delay and the 1000 ms minimum gap.

### 8.3 Engine and full extension (`tests/e2e/`)

Engine (main world, open roots only):

- "lantern" finds the 4 open-reachable entries in display order: closed is skipped here, and hidden
  and undisplayed are never found;
- "Hello World" across the component edge: one match painted as two ranges;
- slotted text inherits `visibility: hidden` from where it is displayed;
- text inside a `display: contents` wrapper is found;
- named slots are read in the order they show their content;
- the first change after a search is reported once; `keepAt`; `show` without scrolling.

Full extension:

- "lantern" → **1 of 5**, closed included, with highlights inside every component;
  *Amended: **1 of 4**, no closed root among the painted ranges; "zircon" → **1 of 1**; and the engine's
  only use of `chrome.dom.openOrClosedShadowRoot` is its yes/no question: a wrapper hands it a Proxy, which
  records no access (§4.6);*
- live: adding a match updates the count within 1.5 s. Removing one lowers it. A change inside a
  component counts too. The current match stays the same match, and `scrollY` doesn't move;
- live: "Not on this page: X" turns into matches when X is added;
- live: the paused line. A page large enough to hit the 1.5 s limit would need about 150 MB of text
  (1 MB searches in about 10 ms), so the test keeps the page busy past the popup's 3 s wait instead,
  which section 3.5 treats the same way;
- live: hidden text that is shown later is found; a change inside a same-origin frame counts; a page
  that keeps changing is refreshed about once a second;
- the closed-root lookup keeps the v1 performance target in the extension's own world; *(amended: the
  lookup is the yes/no question, asked once per HTML element that could host a root (one outside HTML
  with a built-in host name is skipped unasked, amended 2026-10-12); the test checks that
  searching in the extension's world keeps the target, §4.6)*
- live: closing the popup stops it. A later page change has no effect, and the highlights stay gone;
- **the rule:** a main-world `MutationObserver` over the document and every shadow root (closed ones
  through the page's references) records nothing while the extension opens, searches (plain, All in
  order, regex), moves next and back, refreshes live after a test-made change (records are cleared
  once that change has been delivered), clears and closes. A serialization of the document and
  every shadow root is identical before and after.
  *Amended (2026-10-13): the test's own change is taken out of the observers before any callback runs,
  so a write the extension makes in reaction to it is recorded, not cleared with it; and the `value`,
  `checked` and `selectedIndex` of every form control in the document, its frame and every shadow root
  (closed ones too, except the root of `#wc-live`, which the test itself empties) are the same before
  and after, which no serialization shows.*
  *Amended (2026-10-13): it also moves to a match that a pane hides and to one that a sticky header
  covers, and checks that the pane and then the page scrolled, so both of `reveal()`'s scrolling paths
  (§4.5) run while the observers watch; the pane and the header are the test's own, put in and taken out
  like its other changes.*

### 8.4 Manual (`TESTING.md`)

New cases: "lantern" (1 of 5, hidden and undisplayed not highlighted; *amended: 1 of 4, closed not
highlighted, §4.6*; and `zircon`: 1 of 1, only the plain one); "Hello World" across a component; live: click "Add a line every 2 seconds", open
the popup, type `tick`, and watch the count rise while the page stays still and the current match
stays put.

## 9. Documentation and version

- **README:**
  - a short "Finds and highlights only" section with the rule from section 2;
  - live updates and web components added to the features;
  - limitations: remove "Shadow DOM isn't searched" and "Results are a snapshot"; add "Live updates
    run only while the popup is open", "Frames added after the popup opens are searched when you
    reopen it", and "On very large pages live updates pause".
- **TESTING.md:** the cases in 8.4.
- `manifest.json` `version` → `0.2.0`.
- The v1 spec stays as it is: it is the record of version 1.

## 10. Out of scope

Firefox (next, after the go-ahead); find-and-replace (never); saved patterns or history; an options
page; searching frames added after the popup opened; keeping highlights after the popup closes.
