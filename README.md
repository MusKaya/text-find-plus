# Text Find+

Browser extension that finds and highlights text on a web page with simple word searches or regular
expressions. Runs only when you click it, with access to nothing but the tab you open it on.

The extension's code lives once, in [`src/`](src/), and each browser gets a folder that holds only what that
browser needs on top of it. The Chrome version is `src/` plus [`chrome/`](chrome/) (its `manifest.json`):
`node tools/package.mjs chrome` puts the two together in `build/chrome/`, which is exactly what gets zipped for the
Chrome Web Store.

## What it does

Click the toolbar icon (or press the shortcut) and type in any of these boxes:

- **Any of these words**: highlights each of the words wherever it appears.
- **All of these words**: highlights the words only if the page contains every one of them.
  Tick **in this order** to find them in the order you typed them, with any text in between. Each
  in-order sequence counts as one match.
- **Regex** (advanced): a JavaScript regular expression. While this box has text, the Any and All
  boxes are greyed out and ignored; empty it to bring them back. Match case and Whole words still apply.
  A cheat sheet that opens beside the popup, ready-made examples, plain-language error messages and one-click
  "Try …" fixes help if you're new to regex.

Two options apply to every box:

- **Match case**: capitals must match (`Apple` won't find apple). Off by default.
- **Whole words**: full words only (`cat` won't find category). Off by default.

Matches light up in yellow and the current match in orange. The count shows "3 of 27". Use
**Enter** / **Shift+Enter** (or ↑ / ↓) to move between matches; they wrap around at the ends.
While there is nothing to move to (empty boxes or no matches), ↑ and ↓ are greyed out, as in
Chrome's own find bar. **Clear** empties the boxes and removes every highlight. **Close** closes the popup. However you
close it (Close, Esc, or clicking the page), the highlights disappear. If you reopen it on the same page, your last search comes back.

While the popup is open, the results follow the page: when the page adds, removes, edits, shows or
hides text, the count and highlights update within about a second. The current match stays the same
match while its text is still there, and the page never scrolls by itself.

When you move to a match that sits inside a box that hides part of its content and gives you no way to
scroll it (an `overflow: hidden` box, a line-clamped preview, a collapsed "read more", a cell cut off with
an ellipsis), the box is scrolled so the match shows, as Chrome's own find does, and it stays scrolled
until the page is reloaded. A match covered by a sticky or fixed header, bar or cookie banner counts as not
seen: moving to it scrolls it just clear of the bar.

Text inside open web components (shadow DOM) is searched like any other text, in the order the page
shows it. Closed web components, and any page text placed inside them, aren't searched: extensions use
closed components to keep their own on-page panels away from the page, and a highlight inside one would
give the page a way in.

The A◐ / ☀ / ☾ button in the popup's top bar switches its colours between Automatic (an A with a small raised ◐; follows Chrome's light or dark setting), Light and Dark. Your choice is remembered.

The ▲ button next to it collapses the popup to just that bar, so it covers less of the page while
↑, ↓, Clear and Close keep working and any message stays under the bar; ▼ expands it again. The
popup always opens expanded.

### How to type your words (Any and All boxes)

| You type | What it means |
|---|---|
| `cat, dog` | Separate words with a space, a comma or `\|`. Finds *cat* and *dog*. |
| `"ice cream"` | Quotes keep words together as one phrase. Finds *ice cream*, not *ice* or *cream* alone. |
| `walk*` | `*` stands for any letters in a word. Finds *walks*, *walked* and *walking*. |

Every other character is matched literally, so `C++`, `$10` and `notes.txt` find exactly that
text. Whole words and `*` understand letters in any language (`çiçek`, `Straße`). With Match case
off, the Turkish letters `İ`, `I`, `ı` and `i` count as the same letter in these boxes.

## Finds and highlights only

Text Find+ only finds and highlights text. It never changes, adds to, removes from or replaces
anything on a page: no text, elements, attributes or stylesheets, including inside web components.
Highlights are painted with the CSS Custom Highlight API, which leaves the page as it is. Their
colours come from a small stylesheet that Chrome attaches to the tab for the extension. It isn't part
of the page's DOM or its stylesheets, and Chrome keeps it attached until the page reloads or the tab
goes to another page.
There is no find-and-replace, and there never will be. An automated test checks this: it watches the
page and every web component on it while the extension opens, searches, refreshes, clears and closes,
and fails on any change.

## Permissions, and why there are only two

| Permission | Why it's needed |
|---|---|
| `activeTab` | Lets the extension access the tab you're looking at, **only after you click its icon or press its shortcut on that tab**. |
| `scripting` | Lets the popup inject the search script and the highlight colours into that tab. |

That's all. There are no host permissions, no content scripts, no storage permission and no
background worker, so Chrome shows **no permission warning** when you install it. The popup
remembers only your theme choice (Light or Dark) and whether you left the regex cheat sheet
open, in its own local storage, which needs no permission.

**How `activeTab` works:** until you open Text Find+ on a tab, Chrome gives it no access to that
tab at all. When you click the icon (or press the shortcut), Chrome grants temporary access to that
tab. The access ends when you navigate the tab to a different page or close it. Other tabs and
other sites are never accessible.

**Why this matters:** many find-in-page extensions ask for access to `<all_urls>`. That's the
"Read and change all your data on all websites" warning, and their scripts then run on every page
you open. Even if such an extension is trustworthy today, a future update (or a sold or hijacked
developer account) could use that access on every site you visit. Text Find+ can only ever touch
the pages you deliberately open it on. If an update ever asked for more, Chrome would disable the
extension until you approved it.

On the page where you do open it, it can read that page's text. That's unavoidable for any find
tool. The code is small, plain and unminified JavaScript, so you can read exactly what runs.

## Install in Chrome (load unpacked)

1. Download or clone this repository.
2. In it, run `node tools/package.mjs chrome` (Node.js 22 or newer and the `zip` command; nothing to install from
   npm). It puts the Chrome version together in `build/chrome/`.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the **`build/chrome`** folder inside this repository.
6. Pin Text Find+ from the puzzle-piece menu if you want its icon on the toolbar.

After a change to the code, run the packager again and click the extension's reload button on `chrome://extensions`.

Requires Chrome 123 or newer.

### Keyboard shortcut

The suggested shortcut is **Ctrl+Shift+F** (**Control+Shift+F** on a Mac). Chrome only assigns it
if no other extension uses it. If it doesn't work, set it at `chrome://extensions/shortcuts`.

## Known limitations

- A match can't span two separate blocks of text (paragraphs, list items, headings, table cells).
  It can span formatting inside one block, such as *the **quick** brown*.
- **Iframes:** frames from the same site as the page are searched. **Frames from other sites
  (cross-origin iframes) are skipped**, because `activeTab` only covers the tab's own site. This
  was confirmed by testing.
- Text inside images, canvas, PDFs shown in Chrome's PDF viewer, and form fields (text boxes,
  dropdowns) isn't searched.
- Collapsed content, such as a closed `<details>` section, isn't searched. Chrome's own find can
  open those sections, but Text Find+ never changes the page, so it only searches visible text.
- Closed web components, and any page text placed inside them, aren't searched. Extensions use closed
  components to keep their own on-page panels away from the page, and a highlight inside one would give
  the page a way in. The cost: text that a closed component shows on screen can't be found, though
  Chrome's own find (Ctrl+F) still finds it. Text Find+ can't search a page whose `<body>` itself hosts
  a closed root at all. A frame inside a closed component is still searched like any other frame, since each
  frame is its own page and its highlights stay in its own document. A sticky or fixed header, bar or cookie
  banner placed inside a closed component isn't scrolled out of the way of a match it covers, since
  Text Find+ doesn't look inside one.
- Chrome's own pages (`chrome://…`), the Chrome Web Store and other extensions' pages can't be
  searched. Chrome doesn't allow it. For files on your computer (`file://`), turn on **Allow access
  to file URLs** for Text Find+ on `chrome://extensions`.
- **A badly written regex can freeze the tab.** Patterns like `(a+)+$` can make the browser's
  regex engine run for a very long time ("catastrophic backtracking"). If a tab stops responding,
  open Chrome's Task Manager (⋮ → More tools → Task manager, or Shift+Esc on Windows/Linux), select
  the tab and click **End process**.
- At most 5000 matches are highlighted ("1 of 5000+"). On very large pages the search stops after
  about 1.5 seconds and shows the matches found so far.
- Live updates run only while the popup is open. Closing it removes the highlights and stops watching
  the page.
- Frames added to the page after the popup opens are searched when you reopen it.
- On very large pages, where a search stops early, live updates pause until a search finishes in time.
- Live updates watch changes to the page's elements and text, and to their `class`, `style`, `hidden`
  and `open` attributes, which is how pages usually show and hide things. Text shown or hidden any other
  way (a stylesheet rule on another attribute, `:hover`, a media query) and a web component whose
  shadow root appears after the search (a custom element defined late) are picked up at the next
  change or search.
- Case-insensitive matching uses JavaScript's simple case folding, so `ß` doesn't match `SS`.
- The small stylesheet that defines the highlight colours stays attached to the tab after you close
  the popup, until the page reloads or the tab goes to another page. Nothing is left to remove it
  sooner: only the popup can ask Chrome to, and the extension has no background worker. It does
  nothing once the highlights are gone.
- Your search isn't remembered across page reloads: it is deliberately kept only in the page's
  memory, and never saved to disk.

## Zip it for the Chrome Web Store

From the repository root:

```bash
node tools/package.mjs chrome
```

It puts `src/` and `chrome/` together in `build/chrome/` and zips that folder's contents, so that `manifest.json`
sits at the root of the zip: `build/text-find-plus-chrome-<version>.zip`, with the version from
`chrome/manifest.json`.

## Chrome Web Store listing

[`store/chrome/`](store/chrome/) holds what the Chrome Web Store asks for besides the zip.
[`store/chrome/listing.md`](store/chrome/listing.md) has the text for each field of the developer dashboard
(description, privacy answers, distribution) and says which image goes in which slot. The five 1280×800 screenshots,
the 440×280 small promo tile and the 1400×560 marquee promo tile sit next to it; the store icon is
`src/icons/icon128.png`.

The screenshots show the real popup and the real highlights on [`store/chrome/demo.html`](store/chrome/demo.html),
a made-up article. After a change to the popup, make all seven images again (headless, through the browser tests'
harness, so it needs Chrome for Testing as they do):

```bash
node tools/store-shots.mjs
```

## Development

The source is plain HTML, CSS and JavaScript with no dependencies. Nothing is compiled: packaging only copies files.

| Path | What it is |
|---|---|
| `src/popup/` | The popup: `popup.html`, `popup.css`, `popup.js`, plus `query.js` (turns the boxes into regex patterns), `frames.js` (combines results across frames, times live refreshes and picks which match stays current) and `theme.js` (applies the saved theme before the popup paints, and runs the theme button). |
| `src/content/highlighter.js` | The search engine injected into the page: collects visible text, matches, highlights, cleans up. |
| `src/content/highlight.css` | The highlight colours. |
| `src/icons/` | The toolbar icons. |
| `chrome/` | What only Chrome needs on top of `src/`: its `manifest.json`. |
| `tools/package.mjs` | Puts `src/` and a browser's folder together in `build/<browser>/` and zips it for that browser's store: `node tools/package.mjs chrome`, or `node tools/package.mjs` for every folder with a `manifest.json`. A browser's folder may only add files: one at the same path as a file in `src/` stops the packager, which names it. |
| `tools/make-icons.py` | Draws the toolbar icons into `src/icons/` (Python standard library only): `python3 tools/make-icons.py` |
| `tools/store-shots.mjs` | Makes the Chrome Web Store images in `store/chrome/`: `node tools/store-shots.mjs` |
| `store/chrome/` | The Chrome Web Store listing: the dashboard text, the images and the pages they are made from. |
| `build/` | What the packager writes. Not in git. |
| `tests/` | Unit tests, browser tests and the test page. |
| `docs/design/` | The design specs. |

### Running the tests

The tests use only Node.js 22 built-ins: no `npm install`.

```bash
node --test tests/*.test.mjs                              # unit tests (query parsing, frame merging, manifest)
node --test --test-timeout=300000 'tests/e2e/*.test.mjs'  # browser tests: the engine, the full extension and the test harness
```

A stalled browser test fails instead of hanging. A command Chrome doesn't answer within 10 seconds fails,
naming the command, and so does one whose tab or popup closes or crashes before it answers. A single test
that runs longer than 30 seconds fails under its own name. A `before`, `after`, `beforeEach` or `afterEach`
hook that runs longer than 60 seconds fails with a message that names the hook and the file that registered
it, and so does any other error such a hook throws. Node still lists a failing `after` hook under
`tests/e2e/lib/test.mjs`; the message under it names the real file. `--test-timeout` ends a test file that
stalls anyway: Node applies it to each file as a whole, not only to each test, so keep it well above the
minute or two the browser suite takes. A file ended that way, or stopped with Ctrl-C, closes its browsers
and removes their temporary profiles first.

Each run of the browser tests makes Chrome for Testing write three crash dumps of about 0.65 MB each, from the
harness tests that crash a tab and two popups on purpose (the popups crash in `tests/e2e/popup-crash.fixture.mjs`,
which `harness.test.mjs` runs in a child process; it is not a test file of its own); a popup that really crashes
writes two of about 1.5 MB. On macOS they go to
`~/Library/Application Support/Google/Chrome for Testing/Crashpad/pending`. The tests can't redirect or stop them,
so empty that folder by hand now and then.

The browser tests drive **Chrome for Testing**, which can load unpacked extensions and click their
toolbar button. They use `CHROME_PATH` if it's set; otherwise they use the newest build in the
Playwright cache. If you have neither, `npx playwright install chromium` downloads one, or follow
the manual plan in [TESTING.md](TESTING.md). The extension they load, like the one `tools/store-shots.mjs` loads, is
put together afresh from `src/` and `chrome/` by `tools/package.mjs` in a temporary folder that is removed afterwards,
so they always run the current code and never an old `build/`.

`node tests/e2e/spike.mjs` re-checks the platform assumptions the first version relies on, and
`node tests/e2e/spike-components.mjs` those for web components and live updates (painting inside
components, observing them, and what asking Chrome whether an element hosts a closed root costs).

## License

Copyright (C) 2026 The Text Find+ contributors

Text Find+ is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License** as published by the Free Software Foundation, either **version 3** of
the License, or (at your option) any later version (`GPL-3.0-or-later`). It is distributed in the
hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: you may use, study, change and share it. If you distribute a modified version (for example
on the Chrome Web Store), you must release your full source code under the same license.

Privacy: see [PRIVACY.md](PRIVACY.md). Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).
