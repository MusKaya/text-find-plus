# Contributing to Text Find+

Thanks for helping. Bug reports, fixes and improvements are all welcome. This page says what the project
will and won't take, how to set up, and what a change needs before it can be merged.

## What Text Find+ is, and stays

These rules are the reason the extension exists. A change that breaks one of them won't be merged, however
useful it is. If you think one should change, open an issue to discuss it first.

- **It only finds and highlights.** It never changes, adds to, removes from or replaces anything on a page.
  There is no find-and-replace.
- **Two permissions: `activeTab` and `scripting`.** No host permissions, no content scripts, no `storage`
  permission, no background worker. Anything that needs more is a discussion before it is code.
- **Nothing leaves your device.** No network requests, no analytics, no remote code. The only things stored are
  the ones [PRIVACY.md](PRIVACY.md) lists. If your change stores anything else, it isn't a fit.
- **Plain HTML, CSS and JavaScript, with no dependencies.** No frameworks, bundlers or minifiers. Packaging only
  copies files, so the code people install is the code in this repository.
- **One shared source.** The extension's code lives once, in `src/`. A browser's folder (`chrome/`, and later
  others) holds only what that browser needs on top of it, such as its `manifest.json`. `tools/package.mjs` refuses
  to package a browser file that would replace one in `src/`.

## Setting up

You need **Node.js 22 or newer** and the `zip` command. Nothing is installed from npm.

```bash
node tools/package.mjs chrome   # puts src/ and chrome/ together in build/chrome/ and zips it
```

Then load `build/chrome/` unpacked, as the README's install section describes. After a change, run the
packager again and click the extension's reload button on `chrome://extensions`.

The browser tests drive **Chrome for Testing**. They use `CHROME_PATH` if it's set, or else the newest build in
the Playwright cache; `npx playwright install chromium` downloads one. Python 3 is needed only to redraw the icons
(`python3 tools/make-icons.py`).

## Making a change

1. **Open an issue first** for anything beyond a small fix, and for any change to behaviour, the popup's look or
   permissions. It saves you work if the answer is no.
2. **Add or change tests with the code.** Pure logic (`src/popup/query.js`, `src/popup/frames.js`) has unit tests
   in `tests/`. Anything a user can see or do has browser tests in `tests/e2e/`. A new test should fail without
   your change: break the code on purpose once and check that it does.
3. **Run both suites**, and say in the pull request that you did:

   ```bash
   node --test tests/*.test.mjs
   node --test --test-timeout=300000 'tests/e2e/*.test.mjs'
   ```

   Now and then Chrome for Testing crashes a popup on a busy machine. The harness reports it as a crash, not as a
   failed check. Run the suite again; a failure that isn't a crash is real.
4. **Check by hand** what you changed, using the rows of [TESTING.md](TESTING.md) that cover it. Add a row for new
   behaviour, with exact steps and exact expected results.
5. **Keep the documents true in the same change.** Update README.md, TESTING.md or PRIVACY.md wherever your change
   makes them wrong. If the popup looks different, regenerate the store images with `node tools/store-shots.mjs`
   and commit them. The specs in `docs/design/` record why the extension behaves as it does, and code comments cite
   their sections as "spec §…": don't renumber those sections.

## Style

- Match the code around you: its naming, its comment density, and how it handles errors.
- Every source file (`.js`, `.mjs`, `.css`, `.html`, `.py`) starts with these two lines, in that file type's comment
  syntax. `tests/license.test.mjs` checks for them.

  ```text
  Copyright (C) 2026 The Text Find+ contributors
  SPDX-License-Identifier: GPL-3.0-or-later
  ```

- Commit messages start with the area they touch (`Engine:`, `Popup:`, `Test:`, `Docs:`, `Store:`, `Tools:`), and
  the subject says what changes for someone using or working on the extension. A body is welcome when the why isn't
  obvious from the diff.

## Pull requests

Fork the repository, make your change on a branch, and open a pull request against `main`. In it, say what changed
and why, link the issue, and list what you ran: the two test commands and the TESTING.md rows you checked. Keep each
pull request to one change; two unrelated fixes are two pull requests.

## Reporting a bug

Open an issue with:

- your browser and its version;
- the page: a public URL, or better, a small HTML snippet that shows the problem;
- what you typed and in which box (Any, All or Regex), with Match case and Whole words as they were;
- what you expected, and what happened instead.

Please don't paste private page content into an issue.

For a security problem, don't open a public issue. Use **Report a vulnerability** on the repository's **Security**
tab, so it can be fixed before it is public.

## License

Text Find+ is licensed under the GNU General Public License, version 3 or later (`GPL-3.0-or-later`). By
contributing, you agree that your contribution is licensed the same way. You keep the copyright in what you write;
the file headers name the project's contributors together, as "The Text Find+ contributors".
