// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Whether Chrome draws a word, for tests that pin what is found against what is on screen.
import assert from 'node:assert/strict';

/** A fixture box pinned to the top of the viewport, so `drawn()` can photograph the words in it. */
export const PINNED = 'position: fixed; top: 0; left: 0; width: 1000px; z-index: 2147483647; background: white; font: 16px/24px sans-serif';

/**
 * Whether Chrome draws each word (a text node's whole text, found through open shadow roots), told by its pixels: the
 * word's box is photographed with a magenta highlight on the word and without, and Chrome paints a highlight only on
 * text it draws. Its rects can't tell, nor can a hit test: Chrome lays out text that content-visibility hides when it
 * is asked for its rects, and hit-tests text that visibility: hidden hides. The words must be in the viewport of
 * `session`'s page, in its main world.
 */
export async function drawn(session, words) {
  const run = (expr) => session.evaluate(expr);
  await run(`document.head.append(Object.assign(document.createElement('style'),
    { id: 'drawn-probe', textContent: '::highlight(drawn-probe) { background-color: rgb(255, 0, 255); }' }))`);
  try {
    const out = {};
    for (const word of words) {
      const box = await run(`(() => {
        const nodes = [document.body];
        while (nodes.length) {
          const n = nodes.pop();
          if (n.nodeType === 3 && n.data === ${JSON.stringify(word)}) {
            const r = document.createRange();
            r.selectNodeContents(n);
            globalThis.__drawnRange = r;
            const b = r.getBoundingClientRect();
            return [b.x + scrollX, b.y + scrollY, b.width, b.height];
          }
          if (n.shadowRoot) nodes.push(n.shadowRoot);
          nodes.push(...n.childNodes);
        }
        return null;
      })()`);
      assert.ok(box, `"${word}" is not on the page`);
      const [x, y, width, height] = box;
      if (!(width > 0 && height > 0)) { out[word] = false; continue; }
      const shot = async () => (await session.send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } })).data;
      await run(`CSS.highlights.set('drawn-probe', new Highlight(__drawnRange))`);
      const lit = await shot();
      await run(`CSS.highlights.delete('drawn-probe')`);
      out[word] = lit !== (await shot());
    }
    return out;
  } finally {
    await run(`CSS.highlights.delete('drawn-probe'); document.getElementById('drawn-probe').remove(); delete globalThis.__drawnRange`);
  }
}
