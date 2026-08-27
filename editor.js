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
  var renderable = { bg: {}, text: {}, border: {} };

  var HOVER_OUTLINE = '1px dashed rgba(254, 80, 0, .75)';
  var SELECT_OUTLINE = '2px solid #fe5000';
  // Amber marks an element changed but not yet written, so unsaved work stays
  // visible after you move on to another element.
  var DIRTY_OUTLINE = '2px dashed rgba(254, 80, 0, .95)';
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
    // Every idiom that lands on a corner, which is what the all-corners field
    // owns and clears — the same reach px-* has over pl-*/pr-*. Nothing else
    // in Tailwind starts with `rounded`, so one word is the whole family.
    radiusAny: /^rounded(?:-|$)/,
    // The two-corner edge utilities have no field of their own and no regex
    // either: they are read through the corners they actually paint, and
    // cleared by radiusAny along with everything else.
    //
    // The logical forms, which depend on writing direction. Never touched,
    // only noticed: rounded-s-lg still wins on the start corners, and the row
    // says so rather than pretending the element has one radius.
    radiusLogical: /^rounded-(?:s|e|ss|se|es|ee)(?:-|$)/,
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

  /**
   * Which way a lone `gap-*` actually pushes things apart.
   *
   * `gap-4` on a `flex-col` is a *vertical* gap — the same class reads the
   * other way round on a `flex-row`, so a fixed mark is wrong half the time.
   * The axis fields never have this problem: `gap-x-*` is column gap wherever
   * it appears. Only the single field has to ask the element.
   *
   * Grid keeps the horizontal mark: there `gap-4` really does set both axes,
   * and of the two marks the export ships, neither says "both".
   */
  function gapOneIcon(node) {
    if (!node) return 'gapHz';
    var cs = getComputedStyle(node);
    if (!/^(inline-)?flex$/.test(cs.display)) return 'gapHz';
    return /^column/.test(cs.flexDirection) ? 'gapVt' : 'gapHz';
  }

  var GAP_ONE = [{ side: '', name: 'gap', icon: gapOneIcon }];
  var GAP_AXES = [
    { side: '-x', name: 'column gap', icon: 'gapHz' },
    { side: '-y', name: 'row gap', icon: 'gapVt' },
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
    // gap has no toggle: which fields it shows is decided by what the element
    // is wearing, not by a switch. See gapFields.
    { key: 'gap', label: 'Gap', prefix: 'gap', fields: GAP_ONE.concat(GAP_AXES),
      choose: gapFields, applies: supportsGap },
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

  /**
   * The four corners, in the order frame 2:270 lays them out — the box's own
   * reading order, top row then bottom, which is also the order the shorthand
   * `border-radius` says them in.
   */
  var CORNERS = [
    { side: 'tl', name: 'top left', key: 'Tl' },
    { side: 'tr', name: 'top right', key: 'Tr' },
    { side: 'bl', name: 'bottom left', key: 'Bl' },
    { side: 'br', name: 'bottom right', key: 'Br' },
  ];

  /**
   * Which edge utilities cover a corner, the one that wins first.
   *
   * Tailwind emits rounded-t, rounded-r, rounded-b, rounded-l in that order,
   * so on an element wearing both the horizontal edge is the one the browser
   * paints — which is what the field has to report.
   */
  var CORNER_UNDER = { tl: ['l', 't'], tr: ['r', 't'], bl: ['l', 'b'], br: ['r', 'b'] };

  /** What one corner is called in a computed style, and in a declaration. */
  var CORNER_COMPUTED = {
    tl: 'borderTopLeftRadius', tr: 'borderTopRightRadius',
    bl: 'borderBottomLeftRadius', br: 'borderBottomRightRadius',
  };
  var CORNER_PROPS = {
    '': ['border-radius'],
    tl: ['border-top-left-radius'], tr: ['border-top-right-radius'],
    bl: ['border-bottom-left-radius'], br: ['border-bottom-right-radius'],
  };

  // Per-box: is the four-edge view showing? Padding and margin toggle apart.
  // Radius rides along: it is the same question about four corners.
  var expanded = { p: false, m: false, gap: false, radius: false };
  // Which element that choice was made for. Without this the rule below ran on
  // every refresh and overrode the toggle: collapsing an element that owns
  // per-side classes lasted until the next keystroke, and typing into the axis
  // field snapped the view back to the four edges mid-edit.
  var expandedFor = { p: null, m: null, gap: null, radius: null };
  // Rows the user asked to see on this selection though nothing is set yet.
  var revealed = {};
  // What each optional section decided on this pass. Its reveal row is
  // appended after it and its readout runs after it, so the row reads the
  // section's own answer rather than re-deriving it from the same predicates
  // and drifting away from them.
  var shown = {};

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
  // A drag is one step in the ledger too, however many frames the pointer took
  // over it. Text coalesces on a timer, which works because keystrokes are
  // discrete and a pause between them is a real boundary; a drag has a
  // beginning and an end it can simply state, so it states them. Set after the
  // drag's *first* write, so that write opens the step the rest fold into.
  var dragRun = false;
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
    var coalesce = lastPush && lastPush.el === selected &&
      historyAt === history.length - 1 && historyAt > 0 &&
      (dragRun || (kind === 'text' && lastPush.kind === 'text' && now - lastPush.at < 700));

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
    modeToggle.querySelector('.bw-label').textContent = editing ? 'Editing' : 'Edit mode';

    // The badge stays in the row and collapses sideways instead of leaving it.
    //
    // Its 10px/1.5 line box is what makes the pill 33px tall; take the badge
    // out with display:none and the pill drops to 28 and the toggle changes
    // height as you work. Leave it in at full width and its empty slot reads
    // as a hole on the right. is-empty keeps the height and gives up the
    // width, so the pill hugs what you can actually see.
    var count = modeToggle.querySelector('.bw-count');
    count.textContent = dirty.size ? String(dirty.size) : '';
    count.className = 'bw-count' + (dirty.size ? '' : ' is-empty');
    count.style.display = '';
    // The badge is inset by the pill's own vertical padding on the three sides
    // it touches, which is a padding-right the label's own 12px cannot be. It
    // is said on the toggle rather than as a margin on the badge because the
    // empty state has no badge to hang it off — see the rule.
    if (dirty.size) modeToggle.setAttribute('data-tw-count', '');
    else modeToggle.removeAttribute('data-tw-count');

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
    modeToggle.appendChild(el('span', 'bw-label', 'Edit mode'));
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
    deleteHandle.innerHTML = ICONS.close;
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
    // of them as unset. The arrows step off the pixel count either way, so a
    // hand-written p-2.5 counts up from the 10 it renders.
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
   * What an arrow moves a length by, and what Shift moves it by.
   *
   * Padding, margin, gap, radius and stroke width are all spoken in pixels, so
   * an arrow is worth a pixel and Shift is worth ten of them — each field
   * counts in the unit it prints. They used to walk the ladder underneath
   * instead, which made the arrows the one control here whose presses were
   * unevenly sized: 6 to 8 was a press and 64 to 80 was a press, on a field
   * showing pixels either way, so what a press was worth could only be learnt
   * by pressing it.
   *
   * The ladder has not gone anywhere. A step writes the rung where one lands
   * and an arbitrary value where none does — exactly what typing the same
   * number does, so the two ways into a field agree — and the rungs
   * themselves are what the chevron beside it opens. Stroke width has no
   * chevron and now has no ladder in its arrows either, which costs it
   * nothing: 0, 1, 2, 4 and 8 are all inside eight presses of each other.
   */
  var LENGTH_STEP = 1;
  var LENGTH_LEAP = 10;

  /**
   * Where a press lands, or null for "take the class off".
   *
   * A leap that would go under zero stops at zero rather than dropping the
   * class: ten below the bottom is still a number the field can show, and
   * losing the class outright is not what holding Shift asked for. Pressing
   * down again on a zero the element owns is what drops it — the one way
   * back to an inherited value, or to a clean class string.
   */
  function stepLength(from, dir, leap) {
    var next = from + dir * (leap ? LENGTH_LEAP : LENGTH_STEP);
    if (next >= 0) return next;
    return from > 0 ? 0 : null;
  }

  /**
   * The pixel count a press counts from: the number the field is showing where
   * that number is pixels, and what the element renders where it is not.
   *
   * A field can be showing `1.5rem` — a literal in a unit it has to keep, or it
   * says nothing — and parseFloat off that is 1.5, which stepped a 24px padding
   * to 2.5px. The rendered value is the same length said in the unit the arrows
   * count in. A comma pair says its first number first, which is the one the
   * press is against, so the match stops at the comma rather than reading past
   * it.
   */
  function stepFrom(shown, rendered) {
    var m = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*(?:,|$)/.exec(shown == null ? '' : String(shown));
    return m ? Number(m[1]) : (rendered || 0);
  }

  /**
   * A step is the panel writing the value, not the typist typing it.
   *
   * Every readout leaves a focused field alone so refresh() cannot rewrite a
   * word mid-typing — and that guard was also swallowing the marking a step had
   * just earned: an arrow that took a value off the ladder left the snowflake
   * and the italic behind until the field was blurred, so 17 sat there looking
   * like a rung. `stepping` says who wrote it, and the readouts are let through
   * for the one case where the answer is "the panel". Each stepper used to put
   * its new value in by hand for the same reason; letting the readout run is
   * that, and the marking, and the placeholder, in one.
   */
  var stepping = false;
  function withStep(fn) {
    stepping = true;
    try { fn(); } finally { stepping = false; }
  }
  function typing(input) {
    return !stepping && document.activeElement === input;
  }

  /**
   * Step a spacing field by a pixel, or by ten with Shift held.
   *
   * `shown` is the field's own text, because the field is what is on screen:
   * an axis whose two edges disagree says `0, 8` and has no class of its own
   * to read, and a value typed and not yet committed is the one the arrow is
   * being pressed against. parseFloat takes the first number of a pair, which
   * is the first thing the field says — the rule the radius box already
   * steps by. Where it says nothing at all, the step comes off what the side
   * renders today.
   */
  function stepSpacing(prefix, side, dir, leap, shown) {
    if (!selected) return;
    var state = readSpacing(selected, prefix, side);
    var here = stepFrom(shown, computedSpacing(selected, prefix, side));

    var next = stepLength(here, dir, leap);
    if (next === null) {
      // Below zero the class comes off rather than pinning a 0 the element
      // never asked for, which is the only way back to an inherited (or clean)
      // class string. Nothing of its own to take off means nothing to do.
      if (state.source !== 'explicit') return;
      stripFamily(selected, familyRe(prefix, side));
      markDirty(selected, 'classes');
      refresh();
      return;
    }
    setSpacing(prefix, side, suffixForPx(next));
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
  var SEGHOVER = '#2a2a2a'; // a segment under the cursor, one step under it
  var FOCUS = '#fe5000';  // the field you are working in — BRAND, worn as a ring
  // A literal value reads a shade back from a token: still legible, but not
  // claiming the same standing as something on the scale.
  var LITERAL = '#b4b4b4';
  var EDGE = '#333333';     // the hairline around a dropdown, from the frame
  // The accent, and the only saturated colour the panel owns: the selection
  // outline on the page and a pressed control in the panel. FOCUS is the same
  // value under another name because the two are the same signal in two places.
  var BRAND = '#fe5000';
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
    padHz: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><rect x=\"14.5\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/><rect x=\"4\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-padding-vt.svg
    padVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-padding-top.svg
    padTop: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-padding-right.svg
    padRight: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><rect x=\"14.5\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-padding-bottom.svg
    padBottom: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-padding-left.svg
    padLeft: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><rect x=\"4\" y=\"4\" width=\"1.5\" height=\"12\" rx=\"0.75\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-padding-hzvt.svg
    padHzVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-padding-parts.svg
    padParts: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M14.5 6.75C14.5 6.33579 14.8358 6 15.25 6C15.6642 6 16 6.33579 16 6.75V13.25C16 13.6642 15.6642 14 15.25 14C14.8358 14 14.5 13.6642 14.5 13.25V6.75Z\" fill=\"#AAAAAA\"/><path d=\"M4 6.75C4 6.33579 4.33579 6 4.75 6C5.16421 6 5.5 6.33579 5.5 6.75V13.25C5.5 13.6642 5.16421 14 4.75 14C4.33579 14 4 13.6642 4 13.25V6.75Z\" fill=\"#AAAAAA\"/><path d=\"M13.25 4C13.6642 4 14 4.33579 14 4.75C14 5.16421 13.6642 5.5 13.25 5.5L6.75 5.5C6.33579 5.5 6 5.16421 6 4.75C6 4.33579 6.33579 4 6.75 4L13.25 4Z\" fill=\"#AAAAAA\"/><path d=\"M13.25 14.5C13.6642 14.5 14 14.8358 14 15.25C14 15.6642 13.6642 16 13.25 16L6.75 16C6.33579 16 6 15.6642 6 15.25C6 14.8358 6.33579 14.5 6.75 14.5L13.25 14.5Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-hz.svg
    marHz: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M1.25 4.75C1.25 4.33579 1.58579 4 2 4C2.41421 4 2.75 4.33579 2.75 4.75V15.25C2.75 15.6642 2.41421 16 2 16C1.58579 16 1.25 15.6642 1.25 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M17.25 4.75C17.25 4.33579 17.5858 4 18 4C18.4142 4 18.75 4.33579 18.75 4.75V15.25C18.75 15.6642 18.4142 16 18 16C17.5858 16 17.25 15.6642 17.25 15.25V4.75Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-vt.svg
    marVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 1.25C15.6642 1.25 16 1.58579 16 2C16 2.41421 15.6642 2.75 15.25 2.75L4.75 2.75C4.33579 2.75 4 2.41421 4 2C4 1.58579 4.33579 1.25 4.75 1.25L15.25 1.25Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 17.25C15.6642 17.25 16 17.5858 16 18C16 18.4142 15.6642 18.75 15.25 18.75L4.75 18.75C4.33579 18.75 4 18.4142 4 18C4 17.5858 4.33579 17.25 4.75 17.25L15.25 17.25Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-top.svg
    marTop: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 1.25C15.6642 1.25 16 1.58579 16 2C16 2.41421 15.6642 2.75 15.25 2.75L4.75 2.75C4.33579 2.75 4 2.41421 4 2C4 1.58579 4.33579 1.25 4.75 1.25L15.25 1.25Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-right.svg
    marRight: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M17.25 4.75C17.25 4.33579 17.5858 4 18 4C18.4142 4 18.75 4.33579 18.75 4.75V15.25C18.75 15.6642 18.4142 16 18 16C17.5858 16 17.25 15.6642 17.25 15.25V4.75Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-bottom.svg
    marBottom: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 17.25C15.6642 17.25 16 17.5858 16 18C16 18.4142 15.6642 18.75 15.25 18.75L4.75 18.75C4.33579 18.75 4 18.4142 4 18C4 17.5858 4.33579 17.25 4.75 17.25L15.25 17.25Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-left.svg
    marLeft: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M1.25 4.75C1.25 4.33579 1.58579 4 2 4C2.41421 4 2.75 4.33579 2.75 4.75V15.25C2.75 15.6642 2.41421 16 2 16C1.58579 16 1.25 15.6642 1.25 15.25V4.75Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-margin-hzvt.svg
    marHzVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#AAAAAA\" stroke-width=\"1.5\"/></svg>",
    // assets/ic-margin-parts.svg
    marParts: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M14.5 4.75C14.5 4.33579 14.8358 4 15.25 4C15.6642 4 16 4.33579 16 4.75V15.25C16 15.6642 15.6642 16 15.25 16C14.8358 16 14.5 15.6642 14.5 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M4 4.75C4 4.33579 4.33579 4 4.75 4C5.16421 4 5.5 4.33579 5.5 4.75V15.25C5.5 15.6642 5.16421 16 4.75 16C4.33579 16 4 15.6642 4 15.25V4.75Z\" fill=\"#505050\"/><path d=\"M15.25 14.5C15.6642 14.5 16 14.8358 16 15.25C16 15.6642 15.6642 16 15.25 16L4.75 16C4.33579 16 4 15.6642 4 15.25C4 14.8358 4.33579 14.5 4.75 14.5L15.25 14.5Z\" fill=\"#505050\"/><path d=\"M15.25 4C15.6642 4 16 4.33579 16 4.75C16 5.16421 15.6642 5.5 15.25 5.5L4.75 5.5C4.33579 5.5 4 5.16421 4 4.75C4 4.33579 4.33579 4 4.75 4L15.25 4Z\" fill=\"#505050\"/><path d=\"M15.25 1.25C15.6642 1.25 16 1.58579 16 2C16 2.41421 15.6642 2.75 15.25 2.75L4.75 2.75C4.33579 2.75 4 2.41421 4 2C4 1.58579 4.33579 1.25 4.75 1.25L15.25 1.25Z\" fill=\"#AAAAAA\"/><path d=\"M15.25 17.25C15.6642 17.25 16 17.5858 16 18C16 18.4142 15.6642 18.75 15.25 18.75L4.75 18.75C4.33579 18.75 4 18.4142 4 18C4 17.5858 4.33579 17.25 4.75 17.25L15.25 17.25Z\" fill=\"#AAAAAA\"/><path d=\"M1.25 4.75C1.25 4.33579 1.58579 4 2 4C2.41421 4 2.75 4.33579 2.75 4.75V15.25C2.75 15.6642 2.41421 16 2 16C1.58579 16 1.25 15.6642 1.25 15.25V4.75Z\" fill=\"#AAAAAA\"/><path d=\"M17.25 4.75C17.25 4.33579 17.5858 4 18 4C18.4142 4 18.75 4.33579 18.75 4.75V15.25C18.75 15.6642 18.4142 16 18 16C17.5858 16 17.25 15.6642 17.25 15.25V4.75Z\" fill=\"#AAAAAA\"/></svg>",
    // The radius marks, frame 2:270. Four corner brackets; the one the field
    // owns is lit and the other three step back to #505050, which is how the
    // export draws "this corner, not those". The all-corners mark carries the
    // box as well as the four lit corners, and Parts is the same four without
    // it — the folded state and the open one, exactly as padding and margin
    // read.
    // assets/ic-radius-all.svg
    radAll: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_18_894)\"><rect x=\"2\" y=\"2\" width=\"16\" height=\"16\" rx=\"2\" stroke=\"#505050\" stroke-width=\"1.5\"/><path d=\"M5 2H4C2.89543 2 2 2.89543 2 4V6\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 2H16C17.1046 2 18 2.89543 18 4V6\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M5 18H4C2.89543 18 2 17.1046 2 16V14\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 18H16C17.1046 18 18 17.1046 18 16V14\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></g><defs><clipPath id=\"clip0_18_894\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-radius-tl.svg
    radTl: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_19_954)\"><path d=\"M5 2H4C2.89543 2 2 2.89543 2 4V6\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 2H16C17.1046 2 18 2.89543 18 4V6\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M5 18H4C2.89543 18 2 17.1046 2 16V14\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 18H16C17.1046 18 18 17.1046 18 16V14\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></g><defs><clipPath id=\"clip0_19_954\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-radius-tr.svg
    radTr: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_19_979)\"><path d=\"M5 2H4C2.89543 2 2 2.89543 2 4V6\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 2H16C17.1046 2 18 2.89543 18 4V6\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M5 18H4C2.89543 18 2 17.1046 2 16V14\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 18H16C17.1046 18 18 17.1046 18 16V14\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></g><defs><clipPath id=\"clip0_19_979\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-radius-bl.svg
    radBl: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_19_993)\"><path d=\"M5 2H4C2.89543 2 2 2.89543 2 4V6\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 2H16C17.1046 2 18 2.89543 18 4V6\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M5 18H4C2.89543 18 2 17.1046 2 16V14\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 18H16C17.1046 18 18 17.1046 18 16V14\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></g><defs><clipPath id=\"clip0_19_993\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-radius-br.svg
    radBr: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_19_986)\"><path d=\"M5 2H4C2.89543 2 2 2.89543 2 4V6\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 2H16C17.1046 2 18 2.89543 18 4V6\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M5 18H4C2.89543 18 2 17.1046 2 16V14\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 18H16C17.1046 18 18 17.1046 18 16V14\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></g><defs><clipPath id=\"clip0_19_986\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // assets/ic-radius-parts.svg
    radParts: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_19_971)\"><path d=\"M5 2H4C2.89543 2 2 2.89543 2 4V6\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 2H16C17.1046 2 18 2.89543 18 4V6\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M5 18H4C2.89543 18 2 17.1046 2 16V14\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15 18H16C17.1046 18 18 17.1046 18 16V14\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></g><defs><clipPath id=\"clip0_19_971\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
    // Toggle glyphs: a box inside a box is "one padding all round"; adding the
    // two outer rules is "each edge on its own". The button shows the mode it
    // is currently in, so the icon and the fields below it always agree.
    up: '<svg width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.2 4.4 3.5 2.1l2.3 2.3"/></svg>',
    down: '<svg width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.2 2.6 3.5 4.9l2.3-2.3"/></svg>',
    weight: glyph('<path d="M2.2 9.8 5.2 2.2h1.6l3 7.6" stroke-width="1.6"/><path d="M3.6 7.4h4.8" stroke-width="1.6"/>'),
    font: glyph('<path d="M2 3.2V2.1h8v1.1M6 2.4v7.5M4.3 9.9h3.4"/>'),
    // assets/ic-plus.svg
    plus: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g id=\"Frame\"><path id=\"Vector\" d=\"M4.16667 10H15.8333\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path id=\"Vector_2\" d=\"M10 4.16667V15.8333\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g></svg>",
    // The export's own files, inlined verbatim like every other icon here: 20
    // on the frame's grid, #AAAAAA at 1.5, which is the dismiss ×'s hand. The
    // 13px currentColor pair they replaced was drawn back when assets/ had no
    // file for them.
    undo: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M7.50004 11.6666L3.33337 7.49992L7.50004 3.33325\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M3.33337 7.5H12.0834C12.6853 7.5 13.2813 7.61855 13.8373 7.84889C14.3934 8.07922 14.8987 8.41683 15.3243 8.84243C15.7499 9.26803 16.0875 9.77329 16.3178 10.3294C16.5482 10.8854 16.6667 11.4814 16.6667 12.0833C16.6667 12.6852 16.5482 13.2812 16.3178 13.8373C16.0875 14.3934 15.7499 14.8986 15.3243 15.3242C14.8987 15.7498 14.3934 16.0874 13.8373 16.3178C13.2813 16.5481 12.6853 16.6667 12.0834 16.6667H9.16671\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    redo: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12.5 11.6666L16.6667 7.49992L12.5 3.33325\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M16.6667 7.5H7.91671C6.70113 7.5 5.53534 7.98289 4.6758 8.84243C3.81626 9.70197 3.33337 10.8678 3.33337 12.0833C3.33337 12.6852 3.45193 13.2812 3.68226 13.8373C3.91259 14.3934 4.2502 14.8986 4.6758 15.3242C5.53534 16.1838 6.70113 16.6667 7.91671 16.6667H10.8334\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
    // The export has a file for each gap axis, so the hand-drawn trio these
    // replaced is gone: two bars apart across, two bars apart down. Inlined
    // verbatim, keeping their own #AAAAAA at 1.5 like every other asset here.
    // There is no third file for the single gap and it does not need one — a
    // lone `gap-4` and an explicit `gap-x-*` are never on screen together, so
    // the horizontal mark stands for both without ever being ambiguous.
    gapHz: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M2.5 2H3.5C4.32843 2 5 2.67157 5 3.5V16.5C5 17.3284 4.32843 18 3.5 18H2.5\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M17.5 2H16.5C15.6716 2 15 2.67157 15 3.5V16.5C15 17.3284 15.6716 18 16.5 18H17.5\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M9 4.75C9 4.33579 9.33579 4 9.75 4C10.1642 4 10.5 4.33579 10.5 4.75V15.25C10.5 15.6642 10.1642 16 9.75 16C9.33579 16 9 15.6642 9 15.25V4.75Z\" fill=\"#AAAAAA\"/></svg>",
    gapVt: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M18 2.5L18 3.5C18 4.32843 17.3284 5 16.5 5L3.5 5C2.67157 5 2 4.32843 2 3.5L2 2.5\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M18 17.5L18 16.5C18 15.6716 17.3284 15 16.5 15L3.5 15C2.67157 15 2 15.6716 2 16.5L2 17.5\" stroke=\"#505050\" stroke-width=\"1.5\" stroke-linecap=\"round\"/><path d=\"M15.25 9C15.6642 9 16 9.33579 16 9.75C16 10.1642 15.6642 10.5 15.25 10.5L4.75 10.5C4.33579 10.5 4 10.1642 4 9.75C4 9.33579 4.33579 9 4.75 9L15.25 9Z\" fill=\"#AAAAAA\"/></svg>",
    // assets/ic-minus.svg — the + with its upright taken off, which is what
    // the export draws: the same 20 grid, the same #AAAAAA at 1.5, the same
    // `M4.16667 10H15.8333` the plus leads with. The two share a tile and a
    // column, so they had to share a hand as well.
    minus: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g id=\"Frame\"><path id=\"Vector\" d=\"M4.16667 10H15.8333\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g></svg>",
    // assets/ic-unlink.svg. Frame 7:620 puts the real file in the colour field
    // at 20 on the frame's grid; the 12px currentColor glyph it replaced was
    // drawn back when the export had no file for it.
    unlink: "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g id=\"Frame\" clip-path=\"url(#clip0_0_4)\"><path id=\"Vector\" d=\"M15.7 10.2083L17.1333 8.78333H17.1167C17.8839 7.98837 18.3042 6.92144 18.2855 5.81681C18.2667 4.71218 17.8104 3.66014 17.0167 2.89167C16.2391 2.14183 15.201 1.72282 14.1208 1.72282C13.0406 1.72282 12.0025 2.14183 11.225 2.89167L9.79167 4.31667\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path id=\"Vector_2\" d=\"M4.30833 9.79167L2.88333 11.2167C2.11614 12.0116 1.69577 13.0786 1.71452 14.1832C1.73327 15.2878 2.1896 16.3399 2.98333 17.1083C3.76088 17.8582 4.79897 18.2772 5.87917 18.2772C6.95937 18.2772 7.99746 17.8582 8.775 17.1083L10.2 15.6833\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path id=\"Vector_3\" d=\"M6.66667 1.66667V4.16667\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path id=\"Vector_4\" d=\"M1.66667 6.66667H4.16667\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path id=\"Vector_5\" d=\"M13.3333 15.8333V18.3333\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path id=\"Vector_6\" d=\"M15.8333 13.3333H18.3333\" stroke=\"#AAAAAA\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><defs><clipPath id=\"clip0_0_4\"><rect width=\"20\" height=\"20\" fill=\"white\"/></clipPath></defs></svg>",
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
  function handles(sel) {
    return P + ' .bw-h' + sel + ',' + P + ' .bw-foot' + sel + ',' + P + ' .bw-tabs' + sel +
      ',' + P + ' .bw-idle' + sel;
  }

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

      /* tabs — under the header, and a drag handle like every other piece of
         chrome. Both tabs are about the selected element, so the strip folds
         away with the selection exactly as the header does, and .bw-idle takes
         its place. */
      // The chip stands off the rule below it by the same 20 it stands off the
      // edge beside it: 20 + a 28px chip + 20 + the hairline, which is inside
      // the border-box. Squared up rather than centred in a fixed 41, where the
      // 6px left under the chip read as a different measurement from the
      // gutter it sat in.
      // The hairline is EDGE, like every rule between rows in the body — the
      // panel has one colour for "a line between two things".
      // No padding at the top: the 60px header already puts 19px under the
      // title it centres, and adding 20 to that made a 39px void between the
      // title and the tabs where everything else in the panel sits 20 apart.
      // The 20 below stays, so the tabs stand off their own rule the way a row
      // stands off a divider.
      P + ' .bw-tabs{flex:0 0 auto;display:flex;align-items:center;height:49px;',
      '  padding:0 20px 20px;gap:4px;border-bottom:1px solid ' + EDGE + ';',
      '  background:var(--bw-bg)}',
      // A segmented control, not underlined text: the selected tab is a raised
      // chip and the other is plain, which reads as "these two are one switch"
      // rather than as two links with a rule under one of them.
      P + ' .bw-tab{flex:0 0 auto;height:28px;padding:0 12px;border-radius:6px;',
      '  font:400 13px/1 ' + UI_FONT + ';color:var(--bw-muted);display:flex;align-items:center}',
      P + ' .bw-tab:hover{color:var(--bw-fg)}',
      P + ' .bw-tab[aria-selected="true"]{color:var(--bw-fg);background:' + RAISED + '}',
      P + ' .bw-tab .bw-dot{width:5px;height:5px;border-radius:50%;background:var(--bw-brand);',
      '  margin-left:6px;flex:0 0 auto}',
      // Stands where the tabs do, and says the one thing that is true then.
      P + ' .bw-idle{flex:0 0 auto;display:flex;align-items:center;height:41px;padding:0 20px;',
      '  font:400 13px/1 ' + UI_FONT + ';color:var(--bw-muted)}',


      /* prompt tab */
      P + ' .bw-prompt{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}',
      // Where the turn will land, said before it is sent rather than after.
      // The same line as the editor's header, because it names the same thing.
      P + ' .bw-pctx{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:40px;',
      '  padding:0 20px;font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted);',
      '  word-break:break-word}',
      P + ' .bw-pctx-note{font-size:12px;color:var(--bw-faint)}',
      // No min-height and hidden while empty: the log is under the composer
      // now, so an empty one would be a blank panel-width gap below the field
      // rather than the space above it it used to fill.
      // 20 above the first message and 20 below the last, which is the whole
      // reason the bottom is 0: the composer's own 20px top padding is what
      // stands under the transcript, and a padding here would have been added
      // to it. Measured 15 above against 34 below before that.
      //
      // No top border either. The tab strip's rule already divides this from
      // the tabs, and with an empty context line above it the two sat on top
      // of each other.
      P + ' .bw-plog{flex:1 1 auto;min-height:0;max-height:280px;overflow-y:auto;',
      '  padding:20px 20px 0;display:flex;flex-direction:column;gap:12px;user-select:text}',
      P + ' .bw-plog:empty{display:none}',
      P + ' .bw-pmsg{font:400 13px/1.45 ' + UI_FONT + ';color:var(--bw-fg);',
      '  word-break:break-word;white-space:pre-wrap}',
      // A turn is read the way the terminal reads it: what you said is a box,
      // and what came back is a timeline beside it. Two shapes rather than two
      // colours, because the transcript is one column of the same 13px text
      // and a label on each line would cost more room than either says.
      //
      // The box is the composer's own — 8px and its 10/12 padding, so a sent
      // message stands where it was typed — but bordered rather than filled:
      // #232323 is what a field wears, and this one can no longer be typed in.
      P + ' .bw-pmsg.is-me{padding:10px 12px;border:1px solid ' + EDGE + ';border-radius:8px}',
      // Everything that comes back is a rail entry: a dot at the gutter and
      // the text 20px in, which is the panel's own gutter measured again.
      P + ' .bw-pmsg.is-rail{position:relative;padding-left:20px}',
      P + ' .bw-pmsg.is-rail::before{content:"";position:absolute;left:0;top:7px;',
      '  width:5px;height:5px;border-radius:50%;background:var(--bw-muted)}',
      // The line joins one dot to the next and stops there — it is drawn by
      // the entry above, running from under its own dot to 12px below itself,
      // which is exactly the log's gap. EDGE like every other hairline here.
      P + ' .bw-pmsg.is-run::after{content:"";position:absolute;left:2px;top:14px;',
      '  bottom:-12px;width:1px;background:' + EDGE + '}',
      // Tool calls are named, not narrated: enough to show a long turn is alive.
      P + ' .bw-pmsg.is-tool{color:var(--bw-muted);font-size:12px;font-style:italic}',
      P + ' .bw-pmsg.is-err{color:var(--bw-danger)}',
      P + ' .bw-pmsg.is-err::before{background:var(--bw-danger)}',
      // 20 all round, the panel's own gutter. The composer is the whole of it
      // now — Send stands in the footer bar with Save — so the gap below is
      // what separates the field from that bar.
      P + ' .bw-pform{flex:0 0 auto;padding:20px;display:flex;flex-direction:column;gap:8px}',
      P + ' .bw-pinput{height:120px;padding:10px 12px;display:block;background:var(--bw-sunken);',
      '  border:0;border-radius:8px;font:400 14px/1.4 ' + UI_FONT + ';color:var(--bw-fg);',
      '  resize:none;overflow-y:auto;user-select:text}',
      P + ' .bw-pinput::placeholder{color:var(--bw-muted)}',
      P + ' .bw-pinput:focus{outline:1px solid ' + FOCUS + ';outline-offset:-1px}',
      P + ' .bw-prow{display:flex;align-items:center;gap:8px}',
      P + ' .bw-phint{flex:1;min-width:0;font:11px/1.35 ' + UI_FONT + ';color:var(--bw-faint)}',
      P + ' .bw-phint.is-err{color:var(--bw-danger)}',

      /* header */
      // Shorter, and no rule under it: the tab strip above already draws the
      // panel's one horizontal line, and a second right below it boxed the
      // element's name into a bar of its own.
      // The same header a dropdown has, to the pixel: it names the thing you
      // are looking at and offers the way out of it, which is the same job.
      // The dropdown header's size, but no rule under it: there the rule is the
      // panel's only horizontal line, here the tab strip directly below draws
      // one already and two of them 41px apart boxed the name into a bar.
      P + ' .bw-h{display:flex;align-items:center;gap:6px;height:60px;',
      '  padding:0 10px 0 20px;flex:0 0 auto}',
      P + ' .bw-h strong{flex:1;font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted)}',
      // 40x40 with an 8px radius, transparent by default and #232323 on hover
      // — the two states the design ships, and the ic-x asset inside them.
      both(' .bw-x') + '{width:40px;height:40px;border-radius:8px;flex:0 0 auto;',
      '  background:transparent;display:flex;align-items:center;justify-content:center}',
      both(' .bw-x:hover') + '{background:var(--bw-sunken)}',
      both(' .bw-x svg') + '{display:block}',

      /* body */
      // overflow-x:hidden so a divider can run the full width of the panel:
      // it is drawn 20px outside its row on both sides, and overflow-y:auto
      // alone computes overflow-x to auto and hangs a scrollbar off that.
      P + ' .bw-body{padding:20px;display:flex;flex-direction:column;gap:20px;',
      '  overflow-x:hidden;overflow-y:auto}',
      // The frame's hairlines, edge to edge and centred in the 20px between
      // two rows. Each row carries its own so the line travels with it; which
      // row goes without one is decided in markDividers, because :first-child
      // cannot see that the rows above it are display:none.
      //
      // EDGE, not the frame's #232323: that is the same value as a field's
      // background, so every line that ran past a field disappeared into it
      // and the rule only showed in the gaps. #333333 is the panel's other
      // hairline — the one around a dropdown — so this is a colour the design
      // already uses for exactly this job rather than an invented shade.
      P + ' .bw-body > *{position:relative}',
      P + ' .bw-body > .has-rule::before{content:"";position:absolute;',
      '  left:-20px;right:-20px;top:-10px;height:1px;background:' + EDGE + '}',
      // 20px of air on both sides of every line, which is what the frame
      // measures — 167 to a Padding label at 186.5, 280 to a Margin one at
      // 299.5. A reveal row gets there on its own: its label is 15px centred
      // in a 40px box, so half the room is already inside it. An open row
      // starts at its label, with nothing above it but the 10px half-gap, so
      // it buys the other 10 as margin. Margin and not padding, because the
      // row box is measured to the pixel in three suites and this is space
      // around a row, not part of one.
      P + ' .bw-body > *:not(.bw-reveal):not(.bw-rm){margin:10px 0}',
      // The first row on screen has no line above it to stand off from, and
      // the last has the footer. has-rule already names the first — every
      // visible row carries one except that one — and is-last is set beside it.
      P + ' .bw-body > *:not(.bw-reveal):not(.bw-rm):not(.has-rule){margin-top:0}',
      P + ' .bw-body > *:not(.bw-reveal):not(.bw-rm).is-last{margin-bottom:0}',
      // top is measured from the border box, so a row that stands 10px off its
      // own line needs its line drawn 10px further away.
      P + ' .bw-body > .has-rule:not(.bw-reveal)::before{top:-20px}',
      // Edit mode is off until it is asked for, so the toggle is the only part
      // of the editor a visiting page shows by default.
      // box-sizing explicitly, because this one lives on the HOST page rather
      // than inside the panel: a project with a preflight makes it border-box
      // and one without leaves it content-box, and the width measured below
      // would then be 23px out on half the pages it lands on.
      //
      T + '{position:fixed;bottom:16px;right:16px;z-index:2147483646;display:flex;',
      '  box-sizing:border-box;',
      '  align-items:center;gap:7px;padding:7px 12px;border-radius:999px;',
      '  font:600 12px/1 ' + UI_FONT + ';cursor:pointer;border:1px solid var(--bw-border);',
      '  background:var(--bw-card);color:var(--bw-fg);box-shadow:0 2px 10px rgba(0,0,0,.16)}',
      T + '[aria-pressed="true"]{background:' + BRAND + ';border-color:' + BRAND + ';color:#fff}',
      // A badge sits in the same 7px its own top and bottom stand in, so the
      // three sides it touches are one measurement rather than 7, 7 and 12.
      // The label keeps the 12: it is text on the pill's gutter, where the
      // badge is an object inside it, and a 7px lead would put the word hard
      // against the curve. With nothing to inset, the pill goes back to 12 on
      // both sides — a bare word off-centre in its own pill.
      T + '[data-tw-count]{padding-right:7px}',
      // The label takes the slack so the badge is pinned to the right edge
      // rather than pushed there by the word ahead of it. text-align comes
      // with the flex:1, because this is a <button> and a button centres its
      // text — invisible while the span is its own width, plain the moment it
      // owns the row.
      T + ' .bw-label{flex:1;text-align:left}',
      // min-width holds one digit's worth of room even while the badge is
      // empty, which is the slot the toggle's width is reserved against.
      //
      // 1ch IS that digit: the face is monospace, so a character's advance is
      // the measurement rather than a number guessed off a screenshot. The
      // +12px is the padding, which has to be in the total because the host
      // page's preflight puts box-sizing:border-box on everything — a bare
      // min-width under 12px is simply ignored, which is how the first attempt
      // at this changed nothing at all. 1 to 9 changes never move it; ten
      // would, and no session here has come close.
      // box-sizing and min-height together are what hold the pill at ONE
      // height. The badge's line box is the tallest thing in the row, so its
      // presence is the difference between 33px and 28px — and an empty
      // element has no line box to contribute. Asking for the height here
      // covers both states from one rule: the filled badge already stands at
      // exactly this, and the empty one is brought up to it.
      //
      // The +2px is the padding, and box-sizing is declared rather than
      // inherited because this button lives on the host page: min-height means
      // the border box under a preflight and the content box without one, and
      // the difference is the 2px that left it 31px instead of 33px.
      T + ' .bw-count{box-sizing:border-box;min-height:calc(1.5em + 2px);',
      '  display:flex;align-items:center;justify-content:center;',
      '  min-width:calc(1ch + 12px);text-align:center;padding:1px 6px;',
      '  border-radius:999px;font:600 10px/1.5 ' + UI_MONO + ';',
      '  background:' + BRAND + ';color:#fff}',
      T + '[aria-pressed="true"] .bw-count{background:rgba(255,255,255,.28)}',
      // Nothing to say: no width, no side padding, and a negative margin
      // cancelling the row's 7px gap exactly — `gap` cannot be waived per item.
      //
      // min-height is what keeps the pill one height. The badge's line box is
      // what makes it 33px tall rather than 28, and an EMPTY element has no
      // line box at all — there is no text in it to generate one — so the
      // height has to be asked for outright. 1.5em is that line box: the same
      // 1.5 the font shorthand above sets, against the same 10px, so it tracks
      // the badge instead of being a number copied off a screenshot.
      T + ' .bw-count.is-empty{width:0;min-width:0;padding:1px 0;margin-left:-7px;',
      '  overflow:hidden;background:transparent}',
      // A ring around the viewport while edit mode is on: the page's own links
      // and buttons are being swallowed, which is worth saying out loud.
      '[data-tw-editor="ring"]{position:fixed;inset:0;z-index:2147483645;pointer-events:none;',
      '  display:none;box-shadow:inset 0 0 0 2px rgba(254,80,0,.55)}',
      // The floating delete handle and the ghost it leaves behind. Both live on
      // page elements rather than an editor surface, so they carry their own
      // colours instead of the panel's tokens, and both shout — !important —
      // because whatever the page styles that element with has to lose.
      //
      // The handle wears the selection's own colour, because it belongs to the
      // selection: it is drawn on the outline BRAND paints and nowhere else, so
      // a second hue there read as a second thing on screen rather than as this
      // element's own control. Red said "danger" at rest, and the pending
      // removal it leads to already says that — in REMOVE_OUTLINE, on the
      // ghost, and in the panel's notice, all of them after the click.
      //
      // No white ring either. It was there to hold the disc off whatever it
      // was floating over; against a border it is now the same colour as, it
      // drew a gap where the two should meet. The shadow alone lifts it.
      D + '{position:fixed;z-index:2147483646;width:20px;height:20px;display:none;',
      '  align-items:center;justify-content:center;padding:0;border:0;border-radius:999px;',
      '  background:' + BRAND + ';color:#fff;cursor:pointer;',
      '  box-shadow:0 1px 4px rgba(0,0,0,.35)}',
      D + ':hover{background:#d84400}',
      // The export's × — the same file the panel's dismiss wears, inlined
      // verbatim like every other icon. Its #AAA is the one thing overridden,
      // and only here: that grey is drawn for the panel's #171717 surface and
      // goes muddy on the brand fill, where white is what reads.
      //
      // Drawn at 14 rather than its own 20. The dismiss × has a 40px tile to
      // sit in and the disc here is 20, so the mark at full size ran corner to
      // corner and left no field around it — the file is scaled, not redrawn,
      // so the stroke thins with it and the cross keeps the asset's shape.
      D + ' svg{display:block;width:14px;height:14px}',
      D + ' svg path{stroke:#fff}',
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
      // Bare, like the close button: the notice is already a box, and a second
      // filled box inside it reads as a second thing to look at. It lights from
      // label grey to value white under the cursor, the move every row makes.
      // 5px above and below puts its 13px line on the same centre as the 15px
      // heading beside it, and no padding at the sides keeps it flush to the
      // notice's own 14px gutter.
      P + ' .bw-rm-undo{flex:0 0 auto;font:400 13px/1 ' + UI_FONT + ';color:var(--bw-muted);',
      '  border:0;border-radius:8px;padding:5px 0;background:none;cursor:pointer}',
      P + ' .bw-rm-undo:hover{color:var(--bw-fg)}',
      // Label above field, as the frame has it — not beside it. The label is
      // the same 15px as the value it names, only greyer.
      // Label above field, as the frame has it — not beside it. Wrapping rather
      // than a nested container: the label claims a full line, so everything
      // after it falls to the next one and lays out as a row. 8px down to the
      // controls, 12px between them — both straight off the frame.
      P + ' .bw-row{display:flex;flex-wrap:wrap;align-items:center;row-gap:8px;column-gap:12px}',
      P + ' .bw-row.top{align-items:flex-start}',
      P + ' .bw-lbl{flex:0 0 100%;font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted)}',
      // Under the cursor a row's label steps up to the colour its values are
      // set in — the same move the tab strip makes, and the only one available
      // here: a label sits on the panel's own surface, so it cannot take the
      // #2b2b2b fill a tile does. The whole row is the target, because the
      // whole row is what the cursor is over.
      P + ' .bw-row:hover .bw-lbl{color:var(--bw-fg)}',

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
      P + ' .bw-field:focus-within,',
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
      P + ' .bw-chev{position:absolute;right:12px;top:50%;margin:0;',
      '  transform:translateY(-50%);display:flex;align-items:center}',
      // The mark is 8x5, which is a target you have to aim at. The button is
      // the full height of the field and reaches 36px in from its edge; the
      // chevron is held at the same 12px by the padding rather than by being
      // centred, so the hit area grows and nothing moves. The other fields
      // already open from anywhere on the field, so this is the one that needed
      // it.
      P + ' .bw-open{position:absolute;right:0;top:0;height:100%;width:36px;margin:0;',
      '  padding:0 12px 0 0;display:flex;align-items:center;justify-content:flex-end}',
      P + ' .bw-open svg,' + P + ' .bw-chev svg{display:block}',
      P + ' .bw-field > .bw-snow{margin-right:12px}',
      // The note sits before the snowflake, so its own 12px is the gap between
      // the two and the snowflake's is the gap to the edge. With no snowflake
      // showing, the note inherits that gutter instead.
      P + ' .bw-field > .bw-unit{margin-right:12px}',
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
      // Typography's row is the one with no toggle at the end of it, so its
      // stack would run the panel's full 312 where every other section's stops
      // at 270 — a family field a tile wider than the Padding above it, and a
      // weight/size pair of 150px columns standing beside their 129. The
      // gutter is reserved instead of earned: 42 is the 12px between a stack
      // and a tile plus the 30px a tile takes off the flex line, which is its
      // 40 less the 10 it hangs into the panel's own gutter. Same arithmetic
      // as the toggle's negative margin, read from the other side.
      P + ' .bw-stack.is-inset{margin-right:42px}',
      // The frame puts this at the end of the padding row as a 40x40 tile.
      //
      // It hangs 10px into the panel's gutter, which is where the close button
      // already sits: a 20px mark centred in a 40px tile standing 10px off the
      // edge puts the MARK on the 20px gutter every field and label is set to,
      // and the tile's own hover fill 10px outside it. Flush with the gutter
      // instead — which is how this was first written — the tile lines up with
      // the fields and the mark inside it sits 10px short of everything else on
      // the right, so the + column and the x above it read as two columns.
      // The negative margin is what keeps the 12px beside it: the flex line
      // gains the 10px back, so the field grows into it rather than the gap.
      P + ' .bw-toggle{width:40px;height:40px;border-radius:8px;flex:0 0 auto;',
      '  margin-right:-10px;',
      '  background:transparent;display:flex;align-items:center;justify-content:center}',
      P + ' .bw-toggle:hover,' + P + ' .bw-toggle[aria-pressed="true"]',
      '  {background:var(--bw-sunken)}',
      P + ' .bw-seg{flex:0 0 auto;display:flex;align-items:center;gap:14px;',
      '  height:40px;padding:0 6px;border-radius:8px;background:var(--bw-sunken)}',
      // The segment is the pair's first column, not a width of its own: it
      // sits under the weight field and the two are read as one edge, so 124
      // — 6+28+14+28+14+28+6, the frame's own arithmetic — stopped 5px short
      // of a field it is plainly lined up with. A flex column stretches its
      // children across, which would give it all 270, so the column is asked
      // for by name instead. The 5px it gains goes to its gutter and not to
      // its gaps: the three tiles keep the frame's 14px rhythm and the box
      // around them widens, which is the half of this that is a container.
      P + ' .bw-stack > .bw-seg{align-self:flex-start;justify-content:center;',
      '  width:calc((100% - 12px) / 2)}',
      // And the reason the family field needs this: .bw-field carries flex:1,
      // which in a column is flex-basis:0 on the HEIGHT. It collapsed the
      // 40px field to the 15px of its own line box. The two in the pair below
      // are grid items, which ignore flex, which is why only this one broke.
      P + ' .bw-stack > .bw-field{flex:0 0 auto}',
      P + ' .bw-segbtn{width:28px;height:28px;border-radius:3px;display:flex;',
      '  align-items:center;justify-content:center}',
      // #505050 is the frame's border colour and read as one on a 28px tile —
      // the pressed segment now takes SELECTED, the same grey that marks the
      // current row in every dropdown, so "this is the one that is set" is one
      // colour across the panel rather than two.
      P + ' .bw-segbtn:hover{background:' + SEGHOVER + '}',
      // After :hover, not before. Both selectors weigh the same, so order is
      // what decides — and hovering the segment that is already set must not
      // dim it back down to the hover grey.
      P + ' .bw-segbtn[aria-pressed="true"]{background:' + SELECTED + '}',
      P + ' .bw-segbtn svg{display:block}',
      // :focus-visible, not :focus-within on the segment. Clicking a button
      // focuses it, so the container lit up on every alignment change and read
      // as "this control is open" when nothing was. The keyboard still gets a
      // ring, and it goes round the 28px button that actually has focus rather
      // than the whole 124px strip, which is the more useful of the two.
      P + ' .bw-segbtn:focus-visible{outline:1px solid ' + FOCUS + ';outline-offset:-1px}',
      // The colour and its opacity, as one line inside a stack. The stack is
      // a column and these two are side by side, so they need a row of their
      // own — and its 12px is the same 12 the pair below it uses, because it
      // is the same gutter measured twice.
      P + ' .bw-cline{display:flex;align-items:center;column-gap:12px}',
      // A field with no mark and no list: the value sits at the frame's own
      // 12px gutter instead of behind a 20px icon. The snowflake keeps the
      // right-hand slot it has everywhere else.
      P + ' .bw-field.is-plain .bw-val{padding-left:12px}',
      P + ' .bw-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      P + ' .bw-pair.is-hidden{display:none}',
      P + ' .bw-pair.is-single{grid-template-columns:1fr}',
      // A reveal row is a single 40px line: the label does NOT claim a line of
      // its own here, because there is nothing under it to label — it sits
      // beside the + the way the frame draws Margin. nowrap so a long name
      // shortens rather than pushing the + onto a second line.
      P + ' .bw-reveal{flex-wrap:nowrap;height:40px;width:100%;text-align:left}',
      P + ' .bw-reveal .bw-lbl{flex:1 1 auto;min-width:0;overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      // The tile answers for the whole row, because the whole row is what the
      // cursor is over. Without this the only hover feedback sat in the last
      // 40px of a 312px target.
      P + ' .bw-reveal:hover .bw-toggle{background:var(--bw-sunken)}',
      // align-self, because the field stretches its children and this one has a
      // fixed height: stretch leaves a 20px icon pinned to the top of a 40px
      // field. The dropdowns were already centred by their own button.
      P + ' .bw-ico{flex:0 0 auto;align-self:center;display:flex;align-items:center;',
      '  justify-content:center;width:20px;height:20px;color:var(--bw-mark);margin:0 10px}',
      P + ' .bw-ico svg{display:block}',
      P + ' .bw-input{min-width:0}',

      /* colour field */
      P + ' .bw-color{align-items:center}',
      // Frame 4:551: a 20x20 swatch on an 8px gutter with the name 8px after
      // it, so the value starts at 40 — the same place a spacing field's value
      // starts, behind its 20px mark. The swatch is sized here rather than on
      // .bw-chip because the same class draws the ones in the dropdown list,
      // which the frame keeps small.
      // Frame 4:551 still: the 20x20 swatch on the 12px gutter with the value
      // 8px after it, so the value starts at 40 — the same place a spacing
      // field's does behind its 20px mark. The button is the gutter plus the
      // swatch plus that 8, which is the 40 exactly: a 20px target grown to
      // the field's full height without moving anything.
      P + ' .bw-cswatch{flex:0 0 auto;height:100%;display:flex;align-items:center;',
      '  padding:0 8px 0 12px}',
      // It is a button now, so it says so under the cursor — the ring the
      // swatches in the list already wear when hovered.
      P + ' .bw-cswatch:hover .bw-chip{box-shadow:inset 0 0 0 1px var(--bw-ring),',
      '  0 0 0 2px var(--bw-sunken),0 0 0 3.5px var(--bw-brand)}',
      P + ' .bw-cswatch:disabled{cursor:default}',
      P + ' .bw-cswatch:disabled:hover .bw-chip{box-shadow:inset 0 0 0 1px var(--bw-ring)}',
      P + ' .bw-color .bw-chip{width:20px;height:20px;border-radius:3px}',
      P + ' .bw-ctoken{flex:1;min-width:0;display:flex;align-items:center;gap:10px;',
      '  height:100%;padding:0 12px 0 0;overflow:hidden}',
      P + ' .bw-ctoken:hover{background:#2b2b2b}',
      // A colour the panel cannot change is still worth showing, but it is not
      // a control: no hover fill, no chevron, no cursor promising a list.
      P + ' .bw-ctoken:disabled{cursor:default}',
      P + ' .bw-ctoken:disabled:hover{background:none}',
      P + ' .bw-field.is-locked .bw-chev{opacity:0}',
      // No mark to indent past, so the value sits at the frame's 12px gutter.
      P + ' .bw-ctoken.is-bare{padding-left:12px;gap:8px}',
      // A field with no leading mark stands its value on the same 12px the
      // bare token beside it does — the size field against the weight field,
      // one an input and one a button, on one line and one gutter.
      P + ' .bw-field.is-bare > .bw-val{padding-left:12px}',
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

      both(' .bw-chip') + '{flex:0 0 auto;width:14px;height:14px;border-radius:4px;',
      '  box-shadow:inset 0 0 0 1px var(--bw-ring)}',
      P + ' .bw-chip.is-empty{background:repeating-linear-gradient(45deg,var(--bw-hair) 0 3px,transparent 3px 6px)}',
      both(' .bw-snow') + '{flex:0 0 auto;display:flex;align-items:center}',
      both(' .bw-snow svg') + '{display:block}',
      // The stroke list's specimen: the style itself, drawn as a 2px rule at
      // the right of the row where every other list puts its number. A style
      // is the one value here whose name says least about it, which is the
      // same exemption the family list's face has.
      // 3px, not 2: `double` is two lines with a gap between them, and below
      // three there is no room for the gap — it draws as one solid line, which
      // is the one row in the list that would then be showing the wrong thing.
      PP + ' .bw-strokebar{flex:0 0 56px;height:0;border-top-width:3px;',
      '  border-top-color:var(--bw-fg)}',
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
      // It is an <input> on a colour field and a <span> everywhere else, so it
      // carries what an input needs to stop looking like one. The typist is
      // the reason: a hex is a value people arrive holding.
      P + ' .bw-cname{border:0;background:transparent;padding:0}',
      P + ' .bw-cname:focus{outline:none}',
      P + ' .bw-cname:disabled{cursor:default}',
      P + ' .bw-cname.is-unset{color:var(--bw-faint)}',
      // Frame 7:622: opacity is a field of its own, not a corner of the colour
      // one. Its 57 and the 12 beside it come out of the colour field and out
      // of nothing else, so the two states stand on the same line and the tile
      // after them never moves. The 12 is the row's own column-gap — this is a
      // sibling field now, so it is spaced like one.
      P + ' .bw-alpha{flex:0 0 57px;align-items:center;padding-left:10px}',
      // 15px in the value colour, the same as the name in the field beside it:
      // the frame sets "100%" in the panel's own type, where this was an 11px
      // monospace number with a 10px grey % after it. The width is set from the
      // value in ch, so the % sits against the digits at any length instead of
      // after a fixed box the short ones do not fill.
      P + ' .bw-alpha-in{width:3ch;border:0;background:transparent;text-align:left;',
      '  font:400 15px/1 ' + UI_FONT + ';color:var(--bw-fg);padding:0}',
      P + ' .bw-alpha-in:focus{outline:none}',
      // The measure the field is sized from. A `ch` is the width of a zero and
      // these digits are not all a zero wide, so 3ch for "100" left a visible
      // space before the %, which reads as "100 %" rather than as one value.
      // The same font on the same surface, so what it measures is what the
      // input will draw.
      P + ' .bw-alpha-sz{position:absolute;visibility:hidden;white-space:pre;',
      '  font:400 15px/1 ' + UI_FONT + '}',
      // The unlink, in the right-hand slot the chevron otherwise owns — 20 on
      // the frame's grid, ending 10px in from the field's edge, in a 40px-tall
      // target because a 20px mark is a small thing to aim at. It shows on a
      // token colour and the chevron shows without one, so the two share the
      // slot and are never drawn on top of each other.
      P + ' .bw-unlink{position:absolute;right:0;top:0;height:100%;width:40px;',
      '  display:flex;align-items:center;justify-content:flex-end;padding-right:10px}',
      P + ' .bw-unlink svg{display:block}',
      // It hides the way the chevron it stands in for hides. Both are
      // affordances rather than information — they say "this does something"
      // to a cursor that is already here — and a mark sitting on every colour
      // row at rest is a second thing to read on a row whose whole job is to
      // say one colour. pointer-events with it, because a button you cannot
      // see is not a button you should be able to press.
      P + ' .bw-unlink{opacity:0;pointer-events:none}',
      P + ' .bw-field:hover .bw-unlink,' + P + ' .bw-field:focus-within .bw-unlink,',
      P + ' .bw-field.is-open .bw-unlink,' + P + ' .is-open .bw-unlink',
      '  {opacity:1;pointer-events:auto}',
      P + ' .bw-field .bw-unlink:hover{opacity:.7}',
      // The frame ends the name at 222 of the field's 260, 8px short of the
      // mark, so it ellipsises before it reaches it rather than under it. With
      // no mark there the name keeps the field's own 12px gutter.
      P + ' .bw-field.has-unlink{padding-right:38px}',
      // Sits against the chevron: the name above is what absorbs the width.
      // Centred the way the snowflake it shares that slot with is, and for the
      // reason .bw-snow already carries the same two properties: a .bw-field
      // stretches its children, so a 13px line box in a 40px field puts its
      // text at the top of the field rather than on its centre line. It went
      // unseen while every note in the panel sat inside a .bw-ctoken, which
      // centres its own row — the size field's note is the first to be a child
      // of the field itself, and the radius box's "+n" was the same bug
      // waiting on a logical class neither codebase has.
      P + ' .bw-unit{flex:0 0 auto;display:flex;align-items:center;',
      '  font:400 13px/1 ' + UI_FONT + ';color:var(--bw-faint)}',
      P + ' .bw-pct{font:400 15px/1 ' + UI_FONT + ';color:var(--bw-fg)}',

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
      // Both colour views are sized from the grid rather than the grid from
      // them, which is what lets the palette and a ramp beside it be the same
      // object twice: 322 is 2 border + 40 gutter + eleven 20px squares + ten
      // 6px gaps, exactly. Eleven because a ramp is eleven and ten with one
      // under it is an orphan — and once the ramp is eleven the palette has to
      // be too. Same square and same gap in two boxes cannot both run gutter
      // to gutter on different counts: ten and eleven of one square with one
      // gap differ by a square and a gap, so something has to give, and the
      // count is the only one of the three nobody looks at. It used to be 312
      // for the panel's own row width, with the squares taking whatever the
      // gaps left — 21.6 in the palette against 19.1 in the ramp, for one
      // object drawn twice. The token lists keep the frame's 220, since a row
      // of text needs no more.
      PP + '.is-swatches{width:322px;max-height:560px}',
      PP + '.is-shades{width:322px}',
      PP + ' .bw-pop-h{display:flex;align-items:center;gap:6px;height:60px;',
      '  padding:0 10px 0 20px;flex:0 0 auto;border-bottom:1px solid ' + RULE + '}',
      PP + ' .bw-pop-h strong{flex:1;font:400 15px/1.4 ' + UI_FONT + ';color:var(--bw-muted);',
      '  text-transform:capitalize}',
      // 20px at the sides: the gutter the panel uses everywhere, and the one
      // this popover's own header already stands on — the title starts at 20,
      // and the X's mark ends at 20, since a 40px tile holding a 20px glyph
      // puts the glyph there and lets only the hover fill overhang. At 8 the
      // grid was aligned to neither, overhanging the title on the left and the
      // mark on the right by enough to read as a grid slightly too wide rather
      // than as a padding. Aligning to the tile's own edge was the same miss
      // 10px further in: what you see of a button at rest is its mark.
      PP + ' .bw-pop-body{overflow-y:auto;padding:20px}',
      // And a row's TEXT stands on that gutter too, not 12px inside it. The
      // fill it wears under the cursor is what overhangs — the same rule the
      // panel's toggle tiles follow, where what you see of a control at rest
      // is its mark and only its hover fill hangs into the gutter. Read down
      // an open list the two were plainly apart: "Search" at 21 and "0px" at
      // 33, with the meta on the right ending at 187 against the X's mark at
      // 199, on a surface whose whole content is one column of left-aligned
      // text. The 12 is the row's own padding, so it is handed back on both
      // sides rather than taken off it — a row with no inset would sit its
      // fill hard against the border and its text on the gutter with nothing
      // in between. Direct children only: `.bw-picker` and `.bw-swatches`
      // keep the 20, and the swatch grid is measured from it.
      PP + ' .bw-pop-body > .bw-hue,' + PP + ' .bw-pop-body > .bw-pop-empty',
      '  {width:calc(100% + 24px);margin-left:-12px;margin-right:-12px}',
      // The same words in the same voice the popover's own title is set in —
      // 15px muted and capitalised, not a 9px letterspaced caption. Two type
      // styles for two headings on one surface was one style too many.
      PP + ' .bw-pop-group{padding:7px 8px 3px;font:400 15px/1.4 ' + UI_FONT + ';',
      '  text-transform:capitalize;color:var(--bw-muted)}',
      PP + ' .bw-hue{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:0 12px;',
      '  border-radius:6px;font:12px/1.2 ' + UI_MONO + ';color:var(--bw-fg);text-align:left;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      PP + ' .bw-hue:hover{background:' + RAISED + '}',
      // The palette is a grid of colour, not a list of names — and so are the
      // shades, which is the same grid and not a second one. Ten to a row at
      // 24px, which is what sets the popover's width above rather than being
      // set by it: sixteen was as much as nine-in-220 allowed, and a swatch is
      // the whole control, so it is the thing that should have the room. A
      // name would need a row each and turn two dozen colours into a scroll;
      // the title carries it.
      // The picker, on top of the presets and divided from them: one half says
      // any colour there is, the other says the ones this project has names
      // for, and they are two different acts on one surface.
      PP + ' .bw-picker{padding-bottom:12px;margin-bottom:8px;',
      '  border-bottom:1px solid ' + RULE + '}',
      // No canvas: black up, white across, the hue behind both. Changing hue
      // is then one custom property rather than a repaint.
      PP + ' .bw-sv{position:relative;height:120px;border-radius:8px;cursor:crosshair;',
      '  background:linear-gradient(to top,#000,rgba(0,0,0,0)),',
      '  linear-gradient(to right,#fff,rgba(255,255,255,0)),',
      '  var(--bw-sv-hue,hsl(0 100% 50%));',
      '  box-shadow:inset 0 0 0 1px var(--bw-ring);touch-action:none}',
      PP + ' .bw-strip{position:relative;height:12px;margin-top:12px;border-radius:6px;',
      '  cursor:ew-resize;touch-action:none;box-shadow:inset 0 0 0 1px var(--bw-ring);',
      '  background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}',
      // The knob wears the colour it is standing on, ringed in white so it
      // reads on both ends of the square, with a dark halo so the white ring
      // reads on the pale end too. It never takes the pointer — the surface
      // under it is the control, and a knob that ate the press would stall a
      // drag the moment it caught up with the cursor.
      // 12 and not 14: at s=0,v=1 the knob is centred on the square's corner,
      // which is 8px in from the popover's border — 6 of radius and 2 of ring
      // is exactly that 8, so the extreme of the control lands on the gutter
      // instead of across the edge of the window it is in.
      PP + ' .bw-knob{position:absolute;width:12px;height:12px;border-radius:50%;',
      '  transform:translate(-50%,-50%);pointer-events:none;border:2px solid #fff;',
      '  box-shadow:0 0 0 1px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.45)}',
      // One square at one size and one gap, wherever a colour is drawn: 20x20
      // at a 3px radius is what the frame gives the swatch in the field
      // (4:551), so it is what the grids give theirs, and 6px is the gap the
      // panel puts between controls everywhere else. They used to be `1fr`
      // tracks, which meant the square was whatever the gaps left over — 21.6
      // in the palette, 19.1 in an eleven-wide ramp, 20 in the field, three
      // sizes for one object. The track is the square now, the gap is fixed,
      // and the box is what gives: `.is-swatches` is sized to hold exactly
      // this, so the grid still lands on both gutters without being asked to.
      PP + ' .bw-swatches{display:grid;grid-template-columns:repeat(11,20px);gap:6px}',
      PP + ' .bw-swatch{aspect-ratio:1;border-radius:3px;',
      '  box-shadow:inset 0 0 0 1px var(--bw-ring)}',
      PP + ' .bw-swatch.is-empty{background:repeating-linear-gradient(45deg,',
      '  var(--bw-hair) 0 3px,transparent 3px 6px)}',
      PP + ' .bw-swatch:hover{box-shadow:inset 0 0 0 1px var(--bw-ring),',
      '  0 0 0 2px var(--bw-card),0 0 0 3.5px var(--bw-brand)}',
      // The hue whose ramp is open wears what a hovered swatch wears: the ring
      // already means "this one", and the cursor has moved on to the shades by
      // the time it matters. After the hover rule, so it wins the tie.
      PP + ' .bw-swatch.is-open{box-shadow:inset 0 0 0 1px var(--bw-ring),',
      '  0 0 0 2px var(--bw-card),0 0 0 3.5px var(--bw-brand)}',
      // A caption takes a line of its own rather than a cell, so the grid
      // still reads as rows of colour with a heading over each run.
      PP + ' .bw-swatches .bw-pop-group{grid-column:1/-1;padding:8px 0 4px}',
      PP + ' .bw-swatches .bw-pop-group:first-child{padding-top:0}',
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
      PP + ' .bw-nosample{display:none}',
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
      // 12 on every side: the bar's own gutter, the same one it keeps at the
      // right. 10 top and bottom left the button standing closer to the rule
      // above it and to the panel's foot than to the edge it is aligned with.
      P + ' .bw-foot{flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:12px;',
      // EDGE, like the row dividers and the tab strip: --bw-hair is the same
      // value as a field's background, so the line disappeared wherever a
      // field ran up against it — which down here is most of its length.
      '  border-top:1px solid ' + EDGE + ';background:var(--bw-bg)}',
      // With nothing selected the footer IS the panel, so it carries no top
      // border of its own — there is nothing above it to be divided from.
      // Keyed on the selection and not on data-tw-idle: idle means the editor
      // controls are folded, which the Prompt tab does too, and there the
      // footer has a composer above it to be divided from.
      P + '[data-tw-empty] .bw-foot{border-top:0}',
      P + ' .bw-foot-row{display:flex;align-items:center;gap:6px}',
      // The bar is the only part of the panel on screen when nothing is
      // selected, so it has to be a handle too — the header it used to be
      // dragged by is folded away exactly then. Both wear the same cursor:
      // the open hand IS the affordance, which is why there is no grip icon.
      handles('') + '{cursor:grab}',
      handles(':active') + '{cursor:grabbing}',
      handles(' button') + '{cursor:pointer}',
      handles(' button:disabled') + '{cursor:default}',
      // 40 and an 8px radius, which is the panel's tile everywhere else — the
      // dismiss × included, and it wears the same 20px mark now. No border, for
      // the reason the × has none: the tile is the hover fill, and a box drawn
      // permanently around a mark that is only sometimes usable said the wrong
      // thing in both states.
      P + ' .bw-hbtn{flex:0 0 auto;width:40px;height:40px;display:flex;align-items:center;',
      '  justify-content:center;border-radius:8px}',
      P + ' .bw-hbtn svg{display:block}',
      P + ' .bw-hbtn:hover:not(:disabled){background:var(--bw-hover)}',
      // Enabled, these are the export's own #AAA — the same mark the × and the
      // + wear, because they are the same kind of thing. Disabled they only
      // step back from it: dimmed far enough that "nothing to undo" reads
      // before the arrow does.
      //
      // Opacity is the only lever here. The stroke is #AAAAAA baked into the
      // exported file, not currentColor, so `color` on the button does nothing
      // — and the export is kept verbatim on purpose.
      //
      // .22 composited 170 over the card's 23 and landed at 55: a mark two
      // steps off the background, readable as an artefact rather than as a
      // control. .38 lands at 79 — the scheme's own #505050 border grey, which
      // is already what this palette uses for "structural, present, not
      // active", so the disabled arrows now sit on a value the design has
      // rather than on an arbitrary fade.
      P + ' .bw-hbtn:disabled{opacity:.38;cursor:default}',
      P + ' .bw-foot-row .bw-save{margin-left:auto}',
      // The same 40 the buttons beside it stand at, so the row has one height
      // rather than a tall pair and a short one centred against them.
      //
      // Save and Send are one button in two places. They sit on different tabs
      // and never share a screen, so a coral Save against a white Send was two
      // treatments for the footer's one action — whichever tab you were on,
      // the thing at the end of the panel was the same kind of thing. White is
      // the pair's colour: the coral is the brand's, and it is already saying
      // something else on this screen — the toggle, the ring around a held
      // page, the badge counting what is pending. A button wearing it too made
      // the accent the panel's ordinary furniture.
      P + ' .bw-save{height:40px;font:400 15px/1 ' + UI_FONT + ';color:#171717;background:#fff;',
      '  border-radius:8px;padding:0 14px;box-shadow:0 1px 2px rgba(0,0,0,.08);white-space:nowrap}',
      // Darken rather than brighten: brightness(1.06) does nothing whatever to
      // white, which is how the coral button's hover read on Send. And only
      // while the button can be pressed — without the guard it lit a dead one.
      P + ' .bw-save:hover:not(:disabled){filter:brightness(.92)}',
      P + ' .bw-save:disabled{background:var(--bw-sunken);color:var(--bw-faint);',
      '  box-shadow:none;cursor:default}',
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
    // An icon may be a key or a function of the selected element — the single
    // gap is the one that has to ask, since `gap-4` points down a flex-col and
    // across a flex-row. Built with its default; the section's readout swaps it.
    var iconKey = typeof opts.icon === 'function' ? opts.icon(null) : opts.icon;
    mark.innerHTML = ICONS[opts.key ? boxIcon(prefix, opts.key, iconKey) : iconKey];
    mark.setAttribute('data-tw-icon', iconKey);
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
        // The placeholder is where an unset field keeps the number the page
        // renders, so a step off it counts from what is on screen either way.
        // withStep lets this field's own readout through the focus guard, so
        // the new value, its marking and its placeholder all land together —
        // and the blur that follows commits what is on screen rather than the
        // stale text a skipped readout would have left there.
        withStep(function () {
          stepSpacing(prefix, side, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey,
            readout.value || readout.placeholder);
        });
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
      if (typing(readout)) return; // don't fight the typist
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
    if (box.fields) return box.fields.map(function (f) { return f.side; });
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

  /**
   * Is there any text under this element at all — its own or a descendant's?
   *
   * The looser test hasOwnText, and deliberately: typography cascades, so a
   * card holding a heading and a paragraph really can be given a family, and
   * the + row is what offers it. What it cannot do is put type on an element
   * with no type under it — an <img>, a spacer, an empty div — where every
   * field the row reveals would be a control that cannot change the page.
   * A form control renders text of its own that is not in the DOM tree.
   */
  function hasText(el) {
    if (!el) return false;
    if (/^(input|select)$/.test(el.tagName.toLowerCase())) return true;
    return !!(el.textContent || '').trim();
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
   * …and there has to be something for the gap to stand between.
   *
   * A flex container with one item, or none, lays out identically at every
   * value gap can take — so offering to add one there is the same empty offer
   * Typography makes on an element with no text. Text counts: a bare string
   * inside a flex parent is an anonymous flex item like any other, so
   * <div class="flex">a <span>b</span></div> has two.
   *
   * The rule is the + row's alone. An element already carrying gap-4 keeps its
   * field however few children it has, so a stale class stays removable.
   */
  function canGap(el) {
    if (!supportsGap(el)) return false;
    var n = el.children.length;
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) n++;
    }
    return n > 1;
  }

  /**
   * Which gap fields to show: the ones the element is actually using.
   *
   * `gap-4`, `gap-x-4` and `gap-y-4` are three different statements about a
   * container, and the panel shows the one being made rather than offering all
   * three and a switch. A container with `gap-x-4` is saying something about
   * its columns and nothing about its rows — so a row-gap field there is a
   * control for a decision nobody took, and a toggle between "one gap" and
   * "two gaps" is a question about the class list rather than about the page.
   *
   * Nothing set yet is the one gap, which is what `gap-4` means and what the +
   * row reveals into.
   */
  function gapFields(el) {
    var axes = GAP_AXES.filter(function (f) {
      return readSpacing(el, 'gap', f.side).source === 'explicit';
    }).map(function (f) { return f.side; });
    return axes.length ? axes : [''];
  }

  /**
   * A box whose fields are chosen by what the element wears, not by a toggle.
   */
  function chosenSection(box) {
    var wrap = el('div', 'bw-row top');
    wrap.setAttribute('data-tw-section', box.prefix);
    wrap.appendChild(el('span', 'bw-lbl', box.label));

    var pair = el('div', 'bw-pair');
    var fields = {};
    box.fields.forEach(function (f) {
      // The names are already whole here — 'gap', 'column gap', 'row gap' —
      // so they are used as written rather than prefixed with the box's label.
      var node = spacingField(box.prefix, f.side, { icon: f.icon, name: f.name });
      fields[f.side] = node;
      pair.appendChild(node);
    });

    var stack = el('div', 'bw-stack');
    stack.appendChild(pair);
    wrap.appendChild(stack);

    readouts.push(function () {
      var show = boxVisible(selected, box);
      shown[box.prefix] = show;
      wrap.style.display = show ? '' : 'none';
      if (!show) return;
      var want = box.choose(selected);
      box.fields.forEach(function (f) {
        var on = want.indexOf(f.side) !== -1;
        fields[f.side].style.display = on ? '' : 'none';
        // Re-asked per selection, not per readout keystroke: the mark only
        // changes when the element does, and rewriting innerHTML under the
        // cursor would throw away the SVG for no reason.
        if (!on || typeof f.icon !== 'function') return;
        var mark = fields[f.side].querySelector('.bw-ico');
        var key = f.icon(selected);
        if (!mark || mark.getAttribute('data-tw-icon') === key) return;
        mark.setAttribute('data-tw-icon', key);
        mark.innerHTML = ICONS[key];
      });
      pair.className = 'bw-pair' + (want.length === 1 ? ' is-single' : '');
    });

    return wrap;
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
      shown[box.prefix] = show;
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
   * A property that is not always on show keeps its row either way: its
   * controls, or its name with a + where the controls will go.
   *
   * Frame 4:407 draws Margin exactly that way, in Margin's own slot between
   * Padding and Typography. That placement is the point. The strip of chips
   * this replaced sat at the end of the panel, so every property that was not
   * set had been moved out of the order the panel otherwise reads in, and
   * revealing one made the layout jump as the row appeared somewhere else.
   * A row that is already in place only fills in.
   *
   * Revealing still writes nothing — it shows the controls so a value can be
   * set, so nothing is ever hidden beyond reach.
   */
  function revealRow(spec) {
    // The row IS the button. A 20px + is a small thing to hit for something
    // this coarse — the row has one meaning end to end, so the whole of it
    // takes the click, and the label is part of the target rather than a piece
    // of text sitting beside one. One element, so no button nested inside a
    // button: the tile below is a span drawn to look like the toggle it
    // stands in for.
    var row = el('button', 'bw-row bw-reveal');
    row.setAttribute('data-tw-reveal', spec.key);
    row.setAttribute('data-tw-add', spec.key);
    row.title = 'Add ' + spec.label.toLowerCase();
    row.appendChild(el('span', 'bw-lbl', spec.label));

    // The same 40x40 tile a section's toggle sits in, in the same place, so
    // the right-hand column holds still whichever of the two a row is showing.
    var add = el('span', 'bw-toggle');
    add.innerHTML = ICONS.plus;
    row.appendChild(add);

    row.addEventListener('click', function () {
      revealed[spec.key] = true;
      // Most rows reveal and write nothing: a padding field with no class is
      // still telling you the element renders 0. A colour field with no class
      // is a dash and an empty swatch, which is why the row was hiding in the
      // first place — so those two start somewhere instead, and white is the
      // one value that is white on every route rather than a guess at the
      // project's palette.
      if (spec.onReveal) spec.onReveal();
      else refresh();
    });

    readouts.push(function () {
      var show = !!selected && !shown[spec.key] &&
        (spec.applies ? spec.applies(selected) : true);
      row.style.display = show ? '' : 'none';
    });

    return row;
  }

  /** The optional sections, each named where its own row sits. */
  var REVEALS = {
    m: { key: 'm', label: 'Margin' },
    gap: { key: 'gap', label: 'Gap', applies: canGap },
    // Radius hides where nothing would show it, but an element about to get a
    // background should not have to get one first to round its corners.
    radius: { key: 'radius', label: 'Radius' },
    // Revealing writes a stroke, the way the two colour rows do and for a
    // sharper version of their reason: a padding field with no class still
    // tells you the element renders 0, but a stroke that reads 0 wide, no
    // colour and a style nothing is drawn in is three controls describing
    // nothing at all — and the property this row is named for is not on the
    // page. So it starts at the one stroke every route can draw: 1px solid
    // black, all three said out loud.
    //
    // Tokens, not lengths or hexes: `border` is the bare width utility these
    // codebases use 101 times, and `border-black` reads as a token in the
    // field the way `bg-white` does. `border-solid` is written rather than
    // left to preflight so the style field shows it as this element's own
    // choice instead of dimmed as the page's.
    stroke: {
      key: 'stroke', label: 'Stroke',
      onReveal: function () {
        if (!selected) return;
        stripBorderWidth(selected);
        stripFamily(selected, BORDER_STYLE_RE);
        ensureBorderRule('border', 'border-width:1px');
        ensureBorderRule('border-solid', '--tw-border-style:solid;border-style:solid');
        selected.classList.add('border');
        selected.classList.add('border-solid');
        // Last, and through applyColor: it strips whatever colour was there,
        // emits the preview rule on a route that has never generated one, and
        // marks the element dirty and refreshes — which is the whole of what
        // the other two need done after them.
        applyColor('border', 'border-black');
      },
    },
    // One row for the section, not four for its fields: the frame draws
    // Typography as one thing, and a + on a 124px field would be a control
    // wider than the field it stands in for.
    // …and only where there is text for it to reach. On an element with none
    // under it every field the row reveals is inert, which is the one thing a
    // + should never open into.
    typography: { key: 'typography', label: 'Typography', applies: hasText },
    // An element with no colour of its own still renders in one, inherited or
    // from the page's own CSS — but the field could only say so with a dash
    // and an empty swatch, which is a control describing nothing. The + row
    // says the same thing in the panel's own words.
    bg: {
      key: 'bg', label: 'Background color',
      onReveal: function () { applyColor('bg', 'bg-white'); },
    },
    text: {
      key: 'text', label: 'Text color',
      onReveal: function () { applyColor('text', 'text-white'); },
    },
  };

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

  /**
   * The size field: a length you type, with the ladder behind the chevron.
   *
   * It was one button that opened a list, which left the one number in this
   * section people most often arrive holding — a size out of a design file or
   * a spec — as the only value in the panel that could be picked and not
   * typed. The same change the colour row went through, and the same half kept
   * as the opener; there is no swatch here to press, so the chevron keeps the
   * job and the value beside it becomes a field, which is how spacing and
   * radius have always been drawn. The hover fill goes with the button, the
   * way it went from the colour value: what you type in is not a button, and
   * the weight field beside it still is one.
   */
  function sizeField() {
    var field = el('div', 'bw-field is-bare');
    field.setAttribute('data-tw-field', 'font');
    field.setAttribute('data-tw-optional', 'font');

    var readout = document.createElement('input');
    readout.className = 'bw-val';
    readout.type = 'text';
    readout.inputMode = 'numeric';
    readout.autocomplete = 'off';
    readout.spellcheck = false;
    readout.setAttribute('data-tw-font-text', '');
    readout.placeholder = '\u2014';

    // The rung's name where the value is one, and nothing where it is not —
    // the snowflake beside it is what says so, as it does on every other
    // literal in the panel.
    var note = el('span', 'bw-unit', '');
    var snow = snowflake();
    snow.style.display = 'none';

    var open = el('button', 'bw-open');
    open.setAttribute('data-tw-font-open', '');
    open.innerHTML = ICONS.chevron;
    open.title = 'Size \u2014 pick a token';
    open.addEventListener('click', function () { openSizePopover(field); });

    field.appendChild(readout);
    field.appendChild(note);
    field.appendChild(snow);
    field.appendChild(open);

    /** A pixel length said the way every other length here is: bare. */
    function bare(css) {
      var m = /^([\d.]+)px$/.exec(String(css || ''));
      return m ? m[1] : String(css || '');
    }

    /** What the field shows for a given read — the inverse of commit(). */
    function textFor(state) {
      if (!state || state.kind === 'none') return '';
      if (state.kind === 'scale') return bare(pxOfToken(state.name));
      // A literal in some other unit has to keep it, or it says nothing —
      // the same rule spacing states, met on the one length field that
      // routinely holds rem.
      return state.unit === 'px' ? String(state.px) : state.px + state.unit;
    }

    /**
     * What was typed.
     *
     *   16 / 16px    sixteen pixels, written text-[16px]
     *   1.5rem       any other unit taken at its word, arbitrary
     *   lg / text-lg the token, the prefix being the panel’s business
     *
     * A bare number stays a literal even where a rung lands exactly on it,
     * which is where this parts from padding, radius and stroke width. Those
     * rungs are the length and nothing else, so writing p-4 for 16 changes
     * only what the class is called. A text-* token is two declarations: it
     * sets a line-height as well, so text-lg for a typed 18 would move the
     * leading nobody asked about. The token is a click away in the list, and
     * its own name typed here still fetches it — that is what asking for the
     * token looks like. It is also what the list’s own custom row has always
     * written, so the two ways into this field agree.
     *
     * Empty clears the class. Anything else puts back what was showing rather
     * than guessing at an intent, the way every field in this panel refuses.
     */
    function commit() {
      if (!selected) return;
      var raw = readout.value.trim().replace(/\s+/g, '');
      // Committing what the field already shows is not an edit — blur fires on
      // every field merely tabbed through, and without this each one marked the
      // element dirty and pushed a history step that undid to itself.
      if (raw === textFor(readFontSize(selected))) return refresh();
      if (raw === '' || raw === '\u2014') return setFontSize(selected, null);

      var t = raw.toLowerCase();
      var tok = t.indexOf('text-') === 0 ? t.slice(5) : t;
      if (TEXT_SIZES[tok]) return setFontSize(selected, 'text-' + tok);

      var px = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(t);
      if (px) return setFontSize(selected, 'text-[' + Number(px[1]) + 'px]');
      if (/^[\d.]+(?:rem|em)$/.test(t)) return setFontSize(selected, 'text-[' + t + ']');
      if (/^\[[^\]]+\]$/.test(t)) return setFontSize(selected, 'text-' + t);
      refresh();
    }

    /**
     * A pixel a press, ten with Shift — the same press every length in the
     * panel takes, on a field that prints the same unit.
     *
     * It writes what typing that number writes: a literal, never the rung it
     * happens to land on, for the reason commit() gives — a text-* token sets
     * a line-height as well, and counting past 18 is not a request for lg's
     * leading. So the first press off a token detaches from it, which is the
     * honest reading of what an arrow on this field can mean: the ladder here
     * is 12, 14, 16, 18, 20, 24, 30, 36, and it was never something a count
     * could walk.
     */
    function step(dir, leap) {
      if (!selected) return;
      var state = readFontSize(selected);
      var here = stepFrom(readout.value || readout.placeholder,
        Math.round(parseFloat(getComputedStyle(selected).fontSize) || 0));
      var next = stepLength(here, dir, leap);
      if (next === null) {
        // Below zero the class comes off rather than pinning a size nothing is
        // legible at. Nothing of its own to take off means nothing to do.
        if (state.kind === 'none') return;
        return setFontSize(selected, null);
      }
      setFontSize(selected, 'text-[' + next + 'px]');
    }

    readout.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); readout.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); readout.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        withStep(function () { step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); });
      }
    });
    readout.addEventListener('blur', commit);
    readout.addEventListener('focus', function () { readout.select(); });

    return {
      field: field,
      sync: function () {
        // Font size hides on elements with no text of their own, but a wrapper
        // may legitimately set it to cascade — so it stays one click away.
        var state = readFontSize(selected);
        var show = hasOwnText(selected) || revealed.typography || state.kind !== 'none';
        field.style.display = show ? '' : 'none';
        if (!show) return false;
        // The section still needs its answer, so this reports before it bows
        // out rather than instead of it.
        if (typing(readout)) return true;

        readout.placeholder = '\u2014';
        if (state.kind === 'scale') {
          // Pixels lead and the rung is the note beside them, which is the
          // frame’s "24" and the same call the spacing fields already make:
          // nobody should have to know what lg is worth to know how big this
          // is. Bare, because every length in this panel is — the unit only
          // survives where it is not a pixel and would otherwise say nothing.
          readout.value = textFor(state);
          readout.className = 'bw-val';
          note.textContent = state.name.replace('text-', '');
          snow.style.display = 'none';
          readout.title = state.name + ' \u2014 ' + pxOfToken(state.name);
        } else if (state.kind === 'px') {
          // Not a token. Say so rather than dressing it up as one — the
          // snowflake and the italic, set from the one condition, exactly as
          // spacing and radius mark a literal. Naming the nearest rung in the
          // note put a token in the value’s own slot on the one row where the
          // value is emphatically not that token, a shade away from claiming
          // the element is set to it. The hint keeps the tooltip, where a
          // nudge toward the scale costs nothing to read past.
          var near = nearestToken(state.px);
          readout.value = textFor(state);
          readout.className = 'bw-val is-jit';
          note.textContent = '';
          snow.style.display = '';
          readout.title = state.cls + ' \u2014 not a scale token' +
            (near ? '; nearest is ' + near.name + ' at ' + near.px + 'px' : '');
        } else {
          // Nothing in the class list. What the page renders goes in the
          // placeholder rather than the value, so a number this element does
          // not own is never mistaken for one it does — the rule the stroke
          // width field states, and the one a field you can type in needs.
          readout.value = '';
          readout.placeholder = state.px ? String(state.px) : '\u2014';
          readout.className = 'bw-val';
          note.textContent = state.px ? 'inherited' : '';
          snow.style.display = 'none';
          readout.title = 'not set \u2014 rendering at ' + state.px + 'px';
        }
        return true;
      },
    };
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
   * What a generic keyword calls the stack it is in.
   *
   * The same set as above, read for what it says rather than tested for
   * membership — math/emoji/fangsong are left out because no one picks a
   * typeface by them, and a stack whose only generic is one of those falls
   * through to `other` like a stack with no generic at all.
   */
  // The value is the CSS keyword itself, because the keyword is what goes on
  // screen: a row's note says `sans-serif`, not `sans`, and not `meridian`.
  // The platform's own vocabulary is the one thing that means the same in
  // every project this editor is ever pointed at.
  var GENERIC_GROUP = {
    'ui-sans-serif': 'sans-serif', 'sans-serif': 'sans-serif',
    'system-ui': 'sans-serif', 'ui-rounded': 'sans-serif',
    'ui-serif': 'serif', serif: 'serif',
    'ui-monospace': 'monospace', monospace: 'monospace',
    cursive: 'cursive', fantasy: 'fantasy',
  };

  // The order the list is read in, and the whole vocabulary it can say: these
  // five are what CSS itself offers, so the rule is the language's rather than
  // any one project's. The first three are what every project has an answer
  // for; cursive and fantasy exist so a face that is neither — Cora's Square
  // Peg, the one token on that route the project actually wrote — keeps a row
  // rather than being called something it is not.
  //
  // There is deliberately no sixth. A stack that names no generic at all says
  // nothing about what kind of type it is, and an "other" is a label meaning
  // "we could not tell" — so such a token is not offered. The editor has to
  // hold for projects nobody here has seen, and a rule that guesses is one
  // that guesses differently in each of them.
  var FAMILY_GROUPS = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];

  /**
   * Faces worth asking about when a stack resolves to a generic. Not a font
   * list — nothing here is ever offered — it is the set of names the answer
   * is checked against, so a name can only be shown once it has been
   * confirmed on this machine. Anything absent from a platform simply never
   * matches there.
   */
  var PLATFORM_FACES = [
    // Apple
    'SF Pro Text', 'SF Pro Display', 'SF Pro', 'New York', 'Helvetica Neue',
    'SF Mono', 'Menlo', 'Monaco',
    // Windows
    'Segoe UI Variable Text', 'Segoe UI', 'Cascadia Mono', 'Cascadia Code',
    'Consolas',
    // Android / ChromeOS
    'Roboto', 'Roboto Mono', 'Noto Sans', 'Noto Serif', 'Noto Sans Mono',
    // Linux desktops
    'Cantarell', 'Ubuntu', 'Ubuntu Mono', 'DejaVu Sans', 'DejaVu Serif',
    'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono',
    // near-universal. Courier before Courier New: the plain one is what the
    // default `monospace` resolves to on macOS, and first match wins.
    'Helvetica', 'Arial', 'Georgia', 'Andale Mono', 'PT Mono',
    'Times New Roman', 'Courier', 'Courier New',
  ];

  /**
   * The UI font each platform ships, consulted ONLY after the measurement
   * has already proved that is what we are looking at.
   *
   * macOS renders `ui-sans-serif` with `.AppleSystemUIFont`, which no
   * addressable family name draws identically to — the installed "SF Pro"
   * is present and measurably different, being the optical variant Chromium
   * does not use here. So the face cannot be identified by comparison, only
   * placed: matching `system-ui` proves it IS the platform's UI font, and
   * this table then says what that font is called. A platform with no
   * settled answer gets no entry and keeps the keyword.
   */
  var SYSTEM_ALIAS = { 'system-ui': 1, 'BlinkMacSystemFont': 1, '-apple-system': 1 };
  function systemFaceName() {
    var ua = navigator.userAgent || '';
    if (/Mac OS X|iPhone|iPad|iPod/.test(ua)) return 'SF Pro';
    if (/Windows/.test(ua)) return 'Segoe UI';
    if (/Android|CrOS/.test(ua)) return 'Roboto';
    return ''; // desktop Linux has no one answer; the loop above may still find it
  }

  var NO_SUCH_FACE = '"BwNoSuchFace"';
  var faceInk = {};

  /**
   * A fingerprint of how a font stack actually draws.
   *
   * Painted and read back, exactly as colours are, and for exactly the same
   * reason: the serialised value does not tell you what you will see. It is
   * the *bitmap* that is hashed rather than the text width, because the pairs
   * that matter most are the metric-compatible clones — Arial and Liberation
   * Sans are designed to measure identically and to draw differently.
   */
  function inkOf(stack) {
    if (faceInk[stack] !== undefined) return faceInk[stack];
    var cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 48;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    // An unparseable font leaves ctx.font at its 10px default, so a bad name
    // can only ever fail to match — it can never be mistaken for a hit.
    ctx.font = '32px ' + stack;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000';
    ctx.fillText('Hamburgefonstiv 123', 4, 36);
    var d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    var h = 2166136261;
    for (var i = 3; i < d.length; i += 4) { h ^= d[i]; h = (h * 16777619) >>> 0; }
    faceInk[stack] = h;
    return h;
  }

  /**
   * Which real face a generic stack resolves to on this machine, or ''.
   *
   * `ui-sans-serif` is not a typeface, it is a request — the platform answers
   * it and CSS never says what it answered, so the only way to name the
   * answer is to draw it and compare. A candidate that is not installed
   * falls back to the browser default, which is what the control measures;
   * those are skipped rather than matched, so a missing font can never be
   * named. Nothing matching leaves the generic keyword standing — the name
   * is measured or it is not shown.
   */
  function identifyGeneric(stack) {
    var control = inkOf(NO_SUCH_FACE);
    var target = inkOf(stack);
    if (target === control) return '';

    // A named face first, always: this is the half that is proven outright,
    // and it is what answers ui-serif (Georgia) and ui-monospace (Menlo).
    for (var i = 0; i < PLATFORM_FACES.length; i++) {
      var name = PLATFORM_FACES[i];
      // The bogus second entry isolates "absent" from "present": a missing
      // face falls through to it and lands on the control.
      var ink = inkOf('"' + name + '", ' + NO_SUCH_FACE);
      if (ink !== control && ink === target) return name;
    }

    // Otherwise: is it the platform's own UI font? That is still a measured
    // fact — the alias draws identically — and only the name of the thing it
    // proves has to be looked up.
    var aliases = Object.keys(SYSTEM_ALIAS);
    for (var j = 0; j < aliases.length; j++) {
      if (inkOf(aliases[j] + ', ' + NO_SUCH_FACE) === target) return systemFaceName();
    }
    return '';
  }

  /**
   * The typeface a stack actually renders as, or '' when it cannot be named.
   *
   * Only the FIRST entry counts where it names a face. The rest are
   * fallbacks the page reaches for when the first is missing, so on
   * `ui-monospace, "Cascadia Code"` the face in use is the platform's, and
   * naming Cascadia Code would be naming the understudy — which is why the
   * generic case is measured rather than read further down the list.
   */
  function familyFace(stack) {
    var resolved = resolveFamily(stack);
    var first = firstFamily(resolved);
    if (!GENERIC_FAMILY[first.toLowerCase()]) return first;
    return identifyGeneric(resolved);
  }

  /**
   * The first entry in a stack that names a face rather than asking for one.
   *
   * This is a fallback and nothing more. It is not necessarily what renders —
   * on `ui-monospace, "Cascadia Code", monospace` with no Cascadia installed
   * the page draws Courier — so it is only reached once measuring has failed
   * to name the real thing. A name the author actually wrote beats a keyword
   * like `ui-monospace`, which on this build is not even supported and so is
   * the one string guaranteed not to be what you are looking at.
   */
  function namedInStack(stack) {
    var parts = String(resolveFamily(stack) || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].trim().replace(/^["']|["']$/g, '');
      if (name && !GENERIC_FAMILY[name.toLowerCase()]) return name;
    }
    return '';
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
  // Measured first, then placed, then guessed, then given up on — each tier
  // less certain than the last, and the tooltip carries the true stack
  // throughout so the honest answer is always one hover away.
  function familyName(token) {
    var stack = FAMILIES[token];
    return familyFace(stack) || namedInStack(stack) || token;
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
    if (cls) {
      ensureFamilyRule(cls);
      el.classList.add(cls);
    }
    markDirty(el, 'classes');
    refresh();
  }

  /**
   * A family read off a generated utility needs no rule — the page has one
   * already, which is the whole point of discovering them there. A family
   * read off a theme variable has none, for the reason it was discovered that
   * way: nothing in the source uses the class yet, so Tailwind generated
   * nothing. It gets a runtime rule like an arbitrary colour does.
   *
   * No gate needed beyond the one below, and none possible to get wrong: a
   * token that reached FAMILIES through `renderable.family` is skipped by
   * name, so the scoped copy that would outrank a route's own responsive
   * variants — the px-6 md:px-12 failure — can never be written.
   */
  function ensureFamilyRule(cls) {
    var name = cls.indexOf('font-') === 0 ? cls.slice(5) : null;
    if (!name || dynSeen[cls] || !FAMILIES[name]) return;
    if (renderable.family && renderable.family[name]) return;
    dynSeen[cls] = true;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.setAttribute('data-tw-editor', 'dynamic');
      document.head.appendChild(dynStyle);
    }
    var sel = (PREVIEW_ATTR ? '[' + PREVIEW_ATTR + ']' : '') + '.' + CSS.escape(cls);
    try {
      dynStyle.sheet.insertRule(
        sel + '{font-family:' + FAMILIES[name] + '}', dynStyle.sheet.cssRules.length);
    } catch (e) {
      dynSeen[cls] = false;
    }
  }

  // sans/serif/mono are Tailwind's own; anything else is the project's, and
  // goes first for the reason the colour list does — these codebases speak
  // their own vocabulary and reach for the stock names close to never.
  var STOCK_FAMILY = { sans: 1, serif: 1, mono: 1 };

  /**
   * What kind of face a token names, taken from the first generic keyword in
   * the stack it resolves to. This is both the note on its row and the run it
   * is sorted into.
   *
   * The FIRST, not the last: Tailwind's own sans ends
   * `…, "Segoe UI Symbol", "Noto Color Emoji"`, so reading from the end finds
   * a face rather than a keyword. Whole comma-separated entries, never a
   * substring — `sans-serif` contains `serif`, which is the same trap the
   * class prefixes make one level up.
   *
   * The resolved stack rather than the declaration, because `.font-sans` is
   * often just `var(--font-sans)` and a var says nothing about what it holds.
   * resolveFamily caches, so this costs one paint per distinct declaration.
   */
  function familyGroup(token) {
    var parts = String(resolveFamily(FAMILIES[token]) || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var g = GENERIC_GROUP[parts[i].trim().replace(/^["']|["']$/g, '').toLowerCase()];
      if (g) return g;
    }
    return '';
  }

  function familyTokens() {
    // A token whose var resolves to nothing is dropped: it would preview as
    // whatever the row happens to inherit. One that resolves to a generic is
    // kept — `font-sans` meaning the platform's sans is a real answer.
    var all = Object.keys(FAMILIES).filter(function (t) { return !!resolveFamily(FAMILIES[t]); });
    var by = {};
    all.forEach(function (t) {
      // No generic, no row: see FAMILY_GROUPS. A stack ending in a face rather
      // than a generic cannot be said to be a sans or a mono, and guessing is
      // what makes a rule stop travelling between projects.
      var g = familyGroup(t);
      if (g) (by[g] = by[g] || []).push(t);
    });
    var out = [];
    FAMILY_GROUPS.forEach(function (g) {
      if (!by[g]) return;
      // Within a run the project's own token leads, which is what the flat
      // list used to say about the whole list and is the more useful half of
      // it: on volt `sans` is a stock stack the route never draws in and
      // `volt` is the Geist it does.
      by[g].sort(function (a, b) {
        var pa = STOCK_FAMILY[a] ? 1 : 0;
        var pb = STOCK_FAMILY[b] ? 1 : 0;
        return pa - pb || (a < b ? -1 : a > b ? 1 : 0);
      });
      out = out.concat(by[g]);
    });
    return out;
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

  /** Is any radius idiom on this element at all — whole box, edge or corner? */
  function radiusSet(el) {
    return !!el && classesOf(el).some(function (c) { return FAMILY.radiusAny.test(c); });
  }

  /**
   * Radius shows where it would do something, or where it is already doing it.
   *
   * One test, used by the section and by the Add strip that offers it: they
   * used to ask separately and could both answer yes, which put the row and a
   * chip to reveal the row on screen together.
   */
  function radiusVisible(el) {
    return !!(revealed.radius || radiusSet(el) || showsCorners(el));
  }

  /**
   * Which radius idiom is sitting on one base — `rounded`, `rounded-l`,
   * `rounded-tl` — and in what form.
   *
   * The base is matched whole, so `rounded` never swallows `rounded-tl-lg`:
   * the tail would be `tl-lg`, which is not a rung and not bracketed. That is
   * the same membership test the family uses everywhere else, doing double
   * duty as the separator between the three levels.
   */
  function radiusOn(classes, base) {
    for (var i = classes.length - 1; i >= 0; i--) {
      var c = classes[i];
      // A suffix-less `rounded` is the v3 alias, still 0.25rem: 11 uses across
      // these two codebases. Read so it is visible and replaceable; never
      // offered, because rounded-sm is the same value spelled the way v4
      // spells it.
      if (c === base) return { kind: 'legacy', name: base, cls: c };
      if (c.indexOf(base + '-') !== 0) continue;
      var tail = c.slice(base.length + 1);
      if (/^\[[^\]]+\]$/.test(tail)) {
        return { kind: 'arbitrary', name: tail.slice(1, -1), cls: c };
      }
      if (RADII[tail]) return { kind: 'token', name: tail, cls: c };
    }
    return null;
  }

  function readRadius(el) {
    if (!el) return { kind: 'none', value: '', corners: [] };
    var classes = classesOf(el);
    // Only the logical forms are left as written now — the physical edges show
    // up in the two corners they paint, so they need no footnote.
    var corners = classes.filter(function (c) { return FAMILY.radiusLogical.test(c); });
    var own = radiusOn(classes, 'rounded');
    if (own) {
      own.corners = corners;
      return own;
    }
    var now = getComputedStyle(el).borderTopLeftRadius;
    return { kind: 'none', value: parseFloat(now) ? now : '', corners: corners };
  }

  /**
   * What one corner is actually set to, and by which class.
   *
   * Explicit rounded-tl-* wins, then the edge that covers it, then the
   * all-corners class — the order Tailwind emits them in, which is the order
   * the browser paints them in.
   */
  function readCorner(el, corner) {
    if (!el) return { kind: 'none', source: 'none' };
    var classes = classesOf(el);
    var own = radiusOn(classes, 'rounded-' + corner);
    if (own) { own.source = 'explicit'; return own; }
    var under = CORNER_UNDER[corner] || [];
    for (var i = 0; i < under.length; i++) {
      var edge = radiusOn(classes, 'rounded-' + under[i]);
      if (edge) { edge.source = 'inherited'; return edge; }
    }
    var all = radiusOn(classes, 'rounded');
    if (all) { all.source = 'inherited'; return all; }
    return { kind: 'none', source: 'none' };
  }

  /**
   * What a radius field shows: the pixel count, bare, exactly as a spacing
   * field does — nobody should have to know that `lg` is 12 here and 8
   * somewhere else. `full` is the one rung with no pixel count — it computes
   * to `calc(infinity * 1px)`, an eight-digit number no field should print —
   * so it says its own name instead. It used to show `∞`, which was true and
   * unreadable: a symbol nobody types, in a field you type into, standing for
   * the one rung whose class name is already the plainest thing about it.
   */
  function radiusText(state) {
    if (!state || state.kind === 'none') return '';
    if (state.kind === 'token') {
      var n = radiusPx(state.name);
      return n === Infinity ? 'full' : String(n);
    }
    if (state.kind === 'legacy') return String(legacyRadiusPx());
    // A literal in some other unit has to keep it, or it says nothing.
    var px = /^([\d.]+)px$/.exec(String(state.name));
    return px ? px[1] : String(state.name);
  }

  /** What the v3 alias renders as here — the page's own DEFAULT rule, or stock. */
  function legacyRadiusPx() {
    return Math.round(measureRadius(liveRadii().DEFAULT || '0.25rem'));
  }

  /**
   * What this corner renders right now, for a field with no class behind it.
   * `full` computes to a huge number rather than a length, so it is refused
   * instead of printed — but that path only runs when nothing is set at all.
   */
  function computedCorner(el, corner) {
    if (!el) return null;
    var n = parseFloat(getComputedStyle(el)[CORNER_COMPUTED[corner]]);
    return isFinite(n) && n < 1e5 ? Math.round(n) : null;
  }

  /**
   * Clear every idiom that lands on a corner, then write one.
   *
   * Everything is cleared, per-corner classes included: this field is the one
   * above them, the way px-* is the one above pl-* and pr-*, and leaving a more
   * specific class in place means the field just used does nothing. The four
   * corners have fields of their own to put the value back into.
   */
  function setRadius(el, cls) {
    stripFamily(el, FAMILY.radiusAny);
    if (cls) {
      ensureRadiusRule(cls);
      el.classList.add(cls);
    }
    markDirty(el, 'classes');
    refresh();
  }

  /** One corner. Nothing sits below it, so nothing below it is cleared. */
  function setCornerRadius(corner, suffix) {
    if (!selected) return;
    var pattern = new RegExp('^rounded-' + corner + '(?:-|$)');
    if (suffix === null) {
      stripFamily(selected, pattern);
      markDirty(selected, 'classes');
      refresh();
      return;
    }
    var cls = 'rounded-' + corner + '-' + suffix;
    ensureRadiusRule(cls);
    applyClass(selected, cls, pattern);
  }

  /** The class tail for a pixel radius: a rung where one lands, else arbitrary. */
  function radiusSuffixForPx(px) {
    for (var i = 0; i < RADIUS_TOKENS.length; i++) {
      var t = RADIUS_TOKENS[i];
      if (radiusPx(t) === px) return t;
    }
    return '[' + px + 'px]';
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
   *
   * A per-corner rung is the exception to that exception: a route that renders
   * `.rounded-lg` has generated nothing for `.rounded-tl-lg`, so it always
   * needs a rule — built from the live value where there is one, so the corner
   * lands on the same number the whole-box rung does rather than on the stock
   * ladder's.
   */
  function ensureRadiusRule(cls) {
    if (!cls || dynSeen[cls]) return;
    var m = /^rounded(?:-(tl|tr|bl|br))?-(.+)$/.exec(cls);
    if (!m) return;
    var corner = m[1] || '';
    var tail = m[2];
    var value;
    var arb = /^\[([\d.]+(?:px|rem|em|%))\]$/.exec(tail);
    if (arb) {
      value = arb[1];
    } else {
      if (!RADII[tail]) return;
      var live = liveRadii()[tail];
      if (!corner && live) return;
      value = live || RADII[tail];
    }
    var decl = CORNER_PROPS[corner].map(function (p) { return p + ':' + value; }).join(';');
    dynSeen[cls] = true;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.setAttribute('data-tw-editor', 'dynamic');
      document.head.appendChild(dynStyle);
    }
    var sel = (PREVIEW_ATTR ? '[' + PREVIEW_ATTR + ']' : '') + '.' + CSS.escape(cls);
    try {
      dynStyle.sheet.insertRule(sel + '{' + decl + '}', dynStyle.sheet.cssRules.length);
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
    // `full` names itself in the list too, for the reason radiusText gives —
    // and the list is where the name was always going to be read anyway, since
    // that row is the one you click to get it.
    return n === Infinity ? 'full' : n + 'px';
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
      var show = hasOwnText(selected) || revealed.typography || state.kind === 'token';
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

  /**
   * The whole box, as one target among five.
   *
   * `side: null` is what makes it the box rather than a corner: it reads the
   * all-corners class, it writes the all-corners class, and everything else
   * about the field is the same. The frame draws it the same too — a mark, a
   * number, no name and no unit.
   */
  var RADIUS_BOX = { side: null, name: 'radius', key: 'All' };

  /** What one corner's field shows: its own value, or the one it falls back to. */
  function cornerText(el, corner) {
    var text = radiusText(readCorner(el, corner));
    if (text !== '') return text;
    var actual = computedCorner(el, corner);
    return actual === null ? '—' : String(actual);
  }

  /**
   * Do the four corners say the same thing?
   *
   * By what the fields would show, not by class: `rounded-lg` alone agrees
   * with itself four times over, and rounded-tl-[12px] beside it agrees too if
   * that is what lg renders as here. The view opens for a real difference.
   */
  function cornersDisagree(el) {
    if (!el) return false;
    var first = cornerText(el, CORNERS[0].side);
    return CORNERS.some(function (c) { return cornerText(el, c.side) !== first; });
  }

  /** The all-corners class, wearing the same shape a corner read comes back in. */
  function readBox(el) {
    var state = readRadius(el);
    state.source = state.kind === 'none' ? 'none' : 'explicit';
    return state;
  }

  function readRadiusField(el, side) {
    return side ? readCorner(el, side) : readBox(el);
  }

  /**
   * One radius field — the box or one corner — as a number of pixels.
   *
   * The spacing field's idiom, because a radius is a length and the frame
   * writes it as one: 2, 3, 1, 1 in the corners and a bare number above them.
   * The rung is still what gets written where one lands, and the chevron still
   * opens the ladder, so `rounded-lg` is a click away and a literal is a
   * keystroke away — but the panel does not make you know that lg is 12 here
   * and 8 somewhere else before you can read your own element.
   */
  function radiusField(target) {
    var side = target.side;
    var wrap = el('div', 'bw-input');
    wrap.setAttribute('data-tw-field', 'radius-' + (side || 'all'));

    var field = el('div', 'bw-field');
    var mark = el('span', 'bw-ico');
    mark.innerHTML = ICONS['rad' + target.key];
    mark.title = target.name;

    var readout = document.createElement('input');
    readout.className = 'bw-val';
    readout.type = 'text';
    readout.inputMode = 'numeric';
    readout.autocomplete = 'off';
    readout.spellcheck = false;
    readout.placeholder = '—';

    // The logical utilities are the ones left alone by every write, so a
    // lingering rounded-s-lg still wins on the start corners. The box says so
    // rather than showing one radius and meaning two; a corner cannot, because
    // it has no way to know which of them a direction will land on.
    var note = el('span', 'bw-unit', '');

    var snow = snowflake();
    snow.style.display = 'none';

    var open = el('button', 'bw-open');
    // The box keeps data-tw-radius-open; a corner takes its own attribute,
    // because five of one name in a panel is five ways to mean one thing.
    open.setAttribute(side ? 'data-tw-radius-corner' : 'data-tw-radius-open', side || '');
    open.innerHTML = ICONS.chevron;
    open.title = target.name + ' — pick a token';
    open.addEventListener('click', function () {
      if (!RADIUS_TOKENS.length) return;
      popState.prefix = 'radius';
      popState.hue = null;
      popState.corner = side;
      popState.anchor = wrap;
      renderPopover();
      popover.style.display = 'flex';
      placePopover(wrap);
    });

    /** Read exactly as a spacing field reads: pixels, or a length as written. */
    function commit() {
      var raw = readout.value.trim().replace(/\s+/g, '');
      var target2;
      if (raw === '' || raw === '—') {
        target2 = null;
      } else {
        var px = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(raw);
        if (px) target2 = radiusSuffixForPx(Number(px[1]));
        // The one rung this field shows by name is the one rung it takes by
        // name: a field that prints `full` and then refuses `full` typed back
        // cannot round-trip the value it is showing you.
        else if (/^full$/i.test(raw)) target2 = 'full';
        else if (/^[\d.]+(rem|em|%)$/.test(raw)) target2 = '[' + raw + ']';
        else if (/^\[[^\]]+\]$/.test(raw)) target2 = raw;
        // Includes the box's own comma list: tabbing through four values that
        // disagree must not flatten them to the first one.
        else return refresh();
      }
      // Committing the value the field already shows is not an edit — blur
      // fires on every field you merely tab through.
      var wouldBe = target2 === null ? '' : radiusText(
        /^\[/.test(target2) ? { kind: 'arbitrary', name: target2.slice(1, -1) }
          : { kind: 'token', name: target2 });
      if (wouldBe === fieldText()) return refresh();
      writeRadius(side, target2);
    }

    readout.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); readout.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); readout.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        var val = readout.value;
        withStep(function () {
          stepRadius(side, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey, val);
        });
      }
    });
    readout.addEventListener('blur', commit);
    readout.addEventListener('focus', function () { readout.select(); });

    field.appendChild(mark);
    field.appendChild(readout);
    if (!side) field.appendChild(note);
    field.appendChild(snow);
    field.appendChild(open);
    wrap.appendChild(field);

    /** What this field shows right now, whichever of the two it is. */
    function fieldText() {
      return side ? cornerText(selected, side) : boxText(selected);
    }

    readouts.push(function () {
      if (typing(readout)) return; // don't fight the typist
      var state = readRadiusField(selected, side);
      note.textContent = '';

      // Four corners that disagree, said in full. An axis shows `0, 8` for the
      // same reason: one number here would be a lie about three of them, and
      // averaging or naming the disagreement tells you less than the four
      // values do. Upright, not italic — four real values are not one
      // inherited one.
      if (!side && cornersDisagree(selected)) {
        var jit = CORNERS.some(function (c) {
          return readCorner(selected, c.side).kind === 'arbitrary';
        });
        snow.style.display = jit ? '' : 'none';
        readout.placeholder = '—';
        readout.value = CORNERS.map(function (c) {
          return cornerText(selected, c.side);
        }).join(', ');
        readout.className = 'bw-val' + (jit ? ' is-jit' : '');
        readout.title = 'radius: ' + CORNERS.map(function (c) {
          return c.name + ' ' + cornerText(selected, c.side);
        }).join(', ') + ' — typing one value sets all four';
        logicalNote(state);
        return;
      }

      if (state.kind === 'none') {
        // Nothing anywhere in the class list. Where the element genuinely
        // renders square, say 0; where the page's own CSS has rounded it, show
        // that instead, greyed, rather than a zero that is false.
        var actual = computedCorner(selected, side || CORNERS[0].side);
        snow.style.display = 'none';
        readout.value = actual === 0 ? '0' : '';
        readout.placeholder = actual === 0 || actual === null ? '—' : String(actual);
        readout.className = 'bw-val is-unset';
        readout.title = actual === 0
          ? target.name + ': not set, and renders square'
          : actual === null
            ? target.name + ': not set'
            : target.name + ': not set here — the page renders ' + actual + 'px';
        logicalNote(state);
        return;
      }

      var literal = state.kind === 'arbitrary';
      readout.placeholder = '—';
      snow.style.display = literal ? '' : 'none';
      readout.value = radiusText(state);
      readout.className = 'bw-val' +
        (state.source === 'explicit' ? '' : ' is-inherited') +
        (literal ? ' is-jit' : '');
      readout.title = (state.source === 'explicit'
        ? target.name + ': ' + state.cls
        : target.name + ': inherited from ' + state.cls) +
        (state.kind === 'legacy' ? ' — the v3 alias for rounded-sm' : '');
      logicalNote(state);
    });

    function logicalNote(state) {
      if (side || !state.corners || !state.corners.length) return;
      note.textContent = '+' + state.corners.length;
      readout.title += ' — also ' + state.corners.join(' ') + ', left as written';
    }

    return wrap;
  }

  /** Write one radius field: the box clears everything, a corner clears itself. */
  function writeRadius(side, suffix) {
    if (!selected) return;
    if (side) return setCornerRadius(side, suffix);
    if (suffix === null) {
      stripFamily(selected, FAMILY.radiusAny);
      markDirty(selected, 'classes');
      return refresh();
    }
    setRadius(selected, 'rounded-' + suffix);
  }

  /** What the box field shows: one value, or all four when they disagree. */
  function boxText(el) {
    if (cornersDisagree(el)) {
      return CORNERS.map(function (c) { return cornerText(el, c.side); }).join(', ');
    }
    var text = radiusText(readBox(el));
    if (text !== '') return text;
    return cornerText(el, CORNERS[0].side);
  }

  /** The tallest rung that is a length — what `full` steps down onto. */
  function tallestRadiusPx() {
    var top = 0;
    RADIUS_TOKENS.forEach(function (t) {
      var px = radiusPx(t);
      if (px !== Infinity && px > top) top = px;
    });
    return top;
  }

  /**
   * Step a radius field by a pixel, or by ten with Shift held — the same press
   * a spacing field takes, on a field printing the same unit.
   *
   * `shown` is the field's own text, so the box steps from the first of four
   * that disagree rather than from a class it has not got, and a value typed
   * and not yet committed is the one the arrow is pressed against. Stepping
   * below zero drops the class rather than pinning a zero — the only way back
   * to an inherited one, or to a clean class string.
   */
  function stepRadius(side, dir, leap, shown) {
    if (!selected) return;
    var state = readRadiusField(selected, side);
    var text = shown === undefined
      ? (side ? cornerText(selected, side) : boxText(selected))
      : shown;

    // `full` is the one rung with no length to count from — calc(infinity *
    // 1px) — so the one press it can take is down, onto the tallest rung that
    // is a number. Up from it would be a step past infinity.
    if (/^\s*full\s*$/i.test(String(text))) {
      if (dir < 0) writeRadius(side, radiusSuffixForPx(tallestRadiusPx()));
      return;
    }

    var here = stepFrom(text, computedCorner(selected, side || CORNERS[0].side));

    var next = stepLength(here, dir, leap);
    if (next === null) {
      if (state.source === 'explicit') {
        stripFamily(selected, side
          ? new RegExp('^rounded-' + side + '(?:-|$)') : FAMILY.radiusAny);
        markDirty(selected, 'classes');
      }
      return refresh();
    }
    writeRadius(side, radiusSuffixForPx(next));
  }

  /**
   * Radius, laid out as frame 2:270 has it: the all-corners field across the
   * full width with the toggle beside it, and the four corners in a 2x2 grid
   * underneath — top row, then bottom, the order border-radius says them in.
   *
   * The corners sit *under* the field rather than replacing it, which is where
   * this parts from padding and margin. Their toggle swaps two axes for four
   * edges; here there is no middle level to swap to, and the field above is
   * the summary — worth its line while the four are open, because when they
   * disagree it is the only place all four are said at once.
   */
  function radiusSection() {
    var wrap = el('div', 'bw-row top');
    wrap.setAttribute('data-tw-field', 'radius');
    wrap.setAttribute('data-tw-optional', 'radius');
    wrap.appendChild(el('span', 'bw-lbl', 'Radius'));

    var stack = el('div', 'bw-stack');
    stack.appendChild(radiusField(RADIUS_BOX));
    var grid = el('div', 'bw-pair');
    CORNERS.forEach(function (c) { grid.appendChild(radiusField(c)); });
    stack.appendChild(grid);

    var toggle = el('button', 'bw-toggle');
    toggle.innerHTML = ICONS.radAll;
    toggle.setAttribute('data-tw-toggle', 'radius');
    toggle.setAttribute('aria-pressed', 'false');

    wrap.appendChild(stack);
    wrap.appendChild(toggle);

    function render() {
      var open = expanded.radius;
      grid.className = 'bw-pair' + (open ? '' : ' is-hidden');
      toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
      // The box while it is one thing, the four corners while it is four —
      // the swap padding and margin have always made. This toggle wore the
      // all-corners mark in both states because the export had no Parts glyph
      // for radius and drawing one would have been inventing; ic-radius-parts
      // is that file, so the pressed fill is no longer the only thing saying
      // which state the row is in.
      toggle.innerHTML = ICONS[open ? 'radParts' : 'radAll'];
      toggle.title = open
        ? 'Radius: editing each corner \u2014 click to close'
        : 'Radius: all four corners \u2014 click to edit each one';
    }

    toggle.addEventListener('click', function () {
      expanded.radius = !expanded.radius;
      render();
    });

    readouts.push(function () {
      var show = radiusVisible(selected);
      shown.radius = show;
      wrap.style.display = show ? '' : 'none';
      if (!show) return;
      // Decided when the element is selected, never on a refresh: the rule
      // used to re-run on every readout, so collapsing an element that owns
      // per-corner classes lasted until the next keystroke and typing into a
      // corner snapped the view back mid-edit. After this, the toggle owns it.
      if (expandedFor.radius !== selected) {
        expandedFor.radius = selected;
        expanded.radius = cornersDisagree(selected);
      }
      render();
    });

    return wrap;
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
        var show = hasOwnText(selected) || revealed.typography || state.kind === 'token';
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
        (hasOwnText(selected) || revealed.typography || state.kind === 'token');
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
        d.name.textContent =
          familyFace(state.stack) || namedInStack(state.stack) || '\u2014';
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
   * row, weight and size sharing the line below it, the alignment segment
   * below that. Three labels became one because they name one thing, and
   * because at a pair's width a field cannot afford a label beside it.
   *
   * `is-inset` because this row has no toggle at the end of it: without it the
   * stack runs 42px past every other section's, so the family field and the
   * pair under it would both be wider than the Padding row they sit beneath.
   */
  function typographySection() {
    var row = el('div', 'bw-row');
    row.setAttribute('data-tw-section', 'typography');
    row.appendChild(el('span', 'bw-lbl', 'Typography'));

    var stack = el('div', 'bw-stack is-inset');
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
      shown.typography = !!(f || w || z || a);
      row.style.display = shown.typography ? '' : 'none';
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
    var found = { bg: {}, text: {}, border: {}, radius: {}, family: {},
                  familyVar: {}, stroke: {} };

    function walk(rules, inTheme) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];

        // Read this rule BEFORE recursing. With CSS nesting every CSSStyleRule
        // carries a (usually empty) cssRules list, so treating that as "this is
        // a group" skips every real rule — 1580 of them on this page.
        var sel = rule.selectorText;
        if (sel && rule.style && sel.charAt(0) === '.' &&
            sel.indexOf('\\') === -1 && sel.indexOf(' ') === -1) {
          // border- joins bg- and text- here, and the read is the membership
          // test again: `border-` is the trap four ways over — border-2 is a
          // width, border-solid a style, border-collapse a table mode,
          // border-oat a colour — and only the last of them sets border-color,
          // so only the last of them can land in the map.
          var m = /^\.(bg|text|border)-([a-zA-Z][a-zA-Z0-9-]*)$/.exec(sel);
          if (m) {
            var value = m[1] === 'bg' ? rule.style.backgroundColor
              : m[1] === 'border' ? rule.style.borderColor
              : rule.style.color;
            if (value) found[m[1]][m[2]] = value;
          }

          // The stroke's widths and styles, noted by name rather than by
          // value: all the writer needs to know is whether the route has
          // already generated the class, because one it has must be left
          // alone. A scoped copy of a rule the page already owns is the
          // px-6 md:px-12 failure — it outranks the route's own variants and
          // changes the element the moment it is touched.
          if (/^\.border(?:-(?:0|[1-9][0-9]*))?$/.test(sel) &&
              (rule.style.borderWidth || rule.style.borderTopWidth)) {
            found.stroke[sel.slice(1)] = 1;
          }
          if (/^\.border-(?:solid|dashed|dotted|double|hidden|none)$/.test(sel) &&
              rule.style.borderStyle) {
            found.stroke[sel.slice(1)] = 1;
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

        // The other half of what a family can be: a theme variable the page
        // declares but has generated no utility for. Tailwind v4 emits a
        // utility only where the class is in the source, so a token used
        // exclusively through `var(--font-murmur)` — which is how every one of
        // these projects applies its own face, on an inline style at the
        // layout wrapper — has no `.font-murmur` to be discovered by. It is
        // still a writable token: the utility appears the moment the class
        // does, which is exactly what a theme key means.
        //
        // `@layer theme` is the membership test, and a strict one. Tailwind
        // emits its own theme block into that layer and nothing else does:
        // next/font's `--font-geist-mono` lives on a CSS-module class
        // (`.geist_mono_8d43a2aa-module__…`), and writing `font-geist-mono`
        // would preview here and generate nothing on the real build, since it
        // is a plain custom property rather than a theme key. Measured on all
        // three routes: the layer holds sans/serif/mono and the project's own,
        // and next/font's two sit outside it.
        if (inTheme && sel && rule.style && sel.indexOf(':root') !== -1) {
          for (var v = 0; v < rule.style.length; v++) {
            var prop = rule.style[v];
            // --font-weight-* is the one other thing wearing this prefix, the
            // same seam `font-` makes in a class list one level down.
            if (prop.indexOf('--font-') !== 0 || prop.indexOf('--font-weight-') === 0) continue;
            var stack = rule.style.getPropertyValue(prop).trim();
            if (stack) found.familyVar[prop.slice(7)] = stack;
          }
        }

        if (rule.cssRules && rule.cssRules.length) {
          walk(rule.cssRules, inTheme || rule.name === 'theme');
        }
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
      if (rules) walk(rules, false);
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
    // A copy, and the generated utility last: `renderable.family` stays the
    // record of what the page has already drawn, which is what decides
    // whether a preview rule would be shadowing one of its own. Under
    // `@theme inline` the utility is also the truer of the two — cora's
    // `.font-mono` carries `ui-monospace, "Cascadia Code"` while the variable
    // it was built from is not emitted at all.
    FAMILIES = {};
    Object.keys(utils.familyVar).forEach(function (t) { FAMILIES[t] = utils.familyVar[t]; });
    Object.keys(utils.family).forEach(function (t) { FAMILIES[t] = utils.family[t]; });
    familyCache = {}; // a client-routed page can redefine what --font-* means
    faceInk = {};     // and a webfont that arrives late draws differently
    // Union of what bg-*, text-* and border-* can each render; the picker
    // offers names, and ensurePreviewRule fills any gap for the specific prefix
    // in use. A token is a token whichever utility the route happened to
    // generate it under — on uiux_experiment `oat` reaches the palette through
    // border-oat's 30 sites and nothing else.
    var live = {};
    Object.keys(utils.text).forEach(function (n) { live[n] = utils.text[n]; });
    Object.keys(utils.bg).forEach(function (n) { live[n] = utils.bg[n]; });
    Object.keys(utils.border).forEach(function (n) { live[n] = utils.border[n]; });
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

  /**
   * Which property each colour prefix paints, computed and declared.
   *
   * Five call sites were each spelling out the same bg/text pair inline, so
   * adding a third prefix meant finding all five. `borderTopColor` and not the
   * `borderColor` shorthand: getComputedStyle answers '' for a shorthand whose
   * sides disagree, and the four sides of a border disagree far more often
   * than a background does with itself.
   */
  var COLOR_PROP = { bg: 'backgroundColor', text: 'color', border: 'borderTopColor' };
  var COLOR_CSS = { bg: 'background-color', text: 'color', border: 'border-color' };

  // ------------------------------------------------------------ colour maths
  //
  // HSV, because that is the space a picker is a picture of: a square of
  // saturation against value, under the hue it is a square of. RGB has no such
  // picture and HSL's square is a diamond you cannot fill a rectangle with.
  //
  // The state lives in the popover rather than being re-derived from the class
  // on every frame, which is what makes the square behave: white is s=0 at
  // v=1 and has no hue left in it, so a picker that read its hue back off the
  // colour would forget where the strip was the moment you dragged into a
  // corner.

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

  function hexToRgb(hex) {
    var v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function rgbToHsv(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: max ? d / max : 0, v: max };
  }

  /** The hex a point on the square is, which is the thing that gets written. */
  function hsvHex(hsv) {
    var h = ((hsv.h % 360) + 360) % 360 / 60, s = hsv.s, v = hsv.v;
    var i = Math.floor(h), f = h - i;
    var p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    var rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return '#' + rgb.map(function (c) {
      return ('0' + Math.round(c * 255).toString(16)).slice(-2);
    }).join('');
  }

  /**
   * Where the picker opens.
   *
   * The colour the element is actually wearing, whether that is a token, a hex
   * or something the page's own CSS put there — resolved and painted, because
   * a token's value can be a `var(--x)` and an inherited one arrives as
   * `oklch()`. Nothing painted opens at white, which is the value the + row
   * already writes, rather than at the black `rgba(0,0,0,0)` would flatten to.
   */
  function pickerStart(el, prefix) {
    var css = null;
    if (el) {
      var info = readColor(el, prefix);
      css = info ? resolvedColor(info, prefix) : null;
      if (!css) {
        var c = getComputedStyle(el);
        var painted = prefix === 'bg' ? c.backgroundColor
          : prefix === 'text' ? c.color : c.borderTopColor;
        if (isPainted(painted)) css = painted;
      }
    }
    return rgbToHsv(hexToRgb(css ? toHex(css) : '#ffffff'));
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
      // Same rule as px-* clearing pl-*, met on the edge rather than the axis:
      // a box colour that left border-b-oat standing would paint three sides
      // and leave the fourth saying something else, so the field you just used
      // would read as broken on one edge. Zero sites across both codebases —
      // but the clearing costs a membership test, and not clearing costs a bug
      // nobody would look for.
      else if (prefix === 'border' && borderSideColor(c)) el.classList.remove(c);
    });
  }

  /**
   * A per-side colour, separated from a per-side width the way every other
   * `border-` form is separated here: match the side, then test the tail for
   * membership. border-b-oat is a colour, border-b-2 is not.
   */
  function borderSideColor(cls) {
    var m = /^border-([trblxyse])-(.+)$/.exec(cls);
    return !!(m && parseColorClass('border-' + m[2], 'border'));
  }

  /** The CSS value a parsed colour renders as. */
  function colorValue(info) {
    if (!info) return null;
    if (info.kind === 'arbitrary') return info.value;
    var ramp = COLORS && COLORS.ramps[info.hue];
    if (!ramp) return null;
    return info.shade ? ramp[info.shade] : ramp.DEFAULT;
  }

  /**
   * What a token actually paints, which is not always what it says.
   *
   * A ramp entry can be `var(--x)`, and a var resolves against the element it
   * is used on rather than against the panel — so the answer has to be read off
   * the selection. The swatch needs it to show the right colour and the unlink
   * needs it to write the right hex, and the two were working it out their own
   * way before.
   */
  function resolvedColor(info, prefix) {
    var value = colorValue(info);
    if (value && value.indexOf('var(') !== -1 && selected) {
      value = getComputedStyle(selected)[COLOR_PROP[prefix]];
    }
    return value;
  }

  /**
   * The colour this element paints on itself with a `style` attribute.
   *
   * `style={{ color: "var(--polaris-text)" }}` is how three of these routes
   * colour their text, and it leaves nothing in the class list to read — so
   * the panel used to call the element unset, show a dash and an empty
   * swatch, and now offer a + for a colour that is plainly on screen.
   *
   * It also decides more than what to show. An inline declaration beats every
   * class, so a class written here would be inert: the field says where the
   * colour comes from and refuses, rather than writing something that does
   * nothing. Same rule as px-* clearing pl-*, arrived at from the other side.
   */
  function ownColor(el, prefix) {
    if (!el || !el.style) return '';
    if (prefix === 'bg') return el.style.backgroundColor || el.style.background || '';
    // `border` and `borderColor` are both shorthands an author writes, and
    // either wins over every class the same way `color` does.
    if (prefix === 'border') {
      return el.style.borderColor || el.style.borderTopColor || '';
    }
    return el.style.color || '';
  }

  /** Does this element carry this colour itself, by class or by style? */
  function colorSet(el, prefix) {
    return !!(el && (readColor(el, prefix) || ownColor(el, prefix)));
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
        sel + '{' + COLOR_CSS[prefix] + ':' + value + '}',
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

  // What an arrow moves an opacity by, and what Shift moves it by — the same
  // one and ten every length in the panel steps by, counted in percent here
  // because percent is what this field prints. Every integer from 0 to 100 is
  // writable and means something, so one lands on the exact number and ten
  // crosses the range in ten presses.
  var ALPHA_STEP = 1;
  var ALPHA_LEAP = 10;

  /** Rebuild a class with a different alpha; 100 drops the suffix entirely. */
  function withAlpha(info, prefix, alpha) {
    var base = info.kind === 'arbitrary'
      ? prefix + '-[' + info.value + ']'
      : prefix + '-' + (info.shade ? info.hue + '-' + info.shade : info.hue);
    return alpha >= 100 ? base : base + '/' + alpha;
  }

  // ---------------------------------------------------------- colour popover

  var popover = null;
  // The ramp is a dropdown of its own standing beside the palette, not a second
  // view inside it. Two elements, so `hue` no longer means "which of my two
  // views am I showing" — it means which ramp is open next door.
  var shadePop = null;
  var popState = { prefix: null, hue: null, anchor: null, spacing: null, corner: null,
    // Where the picker's two knobs are. Kept here rather than derived from
    // the class each frame, so a drag into a corner does not lose the hue.
    hsv: { h: 0, s: 0, v: 1 } };

  function closePopover() {
    if (popover) popover.style.display = 'none';
    if (shadePop) shadePop.style.display = 'none';
    popState.prefix = null;
    popState.hue = null;
    popState.anchor = null;
    markOpenAnchor();
  }

  /**
   * Shutting the ramp leaves the palette open, which is the whole point of it
   * being a second box: you came back from a ramp to the colours, and the
   * colours never went away. Re-renders the palette only to take the ring off
   * the swatch that owned it.
   */
  function closeShades() {
    popState.hue = null;
    if (shadePop) shadePop.style.display = 'none';
    if (popoverOpen()) renderPopover();
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
    popover = mountPop('data-tw-pop');
    // Its own attribute rather than a second `data-tw-pop`: everything that
    // hit-tests a popover wants both, and everything that addresses one wants
    // exactly one of them.
    shadePop = mountPop('data-tw-pop-shade');
  }

  function mountPop(attr) {
    var node = el('div', 'bw-pop');
    node.setAttribute(attr, '');
    // Marked as an editor surface so clicks inside it never select the page,
    // and mounted on <body> rather than the panel — the panel clips its
    // overflow, which cut the list off at the panel edge.
    node.setAttribute('data-tw-editor', 'popover');
    node.style.display = 'none';
    bindTheme(node);
    document.body.appendChild(node);
    return node;
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
    placeShades();

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
      // The label can carry the demonstration itself — a size set at its own
      // size, a weight at its own weight — which is what let the Ag column go.
      var labelNode = el('span', 'bw-sizename', shown);
      item.appendChild(labelNode);
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
        opt.previewCustom(customSample, pending, customName);
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

  /**
   * Every popover that is a LIST names itself here. Anything else is a
   * colour, which is what the body falls through to — so this one map is
   * where "is this a colour" is decided, rather than a second enumeration
   * beside it.
   *
   * It was a second enumeration, and it drifted the moment the stroke section
   * reused colorField: `border` reached the colour body and was correctly
   * titled Color, while the width test still named bg and text only. So the
   * stroke's picker opened at the list's 220px with the eleven-square grid
   * built for 322 spilling out the side of it. A colour row added next year
   * gets the right box by construction now; a new list has to be registered,
   * and the place it registers is the place its title already lives.
   */
  var POP_TITLES = {
    font: 'Font size', family: 'Font family', weight: 'Weight',
    radius: 'Radius', strokeStyle: 'Stroke style',
  };
  // spacing names itself from the field that opened it, so it is the one list
  // whose title cannot sit in the map.
  function popIsColor() {
    return !!popState.prefix && popState.prefix !== 'spacing' && !POP_TITLES[popState.prefix];
  }

  function renderPopover() {
    markOpenAnchor();
    popover.classList.toggle('is-wide', popState.prefix === 'family');
    // Every colour view is the same grid, so every one gets the width the
    // grid needs — see POP_TITLES for why this is not a list of prefixes.
    popover.classList.toggle('is-swatches', popIsColor());
    popover.innerHTML = '';
    var head = el('div', 'bw-pop-h');

    head.appendChild(el('strong', null,
      popState.prefix === 'spacing' ? popState.spacing.name
        : POP_TITLES[popState.prefix] || 'Color'));
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
        // The note says what KIND of face this is, in CSS's own words — not
        // which slot of this project's theme it came out of. `meridian` and
        // `meridian-mono` are names one codebase invented, and they were
        // sitting in the one column that ought to read the same whatever
        // project the editor is pointed at. The token is not lost: it is in
        // the tooltip below, with the stack it resolves to, which is where
        // the rest of this panel keeps the exact thing behind a value.
        //
        // The list is still ordered by that kind, so the sans faces stand
        // together and the runs are legible without a heading over each.
        item.appendChild(el('span', 'bw-sizepx', familyGroup(t)));
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
      // The list is already only what the font ships — a weight it does not
      // have is not offered, and one that is set but not shipped is kept and
      // labelled `faux` on its own row. That is the whole of what the caption
      // above it used to say, said by the rows themselves.
      var shownW = WEIGHT_TOKENS.filter(function (t) {
        if (!available) return true;                       // unknown: offer all
        if (available[t]) return true;
        return currentW.kind === 'token' && currentW.name === t; // keep what is set
      });
      shownW.forEach(function (t) {
        var item = el('button', 'bw-hue');
        item.setAttribute('data-tw-weight', t);
        // Rows of one weight, like every other list in the panel. The names
        // used to be set in the weight they name, in the element's own face;
        // the number on the right says the same thing without turning nine
        // rows into nine different-looking rows.
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

    if (popState.prefix === 'strokeStyle') {
      var currentS = readBorderStyle(selected);
      // The four that draw something, and whichever of the two that do not is
      // actually set — kept in the list for the reason a faux weight is kept:
      // a value the field is showing must have a row of its own, or the way
      // off it is to guess.
      var shownS = BORDER_STYLES.concat(
        BORDER_OFF.filter(function (t) { return currentS.name === t; }));
      shownS.forEach(function (t) {
        var item = el('button', 'bw-hue');
        item.setAttribute('data-tw-stroke', t);
        item.appendChild(el('span', 'bw-sizename', t.charAt(0).toUpperCase() + t.slice(1)));
        // The specimen is the value: a 2px line in the style it names, which
        // is the one thing about a border style that a name cannot say. Every
        // other list in the panel is one row of one size for a reason, and
        // this does not break it — the rule is the value, not a rendering of
        // the row's own type at some capped scale.
        var rule = el('span', 'bw-strokebar');
        rule.style.borderTopStyle = t === 'hidden' || t === 'none' ? 'solid' : t;
        if (t === 'hidden' || t === 'none') rule.style.opacity = '.25';
        item.appendChild(rule);
        if (currentS.name === t) item.setAttribute('aria-current', 'true');
        item.title = 'border-' + t;
        item.addEventListener('click', function () {
          setBorderStyle(t);
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
        // Rows of one size, like every other list in the panel. The names used
        // to be set at the size they name, which made the list a type ramp —
        // but a ramp that had to be capped to keep a row a row, so the sizes
        // it drew stopped being the sizes it named exactly where they got
        // interesting. The px on the right was carrying the true value the
        // whole time; now it carries it alone.
        sample: function (node) { node.className = 'bw-nosample'; },
        meta: function (t) { return pxOfToken('text-' + t); },
        isCurrent: function (t) { return current.kind === 'scale' && current.name === 'text-' + t; },
        pick: function (t) { setFontSize(selected, 'text-' + t); },
        previewCustom: function () {},
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
      // One ladder, two targets: the whole box, or the corner whose chevron
      // opened it. The list is identical either way — a corner takes the same
      // rungs the box does, spelled rounded-tl-lg.
      var rc = popState.corner;
      var currentR = rc ? readCorner(selected, rc) : readRadius(selected);
      tokenList(body, {
        tokens: RADIUS_TOKENS,
        placeholder: 'Search',
        attrs: { item: 'data-tw-radius', filter: 'data-tw-radius-filter', custom: 'data-tw-radius-custom' },
        // The row is the length and nothing else, exactly as the spacing list
        // is: no corner drawn beside it — a preview capped so a row stays a
        // row said the same thing twice and said it less exactly — and no rung
        // name to translate, because `lg` is 12 here and 8 somewhere else.
        // `full` is the one rung with no length behind it and keeps its symbol.
        // The filter still searches the token, so typing `xl` still finds it.
        sample: function (node) { node.className = 'bw-nosample'; },
        label: function (t) { return pxOfRadius(t); },
        meta: function () { return ''; },
        isCurrent: function (t) {
          return currentR.kind === 'token' && currentR.name === t &&
            (!rc || currentR.source === 'explicit');
        },
        pick: function (t) {
          if (rc) setCornerRadius(rc, t);
          else setRadius(selected, 'rounded-' + t);
        },
        previewCustom: function () {},
        pickCustom: function (v) {
          if (rc) setCornerRadius(rc, '[' + v + 'px]');
          else setRadius(selected, 'rounded-[' + v + 'px]');
        },
      });
      return;
    }

    {
      body.appendChild(colorPicker());
      // Project tokens first, then the stock palette. These codebases use the
      // stock ramps close to zero times — they speak bark, brand-teal,
      // background — so offering emerald-500 first would be offering the wrong
      // vocabulary.
      var swatches = el('div', 'bw-swatches');
      COLORS.order.forEach(function (hue, i) {
        var ramp = COLORS.ramps[hue];
        if (i === 0 && COLORS.projectCount) swatches.appendChild(el('div', 'bw-pop-group', 'Theme'));
        if (i === COLORS.projectCount) swatches.appendChild(el('div', 'bw-pop-group', 'Palette'));
        var value = ramp['500'] || ramp.DEFAULT;
        var item = el('button', 'bw-swatch' + (value ? '' : ' is-empty'));
        item.setAttribute('data-tw-hue', hue);
        item.style.background = value || '';
        // The name has nowhere to be printed now, so it is the tooltip — and
        // a ramp says it opens rather than applies, because clicking it does.
        item.title = ramp.DEFAULT ? popState.prefix + '-' + hue : hue + ' \u2014 pick a shade';
        // The ring says which ramp the box beside this one is holding. The
        // grid is the only thing on screen that can say it: a second dropdown
        // of eleven blues has nothing in it to point back at where they came
        // from.
        if (popState.hue === hue) item.classList.add('is-open');
        item.addEventListener('click', function () {
          if (ramp.DEFAULT) { applyColor(popState.prefix, popState.prefix + '-' + hue); closePopover(); return; }
          // Clicking the open ramp again shuts it, the way pressing an open
          // menu's own button does.
          if (popState.hue === hue) { closeShades(); return; }
          openShades(hue);
        });
        swatches.appendChild(item);
      });
      body.appendChild(swatches);
    }

    // The list is a list of colours and nothing else. What you can do to the
    // colour already on the element is drawn in the row it is on — the unlink
    // in the field, the minus in the tile beside it — where both are on screen
    // the whole time rather than one click inside a list you opened to change
    // the colour, not to take it off.

    popover.appendChild(body);
    if (popState.anchor) placePopover(popState.anchor);
  }

  /**
   * The ramp, as a dropdown of its own standing beside the palette.
   *
   * It used to be the palette's second view, reached by clicking a hue and left
   * by a back chevron — which meant the eleven blues arrived exactly where the
   * colours had been, and the only way to compare a ramp against the palette it
   * came out of was to remember one of them. Two boxes say it at once: the grid
   * stays where it was with a ring on the hue you opened, and its eleven shades
   * stand next to it. The chevron goes with the view it existed to leave, and
   * `ICONS.back` with it — this was its only use.
   */
  function openShades(hue) {
    popState.hue = hue;
    renderPopover();
    renderShades();
  }

  function renderShades() {
    if (!popState.hue || !COLORS.ramps[popState.hue]) return;
    var ramp = COLORS.ramps[popState.hue];
    shadePop.className = 'bw-pop is-shades';
    shadePop.innerHTML = '';

    // The same header the palette wears, named for the ramp — and no chevron
    // in front of it, because what a back button would return to is already
    // on screen to the right of this one.
    var head = el('div', 'bw-pop-h');
    head.appendChild(el('strong', null, popState.hue));
    var shut = el('button', 'bw-x');
    shut.innerHTML = ICONS.close;
    shut.setAttribute('data-tw-shades-close', '');
    shut.addEventListener('click', closeShades);
    head.appendChild(shut);
    shadePop.appendChild(head);

    var body = el('div', 'bw-pop-body');
    // The same grid the palette is, because it is the same act: a ramp is
    // eleven colours and picking one of them is picking a colour. The shade
    // number is the tooltip, as every other name in these grids is.
    var grid = el('div', 'bw-swatches');
    Object.keys(ramp).forEach(function (shade) {
      var cell = el('button', 'bw-swatch');
      cell.style.background = ramp[shade];
      cell.title = popState.prefix + '-' + popState.hue + '-' + shade;
      cell.setAttribute('data-tw-shade', shade);
      cell.addEventListener('click', function () {
        applyColor(popState.prefix, popState.prefix + '-' + popState.hue + '-' + shade);
        closePopover();
      });
      grid.appendChild(cell);
    });
    body.appendChild(grid);
    shadePop.appendChild(body);

    shadePop.style.display = 'flex';
    placeShades();
  }

  /**
   * To the left of the palette, and to its right when the panel is near enough
   * the left edge that there is no room. Placed off the palette rather than off
   * the field, because it is beside the palette and not beside the row — so it
   * travels with it, including through the settling frame that placePopover
   * schedules after a scroll.
   *
   * Levelled on the first square of each, not on the two boxes and not on the
   * two grids. The boxes are nothing alike — one is a header over a row of
   * eleven, the other a header over a picker, a caption and three rows — so
   * tops level put a row of shades against the palette's picker and lined up
   * nothing you were looking at. The grid boxes are no better: the palette's
   * begins at its "Theme" caption, which spans the row and is a good 27px of
   * text nobody is comparing shades against, so grid to grid leaves the two
   * rows visibly out by exactly that caption. Square to square, the eleven
   * shades land on the same line as the first eleven hues and the pair reads
   * as one grid that happens to be in two boxes — same square, same gap, same
   * line, on both sides of the seam.
   */
  function placeShades() {
    if (!popState.hue || !shadePop || shadePop.style.display === 'none') return;
    var p = popover.getBoundingClientRect();
    var w = shadePop.offsetWidth || 312;
    var h = shadePop.offsetHeight || 100;
    var gap = 6;
    var edge = 8;

    var left = p.left - gap - w;
    if (left < edge) {
      var right = p.right + gap;
      left = right + w <= window.innerWidth - edge
        ? right
        : Math.max(edge, window.innerWidth - w - edge);
    }
    shadePop.style.left = Math.round(Math.max(edge, left)) + 'px';

    var fit = function (t) {
      return Math.max(edge, Math.min(t, window.innerHeight - h - edge));
    };
    var top = fit(p.top);
    shadePop.style.top = Math.round(top) + 'px';

    // Measured after that first placement rather than computed from the two
    // headers: the palette's body scrolls, so where its first square actually
    // sits is a question only the laid-out box can answer.
    var theirs = popover.querySelector('.bw-swatch');
    var mine = shadePop.querySelector('.bw-swatch');
    if (!theirs || !mine) return;
    top = fit(top + (theirs.getBoundingClientRect().top - mine.getBoundingClientRect().top));
    shadePop.style.top = Math.round(top) + 'px';
  }

  /**
   * The picker: a saturation/value square under a hue strip, above the presets.
   *
   * It sits on top of the grid rather than beside it because the popover is a
   * column and a column costs no width — side by side would want ~560px against
   * a 352px panel. And on top rather than under, because it is the control that
   * can say any colour at all: the presets below it are the shortcuts.
   *
   * The square needs no canvas. Black up the vertical, white across the
   * horizontal, the hue behind both — three layers of the same box, so
   * changing hue is one custom property and never a redraw.
   */
  function colorPicker() {
    var wrap = el('div', 'bw-picker');
    wrap.setAttribute('data-tw-picker', popState.prefix);

    var sv = el('div', 'bw-sv');
    sv.setAttribute('data-tw-sv', '');
    var svKnob = el('span', 'bw-knob');
    sv.appendChild(svKnob);

    var strip = el('div', 'bw-strip');
    strip.setAttribute('data-tw-strip', '');
    var hueKnob = el('span', 'bw-knob');
    strip.appendChild(hueKnob);

    wrap.appendChild(sv);
    wrap.appendChild(strip);

    // Read once when the drag starts, not per frame: dragging changes which
    // colour is written, never how opaque it is, and the opacity field beside
    // the swatch is what owns that.
    var alpha = 100;
    var last = null;

    function paint() {
      var hsv = popState.hsv;
      sv.style.setProperty('--bw-sv-hue', 'hsl(' + hsv.h + ' 100% 50%)');
      svKnob.style.left = (hsv.s * 100) + '%';
      svKnob.style.top = ((1 - hsv.v) * 100) + '%';
      svKnob.style.background = hsvHex(hsv);
      hueKnob.style.left = (hsv.h / 360 * 100) + '%';
      hueKnob.style.top = '50%';
      hueKnob.style.background = 'hsl(' + hsv.h + ' 100% 50%)';
    }

    function write() {
      var hex = hsvHex(popState.hsv);
      // The same point twice is not an edit. A pointer at rest still fires,
      // and every write here costs a class, a rule and a history step.
      if (hex === last) return;
      last = hex;
      applyColor(popState.prefix,
        withAlpha({ kind: 'arbitrary', value: hex }, popState.prefix, alpha));
      dragRun = true;
    }

    function drag(target, move) {
      target.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        target.setPointerCapture(e.pointerId);
        var live = readColor(selected, popState.prefix);
        alpha = live ? live.alpha : 100;
        // The first write of the drag opens its own history step; every one
        // after it folds into that step rather than adding another.
        dragRun = false;
        last = null;
        move(e);
        var onMove = function (ev) { move(ev); };
        var onUp = function (ev) {
          target.releasePointerCapture(ev.pointerId);
          target.removeEventListener('pointermove', onMove);
          target.removeEventListener('pointerup', onUp);
          target.removeEventListener('pointercancel', onUp);
          dragRun = false;
        };
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
        target.addEventListener('pointercancel', onUp);
      });
    }

    drag(sv, function (e) {
      var r = sv.getBoundingClientRect();
      popState.hsv.s = clamp01((e.clientX - r.left) / r.width);
      popState.hsv.v = 1 - clamp01((e.clientY - r.top) / r.height);
      paint();
      write();
    });
    drag(strip, function (e) {
      var r = strip.getBoundingClientRect();
      popState.hsv.h = clamp01((e.clientX - r.left) / r.width) * 360;
      paint();
      write();
    });

    paint();
    return wrap;
  }

  function openPopover(prefix, anchor) {
    if (!COLORS) return;
    popState.prefix = prefix;
    var current = readColor(selected, prefix);
    popState.hue = current && current.kind === 'token' && current.shade ? current.hue : null;
    popState.hsv = pickerStart(selected, prefix);
    renderPopover();
    popover.style.display = 'flex';
    popState.anchor = anchor;
    placePopover(anchor);
    // Measured off the palette, so the palette has to be on screen first.
    if (popState.hue) renderShades();
  }

  // -------------------------------------------------------------- colour row

  /**
   * The colour control itself: the field, and the opacity field beside it.
   *
   * Pulled out of colorRow when Stroke arrived, because frame 7:687 draws the
   * same object in a different arrangement — no label of its own, a section's
   * name above it, and a pair of fields underneath. What the two rows share is
   * everything inside the 260px; what they do not share is the row around it
   * and what the tile beside it means. So the caller owns the row and the tile,
   * and this owns the colour.
   */
  function colorField(prefix) {
    var field = el('div', 'bw-field bw-color');

    // The swatch opens the list and nothing else does. The whole field used to
    // be the button, which left the value with no way to be typed into — and a
    // hex is a thing people arrive holding, out of a design file or another
    // tab, so the one value in this panel you most want to paste was the one
    // you could only pick. The colour block is the obvious half to keep: it is
    // what a picker looks like everywhere, and the value beside it now behaves
    // like every other value in the panel, which is to say you can type in it.
    var token = el('button', 'bw-cswatch');
    token.setAttribute('data-tw-color-open', prefix);
    var chip = el('span', 'bw-chip');
    token.appendChild(chip);
    token.addEventListener('click', function () { openPopover(prefix, field); });

    var name = document.createElement('input');
    name.className = 'bw-cname';
    name.type = 'text';
    name.spellcheck = false;
    name.setAttribute('data-tw-color-text', prefix);
    name.placeholder = '—';
    // A hex is a literal, the same as p-[13px] or rounded-[3px], and this was
    // the one field in the panel that did not say so. It sits where a unit
    // sits, at the field's own 12px gutter.
    var snow = snowflake();
    snow.style.display = 'none';

    // Frame 7:620 puts the unlink in the field, in the right-hand slot the
    // chevron otherwise owns. It had been a row in the list the field opens,
    // where it went when the field's controls were pulled out wholesale — a
    // control beside the value reads as "delete this" whatever its icon says.
    // What made that true was that removal lived there too; removal is now the
    // tile in the toggle column, so the one mark left in the field is not a
    // delete and cannot be read as one.
    var loose = el('button', 'bw-unlink');
    loose.setAttribute('data-tw-detach', prefix);
    loose.innerHTML = ICONS.unlink;
    loose.title = 'Keep the color, drop the token — then its opacity can be set';
    loose.addEventListener('click', function (e) {
      e.stopPropagation();
      var live = readColor(selected, prefix);
      if (!live || live.kind !== 'token') return;
      applyColor(prefix, withAlpha(
        { kind: 'arbitrary', value: toHex(resolvedColor(live, prefix)) },
        prefix, live.alpha));
    });

    // A field of its own, 57 wide, because that is what the frame draws — and
    // it takes its 57 and its 12 out of the colour field beside it rather than
    // out of the row, so the tile after them holds still in either state.
    var alphaBox = el('div', 'bw-field bw-alpha');
    var alphaInput = document.createElement('input');
    alphaInput.className = 'bw-alpha-in';
    alphaInput.type = 'text';
    alphaInput.inputMode = 'numeric';
    alphaInput.setAttribute('data-tw-alpha', prefix);
    alphaBox.appendChild(alphaInput);
    alphaBox.appendChild(el('span', 'bw-pct', '%'));
    var sizer = el('span', 'bw-alpha-sz');
    sizer.setAttribute('aria-hidden', 'true');
    alphaBox.appendChild(sizer);
    function sizeAlpha() {
      sizer.textContent = alphaInput.value || '0';
      alphaInput.style.width = Math.ceil(sizer.getBoundingClientRect().width) + 1 + 'px';
    }
    alphaInput.addEventListener('input', sizeAlpha);

    field.appendChild(token);
    field.appendChild(name);
    field.appendChild(snow);
    field.appendChild(loose);

    /**
     * What was typed, if it is a colour.
     *
     * Two vocabularies, because the field speaks two: `#4837ca` (or `4837ca`,
     * or `#48c`) is a literal, and `emerald-500`, `clay`, `bg-clay-100/40` is
     * a token on the scale. Anything else is not refused with a message — the
     * field simply puts back what it was showing, the way a spacing field does
     * with a word typed into it.
     */
    function classFromText(text) {
      var t = String(text || '').trim().toLowerCase();
      if (!t) return null;
      var alpha = 100;
      var slash = t.indexOf('/');
      if (slash !== -1) {
        var a = parseInt(t.slice(slash + 1), 10);
        if (isNaN(a)) return null;
        alpha = Math.max(0, Math.min(100, a));
        t = t.slice(0, slash);
      }
      var hex = t.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
      if (hex) {
        var v = hex[1].length === 3
          ? hex[1].replace(/./g, function (c) { return c + c; })
          : hex[1];
        return withAlpha({ kind: 'arbitrary', value: '#' + v }, prefix, alpha);
      }
      if (!COLORS) return null;
      // `bg-clay-100` and `clay-100` are the same request; the prefix is the
      // panel's business, not the typist's.
      var nameOnly = t.indexOf(prefix + '-') === 0 ? t.slice(prefix.length + 1) : t;
      // A whole-name ramp first: `brand-teal` is one token, not `brand` at
      // shade `teal`, and only the map knows which of the two a name is.
      if (COLORS.ramps[nameOnly] && COLORS.ramps[nameOnly].DEFAULT) {
        return withAlpha({ kind: 'token', hue: nameOnly, shade: null }, prefix, alpha);
      }
      var cut = nameOnly.lastIndexOf('-');
      if (cut > 0) {
        var hue = nameOnly.slice(0, cut), shade = nameOnly.slice(cut + 1);
        var ramp = COLORS.ramps[hue];
        if (ramp && ramp[shade]) {
          return withAlpha({ kind: 'token', hue: hue, shade: shade }, prefix, alpha);
        }
      }
      return null;
    }

    function commitText() {
      var cls = classFromText(name.value);
      var live = readColor(selected, prefix);
      // Committing what the field already shows is not an edit. Blur fires on
      // every field you tab through, and without this each one marked the
      // element dirty and pushed a history step that undid to itself.
      if (!cls || (live && cls === live.cls)) return refresh();
      applyColor(prefix, cls);
    }

    name.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitText(); name.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); name.blur(); }
    });
    name.addEventListener('blur', commitText);

    function commitAlpha() {
      var info = readColor(selected, prefix);
      if (!info) return refresh();
      var n = Math.round(parseFloat(alphaInput.value));
      if (isNaN(n)) return refresh();
      applyColor(prefix, withAlpha(info, prefix, Math.max(0, Math.min(100, n))));
    }
    /**
     * Count the opacity up or down — by one, or by ten with Shift held.
     *
     * A press is a percent and Shift is ten of them — 37 goes to 38 or to 47,
     * never to a number the person did not ask for. The same press every
     * length in the panel takes, counted in the unit the field prints. It
     * reads the field rather than the class because the field is what is on
     * screen: a value typed and not yet committed is the one the arrow is
     * being pressed against.
     */
    function stepAlpha(dir, leap) {
      var info = readColor(selected, prefix);
      if (!info) return;
      var typed = Math.round(parseFloat(alphaInput.value));
      var from = isNaN(typed) ? info.alpha : Math.max(0, Math.min(100, typed));
      var next = from + dir * (leap ? ALPHA_LEAP : ALPHA_STEP);
      next = Math.max(0, Math.min(100, next));
      // Both ends stop rather than wrap, and a step that changes nothing is not
      // an edit — the same guard the spacing fields keep, for the same reason:
      // it would mark the element dirty and push a history entry that undoes
      // to itself. 0 keeps the colour, unlike spacing's step below zero: the
      // opacity is a suffix on the class, not the class, so there is nothing
      // to drop but the transparency itself.
      if (next === from) return;
      applyColor(prefix, withAlpha(info, prefix, next));
      // refresh() leaves a focused input alone so it never fights the typist,
      // so the step has to put its own value in — otherwise the blur that
      // follows commits the stale text back and the step undoes itself.
      alphaInput.value = String(next);
      sizeAlpha();
    }

    alphaInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitAlpha(); alphaInput.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); alphaInput.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        stepAlpha(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
      }
    });
    alphaInput.addEventListener('blur', commitAlpha);

    /**
     * Draw the current value, and report what it is.
     *
     * The caller decides what to do with the answer — a colour row hides
     * itself on `set` being false, where inside a section the section has
     * already decided it is on screen and the field simply says "—".
     */
    function sync() {
      var info = readColor(selected, prefix);
      var inline = ownColor(selected, prefix);

      // An inline declaration outranks anything the panel could write, so the
      // field shows what is actually painted and stops there.
      token.disabled = !!inline;
      name.disabled = !!inline;
      field.classList.toggle('is-locked', !!inline);
      // The unlink is offered on a token and nowhere else: an arbitrary colour
      // has no token to come off, and a locked one cannot be written at all. It
      // also owns the slot the chevron sits in, so the field is told to keep the
      // chevron out of it rather than the two landing on top of each other on
      // the hover that reveals one of them.
      var tokenSet = !inline && !!info && info.kind === 'token';
      loose.style.display = tokenSet ? '' : 'none';
      field.classList.toggle('has-unlink', tokenSet);

      if (inline) {
        var painted = getComputedStyle(selected)[COLOR_PROP[prefix]];
        chip.style.background = painted;
        chip.className = 'bw-chip' + (isPainted(painted) ? '' : ' is-empty');
        // Upper case, the way colorLabel spells an arbitrary hex: one hex is
        // one hex however the panel came by it.
        name.value = (toHex(painted) || painted).toUpperCase();
        name.className = 'bw-cname is-unset';
        snow.style.display = 'none';
        alphaBox.style.display = 'none';
        token.title = 'set by a style attribute (' + inline + ')' +
          ' — an inline color outranks every class, so the panel cannot change it here';
        return { set: true, inline: inline };
      }

      var value = info ? resolvedColor(info, prefix) : '';
      chip.style.background = value || 'transparent';
      chip.className = 'bw-chip' + (value ? '' : ' is-empty');
      var literal = !!info && info.kind === 'arbitrary';
      // Never over the typist: refresh runs on every keystroke elsewhere in
      // the panel, and this field is one you are in the middle of a word in.
      if (document.activeElement !== name) name.value = info ? colorLabel(info) : '';
      // is-custom is the italic-and-a-shade-back the whole panel uses for a
      // literal, set from the same condition as the snowflake so the two can
      // never disagree — which a suite asserts across every field at once.
      name.className = 'bw-cname' + (info ? (literal ? ' is-custom' : '') : ' is-unset');
      snow.style.display = literal ? '' : 'none';

      var detached = literal;
      field.setAttribute('data-detached', detached ? 'true' : 'false');
      // Frame 7:622: opacity is what a hex has and a token does not. A token is
      // a name on a scale and `clay-100/40` is a fourth kind of thing again —
      // the way to set one is to come off the token first, which is what the
      // unlink beside it is for.
      alphaBox.style.display = detached ? '' : 'none';
      if (detached && document.activeElement !== alphaInput) {
        alphaInput.value = String(info.alpha);
        sizeAlpha();
      }
      token.title = info
        ? (detached ? 'Arbitrary color — open the palette to pick a token'
          : prefix + '-' + colorLabel(info))
        : 'No color set — open the palette to pick one';
      name.title = 'Type a hex or a token name';
      return { set: !!info, inline: '' };
    }

    return { field: field, alphaBox: alphaBox, sync: sync };
  }

  function colorRow(prefix, label) {
    var row = el('div', 'bw-row');
    row.setAttribute('data-tw-field', prefix === 'bg' ? 'bgColor' : 'textColor');
    row.appendChild(el('span', 'bw-lbl', label));

    var c = colorField(prefix);
    row.appendChild(c.field);
    row.appendChild(c.alphaBox);

    // The same 40x40 tile in the same column the + occupies, so pressing one
    // leaves the cursor over the other: taking a colour off folds the row back
    // to the reveal row that offers it again. Removal used to be a named row in
    // the popover and had to keep `revealed` set, because a field vanishing
    // from under the cursor that had just reached into a list to remove it was
    // worse than a row that said nothing. Nothing vanishes from under this one
    // — the tile it was clicked in is the tile the + lands in.
    var drop = el('button', 'bw-toggle');
    drop.setAttribute('data-tw-color-none', prefix);
    drop.innerHTML = ICONS.minus;
    drop.title = prefix === 'bg' ? 'Remove background' : 'Remove text color';
    drop.addEventListener('click', function () {
      revealed[prefix] = false;
      applyColor(prefix, null);
    });
    row.appendChild(drop);

    readouts.push(function () {
      var info = readColor(selected, prefix);
      var inline = ownColor(selected, prefix);
      var show = !!(revealed[prefix] || info || inline);
      shown[prefix] = show;
      row.style.display = show ? '' : 'none';
      if (!show) return;
      var state = c.sync();
      // Nothing to take off an inline colour: the class list is empty and the
      // style attribute is not this panel's to edit.
      drop.style.display = state.inline ? 'none' : '';
    });

    return row;
  }

  // -------------------------------------------------------------- the stroke

  /**
   * Stroke, frame 7:687: a colour across the row, style beside width under it.
   *
   * `border-` is the trap four ways over — border-2 is a width, border-solid a
   * style, border-oat a colour, border-t-2 one edge's width, and border-collapse
   * is not a stroke at all. Each is matched by its own exact test, and the
   * colour by ramp membership, so no one of them can ever strip another. This
   * is the same rule the three text- families already live by.
   */
  var BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'];
  // hidden and none are read and never offered. Both render nothing while
  // leaving the colour and the width in the class list, so the element would
  // say one thing in the file and another on screen — and the tile beside the
  // label already removes a stroke outright, which is the honest way to say it.
  // A stroke that is authored with one still shows it, so it can be got off.
  var BORDER_OFF = ['hidden', 'none'];
  // The widths Tailwind ships a utility for, which is all this list decides
  // now the arrows count pixels: a width that lands on one is written as the
  // class and anything else becomes border-[3px], the way spacing and radius
  // do. 1 is written `border`, never `border-1` — the bare utility is what
  // Tailwind ships and what these codebases actually use, 101 sites on
  // uiux_experiment against zero for every numbered width put together.
  var BORDER_WIDTHS = [0, 1, 2, 4, 8];

  var BORDER_W_RE = /^border(?:-(0|[1-9][0-9]*))?$/;
  // A length, not a colour: border-[#c0392b] starts the same way and is two of
  // the two arbitrary border classes on uiux_experiment.
  var BORDER_W_ARB = /^border-\[([0-9.]+(?:px|r?em)?)\]$/;
  var BORDER_SIDE_W = /^border-[trblxyse](?:-(?:[0-9]+|\[[^\]]+\]))?$/;
  var BORDER_STYLE_RE = /^border-(solid|dashed|dotted|double|hidden|none)$/;

  /** Every side's rendered width, in the order border-width says them. */
  function computedBorder(el) {
    if (!el) return null;
    var cs = getComputedStyle(el);
    return ['Top', 'Right', 'Bottom', 'Left'].map(function (side) {
      return Math.round(parseFloat(cs['border' + side + 'Width']) || 0);
    });
  }

  /**
   * The width this element sets on itself, if it sets one.
   *
   * `border` on its own is 1px, so it reads as the rung 1 and is written back
   * as itself. Anything with no rung behind it becomes border-[3px] and takes
   * the snowflake, exactly as spacing and radius do.
   */
  function readBorderWidth(el) {
    if (!el) return { px: null, raw: null, from: null, arbitrary: false };
    var classes = classesOf(el);
    for (var i = classes.length - 1; i >= 0; i--) {
      var cls = classes[i];
      var arb = BORDER_W_ARB.exec(cls);
      if (arb) {
        var px = /^([0-9.]+)px$/.exec(arb[1]);
        return { px: px ? Number(px[1]) : null, raw: arb[1], from: cls, arbitrary: true };
      }
      var m = BORDER_W_RE.exec(cls);
      if (m) {
        return { px: m[1] === undefined ? 1 : Number(m[1]), raw: null, from: cls, arbitrary: false };
      }
    }
    return { px: null, raw: null, from: null, arbitrary: false };
  }

  function borderWidthText(state) {
    if (!state || state.from === null) return '';
    if (!state.arbitrary) return String(state.px);
    return state.px === null ? state.raw : String(state.px);
  }

  function readBorderStyle(el) {
    if (!el) return { name: null, from: null };
    var classes = classesOf(el);
    for (var i = classes.length - 1; i >= 0; i--) {
      var m = BORDER_STYLE_RE.exec(classes[i]);
      if (m) return { name: m[1], from: classes[i] };
    }
    return { name: null, from: null };
  }

  /**
   * A width or a style rung the route has never generated has no CSS at all,
   * the same gap an arbitrary colour has and the same fix. Emitted only where
   * the page has none of its own — a scoped copy of a rule the route already
   * owns outranks its own responsive variants, which is the px-6 md:px-12
   * failure read from the other side.
   */
  function ensureBorderRule(cls, body) {
    if (!cls || dynSeen[cls]) return;
    if (renderable.stroke && renderable.stroke[cls]) return;
    dynSeen[cls] = true;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.setAttribute('data-tw-editor', 'dynamic');
      document.head.appendChild(dynStyle);
    }
    var sel = (PREVIEW_ATTR ? '[' + PREVIEW_ATTR + ']' : '') + '.' + CSS.escape(cls);
    try {
      dynStyle.sheet.insertRule(sel + '{' + body + '}', dynStyle.sheet.cssRules.length);
    } catch (e) {
      dynSeen[cls] = false;
    }
  }

  function stripBorderWidth(el) {
    stripFamily(el, BORDER_W_RE);
    stripFamily(el, BORDER_W_ARB);
    // Same rule as px-* clearing pl-*: a box width that left border-b-2 in
    // place would do nothing to the bottom edge, and the field just typed into
    // would read as broken on exactly one side.
    stripFamily(el, BORDER_SIDE_W);
  }

  /** `null` clears the width; a number is a length in pixels. */
  function setBorderWidth(px, raw) {
    if (!selected) return;
    stripBorderWidth(selected);
    if (px !== null || raw) {
      var cls, value;
      if (raw) { cls = 'border-[' + raw + ']'; value = raw; }
      else if (px === 1) { cls = 'border'; value = '1px'; }
      else if (BORDER_WIDTHS.indexOf(px) !== -1) { cls = 'border-' + px; value = px + 'px'; }
      else { cls = 'border-[' + px + 'px]'; value = px + 'px'; }
      // border-width alone. Preflight already sets `border:0 solid` on every
      // element, so the style is solid unless a style class says otherwise —
      // and where one does, saying it again here would overwrite it.
      ensureBorderRule(cls, 'border-width:' + value);
      selected.classList.add(cls);
    }
    markDirty(selected, 'classes');
    refresh();
  }

  function setBorderStyle(name) {
    if (!selected) return;
    stripFamily(selected, BORDER_STYLE_RE);
    if (name) {
      var cls = 'border-' + name;
      // The custom property as well as the property itself: Tailwind v4's width
      // utilities set `border-style:var(--tw-border-style)`, so a rule that set
      // only border-style would be undone by the width class beside it.
      ensureBorderRule(cls, '--tw-border-style:' + name + ';border-style:' + name);
      selected.classList.add(cls);
    }
    markDirty(selected, 'classes');
    refresh();
  }

  /**
   * Does this element have a stroke to show?
   *
   * Its own classes, an inline colour — and a border the page's own CSS puts
   * there, because that one is on screen: a + row offering to add it would be
   * offering something the element already has. Same reason the padding field
   * prints what the page renders rather than a zero it cannot back up.
   */
  function strokeSet(el) {
    if (!el) return false;
    if (readColor(el, 'border') || ownColor(el, 'border')) return true;
    if (readBorderWidth(el).from || readBorderStyle(el).from) return true;
    var own = classesOf(el);
    for (var i = 0; i < own.length; i++) {
      if (BORDER_SIDE_W.test(own[i]) || borderSideColor(own[i])) return true;
    }
    var w = computedBorder(el);
    return !!(w && (w[0] || w[1] || w[2] || w[3]));
  }

  /**
   * The style field: a list of four, the way the weight list is a list, with
   * no search over it. Whatever is set is in the list even when it is one of
   * the two that draw nothing, the same way a weight the font does not ship
   * stays on its own row rather than vanishing from under the value it names.
   */
  function borderStyleField() {
    var d = dropField('strokeStyle', function (anchor) {
      if (!selected) return;
      popState.prefix = 'strokeStyle';
      popState.hue = null;
      renderPopover();
      popover.style.display = 'flex';
      popState.anchor = anchor;
      placePopover(anchor);
    });
    d.token.setAttribute('data-tw-stroke-style', '');

    d.sync = function () {
      var state = readBorderStyle(selected);
      var live = selected ? getComputedStyle(selected).borderTopStyle : 'none';
      var name = state.name || live;
      d.name.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      // Not this element's own: dimmed, the way an inherited spacing value is.
      d.name.className = 'bw-cname' + (state.name ? '' : ' is-unset');
      d.note.textContent = '';
      d.token.title = state.name
        ? 'Style: ' + state.from
        : 'Style: not set — the page renders ' + live;
    };
    return d;
  }

  /**
   * The width field: a plain number, no mark and no list.
   *
   * Frame 7:687 gives it neither — the chevron is on Solid beside it and not
   * here — so it is typed and stepped, with nothing behind it to pick from.
   * Pixels, like every other length in the panel, and the arrows count them:
   * 0, 1, 2, 4 and 8 are inside eight presses of each other, so a ladder in
   * the keys bought this field nothing a plain count does not.
   */
  function borderWidthField() {
    var field = el('div', 'bw-field is-plain');
    field.setAttribute('data-tw-field', 'strokeWidth');

    var readout = document.createElement('input');
    readout.className = 'bw-val';
    readout.type = 'text';
    readout.inputMode = 'numeric';
    readout.autocomplete = 'off';
    readout.spellcheck = false;
    readout.placeholder = '—';

    var snow = snowflake();
    snow.style.display = 'none';
    field.appendChild(readout);
    field.appendChild(snow);

    function commit() {
      if (!selected) return;
      var raw = readout.value.trim().replace(/\s+/g, '');
      var px = null, arb = null;
      if (raw === '' || raw === '—') { px = null; }
      else {
        var m = /^([0-9]+(?:\.[0-9]+)?)(?:px)?$/.exec(raw);
        if (m) px = Number(m[1]);
        else if (/^[0-9.]+(?:r?em)$/.test(raw)) arb = raw;
        else return refresh(); // not something we can write; put the old value back
      }
      // Committing what the field already shows is not an edit — blur fires on
      // every field merely tabbed through, and without this each one marked the
      // element dirty and pushed a history step that undid to itself.
      var was = borderWidthText(readBorderWidth(selected));
      var want = arb || (px === null ? '' : String(px));
      if (want === was) return refresh();
      setBorderWidth(px, arb);
    }

    /**
     * A pixel a press, ten with Shift — the same step every length in this
     * panel takes. Off the field's own text, so a width the page draws and
     * this element does not own is counted from where it renders: that number
     * lives in the placeholder rather than the value, and four sides that
     * disagree are said in full, so parseFloat takes the first of them.
     */
    function step(dir, leap) {
      var state = readBorderWidth(selected);
      var here = stepFrom(readout.value || readout.placeholder,
        (computedBorder(selected) || [0])[0]);
      var next = stepLength(here, dir, leap);
      // Below zero the class comes off, the way a radius rung does rather than
      // pinning a zero the element never asked for. With nothing of its own to
      // take off there is nothing to do.
      if (next === null) return state.from === null ? undefined : setBorderWidth(null, null);
      setBorderWidth(next, null);
    }

    readout.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); readout.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); readout.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        withStep(function () { step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); });
      }
    });
    readout.addEventListener('blur', commit);
    readout.addEventListener('focus', function () { readout.select(); });

    return {
      field: field,
      sync: function () {
        if (typing(readout)) return; // don't fight the typist
        var state = readBorderWidth(selected);
        if (state.from !== null) {
          readout.placeholder = '—';
          readout.value = borderWidthText(state);
          readout.className = 'bw-val' + (state.arbitrary ? ' is-jit' : '');
          snow.style.display = state.arbitrary ? '' : 'none';
          readout.title = 'Width: ' + state.from;
          return;
        }
        // Nothing in the class list. What the page renders goes in the
        // placeholder rather than the value, so a number this element does not
        // own is never mistaken for one it does — and four sides that disagree
        // are said in full, because one of them would be a lie about the others.
        var w = computedBorder(selected) || [0, 0, 0, 0];
        var same = w[0] === w[1] && w[1] === w[2] && w[2] === w[3];
        snow.style.display = 'none';
        readout.className = 'bw-val is-unset';
        readout.value = same && w[0] === 0 ? '0' : '';
        readout.placeholder = same ? (w[0] === 0 ? '—' : String(w[0])) : w.join(', ');
        readout.title = same
          ? (w[0] === 0
              ? 'Width: not set, and renders 0'
              : 'Width: not set here — the page renders ' + w[0] + 'px')
          : 'Width: not set here — the page renders ' + w.join(', ') +
            ' on top, right, bottom, left';
      },
    };
  }

  /**
   * Stroke, as one section — the shape of frame 7:687: the colour across the
   * row with the tile beside it, style and width sharing the line below.
   *
   * It sits with padding, margin and radius rather than with the two colour
   * rows at the foot of the panel, and directly after radius: both describe
   * the edge of the same box, and that is the order the frame's own canvas
   * puts them in.
   */
  function strokeSection() {
    var row = el('div', 'bw-row top');
    row.setAttribute('data-tw-section', 'stroke');
    row.appendChild(el('span', 'bw-lbl', 'Stroke'));

    var stack = el('div', 'bw-stack');
    var colour = colorField('border');
    // The colour and its opacity are one line inside the stack, not two rows:
    // 260 is what the stack has, and 191 + 12 + 57 is what the frame draws in
    // it, so the tile outside the stack holds still whether opacity shows.
    var line = el('div', 'bw-cline');
    line.appendChild(colour.field);
    line.appendChild(colour.alphaBox);
    stack.appendChild(line);

    var style = borderStyleField();
    var width = borderWidthField();
    var pair = el('div', 'bw-pair');
    pair.appendChild(style.field);
    pair.appendChild(width.field);
    stack.appendChild(pair);
    row.appendChild(stack);

    // The tile beside the section's own label, so what it removes is the thing
    // the label names. On the two colour rows the same tile takes off the one
    // colour that row is about; here the row is about a stroke, and a minus
    // that left a width or a style behind would be removing a colour from
    // something still drawn on the page. It is also the only complete way out:
    // the width steps down to nothing, but the style list offers no "none" —
    // both of the styles that draw nothing are read and never offered.
    var drop = el('button', 'bw-toggle');
    drop.setAttribute('data-tw-stroke-none', '');
    drop.innerHTML = ICONS.minus;
    drop.title = 'Remove stroke';
    drop.addEventListener('click', function () {
      if (!selected) return;
      revealed.stroke = false;
      stripColor(selected, 'border');
      stripBorderWidth(selected);
      stripFamily(selected, BORDER_STYLE_RE);
      markDirty(selected, 'classes');
      refresh();
    });
    row.appendChild(drop);

    readouts.push(function () {
      var show = !!selected && (revealed.stroke || strokeSet(selected));
      shown.stroke = show;
      row.style.display = show ? '' : 'none';
      if (!show) return;
      var state = colour.sync();
      style.sync();
      width.sync();
      // Nothing here is the panel's to take off when the page draws the border
      // itself or an inline style paints it — the classes are not what is
      // making it, so a minus would clear nothing and look broken.
      drop.style.display = state.inline ? 'none' : '';
    });

    return row;
  }

  // ------------------------------------------------------------ prompt tab

  /**
   * Which tab is showing. 'editor' is every control this panel has ever had;
   * 'prompt' is a text box wired to a headless `claude -p` running in the
   * project root.
   *
   * Not the VSCode session next door, which cannot be driven from outside: its
   * own extension answers a prompt aimed at a live session with "Session is
   * already open. Your prompt was not applied — enter it manually." So the
   * editor runs a session of its own, which it can actually finish a turn with.
   */
  var tab = 'editor';
  var PROMPT_ENDPOINT = CFG.promptEndpoint || null;
  // Carried across turns so the panel is a conversation and not a series of
  // strangers; the server passes it back as --resume.
  var promptSession = null;
  var promptBusy = null;
  // How much of the plan's five-hour window is gone, as last reported by a turn.

  function setTab(next) {
    if (tab === next) return;
    tab = next;
    if (ui.tabs) {
      ui.tabs.forEach(function (btn) {
        btn.setAttribute('aria-selected', btn.getAttribute('data-tw-tab') === tab ? 'true' : 'false');
      });
    }
    updatePanelChrome();
    if (tab === 'prompt') {
      refreshPromptContext();
      if (ui.pinput) ui.pinput.focus();
    }
  }

  /**
   * The selected element as a place in the source, which is the only reason
   * this tab beats typing the same sentence into a terminal: the loader already
   * stamped file:line:col onto the element, so the prompt can point at it
   * instead of describing it.
   */
  function promptContext() {
    if (!selected) return null;
    var id = selected.getAttribute(ID_ATTR) || '';
    // Popped from the right, exactly as the server's parseLoc does it: a path
    // may contain a colon, and only the last three fields are known-width.
    var bits = id.split(':');
    if (bits.length < 3) return null;
    if (bits.length >= 4) bits.pop();
    var col = Number(bits.pop());
    var line = Number(bits.pop());
    var file = bits.join(':');
    if (!file || isNaN(line) || isNaN(col)) return null;
    var text = (selected.textContent || '').trim();
    return {
      file: file,
      line: line,
      col: col,
      tag: selected.tagName.toLowerCase(),
      classes: selected.getAttribute('class') || '',
      text: selected.children.length ? '' : text,
      instances: sameSource(selected).length,
    };
  }

  function refreshPromptContext() {
    if (!ui.pctx) return;
    var ctx = promptContext();
    ui.pctx.textContent = '';
    if (!ctx) {
      ui.pctx.style.display = 'none';
      return;
    }
    // The header above already names the element, so this line only carries
    // what the header cannot: how many elements one source line renders.
    if (ctx.instances > 1) {
      ui.pctx.style.display = '';
      ui.pctx.appendChild(el('span', 'bw-pctx-note',
        'this line renders ' + ctx.instances + ' elements'));
    } else {
      ui.pctx.style.display = 'none';
    }
    ui.pctx.title = ctx.file + ':' + ctx.line + ':' + ctx.col;
  }

  /**
   * On the view rather than in a global: a test asks the panel what it knows
   * the same way it asks about anything else here, by attribute and not by
   * reaching into the closure.
   */
  function setSession(id) {
    if (!id) return;
    promptSession = id;
    if (ui.promptView) ui.promptView.setAttribute('data-tw-session', id);
  }

  /**
   * Everything but `me` is a rail entry, and a rail entry landing under
   * another tells the one above it to run its line down into the gap.
   * `is-run` is set on the *previous* node because that is the only node that
   * knows the distance: an entry is as tall as its own text, so the line from
   * a dot to the next one can only be drawn from above.
   */
  function logMsg(kind, text) {
    if (!ui.plog) return null;
    var rail = kind !== 'me';
    var node = el('div', 'bw-pmsg is-' + kind + (rail ? ' is-rail' : ''), text);
    var prev = ui.plog.lastElementChild;
    if (rail && prev && prev.classList.contains('is-rail')) prev.classList.add('is-run');
    ui.plog.appendChild(node);
    ui.plog.scrollTop = ui.plog.scrollHeight;
    return node;
  }

  function promptHint(text, bad) {
    if (!ui.phint) return;
    ui.phint.textContent = text;
    ui.phint.className = 'bw-phint' + (bad ? ' is-err' : '');
  }

  /**
   * Send is off until there is something to send.
   *
   * Except while a turn is in flight: the same button is Stop then, and
   * aborting is the one thing that must always be available — the field is
   * disabled at that point, so keying off its text would lock the only way
   * out of a running turn.
   */
  function syncSend() {
    if (!ui.psend) return;
    ui.psend.disabled = !promptBusy && !(ui.pinput && ui.pinput.value.trim());
  }

  function setPromptBusy(on) {
    if (!ui.psend) return;
    ui.psend.textContent = on ? 'Stop' : 'Send';
    ui.pinput.disabled = on;
    // After the flag and the field, not before: it reads both.
    syncSend();
  }

  function sendPrompt() {
    if (promptBusy) {
      // Same button, because a turn in flight is the only thing you want to do
      // to a turn in flight.
      promptBusy.abort();
      return;
    }
    var text = (ui.pinput.value || '').trim();
    if (!text) return;

    // Claude writes to the same files the panel does, and it reads them off
    // disk. Pending class edits live only in the DOM, so a turn started now
    // would be reasoning about a version of the file that does not exist and
    // its write would silently drop them.
    if (dirty.size) {
      promptHint('Save or undo your ' + dirty.size + ' pending change' +
        (dirty.size === 1 ? '' : 's') + ' first — Claude reads these files from disk.', true);
      return;
    }

    var ctx = promptContext();
    logMsg('me', text);
    ui.pinput.value = '';
    promptHint('');

    var ctrl = new AbortController();
    promptBusy = ctrl;
    setPromptBusy(true);
    var thinking = logMsg('tool', 'thinking…');

    fetch(PROMPT_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: CFG.token
        ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.token }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, context: ctx, sessionId: promptSession }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (d) {
            throw new Error(d.error || 'server said ' + res.status);
          });
        }
        return readEvents(res, function (ev) {
          if (thinking) { thinking.remove(); thinking = null; }
          if (ev.t === 'session') setSession(ev.sessionId);
          else if (ev.t === 'text') logMsg('claude', ev.text.trim());
          else if (ev.t === 'tool') logMsg('tool', ev.name + (ev.detail ? ' ' + ev.detail : ''));
          else if (ev.t === 'done') {
            if (ev.sessionId) setSession(ev.sessionId);
            if (ev.error) logMsg('err', ev.error);
            // Nothing to report on a turn that worked. The seconds it took
            // and the share of the plan's five-hour window it used are facts
            // about the machinery, not about the change you asked for, and
            // they sat under the field until the next thing you typed. The
            // hint is still where a failure goes.
            promptHint('');
          }
        });
      })
      .catch(function (err) {
        if (thinking) { thinking.remove(); thinking = null; }
        if (err.name === 'AbortError') logMsg('tool', 'stopped');
        else logMsg('err', err.message);
      })
      .then(function () {
        promptBusy = null;
        setPromptBusy(false);
        ui.pinput.focus();
      });
  }

  /** Read an SSE body off a fetch stream. One `data:` line is one event. */
  function readEvents(res, onEvent) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return;
        buf += decoder.decode(chunk.value, { stream: true });
        var split;
        while ((split = buf.indexOf('\n\n')) !== -1) {
          var frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          if (frame.indexOf('data: ') !== 0) continue;
          try {
            onEvent(JSON.parse(frame.slice(6)));
          } catch (e) { /* a half-written frame is not an error worth showing */ }
        }
        return pump();
      });
    }
    return pump();
  }

  function promptView() {
    var view = el('div', 'bw-prompt');
    view.setAttribute('data-tw-view', 'prompt');

    var form = el('div', 'bw-pform');
    ui.pinput = el('textarea', 'bw-pinput');
    // Generic on purpose. The old one was a worked example — "Make this the
    // same blue as the header…" — which reads as an instruction the first time
    // and narrows what the box looks like it takes: a colour, on this element,
    // copied from another. The field takes any change to the selected element,
    // and the panel already says which element that is on the line above.
    ui.pinput.placeholder = 'Describe the change you want…';
    ui.pinput.setAttribute('data-tw-field', 'prompt');
    ui.pinput.addEventListener('keydown', function (e) {
      // Enter sends; Shift+Enter is a newline. A prompt is usually one line and
      // reaching for a button every time would be the wrong default.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
      e.stopPropagation();
    });

    // Built here, appended to the footer: Send and Save are the same kind of
    // button doing the same kind of thing at the end of the same panel, so
    // they stand in the same bar rather than each keeping their own margins.
    var row = el('div', 'bw-foot-row bw-prow');
    ui.sendRow = row;
    ui.phint = el('span', 'bw-phint', '');
    // Its own attribute, not data-tw-status: the footer's save status carries
    // that one, nine test sites and verify.js address it bare, and
    // querySelector answers with whichever comes first in the DOM — which is
    // this hint. Sharing the name made every save look like it never landed.
    ui.phint.setAttribute('data-tw-phint', '');
    ui.psend = el('button', 'bw-save', 'Send');
    ui.psend.setAttribute('data-tw-send', '');
    ui.psend.addEventListener('click', sendPrompt);
    ui.pinput.addEventListener('input', syncSend);
    syncSend(); // an empty field on the first paint, not a live-looking button
    row.appendChild(ui.phint);
    row.appendChild(ui.psend);

    form.appendChild(ui.pinput);

    // Context, then what has been said, then the box you say the next thing
    // in — the order every chat is read in. The composer used to sit at the
    // top with the transcript growing under it, which put the newest reply
    // furthest from the field that produced it.
    ui.pctx = el('div', 'bw-pctx');
    view.appendChild(ui.pctx);

    ui.plog = el('div', 'bw-plog');
    view.appendChild(ui.plog);

    view.appendChild(form);
    return view;
  }

  function tabStrip() {
    var strip = el('div', 'bw-tabs');
    ui.tabs = [];
    [['editor', 'Editor'], ['prompt', 'Prompt']].forEach(function (pair) {
      var btn = el('button', 'bw-tab', pair[1]);
      btn.setAttribute('data-tw-tab', pair[0]);
      btn.setAttribute('aria-selected', pair[0] === tab ? 'true' : 'false');
      btn.addEventListener('click', function () { setTab(pair[0]); });
      strip.appendChild(btn);
      ui.tabs.push(btn);
    });
    return strip;
  }

  function buildPanel() {
    injectStyles();

    panel = document.createElement('div');
    panel.setAttribute('data-tw-editor', 'panel');
    bindTheme(panel);

    // Only when the backend offers it. The route is opt-in server-side, and a
    // tab that answers every prompt with 404 is worse than no tab.
    if (PROMPT_ENDPOINT) {
      ui.tabstrip = tabStrip();
      panel.appendChild(ui.tabstrip);
      makeDraggable(panel, ui.tabstrip);
    }

    // What the panel is waiting for, said in the space the controls would take.
    ui.idleMsg = el('div', 'bw-idle', 'Please select an element');
    ui.idleMsg.setAttribute('data-tw-idle-msg', '');
    panel.appendChild(ui.idleMsg);
    makeDraggable(panel, ui.idleMsg);

    var header = el('div', 'bw-h');
    ui.header = header;
    ui.title = el('strong', null, 'nothing selected');
    var close = el('button', 'bw-x');
    close.innerHTML = ICONS.close;
    close.title = 'Deselect (Esc)';
    close.addEventListener('click', deselect);
    header.appendChild(ui.title);
    header.appendChild(close);
    // The header goes in FIRST — above the tab strip — so the panel opens the
    // way a dropdown does: what you are looking at, then the way out of it.
    panel.insertBefore(header, panel.firstChild);
    makeDraggable(panel, header);

    var body = el('div', 'bw-body');
    ui.body = body;
    body.appendChild(removeRow());
    body.appendChild(textRow());
    // Every optional section is followed by the row that stands in for it, so
    // each property occupies one slot in the panel whether it is set or not.
    BOXES.forEach(function (box) {
      body.appendChild(box.choose ? chosenSection(box) : boxSection(box));
      if (REVEALS[box.prefix]) body.appendChild(revealRow(REVEALS[box.prefix]));
      // Radius belongs with the box controls, not down among the type ones: it
      // is a property of the same box padding and margin describe.
      if (box.key === 'margin') {
        body.appendChild(radiusSection());
        body.appendChild(revealRow(REVEALS.radius));
        // Straight after radius: both describe the edge of the box padding and
        // margin describe, and that is the order the frame's own canvas puts
        // them in. Appended here rather than at a fixed index so it stays put
        // as rows come and go, the same way radius does.
        body.appendChild(strokeSection());
        body.appendChild(revealRow(REVEALS.stroke));
      }
    });
    body.appendChild(typographySection());
    body.appendChild(revealRow(REVEALS.typography));
    // Text before background, and both of them named `… color`. Text is the
    // one you reach for far more often — an element that sets a background is
    // usually a container, and a container's text belongs to its children —
    // so it goes where the eye lands first. And "Background" on its own was
    // the odd label out beside "Text color": both rows hold a colour and only
    // one of them said so.
    body.appendChild(colorRow('text', 'Text color'));
    body.appendChild(revealRow(REVEALS.text));
    body.appendChild(colorRow('bg', 'Background color'));
    body.appendChild(revealRow(REVEALS.bg));

    panel.appendChild(body);

    if (PROMPT_ENDPOINT) {
      ui.promptView = promptView();
      panel.appendChild(ui.promptView);
    }

    var footer = el('div', 'bw-foot');
    ui.footer = footer;
    var row = el('div', 'bw-foot-row');
    ui.footRow = row;

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
    // The Prompt tab's own row, built with the view it belongs to and parked
    // here so the two tabs' buttons stand in one place.
    if (ui.sendRow) footer.appendChild(ui.sendRow);
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
    ui.title.textContent = selectionLabel(selected);
    readouts.forEach(function (update) { update(); });
    markDividers();
    updateDeleteHandle();
    updateFooter();
  }

  /**
   * A hairline above every row on screen except the first.
   *
   * Runs after the readouts, because until they have all had their say there
   * is no telling which row is first: half of them hide themselves, and a
   * divider above the top one would be a line under the header.
   */
  function markDividers() {
    if (!ui.body) return;
    var cutting = ui.body.classList.contains('is-cutting');
    var seen = false;
    var last = null;
    for (var i = 0; i < ui.body.children.length; i++) {
      var row = ui.body.children[i];
      // The cutting notice hides its siblings from the stylesheet rather than
      // through their own readouts, so their inline display still says visible.
      var on = cutting ? row.classList.contains('bw-rm') : row.style.display !== 'none';
      row.classList.toggle('has-rule', on && seen);
      row.classList.remove('is-last');
      if (on) { seen = true; last = row; }
    }
    if (last) last.classList.add('is-last');
  }

  /**
   * The selected element, said the same way wherever it is said — the editor's
   * header and the prompt's context line had drifted into two wordings and two
   * type sizes for one fact.
   */
  function selectionLabel(el) {
    return el ? '<' + el.tagName.toLowerCase() + '>  ' + shortId(el) : '';
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
    // The Prompt tab works with nothing selected — asking about the project as
    // a whole is a real thing to want — so "idle" is about the editor controls,
    // not about the panel. Folding the whole body when the Prompt tab is open
    // would fold away the tab you just switched to.
    var on = !!selected && tab === 'editor';
    if (on) panel.removeAttribute('data-tw-idle');
    else panel.setAttribute('data-tw-idle', '');
    // Idle is about the editor's controls; empty is about the selection. The
    // Prompt tab is the one place the two part company.
    if (selected) panel.removeAttribute('data-tw-empty');
    else panel.setAttribute('data-tw-empty', '');
    // The header follows the SELECTION, not the tab: it names the element and
    // carries the only way to deselect one, and both of those still apply while
    // you are writing a prompt about it.
    if (ui.header) ui.header.style.display = selected ? 'flex' : 'none';
    // Both tabs are about the selected element, so with none the strip has
    // nothing to switch between and folds away exactly as the header does.
    // The line below takes its place and says what the panel is waiting for.
    if (ui.tabstrip) ui.tabstrip.style.display = selected ? 'flex' : 'none';
    if (ui.idleMsg) ui.idleMsg.style.display = selected ? 'none' : 'flex';
    if (ui.body) ui.body.style.display = on ? '' : 'none';
    var prompting = !!selected && tab === 'prompt';
    if (ui.promptView) ui.promptView.style.display = prompting ? 'flex' : 'none';
    // One bar at the foot of the panel, holding whichever row the tab owns.
    // Save, undo and redo are the editor's ledger and Claude's writes go
    // straight to disk without joining it, so they are not on the Prompt tab
    // at all — pending edits or none. Nothing is stranded by that the way a
    // background click used to strand them: the Editor tab is one click away
    // and brings the bar back with its count intact.
    if (ui.footRow) ui.footRow.style.display = prompting ? 'none' : 'flex';
    if (ui.status) ui.status.style.display = prompting ? 'none' : '';
    if (ui.sendRow) ui.sendRow.style.display = prompting ? 'flex' : 'none';
    if (ui.footer) ui.footer.style.display = 'flex';
    if (prompting) refreshPromptContext();
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
          !e.target.closest('[data-tw-pop],[data-tw-pop-shade]') &&
          !e.target.closest('[data-tw-color-open]')) {
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
      // The ramp is a layer of its own now, so it is a step of its own.
      if (popState.hue) { closeShades(); return; }
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
