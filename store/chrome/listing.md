# Chrome Web Store listing

Everything to enter in the Chrome Web Store developer dashboard for Text Find+ 1.0.0, one section per
dashboard field. Paste the contents of each block as it stands. The images are made by
`node tools/store-shots.mjs` (see the README).

## Package

From the repository root:

```bash
node tools/package.mjs chrome
```

It puts `src/` and `chrome/` together in `build/chrome/` and zips that folder's contents, so that `manifest.json`
sits at the root of the zip. Upload `build/text-find-plus-chrome-1.0.0.zip` (version **1.0.0**, from
`chrome/manifest.json`). It holds exactly these files, plus the folder entries `content/`, `icons/` and `popup/`:

```text
manifest.json
content/highlight.css
content/highlighter.js
icons/icon16.png
icons/icon48.png
icons/icon128.png
popup/frames.js
popup/popup.css
popup/popup.html
popup/popup.js
popup/query.js
popup/theme.js
```

## Store listing tab

### Item name

Taken from the manifest:

```text
Text Find+
```

### Summary

Taken from the manifest's `description` (122 characters; the limit is 132):

```text
Find text on any page with simple word searches or regex. Runs only when you click it, with no access to your other sites.
```

### Description

Plain text:

```text
Text Find+ finds text on the page you're looking at, with simple word searches or, when you want one, a real regular expression. It asks Chrome for the fewest possible permissions and runs only when you click it.

WHAT IT DOES

Click the toolbar icon (or press the shortcut) and type in any of these boxes:

• Any of these words: highlights each of the words wherever it appears.
• All of these words: highlights the words only if the page contains every one of them. Tick "in this order" to find them in the order you typed them, with any text in between.
• Regex (advanced): a JavaScript regular expression. While this box has text, the Any and All boxes are greyed out and ignored; empty it to bring them back.

Two options apply to every box: Match case (capitals must match, so Apple won't find apple) and Whole words (full words only, so cat won't find category). Both are off by default.

Matches light up in yellow and the current match in orange, and the count shows "3 of 27". Use Enter and Shift+Enter (or the ↑ and ↓ buttons) to move between matches; they wrap around at the ends. Clear empties the boxes and removes every highlight. However you close the popup (Close, Esc, or clicking the page), the highlights disappear. If you reopen it on the same page, your last search comes back.

The ▲ button collapses the popup to just its top bar, so it covers less of the page while ↑, ↓, Clear and Close keep working. The theme button switches the popup between Automatic (follows Chrome's light or dark setting), Light and Dark.

The suggested shortcut is Ctrl+Shift+F (Control+Shift+F on a Mac). Chrome only assigns it if no other extension uses it; you can set it at chrome://extensions/shortcuts.

HOW TO TYPE YOUR WORDS (ANY AND ALL BOXES)

• cat, dog: separate words with a space, a comma or |. Finds cat and dog.
• "ice cream": quotes keep words together as one phrase. Finds ice cream, not ice or cream alone.
• walk*: * stands for any letters in a word. Finds walks, walked and walking.

Every other character is matched literally, so C++, $10 and notes.txt find exactly that text. Whole words and * understand letters in any language.

HELP WITH REGEX

A cheat sheet that opens beside the popup, ready-made examples (prices, phone numbers, dates, email addresses and more), plain-language error messages and one-click "Try …" fixes help if you're new to regex.

LIVE UPDATES

While the popup is open, the results follow the page: when the page adds, removes, edits, shows or hides text, the count and highlights update within about a second. The current match stays the same match while its text is still there, and the page never scrolls by itself.

WEB COMPONENTS

Text inside open web components (shadow DOM) is searched like any other text, in the order the page shows it. Closed web components, and any page text placed inside them, aren't searched.

FINDS AND HIGHLIGHTS ONLY

Text Find+ only finds and highlights text. It never changes, adds to, removes from or replaces anything on a page. There is no find-and-replace.

PERMISSIONS

Text Find+ asks for two permissions, and Chrome shows no permission warning when you install it:

• activeTab: lets it access the tab you're looking at, only after you click its icon or press its shortcut on that tab. The access ends when you navigate the tab to a different page or close it.
• scripting: lets the popup inject the search script and the highlight colours into that tab.

There are no host permissions, no content scripts, no storage permission and no background worker. Other tabs and other sites are never accessible.

PRIVACY

Text Find+ collects nothing and sends nothing. The only things it stores are your theme choice, and only when it is Light or Dark (Automatic stores nothing), and whether you left the regex cheat sheet open, and only when you did (a closed one stores nothing). Both are kept on your device, in the popup's own local storage, and need no permission. It makes no network requests, uses no analytics and loads no remote code. It runs only on the tab where you open it, and only after you click its icon or press its shortcut. Your search text is used only to find matches on that page. While highlights are shown, the page's own scripts can see which text is highlighted, and so could work out what you searched for on that page. So that reopening the popup can restore your last search, the search is kept in that open page's memory. It is never written to disk and is gone as soon as the page reloads, navigates or closes.

GOOD TO KNOW

• Chrome's own pages (chrome://), the Chrome Web Store and other extensions' pages can't be searched; Chrome doesn't allow it.
• Frames from the same site as the page are searched; frames from other sites are skipped.
• Text in images, canvas, PDFs and form fields isn't searched.
• A badly written regex, such as (a+)+$, can freeze the tab.

Requires Chrome 123 or newer.

OPEN SOURCE

Text Find+ is free software under the GNU General Public License, version 3 or later (GPL-3.0-or-later). The code is small, plain and unminified JavaScript, so you can read exactly what runs:
https://github.com/MusKaya/text-find-plus
```

### Category

Suggested: **Productivity › Tools**. (**Make Chrome Yours › Functionality & UI** fits too.)

### Language

English.

### Graphic assets

| Dashboard slot | File | Size |
|---|---|---|
| Store icon | `src/icons/icon128.png` | 128×128 |
| Screenshot 1 | `store/chrome/screenshot-1-words.png` | 1280×800 |
| Screenshot 2 | `store/chrome/screenshot-2-regex.png` | 1280×800 |
| Screenshot 3 | `store/chrome/screenshot-3-collapsed.png` | 1280×800 |
| Screenshot 4 | `store/chrome/screenshot-4-all-words.png` | 1280×800 |
| Screenshot 5 | `store/chrome/screenshot-5-phrase-wildcard.png` | 1280×800 |
| Small promo tile | `store/chrome/promo-small-440x280.png` | 440×280 |
| Marquee promo tile | `store/chrome/promo-marquee-1400x560.png` | 1400×560 |
| Promo video | none (optional) | |

The screenshots and the tiles are PNGs without an alpha channel.

### Additional fields

| Field | Value |
|---|---|
| Official URL | none |
| Homepage URL | `https://github.com/MusKaya/text-find-plus` |
| Support URL | `https://github.com/MusKaya/text-find-plus` |
| Mature content | No |

## Privacy practices tab

### Single purpose description

```text
Text Find+ finds and highlights text on the web page you open it on, with word searches or a regular expression.
```

### Permission justification: activeTab

```text
Text Find+ searches only the page in the tab where you open it. activeTab gives it access to that tab only after you click its toolbar icon or press its shortcut there, and the access ends when you navigate the tab to a different page or close it. It has no access to any other tab or site.
```

### Permission justification: scripting

```text
The popup uses the scripting API on the tab where you opened it, and only there: it checks which frames of that tab already have the search script, injects the search script (content/highlighter.js) and the highlight colours (content/highlight.css) into the others, and the script then finds and highlights the matches. Only code packaged with the extension is injected. Without scripting it cannot search or highlight the page.
```

There are no host permissions to justify.

### Remote code

**No, I am not using remote code.** All JavaScript is in the package, and the manifest's content security policy
allows scripts from the package only (`script-src 'self'`).

### Data usage

Tick **none** of the data types. Text Find+ collects none of them: personally identifiable information, health
information, financial and payment information, authentication information, personal communications, location,
web history, user activity, website content.

Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

```text
https://github.com/MusKaya/text-find-plus/blob/main/PRIVACY.md
```

## Distribution tab

| Field | Suggested value |
|---|---|
| Payments | Free of charge |
| Visibility | Public |
| Regions | All regions |
