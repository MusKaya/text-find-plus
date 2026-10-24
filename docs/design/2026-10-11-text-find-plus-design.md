# Text Find+ — Chrome extension design

- **Date:** 2026-10-11
- **Status:** Draft for review
- **Repo:** `~/code/extensions/text-find-plus/` (Chrome version lives in `chrome/`)

## 1. Purpose and success criteria

A small open-source find-in-page extension that lets **regular users** search a page with friendly
word boxes (any words, all words, phrases, `*` wildcard) and lets **power users** type a real regex —
while asking Chrome for the **minimum possible permissions**. The owner loads it unpacked first and
decides later whether to publish to the Chrome Web Store.

Done means:

1. Every feature in sections 4–6 works on the bundled test page.
2. Nothing stays on the page after the popup closes or Clear is pressed.
3. The manifest asks for exactly `["activeTab", "scripting"]`, with no host permissions and no
   content scripts, so Chrome shows **no install warning**.
4. The owner's verification steps (section 13) pass.

## 2. Hard constraints (from the request)

- Manifest V3.
- Permissions: only `activeTab` and `scripting`. No `storage`, `tabs`, `host_permissions`,
  `optional_host_permissions`, or `content_scripts`. If something can't be done within these limits,
  it is reported, not worked around with a new permission.
- Code runs in a page only when the user clicks the toolbar icon or presses the shortcut. The popup
  injects via `chrome.scripting.executeScript` / `insertCSS` on the active tab.
- Plain HTML/CSS/JS. No build step, bundler, npm runtime dependencies, frameworks or minification.
  `chrome/` is exactly what gets zipped for the store.
- No network requests, analytics, remote code, `eval` / `new Function`, or inline scripts.
  Strict `extension_pages` CSP.

## 3. Name and repo layout

- Display name: **Text Find+** (manifest `name` and `short_name`).
- Store title when published: "Text Find+: Regex Find in Page".
- Directory / repo name: `text-find-plus` (no spaces or `+` in paths).

```
text-find-plus/                 ← git repo
  chrome/                       ← exactly what gets zipped for the store
    manifest.json
    popup/  popup.html  popup.css  popup.js  query.js
    content/  highlighter.js  highlight.css
    icons/  icon16.png  icon48.png  icon128.png
  tests/
    query.test.mjs              ← unit tests for query.js (node --test, no deps)
    test.html  frame.html       ← test page (+ same-origin iframe)
    e2e/                        ← headless end-to-end runner (Node built-ins only)
  tools/  make-icons.py         ← draws the PNG icons, Python standard library only
  docs/design/                  ← this design
  README.md  LICENSE  PRIVACY.md  TESTING.md  .gitignore
```

## 4. Popup UI

The main window is **exactly as wide as its longest line** (CSS `max-content`, about 406 px on macOS):
no line wraps and there is no spare space on the right. Messages and tips wrap inside that width
instead of widening it, and the count reserves room for "5000 of 5000+" so navigating never resizes
the popup. The whole popup fits under Chrome's 600 px height cap **without scrolling when it opens**
(about 573 px, and still under 600 px with a one-line message). The header is sticky, so
the count and buttons stay visible if a longer tip makes it scroll. Light and dark
mode follow the system and Chrome's mode (`prefers-color-scheme`).

### 4.1 Layout, top to bottom

1. **Sticky header**
   - Title "Text Find+" on the left.
   - On the right: match count, **↑** (previous), **↓** (next), **Clear**, **Close**. The count is
     bold in the main text colour (white in dark mode) so it stands out.
   - Button colours (tuned for light and dark mode): ↑ ↓ green, Clear amber, Close red.
   - **Close** closes the popup (`window.close()`), which removes the highlights like any other way
     of closing it. It stays enabled on pages that can't be searched.
   - Directly under it, a message area for errors, status lines and tips (empty most of the time).
2. **"Any of these words" card**
   - Input, placeholder `cat, dog, "guinea pig"`.
   - Description: "Highlights each of these words wherever it appears."
3. **"All of these words" card**
   - Input, placeholder `cheap, flight, "New York"`.
   - Checkbox **in this order**, on the card's heading line (right-aligned).
   - Description, which follows the checkbox:
     - unticked: "Only highlights if the page has every one of these words."
     - ticked: "Only highlights them in this order, with any text in between." (shortened so it fits
       on one line)
4. **"How to type your words" panel** — deliberately quiet: dashed outline, muted text, regular
   weight, lightbulb icon, "for the 2 boxes above". One rule per row, example on the left:
   - `cat, dog` — **Separate words with a space, comma or |** — → finds *cat* and *dog*
   - `"ice cream"` — **Put "quotes" around words that belong together** — → finds *ice cream*, not
     *ice* or *cream* alone
   - `walk*` — **\* stands for any letters in a word** — → finds *walks*, *walked* and *walking*
5. **Options band** — "Options · apply to every box". Each description sits beside its checkbox,
   on one line:
   - ☐ **Match case** — "Capitals must match: `Apple` won't find apple"
   - ☐ **Whole words** — "Full words only: `cat` won't find category"
6. **"Regex" card** (last)
   - Heading: "Regex (advanced, replaces the boxes above)".
   - Input, placeholder `e.g. colou?r (finds color or colour)`.
   - Soft-yellow toggle button **"◀ Open regex cheat sheet"** / **"Close regex cheat sheet ▶"** (with
     a large arrow) that opens the cheat sheet as a panel to the left of the main window (see 4.4).
     Closed on every open.

Both options are unticked by default. The popup uses no inline styles or inline scripts; visibility is
toggled with classes and the `hidden` attribute.

### 4.2 Behaviour

- **Focus on open:** the "Any of these words" input.
- **Live search:** any change (typing, ticking) re-runs the search after a 150 ms pause.
- **Enter / Shift+Enter** in any input: next / previous match. If a search is still pending,
  Enter runs it immediately and shows match 1.
- **↑ / ↓** wrap around (from the last match, ↓ goes to the first).
- **Count:** "3 of 27", "No matches" when a search finds nothing, empty when all boxes are empty,
  "1 of 5000+" when the cap is hit.
- **Clear:** empties every box, removes all highlights, and forgets the remembered search (4.3).
- **Regex box overrides:** when the Regex box has text, Any/All are ignored and the status line says
  "The Regex box is in use, so the boxes above are ignored."
- **Reopening the popup on the same page restores the last search.** It is kept only in that page's
  memory by the injected script, never written to disk, and is gone when the page reloads or
  navigates. Reason: Chrome closes the popup on any click outside it, and re-typing every time
  would be painful.

### 4.3 Messages (exact copy)

Status lines:

- "Not on this page: zebra" (All box: lists every missing word)
- "None of these are on this page: berlin, paris" (Any box when combined with All)
- "All words are on the page, but never in this order"
- "Each match is one in-order sequence" (hint while in-order results are shown)
- "Showing the first 5000 matches"
- "Stopped early because this page is very large. Showing the first N matches."
- "The Regex box is in use, so the boxes above are ignored."

Can't-search page (inputs disabled):

> Text Find+ can't search this page. Chrome doesn't allow extensions on chrome:// pages, the Chrome
> Web Store or other extensions' pages. For files on your computer, turn on "Allow access to file
> URLs" for Text Find+ in chrome://extensions.

### 4.4 Regex helpers

**Cheat sheet panel** (closed by default). It opens to the **left** of the main window, inside the
same popup, which widens to fit it (about 307 px panel + 406 px main window, under Chrome's 800 px
maximum popup width). A truly separate window isn't possible: Chrome closes an extension popup as soon
as another window takes focus, which would also remove the highlights. The panel is **exactly as wide
as its longest symbol row** ("`\w` a letter, digit or _ (English letters)"); popup.js measures it
when it first opens. The "Ready-made examples" heading and the "To find a symbol itself…" line are
spread to that same width. The panel has a soft yellow tint (not too strong, not too faint, in both
themes), is as tall as the main window, scrolls on its own, and has a header "Regex cheat sheet" with
its own "✕ Close" button; the toggle in the Regex card also closes it. The panel header matches the
main header exactly (height, neutral background and divider, title size, and a Close button of the
same shape and size), so the two read as one header bar. Clicking a symbol inserts it at the cursor in the Regex
box; `[ ]`, `[^ ]` and `( )` place the cursor inside.

- Building blocks: `.` any single character · `\w` a letter, digit or _ (English letters) ·
  `\p{L}` any letter, any language · `\d` a digit · `\s` a space or tab
- Repeat the thing before it: `*` 0 or more · `+` 1 or more · `?` optional · `{3}` exactly 3 ·
  `{2,4}` 2 to 4 times
- Choices and groups: `a|b` · `[abc]` · `[^abc]` · `( )`
- Position: `\b` edge of a word · `^` start · `$` end
- "To find a symbol itself, put \ in front: `\.` `\$` `\+` `\(` `\?`"
- **Ready-made examples**: each one is a full-width button, explanation on top, pattern underneath.
  Clicking puts the pattern in the Regex box.
  - color or colour — `colou?r`
  - Phone numbers like 555-1234 — `\d{3}-\d{4}`
  - Prices like $4 or $2.50 — `\$\d+(\.\d\d)?`
  - Email addresses — `\S+@\S+\.\w+`
  - Dates like 3/14/2026 — `\d{1,2}/\d{1,2}/\d{4}`
  - ALL-CAPS words (turns on Match case) — `\b[A-Z]{2,}\b`

**Tips** (one at a time, in this priority order, each with a one-click fix button "Try …"):

1. Regex has no matches and contains a letter or digit followed by an unescaped `*`:
   "No matches. In regex, `*` repeats the character before it, so `st*n` means sn, stn, sttn… For
   "any letters" use `\w*`." Fix: replace `X*` with `X\w*`.
2. Unescaped `.*` / `.+` (not lazy) and a match longer than 30 characters:
   "`.*` matches anything, even across many words. For letters inside one word use `\w*`; to stop at
   the first possible end use `.*?`" Fix: replace `.*` / `.+` with `\w*` / `\w+`.
3. Unescaped `$` that is not at the end:
   "`$` means "end of the text", so it never matches in the middle. To find a real $ sign, write
   `\$`." Fix: escape it.
4. A `.` between two letters or digits:
   "`.` means any character, so `notes.txt` also finds notesXtxt. For a real dot, write `\.`" Fix:
   escape it.

**"Looks like a regex" tip** for the Any/All boxes, when the text contains `\d \w \s \b \p`, `.*`,
`.+`, `[...]`, `(?` or `{n}` / `{n,m}`:
"This looks like a regex, but this box searches for the exact characters you typed." Button
**"Move it to the Regex box"** moves the text and empties the box it came from.

**Plain-language regex errors.** The friendly sentence comes first, with the original message underneath in small text:

| Chrome message contains | Shown as |
|---|---|
| Nothing to repeat | "*, + or ? needs something before it to repeat. To find the symbol itself, put \ in front, e.g. C\+\+" |
| Unterminated group | "A ( is missing its closing ). To find a ( itself, write \(" |
| Unmatched ')' | "There is a ) without an opening (. To find a ) itself, write \)" |
| Unterminated character class | "A [ is missing its closing ]. To find a [ itself, write \[" |
| \ at end of pattern | "The pattern ends with a lone \. Add the character it should escape, or remove it." |
| Incomplete quantifier / Lone quantifier brackets | "{ } must hold numbers, like \d{3}. To find a { itself, write \{" |
| Range out of order | "In a range like [a-z], the first character has to come first." |
| Invalid group | "(? must be followed by :, =, ! or <" |
| anything else | the original message |

An invalid regex never throws out of the popup: the error is shown and all highlights are cleared.

## 5. Query language (`popup/query.js`)

Pure functions: no DOM, no Chrome APIs. One ES module, used by the popup and imported directly by
Node tests.

### 5.1 Word lists (Any and All boxes)

- Separators: whitespace, `,` and `|`, in any mix, with or without spaces around them. Empty items
  are dropped, so `apple ,pear , ` gives `apple` + `pear`.
- `"quoted text"` is one term; commas and `|` inside quotes are literal.
- A comma between two digits stays inside the term (`1,000`).
- A term made only of `*` is dropped.

### 5.2 Term → regex source

- Every regex-special character is escaped, so `C++`, `$10` and `file.txt` are literal.
- `*` becomes `WORD*`, where `WORD = [\p{L}\p{M}\p{N}_]` (letters of any language, combining marks,
  digits, underscore).
- Whitespace inside a quoted phrase becomes `\s+`.
- **Whole words** wraps the term as `(?<!WORD)(?:term)(?!WORD)`. The boundaries are Unicode-aware,
  so `çiçek` and `Straße` work.
- **Turkish dotted/dotless i:** when Match case is off, each `i`/`I`/`İ`/`ı` in a friendly term
  becomes `[iIİı]`, so `istanbul` finds İstanbul and ISTANBUL. JavaScript's own case folding doesn't
  cover these letters. (Friendly boxes only; the Regex box is left as typed.)
- Flags: `gu`, plus `i` when Match case is off.

### 5.3 Search kinds

- **Any only:** one pattern, `term1|term2|…`. Every occurrence is a match.
- **All (in this order unticked):** the page must contain every term (across all frames). If yes,
  every occurrence of every term is a match. If not, there are no matches and the "Not on this page"
  status lists the missing terms.
- **All + in this order:** matches are **sequences**: term 1, then term 2 later, and so on, with any
  text between, within one frame. Each sequence is one match (several highlighted words). Sequences
  don't overlap and use the tightest window: the earliest place a full sequence can end, then the
  latest start for each earlier word.
- **Any + All:** the page must satisfy All (including order, if ticked) **and** contain at least one
  Any term. Matches are the All matches plus every Any occurrence, in page order.
- **Regex box:** the pattern is validated **on its own first**. It is tried with `u`, and if that
  fails, without `u`; if both fail, the second error is shown. Whole words then wraps it with the
  same Unicode guards (`\w`-based guards in non-`u` mode). Match case controls `i`.

### 5.4 Compiled query (sent to the page)

```js
// flat: every hit of one pattern is a match
{ kind: 'flat', source, flags }
// all: per-term patterns, optional order, optional any-pattern
{ kind: 'all', flags, ordered, terms: [{ label, source }], any: { source, labels } | null }
```

## 6. Page engine (`content/highlighter.js`)

A self-contained classic script, injected into the extension's isolated world, so page scripts can't
see or tamper with it. Guarded so injecting twice is harmless. It splits into an engine and a thin
port layer, so the engine can be tested without Chrome APIs.

### 6.1 Text model

- A TreeWalker over `document.body`, visiting text nodes and `<br>` elements.
- **Skipped:** `script`, `style`, `noscript`, `textarea`, `input`, `select`, `option`, `template`,
  and anything not visible according to `checkVisibility({ visibilityProperty: true })` (plus
  `checkVisibilityCSS` for older Chrome). The result is cached per element.
- **Blocks:** consecutive text nodes with the same nearest block-level ancestor form one block. An
  element is inline-level when its computed `display` starts with `inline` or is `contents`. Block
  text is the concatenation of its text nodes; a `<br>` adds a virtual `\n`. Matches can cross inline
  tags (`the <em>quick</em> brown`) but never cross blocks.
- The model is rebuilt on every search, so it always reflects the current page.

### 6.2 Matching

- Patterns are compiled from `source` / `flags`. Zero-length hits are skipped by advancing
  `lastIndex`.
- **Cap:** each frame stops at 5000 matches and reports `capped`. The popup keeps the first 5000
  across all frames in page order, and tells each frame how many of its matches to paint (`limit` in
  the `show` message). So the page never shows more than 5000 highlights.
- **Time guard:** the engine checks the clock between blocks and stops after 1.5 s, reporting
  `timedOut`. A single catastrophic regex can't be interrupted (accepted limitation of approach A;
  documented in the README).
- **Results are computed first, painted second** (see 7.2), so a page that fails the All check never
  flashes highlights.

### 6.3 Highlighting

- CSS Custom Highlight API: two registered highlights, `text-find-plus-match` (all matches) and
  `text-find-plus-current` (`priority = 1`). Ranges may span text nodes inside a block.
- Colours come from `content/highlight.css`, injected with `chrome.scripting.insertCSS`, which adds
  no DOM elements:
  ```css
  ::highlight(text-find-plus-match)   { background-color: #ffe45c; color: #000; }
  ::highlight(text-find-plus-current) { background-color: #ff9632; color: #000; }
  ```
- **Scroll:** if the current match's first range is outside the viewport, its start node's parent
  element gets `scrollIntoView({ block: 'center', inline: 'nearest' })`. This also handles nested
  scroll containers and same-origin iframes.
  *Amended (2026-10-13): "outside the viewport" also holds for a match hidden by a box that clips it
  (overflow hidden, scroll or auto) that is on screen, and a match that is already seen is left where it
  is. Every scroll is instant, whatever the page's `scroll-behavior` says. See the live updates and web
  components design, §4.5.*
- **The page DOM is never modified.**

### 6.4 Cleanup

- On port disconnect (the popup closed for any reason) or on `clear`: both highlights are deleted
  from `CSS.highlights` and cached ranges and text references are dropped.
- On **disconnect**, the remembered search (raw form values and current index, see 4.2) is **kept**,
  so the next open can restore it. On **`clear`** (the Clear button) it is **forgotten** too.
- The injected stylesheet can't be removed after the popup closes (Chrome offers no hook for that).
  It stays but does nothing without the named highlights. The README says so.

## 7. Architecture and messaging (approach A)

### 7.1 Opening the popup

1. `chrome.tabs.query({ active: true, currentWindow: true })` gives the tab id. No `tabs`
   permission is needed for the id.
2. Probe: `executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.__textFindPlus === true })`.
   - If this rejects → can't-search message (4.3).
   - Frames that answer `false` get `executeScript({ files: ['content/highlighter.js'] })` and
     `insertCSS({ files: ['content/highlight.css'] })`, targeted by `frameIds`.
3. For each frame from the probe results: `chrome.tabs.connect(tabId, { name: 'text-find-plus', frameId })`.
4. Frames are ordered main frame first, then by `frameId`. That order defines "page order" across
   frames.

### 7.2 Messages

Popup → page:

- `{ type: 'search', seq, query, form }` — `query` from 5.4. `form` holds the raw box and checkbox
  values, so the page can return them on the next open. Computes and caches results; paints nothing.
- `{ type: 'show', seq, current, limit }` — paints the first `limit` cached matches; `current` is a
  frame-local index or `-1`.
- `{ type: 'clear' }`

Page → popup:

- `{ type: 'hello', form, current }` — main frame only, sent right after connect, if a search is
  remembered.
- `{ type: 'result', seq, count, capped, timedOut, termCounts, anyCount, longest }` — `termCounts`
  and `anyCount` let the popup decide the All / Any checks across frames; `longest` feeds tip 2.
- `{ type: 'error', seq, message }`

The popup ignores replies whose `seq` is older than the latest search (fast typing).

### 7.3 Aggregation in the popup

1. Total count = sum of frame counts, capped at 5000. Frames are filled in page order: each frame's
   `limit` is whatever is left of the 5000 after the frames before it.
2. All / Any checks use summed `termCounts` / `anyCount`.
3. If a check fails, the popup sends `show` with `limit: 0` and `current: -1` to every frame (paints
   nothing, keeps the remembered search) and shows the status line. Otherwise it sends `show` to each
   frame, with `current` set only in the frame that owns the current global index. `clear` is sent
   only by the Clear button.
4. Navigation maps the global index to (frame, local index) and re-sends `show` to the frame(s) that
   changed.

### 7.4 Iframes

`allFrames: true` is best effort. **Confirmed by the spike (Chrome for Testing 151):** under
`activeTab`, `executeScript` reaches the main frame and **same-origin** iframes. **Cross-origin**
iframes are skipped silently: the call still resolves, it just returns no result for those frames.
Sequences ("in this order") never cross frames.

Other spike findings:

- The real CSP loads without errors.
- A highlight registered from the isolated world paints on the page and is visible from both worlds.
- `Extensions.triggerAction` opens a drivable popup in headless mode, but only when given the page's
  **tab** target id (not its page target id).

## 8. Manifest

```json
{
  "manifest_version": 3,
  "name": "Text Find+",
  "short_name": "Text Find+",
  "version": "0.1.0",
  "description": "Find text on any page with simple word searches or regex. Runs only when you click it, with no access to your other sites.",
  "minimum_chrome_version": "121",
  "permissions": ["activeTab", "scripting"],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Text Find+",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "commands": {
    "_execute_action": { "suggested_key": { "default": "Ctrl+Shift+F", "mac": "MacCtrl+Shift+F" } }
  },
  "content_security_policy": {
    "extension_pages": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }
}
```

- 121 is the first Chrome with the `checkVisibility({ visibilityProperty })` option. The CSS
  Custom Highlight API needs 105.
- `connect-src 'none'` blocks fetch, XHR and WebSocket from the popup. The injected script is not
  covered by this CSP; its "no network" guarantee comes from code review and the grep in section 13.
- If Chrome rejects any CSP directive at load time, drop only that directive and record why.

## 9. Icons

`tools/make-icons.py` (Python 3 standard library: `zlib` + `struct`) draws the 16, 48 and 128 px
PNGs with 4× supersampling. Design: a rounded square in a calm blue, a white magnifying glass, and
one white plus sign at the top right (the "+"), drawn bolder at 16 px. No fonts or copyrighted
artwork.

## 10. Safety and error handling (summary)

| Situation | Behaviour |
|---|---|
| Invalid regex | Plain-language error, highlights cleared, nothing thrown |
| More than 5000 matches | Stop at 5000; count "1 of 5000+"; status line |
| Huge page (>1.5 s) | Stop between blocks; partial results; status line |
| Catastrophic regex | Can freeze that tab (accepted). README: end it with Chrome's Task Manager (⋮ → More tools → Task manager) |
| Zero-length matches (`a*`, `^`) | Skipped, never loop |
| Restricted page / injection fails | Can't-search message; inputs disabled |
| Frame can't be reached | Skipped silently; the other frames still work |
| Page changes after a search | The next keystroke re-searches; stale ranges are harmless |
| Popup closes | Port disconnect → highlights removed |

## 11. Testing

1. **Unit — `tests/query.test.mjs`** (`node --test tests/`, Node 22 built-ins only):
   - the five comma forms, pipes, mixed separators, quotes, `1,000` and lone `*`
   - wildcard, Whole words, Unicode boundaries and the Turkish i mapping
   - Regex validation with and without `u`, plus the whole-word wrap
   - every friendly error, every tip and its fix, and looks-like-regex detection
   - the compiled query shapes
2. **Engine — `tests/e2e/engine.mjs`:** a tiny `node:http` static server serves `tests/`. Headless
   Chrome for Testing is driven over raw CDP (Node's built-in WebSocket). `highlighter.js` is
   evaluated in the test page, where the missing `chrome.runtime` skips the port layer, and its
   engine is driven directly. It covers:
   - phrase across inline tags, and `<br>`
   - exclusions: textarea, script, style, noscript, `display:none`, `visibility:hidden`
   - sequences, cap, zero-length patterns, Turkish text
   - performance target: under 300 ms per search on a generated ~1 MB text page
3. **Full extension — `tests/e2e/extension.mjs`:** Chrome for Testing launched with
   `--remote-debugging-pipe --enable-unsafe-extension-debugging`. Steps:
   1. `Extensions.loadUnpacked('chrome/')`.
   2. Open `tests/test.html` and call `Extensions.triggerAction` (this grants `activeTab` exactly as
      a click does).
   3. Drive the popup target; read highlights from the page.

   The owner's cases: plain match, regex with groups, case toggle, invalid regex, no matches,
   next/prev wraparound, Clear, text in textarea/script/style **not** matched. Added cases:
   - popup close removes highlights
   - reopen restores the search
   - same-origin iframe behaviour
   - `chrome://version` shows the can't-search message

   The Chrome path comes from `CHROME_PATH` or the local Playwright cache. Nothing is installed
   into the repo.
4. **Manual — `TESTING.md`:** the same cases as step-by-step instructions using `tests/test.html`,
   for anyone without a headless setup.

**Build step 0 (spike, before the real code):** confirm four assumptions in the real extension:

- `CSS.highlights` set from the isolated world paints on the page
- what `allFrames` reaches under `activeTab`
- `triggerAction` opens a drivable popup in headless mode
- the CSP is accepted

If the first one fails, stop and report — don't silently switch to the page's main world.

## 12. Documentation

- **README.md:**
  - what it does
  - each permission and why it's needed
  - how `activeTab` works (access only after you invoke it on that tab, until you leave the page)
  - "why so few permissions" (the {find+} comparison as a general point about `<all_urls>`)
  - load unpacked (chrome://extensions → Developer mode → Load unpacked → select `chrome/`)
  - keyboard shortcut (Chrome may need it assigned at chrome://extensions/shortcuts)
  - how to type searches
  - known limitations (section 14)
  - how to zip for the store (zip the *contents* of `chrome/`, so `manifest.json` is at the zip
    root: `cd chrome && zip -r ../text-find-plus-chrome.zip . -x '.*'`)
  - running the tests
- **PRIVACY.md:** one paragraph: collects nothing, sends nothing, stores nothing. The remembered
  search lives only in the open page's memory and is gone on reload.
- **LICENSE:** GNU GPL v3 (`GPL-3.0-or-later`), canonical FSF text; copyright 2026 "YOUR NAME" in the README and in an SPDX header at the top of every source file.
- **TESTING.md:** the manual plan.
- **.gitignore:** `.DS_Store`, `*.zip`, `node_modules/`, test profile folders.

## 13. Verification before finishing (owner's list)

1. Print the final `manifest.json`; confirm permissions are exactly `["activeTab","scripting"]`, with
   no host permissions or content scripts.
2. Grep the source for `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `new Function`, `innerHTML`
   and external URLs, and report every hit with an explanation. The popup builds its tip and error
   markup with DOM methods and `textContent`, so `innerHTML` is not needed.
3. Run the unit, engine and full-extension tests (section 11), and report the results.
4. Summarise what works, what doesn't, and any limitation hit.

## 14. Known limitations (for the README)

- Matches don't cross blocks: paragraphs, list items, headings, table cells.
- Shadow DOM (open or closed) isn't searched.
- Cross-origin iframes are skipped (confirmed): `activeTab` only covers the tab's own origin, so text
  inside embedded frames from other sites is not searched. Same-origin iframes are searched.
- Text in images, canvas, PDFs (Chrome's PDF viewer) and inside form fields isn't searched.
- Chrome pages, the Web Store and other extensions can't be searched. Local files need "Allow
  access to file URLs".
- A catastrophic regex can freeze the tab; end it with Chrome's Task Manager.
- Results are a snapshot: if the page changes, type again to refresh.
- Case-insensitive matching uses JavaScript's simple case folding: `ß` doesn't match `SS`. Turkish
  `İ`/`ı` are handled specially in the friendly boxes only.
- The highlight-colour stylesheet stays in the page after use (inert).
- Nothing is remembered across page reloads (no storage permission).

## 15. Out of scope

Find-and-replace, saved patterns or history, an options page, other browsers (Firefox comes later),
live updates via MutationObserver, running regex in a worker (approach C, possible later upgrade),
searching shadow DOM.
