// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// The popup's colour theme: Automatic (follows Chrome's light/dark setting), Light or Dark.
// A classic script in <head> (no type, defer or async), so the saved choice is on <html> before the
// first paint. It also owns the #theme button. The choice lives in the popup's own localStorage.
(() => {
  const KEY = 'theme';
  // Cycle order. `name` is the stored value and the data-theme value; null means Automatic. A `badge` is a small
  // raised mark after the glyph; Automatic has one to show that it changes by itself.
  const MODES = [
    { name: null, glyph: 'A', badge: '\u25D0\uFE0E', label: 'Theme: Automatic (follows Chrome). Click for Light.' },
    { name: 'light', glyph: '\u2600\uFE0E', label: 'Theme: Light. Click for Dark.' },
    { name: 'dark', glyph: '\u263E\uFE0E', label: 'Theme: Dark. Click for Automatic.' },
  ];

  /** The saved mode's index; anything unreadable or unrecognised is Automatic. */
  function read() {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* storage unavailable: Automatic */ }
    const at = MODES.findIndex((mode) => mode.name !== null && mode.name === saved);
    return at === -1 ? 0 : at;
  }

  function apply(index) {
    const { name } = MODES[index];
    if (name) document.documentElement.setAttribute('data-theme', name);
    else document.documentElement.removeAttribute('data-theme');
  }

  function save(index) {
    const { name } = MODES[index];
    try {
      if (name) localStorage.setItem(KEY, name);
      else localStorage.removeItem(KEY);
    } catch { /* storage unavailable: the choice lasts until the popup closes */ }
  }

  let current = read();
  apply(current);

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme');
    if (!button) return;
    const show = () => {
      const { glyph, badge } = MODES[current];
      button.replaceChildren(glyph);
      if (badge) {
        const sup = document.createElement('sup');
        sup.textContent = badge;
        button.append(sup);
      }
      button.title = MODES[current].label;
      button.setAttribute('aria-label', MODES[current].label);
    };
    show();
    button.addEventListener('click', () => {
      current = (current + 1) % MODES.length;
      apply(current);
      save(current);
      show();
    });
  });
})();
