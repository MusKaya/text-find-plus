// Copyright (C) 2026 The Text Find+ contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Text Find+ page engine. The popup injects this on demand into the extension's isolated world.
// It never modifies the page DOM: matches are painted with the CSS Custom Highlight API.
(() => {
  if (globalThis.__textFindPlus === true) return;

  const CAP = 5000;
  const TIME_BUDGET_MS = 1500;
  const MATCH = 'text-find-plus-match';
  const CURRENT = 'text-find-plus-current';
  const PORT_NAME = 'text-find-plus';
  // HTML elements never rendered as text: code, form fields, templates, and fallback content of replaced elements.
  // Elements outside HTML with these names are walked like any other: a MathML one holding a token is drawn, and an
  // SVG one is never drawn, which checkVisibility() reports.
  const SKIP = new Set(['script', 'style', 'noscript', 'textarea', 'input', 'select', 'option', 'template',
    'iframe', 'canvas', 'video', 'audio']);
  const CLOCK_EVERY = 256; // nodes between clock checks while collecting text
  const MATCH_GRACE_MS = 300; // matching time left after text collection used up the budget
  const POS = 4294967296; // 2^32: a hit's page position is blockIndex * POS + offset
  // Computed displays on which Chrome ignores content-visibility, so it draws what is inside (measured in Chrome for
  // Testing 151, spec §4.2): boxes that containment doesn't apply to (display: contents, non-atomic inline boxes,
  // table rows and row groups, internal ruby boxes) and, beyond what the containment spec lists, tables.
  const CV_IGNORED = new Set(['contents', 'inline', 'inline list-item', 'ruby', 'ruby-text', 'table', 'inline-table',
    'table-row', 'table-row-group', 'table-header-group', 'table-footer-group']);
  // Elements that can host a shadow root besides custom elements (names with a "-"), per attachShadow(). Outside HTML,
  // Chrome attaches roots to these names too, but never to a name with a "-".
  const HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'main', 'nav', 'p', 'section', 'span']);
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  // The HTML element `name`: every element the walk treats by name is one only in the HTML namespace, since a MathML
  // or SVG element can have the same name and none of the meaning (couldHost() takes HOSTS names in any namespace).
  const isHTML = (el, name) => el.localName === name && el.namespaceURI === HTML_NS;
  // The MathML elements Chrome draws text placed directly in under any display that draws the element (measured in
  // Chrome for Testing 151, spec §4.2): the tokens. Text directly in any other MathML element, <math> itself and the
  // table ones included, is not drawn while the element has a math display; given another display (block,
  // inline-block, ...), which <mtable>, <mtr> and <mtd> have by default, it is laid out like any box.
  const MATHML_TOKENS = new Set(['mi', 'mn', 'mo', 'ms', 'mtext']);
  const couldHost = (el) => HOSTS.has(el.localName) || (el.namespaceURI === HTML_NS && el.localName.includes('-'));
  // Chrome tells whether an element hosts a closed shadow root only to the extension's own world, and chrome.runtime.id,
  // which is set only there, decides which world this is, not whether the call exists. In the extension the answer is
  // required: a missing or failing call stops the search with an error, and is never read as "no element is closed",
  // which would count the text closed components hide. The page's world (where the engine tests run) has no such
  // answer, and there no element counts as closed.
  const inExtension = Boolean(globalThis.chrome?.runtime?.id);
  // Whether `el` hosts a closed shadow root, which is skipped with everything in it (spec §4.6). Only whether one
  // exists is asked: the answer is tested for null (or undefined) and never touched, kept or passed on, so nothing in
  // a closed root can be read, highlighted or handed to the page. Chrome's call returns open roots as well as closed
  // ones, so an element whose shadowRoot is set answers no without being asked: it has at most one root, and that one
  // is open. Chrome answers only for HTML elements, yet attaches roots to an element outside HTML with a HOSTS name (a
  // <div> in another namespace), so one of those is skipped the same way, unasked. The call is written out in full so
  // a test can wrap it at run time.
  const hostsClosedRoot = (el) => inExtension && !el.shadowRoot && couldHost(el)
    && (el.namespaceURI !== HTML_NS || chrome.dom.openOrClosedShadowRoot(el) != null);

  /**
   * Collect visible text as blocks, reading the page as it is displayed (the flat tree, spec §4.2): a shadow
   * host's children are its shadow root's, a slot shows what is assigned to it (or its fallback), and a host's
   * own children are reached only through the slots that show them. Only open shadow roots are entered. A
   * host with a closed one is skipped with its light DOM, which can't be judged shown or hidden without
   * reading the root (spec §4.6). A block is consecutive text nodes with the same nearest block-level
   * ancestor: { text, pieces: [{ node, start, len }] }; a <br> adds a virtual "\n". Returns
   * { blocks, roots, where }: every (open) shadow root entered, and each collected text node's
   * { block, start }. Stops early (returning what it has) once `clock` expires, so huge pages stay responsive.
   */
  function buildModel(doc, clock) {
    const blocks = [];
    const roots = [];
    const where = new Map();
    if (!doc.body) return { blocks, roots, where };
    const view = doc.defaultView;
    const style = new WeakMap();
    const styleOf = (el) => {
      let s = style.get(el);
      if (!s) style.set(el, (s = view.getComputedStyle(el)));
      return s;
    };
    // Parents in the flat tree, recorded by the walk: parentElement stops at a shadow root, and a slotted
    // node's parent in the flat tree is its slot.
    const up = new WeakMap();
    const blockOf = new WeakMap();
    const blockElement = (el) => {
      const seen = [];
      let found = doc.body;
      for (let e = el; e && e !== doc.body; e = up.get(e)) {
        const cached = blockOf.get(e);
        if (cached) { found = cached; break; }
        seen.push(e);
        const d = styleOf(e).display;
        if (!(d.startsWith('inline') || d === 'contents')) { found = e; break; }
      }
      for (const e of seen) blockOf.set(e, found);
      return found;
    };
    const childrenOf = (el) => {
      const root = el.shadowRoot; // an open root: null for a closed one and for an element that hosts none
      if (root) { roots.push(root); return root.childNodes; }
      if (hostsClosedRoot(el)) return [];
      // A slot in a shadow tree shows what is assigned to it, one level at a time: an assigned slot is walked like any
      // element, so its own style counts. With nothing assigned, it shows its own children, its fallback.
      // (An element named slot outside HTML, such as one inside <math>, is not a slot and has no assigned nodes.)
      if (isHTML(el, 'slot') && el.getRootNode() !== doc) {
        const assigned = el.assignedNodes();
        if (assigned.length) return assigned;
      }
      return el.childNodes;
    };
    // A <details> element's summary is its first <summary> child; any other one is part of its content.
    const summaryOf = (details) => {
      for (const c of details.children) if (isHTML(c, 'summary')) return c;
      return null;
    };
    // Whether `parent` shows none of `child`, as Chrome draws it: a table column draws nothing inside it;
    // content-visibility: hidden (which is what hidden="until-found" sets) hides the content unless the parent's
    // display is one Chrome ignores it on; a closed <details> shows only its summary; and a MathML element other than
    // a token (MATHML_TOKENS) draws no text placed directly in it while its display is still a math one.
    const hides = (parent, child) => {
      const s = styleOf(parent);
      return s.display === 'table-column' || s.display === 'table-column-group'
        || (s.contentVisibility === 'hidden' && !CV_IGNORED.has(s.display))
        || (isHTML(parent, 'details') && !parent.open && child !== summaryOf(parent))
        || (child.nodeType === 3 && parent.namespaceURI === MATHML_NS && !MATHML_TOKENS.has(parent.localName)
          && /\bmath\b/.test(s.display));
    };
    // An element is hidden when its parent hides it, or when checkVisibility() is false for it, unless it is
    // display: contents (every <slot>, by default): that has no box of its own, so checkVisibility() is false, but
    // it shows its children, and only its parent's answer counts. checkVisibility() alone misses one case: it is
    // true for an element in a table caption whose content-visibility hides it.
    const hidden = (el, parent) => hides(parent, el)
      || (el.checkVisibility && !el.checkVisibility() && styleOf(el).display !== 'contents');

    let current = null;
    let currentEl = null;
    let visited = 0;
    const stack = [{ parent: doc.body, nodes: childrenOf(doc.body), i: 0 }];
    walk: while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.nodes.length) { stack.pop(); continue; }
      const n = top.nodes[top.i++];
      const parent = top.parent;
      const isText = n.nodeType === 3;
      if (!isText) {
        if (n.nodeType !== 1 || (n.namespaceURI === HTML_NS && SKIP.has(n.localName)) || hidden(n, parent)) continue;
        up.set(n, parent);
        if (!isHTML(n, 'br')) { stack.push({ parent: n, nodes: childrenOf(n), i: 0 }); continue; }
      }
      if (++visited % CLOCK_EVERY === 0 && clock.expired()) break walk;
      if (isText && (!n.data || styleOf(parent).visibility !== 'visible' || hides(parent, n))) continue;
      const blockEl = blockElement(parent);
      if (blockEl !== currentEl) {
        if (isText && !n.data.trim()) continue; // whitespace between blocks
        current = { text: '', pieces: [] };
        currentEl = blockEl;
        blocks.push(current);
      }
      if (isText) {
        where.set(n, { block: blocks.length - 1, start: current.text.length });
        current.pieces.push({ node: n, start: current.text.length, len: n.data.length });
        current.text += n.data;
      } else {
        current.text += '\n';
      }
    }
    return { blocks, roots, where };
  }

  /** Index of the piece holding a block offset; ends map into the piece before the offset. */
  function pieceAt(pieces, off, isEnd) {
    let lo = 0, hi = pieces.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (isEnd ? pieces[mid].start < off : pieces[mid].start <= off) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx;
  }

  const offsetIn = (p, off) => Math.max(0, Math.min(off - p.start, p.len));
  // Two pieces share a Range only when the second's text node is the next text node after the first's in their
  // tree (spec §4.4): a Range covers every text node between its ends, and named slots, or a closed component that
  // shows its page text, can put text there that the match doesn't cover.
  const sameRun = (doc, p, q) => {
    const next = doc.createTreeWalker(p.node.getRootNode(), NodeFilter.SHOW_TEXT);
    next.currentNode = p.node;
    return next.nextNode() === q.node;
  };

  /**
   * Ranges covering block offsets [a, z). A Range can't start and end in different trees, so a match that
   * crosses a web component's edge gets one Range per run of pieces in the same tree.
   */
  function rangesFor(doc, block, a, z) {
    const ps = block.pieces;
    const first = pieceAt(ps, a, false), last = pieceAt(ps, z, true);
    const out = [];
    let from = first;
    for (let i = first; i <= last; i++) {
      if (i < last && sameRun(doc, ps[i], ps[i + 1])) continue;
      const r = doc.createRange();
      r.setStart(ps[from].node, from === first ? offsetIn(ps[first], a) : 0);
      r.setEnd(ps[i].node, i === last ? offsetIn(ps[last], z) : ps[i].len);
      out.push(r);
      from = i + 1;
    }
    return out;
  }

  function advance(text, i, unicode) {
    const c = text.charCodeAt(i);
    return i + (unicode && c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1);
  }

  /** Every non-empty hit of `re`, in page order, up to `limit`; stops early when the clock expires. */
  function hitsOf(re, blocks, clock, limit) {
    const out = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      if (clock.expired()) break;
      const text = blocks[bi].text;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) { re.lastIndex = advance(text, re.lastIndex, re.unicode); continue; }
        out.push({ b: bi, a: m.index, z: m.index + m[0].length, g: bi * POS + m.index, ge: bi * POS + m.index + m[0].length });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  const firstAtOrAfter = (hits, pos) => {
    let lo = 0, hi = hits.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (hits[mid].g >= pos) hi = mid; else lo = mid + 1; }
    return lo;
  };
  const lastEndingBy = (hits, pos) => {
    let lo = 0, hi = hits.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (hits[mid].ge <= pos) lo = mid + 1; else hi = mid; }
    return lo - 1;
  };

  /**
   * Non-overlapping in-order sequences (term 1, then term 2 later, ...), each using the tightest
   * window: the earliest place a full sequence can end, then the latest start for each earlier term.
   */
  function sequences(per, limit) {
    const out = [];
    let from = 0;
    while (out.length < limit) {
      const picks = [];
      let pos = from;
      for (const hits of per) {
        const i = firstAtOrAfter(hits, pos);
        if (i === hits.length) return out;
        picks.push(hits[i]);
        pos = hits[i].ge;
      }
      for (let k = per.length - 2; k >= 0; k--) {
        const j = lastEndingBy(per[k], picks[k + 1].g);
        if (j >= 0 && per[k][j].g >= from) picks[k] = per[k][j];
      }
      out.push(picks);
      from = picks[picks.length - 1].ge;
    }
    return out;
  }

  // ---------- Scrolling to a match (spec §4.5) ----------
  // reveal() scrolls a match only when it can't be seen, and moves only what has to move. boxesAround() lists the boxes
  // that clip it, outside() judges it against each, and clearBar() moves it out from under a sticky or fixed bar.

  // The parent of `node` in the flat tree: the slot that shows it, else its parent; a shadow root's is its host.
  // assignedSlot is null for a node shown through a slot in a closed root (spec §4.3). That is safe only because
  // closed hosts are skipped whole (spec §4.6): no match is inside one, and from a node placed inside one this leads
  // up to the host itself, which clearBar() takes in its place.
  const flatParent = (node) => {
    const parent = node.assignedSlot ?? node.parentNode;
    return parent?.nodeType === 11 ? parent.host : parent;
  };
  // The element a match's text node sits in. A text node directly inside a shadow root has no parentElement: its host.
  const elementOf = (node) => node.parentElement ?? node.parentNode?.host;
  // The outermost of `el` and its flat-tree ancestors that hosts a closed shadow root, or undefined. They are asked the
  // yes/no question (hostsClosedRoot()) from the top down, so nothing below that host is asked even that.
  const closedHostOf = (el) => {
    const up = [];
    for (let e = el; e?.nodeType === 1; e = flatParent(e)) up.push(e);
    return up.reverse().find(hostsClosedRoot);
  };

  // Computed displays of non-atomic inline boxes (an inline-block is atomic, so not one): they have no box to clip
  // with, and contain a fixed element only through a filter (containsFixed()). Measured in Chrome for Testing 151.
  const NON_ATOMIC_INLINE = /^(inline|ruby|ruby-text|inline list-item)$/;
  // Table rows and row groups, which take no paint or layout containment: measured in Chrome for Testing 151, and
  // Chromium's IsEligibleForPaintOrLayoutContainment says the same in 123.
  const NO_CONTAINMENT = /^table-(row|row-group|header-group|footer-group)$/;
  // The will-change names that make an element contain a fixed element, matched as whole names and in any case (Chrome
  // keeps the case they were written in, and honours every case): a will-change of transform-origin,
  // -webkit-backdrop-filter or my-transform names none of them. Measured in Chrome for Testing 151.
  const WILL_TRANSFORM = new Set(['transform', '-webkit-transform', 'transform-style', '-webkit-transform-style',
    'perspective', '-webkit-perspective', 'translate', 'rotate', 'scale', 'offset', 'offset-path', 'offset-position']);
  const WILL_FILTER = new Set(['filter', '-webkit-filter', 'backdrop-filter']);
  const WILL_CONTAIN = new Set(['contain']);
  const willNames = (s, names) => s.willChange.split(',').some((name) => names.has(name.trim().toLowerCase()));
  // Whether an element with computed style `s` is the containing block of its fixed (and absolutely positioned)
  // descendants, which then belong to it and are clipped by what clips it: a transform of any kind, a perspective, an
  // offset-path or an offset-position other than normal or auto, a filter or backdrop-filter, transform-style:
  // preserve-3d, or a will-change that names one of those (WILL_TRANSFORM, which has the offset shorthand too, and
  // WILL_FILTER); and, except on a table row or row group, paint or layout containment, a will-change that names
  // contain, or content-visibility: auto. A non-atomic inline element (display: inline, ruby, ruby-text or inline
  // list-item) contains them only with a filter or backdrop-filter, or a will-change that names one, and a display:
  // contents element, which has no box, never does. Measured in Chrome for Testing 151, and Chromium's
  // LayoutObject::ComputeIsFixedContainer lists the same in 123. Opacity, clip-path, mask, isolation, mix-blend-mode,
  // contain: size or style, container-type and will-change: opacity do not.
  const containsFixed = (s) => {
    if (s.display === 'contents') return false;
    if (NON_ATOMIC_INLINE.test(s.display)) {
      return s.filter !== 'none' || s.backdropFilter !== 'none' || willNames(s, WILL_FILTER);
    }
    if (s.transform !== 'none' || s.translate !== 'none' || s.rotate !== 'none' || s.scale !== 'none'
      || s.perspective !== 'none' || s.offsetPath !== 'none' || !/^(normal|auto)$/.test(s.offsetPosition)
      || s.filter !== 'none' || s.backdropFilter !== 'none' || s.transformStyle === 'preserve-3d'
      || willNames(s, WILL_TRANSFORM) || willNames(s, WILL_FILTER)) return true;
    if (NO_CONTAINMENT.test(s.display)) return false;
    return /\b(paint|layout|strict|content)\b/.test(s.contain) || willNames(s, WILL_CONTAIN)
      || s.contentVisibility === 'auto';
  };

  /**
   * The boxes whose visible parts a range must lie in to be seen, innermost first: each flat-tree ancestor that clips
   * its content (an overflow other than visible, on the axes it clips), then the viewport. A box is
   * { scroller, area() }, area() the part of it that shows, measured when asked as it is drawn, with the scale (sx, sy)
   * of the box's own pixels to drawn ones. A fixed element is clipped only from the first ancestor that contains it
   * (containsFixed()) up, and an absolutely positioned one from the first that contains it or is positioned.
   */
  function boxesAround(doc, node) {
    const view = doc.defaultView;
    const boxes = [];
    let above = null; // 'fixed' or 'absolute' while the walk is above such an element and has not reached its container
    for (let e = flatParent(node); e?.nodeType === 1 && e !== doc.body && e !== doc.documentElement;
        e = flatParent(e)) {
      const s = view.getComputedStyle(e);
      if (above === 'absolute' ? s.position !== 'static' || containsFixed(s) : above === 'fixed' && containsFixed(s)) {
        above = null;
      }
      const cx = s.overflowX !== 'visible', cy = s.overflowY !== 'visible';
      // A non-atomic inline element has no box to clip with, whatever its overflow says.
      if (!above && (cx || cy) && !NON_ATOMIC_INLINE.test(s.display) && s.display !== 'contents') {
        boxes.push({
          scroller: e,
          area: () => {
            const b = e.getBoundingClientRect();
            // The padding box is what clips. client* are in the box's own pixels, the rect is as drawn: scale them.
            const sx = e.offsetWidth ? b.width / e.offsetWidth : 1, sy = e.offsetHeight ? b.height / e.offsetHeight : 1;
            const top = b.top + e.clientTop * sy, left = b.left + e.clientLeft * sx;
            return {
              top: cy ? top : -Infinity, bottom: cy ? top + e.clientHeight * sy : Infinity,
              left: cx ? left : -Infinity, right: cx ? left + e.clientWidth * sx : Infinity, sx, sy,
            };
          },
        });
      }
      if (s.position === 'fixed' || s.position === 'absolute') above = s.position;
    }
    boxes.push({
      scroller: view,
      area: () => ({ top: 0, left: 0, bottom: view.innerHeight, right: view.innerWidth, sx: 1, sy: 1 }),
    });
    return boxes;
  }

  // Whether the match `r` is outside the part `a` of a box, along each axis. The glyph box of a line can stick out of a
  // tight line box by a pixel or two, so only the middle half of the match's height is judged against an edge.
  const outY = (r, a) => r.top + r.height / 4 < a.top || r.bottom - r.height / 4 > a.bottom;
  const outX = (r, a) => r.left < a.left - 0.5 || r.right > a.right + 0.5;
  const outside = (r, a) => outX(r, a) || outY(r, a);

  // A fixed or sticky element at least this much of the viewport tall is an overlay, a backdrop or a sidebar,
  // not a bar.
  const BAR_MAX = 1 / 3;

  /**
   * A match the boxes say is seen can still sit under a sticky or fixed bar (a header, a cookie banner, a sticky table
   * heading), which counts as not seen. Hit-test the match's middle, in its own tree and then inside each open shadow
   * root the hit lands on: from outside a component the hit test gives only its host, and the bar can be inside it (an
   * app shell's header, a cookie banner in a component). Nothing below a closed host is looked at (spec §4.6): when
   * what is on top is page content placed inside one, the outermost such host stands for it, as the hit test itself
   * gives the host for anything inside a closed root, so a bar placed in a closed component is not cleared. If what is
   * there is neither the match's element, a flat-tree ancestor of it nor a flat-tree descendant of it, take its nearest
   * fixed or sticky flat-tree ancestor below the flat-tree ancestors of the match's element: a bar that holds the match
   * (a cookie banner whose own button covers its text) moves with it, and no scroll clears it. Pass over a sticky
   * element whose top and bottom are both auto: it sticks only sideways (the first column of a table scrolled sideways)
   * and scrolls up and down like any other element. Leave alone a bar at least BAR_MAX of the viewport tall, and one
   * that doesn't overlap the match (a dropdown hanging from a header). Otherwise move the match just far enough to put
   * it a line's height clear of the bar. A sticky bar is cleared by scrolling the match's nearest clipping box above
   * it, which is what it sticks to. A fixed one, or a sticky one with no such box above it, is cleared by the viewport,
   * then the <body> when that scrolls itself (<html> has an overflow other than visible), then the match's boxes from
   * the outside in (a fixed header over a full-height <main> that scrolls), each scrolled by what is left of the
   * distance, until the match has moved all of it. One that moves nothing of the match (a page behind a fixed <main>)
   * is put back.
   */
  function clearBar(doc, range, r, boxes) {
    const view = doc.defaultView, node = range.startContainer, own = elementOf(node);
    if (!own) return;
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    let hit = node.getRootNode().elementFromPoint(x, y);
    for (;;) {
      const host = closedHostOf(hit);
      if (host) { hit = host; break; }
      const inner = hit?.shadowRoot?.elementFromPoint(x, y); // shadowRoot is null for a closed root
      if (!inner || inner === hit) break;
      hit = inner;
    }
    const path = []; // the hit and its flat-tree ancestors
    for (let e = hit; e?.nodeType === 1; e = flatParent(e)) path.push(e);
    if (path.includes(own)) return; // the match's element, or something inside it
    const holders = new Set();
    for (let e = own; e?.nodeType === 1; e = flatParent(e)) holders.add(e);
    for (const e of path) {
      if (holders.has(e)) return;
      const style = view.getComputedStyle(e), position = style.position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      if (position === 'sticky' && style.top === 'auto' && style.bottom === 'auto') continue;
      const bar = e.getBoundingClientRect();
      if (bar.height >= view.innerHeight * BAR_MAX || r.bottom <= bar.top || r.top >= bar.bottom) return;
      let movers = [boxes[boxes.length - 1]];
      const html = view.getComputedStyle(doc.documentElement), body = view.getComputedStyle(doc.body);
      if (html.overflowY !== 'visible' && body.overflowY !== 'visible') {
        movers.push({ scroller: doc.body, area: () => ({ sy: 1 }) }); // a <body> that scrolls itself
      }
      movers.push(...boxes.slice(0, -1).reverse());
      if (position === 'sticky') {
        for (let up = flatParent(e); up?.nodeType === 1; up = flatParent(up)) {
          const found = boxes.find((b) => b.scroller === up);
          if (found) { movers = [found]; break; }
        }
      }
      const topHalf = bar.top + bar.height / 2 < view.innerHeight / 2; // a bar in the top half is cleared downwards
      // How far the match still has to move up the screen (down, when negative).
      let left = topHalf ? r.top - (bar.bottom + r.height) : r.bottom - (bar.top - r.height);
      for (const { scroller, area } of movers) {
        const was = scroller.scrollY ?? scroller.scrollTop, top = range.getBoundingClientRect().top;
        scroller.scrollBy({ top: left / area().sy, behavior: 'instant' });
        const moved = top - range.getBoundingClientRect().top;
        if (!moved) scroller.scrollTo({ top: was, behavior: 'instant' });
        if (Math.abs(left -= moved) < 1) return;
      }
      return;
    }
  }

  /**
   * Scroll a range into view if it can't be seen: outside the viewport, hidden by a box it sits in, or under a sticky
   * or fixed bar. A range that is seen is left alone. Outside the viewport, the page centres it, which moves every
   * scroller above it too, as Chrome's find does. Inside the viewport only the boxes that hide it scroll (an overflow:
   * hidden one as well as an auto one, as Chrome's find scrolls it; an overflow: clip one can't scroll), and each aims
   * at the part of itself that the viewport shows, so the page stays where it is. Every scroll is instant, whatever the
   * page's scroll-behavior says, as desktop Chrome's find scrolls: each step measures where the one before left the
   * match, and a smooth scroll would not have moved it yet.
   */
  function reveal(doc, range) {
    try {
      const boxes = boxesAround(doc, range.startContainer);
      const viewport = boxes[boxes.length - 1];
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) return; // unrenderable: nothing to scroll to
      if (boxes.every((box) => !outside(r, box.area()))) {
        clearBar(doc, range, r, boxes);
        return;
      }
      if (outside(r, viewport.area())) {
        const target = elementOf(range.startContainer);
        if (!target) return;
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      }
      // Then, innermost box first, put the match mid-box on each axis a box still hides it on. That is all that moves
      // when the viewport shows the match, and it finishes the job for a parent taller than its box, which
      // scrollIntoView centres, not the match. A box reaching past the viewport is aimed at in the part the viewport
      // shows, when it shows any: the middle of the whole box could be off screen, and the page would have to follow.
      for (const box of boxes) {
        const m = range.getBoundingClientRect(), whole = box.area(), shown = viewport.area();
        const a = { ...whole, top: Math.max(whole.top, shown.top), bottom: Math.min(whole.bottom, shown.bottom),
          left: Math.max(whole.left, shown.left), right: Math.min(whole.right, shown.right) };
        if (a.top >= a.bottom || a.left >= a.right) Object.assign(a, whole);
        const dx = outX(m, a) ? ((m.left + m.right) / 2 - (a.left + a.right) / 2) / a.sx : 0;
        const dy = outY(m, a) ? (m.top - (a.top + a.bottom) / 2) / a.sy : 0;
        if (dx || dy) box.scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      }
    } catch {
      // detached or unrenderable range: nothing to scroll to
    }
  }

  // What the engine watches after a search (spec §3.2).
  const WATCH = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] };

  function createEngine(doc, { timeBudgetMs = TIME_BUDGET_MS, now = () => performance.now(), onChange = null } = {}) {
    let matches = []; // one array of Ranges per match (a sequence has several)
    let starts = []; // each match's first hit, for finding the kept match again
    let lastForm = null; // the popup form behind the last search, returned on the next open
    let lastCurrent = -1;
    // Reports the first change after each search, once; the next search watches again.
    let watching = false;
    let reported = false;
    const observer = new MutationObserver(() => {
      if (reported) return;
      reported = true;
      onChange?.();
    });

    function watch(roots) {
      observer.disconnect();
      observer.observe(doc, WATCH);
      for (const root of roots) observer.observe(root, WATCH);
      watching = true;
      reported = false;
    }

    function unwatch() {
      observer.disconnect();
      watching = false;
    }

    /**
     * Paint the first `limit` matches; `current` (local index or -1) gets the current-match colour and is
     * scrolled into view unless `scroll` is false (live refreshes never scroll).
     */
    function show(current, limit, scroll = true) {
      lastCurrent = current;
      const n = Math.max(0, Math.min(limit, matches.length));
      const all = new Highlight();
      for (let i = 0; i < n; i++) for (const r of matches[i]) all.add(r);
      if (all.size) CSS.highlights.set(MATCH, all); else CSS.highlights.delete(MATCH);
      if (current >= 0 && current < n) {
        const cur = new Highlight(...matches[current]);
        cur.priority = 1;
        CSS.highlights.set(CURRENT, cur);
        if (scroll) reveal(doc, matches[current][0]);
      } else {
        CSS.highlights.delete(CURRENT);
      }
    }

    /** Remove all highlights; `forget` also drops the remembered search (the Clear button). */
    function clear(forget) {
      unwatch();
      CSS.highlights.delete(MATCH);
      CSS.highlights.delete(CURRENT);
      matches = [];
      starts = [];
      if (forget) { lastForm = null; lastCurrent = -1; }
    }

    const remembered = () => (lastForm ? { form: lastForm, current: lastCurrent } : null);

    /**
     * Search the page. `keep` is the local index of the current match before a live refresh (or -1): the
     * result's `keepAt` is the index of the first new match at or after it, or -1 when its text is gone.
     */
    function search(query, form, keep = -1) {
      if (form) lastForm = form;
      lastCurrent = -1;
      const anchor = keep >= 0 ? matches[keep]?.[0] : null; // a live Range: the DOM has kept it up to date
      let deadline = now() + timeBudgetMs;
      const clock = { timedOut: false, expired() { return now() > deadline && (this.timedOut = true); } };
      const { blocks, roots, where } = buildModel(doc, clock);
      watch(roots);
      // If collecting text used up the budget, still match what was collected (a short grace period).
      if (clock.timedOut) deadline = now() + MATCH_GRACE_MS;
      const result = { count: 0, capped: false, timedOut: false, termCounts: [], anyCount: 0, longest: 0, keepAt: -1 };
      const compile = (source) => new RegExp(source, query.flags);
      let groups;
      if (query.kind === 'flat') {
        groups = hitsOf(compile(query.source), blocks, clock, CAP + 1).map((h) => [h]);
      } else {
        const per = query.terms.map((t) => hitsOf(compile(t.source), blocks, clock, CAP + 1));
        result.termCounts = per.map((h) => Math.min(h.length, CAP));
        groups = query.ordered ? sequences(per, CAP + 1) : per.flat().map((h) => [h]);
        if (query.any) {
          const anyHits = hitsOf(compile(query.any.source), blocks, clock, CAP + 1);
          result.anyCount = Math.min(anyHits.length, CAP);
          groups = groups.concat(anyHits.map((h) => [h]));
        }
        groups.sort((x, y) => x[0].g - y[0].g);
      }
      result.capped = groups.length > CAP;
      groups = groups.slice(0, CAP);
      matches = [];
      starts = [];
      for (const group of groups) {
        const ranges = [];
        for (const h of group) {
          const block = blocks[h.b];
          if (!block.pieces.length) continue;
          ranges.push(...rangesFor(doc, block, h.a, h.z));
          result.longest = Math.max(result.longest, h.z - h.a);
        }
        if (ranges.length) { matches.push(ranges); starts.push(group[0]); }
      }
      result.count = matches.length;
      result.timedOut = clock.timedOut;
      const at = anchor && where.get(anchor.startContainer);
      if (at) result.keepAt = firstAtOrAfter(starts, at.block * POS + at.start + anchor.startOffset);
      return result;
    }

    return {
      search,
      show,
      clear,
      remembered,
      createEngine, // exposed so tests can build an engine with a fake clock
      get _lastMatches() { return matches.map((m) => m.map((r) => r.toString())); },
      get _watching() { return watching; },
    };
  }

  let notify = null; // tells the popup that ran the last search that the page changed
  const engine = createEngine(document, { onChange: () => notify?.() });
  globalThis.__textFindPlus = true;
  globalThis.__textFindPlusEngine = engine;

  // Port layer: one long-lived connection per frame from the popup (spec §7.2). When the popup
  // closes for any reason, Chrome disconnects the port: every highlight is removed and the page is no longer watched.
  if (globalThis.chrome?.runtime?.onConnect) {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAME) return;
      const changed = () => {
        try {
          port.postMessage({ type: 'changed' });
        } catch {
          // the popup closed; its disconnect stops the watching
        }
      };
      port.onMessage.addListener((msg) => {
        if (msg.type === 'search') {
          notify = changed;
          try {
            port.postMessage({ type: 'result', seq: msg.seq, ...engine.search(msg.query, msg.form, msg.keep ?? -1) });
          } catch (e) {
            port.postMessage({ type: 'error', seq: msg.seq, message: String(e?.message || e) });
          }
        } else if (msg.type === 'show') {
          engine.show(msg.current, msg.limit, msg.reveal !== false);
        } else if (msg.type === 'clear') {
          engine.clear(true);
        }
      });
      port.onDisconnect.addListener(() => {
        if (notify === changed) notify = null;
        engine.clear(false);
      });
      const memo = engine.remembered();
      if (window === window.top && memo) port.postMessage({ type: 'hello', form: memo.form, current: memo.current });
    });
  }
})();
