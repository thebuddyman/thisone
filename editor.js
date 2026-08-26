/**
 * Visual Tailwind editor — client half.
 *
 * Hover to highlight, click to select, nudge utility classes for instant
 * preview, Save to POST the resulting class string back to the server, which
 * writes it into index.html on disk.
 *
 * Highlighting is done with inline outline styles only, never with classes,
 * so the element's class string stays exactly what the user chose.
 */
(function () {
  'use strict';

  /**
   * Backend configuration, injected by whichever server serves this file.
   *
   * HTML mode (the standalone POC): identity is a positional data-eid and the
   * write endpoint is same-origin. JSX mode (Next): identity is a source
   * location stamped by a bundler loader, the endpoint is the editor server on
   * its own port, and text editing is off — JsxText is whitespace-significant
   * and sits next to {expressions}, so rewriting it safely is not a v1 job.
   */
  var CFG = window.__TW_EDITOR__ || {};
  var ID_ATTR = CFG.idAttr || 'data-eid';
  var ENDPOINT = CFG.endpoint || '/edit';
  var TEXT_ENABLED = CFG.text !== false;
  // Tailwind v4 generates no CSS for a class that appears in no source file, so
  // the preview stylesheet is scoped to this attribute and applied only to
  // elements the editor has actually touched.
  var PREVIEW_ATTR = CFG.previewAttr || null;
  // Does the page rebuild itself from the file after a write? The Next backend
  // says yes; the HTML one has no such loop and needs the DOM updated by hand.
  var HMR = CFG.hmr === true;
  // { order, ramps, projectCount } — the server's stock ramps merged with the
  // tokens actually defined on the live page. Built lazily on first selection,
  // because stylesheets may still be loading at script time.
  var COLORS = null;
  // prefix → { tokenName: renderedValue } for classes the page can already
  // render, so preview rules are emitted only where they are actually missing.
  var renderable = { bg: {}, text: {} };

  var HOVER_OUTLINE = '1px dashed rgba(217, 121, 89, .75)';
  var SELECT_OUTLINE = '2px solid #d97959';
  // Amber marks an element changed but not yet written, so unsaved work stays
  // visible after you move on to another element.
  var DIRTY_OUTLINE = '2px dashed rgba(217, 121, 89, .95)';
  // A pending removal is not a pending edit: it reads red, not amber, and the
  // element is ghosted rather than hidden so it stays clickable and undoable.
  var REMOVE_OUTLINE = '2px dashed rgba(220, 40, 40, .9)';

  /**
   * Each control owns a "family" of classes. Before adding a value we strip
   * every existing class in the same family, so p-4 replaces p-8 instead of
   * fighting it in the cascade.
   *
   * The two text-* families are deliberately separate: font size and text
   * colour share a prefix but must not evict each other.
   */
  var FAMILY = {
    fontSize: /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/,
    // Arbitrary sizes are the real vocabulary here: uiux_experiment uses the
    // named scale twice and text-[13px] and friends 497 times. Both forms are
    // one family — writing either must clear the other.
    fontSizeArb: /^text-\[[\d.]+(?:px|rem|em)\]$/,
    // Arbitrary radii are not a fringe idiom: 66 against 171 named tokens in
    // uiux_experiment, and 180 against 90 in gw-web, where they are the
    // majority. Same two-idiom shape as font size, same rule — writing either
    // form clears the other.
    // Exact words only: text- is shared with sizes and colours, and text-left
    // is neither. start/end are stripped though never offered — the export has
    // icons for three alignments, not five.
    textAlign: /^text-(?:left|center|right|justify|start|end)$/,
    radiusArb: /^rounded-\[[^\]]+\]$/,
    // The per-corner utilities. Never touched, only noticed: rounded-l-[2px]
    // still wins on the left after rounded-lg is written, and the row says so
    // rather than pretending the element has one radius.
    radiusSide: /^rounded-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee)(?:-|$)/,
  };

  // Shared spacing scale for every padding/margin field.
  // The rungs the dropdown offers. Wider than the six it used to hold, and it
  // carries the half steps deliberately: py-2.5 and friends are 97 of the 802
  // spacing classes in uiux_experiment. Anything off this ladder is still
  // typeable — it just becomes an arbitrary value and says so.
  var SPACING = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 16, 20, 24];

  // An axis field is really the two edges beneath it: a py-* lookup cannot see
  // pt-*/pb-*, and a py-* write has to clear them or they outrank it.
  var PAIR = { x: ['l', 'r'], y: ['t', 'b'] };

  /** Which CSS properties one spacing class actually sets. */
  var SPACING_PROPS = {
    p: { '': ['padding'], x: ['padding-left', 'padding-right'], y: ['padding-top', 'padding-bottom'],
      t: ['padding-top'], r: ['padding-right'], b: ['padding-bottom'], l: ['padding-left'] },
    m: { '': ['margin'], x: ['margin-left', 'margin-right'], y: ['margin-top', 'margin-bottom'],
      t: ['margin-top'], r: ['margin-right'], b: ['margin-bottom'], l: ['margin-left'] },
    gap: { '': ['gap'], '-x': ['column-gap'], '-y': ['row-gap'] },
  };

  var GAP_ONE = [{ side: '', name: 'gap', icon: 'gapAll' }];
  var GAP_AXES = [
    { side: '-x', name: 'column gap', icon: 'gapX' },
    { side: '-y', name: 'row gap', icon: 'gapY' },
  ];

  /**
   * Padding is always on show; margin and gap appear only when the element
   * actually uses them, which keeps the panel close to Figma's padding+gap
   * model without making 348 real margin utilities uneditable. Anything hidden
   * is one click away from the "add" row underneath.
   */
  var BOXES = [
    { key: 'padding', label: 'Padding', prefix: 'p', always: true },
    { key: 'margin', label: 'Margin', prefix: 'm' },
    { key: 'gap', label: 'Gap', prefix: 'gap', collapsed: GAP_ONE, expanded: GAP_AXES,
      applies: supportsGap },
  ];

  // Figma's model: two axis inputs by default (px-*/py-*), swapped for the four
  // edges (pt/pr/pb/pl) behind a toggle. Every `side` here is the exact token
  // the Tailwind class uses.
  // Vertical first: it is the one people set, and it reads top-then-sides the
  // way the shorthand does.
  var AXES = [
    { side: 'y', name: 'vertical', key: 'Vt' },
    { side: 'x', name: 'horizontal', key: 'Hz' },
  ];

  var SIDES = [
    { side: 't', name: 'top', key: 'Top' },
    { side: 'r', name: 'right', key: 'Right' },
    { side: 'b', name: 'bottom', key: 'Bottom' },
    { side: 'l', name: 'left', key: 'Left' },
  ];

  /**
   * Padding and margin ship parallel icon sets — a margin's marks sit outside
   * its box where a padding's sit inside — so the shape is the shared part and
   * the set is the box's. gap has neither and keeps its own three.
   */
  var ICON_SET = { p: 'pad', m: 'mar' };
  function boxIcon(prefix, key, fallback) {
    var name = (ICON_SET[prefix] || '') + key;
    return ICONS[name] ? name : fallback;
  }

  // Per-box: is the four-edge view showing? Padding and margin toggle apart.
  var expanded = { p: false, m: false, gap: false };
  // Which element that choice was made for. Without this the rule below ran on
  // every refresh and overrode the toggle: collapsing an element that owns
  // per-side classes lasted until the next keystroke, and typing into the axis
  // field snapped the view back to the four edges mid-edit.
  var expandedFor = { p: null, m: null, gap: null };
  // Rows the user asked to see on this selection though nothing is set yet.
  var revealed = {};

  // Which axis utility covers an edge, for reading values inherited from px-*/py-*.
  // The axes themselves have no intermediate step — they fall straight to p-*.
  var AXIS = { t: 'y', b: 'y', l: 'x', r: 'x' };

  // The scale comes from the project's own theme, shipped by whichever server
  // served this file. It cannot be read from the page: Tailwind v4 emits both
  // utilities and theme variables on demand, so a route using two sizes exposes
  // exactly two.
  var SIZE_ORDER = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'];
  var TEXT_SIZES = CFG.textSizes || {};
  var FONT_TOKENS = Object.keys(TEXT_SIZES).sort(function (a, b) {
    var ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  var FONT_SIZES = FONT_TOKENS.map(function (t) { return 'text-' + t; });

  // font- is shared between weight and family utilities: font-medium is a
  // weight, font-sans is a family (150 and 438 uses across these projects).
  // Membership in the ladder is the only safe test — never /^font-/.
  var WEIGHT_ORDER = ['thin', 'extralight', 'light', 'normal', 'medium',
    'semibold', 'bold', 'extrabold', 'black'];
  var FONT_WEIGHTS = CFG.fontWeights || {};
  var WEIGHT_TOKENS = Object.keys(FONT_WEIGHTS).sort(function (a, b) {
    return Number(FONT_WEIGHTS[a]) - Number(FONT_WEIGHTS[b]);
  });

  // rounded- is shared between the all-corner utilities and the per-corner
  // ones: rounded-sm is a rung on the ladder, rounded-s is the two start
  // corners. Membership decides, never /^rounded-/ — that would swallow
  // rounded-t-lg and leave the element wearing two competing radii.
  var RADIUS_ORDER = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'];
  // none (0) and full (calc(infinity * 1px)) are baked into the utility, not
  // into the theme: they have no --radius-* variable anywhere, so the two ends
  // of the ladder are completed here rather than shipped by the server.
  var RADII = Object.assign({ none: '0px', full: 'calc(infinity * 1px)' }, CFG.radii || {});

  // Families are read off the page, never off a config or a webfont service:
  // the only families offered are the ones this route already generated a
  // utility rule for, which is the same question colours answer — what can
  // this page actually render. Filled by buildColorModel.
  var FAMILIES = {};
  var RADIUS_TOKENS = Object.keys(RADII).sort(function (a, b) {
    var ia = RADIUS_ORDER.indexOf(a), ib = RADIUS_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  var selected = null;
  var hovered = null;
  var panel = null;
  var ui = {};
  var readouts = []; // refresh() calls each of these to repaint a field
  var textEditable = false; // is the current selection accepting typed text?

  // Elements changed but not yet written. Previously an edit that was never
  // saved stayed on screen with nothing marking it, and one refresh lost it.
  var dirty = new Map(); // element -> { text: boolean, classes: boolean }
  // Classes as first seen this session, per element. A composed className —
  // cn("p-4", cond && "bg-blue-500") — cannot be rewritten from the rendered
  // string, because that string also contains whatever the other arguments
  // contributed. Sending the delta lets the writer edit only its own literal.
  var baseline = new Map();
  // Fingerprint of the bytes our eids were derived from; quoted back on write.
  var fileHash = null;

  // ---------------------------------------------------------------- outlines

  function setOutline(el, value) {
    if (!el) return;
    if (!('twPrevOutline' in el.dataset)) {
      el.dataset.twPrevOutline = el.style.outline || '';
      el.dataset.twPrevOffset = el.style.outlineOffset || '';
    }
    el.style.outline = value;
    el.style.outlineOffset = '2px';
  }

  /** Stop highlighting an element — but keep the marker if it is unsaved. */
  function releaseOutline(el) {
    if (!el) return;
    // Red outranks amber: a pending removal is not a pending edit, and every
    // instance of a shared location wears it, not only the dirty one.
    if (isRemoved(el)) setOutline(el, REMOVE_OUTLINE);
    else if (dirty.has(el)) setOutline(el, DIRTY_OUTLINE);
    else clearOutline(el);
  }

  function clearOutline(el) {
    if (!el || !('twPrevOutline' in el.dataset)) return;
    el.style.outline = el.dataset.twPrevOutline;
    el.style.outlineOffset = el.dataset.twPrevOffset;
    delete el.dataset.twPrevOutline;
    delete el.dataset.twPrevOffset;
    if (!el.getAttribute('style')) el.removeAttribute('style');
  }

  // ------------------------------------------------------------- text edits

  /**
   * Only leaf elements may be typed into. Turning a container contenteditable
   * would let a stray keystroke delete its child markup, and the server
   * refuses those writes anyway.
   */
  function canEditText(el) {
    return el.children.length === 0;
  }

  function onTextInput() {
    markDirty(selected, 'text');
    refresh();
  }

  function onTextKeydown(e) {
    // One text node in, one text node out — no <br>/<div> line breaks.
    if (e.key === 'Enter') e.preventDefault();
  }

  function onTextPaste(e) {
    e.preventDefault();
    var plain = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, plain.replace(/\s*\n\s*/g, ' '));
  }

  function enableTextEditing(el) {
    if (!canEditText(el)) return false;
    // plaintext-only keeps pasted markup out; fall back where unsupported.
    el.setAttribute('contenteditable', 'plaintext-only');
    if (!el.isContentEditable) el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.addEventListener('input', onTextInput);
    el.addEventListener('keydown', onTextKeydown);
    el.addEventListener('paste', onTextPaste);
    return true;
  }

  /**
   * contenteditable is switched on during the click that selects the element,
   * which is after the browser has already decided where focus goes — so
   * without this the first click would never land a caret and you would have
   * to click a second time before you could type.
   */
  function focusText(el, point) {
    el.focus({ preventScroll: true });
    if (!point) return;

    var range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(point.x, point.y);
    } else if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(point.x, point.y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range || !el.contains(range.startContainer)) return;

    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function disableTextEditing(el) {
    if (!el) return;
    el.removeEventListener('input', onTextInput);
    el.removeEventListener('keydown', onTextKeydown);
    el.removeEventListener('paste', onTextPaste);
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    el.blur();
  }

  // ------------------------------------------------------------ class edits

  function classesOf(el) {
    return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }

  function stripFamily(el, pattern) {
    classesOf(el).forEach(function (cls) {
      if (pattern.test(cls)) el.classList.remove(cls);
    });
  }

  function applyClass(el, value, pattern) {
    stripFamily(el, pattern);
    if (value) el.classList.add(value);
    markDirty(el, 'classes');
    refresh();
  }

  function markDirty(el, kind) {
    if (!el) return;
    var entry = dirty.get(el) || { text: false, classes: false, remove: false };
    if (kind === 'text') entry.text = true;
    if (kind === 'classes') entry.classes = true;
    if (kind === 'remove') entry.remove = true;
    dirty.set(el, entry);
    if (PREVIEW_ATTR) el.setAttribute(PREVIEW_ATTR, '');
    pushHistory(kind);
    updateFooter();
  }

  // ----------------------------------------------------------------- history

  /**
   * Undo/redo by snapshot, not by command.
   *
   * Every control in the panel already writes straight to the DOM and to
   * `dirty`; recording the state after each one is both cheaper and far harder
   * to get wrong than teaching a dozen call sites to describe and invert
   * themselves. The states are small — one entry per element the session has
   * touched, and these sessions touch a handful.
   */
  var history = [[]];      // history[0] is the session's starting point
  var historyAt = 0;       // the state currently on screen
  var touched = [];        // every element seen, in the order it was selected
  var pristine = new Map();// each one as it was before anything was done to it
  var restoring = false;   // guards pushHistory while a state is being applied
  var lastPush = null;     // for coalescing a run of keystrokes into one step
  var HISTORY_CAP = 100;

  /** One element's complete editable state. */
  function stateOf(el) {
    var entry = dirty.get(el);
    return {
      el: el,
      cls: el.getAttribute('class'),
      // Only a leaf's text round-trips. textContent on a container would
      // flatten its markup — the very thing the writer refuses to do.
      text: el.children.length === 0 ? el.textContent : null,
      removed: isRemoved(el),
      dirty: entry ? { text: entry.text, classes: entry.classes, remove: entry.remove } : null,
    };
  }

  /**
   * Remember an element and how it looked before the session got to it.
   *
   * Called from select(), never from markDirty: every mutation acts on the
   * current selection, so selection is the moment the element is still
   * pristine. Capturing it after a mutation would record the mutation as the
   * thing to go back to.
   */
  function noteTouched(el) {
    if (!el || pristine.has(el)) return;
    pristine.set(el, stateOf(el));
    touched.push(el);
  }

  function pushHistory(kind) {
    if (restoring) return;
    var now = Date.now();
    // A run of keystrokes is one step, not one per character.
    var coalesce = kind === 'text' && lastPush && lastPush.kind === 'text' &&
      lastPush.el === selected && now - lastPush.at < 700 &&
      historyAt === history.length - 1 && historyAt > 0;

    history = history.slice(0, historyAt + 1);
    if (coalesce) {
      history[historyAt] = touched.map(stateOf);
    } else {
      history.push(touched.map(stateOf));
      if (history.length > HISTORY_CAP) history.shift();
      historyAt = history.length - 1;
    }
    lastPush = { el: selected, kind: kind, at: now };
    updateHistoryButtons();
  }

  /** Everything goes back to how the session's starting point had it. */
  function forgetHistory() {
    history = [[]];
    historyAt = 0;
    touched = [];
    pristine = new Map();
    lastPush = null;
    updateHistoryButtons();
  }

  function applyState(state) {
    restoring = true;
    var byEl = new Map();
    state.forEach(function (s) { byEl.set(s.el, s); });

    touched.forEach(function (el) {
      var s = byEl.get(el) || pristine.get(el);
      if (!s) return;

      if (s.cls === null) el.removeAttribute('class');
      else if (el.getAttribute('class') !== s.cls) el.setAttribute('class', s.cls);

      if (s.text !== null && el.children.length === 0 && el.textContent !== s.text) {
        el.textContent = s.text;
      }

      // Removal is recorded on the element that holds the edit, and applied to
      // every instance its source location renders.
      sameSource(el).forEach(function (node) {
        if (s.removed) node.setAttribute('data-tw-removed', '');
        else node.removeAttribute('data-tw-removed');
      });

      if (s.dirty) dirty.set(el, { text: s.dirty.text, classes: s.dirty.classes, remove: s.dirty.remove });
      else dirty.delete(el);

      if (PREVIEW_ATTR) {
        if (dirty.has(el)) el.setAttribute(PREVIEW_ATTR, '');
        else el.removeAttribute(PREVIEW_ATTR);
      }
    });

    // Outlines last: releaseOutline reads both the dirty entry and the ghost
    // attribute, and both had to settle first.
    touched.forEach(function (el) {
      sameSource(el).forEach(function (node) {
        if (node === selected) setOutline(node, isRemoved(node) ? REMOVE_OUTLINE : SELECT_OUTLINE);
        else releaseOutline(node);
      });
    });

    restoring = false;
    lastPush = null;
    refresh();
    updateDeleteHandle();
    updateFooter();
  }

  function canUndo() { return historyAt > 0; }
  function canRedo() { return historyAt < history.length - 1; }

  function undo() {
    if (!canUndo()) return;
    historyAt--;
    applyState(history[historyAt]);
  }

  function redo() {
    if (!canRedo()) return;
    historyAt++;
    applyState(history[historyAt]);
  }

  function updateHistoryButtons() {
    if (!ui.undo) return;
    ui.undo.disabled = !canUndo();
    ui.redo.disabled = !canRedo();
    ui.undo.title = canUndo() ? 'Undo (' + MOD + 'Z)' : 'Nothing to undo';
    ui.redo.title = canRedo() ? 'Redo (' + MOD + '\u21e7Z)' : 'Nothing to redo';
  }

  // -------------------------------------------------------------- edit mode

  /**
   * The editor is off until it is asked for.
   *
   * While it is on, every click on the page is swallowed in the capture phase
   * so the app's own links and buttons cannot fire — which is what makes the
   * page selectable, and also what makes it unusable as an app. Leaving that
   * on by default meant the target site could not be navigated, scrolled
   * through a form, or clicked at all without editing something.
   *
   * The choice is remembered for the tab, not the browser: a reload or a route
   * change mid-session keeps you editing, and a fresh tab always starts on the
   * page as its own users see it.
   */
  var MODE_KEY = 'bw-editor-mode';
  var editing = false;
  var modeToggle = null;
  var modeRing = null;

  function rememberMode(on) {
    try {
      window.sessionStorage.setItem(MODE_KEY, on ? '1' : '0');
    } catch (e) {
      /* private mode, blocked storage — the session just does not persist */
    }
  }

  function recallMode() {
    try {
      return window.sessionStorage.getItem(MODE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setEditing(on) {
    if (editing === on) return;
    editing = on;
    if (!on) {
      // Pending edits are NOT dropped — their markers stay on the page and the
      // count stays on the toggle, so unsaved work survives leaving the mode.
      closePopover();
      deselect();
      if (hovered) { releaseOutline(hovered); hovered = null; }
    }
    rememberMode(on);
    updatePanelChrome();
    updateModeToggle();
  }

  function updateModeToggle() {
    if (!modeToggle) return;
    modeToggle.setAttribute('aria-pressed', editing ? 'true' : 'false');
    modeToggle.querySelector('.bw-label').textContent = editing ? 'Editing' : 'Edit';

    var count = modeToggle.querySelector('.bw-count');
    count.textContent = dirty.size ? String(dirty.size) : '';
    count.style.display = dirty.size ? '' : 'none';

    modeToggle.title = dirty.size
      ? dirty.size + ' unsaved change' + (dirty.size === 1 ? '' : 's') +
        (editing ? '' : ' \u2014 click to pick up where you left off')
      : editing
        ? 'Editing \u2014 the page\'s own clicks are being held (Esc to stop)'
        : 'Turn on edit mode';

    if (modeRing) modeRing.style.display = editing ? 'block' : 'none';
  }

  function buildModeToggle() {
    modeRing = document.createElement('div');
    modeRing.setAttribute('data-tw-editor', 'ring');
    document.body.appendChild(modeRing);

    modeToggle = document.createElement('button');
    modeToggle.type = 'button';
    modeToggle.setAttribute('data-tw-editor', 'toggle');
    modeToggle.setAttribute('data-tw-mode', '');
    modeToggle.setAttribute('aria-pressed', 'false');
    modeToggle.appendChild(el('span', 'bw-dot'));
    modeToggle.appendChild(el('span', 'bw-label', 'Edit'));
    modeToggle.appendChild(el('span', 'bw-count', ''));
    bindTheme(modeToggle);
    modeToggle.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setEditing(!editing);
    });
    document.body.appendChild(modeToggle);
    updateModeToggle();
  }

  // ---------------------------------------------------------------- removal

  /**
   * Every element on the page that this one's source location renders.
   *
   * One line inside a shared component renders many: measured on these routes,
   * 42% of Cora's elements, 72% of Polaris', 78% of Volt's, worst case 19
   * elements from a single location. For a class change that is a surprise.
   * For a removal it is the difference between deleting one card and deleting
   * the list — so the count is said out loud before the save, and every
   * instance is ghosted, not just the one that was clicked.
   */
  function sameSource(el) {
    if (!el) return [];
    var id = el.getAttribute(ID_ATTR);
    // HTML mode stamps a positional index, unique by construction.
    if (!id || id.indexOf(':') === -1) return [el];
    var bits = id.split(':');
    if (bits.length < 3) return [el];
    var prefix = bits.slice(0, 3).join(':') + ':';
    var out = [];
    var all = document.querySelectorAll('[' + ID_ATTR + ']');
    for (var i = 0; i < all.length; i++) {
      if ((all[i].getAttribute(ID_ATTR) || '').indexOf(prefix) === 0) out.push(all[i]);
    }
    return out.length ? out : [el];
  }

  /**
   * The ghost attribute is the fast answer, because refresh() asks on every
   * interaction and walking every stamped element on the page to answer it
   * would not be free. It is set and cleared in lockstep with the dirty entry.
   */
  function isRemoved(el) {
    return !!(el && el.nodeType === 1 && el.hasAttribute('data-tw-removed'));
  }

  /** Which element of the group actually holds the pending edit. */
  function removalKey(el) {
    var group = sameSource(el);
    for (var i = 0; i < group.length; i++) {
      var entry = dirty.get(group[i]);
      if (entry && entry.remove) return group[i];
    }
    return null;
  }

  /**
   * Mark for removal. Nothing is written here — the element is ghosted rather
   * than hidden, so it stays on the page, stays clickable, and stays undoable
   * right up until Save, which is the step that actually cuts the source.
   */
  function markRemoved(el) {
    if (!el || isRemoved(el)) return;
    sameSource(el).forEach(function (node) {
      node.setAttribute('data-tw-removed', '');
      setOutline(node, REMOVE_OUTLINE);
    });
    markDirty(el, 'remove');
    refresh();
  }

  function unmarkRemoved(el) {
    var key = removalKey(el);
    if (!key) return;
    var entry = dirty.get(key);
    if (entry) {
      entry.remove = false;
      if (!entry.classes && !entry.text) dirty.delete(key);
    }
    sameSource(key).forEach(function (node) {
      node.removeAttribute('data-tw-removed');
      if (node === selected) setOutline(node, SELECT_OUTLINE);
      else releaseOutline(node);
    });
    // This clears the dirty entry by hand rather than through markDirty, so
    // the step has to be recorded by hand too — otherwise the top of the
    // history would describe a page that no longer exists.
    pushHistory('remove');
    updateFooter();
    refresh();
  }

  // The handle floats on <body> rather than inside the element: parenting it to
  // the page would put an editor node into the very tree being edited.
  var deleteHandle = null;

  function buildDeleteHandle() {
    deleteHandle = document.createElement('button');
    deleteHandle.type = 'button';
    deleteHandle.setAttribute('data-tw-editor', 'delete');
    deleteHandle.setAttribute('data-tw-delete', '');
    deleteHandle.innerHTML = ICONS.cross;
    deleteHandle.title = 'Remove this element \u2014 undoable until you save';
    deleteHandle.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (selected) markRemoved(selected);
    });
    document.body.appendChild(deleteHandle);
  }

  /**
   * Pinned half over the element's top-right corner — but only if that corner
   * is reachable.
   *
   * The panel is fixed to the top right at the maximum z-index, so for
   * anything in that band the preferred corner sits underneath it and the
   * handle cannot be clicked at all. Raising the handle above the panel is not
   * an option (nothing outranks 2147483647, and a delete button floating over
   * the controls would be worse), so it walks the other three corners instead
   * and only falls back to the first when every one of them is covered.
   */
  function updateDeleteHandle() {
    if (!deleteHandle) return;
    if (!selected || isRemoved(selected)) {
      deleteHandle.style.display = 'none';
      return;
    }
    var r = selected.getBoundingClientRect();
    if (!r.width && !r.height) {
      deleteHandle.style.display = 'none';
      return;
    }

    var size = 20, gap = 4;
    // The handle belongs to the element's TOP edge and to nothing else.
    // Clamped into the viewport unconditionally, it used to stick to the top of
    // the screen long after the element had scrolled away above it, pointing at
    // nothing. It may still be nudged into view by up to its own size — that is
    // what an element sitting flush against an edge needs — but once its line
    // has left the viewport altogether it is simply not there.
    var line = r.top - size / 2;
    var offscreen = line + size <= 0 || line >= window.innerHeight ||
      r.right + size / 2 <= 0 || r.left - size / 2 >= window.innerWidth;
    if (offscreen) {
      deleteHandle.style.display = 'none';
      return;
    }

    var clampX = function (x) { return Math.max(gap, Math.min(window.innerWidth - size - gap, x)); };
    var clampY = function (y) { return Math.max(gap, Math.min(window.innerHeight - size - gap, y)); };
    // Two candidates, not four: the other side of the element is the panel
    // dodge, the bottom of it is a different element's business.
    var corners = [
      [r.right - size / 2, line],
      [r.left - size / 2, line],
    ].map(function (c) { return [clampX(c[0]), clampY(c[1])]; });

    var blockers = [panel, popover].filter(function (node) {
      return node && node.style.display !== 'none' && node.offsetWidth;
    }).map(function (node) { return node.getBoundingClientRect(); });

    var hits = function (c) {
      return blockers.some(function (b) {
        return c[0] + size > b.left && c[0] < b.right && c[1] + size > b.top && c[1] < b.bottom;
      });
    };
    var clear = corners.find(function (c) { return !hits(c); });

    // A short element in the top-right band has both of its top corners under
    // the panel. Rather than hand back one that cannot be clicked, slide out
    // past the blocker's edge and keep the element's own top line.
    if (!clear) {
      var edge = Math.min.apply(null, blockers.map(function (b) { return b.left; }));
      clear = [clampX(edge - size - gap), corners[0][1]];
      if (hits(clear)) {
        var far = Math.max.apply(null, blockers.map(function (b) { return b.right; }));
        clear = [clampX(far + gap), corners[0][1]];
      }
    }

    deleteHandle.style.left = Math.round(clear[0]) + 'px';
    deleteHandle.style.top = Math.round(clear[1]) + 'px';
    deleteHandle.style.display = 'flex';
  }

  /** The panel has nothing to offer an element on its way out — just the undo. */
  function removeRow() {
    var row = el('div', 'bw-rm');
    row.setAttribute('data-tw-field', 'removed');
    var txt = el('div', 'bw-rm-txt');
    txt.appendChild(el('strong', null, 'Marked for removal'));
    var detail = el('span', null, '');
    txt.appendChild(detail);
    row.appendChild(txt);

    var undo = el('button', 'bw-rm-undo', 'Undo');
    undo.setAttribute('data-tw-undo-remove', '');
    undo.addEventListener('click', function () { unmarkRemoved(selected); });
    row.appendChild(undo);

    readouts.push(function () {
      var on = isRemoved(selected);
      row.style.display = on ? 'flex' : 'none';
      if (ui.body) ui.body.classList.toggle('is-cutting', on);
      if (!on) return;
      var n = sameSource(selected).length;
      detail.textContent = n > 1
        ? 'This one line renders ' + n + ' elements on this page. Saving removes all ' + n + '.'
        : 'It is cut from the source file when you save.';
    });

    return row;
  }

  // --------------------------------------------------------- spacing fields

  /**
   * Matches exactly one spacing family: ('p','') → p-*, ('p','t') → pt-*.
   *
   * The all-sides field also owns the axis utilities px- and py-. They have no
   * field of their own in the panel, and Tailwind emits them after p-*, so
   * leaving one in place would silently defeat the value the user just set —
   * bumping All on an element with px-6 would appear to do nothing horizontally.
   * Per-side pt/pr/pb/pl DO have fields, so they survive and read as explicit.
   */
  function familyRe(prefix, side) {
    if (!side) return new RegExp('^-?' + prefix + '(?:[xy])?-');
    return new RegExp('^-?' + prefix + side + '-');
  }

  function scaleValue(classes, token) {
    // Half steps count: py-2.5, mt-0.5 and friends are 97 of the 802 spacing
    // classes in uiux_experiment, and an integers-only pattern read every one
    // of them as unset. Stepping from one lands on the nearest rung, which is
    // what nearestIndex already does for a hand-written p-5.
    var rung = new RegExp('^' + token + '-(\\d+(?:\\.\\d+)?)$');
    var arbitrary = new RegExp('^' + token + '-\\[([^\\]]+)\\]$');
    // Last match wins, mirroring how a duplicated class would land in the DOM.
    for (var i = classes.length - 1; i >= 0; i--) {
      var m = rung.exec(classes[i]);
      if (m) return { value: Number(m[1]), from: classes[i], arbitrary: false };
      var a = arbitrary.exec(classes[i]);
      if (a) return { value: a[1], from: classes[i], arbitrary: true };
    }
    return null;
  }

  /**
   * What is this side actually set to right now?
   *
   * Explicit pt-4 wins, then the axis utility py-4, then the all-sides p-4.
   * Tailwind emits them in that order, so this mirrors what the browser paints.
   */
  /**
   * What the page actually renders for this edge, in px — or null when the
   * edges under one field disagree, in which case there is no single answer to
   * show.
   *
   * Padding and margin are not inherited properties, and Tailwind's preflight
   * zeroes the ones browsers ship a default for, so "no class" almost always
   * means zero. Almost: a project stylesheet can still put padding on an
   * element, and claiming 0 there would be a lie the panel cannot back up.
   */
  var COMPUTED_SIDES = {
    '': ['Top', 'Right', 'Bottom', 'Left'],
    x: ['Left', 'Right'], y: ['Top', 'Bottom'],
    t: ['Top'], r: ['Right'], b: ['Bottom'], l: ['Left'],
  };

  function computedSpacing(el, prefix, side) {
    if (!el) return null;
    var cs = getComputedStyle(el);

    if (prefix === 'gap') {
      // `normal` is what a flex container reports for an unset gap, and it
      // lays out as zero.
      var pick = side === '-x' ? ['columnGap'] : side === '-y' ? ['rowGap'] : ['columnGap', 'rowGap'];
      var g = pick.map(function (k) { return cs[k] === 'normal' ? 0 : Math.round(parseFloat(cs[k]) || 0); });
      return g.every(function (v) { return v === g[0]; }) ? g[0] : null;
    }

    var edges = COMPUTED_SIDES[side || ''];
    if (!edges) return null;
    var prop = prefix === 'm' ? 'margin' : 'padding';
    var seen = null;
    for (var i = 0; i < edges.length; i++) {
      var v = Math.round(parseFloat(cs[prop + edges[i]]) || 0);
      if (seen === null) seen = v;
      else if (seen !== v) return null;
    }
    return seen;
  }

  function readSpacing(el, prefix, side) {
    var classes = classesOf(el);

    var direct = scaleValue(classes, prefix + side);
    if (direct) return { value: direct.value, from: direct.from, arbitrary: direct.arbitrary, source: 'explicit' };

    if (side) {
      if (AXIS[side]) {
        var axis = scaleValue(classes, prefix + AXIS[side]);
        if (axis) return { value: axis.value, from: axis.from, arbitrary: axis.arbitrary, source: 'inherited' };
      }
      var all = scaleValue(classes, prefix);
      if (all) return { value: all.value, from: all.from, arbitrary: all.arbitrary, source: 'inherited' };
    }

    return { value: null, from: null, arbitrary: false, source: 'none' };
  }

  /**
   * What size is this element wearing, and in which idiom?
   *
   *   scale — a named class (text-lg)
   *   px    — an arbitrary value (text-[13px]), stepped by the pixel
   *   none  — nothing set; report what it actually renders at, so the field
   *           shows something true rather than a dash
   */
  function readFontSize(el) {
    if (!el) return { kind: 'none', px: 0 };
    var classes = classesOf(el);

    var named = FONT_SIZES.find(function (v) { return classes.indexOf(v) !== -1; });
    if (named) return { kind: 'scale', name: named };

    for (var i = classes.length - 1; i >= 0; i--) {
      if (FAMILY.fontSizeArb.test(classes[i])) {
        var m = /\[([\d.]+)(px|rem|em)\]/.exec(classes[i]);
        return { kind: 'px', px: Number(m[1]), unit: m[2], cls: classes[i] };
      }
    }
    return { kind: 'none', px: Math.round(parseFloat(getComputedStyle(el).fontSize) || 0) };
  }

  /** Clear both idioms, then write one. */
  function setFontSize(el, cls) {
    stripFamily(el, FAMILY.fontSize);
    stripFamily(el, FAMILY.fontSizeArb);
    if (cls) {
      ensureFontRule(cls);
      el.classList.add(cls);
    }
    markDirty(el, 'classes');
    refresh();
  }

  /**
   * An arbitrary size exists in no source file, so Tailwind generates nothing
   * for it — the same gap arbitrary colours have. Emit the rule at runtime.
   */
  function ensureFontRule(cls) {
    var m = /^text-\[([\d.]+)(px|rem|em)\]$/.exec(cls);
    if (!m || dynSeen[cls]) return;
    dynSeen[cls] = true;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.setAttribute('data-tw-editor', 'dynamic');
      document.head.appendChild(dynStyle);
    }
    var sel = (PREVIEW_ATTR ? '[' + PREVIEW_ATTR + ']' : '') + '.' + CSS.escape(cls);
    try {
      dynStyle.sheet.insertRule(sel + '{font-size:' + m[1] + m[2] + '}', dynStyle.sheet.cssRules.length);
    } catch (e) {
      dynSeen[cls] = false;
    }
  }

  /**
   * Nearest slot on the scale, so a hand-written p-5 still steps sensibly and a
   * typed 7 lands somewhere real. Ties round up (7 → 8), which is what people
   * expect from a number field; `<=` is what makes the later slot win.
   */
  function nearestIndex(value) {
    var best = 0;
    for (var i = 1; i < SPACING.length; i++) {
      if (Math.abs(SPACING[i] - value) <= Math.abs(SPACING[best] - value)) best = i;
    }
    return best;
  }

  function stepSpacing(prefix, side, dir) {
    if (!selected) return;
    var state = readSpacing(selected, prefix, side);
    var pattern = familyRe(prefix, side);
    // An arbitrary value steps from wherever it actually sits on the ladder.
    var from = state.value === null ? null
      : state.arbitrary ? parseFloat(state.value) / (pxOfSpacing(1) || 4)
      : state.value;
    var index = from === null ? -1 : nearestIndex(from);
    var next;

    if (state.source === 'explicit') {
      next = index + dir;
      // Stepping below zero drops the class entirely rather than pinning a 0,
      // which is the only way back to an inherited (or clean) class string.
      if (next < 0) {
        stripFamily(selected, pattern);
        refresh();
        return;
      }
    } else {
      // Inherited or unset: step away from whatever the side renders as today.
      next = (index === -1 ? 0 : index) + dir;
    }

    next = Math.max(0, Math.min(SPACING.length - 1, next));
    setSpacing(prefix, side, String(SPACING[next]));
  }

  /**
   * Apply an explicit value, snapping to the nearest step on the scale.
   *
   * Snapping is not tidiness: Tailwind v4 generates no CSS for a class that
   * appears in no source file, and the dev palette only pre-renders this scale.
   * An unsnapped p-5 would write correctly but preview as nothing.
   */
  /**
   * `suffix` is the class's own tail: a rung ('4', '3.5') or an arbitrary value
   * in brackets ('[13px]'). It is written as given.
   *
   * This used to snap to the nearest rung, and the reason was sound at the
   * time: Tailwind v4 generates no CSS for a class in no source file, and the
   * palette pre-renders only the ladder, so an unsnapped p-13 would write
   * correctly and preview as nothing. ensureSpacingRule closes that gap, which
   * is what makes typing a value the field cannot snap to safe.
   */
  /** One edge of a comma pair: its own value, or what it actually renders. */
  function edgeText(text, prefix, edge) {
    if (text !== '') return text;
    var actual = computedSpacing(selected, prefix, edge);
    return actual === null ? '\u2014' : String(actual);
  }

  /** What a field would show for a given class tail — the inverse of commit(). */
  function textForSuffix(suffix) {
    if (suffix === null) return '';
    var px = /^\[([\d.]+)px\]$/.exec(suffix);
    if (px) return px[1];
    if (suffix.charAt(0) === '[') return suffix.slice(1, -1);
    return String(pxOfSpacing(suffix));
  }

  /** The class tail for a pixel length: a rung where one lands, else arbitrary. */
  function suffixForPx(px) {
    return rungForPx(px) || '[' + px + 'px]';
  }

  function setSpacing(prefix, side, suffix) {
    if (!selected) return;
    var pattern = familyRe(prefix, side);
    if (suffix === null) {
      stripFamily(selected, pattern);
      markDirty(selected, 'classes');
      refresh();
      return;
    }
    // An axis owns the two edges beneath it, the same way the all-sides field
    // owns the axes. Leave pl-* in place while writing px-* and the more
    // specific class wins, so the field the user just typed into does nothing.
    var under = PAIR[side];
    if (under) {
      stripFamily(selected, familyRe(prefix, under[0]));
      stripFamily(selected, familyRe(prefix, under[1]));
    }
    var cls = prefix + side + '-' + suffix;
    ensureSpacingRule(cls, prefix, side, suffix);
    applyClass(selected, cls, pattern);
  }

  /**
   * A rung off the pre-generated ladder, or an arbitrary value, exists in no
   * source file — so Tailwind has generated nothing for it and the preview
   * would be a no-op. Same gap arbitrary colours, sizes and radii have.
   *
   * `--spacing` is read rather than assumed: it is a theme token a project can
   * and does move, and calc() against it is exactly what Tailwind emits.
   */
  function ensureSpacingRule(cls, prefix, side, suffix) {
    if (!cls || dynSeen[cls]) return;
    var props = (SPACING_PROPS[prefix] || {})[side || ''];
    if (!props) return;

    var value = null;
    var arb = /^\[([^\]]+)\]$/.exec(suffix);
    if (arb) value = arb[1];
    else if (/^\d+(?:\.\d+)?$/.test(suffix) && SPACING.indexOf(Number(suffix)) === -1) {
      value = 'calc(var(--spacing, 0.25rem) * ' + suffix + ')';
    }
    if (value === null) return; // on the ladder: the palette already has it

    dynSeen[cls] = true;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.setAttribute('data-tw-editor', 'dynamic');
      document.head.appendChild(dynStyle);
    }
    var sel = (PREVIEW_ATTR ? '[' + PREVIEW_ATTR + ']' : '') + '.' + CSS.escape(cls);
    var body = props.map(function (k) { return k + ':' + value; }).join(';');
    try {
      dynStyle.sheet.insertRule(sel + '{' + body + '}', dynStyle.sheet.cssRules.length);
    } catch (e) {
      dynSeen[cls] = false;
    }
  }

  /**
   * Spacing is shown, typed and picked in PIXELS.
   *
   * The class written is still the Tailwind rung when one matches — p-4, not
   * p-[16px] — but nobody has to know that 4 means 16 to use the panel. Only
   * a value with no rung behind it becomes arbitrary, and that is what the
   * snowflake marks.
   */
  function rungForPx(px) {
    for (var i = 0; i < SPACING.length; i++) {
      if (pxOfSpacing(SPACING[i]) === px) return String(SPACING[i]);
    }
    return null;
  }

  /**
   * What a field shows: the pixel count, bare.
   *
   * No unit on the panel — every spacing field is in pixels, so printing it on
   * each one is noise. The dropdown still spells it out, once, where the values
   * are being compared against each other.
   */
  function spacingText(state) {
    if (!state || state.value === null) return '';
    if (!state.arbitrary) return String(pxOfSpacing(state.value));
    // A literal in some other unit has to keep it, or it says nothing.
    var px = /^([\d.]+)px$/.exec(String(state.value));
    return px ? px[1] : String(state.value);
  }

  /** What one rung renders as here, measured against the page's own --spacing. */
  function pxOfSpacing(rung) {
    var host = (selected && selected.parentElement) || document.body;
    var probe = document.createElement('span');
    probe.style.cssText =
      'position:fixed;left:-9999px;width:calc(var(--spacing, 0.25rem) * ' + rung + ')';
    host.appendChild(probe);
    var px = Math.round(parseFloat(getComputedStyle(probe).width) || 0);
    probe.remove();
    return px;
  }

  // ------------------------------------------------------------------- panel

  // ------------------------------------------------------------------- panel

  /**
   * Design tokens.
   *
   * The palette is the shadcn token set from bloom-template-private
   * (src/global.css) resolved to hex — the same neutral ramp and the same coral
   * --primary the prototypes use, so the editor reads as Bloomworks tooling
   * rather than as a generic devtool.
   *
   * The proportions follow Linear: 11-13px type, hairline dividers, a 6px
   * control radius inside a 12px card, and two layered low-opacity shadows
   * instead of one heavy drop.
   *
   * Panel styling lives in a scoped stylesheet rather than inline styles, so
   * hover, focus and pressed states are expressible. Inline styles remain the
   * rule for the *user's* elements — the panel is excluded from selection, so
   * its classes can never leak into anything written back to source.
   */
  /**
   * One scheme, not two.
   *
   * The panel used to follow the OS between a light and a dark palette. The
   * design it now wears is a single dark surface, so both keys carry it: a
   * light variant would be an invention, and inventing one is how a design
   * stops matching the file it came from.
   *
   * Every value below is lifted from the Figma frame (352x449, node 1:2):
   * #171717 panel, #232323 fields, #dcdcdc values, #8c8c8c labels,
   * #505050 borders, #aaa icon marks, #858585 the snowflake grey.
   */
  var SCHEME = {
    card: '#171717', bg: '#171717', sunken: '#232323', inset: '#232323',
    border: '#505050', hair: '#232323',
    fg: '#dcdcdc', muted: '#8c8c8c', faint: '#858585', mark: '#aaaaaa',
    hover: 'rgba(255,255,255,.06)', press: 'rgba(255,255,255,.1)', ring: 'rgba(255,255,255,.12)',
    shadow: '0 1px 2px rgba(0,0,0,.5), 0 16px 40px -12px rgba(0,0,0,.7)',
  };
  var TOKENS = { light: SCHEME, dark: SCHEME };
  var RULE = '#212121';   // the hairline under a header
  var RAISED = '#2b2b2b';   // a list row under the cursor
  var SELECTED = '#353535'; // the one that is actually set
  var FOCUS = '#df7e46';    // the field you are working in
  // A literal value reads a shade back from a token: still legible, but not
  // claiming the same standing as something on the scale.
  var LITERAL = '#b4b4b4';
  var EDGE = '#333333';     // the hairline around a dropdown, from the frame
  var BRAND = '#d97959';  // --primary from the template
  var DANGER = '#dc2828'; // --destructive
  var OKGREEN = '#2f9e64';
  var UI_FONT = "Figtree, Figtree_400Regular, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  var UI_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";
  var MOD = /Mac|iP(hone|ad|od)/.test(navigator.platform) ? '\u2318' : 'Ctrl+';

  function vars(t) {
    return Object.keys(t)
      .map(function (k) { return '--bw-' + k + ':' + t[k]; })
      .join(';');
  }

  /**
   * The few marks the export has no file for — the four individual edges, and
   * the small chrome arrows. Drawn on a 12 grid but rendered at 20 to sit with
   * the exported icons, which means 0.9 here lands at the assets' 1.5 stroke.
   */
  function glyph(inner) {
    return '<svg width="20" height="20" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="0.9" stroke-linecap="round">' + inner + '</svg>';
  }
  var ICONS = {
    // Exported from the Figma into assets/ and inlined verbatim. The colours
    // are the design's own — #aaa marks, #505050 boxes, #858585 snowflake — so
    // they are deliberately NOT swapped for currentColor. Padding and margin
    // have parallel sets; the names mirror the filenames so a missing one is
    // obvious at a glance.
    // assets/ic-x.svg
    close: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M15 5L5 15\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M5 5L15 15\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    // assets/ic-chevron-down.svg
    chevron: "<svg width=\"8\" height=\"5\" viewBox=\"0 0 8 5\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0.75 0.75L3.75 3.75L6.75 0.75\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    // assets/ic-snowflake.svg
    snow: "<svg width=\"12\" height=\"12\" viewBox=\"0 0 12 12\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M5 10L4.375 8.75L3 9\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M5 2L4.375 3.25L3 3\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M7 10L7.625 8.75L9 9\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M7 2L7.625 3.25L9 3\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M8.5 10.5L7 7.5H5\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M8.5 1.5L7 4.5L7.75 6\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M1 6H4.25L5 4.5\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 5L9.25 6L10 7\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M11 6H7.75L7 7.5\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M2 5L2.75 6L2 7\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M3.5 10.5L5 7.5L4.25 6\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M3.5 1.5L5 4.5H7\" stroke=\"#858585\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    // assets/ic-align-left.svg
    alignLeft: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M17.5 4.16602H2.5\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M12.5 10H2.5\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M14.1667 15.834H2.5\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    // assets/ic-align-center.svg
    alignCenter: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M17.5 4.16602H2.5\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M14.1673 10H5.83398\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M15.8327 15.834H4.16602\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    // assets/ic-align-right.svg
    alignRight: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M17.5 4.16602H2.5\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M17.5 10H7.5\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M17.5007 15.834H5.83398\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    // assets/ic-padding-hz.svg
    padHz: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_149_417)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><rect x=\"14.5\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/><rect x=\"4\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_149_417\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-padding-vt.svg
    padVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_149_412)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_149_412\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-padding-top.svg
    padTop: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_2_162)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_2_162\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-padding-right.svg
    padRight: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_2_153)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><rect x=\"14.5\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_2_153\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-padding-bottom.svg
    padBottom: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_2_148)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_2_148\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-padding-left.svg
    padLeft: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_2_144)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><rect x=\"4\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_2_144\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-padding-hzvt.svg
    padHzVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_149_398)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_149_398\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-padding-parts.svg
    padParts: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_1_90)\"><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M14.5 6.75C14.5 6.33579 14.8358 6 15.25 6C15.6642 6 16 6.33579 16 6.75V13.25C16 13.6642 15.6642 14 15.25 14C14.8358 14 14.5 13.6642 14.5 13.25V6.75Z\" fill=\"#AAAAAA\"/><path d=\"M4 6.75C4 6.33579 4.33579 6 4.75 6C5.16421 6 5.5 6.33579 5.5 6.75V13.25C5.5 13.6642 5.16421 14 4.75 14C4.33579 14 4 13.6642 4 13.25V6.75Z\" fill=\"#AAAAAA\"/><path d=\"M13.25 4C13.6642 4 14 4.33579 14 4.75C14 5.16421 13.6642 5.5 13.25 5.5L6.75 5.5C6.33579 5.5 6 5.16421 6 4.75C6 4.33579 6.33579 4 6.75 4L13.25 4Z\" fill=\"#AAAAAA\"/><path d=\"M13.25 14.5C13.6642 14.5 14 14.8358 14 15.25C14 15.6642 13.6642 16 13.25 16L6.75 16C6.33579 16 6 15.6642 6 15.25C6 14.8358 6.33579 14.5 6.75 14.5L13.25 14.5Z\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_1_90\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-margin-hz.svg
    marHz: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18 4.75C18 4.33579 18.3358 4 18.75 4C19.1642 4 19.5 4.33579 19.5 4.75V15.25C19.5 15.6642 19.1642 16 18.75 16C18.3358 16 18 15.6642 18 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M0.5 4.75C0.5 4.33579 0.835786 4 1.25 4C1.66421 4 2 4.33579 2 4.75V15.25C2 15.6642 1.66421 16 1.25 16C0.835786 16 0.5 15.6642 0.5 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/></svg>",
    // assets/ic-margin-vt.svg
    marVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 18C15.6642 18 16 18.3358 16 18.75C16 19.1642 15.6642 19.5 15.25 19.5L4.75 19.5C4.33579 19.5 4 19.1642 4 18.75C4 18.3358 4.33579 18 4.75 18L15.25 18Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 0.5C15.6642 0.5 16 0.835787 16 1.25C16 1.66421 15.6642 2 15.25 2L4.75 2C4.33579 2 4 1.66421 4 1.25C4 0.835786 4.33579 0.5 4.75 0.5L15.25 0.5Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-top.svg
    marTop: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 0.5C15.6642 0.5 16 0.835787 16 1.25C16 1.66421 15.6642 2 15.25 2L4.75 2C4.33579 2 4 1.66421 4 1.25C4 0.835786 4.33579 0.5 4.75 0.5L15.25 0.5Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-right.svg
    marRight: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18 4.75C18 4.33579 18.3358 4 18.75 4C19.1642 4 19.5 4.33579 19.5 4.75V15.25C19.5 15.6642 19.1642 16 18.75 16C18.3358 16 18 15.6642 18 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/></svg>",
    // assets/ic-margin-bottom.svg
    marBottom: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 18C15.6642 18 16 18.3358 16 18.75C16 19.1642 15.6642 19.5 15.25 19.5L4.75 19.5C4.33579 19.5 4 19.1642 4 18.75C4 18.3358 4.33579 18 4.75 18L15.25 18Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-left.svg
    marLeft: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0.5 4.75C0.5 4.33579 0.835786 4 1.25 4C1.66421 4 2 4.33579 2 4.75V15.25C2 15.6642 1.66421 16 1.25 16C0.835786 16 0.5 15.6642 0.5 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/></svg>",
    // assets/ic-margin-hzvt.svg
    marHzVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_4_337)\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><rect x=\"1.25\" y=\"1.25\" width=\"17.5\" height=\"17.5\" rx=\"2.75\" stroke=\"#AAAAAA\" stroke-width=\"1.5\"/></g><defs><clipPath id=\"clip0_4_337\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-margin-parts.svg
    marParts: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_4_350)\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 18C15.6642 18 16 18.3358 16 18.75C16 19.1642 15.6642 19.5 15.25 19.5L4.75 19.5C4.33579 19.5 4 19.1642 4 18.75C4 18.3358 4.33579 18 4.75 18L15.25 18Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 0.5C15.6642 0.5 16 0.835787 16 1.25C16 1.66421 15.6642 2 15.25 2L4.75 2C4.33579 2 4 1.66421 4 1.25C4 0.835786 4.33579 0.5 4.75 0.5L15.25 0.5Z\" fill=\"#AAAAAA\"/><path d=\"M18 4.75C18 4.33579 18.3358 4 18.75 4C19.1642 4 19.5 4.33579 19.5 4.75V15.25C19.5 15.6642 19.1642 16 18.75 16C18.3358 16 18 15.6642 18 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M0.5 4.75C0.5 4.33579 0.835786 4 1.25 4C1.66421 4 2 4.33579 2 4.75V15.25C2 15.6642 1.66421 16 1.25 16C0.835786 16 0.5 15.6642 0.5 15.25V4.75Z\" fill=\"#AAAAAA\"/></g><defs><clipPath id=\"clip0_4_350\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // Toggle glyphs: a box inside a box is "one padding all round"; adding the
    // two outer rules is "each edge on its own". The button shows the mode it
    // is currently in, so the icon and the fields below it always agree.
    up: '<svg width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.2 4.4 3.5 2.1l2.3 2.3"/></svg>',
    down: '<svg width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.2 2.6 3.5 4.9l2.3-2.3"/></svg>',
    weight: glyph('<path d="M2.2 9.8 5.2 2.2h1.6l3 7.6" stroke-width="1.6"/><path d="M3.6 7.4h4.8" stroke-width="1.6"/>'),
    font: glyph('<path d="M2 3.2V2.1h8v1.1M6 2.4v7.5M4.3 9.9h3.4"/>'),
    // The control is about one corner, so the glyph shows one: two edges
    // running off the box and the arc that joins them.
    radius: glyph('<path d="M2.1 10V5.1a3 3 0 0 1 3-3H10" stroke-width="1.5"/>' +
      '<path d="M2.1 2.1h1.2M9.9 9.9v-1.2" opacity=".45"/>'),
    plus: '<svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round"><path d="M4.5 1.4v6.2M1.4 4.5h6.2"/></svg>',
    // The delete handle's mark. Heavier than the panel's dismiss ×, because
    // this one removes source rather than closing a window.
    cross: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round"><path d="M2 2l6 6M8 2l-6 6"/></svg>',
    undo: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M2.2 5.4h5.4a3 3 0 0 1 0 6H5.2"/><path d="M4.6 2.6 2 5.4l2.6 2.8"/></svg>',
    redo: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10.8 5.4H5.4a3 3 0 0 0 0 6h2.4"/><path d="M8.4 2.6 11 5.4l-2.6 2.8"/></svg>',
    gapAll: glyph('<rect x="1.6" y="1.6" width="3.6" height="3.6" rx="1"/>' +
      '<rect x="6.8" y="1.6" width="3.6" height="3.6" rx="1"/>' +
      '<rect x="1.6" y="6.8" width="3.6" height="3.6" rx="1"/>' +
      '<rect x="6.8" y="6.8" width="3.6" height="3.6" rx="1"/>'),
    gapX: glyph('<rect x="1.4" y="2.2" width="3.4" height="7.6" rx="1.1"/>' +
      '<rect x="7.2" y="2.2" width="3.4" height="7.6" rx="1.1"/>'),
    gapY: glyph('<rect x="2.2" y="1.4" width="7.6" height="3.4" rx="1.1"/>' +
      '<rect x="2.2" y="7.2" width="7.6" height="3.4" rx="1.1"/>'),
    back: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 1.8 3 5l3.2 3.2"/></svg>',
    detach: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.1" stroke-linecap="round"><path d="M4.6 7.4 2.9 9.1a1.9 1.9 0 0 1-2.7-2.7l1.7-1.7"/>' +
      '<path d="M7.4 4.6 9.1 2.9a1.9 1.9 0 0 1 2.7 2.7L10.1 7.3"/><path d="M1 1l10 10"/></svg>',
  };

  var D = '[data-tw-editor="delete"]';
  var T = '[data-tw-editor="toggle"]';
  var P = '[data-tw-editor="panel"]';
  var PP = '[data-tw-editor="popover"]';
  // Every surface carries the same tokens: the popover and the toggle live on
  // <body>, not inside the panel, so neither can inherit them.
  var SURFACES = [P, PP, T].join(',');
  /** Same rule on each surface: both(' .bw-x') → '[…panel] .bw-x,[…popover] .bw-x,…'. */
  function both(sel) { return [P, PP, T].map(function (s) { return s + sel; }).join(','); }
  /** The two drag handles, which drifted apart once — move on one, grab on the other. */
  function handles(sel) { return P + ' .bw-h' + sel + ',' + P + ' .bw-foot' + sel; }

  function styleSheet() {
    return [
      SURFACES + '{' + vars(TOKENS.light) + ';--bw-brand:' + BRAND + ';--bw-danger:' + DANGER +
        ';--bw-ok:' + OKGREEN + ';font:13px/1.45 ' + UI_FONT + ';-webkit-font-smoothing:antialiased}',
      // both() and not SURFACES + '[…]': an attribute appended to a comma list
      // binds only to its last item, which left the panel permanently dark.
      both('[data-theme="dark"]') + '{' + vars(TOKENS.dark) + '}',
      PP + ' *{box-sizing:border-box;margin:0}',
      PP + ' button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;padding:0}',
      // Anchored to the BOTTOM, so the button bar holds still and the panel
      // grows upward above it when something is selected. Top-anchored, every
      // selection shoved the Save button down the screen.
      P + '{',
      '  position:fixed;bottom:58px;right:16px;width:352px;max-height:calc(100vh - 74px);',
      '  z-index:2147483647;display:none;flex-direction:column;overflow:hidden;',
      '  background:var(--bw-card);color:var(--bw-fg);',
      '  border-radius:12px;box-shadow:var(--bw-shadow);font:15px/1.4 ' + UI_FONT + ';',
      '  -webkit-font-smoothing:antialiased;user-select:none;text-align:left}',
      P + ' *{box-sizing:border-box;margin:0}',
      P + ' button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;padding:0}',

      /* header */
      P + ' .bw-h{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      '  height:60px;padding:0 10px 0 20px;flex:0 0 auto;',
      '  border-bottom:1px solid ' + RULE + '}',
      P + ' .bw-h strong{font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted)}',
      // 40x40 with an 8px radius, transparent by default and #232323 on hover
      // — the two states the design ships, and the ic-x asset inside them.
      both(' .bw-x') + '{width:40px;height:40px;border-radius:8px;flex:0 0 auto;',
      '  background:transparent;display:flex;align-items:center;justify-content:center}',
      both(' .bw-x:hover') + '{background:var(--bw-sunken)}',
      both(' .bw-x svg') + '{display:block}',

      /* body */
      P + ' .bw-body{padding:20px;display:flex;flex-direction:column;gap:20px;overflow-y:auto}',
      // Edit mode is off until it is asked for, so the toggle is the only part
      // of the editor a visiting page shows by default.
      T + '{position:fixed;bottom:16px;right:16px;z-index:2147483646;display:flex;',
      '  align-items:center;gap:7px;padding:7px 12px 7px 10px;border-radius:999px;',
      '  font:600 12px/1 ' + UI_FONT + ';cursor:pointer;border:1px solid var(--bw-border);',
      '  background:var(--bw-card);color:var(--bw-fg);box-shadow:0 2px 10px rgba(0,0,0,.16)}',
      T + '[aria-pressed="true"]{background:' + BRAND + ';border-color:' + BRAND + ';color:#fff}',
      T + ' .bw-dot{width:7px;height:7px;border-radius:999px;background:var(--bw-faint)}',
      T + '[aria-pressed="true"] .bw-dot{background:#fff}',
      T + ' .bw-count{padding:1px 6px;border-radius:999px;font:600 10px/1.5 ' + UI_MONO + ';',
      '  background:' + BRAND + ';color:#fff}',
      T + '[aria-pressed="true"] .bw-count{background:rgba(255,255,255,.28)}',
      // A ring around the viewport while edit mode is on: the page's own links
      // and buttons are being swallowed, which is worth saying out loud.
      '[data-tw-editor="ring"]{position:fixed;inset:0;z-index:2147483645;pointer-events:none;',
      '  display:none;box-shadow:inset 0 0 0 2px rgba(217,121,89,.55)}',
      // The floating delete handle and the ghost it leaves behind. Both live on
      // page elements rather than an editor surface, so they carry their own
      // colours instead of the panel's tokens, and both shout — !important —
      // because whatever the page styles that element with has to lose.
      D + '{position:fixed;z-index:2147483646;width:20px;height:20px;display:none;',
      '  align-items:center;justify-content:center;padding:0;border:0;border-radius:999px;',
      '  background:' + DANGER + ';color:#fff;cursor:pointer;',
      '  box-shadow:0 1px 4px rgba(0,0,0,.35),0 0 0 2px rgba(255,255,255,.9)}',
      D + ':hover{background:#b81f1f}',
      '[data-tw-removed]{opacity:.3!important;filter:grayscale(.7)!important}',
      // The panel has nothing to offer an element that is on its way out, so
      // every control folds away and leaves only the notice and its undo.
      // A class, not [data-tw-removed]: that attribute means "this element is
      // being cut", it is counted to size the blast radius, and it carries the
      // ghost styling — all three of which are wrong for the panel's own body.
      P + ' .bw-body.is-cutting > *:not(.bw-rm){display:none!important}',
      P + ' .bw-rm{display:flex;align-items:flex-start;gap:12px;padding:14px;border-radius:8px;',
      '  background:rgba(220,40,40,.1);border:1px solid rgba(220,40,40,.3)}',
      P + ' .bw-rm-txt{flex:1;font:400 13px/1.45 ' + UI_FONT + ';color:var(--bw-muted)}',
      P + ' .bw-rm-txt strong{display:block;font:400 15px/1.5 ' + UI_FONT + ';color:#e46a6a}',
      P + ' .bw-rm-undo{flex:0 0 auto;font:400 13px/1 ' + UI_FONT + ';color:var(--bw-fg);',
      '  border:0;border-radius:8px;padding:9px 12px;background:var(--bw-sunken)}',
      P + ' .bw-rm-undo:hover{border-color:var(--bw-fg)}',
      // Label above field, as the frame has it — not beside it. The label is
      // the same 15px as the value it names, only greyer.
      // Label above field, as the frame has it — not beside it. Wrapping rather
      // than a nested container: the label claims a full line, so everything
      // after it falls to the next one and lays out as a row. 8px down to the
      // controls, 12px between them — both straight off the frame.
      P + ' .bw-row{display:flex;flex-wrap:wrap;align-items:center;row-gap:8px;column-gap:12px}',
      P + ' .bw-row.top{align-items:flex-start}',
      P + ' .bw-lbl{flex:0 0 100%;font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted)}',

      /* segmented stepper */
      P + ' .bw-field{flex:1;min-width:0;display:flex;align-items:stretch;height:40px;',
      '  background:var(--bw-sunken);border:0;border-radius:8px;overflow:hidden}',
      P + ' .bw-val{flex:1;min-width:0;width:100%;padding:0 4px;border:0;background:transparent;',
      '  font:400 15px/1 ' + UI_FONT + ';color:var(--bw-fg);text-align:left}',
      P + ' .bw-val:focus{outline:none;color:var(--bw-fg);font-style:normal}',
      P + ' .bw-val::placeholder{color:var(--bw-faint)}',
      P + ' .bw-val.is-text{display:flex;align-items:center;padding-left:8px;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      P + ' .bw-val::-webkit-outer-spin-button,' + P + ' .bw-val::-webkit-inner-spin-button{',
      '  -webkit-appearance:none;margin:0}',
      /* stacked up/down */
      // What you are working in says so — a field being typed into, and a field
      // whose list is open, which is focus even though the caret has moved into
      // the popover.
      P + ' .bw-field:focus-within,' + P + ' .bw-seg:focus-within,',
      // Two forms because two things anchor a popover: a row that holds one
      // field, and — since typography put three on one row — a field itself.
      // Not .bw-row.is-open: a spacing field anchors its list to the .bw-input
      // wrapper, not to the row, so tying the ring to the row lit every
      // dropdown except the ones that just grew a chevron.
      //
      // An outline, not an inset shadow. The token button fills its field edge
      // to edge, and a child's background paints OVER a parent's inset shadow —
      // so the ring was being drawn the whole time and hidden under
      // .bw-ctoken:hover, which is exactly where the cursor is after a click.
      // An outline is painted over descendants, and at -1px it lands where the
      // shadow did and follows the same 8px radius.
      P + ' .bw-field.is-open,',
      P + ' .is-open .bw-field{outline:1px solid ' + FOCUS + ';outline-offset:-1px}',
      P + ' .bw-text:focus{outline:none;box-shadow:inset 0 0 0 1px ' + FOCUS + '}',
      both(' .bw-search-in') + '{caret-color:' + FOCUS + '}',
      // The chevron takes the right-hand slot out of flow, so the info that
      // lives there — a unit, a rung name, "inherited", the snowflake — keeps
      // the space and the two simply swap. Both end 12px from the edge, so
      // nothing shifts as one replaces the other.
      P + ' .bw-field{position:relative}',
      P + ' .bw-open,' + P + ' .bw-chev{position:absolute;right:12px;top:50%;margin:0;',
      '  transform:translateY(-50%);display:flex;align-items:center;width:auto;height:auto}',
      P + ' .bw-open svg,' + P + ' .bw-chev svg{display:block}',
      P + ' .bw-field > .bw-snow{margin-right:12px}',
      // The chevron is an affordance, not information: it says "this opens" to
      // a cursor that is already here. Hidden by opacity rather than display so
      // the value never shifts as it comes and goes, and kept for focus and
      // while the list is open — otherwise it would vanish from under the
      // keyboard, and from under the click that just opened it.
      P + ' .bw-chev,' + P + ' .bw-open{opacity:0}',
      P + ' .bw-field:hover .bw-chev,' + P + ' .bw-field:hover .bw-open,',
      P + ' .bw-field:focus-within .bw-chev,' + P + ' .bw-field:focus-within .bw-open,',
      P + ' .bw-field.is-open .bw-chev,' + P + ' .bw-field.is-open .bw-open,',
      P + ' .is-open .bw-chev,' + P + ' .is-open .bw-open{opacity:1}',
      // …and the information it displaces steps back while it is there.
      P + ' .bw-field:hover .bw-unit,' + P + ' .bw-field:hover .bw-snow,',
      P + ' .bw-field:focus-within .bw-unit,' + P + ' .bw-field:focus-within .bw-snow,',
      P + ' .bw-field.is-open .bw-unit,' + P + ' .bw-field.is-open .bw-snow,',
      P + ' .is-open .bw-unit,' + P + ' .is-open .bw-snow{opacity:0}',
      P + ' .bw-spin{flex:0 0 20px;display:flex;flex-direction:column;align-self:stretch;',
      '  padding-right:8px}',
      P + ' .bw-step{flex:1;display:flex;align-items:center;justify-content:center;',
      '  color:var(--bw-faint);min-height:0}',
      P + ' .bw-step{border-radius:3px}',
      P + ' .bw-step:hover{background:var(--bw-hover);color:var(--bw-fg)}',
      P + ' .bw-step:active{background:var(--bw-press)}',
      // Italic means one thing across the whole panel: this value is a literal,
      // not a token on a scale. It used to mean "inherited from a broader
      // class", which put top and bottom in italic the moment you typed a
      // vertical value — two unrelated ideas wearing one style. Inherited keeps
      // the dimmed colour, which is the half of that pair that reads as
      // "not this element's own".
      // is-jit first: an inherited literal is dimmer still, and at equal
      // specificity the later rule is the one that wins.
      P + ' .bw-val.is-jit{font-style:italic;color:' + LITERAL + '}',
      P + ' .bw-val.is-inherited{color:var(--bw-faint)}',
      P + ' .bw-val.is-unset{color:var(--bw-faint)}',

      /* spacing: label, a 2-up grid of inputs, then the per-side toggle */
      P + ' .bw-stack{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:12px}',
      // The frame puts this at the end of the padding row as a 40x40 tile.
      P + ' .bw-toggle{width:40px;height:40px;border-radius:8px;flex:0 0 auto;',
      '  background:transparent;display:flex;align-items:center;justify-content:center}',
      P + ' .bw-toggle:hover,' + P + ' .bw-toggle[aria-pressed="true"]',
      '  {background:var(--bw-sunken)}',
      P + ' .bw-seg{flex:0 0 auto;display:flex;align-items:center;gap:14px;',
      '  height:40px;padding:0 6px;border-radius:8px;background:var(--bw-sunken)}',
      // 6+28+14+28+14+28+6 is the frame's 124px exactly, which only holds if
      // the column above it does not stretch it — a flex column stretches its
      // children on the cross axis by default, and that is the width here.
      P + ' .bw-stack > .bw-seg{align-self:flex-start}',
      // And the reason the family field needs this: .bw-field carries flex:1,
      // which in a column is flex-basis:0 on the HEIGHT. It collapsed the
      // 40px field to the 15px of its own line box. The two in the pair below
      // are grid items, which ignore flex, which is why only this one broke.
      P + ' .bw-stack > .bw-field{flex:0 0 auto}',
      P + ' .bw-segbtn{width:28px;height:28px;border-radius:3px;display:flex;',
      '  align-items:center;justify-content:center}',
      P + ' .bw-segbtn:hover{background:rgba(255,255,255,.06)}',
      P + ' .bw-segbtn[aria-pressed="true"]{background:#505050}',
      P + ' .bw-segbtn svg{display:block}',
      P + ' .bw-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      P + ' .bw-pair.is-hidden{display:none}',
      P + ' .bw-pair.is-single{grid-template-columns:1fr}',
      P + ' .bw-addstrip{flex:1;display:flex;flex-wrap:wrap;gap:5px}',
      P + ' .bw-addchip{display:flex;align-items:center;gap:6px;padding:0 12px 0 9px;height:32px;',
      '  border-radius:8px;font:400 13px/1 ' + UI_FONT + ';color:var(--bw-muted);',
      '  background:var(--bw-sunken)}',
      P + ' .bw-addchip:hover{background:#2b2b2b;color:var(--bw-fg)}',
      P + ' .bw-addchip svg{display:block}',
      // align-self, because the field stretches its children and this one has a
      // fixed height: stretch leaves a 20px icon pinned to the top of a 40px
      // field. The dropdowns were already centred by their own button.
      P + ' .bw-ico{flex:0 0 auto;align-self:center;display:flex;align-items:center;',
      '  justify-content:center;width:20px;height:20px;color:var(--bw-mark);margin:0 10px}',
      P + ' .bw-ico svg{display:block}',
      P + ' .bw-input{min-width:0}',

      /* colour field */
      P + ' .bw-color{align-items:center}',
      P + ' .bw-ctoken{flex:1;min-width:0;display:flex;align-items:center;gap:10px;',
      '  height:100%;padding:0 12px 0 0;overflow:hidden}',
      P + ' .bw-ctoken:hover{background:#2b2b2b}',
      // No mark to indent past, so the value sits at the frame's 12px gutter.
      P + ' .bw-ctoken.is-bare{padding-left:12px;gap:8px}',
      // Not an icon: this is the face itself, set in the face, which is why it
      // is the one thing in a bare field that comes before the value.
      P + ' .bw-famsample{flex:0 0 auto;font:15px/1 serif;color:var(--bw-fg)}',
      // A name set in its own face needs a taller line box than the panel's
      // own 15px/1: overflow:hidden is there for the ellipsis and clips both
      // axes, so a script face loses its ascenders and descenders to it.
      // 15px, not the list's 16: this sits beside `400` and `16px`, and the
      // frame's panel text is 15 throughout. Only the line box grows.
      P + ' .bw-cname.is-face{line-height:1.6}',
      P + ' .bw-famsample.is-unset{color:var(--bw-faint)}',
      // The chevron: 8x5, 12px in from the right, on every field that opens a list.
      P + ' .bw-chev{flex:0 0 auto;display:flex;align-items:center;margin-left:auto}',
      P + ' .bw-chev svg{display:block}',
      both(' .bw-chip') + '{flex:0 0 auto;width:14px;height:14px;border-radius:4px;',
      '  box-shadow:inset 0 0 0 1px var(--bw-ring)}',
      P + ' .bw-chip.is-empty{background:repeating-linear-gradient(45deg,var(--bw-hair) 0 3px,transparent 3px 6px)}',
      both(' .bw-snow') + '{flex:0 0 auto;display:flex;align-items:center}',
      both(' .bw-snow svg') + '{display:block}',
      PP + ' .bw-customtag{display:flex;align-items:center;gap:6px}',
      PP + ' .bw-custom .bw-sizename{font-style:italic;color:' + LITERAL + '}',
      // flex:1 so the NAME takes the slack, min-width:0 so it ellipsizes when
      // there is none — "Euclid Circular B" used to push the token out of the
      // field entirely. The note used to claim the slack with margin-left:auto
      // instead, which put two auto margins in one row: they split the free
      // space evenly and stranded the note halfway to the chevron.
      P + ' .bw-cname{flex:1;min-width:0;font:400 15px/1 ' + UI_FONT + ';color:var(--bw-fg);',
      // text-align, because the token is a <button> and a button centres its
      // text by UA default. Invisible while this span was auto-width; the
      // moment flex:1 gave it the whole field, the value drifted to the middle.
      '  text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      P + ' .bw-cname.is-unset{color:var(--bw-faint)}',
      P + ' .bw-alpha{flex:0 0 auto;display:flex;align-items:center;gap:1px;',
      '  padding-left:4px;border-left:1px solid var(--bw-hair)}',
      P + ' .bw-alpha-in{width:24px;border:0;background:transparent;text-align:right;',
      '  font:11px/1 ' + UI_MONO + ';color:var(--bw-fg)}',
      P + ' .bw-alpha-in:focus{outline:none}',
      // Sits against the chevron: the name above is what absorbs the width.
      P + ' .bw-unit{flex:0 0 auto;font:400 13px/1 ' + UI_FONT + ';color:var(--bw-faint)}',
      P + ' .bw-pct{font:10px/1 ' + UI_FONT + ';color:var(--bw-faint);padding-right:3px}',
      P + ' .bw-detach{flex:0 0 auto;width:22px;height:22px;border-radius:5px;opacity:0;',
      '  display:flex;align-items:center;justify-content:center;color:var(--bw-faint)}',
      P + ' .bw-color:hover .bw-detach{opacity:1}',
      P + ' .bw-detach:hover{background:var(--bw-hover);color:var(--bw-fg)}',

      /* colour popover */
      // border-box on the popover itself, not just its children: the 220 in the
      // frame is the outer width, and PP + ' *' only reaches descendants.
      PP + '{position:fixed;width:220px;max-height:340px;z-index:2147483647;box-sizing:border-box;',
      '  display:none;flex-direction:column;overflow:hidden;background:var(--bw-card);',
      '  color:var(--bw-fg);border:1px solid ' + EDGE + ';border-radius:12px;',
      '  box-shadow:var(--bw-shadow);user-select:none}',
      // Family names are the longest label any of these lists carries — a rung
      // is `lg`, a hue is `clay`, but a face is "Euclid Circular B". 260px is
      // the frame's own panel width, and only the family list asks for it.
      PP + '.is-wide{width:260px}',
      PP + ' .bw-pop-h{display:flex;align-items:center;gap:6px;height:60px;',
      '  padding:0 10px 0 20px;flex:0 0 auto;border-bottom:1px solid ' + RULE + '}',
      PP + ' .bw-pop-h strong{flex:1;font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted);',
      '  text-transform:capitalize}',
      PP + ' .bw-pop-back{width:18px;height:18px;border-radius:4px;color:var(--bw-faint);',
      '  display:flex;align-items:center;justify-content:center}',
      PP + ' .bw-pop-back:hover{background:var(--bw-hover);color:var(--bw-fg)}',
      PP + ' .bw-pop-body{overflow-y:auto;padding:8px}',
      PP + ' .bw-pop-group{padding:7px 8px 3px;font:600 9px/1 ' + UI_FONT + ';',
      '  letter-spacing:.07em;text-transform:uppercase;color:var(--bw-faint)}',
      PP + ' .bw-hue{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:0 12px;',
      '  border-radius:6px;font:12px/1.2 ' + UI_MONO + ';color:var(--bw-fg);text-align:left;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      PP + ' .bw-hue:hover{background:' + RAISED + '}',
      PP + ' .bw-shades{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:2px}',
      PP + ' .bw-shade{height:34px;border-radius:6px;display:flex;align-items:flex-end;',
      '  justify-content:center;padding-bottom:3px;box-shadow:inset 0 0 0 1px var(--bw-ring)}',
      PP + ' .bw-shade:hover{box-shadow:inset 0 0 0 1px var(--bw-ring),0 0 0 2px var(--bw-card),0 0 0 3.5px var(--bw-brand)}',
      PP + ' .bw-search-in{flex:1;min-width:0;height:100%;border:0;background:transparent;',
      '  color:var(--bw-fg);padding:0;font:400 15px/1.4 ' + UI_FONT + '}',
      PP + ' .bw-search-in:focus{outline:none}',
      PP + ' .bw-search-in::placeholder{color:var(--bw-muted)}',
      PP + ' .bw-search-in::placeholder{color:var(--bw-faint)}',
      PP + ' [data-tw-synthetic] .bw-sizepx{color:var(--bw-danger)}',
      // Same box as a row, so an empty list does not change shape: 40px tall,
      // the same 12px inset, the same 15px type.
      PP + ' .bw-pop-empty{display:flex;align-items:center;min-height:40px;padding:0 12px;',
      '  border-radius:8px;font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted)}',
      PP + ' .bw-custom{border-top:1px solid var(--bw-hair);margin-top:3px;padding-top:6px}',
      PP + ' .bw-sizesample{flex:0 0 44px;line-height:1.05;color:var(--bw-fg);overflow:hidden}',
      // One corner, drawn at true scale in the same 44px column the type
      // samples use, so the two lists line up.
      // 26 + 18 keeps the name column aligned with the type list's 44px sample.
      PP + ' .bw-nosample{display:none}',
      PP + ' .bw-radsample{flex:0 0 26px;height:20px;margin-right:18px;box-sizing:border-box;' +
        'border-top:1.5px solid var(--bw-fg);border-left:1.5px solid var(--bw-fg)}',
      // min-width:0 or flex:1 will not shrink below the text: "Euclid Circular
      // B" pushed its token clean off the right edge of the list.
      PP + ' .bw-sizename{flex:1;min-width:0;font:400 15px/1 ' + UI_FONT + ';color:var(--bw-fg);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      PP + ' .bw-sizepx{flex:0 0 auto;font:400 13px/1 ' + UI_FONT + ';color:var(--bw-faint)}',
      PP + ' [data-tw-size]{align-items:baseline}',
      PP + ' [data-tw-radius]{align-items:center}',
      PP + ' .bw-sizename.is-face{font-size:16px;line-height:1.6}',
      PP + ' .bw-hue{border-radius:8px}',
      PP + ' [aria-current="true"]{background:' + SELECTED + '}',
      P + ' .bw-cname.is-custom{color:' + LITERAL + ';font-style:italic}',
      PP + ' .bw-shade-n{font:9px/1 ' + UI_MONO + ';color:#fff;mix-blend-mode:difference}',

      /* swatches */
      P + ' .bw-sws{flex:1;display:flex;gap:6px;align-items:center}',
      P + ' .bw-sw{flex:0 0 auto;width:22px;height:22px;border-radius:6px;',
      '  box-shadow:inset 0 0 0 1px var(--bw-ring);transition:transform .08s ease}',
      P + ' .bw-sw:hover{transform:scale(1.08)}',
      P + ' .bw-sw[aria-pressed="true"]{box-shadow:inset 0 0 0 1px var(--bw-ring),',
      '  0 0 0 2px var(--bw-card),0 0 0 3.5px var(--bw-brand)}',

      /* text mirror */
      P + ' .bw-text{flex:1 1 100%;min-width:0;height:96px;padding:12px;display:block;',
      '  background:var(--bw-sunken);border:0;border-radius:8px;font:400 15px/1.4 ' + UI_FONT + ';',
      '  color:var(--bw-fg);resize:none;overflow-y:auto;word-break:break-word}',
      P + ' .bw-text::placeholder{color:var(--bw-muted)}',
      P + ' .bw-text.is-off::placeholder{font-style:italic}',
      P + ' .bw-text:disabled{cursor:default}',

      /* footer */
      P + ' .bw-foot{flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:10px 12px;',
      '  border-top:1px solid var(--bw-hair);background:var(--bw-bg)}',
      // With nothing selected the footer IS the panel, so it carries no top
      // border of its own — there is nothing above it to be divided from.
      P + '[data-tw-idle] .bw-foot{border-top:0}',
      P + ' .bw-foot-row{display:flex;align-items:center;gap:6px}',
      // The bar is the only part of the panel on screen when nothing is
      // selected, so it has to be a handle too — the header it used to be
      // dragged by is folded away exactly then. Both wear the same cursor:
      // the open hand IS the affordance, which is why there is no grip icon.
      handles('') + '{cursor:grab}',
      handles(':active') + '{cursor:grabbing}',
      handles(' button') + '{cursor:pointer}',
      handles(' button:disabled') + '{cursor:default}',
      P + ' .bw-hbtn{flex:0 0 auto;width:28px;height:28px;display:flex;align-items:center;',
      '  justify-content:center;border-radius:6px;color:var(--bw-fg);',
      '  box-shadow:inset 0 0 0 1px var(--bw-border)}',
      P + ' .bw-hbtn:hover:not(:disabled){background:var(--bw-hover)}',
      P + ' .bw-hbtn:disabled{color:var(--bw-faint);box-shadow:inset 0 0 0 1px var(--bw-hair);',
      '  cursor:default}',
      P + ' .bw-foot-row .bw-save{margin-left:auto}',
      P + ' .bw-save{font:600 12px/1 ' + UI_FONT + ';color:#fff;background:var(--bw-brand);',
      '  border-radius:6px;padding:8px 12px;box-shadow:0 1px 2px rgba(0,0,0,.08);white-space:nowrap}',
      P + ' .bw-save:hover{filter:brightness(1.06)}',
      P + ' .bw-save:disabled{background:transparent;color:var(--bw-faint);',
      '  box-shadow:inset 0 0 0 1px var(--bw-border);cursor:default}',
      P + ' .bw-status{min-width:0;font:11px/1.35 ' + UI_FONT + ';color:var(--bw-muted);word-break:break-word}',
      P + ' .bw-status:empty{display:none}',
      P + ' .bw-status.is-ok{color:var(--bw-ok)}',
      P + ' .bw-status.is-err{color:var(--bw-danger)}',
    ].join('\n');
  }

  function injectStyles() {
    var tag = document.createElement('style');
    tag.setAttribute('data-tw-editor', 'style');
    tag.textContent = styleSheet();
    document.head.appendChild(tag);
  }

  /** Follow the OS theme, and keep following it if it changes mid-session. */
  function bindTheme(el) {
    var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    var apply = function () { el.setAttribute('data-theme', mq && mq.matches ? 'dark' : 'light'); };
    apply();
    if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  }

  function css(el, styles) {
    Object.keys(styles).forEach(function (k) {
      el.style[k] = styles[k];
    });
    return el;
  }

  function make(tag, styles, text) {
    var el = document.createElement(tag);
    if (styles) css(el, styles);
    if (text != null) el.textContent = text;
    return el;
  }

  /** Shorthand: element with a class and optional text. */
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * One −/value/+ segmented field. `wide` fields show the whole class (p-4);
   * the compact per-side ones show just the number, since the label already
   * says which side.
   */
  /**
   * One spacing input: [icon][−][value][+].
   *
   * `side` is '' (all), 'x'/'y' (axis) or 't'/'r'/'b'/'l' (edge) — the same
   * token the Tailwind class uses, so the control and the class it writes
   * cannot disagree.
   */
  function spacingField(prefix, side, opts) {
    var row = el('div', 'bw-input');
    row.setAttribute('data-tw-field', prefix + '-' + (side || 'all'));

    var field = el('div', 'bw-field');
    var mark = el('span', 'bw-ico');
    mark.innerHTML = ICONS[opts.key ? boxIcon(prefix, opts.key, opts.icon) : opts.icon];
    mark.title = opts.name;

    var readout = document.createElement('input');
    readout.className = 'bw-val';
    readout.type = 'text';
    readout.inputMode = 'numeric';
    readout.autocomplete = 'off';
    readout.spellcheck = false;
    readout.placeholder = '—';

    // The snowflake only shows for a value that is not a rung, exactly as it
    // does on font size and radius.
    var snow = snowflake();
    snow.style.display = 'none';

    var open = el('button', 'bw-open');
    open.setAttribute('data-tw-spacing-open', prefix + '-' + (side || 'all'));
    open.innerHTML = ICONS.chevron;
    open.title = opts.name + ' \u2014 pick a token';
    open.addEventListener('click', function () {
      openSpacingPopover(prefix, side, opts.name, row);
    });

    /**
     * What was typed is a length in pixels.
     *
     *   16 / 16px   16 pixels — written as p-4 if a rung lands there, else
     *               p-[16px], which is what the snowflake marks
     *   1.5rem      any other unit is taken at its word, arbitrary
     *
     * Empty clears the class. Anything unparseable restores what was there
     * rather than guessing at an intent.
     */
    function commit() {
      var raw = readout.value.trim().replace(/\s+/g, '');
      var target;
      if (raw === '' || raw === '\u2014') {
        target = null;
      } else {
        var px = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(raw);
        if (px) target = suffixForPx(Number(px[1]));
        // A length in some other unit is taken as written.
        else if (/^-?[\d.]+(rem|em|%|vh|vw|ch)$/.test(raw)) target = '[' + raw + ']';
        else if (/^\[[^\]]+\]$/.test(raw)) target = raw;
        else return refresh(); // not something we can write; put the old value back
      }

      // Committing the value the field already shows is not an edit. Blur fires
      // on every field you merely tab through; without this each one marked the
      // element dirty and pushed a history step that undid to itself. It also
      // covers the nastier case: stepping below zero drops the class, and the
      // blur that followed wrote the inherited value straight back as explicit.
      if (textForSuffix(target) === spacingText(readSpacing(selected, prefix, side))) {
        return refresh();
      }

      setSpacing(prefix, side, target);
    }
    readout.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); readout.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); readout.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        stepSpacing(prefix, side, e.key === 'ArrowUp' ? 1 : -1);
        // refresh() leaves a focused input alone so it never fights the typist.
        // Stepping IS the panel changing the value, so it has to put the new
        // one in by hand — otherwise the blur that follows commits the stale
        // text back and the step silently undoes itself.
        readout.value = spacingText(readSpacing(selected, prefix, side));
      }
    });
    readout.addEventListener('blur', commit);
    readout.addEventListener('focus', function () { readout.select(); });

    field.appendChild(mark);
    field.appendChild(readout);
    field.appendChild(snow);
    field.appendChild(open);
    row.appendChild(field);

    readouts.push(function () {
      if (document.activeElement === readout) return; // don't fight the typist
      var state = readSpacing(selected, prefix, side);

      var pair = PAIR[side];
      if (pair && selected) {
        var one = readSpacing(selected, prefix, pair[0]);
        var two = readSpacing(selected, prefix, pair[1]);
        var oneText = spacingText(one), twoText = spacingText(two);
        if (oneText !== twoText) {
          // Both, comma separated. One number here would be a lie about one of
          // the edges — and this is the case the four-edge view exists for.
          // Upright, not italic: two real values are not one inherited one.
          // An edge with no class of its own still renders something, and
          // ', 8' reads as a missing number rather than a zero.
          var jit = one.arbitrary || two.arbitrary;
          snow.style.display = jit ? '' : 'none';
          readout.value = edgeText(oneText, prefix, pair[0]) + ', ' +
            edgeText(twoText, prefix, pair[1]);
          readout.className = 'bw-val' + (jit ? ' is-jit' : '');
          readout.title = opts.name + ': ' + (one.from || 'not set') + ' and ' +
            (two.from || 'not set') + ' \u2014 typing one value sets both';
          return;
        }
        // The edges agree — and they are what the four-edge view shows, so the
        // folded field shows the same thing. Reading the axis's own class here
        // let the two views contradict each other: mx-[100px] alongside
        // ml-3 mr-3 read 100 folded and 12 / 12 unfolded.
        state = one;
      }

      if (state.value === null) {
        // Nothing in the class list. Where the element genuinely renders zero,
        // say 0 — an empty box and a dash both read as "unknown" when the
        // answer is not in doubt. Where the page's own CSS has put something
        // there, show THAT instead, greyed, rather than a zero that is false.
        var actual = computedSpacing(selected, prefix, side);
        snow.style.display = 'none';
        readout.value = actual === 0 ? '0' : '';
        readout.placeholder = actual === 0 || actual === null ? '\u2014' : String(actual);
        readout.className = 'bw-val is-unset';
        readout.title = actual === 0
          ? opts.name + ': not set, and renders 0'
          : actual === null
            ? opts.name + ': not set'
            : opts.name + ': not set here \u2014 the page renders ' + actual + 'px';
        return;
      }
      readout.placeholder = '\u2014';
      // Explicit values read at full contrast; values merely inherited from a
      // broader class (p-* under px-*, px-* under pl-*) are dimmed and italic,
      // so it is obvious which classes this element actually owns.
      snow.style.display = state.arbitrary ? '' : 'none';
      readout.value = spacingText(state);
      readout.className = 'bw-val' +
        (state.source === 'explicit' ? '' : ' is-inherited') +
        (state.arbitrary ? ' is-jit' : '');
      readout.title = state.source === 'explicit'
        ? opts.name + ': ' + state.from
        : opts.name + ': inherited from ' + state.from;
    });

    return row;
  }

  /** Every side token a box can write, including its all-sides class. */
  function boxSides(box) {
    return [''].concat(
      (box.collapsed || AXES).map(function (f) { return f.side; }),
      (box.expanded || SIDES).map(function (f) { return f.side; })
    );
  }

  function boxIsSet(el, box) {
    return boxSides(box).some(function (side) {
      return readSpacing(el, box.prefix, side).source === 'explicit';
    });
  }

  /**
   * Does this element render text itself, rather than only through children?
   *
   * font-size on a wrapper cascades, so it is not wrong there — but it is
   * indirect, and the row was appearing on every div. Direct text nodes are the
   * honest test: <h1>Hello</h1> yes, <div><span>x</span></div> no.
   */
  function hasOwnText(el) {
    if (!el) return false;
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  /** Can this box do anything for this element, whether or not it is set? */
  function boxApplies(el, box) {
    return box.applies ? box.applies(el) : true;
  }

  function boxVisible(el, box) {
    return !!(box.always || revealed[box.prefix] || boxIsSet(el, box));
  }

  /**
   * gap only takes effect on a flex or grid container, so the row appears for
   * those — and for anything already carrying a gap class, so a stale one on a
   * block element stays visible and removable rather than silently stranded.
   */
  function supportsGap(el) {
    return !!el && /^(inline-)?(flex|grid)$/.test(getComputedStyle(el).display);
  }

  /**
   * A padding or margin box, modelled on Figma: two axis inputs by default,
   * with a toggle that swaps them for the four individual edges. Collapsed and
   * expanded are two views of the same classes — nothing is written or cleared
   * by toggling.
   */
  function boxSection(box) {
    var wrap = el('div', 'bw-row top');
    wrap.appendChild(el('span', 'bw-lbl', box.label));

    var stack = el('div', 'bw-stack');

    var toggle = el('button', 'bw-toggle');
    toggle.innerHTML = ICONS[boxIcon(box.prefix, 'HzVt', 'padHzVt')];
    toggle.setAttribute('data-tw-toggle', box.prefix);
    toggle.setAttribute('aria-pressed', 'false');
    toggle.title = 'Edit ' + box.label.toLowerCase() + ' per side';

    var shut = box.collapsed || AXES;
    var open = box.expanded || SIDES;

    function view(list, hidden) {
      var v = el('div', 'bw-pair' + (list.length === 1 ? ' is-single' : '') + (hidden ? ' is-hidden' : ''));
      list.forEach(function (f) {
        v.appendChild(spacingField(box.prefix, f.side, {
          // `key` is the shape; the box decides which set it comes from. gap
          // has no set of its own and passes a plain icon name instead.
          key: f.key,
          icon: f.icon,
          name: f.name === 'gap' ? 'gap' : box.label.toLowerCase() + ' ' + f.name,
        }));
      });
      return v;
    }

    var axisView = view(shut, false);
    var sideView = view(open, true);

    stack.appendChild(axisView);
    stack.appendChild(sideView);
    wrap.appendChild(stack);
    wrap.appendChild(toggle);

    function render() {
      var open = expanded[box.prefix];
      axisView.className = 'bw-pair' + (open ? ' is-hidden' : '');
      sideView.className = 'bw-pair' + (open ? '' : ' is-hidden');
      toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
      toggle.innerHTML = ICONS[boxIcon(box.prefix, open ? 'Parts' : 'HzVt',
        open ? 'padParts' : 'padHzVt')];
      toggle.title = open
        ? box.label + ': editing each edge — click for horizontal / vertical'
        : box.label + ': horizontal / vertical — click to edit each edge';
    }

    toggle.addEventListener('click', function () {
      expanded[box.prefix] = !expanded[box.prefix];
      render();
    });

    // Open on selection if the element already owns the finer-grained classes,
    // so an element written with pt-6 does not look unset behind a collapsed
    // view. Conditional rows (gap) also decide here whether to appear at all.
    readouts.push(function () {
      var show = boxVisible(selected, box);
      wrap.style.display = show ? '' : 'none';
      if (!show) return;
      if (expandedFor[box.prefix] !== selected) {
        expandedFor[box.prefix] = selected;
        // Four inputs are worth showing only when they would say something two
        // cannot. Now that an axis field reads the edges beneath it, pt-0 pb-0
        // pl-4 pr-4 reads perfectly well as 0 and 16 — so the four edges open
        // for disagreement and nothing else. Decided once, here; after that the
        // toggle is the user's.
        expanded[box.prefix] = box.expanded
          // gap expands to its two axes, which have no edges to compare; show
          // them when either is set in its own right.
          ? open.some(function (f) {
            return readSpacing(selected, box.prefix, f.side).source === 'explicit';
          })
          : Object.keys(PAIR).some(function (axis) {
            var edges = PAIR[axis];
            return spacingText(readSpacing(selected, box.prefix, edges[0])) !==
                   spacingText(readSpacing(selected, box.prefix, edges[1]));
          });
      }
      render();
    });

    return wrap;
  }

  /**
   * Chips for the boxes this element could use but currently does not.
   * Revealing writes nothing — it just shows the row so a value can be set,
   * so nothing is ever hidden beyond reach.
   */
  function addRow() {
    var row = el('div', 'bw-row bw-add');
    row.setAttribute('data-tw-add-row', '');
    row.appendChild(el('span', 'bw-lbl', 'Add'));
    var strip = el('div', 'bw-addstrip');
    row.appendChild(strip);

    readouts.push(function () {
      var missing = BOXES.filter(function (box) {
        return !boxVisible(selected, box) && boxApplies(selected, box);
      }).map(function (box) { return { key: box.prefix, label: box.label }; });

      // The typography fields hide on elements with no text of their own, but
      // a wrapper may legitimately set any of them to cascade — so each stays
      // one click away. Listed in the order they appear in the section.
      if (selected && !hasOwnText(selected) && !revealed.family &&
          familyTokens().length && readFontFamily(selected).kind !== 'token') {
        missing.push({ key: 'family', label: 'Font family' });
      }
      if (selected && !hasOwnText(selected) && !revealed.weight &&
          readFontWeight(selected).kind !== 'token') {
        missing.push({ key: 'weight', label: 'Weight' });
      }
      if (selected && !hasOwnText(selected) && !revealed.font &&
          readFontSize(selected).kind === 'none') {
        missing.push({ key: 'font', label: 'Font size' });
      }
      if (selected && !hasOwnText(selected) && !revealed.align &&
          readAlign(selected).kind !== 'token') {
        missing.push({ key: 'align', label: 'Align' });
      }
      // Radius hides where nothing would show it, but an element about to get
      // a background should not have to get one first to round its corners.
      if (selected && !revealed.radius && !showsCorners(selected) &&
          readRadius(selected).kind === 'none') {
        missing.push({ key: 'radius', label: 'Radius' });
      }
      row.style.display = missing.length ? '' : 'none';
      strip.innerHTML = '';
      missing.forEach(function (box) {
        var chip = el('button', 'bw-addchip');
        chip.setAttribute('data-tw-add', box.key);
        chip.innerHTML = ICONS.plus;
        chip.appendChild(el('span', null, box.label));
        chip.title = 'Show ' + box.label.toLowerCase() + ' controls';
        chip.addEventListener('click', function () {
          revealed[box.key] = true;
          refresh();
        });
        strip.appendChild(chip);
      });
    });

    return row;
  }

  // ------------------------------------------------------- other controls

  /**
   * A field that opens a list, with no leading icon.
   *
   * Bare because the frame's typography fields are bare, and because two of
   * them now share one 260px line: a 20px mark with its 10px margins would eat
   * a third of the 124px each is left with. The dropdowns that still have a
   * row to themselves — radius, the two colours — keep their marks.
   */
  function dropField(key, open) {
    var field = el('div', 'bw-field bw-color');
    field.setAttribute('data-tw-field', key);
    field.setAttribute('data-tw-optional', key);
    var token = el('button', 'bw-ctoken is-bare');
    var name = el('span', 'bw-cname', '\u2014');
    var note = el('span', 'bw-unit', '');
    token.appendChild(name);
    token.appendChild(note);
    token.appendChild(chevron());
    field.appendChild(token);
    // The field is what the popover anchors to and what lights up, not the row
    // it sits in: three of these share a row now, so lighting the row would
    // claim all three were open.
    token.addEventListener('click', function () { open(field); });
    return { field: field, token: token, name: name, note: note };
  }

  function sizeField() {
    var d = dropField('font', function (anchor) { openSizePopover(anchor); });
    d.token.setAttribute('data-tw-font-open', '');

    d.sync = function () {
      // Font size hides on elements with no text of their own, but a wrapper
      // may legitimately set it to cascade — so it stays one click away.
      var state = readFontSize(selected);
      var show = hasOwnText(selected) || revealed.font || state.kind !== 'none';
      d.field.style.display = show ? '' : 'none';
      if (!show) return false;

      // Pixels lead and the rung is the note beside them, which is the frame's
      // "24" and the same call the spacing fields already make: nobody should
      // have to know what lg is worth to know how big this is.
      if (state.kind === 'scale') {
        var px = pxOfToken(state.name);
        d.name.textContent = px || state.name.replace('text-', '');
        d.name.className = 'bw-cname';
        d.note.textContent = state.name.replace('text-', '');
        d.token.title = state.cls + (px ? ' \u2014 ' + px : '');
      } else if (state.kind === 'px') {
        // Not a token. Say so rather than dressing it up as one — picking from
        // the list is how you get back onto the scale.
        d.name.textContent = state.px + state.unit;
        d.name.className = 'bw-cname is-custom';
        var near = nearestToken(state.px);
        d.note.textContent = near && near.d > 0 ? near.name : '';
        d.note.appendChild(snowflake());
        d.token.title = state.cls + ' \u2014 not a scale token' +
          (near ? '; nearest is ' + near.name + ' at ' + near.px + 'px' : '');
      } else {
        d.name.textContent = state.px ? state.px + 'px' : '\u2014';
        d.name.className = 'bw-cname is-unset';
        d.note.textContent = state.px ? 'inherited' : '';
        d.token.title = 'not set \u2014 rendering at ' + state.px + 'px';
      }
      return true;
    };
    return d;
  }

  /**
   * The token closest to a given pixel size, so a custom value can say what it
   * is near. A nudge toward the scale rather than a wall in front of it.
   */
  function nearestToken(px) {
    var best = null;
    FONT_SIZES.forEach(function (cls) {
      var v = parseFloat(pxOfToken(cls));
      if (!v) return;
      var d = Math.abs(v - px);
      if (!best || d < best.d) best = { d: d, name: cls.replace('text-', ''), px: v };
    });
    return best;
  }

  /**
   * Which weights the element's own font actually ships.
   *
   * Anything else is synthesized by the browser — faux bold, faux light — so
   * offering all nine is offering eight lies on a font like Space Mono, which
   * declares 400 and nothing else. A variable font declares a range
   * ("100 900") and genuinely covers it.
   *
   * Returns null when it cannot be known — a system font with no @font-face —
   * in which case everything is offered rather than guessing.
   */
  function availableWeights(el) {
    if (!el || !document.fonts) return null;
    var strip = function (v) { return String(v).replace(/^["']|["']$/g, '').toLowerCase(); };
    var family = strip(getComputedStyle(el).fontFamily.split(',')[0].trim());
    if (!family) return null;

    var declared = [];
    document.fonts.forEach(function (face) {
      if (strip(face.family) === family) declared.push(String(face.weight));
    });
    if (!declared.length) return null; // system font: nothing declared to read

    var KEYWORD = { normal: 400, bold: 700 };
    var ok = {};
    declared.forEach(function (spec) {
      var parts = spec.trim().split(/\s+/).map(function (v) {
        return KEYWORD[v] !== undefined ? KEYWORD[v] : Number(v);
      }).filter(function (n) { return !isNaN(n); });
      if (!parts.length) return;
      var lo = parts[0];
      var hi = parts.length > 1 ? parts[1] : parts[0];
      WEIGHT_TOKENS.forEach(function (t) {
        var n = Number(FONT_WEIGHTS[t]);
        if (n >= lo && n <= hi) ok[t] = true;
      });
    });
    return Object.keys(ok).length ? ok : null;
  }

  function readFontWeight(el) {
    if (!el) return { kind: 'none', value: '' };
    var classes = classesOf(el);
    for (var i = classes.length - 1; i >= 0; i--) {
      var name = classes[i].indexOf('font-') === 0 ? classes[i].slice(5) : null;
      if (name && FONT_WEIGHTS[name]) {
        return { kind: 'token', name: name, value: FONT_WEIGHTS[name], cls: classes[i] };
      }
    }
    return { kind: 'none', value: getComputedStyle(el).fontWeight };
  }

  function setFontWeight(el, cls) {
    classesOf(el).forEach(function (c) {
      if (c.indexOf('font-') === 0 && FONT_WEIGHTS[c.slice(5)]) el.classList.remove(c);
    });
    if (cls) el.classList.add(cls);
    markDirty(el, 'classes');
    refresh();
  }

  // ------------------------------------------------------------- font family

  /**
   * The stack a declaration really means.
   *
   * A generated utility does not always carry one. `@theme inline` bakes the
   * value into the rule, but a plain `@theme` emits `font-family:var(--font-
   * sans)` instead — and "var(--font-sans)" is not the name of a typeface.
   * The chain is followed by painting it onto a probe rather than by parsing,
   * because a var may point at another var and the cascade is the only thing
   * that knows the answer. pxOfToken resolves font sizes the same way.
   *
   * The probe sits in a host wearing a sentinel family: a var that resolves
   * to nothing is invalid at computed-value time and inherits, so without the
   * sentinel a dead token would report whatever the page happens to inherit
   * as though the element rendered in it.
   */
  var SENTINEL = 'BwUnresolvedFamily';
  var familyCache = {};
  function resolveFamily(decl) {
    if (!decl) return '';
    if (String(decl).indexOf('var(') === -1) return String(decl);
    if (familyCache[decl] !== undefined) return familyCache[decl];
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:-9999px;font-family:' + SENTINEL;
    var probe = document.createElement('span');
    probe.style.fontFamily = decl;
    host.appendChild(probe);
    document.body.appendChild(host);
    var out = getComputedStyle(probe).fontFamily;
    host.remove();
    familyCache[decl] = (out && out !== SENTINEL && out.indexOf('var(') === -1) ? out : '';
    return familyCache[decl];
  }

  /** The first entry of a stack, unquoted. */
  function firstFamily(stack) {
    return String(stack || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  }

  // The families CSS defines rather than ships. A stack leading with one of
  // these names no typeface at all — it asks the platform for whatever it has
  // — so there is no face to show, and saying `ui-sans-serif` in a field
  // whose job is to name a typeface answers a question nobody asked.
  var GENERIC_FAMILY = {
    'ui-sans-serif': 1, 'ui-serif': 1, 'ui-monospace': 1, 'ui-rounded': 1,
    'system-ui': 1, 'sans-serif': 1, serif: 1, monospace: 1, cursive: 1,
    fantasy: 1, math: 1, emoji: 1, fangsong: 1,
  };

  /**
   * The typeface a stack actually names, or '' when it names none.
   *
   * Only the FIRST entry counts. The rest are fallbacks the page reaches for
   * when the first is missing, so on `ui-monospace, "Cascadia Code"` the face
   * in use is the platform's, and naming Cascadia Code would be naming the
   * understudy. Used where there is a second thing to say instead — an unset
   * field, which has a computed stack but no token to fall back on.
   */
  function familyFace(stack) {
    var first = firstFamily(resolveFamily(stack));
    return GENERIC_FAMILY[first.toLowerCase()] ? '' : first;
  }

  /**
   * What a token is called on screen: the typeface, named. `font-sans` is
   * Inter or Aspekta or Euclid Circular B depending on the project, and that
   * name — not `sans` — is the answer to "what is this". Which slot it came
   * from is real information too, so it is shown alongside rather than
   * instead: the face on the left, the token on the right.
   *
   * A stack that names no face at all falls back to the token, because there
   * is nothing else true to say.
   */
  function familyName(token) {
    return firstFamily(resolveFamily(FAMILIES[token])) || token;
  }

  /**
   * Membership, never /^font-/ — the same rule weights are matched by, and
   * for the same 150-and-438-uses reason. FAMILIES holds only names whose
   * generated rule sets font-family, so `font-medium` can neither be read as
   * a family nor stripped by one.
   */
  function readFontFamily(el) {
    if (!el) return { kind: 'none', stack: '' };
    var classes = classesOf(el);
    for (var i = classes.length - 1; i >= 0; i--) {
      var name = classes[i].indexOf('font-') === 0 ? classes[i].slice(5) : null;
      if (name && FAMILIES[name]) {
        return { kind: 'token', name: name, stack: FAMILIES[name], cls: classes[i] };
      }
    }
    return { kind: 'none', stack: getComputedStyle(el).fontFamily };
  }

  function setFontFamily(el, cls) {
    classesOf(el).forEach(function (c) {
      if (c.indexOf('font-') === 0 && FAMILIES[c.slice(5)]) el.classList.remove(c);
    });
    // No preview rule, and none is needed: a family is in FAMILIES only
    // because the page had already generated its rule. That is the whole
    // point of reading them off the page — nothing here can be invented, so
    // nothing here can preview as blank the way an invented class would.
    if (cls) el.classList.add(cls);
    markDirty(el, 'classes');
    refresh();
  }

  // sans/serif/mono are Tailwind's own; anything else is the project's, and
  // goes first for the reason the colour list does — these codebases speak
  // their own vocabulary and reach for the stock names close to never.
  var STOCK_FAMILY = { sans: 1, serif: 1, mono: 1 };

  function familyTokens() {
    // A token whose var resolves to nothing is dropped: it would preview as
    // whatever the row happens to inherit. One that resolves to a generic is
    // kept — `font-sans` meaning the platform's sans is a real answer.
    var all = Object.keys(FAMILIES).filter(function (t) { return !!resolveFamily(FAMILIES[t]); });
    var project = all.filter(function (t) { return !STOCK_FAMILY[t]; });
    project.sort();
    var stock = ['sans', 'serif', 'mono'].filter(function (t) { return all.indexOf(t) !== -1; });
    return project.concat(stock);
  }

  // ------------------------------------------------------------ border radius

  /**
   * Does this colour paint anything at all?
   *
   * Alpha is read by painting it, never by matching the serialised string:
   * the same colour arrives as rgb(), oklch() or lab() depending on where it
   * came from, and `transparent` is only one of the spellings of nothing.
   */
  function isPainted(css) {
    if (!css) return false;
    var cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0)'; // an unparseable value leaves this in place
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3] > 0;
  }

  /**
   * A radius is only visible where there is an edge to round — a painted
   * background, a border, a shadow, replaced content, or a clipped overflow.
   * On a bare run of text it changes nothing, so the row stays off and lives
   * one click away in the Add strip instead.
   */
  function showsCorners(el) {
    if (!el) return false;
    if (/^(IMG|VIDEO|CANVAS|SVG|PICTURE)$/.test(el.tagName.toUpperCase())) return true;
    var cs = getComputedStyle(el);
    if (cs.overflow !== 'visible') return true;      // the clip follows the radius
    if (cs.backgroundImage !== 'none') return true;
    if (cs.boxShadow !== 'none') return true;
    var edges = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
    for (var i = 0; i < edges.length; i++) {
      if (parseFloat(cs[edges[i]]) > 0) return true; // width is 0 when style is none
    }
    return isPainted(cs.backgroundColor);
  }

  /** Is this class one of the all-corner radius utilities we own? */
  function isRadiusClass(cls) {
    if (cls === 'rounded') return true;              // the v3 alias, still 0.25rem
    if (FAMILY.radiusArb.test(cls)) return true;
    return cls.indexOf('rounded-') === 0 && !!RADII[cls.slice(8)];
  }

  function readRadius(el) {
    if (!el) return { kind: 'none', value: '', corners: [] };
    var classes = classesOf(el);
    var corners = classes.filter(function (c) { return FAMILY.radiusSide.test(c); });
    for (var i = classes.length - 1; i >= 0; i--) {
      var c = classes[i];
      if (FAMILY.radiusArb.test(c)) {
        return { kind: 'arbitrary', name: c.slice(9, -1), cls: c, corners: corners };
      }
      // A suffix-less `rounded` is the v3 alias, still 0.25rem: 11 uses across
      // these two codebases. Read so it is visible and replaceable; never
      // offered, because rounded-sm is the same value spelled the way v4
      // spells it.
      if (c === 'rounded') return { kind: 'legacy', name: 'rounded', cls: c, corners: corners };
      if (c.indexOf('rounded-') === 0 && RADII[c.slice(8)]) {
        return { kind: 'token', name: c.slice(8), cls: c, corners: corners };
      }
    }
    var now = getComputedStyle(el).borderTopLeftRadius;
    return { kind: 'none', value: parseFloat(now) ? now : '', corners: corners };
  }

  /** Clear every all-corner idiom, then write one. Per-corner classes stay. */
  function setRadius(el, cls) {
    classesOf(el).forEach(function (c) {
      if (isRadiusClass(c)) el.classList.remove(c);
    });
    if (cls) {
      ensureRadiusRule(cls);
      el.classList.add(cls);
    }
    markDirty(el, 'classes');
    refresh();
  }

  /**
   * The rungs this page can already render, keyed by token.
   *
   * `@theme inline` — which every one of these projects uses — substitutes the
   * token straight into the utility and emits no `--radius-*` at all. On the
   * Cora route `.rounded-lg` is `var(--radius)`, 12px, while `--radius-lg`
   * still resolves to the stock 8px. Reading the variable would be reading the
   * wrong number; reading the generated rule answers the question that
   * matters, which is what this page will actually paint.
   */
  function liveRadii() {
    return (renderable && renderable.radius) || {};
  }

  /**
   * An arbitrary radius exists in no source file, so Tailwind generates
   * nothing for it — the same gap arbitrary colours and sizes have. A rung
   * this route has never used has the same gap for the same reason, and gets
   * the ladder the server read off theme.css; a rung the route DOES render is
   * left alone, because its own rule already carries the right value and ours
   * would only override it with the stock one.
   */
  function ensureRadiusRule(cls) {
    if (!cls || dynSeen[cls]) return;
    var value;
    var arb = /^rounded-\[([\d.]+(?:px|rem|em|%))\]$/.exec(cls);
    if (arb) {
      value = arb[1];
    } else {
      var t = cls.slice(8);
      if (!RADII[t] || liveRadii()[t]) return;
      value = RADII[t];
    }
    dynSeen[cls] = true;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.setAttribute('data-tw-editor', 'dynamic');
      document.head.appendChild(dynStyle);
    }
    var sel = (PREVIEW_ATTR ? '[' + PREVIEW_ATTR + ']' : '') + '.' + CSS.escape(cls);
    try {
      dynStyle.sheet.insertRule(
        sel + '{border-radius:' + value + '}', dynStyle.sheet.cssRules.length);
    } catch (e) {
      dynSeen[cls] = false;
    }
  }

  /**
   * Measure a declaration where the selection sits, so a value written as
   * `var(--radius)` resolves against the same scope the element does. The
   * probe is fixed-position and removed immediately, and it goes beside the
   * element rather than inside it — appending to the selection would mutate
   * the very thing being edited.
   */
  function measureRadius(css) {
    var host = (selected && selected.parentElement) || document.body;
    var probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;border-radius:' + css;
    host.appendChild(probe);
    var px = parseFloat(getComputedStyle(probe).borderTopLeftRadius) || 0;
    probe.remove();
    return px;
  }

  /** What a rung renders as here: the page's own rule first, theme after. */
  function radiusPx(t) {
    if (t === 'full') return Infinity;                  // calc(infinity * 1px)
    var live = liveRadii()[t];
    if (live) return Math.round(measureRadius(live));
    if (t === 'none') return 0;
    return Math.round(measureRadius('var(--radius-' + t + ',' + (RADII[t] || 0) + ')'));
  }

  function pxOfRadius(t) {
    var n = radiusPx(t);
    return n === Infinity ? '\u221e' : n + 'px';
  }

  /**
   * One top-left corner drawn at its true radius, capped so a row stays a row.
   * Past the cap every rung would read as the same quarter circle anyway; the
   * px label beside it still carries the real value.
   */
  function setSampleRadius(node, px) {
    node.style.borderTopLeftRadius = Math.max(0, Math.min(20, px)) + 'px';
  }

  /** Preview type, clamped so a row stays a row. */
  function sampleSize(px) {
    var n = parseFloat(px);
    if (!n) return '';
    return Math.max(9, Math.min(26, n)) + 'px';
  }

  /** The rendered size of a scale token, measured against the page. */
  function pxOfToken(cls) {
    var t = cls.replace('text-', '');
    if (!TEXT_SIZES[t]) return '';
    var probe = document.createElement('span');
    probe.style.cssText =
      'position:fixed;left:-9999px;font-size:var(--text-' + t + ',' + TEXT_SIZES[t] + ')';
    document.body.appendChild(probe);
    var px = Math.round(parseFloat(getComputedStyle(probe).fontSize));
    probe.remove();
    return px ? px + 'px' : '';
  }

  /** Which spacing field the open list belongs to. */
  function openSpacingPopover(prefix, side, name, anchor) {
    popState.prefix = 'spacing';
    popState.hue = null;
    popState.spacing = { prefix: prefix, side: side, name: name };
    popState.anchor = anchor;
    renderPopover();
    popover.style.display = 'flex';
    placePopover(anchor);
  }

  function openSizePopover(anchor) {
    if (!FONT_SIZES.length) return;
    popState.prefix = 'font';
    popState.hue = null;
    popState.anchor = anchor;
    renderPopover();
    popover.style.display = 'flex';
    placePopover(anchor);
  }

  function weightField() {
    var d = dropField('weight', function (anchor) {
      if (!WEIGHT_TOKENS.length) return;
      popState.prefix = 'weight';
      popState.hue = null;
      popState.anchor = anchor;
      renderPopover();
      popover.style.display = 'flex';
      placePopover(anchor);
    });
    d.token.setAttribute('data-tw-weight-open', '');

    d.sync = function () {
      var state = readFontWeight(selected);
      var show = hasOwnText(selected) || revealed.weight || state.kind === 'token';
      d.field.style.display = show ? '' : 'none';
      if (!show) return false;

      if (state.kind === 'token') {
        // Verbatim, not capitalised: this is the word that goes into the file.
        d.name.textContent = state.name;
        d.name.className = 'bw-cname';
        d.note.textContent = state.value;
        d.token.title = state.cls;
      } else {
        d.name.textContent = state.value || '\u2014';
        d.name.className = 'bw-cname is-unset';
        d.note.textContent = state.value ? 'inherited' : '';
        d.token.title = 'not set \u2014 rendering at ' + state.value;
      }
      return true;
    };
    return d;
  }

  /**
   * The exported chevron, on the right edge of anything that opens a list.
   * One helper rather than four copies — the four dropdown fields in this
   * panel have drifted apart before.
   */
  function chevron() {
    var c = el('span', 'bw-chev');
    c.innerHTML = ICONS.chevron;
    return c;
  }

  /** The snowflake marks a value that is a literal, not a token on the scale. */
  function snowflake() {
    var f = el('span', 'bw-snow');
    f.innerHTML = ICONS.snow;
    f.title = 'an arbitrary value, not a token on the scale';
    return f;
  }

  function radiusRow() {
    var row = el('div', 'bw-row');
    row.setAttribute('data-tw-field', 'radius');
    row.setAttribute('data-tw-optional', 'radius');
    row.appendChild(el('span', 'bw-lbl', 'Radius'));

    var field = el('div', 'bw-field bw-color');
    var token = el('button', 'bw-ctoken');
    token.setAttribute('data-tw-radius-open', '');
    var mark = el('span', 'bw-ico');
    mark.innerHTML = ICONS.radius;
    var name = el('span', 'bw-cname', '\u2014');
    var note = el('span', 'bw-unit', '');
    token.appendChild(mark);
    token.appendChild(name);
    token.appendChild(note);
    token.appendChild(chevron());
    field.appendChild(token);
    row.appendChild(field);

    token.addEventListener('click', function () {
      if (!RADIUS_TOKENS.length) return;
      popState.prefix = 'radius';
      popState.hue = null;
      popState.anchor = row;
      renderPopover();
      popover.style.display = 'flex';
      placePopover(row);
    });

    readouts.push(function () {
      var state = readRadius(selected);
      var show = revealed.radius || state.kind !== 'none' || showsCorners(selected);
      row.style.display = show ? '' : 'none';
      if (!show) return;

      if (state.kind === 'none') {
        name.textContent = state.value || '\u2014';
        name.className = 'bw-cname is-unset';
        note.textContent = state.value ? 'inherited' : '';
        token.title = state.value
          ? 'not set \u2014 rendering at ' + state.value
          : 'No radius set \u2014 click to pick one';
      } else {
        name.textContent = state.name;
        name.className = 'bw-cname' + (state.kind === 'arbitrary' ? ' is-custom' : '');
        note.textContent = state.kind === 'token' ? pxOfRadius(state.name)
          : state.kind === 'legacy'
            ? Math.round(measureRadius(liveRadii().DEFAULT || '0.25rem')) + 'px'
            : '';
        if (state.kind === 'arbitrary') note.appendChild(snowflake());
        token.title = state.cls + (state.kind === 'legacy'
          ? ' \u2014 the v3 alias for rounded-sm' : '');
      }
      // Per-corner classes are left alone by every write, so a lingering
      // rounded-l-[2px] still wins on the left. Say so instead of showing one
      // radius and meaning two.
      if (state.corners.length) {
        note.textContent = (note.textContent ? note.textContent + ' ' : '') +
          '+' + state.corners.length;
        token.title += ' \u2014 also ' + state.corners.join(' ') + ', left as written';
      }
    });

    return row;
  }

  // text-left is neither a size nor a colour, so it is matched by membership in
  // this exact set — the same rule that keeps font-sans safe from font-medium.
  var ALIGNS = [
    { name: 'left', icon: 'alignLeft' },
    { name: 'center', icon: 'alignCenter' },
    { name: 'right', icon: 'alignRight' },
  ];

  function readAlign(el) {
    if (!el) return { kind: 'none', name: '' };
    var classes = classesOf(el);
    for (var i = classes.length - 1; i >= 0; i--) {
      if (FAMILY.textAlign.test(classes[i])) {
        return { kind: 'token', name: classes[i].slice(5), cls: classes[i] };
      }
    }
    return { kind: 'none', name: getComputedStyle(el).textAlign };
  }

  function setAlign(el, name) {
    var current = readAlign(el);
    stripFamily(el, FAMILY.textAlign);
    // Pressing the one already set turns it off, which is the only way back to
    // whatever the element inherited.
    if (!(current.kind === 'token' && current.name === name)) {
      el.classList.add('text-' + name);
    }
    markDirty(el, 'classes');
    refresh();
  }

  function alignField() {
    var seg = el('div', 'bw-seg');
    seg.setAttribute('data-tw-field', 'align');
    seg.setAttribute('data-tw-optional', 'align');
    var buttons = ALIGNS.map(function (a) {
      var b = el('button', 'bw-segbtn');
      b.setAttribute('data-tw-align', a.name);
      b.innerHTML = ICONS[a.icon];
      b.title = 'Align ' + a.name;
      b.addEventListener('click', function () { setAlign(selected, a.name); });
      seg.appendChild(b);
      return { name: a.name, node: b };
    });

    return {
      node: seg,
      sync: function () {
        var state = readAlign(selected);
        var show = hasOwnText(selected) || revealed.align || state.kind === 'token';
        seg.style.display = show ? '' : 'none';
        if (!show) return false;
        buttons.forEach(function (b) {
          // Pressed means the class is on THIS element. An alignment the
          // element merely inherits is named in the tooltip, not claimed.
          var on = state.kind === 'token' && state.name === b.name;
          b.node.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.node.title = on
            ? state.cls + ' \u2014 click to clear'
            : 'Align ' + b.name +
              (state.kind === 'none' && state.name ? ' (inheriting ' + state.name + ')' : '');
        });
        return true;
      },
    };
  }

  function familyField() {
    var d = dropField('family', function (anchor) {
      if (!familyTokens().length) return;
      popState.prefix = 'family';
      popState.hue = null;
      popState.anchor = anchor;
      renderPopover();
      popover.style.display = 'flex';
      placePopover(anchor);
    });
    d.token.setAttribute('data-tw-family-open', '');
    // The same specimen the list shows, kept after you pick from it: a face is
    // the one value in this panel whose name is not the point — Aspekta tells
    // you nothing about Aspekta, and two letters of it tell you everything.
    var sample = el('span', 'bw-famsample', 'Ag');
    sample.setAttribute('data-tw-family-sample', '');
    d.token.insertBefore(sample, d.name);

    d.sync = function () {
      var state = readFontFamily(selected);
      // A page that generated no family utility gets no field — an empty list
      // behind a chevron is worse than no chevron. Otherwise the weight rule,
      // for the weight reason: a wrapper with no text of its own can still set
      // a family that cascades, so it waits in the Add strip rather than gone.
      var show = familyTokens().length > 0 &&
        (hasOwnText(selected) || revealed.family || state.kind === 'token');
      d.field.style.display = show ? '' : 'none';
      if (!show) return false;

      // Set from the declaration, not from the resolved stack: a var resolves
      // against wherever it is painted, and the panel is on the same page.
      sample.style.fontFamily =
        state.kind === 'token' ? (FAMILIES[state.name] || '') : (state.stack || '');
      sample.className = 'bw-famsample' + (state.kind === 'token' ? '' : ' is-unset');

      // The name is set in the face it names — the specimen and the label are
      // the same object, which is how every type picker worth using shows a
      // font. is-face buys the line box some headroom: .bw-cname is 15px/1
      // with overflow:hidden for the ellipsis, and a face with real ascenders
      // (Square Peg runs well past them) gets its top and tail shaved off.
      d.name.style.fontFamily =
        state.kind === 'token' ? (FAMILIES[state.name] || '') : (state.stack || '');

      if (state.kind === 'token') {
        d.name.textContent = familyName(state.name);
        d.name.className = 'bw-cname is-face';
        d.note.textContent = state.name;
        d.token.title = state.cls + ' \u2014 ' + (resolveFamily(state.stack) || state.stack);
      } else {
        d.name.textContent = familyFace(state.stack) || firstFamily(state.stack) || '\u2014';
        d.name.className = 'bw-cname is-face is-unset';
        d.note.textContent = state.stack ? 'inherited' : '';
        d.token.title = 'not set \u2014 rendering in ' +
          (resolveFamily(state.stack) || 'the browser default');
      }
      return true;
    };
    return d;
  }

  /**
   * Typography, as one section — the shape of the frame: the family across the
   * full width, weight and size sharing the line below it, the alignment
   * segment below that. Three labels became one because they name one thing,
   * and because at 124px a field cannot afford a label of its own beside it.
   */
  function typographySection() {
    var row = el('div', 'bw-row');
    row.setAttribute('data-tw-section', 'typography');
    row.appendChild(el('span', 'bw-lbl', 'Typography'));

    var stack = el('div', 'bw-stack');
    var family = familyField();
    var weight = weightField();
    var size = sizeField();
    var align = alignField();

    var pair = el('div', 'bw-pair');
    pair.appendChild(weight.field);
    pair.appendChild(size.field);

    stack.appendChild(family.field);
    stack.appendChild(pair);
    stack.appendChild(align.node);
    row.appendChild(stack);

    readouts.push(function () {
      // Each field still decides for itself exactly as it did when it owned a
      // row. The section shows when any of them does, and the pair drops to a
      // single column rather than leaving a hole where the other one was.
      var f = family.sync();
      var w = weight.sync();
      var z = size.sync();
      var a = align.sync();
      pair.className = 'bw-pair' + (w && z ? '' : w || z ? ' is-single' : ' is-hidden');
      row.style.display = (f || w || z || a) ? '' : 'none';
    });

    return row;
  }

  function textRow() {
    var row = el('div', 'bw-row top');
    row.setAttribute('data-tw-field', 'text');
    var label = el('span', 'bw-lbl', 'Text');
    label.style.paddingTop = '6px';
    row.appendChild(label);

    // A textarea, not a mirror. Typing here writes straight through to the
    // element, the same as typing on the page does — the DOM stays the one
    // source of truth and the save path reads it either way.
    var box = document.createElement('textarea');
    box.className = 'bw-text';
    box.setAttribute('data-tw-text', '');
    box.spellcheck = false;
    box.autocomplete = 'off';
    row.appendChild(box);

    box.addEventListener('input', function () {
      if (!selected || !textEditable || box.disabled) return;
      if (selected.textContent === box.value) return;
      selected.textContent = box.value;
      markDirty(selected, 'text');
    });
    box.addEventListener('keydown', function (e) {
      // Escape belongs to the panel here, not to the page: it should leave the
      // field, not drop the selection out from under it.
      if (e.key === 'Escape') { e.stopPropagation(); box.blur(); }
    });

    readouts.push(function () {
      // No text, no field. A container cannot be typed into, and a disabled box
      // explaining that took the largest row in the panel to say nothing you
      // could act on — the row simply is not there now.
      var show = TEXT_ENABLED && textEditable;
      row.style.display = show ? '' : 'none';
      if (!show) return;
      box.disabled = false;
      box.className = 'bw-text';
      box.placeholder = '(empty)';
      box.title = 'type here, or on the page itself';
      // Never while it is being typed into, and never for a value that already
      // matches — assigning would put the caret back at the end.
      if (document.activeElement !== box && box.value !== selected.textContent) {
        box.value = selected.textContent;
      }
    });

    return row;
  }

  // ------------------------------------------------------------ theme tokens

  /**
   * What colour classes can this page actually render?
   *
   * Read the GENERATED UTILITY RULES, not the custom properties. `@theme inline`
   * — which every one of these projects uses — substitutes token values
   * straight into the utilities and emits no `--color-*` at all: on the Cora
   * route `--color-clay` appears zero times in the served CSS while `.text-clay`
   * is right there. Scanning rules also answers the question we actually care
   * about, which is what will render rather than what is declared.
   */
  function discoverUtilities() {
    var found = { bg: {}, text: {}, radius: {}, family: {} };

    function walk(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];

        // Read this rule BEFORE recursing. With CSS nesting every CSSStyleRule
        // carries a (usually empty) cssRules list, so treating that as "this is
        // a group" skips every real rule — 1580 of them on this page.
        var sel = rule.selectorText;
        if (sel && rule.style && sel.charAt(0) === '.' &&
            sel.indexOf('\\') === -1 && sel.indexOf(' ') === -1) {
          var m = /^\.(bg|text)-([a-zA-Z][a-zA-Z0-9-]*)$/.exec(sel);
          if (m) {
            var value = m[1] === 'bg' ? rule.style.backgroundColor : rule.style.color;
            if (value) found[m[1]][m[2]] = value;
          }

          // Radius rungs are read the same way and for the same reason: the
          // route's own `.rounded-lg` is what will render, and under
          // `@theme inline` it carries a value --radius-lg does not have.
          var r = /^\.rounded(?:-([a-z0-9]+))?$/.exec(sel);
          if (r && rule.style.borderRadius) {
            found.radius[r[1] || 'DEFAULT'] = rule.style.borderRadius;
          }

          // Families, and the read is itself the membership test that the
          // font- trap demands: .font-medium sets font-weight and carries no
          // font-family, so it can never land here, while .font-sans and a
          // project's own .font-aspekta both do. Nothing else needs a guard.
          var f = /^\.font-([a-zA-Z][a-zA-Z0-9-]*)$/.exec(sel);
          if (f && rule.style.fontFamily) found.family[f[1]] = rule.style.fontFamily;
        }

        if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
      }
    }

    var sheets = document.styleSheets;
    for (var s = 0; s < sheets.length; s++) {
      var rules;
      try {
        rules = sheets[s].cssRules;
      } catch (e) {
        continue; // cross-origin; nothing readable and nothing we own
      }
      if (rules) walk(rules);
    }
    return found;
  }

  // Stock names that are flat rather than a ramp, so they sort with the palette.
  var STOCK_FLAT = { white: 1, black: 1, transparent: 1, current: 1, inherit: 1 };

  /**
   * Merge what the page defines over what the server reported.
   *
   * Anything shaped `name-123` becomes a ramp entry — which folds a project's
   * extra steps (neutral-60) into the right ramp. Everything else is a flat
   * token with a DEFAULT, the same shape white/black already use, so the rest
   * of the colour code needs no special case for them.
   */
  function buildColorModel() {
    var ramps = {};
    var stockOrder = [];

    if (CFG.colors && CFG.colors.ramps) {
      Object.keys(CFG.colors.ramps).forEach(function (hue) {
        ramps[hue] = {};
        var src = CFG.colors.ramps[hue];
        Object.keys(src).forEach(function (k) { ramps[hue][k] = src[k]; });
      });
      stockOrder = (CFG.colors.order || []).slice();
    }
    var known = {};
    stockOrder.forEach(function (h) { known[h] = true; });

    var utils = discoverUtilities();
    renderable = utils;
    FAMILIES = utils.family;
    familyCache = {}; // a client-routed page can redefine what --font-* means
    // Union of what bg-* and text-* can each render; the picker offers names,
    // and ensurePreviewRule fills any gap for the specific prefix in use.
    var live = {};
    Object.keys(utils.text).forEach(function (n) { live[n] = utils.text[n]; });
    Object.keys(utils.bg).forEach(function (n) { live[n] = utils.bg[n]; });
    var project = [];

    Object.keys(live).forEach(function (name) {
      var m = /^(.+)-(\d+)$/.exec(name);
      if (m) {
        var hue = m[1];
        if (!ramps[hue]) ramps[hue] = {};
        ramps[hue][m[2]] = live[name];
        if (!known[hue] && project.indexOf(hue) === -1 && stockOrder.indexOf(hue) === -1) {
          project.push(hue);
        }
        return;
      }
      ramps[name] = { DEFAULT: live[name] };
      if (STOCK_FLAT[name]) {
        if (stockOrder.indexOf(name) === -1) stockOrder.push(name);
      } else if (project.indexOf(name) === -1) {
        project.push(name);
      }
    });

    project.sort();
    COLORS = {
      order: project.concat(stockOrder),
      ramps: ramps,
      projectCount: project.length,
    };
  }

  // ------------------------------------------------------------------ colour

  /**
   * A colour class is either a Tailwind token (bg-emerald-500), an arbitrary
   * value (bg-[#10b981]), and either may carry an /alpha suffix.
   *
   * Membership is tested against the real ramps rather than a regex, which is
   * what keeps `text-lg` and `text-[13px]` from being mistaken for colours —
   * `text-` is shared between size and colour utilities.
   */
  function parseColorClass(cls, prefix) {
    if (cls.indexOf(prefix + '-') !== 0) return null;
    var body = cls.slice(prefix.length + 1);

    var alpha = 100;
    var slash = body.lastIndexOf('/');
    if (slash > 0 && /^\d{1,3}$/.test(body.slice(slash + 1))) {
      alpha = Number(body.slice(slash + 1));
      body = body.slice(0, slash);
    }

    if (body.charAt(0) === '[' && body.charAt(body.length - 1) === ']') {
      var raw = body.slice(1, -1);
      // `bg-` and `text-` are shared between colour and non-colour utilities,
      // so decide by the value. Rule out images and gradients, then lengths
      // (text-[13px] is a font size), then require something colour-shaped.
      // var(--x) counts: bg-[var(--idx-bg)] is how themed colours get written.
      if (/^(?:url\(|(?:linear|radial|conic)-gradient)/i.test(raw)) return null;
      if (/^[.\d]/.test(raw) || /(?:px|r?em|%|ch|vw|vh|pt|fr)$/i.test(raw)) return null;
      if (!/^(#|rgba?\(|hsla?\(|oklch|oklab|lab\(|lch\(|color\(|var\(|currentColor|transparent)/i.test(raw)) {
        return null;
      }
      return { kind: 'arbitrary', value: raw, alpha: alpha, cls: cls };
    }

    if (!COLORS) return null;
    var ramps = COLORS.ramps;
    if (ramps[body] && ramps[body].DEFAULT) {
      return { kind: 'token', hue: body, shade: null, alpha: alpha, cls: cls };
    }
    var dash = body.lastIndexOf('-');
    if (dash > 0) {
      var hue = body.slice(0, dash);
      var shade = body.slice(dash + 1);
      if (ramps[hue] && ramps[hue][shade]) {
        return { kind: 'token', hue: hue, shade: shade, alpha: alpha, cls: cls };
      }
    }
    return null;
  }

  function readColor(el, prefix) {
    var classes = classesOf(el);
    for (var i = classes.length - 1; i >= 0; i--) {
      var info = parseColorClass(classes[i], prefix);
      if (info) return info;
    }
    return null;
  }

  function stripColor(el, prefix) {
    classesOf(el).forEach(function (c) {
      if (parseColorClass(c, prefix)) el.classList.remove(c);
    });
  }

  /** The CSS value a parsed colour renders as. */
  function colorValue(info) {
    if (!info) return null;
    if (info.kind === 'arbitrary') return info.value;
    var ramp = COLORS && COLORS.ramps[info.hue];
    if (!ramp) return null;
    return info.shade ? ramp[info.shade] : ramp.DEFAULT;
  }

  function colorLabel(info) {
    if (!info) return '—';
    if (info.kind === 'arbitrary') return info.value.toUpperCase();
    return info.shade ? info.hue + '-' + info.shade : info.hue;
  }

  /** Any CSS colour → #rrggbb, by painting it. Clips wide-gamut to sRGB. */
  function toHex(css) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    var d = ctx.getImageData(0, 0, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(function (n) {
      return ('0' + n.toString(16)).slice(-2);
    }).join('');
  }

  /**
   * Tokens are pre-rendered in the dev palette, but an arbitrary value like
   * bg-[#10b981] exists in no source file, so Tailwind generates nothing for
   * it. Emit a matching rule at runtime or a detached colour would preview as
   * no change at all.
   */
  var dynStyle = null;
  var dynSeen = {};
  function ensurePreviewRule(cls, prefix) {
    if (!cls || dynSeen[cls]) return;
    var info = parseColorClass(cls, prefix);
    if (!info) return;
    dynSeen[cls] = true;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.setAttribute('data-tw-editor', 'dynamic');
      document.head.appendChild(dynStyle);
    }
    var token = info.shade ? info.hue + '-' + info.shade : info.hue;
    if (info.kind === 'token' && renderable[prefix] && renderable[prefix][token]) {
      return; // the page's own CSS already has this rule; adding one is noise
    }
    // Use the resolved value rather than var(--color-x): under `@theme inline`
    // no such custom property exists.
    var base = info.kind === 'arbitrary' ? info.value : colorValue(info);
    if (!base) return;
    var value = info.alpha < 100
      ? 'color-mix(in srgb, ' + base + ' ' + info.alpha + '%, transparent)'
      : base;
    var sel = (PREVIEW_ATTR ? '[' + PREVIEW_ATTR + ']' : '') + '.' + CSS.escape(cls);
    try {
      dynStyle.sheet.insertRule(
        sel + '{' + (prefix === 'bg' ? 'background-color' : 'color') + ':' + value + '}',
        dynStyle.sheet.cssRules.length
      );
    } catch (e) {
      dynSeen[cls] = false;
    }
  }

  function applyColor(prefix, cls) {
    if (!selected) return;
    stripColor(selected, prefix);
    if (cls) {
      ensurePreviewRule(cls, prefix);
      selected.classList.add(cls);
    }
    markDirty(selected, 'classes');
    refresh();
  }

  /** Rebuild a class with a different alpha; 100 drops the suffix entirely. */
  function withAlpha(info, prefix, alpha) {
    var base = info.kind === 'arbitrary'
      ? prefix + '-[' + info.value + ']'
      : prefix + '-' + (info.shade ? info.hue + '-' + info.shade : info.hue);
    return alpha >= 100 ? base : base + '/' + alpha;
  }

  // ---------------------------------------------------------- colour popover

  var popover = null;
  var popState = { prefix: null, hue: null, anchor: null, spacing: null };

  function closePopover() {
    if (popover) popover.style.display = 'none';
    popState.prefix = null;
    popState.anchor = null;
    markOpenAnchor();
  }

  /** Exactly one row can own the open list, so exactly one wears the ring. */
  function markOpenAnchor() {
    if (!panel) return;
    var lit = panel.querySelectorAll('.is-open');
    for (var i = 0; i < lit.length; i++) lit[i].classList.remove('is-open');
    if (popState.anchor && popState.anchor.classList) popState.anchor.classList.add('is-open');
  }

  function popoverOpen() { return !!popState.prefix; }

  function buildPopover() {
    popover = el('div', 'bw-pop');
    popover.setAttribute('data-tw-pop', '');
    // Marked as an editor surface so clicks inside it never select the page,
    // and mounted on <body> rather than the panel — the panel clips its
    // overflow, which cut the list off at the panel edge.
    popover.setAttribute('data-tw-editor', 'popover');
    popover.style.display = 'none';
    bindTheme(popover);
    document.body.appendChild(popover);
  }

  /**
   * Sit beside the panel rather than over it, so the control you are editing
   * stays visible. Falls to the other side, then clamps, when space runs out.
   */
  var placeSettling = false;

  function placePopover(anchor) {
    // Some rows hand over the whole row and some hand over the field itself.
    // Measure the field either way, or a list flipping above a row would clear
    // the label too and float 29px off the control it belongs to.
    var box = (anchor.classList && anchor.classList.contains('bw-field'))
      ? anchor
      : (anchor.querySelector && anchor.querySelector('.bw-field')) || anchor;
    var a = box.getBoundingClientRect();
    var w = popover.offsetWidth || 220;
    var h = popover.offsetHeight || 300;
    var gap = 6;
    var edge = 8;

    // Left-aligned with the field and hanging under it, the way a menu does.
    // It used to sit beside the whole panel, which put the list and the control
    // it was changing an inch apart with the panel in between.
    var left = Math.max(edge, Math.min(window.innerWidth - w - edge, a.left));

    // Below by default, above when there is no room — which is the common case
    // here, since the panel is anchored to the bottom of the window.
    var top = a.bottom + gap;
    if (top + h > window.innerHeight - edge) {
      var above = a.top - gap - h;
      top = above >= edge ? above : Math.max(edge, window.innerHeight - h - edge);
    }

    popover.style.left = Math.round(left) + 'px';
    popover.style.top = Math.round(top) + 'px';

    // Clicking a field can scroll the panel to bring it into view, which moves
    // the anchor out from under a placement made in the same tick — measured at
    // 29px on the lower rows. Settle once on the next frame, when it has
    // stopped moving.
    if (placeSettling) return;
    placeSettling = true;
    requestAnimationFrame(function () {
      placeSettling = false;
      if (popoverOpen() && popState.anchor) placePopover(popState.anchor);
    });
  }

  /**
   * A filtered ladder with an escape hatch at the bottom — the shape the size
   * and radius pickers share. Filtering hides rows rather than re-rendering
   * the list, so the input never loses focus or caret position mid-type.
   */
  function tokenList(body, opt) {
    // The header is the search field — that is what the frame shows, a line of
    // type at the top with the close button beside it and a rule underneath.
    // It takes the title's place rather than adding a second row.
    var query = document.createElement('input');
    query.className = 'bw-search-in';
    query.type = 'text';
    query.placeholder = opt.placeholder;
    query.setAttribute(opt.attrs.filter, '');
    query.autocomplete = 'off';
    query.spellcheck = false;

    var head = popover.querySelector('.bw-pop-h');
    var title = head && head.querySelector('strong');
    if (title) head.replaceChild(query, title);
    else popover.insertBefore(query, popover.firstChild);

    var rows = opt.tokens.map(function (t) {
      var item = el('button', 'bw-hue');
      item.setAttribute(opt.attrs.item, t);
      var sample = el('span');
      opt.sample(sample, t);
      item.appendChild(sample);
      // A row can be labelled differently from the token it writes — spacing
      // shows 16px and writes p-4 — so the filter searches the label, which is
      // the only thing the reader can actually see.
      var shown = opt.label ? opt.label(t) : t;
      item.appendChild(el('span', 'bw-sizename', shown));
      item.appendChild(el('span', 'bw-sizepx', opt.meta(t)));
      if (opt.isCurrent(t)) item.setAttribute('aria-current', 'true');
      item.addEventListener('click', function () { opt.pick(t); closePopover(); });
      body.appendChild(item);
      return { token: t, label: shown, node: item };
    });

    // The escape hatch: a numeric query offers an arbitrary value, always
    // ranked below every token so it is reachable but never the easy default.
    var custom = el('button', 'bw-hue bw-custom');
    custom.setAttribute(opt.attrs.custom, '');
    var customSample = el('span');
    opt.sample(customSample, null);
    var customName = el('span', 'bw-sizename', '');
    custom.appendChild(customSample);
    custom.appendChild(customName);
    var customTag = el('span', 'bw-sizepx bw-customtag');
    customTag.appendChild(snowflake());
    customTag.appendChild(el('span', null, 'custom'));
    custom.appendChild(customTag);
    custom.style.display = 'none';
    body.appendChild(custom);

    var pending = null;
    custom.addEventListener('click', function () {
      if (pending == null) return;
      opt.pickCustom(pending);
      closePopover();
    });

    var empty = el('div', 'bw-pop-empty', 'no match');
    empty.style.display = 'none';
    body.appendChild(empty);

    function applyFilter() {
      var q = query.value.trim().toLowerCase();
      var n = parseFloat(q);
      var visible = 0;
      rows.forEach(function (r) {
        var hit = !q || String(r.label).indexOf(q) !== -1 || r.token.indexOf(q) !== -1;
        r.node.style.display = hit ? '' : 'none';
        if (hit) visible++;
      });
      pending = isFinite(n) && n > 0 && /^[\d.]+(px)?$/.test(q) ? n : null;
      // Offering a "custom 40px" beside a 40px rung is offering the same thing
      // twice, and the arbitrary one is the worse of the two.
      if (pending !== null && rows.some(function (r) {
        return String(r.label) === String(pending) + 'px' || String(r.label) === String(pending);
      })) pending = null;
      if (pending == null) {
        custom.style.display = 'none';
      } else {
        custom.style.display = '';
        customName.textContent = pending + 'px';
        opt.previewCustom(customSample, pending);
        visible++;
      }
      empty.style.display = visible ? 'none' : '';
    }

    query.addEventListener('input', applyFilter);
    query.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closePopover(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Enter takes the first thing on screen — a token if one matches, the
      // custom value only when nothing else does.
      var first = rows.find(function (r) { return r.node.style.display !== 'none'; });
      if (first) first.node.click();
      else if (custom.style.display !== 'none') custom.click();
    });

    popover.appendChild(body);
    applyFilter();
    if (popState.anchor) placePopover(popState.anchor);
    setTimeout(function () { query.focus(); }, 0);
  }

  function renderPopover() {
    markOpenAnchor();
    popover.classList.toggle('is-wide', popState.prefix === 'family');
    popover.innerHTML = '';
    var head = el('div', 'bw-pop-h');

    if (popState.hue) {
      var back = el('button', 'bw-pop-back');
      back.innerHTML = ICONS.back;
      back.title = 'All colours';
      back.addEventListener('click', function () { popState.hue = null; renderPopover(); });
      head.appendChild(back);
    }
    head.appendChild(el('strong', null,
      popState.prefix === 'font' ? 'Font size'
        : popState.prefix === 'family' ? 'Font family'
        : popState.prefix === 'weight' ? 'Weight'
        : popState.prefix === 'radius' ? 'Radius'
        : popState.prefix === 'spacing' ? popState.spacing.name
        : (popState.hue || 'Colour')));
    var shut = el('button', 'bw-x');
    shut.innerHTML = ICONS.close;
    shut.addEventListener('click', closePopover);
    head.appendChild(shut);
    popover.appendChild(head);

    var body = el('div', 'bw-pop-body');

    if (popState.prefix === 'family') {
      var currentF = readFontFamily(selected);
      familyTokens().forEach(function (t) {
        var item = el('button', 'bw-hue');
        item.setAttribute('data-tw-family', t);
        // Each sample set in its own family: the list is the only place the
        // difference between two of them is visible before you commit.
        var sample = el('span', 'bw-sizesample', 'Ag');
        sample.style.cssText = 'font-size:16px;font-family:' + FAMILIES[t];
        item.appendChild(sample);
        var label = el('span', 'bw-sizename is-face', familyName(t));
        label.style.fontFamily = FAMILIES[t];
        item.appendChild(label);
        item.appendChild(el('span', 'bw-sizepx', t));
        if (currentF.kind === 'token' && currentF.name === t) {
          item.setAttribute('aria-current', 'true');
        }
        item.title = 'font-' + t + ' \u2014 ' + (resolveFamily(FAMILIES[t]) || FAMILIES[t]);
        item.addEventListener('click', function () {
          setFontFamily(selected, 'font-' + t);
          closePopover();
        });
        body.appendChild(item);
      });
      popover.appendChild(body);
      if (popState.anchor) placePopover(popState.anchor);
      return;
    }

    if (popState.prefix === 'weight') {
      var currentW = readFontWeight(selected);
      var available = availableWeights(selected);
      var shownW = WEIGHT_TOKENS.filter(function (t) {
        if (!available) return true;                       // unknown: offer all
        if (available[t]) return true;
        return currentW.kind === 'token' && currentW.name === t; // keep what is set
      });
      if (available && shownW.length < WEIGHT_TOKENS.length) {
        body.appendChild(el('div', 'bw-pop-group',
          shownW.length + ' of ' + WEIGHT_TOKENS.length + ' shipped by this font'));
      }
      shownW.forEach(function (t) {
        var item = el('button', 'bw-hue');
        item.setAttribute('data-tw-weight', t);
        var sample = el('span', 'bw-sizesample', 'Ag');
        sample.style.cssText = 'font-size:16px;font-weight:' + FONT_WEIGHTS[t];
        item.appendChild(sample);
        item.appendChild(el('span', 'bw-sizename', t));
        item.appendChild(el('span', 'bw-sizepx', FONT_WEIGHTS[t]));
        if (currentW.kind === 'token' && currentW.name === t) {
          item.setAttribute('aria-current', 'true');
        }
        // A weight that is set but not shipped is kept visible, and labelled,
        // rather than silently dropped from the list.
        if (available && !available[t]) {
          item.setAttribute('data-tw-synthetic', '');
          item.lastChild.textContent = 'faux';
        }
        item.addEventListener('click', function () {
          setFontWeight(selected, 'font-' + t);
          closePopover();
        });
        body.appendChild(item);
      });
      popover.appendChild(body);
      if (popState.anchor) placePopover(popState.anchor);
      return;
    }

    if (popState.prefix === 'font') {
      var current = readFontSize(selected);
      tokenList(body, {
        tokens: FONT_TOKENS,
        placeholder: 'Search',
        attrs: { item: 'data-tw-size', filter: 'data-tw-size-filter', custom: 'data-tw-size-custom' },
        // Each sample is set at its own size so the list reads as a type ramp,
        // but capped: 9xl is 128px and would swallow the row whole. The px
        // label still carries the true value.
        sample: function (node, t) {
          node.className = 'bw-sizesample';
          node.textContent = 'Ag';
          if (t) node.style.fontSize = sampleSize(pxOfToken('text-' + t));
        },
        meta: function (t) { return pxOfToken('text-' + t); },
        isCurrent: function (t) { return current.kind === 'scale' && current.name === 'text-' + t; },
        pick: function (t) { setFontSize(selected, 'text-' + t); },
        previewCustom: function (node, v) { node.style.fontSize = sampleSize(v + 'px'); },
        pickCustom: function (v) { setFontSize(selected, 'text-[' + v + 'px]'); },
      });
      return;
    }

    if (popState.prefix === 'spacing') {
      var sp = popState.spacing;
      var live = readSpacing(selected, sp.prefix, sp.side);
      tokenList(body, {
        tokens: SPACING.map(String),
        placeholder: 'Search',
        attrs: { item: 'data-tw-spacing', filter: 'data-tw-spacing-filter',
          custom: 'data-tw-spacing-custom' },
        // The row is the length and nothing else: no rule beside it, and no
        // scale number to translate in your head.
        label: function (t) { return pxOfSpacing(t) + 'px'; },
        sample: function (node) { node.className = 'bw-nosample'; },
        meta: function () { return ''; },
        isCurrent: function (t) {
          return live.source === 'explicit' && !live.arbitrary && String(live.value) === t;
        },
        pick: function (t) { setSpacing(sp.prefix, sp.side, t); },
        previewCustom: function () {},
        // Typed into the filter, a number is pixels too.
        pickCustom: function (v) { setSpacing(sp.prefix, sp.side, suffixForPx(v)); },
      });
      return;
    }

    if (popState.prefix === 'radius') {
      var currentR = readRadius(selected);
      tokenList(body, {
        tokens: RADIUS_TOKENS,
        placeholder: 'Search',
        attrs: { item: 'data-tw-radius', filter: 'data-tw-radius-filter', custom: 'data-tw-radius-custom' },
        sample: function (node, t) {
          node.className = 'bw-radsample';
          setSampleRadius(node, t ? radiusPx(t) : 0);
        },
        meta: function (t) { return pxOfRadius(t); },
        isCurrent: function (t) { return currentR.kind === 'token' && currentR.name === t; },
        pick: function (t) { setRadius(selected, 'rounded-' + t); },
        previewCustom: function (node, v) { setSampleRadius(node, v); },
        pickCustom: function (v) { setRadius(selected, 'rounded-[' + v + 'px]'); },
      });
      return;
    }

    if (!popState.hue) {
      // Project tokens first, then the stock palette. These codebases use the
      // stock ramps close to zero times — they speak bark, brand-teal,
      // background — so offering emerald-500 first would be offering the wrong
      // vocabulary.
      COLORS.order.forEach(function (hue, i) {
        var ramp = COLORS.ramps[hue];
        if (i === 0 && COLORS.projectCount) body.appendChild(el('div', 'bw-pop-group', 'Theme'));
        if (i === COLORS.projectCount) body.appendChild(el('div', 'bw-pop-group', 'Palette'));
        var item = el('button', 'bw-hue');
        item.setAttribute('data-tw-hue', hue);
        var sw = el('span', 'bw-chip');
        sw.style.background = ramp['500'] || ramp.DEFAULT;
        item.appendChild(sw);
        item.appendChild(el('span', null, hue));
        item.addEventListener('click', function () {
          if (ramp.DEFAULT) { applyColor(popState.prefix, popState.prefix + '-' + hue); closePopover(); return; }
          popState.hue = hue;
          renderPopover();
        });
        body.appendChild(item);
      });
    } else {
      var ramp = COLORS.ramps[popState.hue];
      var grid = el('div', 'bw-shades');
      Object.keys(ramp).forEach(function (shade) {
        var cell = el('button', 'bw-shade');
        cell.style.background = ramp[shade];
        cell.title = popState.prefix + '-' + popState.hue + '-' + shade;
        cell.setAttribute('data-tw-shade', shade);
        cell.appendChild(el('span', 'bw-shade-n', shade));
        cell.addEventListener('click', function () {
          applyColor(popState.prefix, popState.prefix + '-' + popState.hue + '-' + shade);
          closePopover();
        });
        grid.appendChild(cell);
      });
      body.appendChild(grid);
    }

    popover.appendChild(body);
    if (popState.anchor) placePopover(popState.anchor);
  }

  function openPopover(prefix, anchor) {
    if (!COLORS) return;
    popState.prefix = prefix;
    var current = readColor(selected, prefix);
    popState.hue = current && current.kind === 'token' && current.shade ? current.hue : null;
    renderPopover();
    popover.style.display = 'flex';
    popState.anchor = anchor;
    placePopover(anchor);
  }

  // -------------------------------------------------------------- colour row

  function colorRow(prefix, label) {
    var row = el('div', 'bw-row');
    row.setAttribute('data-tw-field', prefix === 'bg' ? 'bgColor' : 'textColor');
    row.appendChild(el('span', 'bw-lbl', label));

    var field = el('div', 'bw-field bw-color');

    var token = el('button', 'bw-ctoken');
    token.setAttribute('data-tw-color-open', prefix);
    var chip = el('span', 'bw-chip');
    var name = el('span', 'bw-cname', '—');
    token.appendChild(chip);
    token.appendChild(name);
    token.addEventListener('click', function () { openPopover(prefix, row); });

    var alphaBox = el('span', 'bw-alpha');
    var alphaInput = document.createElement('input');
    alphaInput.className = 'bw-alpha-in';
    alphaInput.type = 'text';
    alphaInput.inputMode = 'numeric';
    alphaInput.setAttribute('data-tw-alpha', prefix);
    alphaBox.appendChild(alphaInput);
    alphaBox.appendChild(el('span', 'bw-pct', '%'));

    var detach = el('button', 'bw-detach');
    detach.innerHTML = ICONS.detach;
    detach.setAttribute('data-tw-detach', prefix);
    detach.title = 'Detach from the Tailwind token';

    token.appendChild(chevron());
    field.appendChild(token);
    field.appendChild(alphaBox);
    field.appendChild(detach);
    row.appendChild(field);

    detach.addEventListener('click', function () {
      var info = readColor(selected, prefix);
      if (!info || info.kind !== 'token') return;
      var hex = toHex(colorValue(info));
      applyColor(prefix, withAlpha({ kind: 'arbitrary', value: hex }, prefix, info.alpha));
    });

    function commitAlpha() {
      var info = readColor(selected, prefix);
      if (!info) return refresh();
      var n = Math.round(parseFloat(alphaInput.value));
      if (isNaN(n)) return refresh();
      applyColor(prefix, withAlpha(info, prefix, Math.max(0, Math.min(100, n))));
    }
    alphaInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitAlpha(); alphaInput.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); alphaInput.blur(); }
    });
    alphaInput.addEventListener('blur', commitAlpha);

    readouts.push(function () {
      var info = readColor(selected, prefix);
      var value = colorValue(info);
      // var(--x) resolves against the element, not the panel, so read it there.
      if (value && value.indexOf('var(') !== -1) {
        var computed = getComputedStyle(selected);
        value = prefix === 'bg' ? computed.backgroundColor : computed.color;
      }
      chip.style.background = value || 'transparent';
      chip.className = 'bw-chip' + (value ? '' : ' is-empty');
      name.textContent = colorLabel(info);
      name.className = 'bw-cname' + (info ? '' : ' is-unset');

      var detached = !!info && info.kind === 'arbitrary';
      field.setAttribute('data-detached', detached ? 'true' : 'false');
      detach.style.display = info && info.kind === 'token' ? '' : 'none';
      alphaBox.style.display = detached ? '' : 'none';
      if (detached && document.activeElement !== alphaInput) alphaInput.value = String(info.alpha);
      token.title = info
        ? (detached ? 'Arbitrary colour — click to pick a token' : prefix + '-' + colorLabel(info))
        : 'No colour set — click to pick one';
    });

    return row;
  }

  function buildPanel() {
    injectStyles();

    panel = document.createElement('div');
    panel.setAttribute('data-tw-editor', 'panel');
    bindTheme(panel);

    var header = el('div', 'bw-h');
    ui.header = header;
    ui.title = el('strong', null, 'nothing selected');
    var close = el('button', 'bw-x');
    close.innerHTML = ICONS.close;
    close.title = 'Deselect (Esc)';
    close.addEventListener('click', deselect);
    header.appendChild(ui.title);
    header.appendChild(close);
    panel.appendChild(header);
    makeDraggable(panel, header);

    var body = el('div', 'bw-body');
    ui.body = body;
    body.appendChild(removeRow());
    body.appendChild(textRow());
    BOXES.forEach(function (box) { body.appendChild(boxSection(box)); });
    body.appendChild(addRow());
    body.appendChild(typographySection());
    body.appendChild(radiusRow());
    body.appendChild(colorRow('bg', 'Background'));
    body.appendChild(colorRow('text', 'Text color'));

    panel.appendChild(body);

    var footer = el('div', 'bw-foot');
    var row = el('div', 'bw-foot-row');

    ui.undo = el('button', 'bw-hbtn');
    ui.undo.setAttribute('data-tw-undo', '');
    ui.undo.innerHTML = ICONS.undo;
    ui.undo.addEventListener('click', undo);

    ui.redo = el('button', 'bw-hbtn');
    ui.redo.setAttribute('data-tw-redo', '');
    ui.redo.innerHTML = ICONS.redo;
    ui.redo.addEventListener('click', redo);

    ui.save = el('button', 'bw-save', 'Saved');
    ui.save.setAttribute('data-tw-save', '');
    ui.save.addEventListener('click', save);
    ui.status = el('span', 'bw-status', '');
    ui.status.setAttribute('data-tw-status', '');

    row.appendChild(ui.undo);
    row.appendChild(ui.redo);
    row.appendChild(ui.save);
    // Status ABOVE the buttons, not below. Everything in this panel grows
    // upward out of the button row; with the status underneath it, a message
    // appearing or clearing changed the footer's height and slid the buttons
    // 22px down the screen — the exact thing the bottom anchor is for.
    footer.appendChild(ui.status);
    footer.appendChild(row);
    panel.appendChild(footer);
    makeDraggable(panel, footer);

    document.body.appendChild(panel);
    buildPopover();
    buildDeleteHandle();
  }

  /**
   * Drag by the bottom-left corner, never the top-left.
   *
   * The panel grows upward out of its button bar, so the bottom edge is the one
   * that has to stay where it was put. Pinning `top` instead — which is the
   * obvious way to write this — meant that after a drag the next selection
   * pushed the bar back down the screen, which is the exact behaviour the
   * bottom anchor exists to prevent.
   */
  function dragOffsets(box) {
    var rect = box.getBoundingClientRect();
    return { left: rect.left, bottom: rect.bottom };
  }

  function placeBox(box, left, bottom) {
    var w = box.offsetWidth;
    box.style.right = 'auto';
    box.style.top = 'auto';
    box.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left)) + 'px';
    // Clamped so the bar can never be dragged past an edge and stranded there.
    box.style.bottom =
      Math.max(8, Math.min(window.innerHeight - 44, window.innerHeight - bottom)) + 'px';
  }

  var dragBox = null;
  var dragDX = 0;
  var dragDY = 0;

  function makeDraggable(box, handle) {
    handle.addEventListener('mousedown', function (e) {
      // closest(), not tagName: a mousedown on the icon inside a button reports
      // the <svg> as its target, so the button test missed and the panel
      // started dragging out from under the click.
      if (e.target.closest && e.target.closest('button,input,[contenteditable]')) return;
      var at = dragOffsets(box);
      dragBox = box;
      dragDX = e.clientX - at.left;
      dragDY = e.clientY - at.bottom;
      document.body.style.cursor = 'grabbing';
      e.preventDefault();
    });
  }

  window.addEventListener('mousemove', function (e) {
    if (!dragBox) return;
    placeBox(dragBox, e.clientX - dragDX, e.clientY - dragDY);
  });

  window.addEventListener('mouseup', function () {
    if (!dragBox) return;
    dragBox = null;
    document.body.style.cursor = '';
  });

  function refresh() {
    if (!selected) return;
    ui.title.textContent = '<' + selected.tagName.toLowerCase() + '>  ' + shortId(selected);
    readouts.forEach(function (update) { update(); });
    updateDeleteHandle();
    updateFooter();
  }

  /** Panel title: '#12' for html mode, 'page.tsx:24' for a source location. */
  function shortId(el) {
    var raw = el.getAttribute(ID_ATTR) || '';
    if (raw.indexOf(':') === -1) return '#' + raw;
    var bits = raw.split(':');
    return bits[0].split('/').pop() + ':' + bits[1];
  }

  /** The class string as it should land on disk — never includes editor state. */
  function liveClasses(el) {
    return classesOf(el).join(' ');
  }

  /**
   * Edit mode decides whether the panel is on screen at all; the selection
   * decides only how much of it. The button bar has to outlive the selection —
   * losing the Save button by clicking the background was a way to strand
   * unsaved work behind a click.
   */
  function updatePanelChrome() {
    if (!panel) return;
    panel.style.display = editing ? 'flex' : 'none';
    var on = !!selected;
    if (on) panel.removeAttribute('data-tw-idle');
    else panel.setAttribute('data-tw-idle', '');
    if (ui.header) ui.header.style.display = on ? 'flex' : 'none';
    if (ui.body) ui.body.style.display = on ? '' : 'none';
  }

  function updateFooter() {
    updateModeToggle();
    updatePanelChrome();
    updateHistoryButtons();
    if (!ui.save) return;
    var n = dirty.size;
    ui.save.disabled = n === 0;
    ui.save.textContent = n === 0
      ? 'Saved'
      : 'Save ' + n + ' change' + (n === 1 ? '' : 's');
  }

  // --------------------------------------------------------------- selection

  function editable(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.closest('[data-tw-editor]')) return null;
    return node.closest('[' + ID_ATTR + ']');
  }

  function select(el, point) {
    if (selected === el) return;
    deselect();
    if (hovered === el) { releaseOutline(hovered); hovered = null; }
    selected = el;
    if (!baseline.has(el)) baseline.set(el, classesOf(el));
    noteTouched(el); // while it is still untouched — see noteTouched
    revealed = {}; // reveals are per-selection, not sticky across elements
    // So is the folded/unfolded choice. Deciding it again here is what makes
    // "decided once per selection" true when you click away and back — while
    // still leaving the toggle alone for every refresh in between.
    expandedFor = { p: null, m: null, gap: null };
    buildColorModel(); // re-read: a client-routed page can swap its @theme
    if (!isRemoved(selected)) setOutline(selected, SELECT_OUTLINE);
    // Nothing about an element marked for removal is editable, and making it
    // contenteditable would invite typing into something already on its way out.
    textEditable = TEXT_ENABLED && !isRemoved(selected) && enableTextEditing(selected);
    if (textEditable) focusText(selected, point);
    updatePanelChrome();
    ui.status.textContent = '';
    ui.status.className = 'bw-status';
    refresh();
  }

  function deselect() {
    closePopover();
    if (!selected) return;
    disableTextEditing(selected);
    textEditable = false;
    releaseOutline(selected);
    selected = null;
    // The panel stays; only its top half goes. The bar below it holds the
    // Save button and the history, which have nothing to do with a selection.
    updatePanelChrome();
    updateDeleteHandle();
    updateFooter();
  }

  // ------------------------------------------------------------------- save

  /**
   * Writes every dirty element in one request.
   *
   * Saving them one at a time would be wrong, not merely slow: the first write
   * changes the file, which invalidates the hash the remaining writes are
   * holding, so every save after the first would be rejected as stale.
   */
  function save() {
    if (!dirty.size) return;

    var edits = [];
    dirty.forEach(function (entry, el) {
      // Send only what actually changed. Sending the class string on a
      // text-only edit made the writer insert a className attribute onto
      // elements that legitimately had none (styled by a stylesheet, not by
      // utilities) — an edit the user never asked for.
      var edit = { id: el.getAttribute(ID_ATTR) };
      // An element on its way out has nothing else to say. The writer drops
      // any edit landing inside a cut anyway; not sending one keeps the
      // request honest about what it is asking for.
      if (entry.remove) {
        edit.remove = true;
        edits.push(edit);
        return;
      }
      if (entry.classes) {
        edit.classes = liveClasses(el);
        var was = baseline.get(el) || [];
        var now = classesOf(el);
        edit.removed = was.filter(function (c) { return now.indexOf(c) === -1; });
        edit.added = now.filter(function (c) { return was.indexOf(c) === -1; });
      }
      if (entry.text && TEXT_ENABLED) {
        // A browser quirk may still have slipped a node in (a <br> from an odd
        // paste path). Flatten back to pure text so the write stays a leaf.
        if (el.children.length) el.textContent = el.textContent;
        edit.text = el.textContent;
      }
      edits.push(edit);
    });

    var saving = [];
    var removing = [];
    dirty.forEach(function (entry, el) {
      saving.push(el);
      if (entry.remove) removing.push(el);
    });

    ui.save.disabled = true;
    ui.status.textContent = 'saving…';
    ui.status.className = 'bw-status';

    fetch(ENDPOINT, {
      method: 'POST',
      headers: CFG.token
        ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.token }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: fileHash, edits: edits }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (r) {
        var data = r.data || {};
        if (data.ok) {
          fileHash = data.hash || fileHash;
          dirty.clear();
          baseline.clear();
          // Undo cannot reach across a write: the file has already changed, so
          // stepping back would only stage the reverse as a fresh edit while
          // silently claiming to have undone something. The saved state is the
          // new starting point.
          forgetHistory();
          saving.forEach(function (el) {
            if (el === selected) setOutline(el, SELECT_OUTLINE);
            else releaseOutline(el);
          });
          // Cut from the file — but only take the nodes off the page where
          // nothing else will. A framework backend re-renders from the new
          // source, and pulling a node out from under React makes its next
          // reconcile throw removeChild on something it no longer owns. In
          // HTML mode nothing re-renders, so there the page must be told.
          var gone = false;
          removing.forEach(function (el) {
            sameSource(el).forEach(function (node) {
              if (node === selected) gone = true;
              if (!HMR) node.remove();
            });
          });
          if (gone) deselect();
          ui.status.textContent = data.files && data.files.length
            ? 'written to ' + data.files.map(function (f) { return f.split('/').pop(); }).join(', ')
            : 'written to index.html';
          ui.status.className = 'bw-status is-ok';
        } else if (data.reason === 'stale-hash') {
          // The file moved under us — a hand edit, a formatter, a branch switch.
          // Keep the pending edits and say so rather than writing to the wrong
          // element, which is exactly what the old code would have done.
          ui.status.textContent = 'source changed on disk — reload before saving';
          ui.status.className = 'bw-status';
        } else if (data.refusals && data.refusals.length) {
          var r = data.refusals[0];
          ui.status.textContent = (r.tag ? '<' + r.tag + '> ' : '') + (r.detail || r.reason);
          ui.status.className = 'bw-status is-err';
        } else {
          ui.status.textContent = 'failed: ' + (data.error || 'unknown error');
          ui.status.className = 'bw-status is-err';
        }
      })
      .catch(function (err) {
        ui.status.textContent = 'failed: ' + err.message;
        ui.status.className = 'bw-status is-err';
      })
      .finally(function () { updateFooter(); });
  }

  // ---------------------------------------------------------------- wiring

  function init() {
    buildPanel();
    buildModeToggle();

    // The fingerprint of the bytes these eids were derived from. Quoted back on
    // every write so the server can reject a save aimed at a file that moved.
    fileHash = document.body.getAttribute('data-tw-hash');
    updateFooter();

    window.addEventListener('beforeunload', function (e) {
      if (!dirty.size) return;
      e.preventDefault();
      e.returnValue = '';
    });

    document.addEventListener('mouseover', function (e) {
      if (!editing) return;
      var el = editable(e.target);
      if (el === hovered) return;
      if (hovered && hovered !== selected) releaseOutline(hovered);
      hovered = el;
      if (hovered && hovered !== selected) setOutline(hovered, HOVER_OUTLINE);
    });

    document.addEventListener('mouseout', function (e) {
      if (!editing || !hovered) return;
      if (e.relatedTarget && hovered.contains(e.relatedTarget)) return;
      if (hovered !== selected) releaseOutline(hovered);
      hovered = null;
    });

    // Capture phase: the page's own links and buttons must not fire while
    // editing. Off the mode, this returns before any of that and the page
    // behaves exactly as it does without the editor loaded.
    document.addEventListener('click', function (e) {
      if (!editing) return;
      // A floating popover has to dismiss itself; it is no longer clipped by
      // (or a child of) the panel, so nothing else closes it. The dismissing
      // click is swallowed rather than also changing the selection — one click
      // should do one thing.
      if (popoverOpen() && e.target.closest &&
          !e.target.closest('[data-tw-pop]') && !e.target.closest('[data-tw-color-open]')) {
        closePopover();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest && e.target.closest('[data-tw-editor]')) return;

      // Clicking inside the element being typed into must place the caret, so
      // this one case is let through — minus any navigation it would trigger.
      if (textEditable && selected && selected.contains(e.target)) {
        if (e.target.closest('a')) e.preventDefault();
        return;
      }

      var el = editable(e.target);
      e.preventDefault();
      e.stopPropagation();
      if (el) select(el, { x: e.clientX, y: e.clientY });
      else deselect();
    }, true);

    document.addEventListener('keydown', function (e) {
      if (!editing || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      // Inside the text being typed, the browser's own undo is the better one
      // and it fires input events we still record. Everywhere else, ours.
      if (textEditable && selected && document.activeElement === selected) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    });

    // Escape steps out one layer at a time: popover, then selection, then the
    // mode itself — so there is always a way back to the page from the keyboard.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !editing) return;
      if (popoverOpen()) { closePopover(); return; }
      if (selected) { deselect(); return; }
      setEditing(false);
    });

    var reflow = function () {
      if (popoverOpen() && popState.anchor) placePopover(popState.anchor);
      // A panel dragged into a corner of a big window must not be left outside
      // a small one. Only re-clamps once it has actually been moved.
      if (panel && panel.style.left) {
        var r = panel.getBoundingClientRect();
        placeBox(panel, r.left, r.bottom);
      }
      updateDeleteHandle();
    };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);

    if (recallMode()) setEditing(true);
    console.log('[tw-editor] ready — turn on edit mode to select elements');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
