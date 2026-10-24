# Manual test plan

The automated browser tests (`node --test --test-timeout=300000 'tests/e2e/*.test.mjs'`) run these same
checks. Use this plan when you can't run them, or to see the behaviour yourself.

Each run of the browser tests makes Chrome for Testing write three crash dumps of about 0.65 MB each, from the
harness tests that crash a tab and two popups on purpose; a popup that really crashes writes two of about 1.5 MB.
On macOS they go to
`~/Library/Application Support/Google/Chrome for Testing/Crashpad/pending`. The tests can't redirect or stop them,
so empty that folder by hand now and then.

## Setup

1. Put the Chrome version together from the repository root with `node tools/package.mjs chrome`, then load it
   unpacked: `chrome://extensions` → **Developer mode** → **Load unpacked** → select the `build/chrome/` folder.
   After a change to the code, run the packager again and click the extension's reload button.
2. Serve the test pages from the repository root:

   ```bash
   python3 -m http.server -d tests 8000
   ```

3. Open **<http://localhost:8000/test.html?xorigin=http://127.0.0.1:8000>**.

**Why serve the page instead of opening the file directly?** On `file://` pages Chrome blocks
extensions unless you turn on "Allow access to file URLs". Serving also gives the page a real
origin. The `?xorigin=` part loads the second iframe from `127.0.0.1` instead of `localhost`, which
makes it a **cross-origin** frame. The first iframe is same-origin.

"Open the popup" means: click the Text Find+ toolbar icon (or press the shortcut). Before each
case, press **Clear** unless the case says otherwise. Typing updates results after a short pause.

## Cases

| # | Case | Steps | Expected |
|---|---|---|---|
| 1 | Plain match | Any box: `cheap` | Count **1 of 3**; three words highlighted yellow, the first orange. |
| 2 | Regex with groups | Regex box: `(cheap\|deals) (flight\|page)` | **1 of 3** ("Cheap flight", "cheap flight", "deals page"). |
| 3 | Case toggle | Any: `Cheap`, then tick **Match case**, then untick it | **1 of 3** → **1 of 1** → **1 of 3**. |
| 4 | Invalid regex | Regex: `(abc` | Message "A ( is missing its closing ). To find a ( itself, write \(" with Chrome's original error below it; no highlights. |
| 5 | No matches | Any: `zebra` | **No matches**; nothing highlighted. |
| 6 | Must **not** match | Same as 5 | The page has "zebra" inside a textarea, an input, a `<script>`, a `<style>`, `<noscript>`, a `<template>`, a dropdown and three hidden spans. None of them may be found. |
| 7 | Next/previous wraparound | Any: `colo*r` → **Shift+Enter** → **Enter** → **↓** → **↑** | **1 of 5** → **5 of 5** → **1 of 5** → **2 of 5** → **1 of 5**; the orange match moves and scrolls into view. |
| 8 | All words, one missing | All: `cheap zebra` | Message "Not on this page: zebra"; no highlights. |
| 9 | In-order description | Tick **in this order** | The All box description becomes "Only highlights them in this order, with any text in between." and stays on one line. |
| 10 | In-order sequences | All: `flight cheap`, tick **in this order** | **1 of 2**; "Flight … cheap" highlighted as one match; message "Each match is one in-order sequence". |
| 11 | Looks like a regex | Any: `\d+` | Tip "This looks like a regex…" → click **Move it to the Regex box** → text moves to the Regex box, Any box empties, count **1 of 13**. |
| 12 | Regex tip | Regex: `st*n` | Tip explaining `*` → click **Try st\w*n** → **1 of 2** (Istanbul, İSTANBUL). |
| 13 | Regex box overrides | Any: `cheap`, Regex: `fl.ght` | Message "The Regex box is in use, so the Any and All boxes are ignored. Empty the Regex box to use them again."; the Any and All boxes and **in this order** are greyed out; **1 of 5**. |
| 14 | Cheat sheet panel | Click **◂ Open regex cheat sheet**, then **Phone numbers like 555-1234**, then **Close** | The panel opens to the left of the popup (the popup widens); the Regex box shows `\d{3}-\d{4}`, **1 of 2**; **Close** closes the panel and the popup returns to its normal width. The toggle also opens and closes it. |
| 15 | Clear | Type in Any and All, then click **Clear** | All boxes empty, count empty, no highlights. |
| 15a | Close button | Any: `cheap`, then click **Close** | The popup closes and all highlights disappear. |
| 15b | No scrolling | Open the popup | Everything is visible without scrolling, from the title to the Options band. |
| 16 | Closing removes highlights | Any: `cheap`, then click on the page (the popup closes) | All highlights disappear immediately. |
| 17 | Reopen restores | Open the popup again right after case 16 | Any box shows `cheap`, **1 of 3**, highlights back. |
| 18 | Fast typing | Type `cheap` quickly | Ends on **1 of 3** (never a stale count from a shorter prefix). |
| 19 | Frames | Any: `framed` | **1 of 1**: only the same-origin frame is searched. The cross-origin frame contains the same word but is skipped. |
| 20 | Reload forgets | Search `cheap`, close the popup, reload the page, open the popup | Boxes are empty; searching `cheap` again gives **1 of 3**. |
| 21 | Restricted page | Open `chrome://version`, open the popup | "Text Find+ can't search this page…" message; the boxes are disabled. |
| 22 | Whole words | Any: `run`, then tick **Whole words** | **1 of 4** → **1 of 1**. |
| 23 | Phrases and separators | Any: `"cheap flight"`, then `cheap \| flight` | **1 of 2** → **1 of 8**. |
| 24 | Turkish letters | Any: `istanbul` | **1 of 2** (Istanbul and İSTANBUL). |
| 25 | Keyboard shortcut | Press Ctrl+Shift+F (Control+Shift+F on Mac) on the test page | The popup opens. If not, assign it at `chrome://extensions/shortcuts`. |
| 26 | Web components | Any: `lantern`, then Any: `zircon` | `lantern`: **1 of 4**: "open", "nested", "slotted" and "fallback" lantern are highlighted. The closed lantern is not (closed web components aren't searched), and neither are the hidden, undisplayed and ghost lanterns (they aren't shown on the page). `zircon`: **1 of 1**, "The control zircon." The page also has `zircon` as text placed inside seven closed components, four of which show it on screen; none is highlighted, because closed web components and the page text inside them aren't searched. |
| 27 | Across a component's edge | Any: `"Hello World"` | **1 of 1**: "Hello" and "World" (which sits inside a web component) highlighted as one match. |
| 28 | Live updates | Close the popup, click **Add a line every 2 seconds** on the page, open the popup, Any: `tick`, then press **Enter** once | The count rises by one every two seconds. The page never scrolls by itself, and the orange match stays on the same line. |
| 29 | Theme | Click the top-bar button until it shows A with a small raised ◐ (Automatic); then click it once; click it again; close and reopen the popup; then click it once more | First click: ☀ Light, the popup turns light. Second click: ☾ Dark, the popup turns dark. After reopening, it is still dark (☾). Last click: A with its small raised ◐, Automatic, the popup follows Chrome's own light or dark setting. |
| 30 | Collapse | Any: `colo*r`, click **◂ Open regex cheat sheet**, then **▲** in the top bar; click **↓**, then **↑**; click **▼**; click **Close** in the cheat sheet, then **▲**, **Clear**, **▼** | **▲**: only the top bar shows, still **1 of 5**; the boxes and the cheat sheet disappear, the popup shrinks to the bar and the triangle now points down, **▼**, and is about as big as **↑** and **↓**. **↓**: **2 of 5**, the orange match moves; **↑**: **1 of 5**. **▼**: the boxes come back with the cheat sheet open, as wide as before, and the triangle points up again. After closing the cheat sheet, **▲** shrinks the popup to the bar again; **Clear** empties the count and removes every highlight, and the popup stays collapsed; **▼** brings back the boxes, empty, with the cheat sheet still closed. |
| 31 | Cheat sheet remembered | Click **◂ Open regex cheat sheet**, close the popup and open it again; click **Close** in the cheat sheet, close the popup and open it again; click **▲**, close the popup and open it again | First reopen: the cheat sheet is open. Second reopen: it is closed. Third reopen: the popup is expanded, with the cursor in the Any box. |
| 32 | Regex greys out the boxes | Look at the Regex label; Any: `cheap`, All: `flight`, tick **in this order**; Regex: `fl.ght`; hold the pointer over the Any box, then over **in this order**; delete all the Regex text; click **◂ Open regex cheat sheet**, then **color or colour**, then **Close**; close the popup and open it again; click **Clear** | The label reads "REGEX (advanced; Any and All are ignored until this Regex box is empty)", with nothing under the Regex box but the cheat-sheet button. Regex `fl.ght`: at once, the Any and All cards (headings, boxes, descriptions and **in this order**) are greyed out and can't be typed in or ticked; Match case, Whole words and the Regex box still work; **1 of 5**. Over the Any box a tooltip says "Ignored while the Regex box has text. Empty the Regex box to use it again."; over **in this order** the pointer is an arrow, not a hand. Regex emptied: at once the cards are back, still showing `cheap`, `flight` and **in this order** ticked, with no tooltip. **color or colour**: the Regex box shows `colou?r` and the cards are greyed out again, with their text. Reopened: the Regex box still shows `colou?r`, the cards are still greyed out with their text, and the cursor is in the Regex box. **Clear**: every box is empty and the cards are back, with the cursor in the Any box. |
| 33 | Arrows grey out | Close the popup and open it again, with the boxes empty; hold the pointer over **↓**; Any: `cheap`, hold the pointer over **↓**, then click it; Any: `zebra`; Any: `cheap`; click **Clear** | Opened with empty boxes: **↑** and **↓** are greyed out (dimmed as a disabled box is) and clicking them does nothing; over **↓** the pointer is an arrow, not a hand, and the button doesn't darken. `cheap`: **1 of 3** and the arrows are back in their full green; over **↓** the pointer is a hand and the button darkens slightly; the click moves to **2 of 3**. `zebra`: **No matches**, and the arrows are greyed out again. `cheap`: **1 of 3**, the arrows are back. **Clear**: the count empties and the arrows are greyed out at once. |
