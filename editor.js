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
  };

  // Shared spacing scale for every padding/margin field.
  var SPACING = [0, 2, 4, 6, 8, 12];

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
  var AXES = [
    { side: 'x', name: 'horizontal', icon: 'x' },
    { side: 'y', name: 'vertical', icon: 'y' },
  ];

  var SIDES = [
    { side: 't', name: 'top', icon: 't' },
    { side: 'r', name: 'right', icon: 'r' },
    { side: 'b', name: 'bottom', icon: 'b' },
    { side: 'l', name: 'left', icon: 'l' },
  ];

  // Per-box: is the four-edge view showing? Padding and margin toggle apart.
  var expanded = { p: false, m: false, gap: false };
  // Rows the user asked to see on this selection though nothing is set yet.
  var revealed = {};

  // Which axis utility covers an edge, for reading values inherited from px-*/py-*.
  // The axes themselves have no intermediate step — they fall straight to p-*.
  var AXIS = { t: 'y', b: 'y', l: 'x', r: 'x' };

  var FONT_SIZES = ['text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'text-4xl'];
  var FONT_FALLBACK = 1; // unset text is effectively text-base

  var selected = null;
  var hovered = null;
  var panel = null;
  var ui = {};
  var readouts = []; // refresh() calls each of these to repaint a field
  var textEditable = false; // is the current selection accepting typed text?

  // Elements changed but not yet written. Previously an edit that was never
  // saved stayed on screen with nothing marking it, and one refresh lost it.
  var dirty = new Map(); // element -> { text: boolean, classes: boolean }
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

  /** Stop highlighting an element — but keep the amber marker if it is unsaved. */
  function releaseOutline(el) {
    if (!el) return;
    if (dirty.has(el)) setOutline(el, DIRTY_OUTLINE);
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
    var entry = dirty.get(el) || { text: false, classes: false };
    if (kind === 'text') entry.text = true;
    if (kind === 'classes') entry.classes = true;
    dirty.set(el, entry);
    if (PREVIEW_ATTR) el.setAttribute(PREVIEW_ATTR, '');
    updateFooter();
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
    var re = new RegExp('^' + token + '-(\\d+)$');
    // Last match wins, mirroring how a duplicated class would land in the DOM.
    for (var i = classes.length - 1; i >= 0; i--) {
      var m = re.exec(classes[i]);
      if (m) return { value: Number(m[1]), from: classes[i] };
    }
    return null;
  }

  /**
   * What is this side actually set to right now?
   *
   * Explicit pt-4 wins, then the axis utility py-4, then the all-sides p-4.
   * Tailwind emits them in that order, so this mirrors what the browser paints.
   */
  function readSpacing(el, prefix, side) {
    var classes = classesOf(el);

    var direct = scaleValue(classes, prefix + side);
    if (direct) return { value: direct.value, from: direct.from, source: 'explicit' };

    if (side) {
      if (AXIS[side]) {
        var axis = scaleValue(classes, prefix + AXIS[side]);
        if (axis) return { value: axis.value, from: axis.from, source: 'inherited' };
      }
      var all = scaleValue(classes, prefix);
      if (all) return { value: all.value, from: all.from, source: 'inherited' };
    }

    return { value: null, from: null, source: 'none' };
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
    var index = state.value === null ? -1 : nearestIndex(state.value);
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
    applyClass(selected, prefix + side + '-' + SPACING[next], pattern);
  }

  /**
   * Apply an explicit value, snapping to the nearest step on the scale.
   *
   * Snapping is not tidiness: Tailwind v4 generates no CSS for a class that
   * appears in no source file, and the dev palette only pre-renders this scale.
   * An unsnapped p-5 would write correctly but preview as nothing.
   */
  function setSpacing(prefix, side, value) {
    if (!selected) return;
    var pattern = familyRe(prefix, side);
    if (value === null) {
      stripFamily(selected, pattern);
      markDirty(selected, 'classes');
      refresh();
      return;
    }
    applyClass(selected, prefix + side + '-' + SPACING[nearestIndex(value)], pattern);
  }

  // ------------------------------------------------------------------- panel

  /**
   * Apply an explicit value, snapping to the nearest step on the scale.
   *
   * Snapping is not tidiness: Tailwind v4 generates no CSS for a class that
   * appears in no source file, and the dev palette only pre-renders this scale.
   * An unsnapped p-5 would write correctly but preview as nothing.
   */
  function setSpacing(prefix, side, value) {
    if (!selected) return;
    var pattern = familyRe(prefix, side);
    if (value === null) {
      stripFamily(selected, pattern);
      markDirty(selected, 'classes');
      refresh();
      return;
    }
    applyClass(selected, prefix + side + '-' + SPACING[nearestIndex(value)], pattern);
  }

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
  var TOKENS = {
    light: {
      card: '#ffffff', bg: '#fafafa', sunken: '#fafafa', inset: '#f7f7f7',
      border: '#e3e3e3', hair: '#ededed',
      fg: '#141414', muted: '#737373', faint: '#a3a3a3',
      hover: 'rgba(0,0,0,.045)', press: 'rgba(0,0,0,.075)', ring: 'rgba(0,0,0,.08)',
      shadow: '0 1px 2px rgba(0,0,0,.05), 0 12px 28px -8px rgba(0,0,0,.18)',
    },
    dark: {
      card: '#2b2b2b', bg: '#252525', sunken: '#262626', inset: '#1f1f1f',
      border: '#3d3d3d', hair: '#343434',
      fg: '#f5f5f5', muted: '#a6a6a6', faint: '#6f6f6f',
      hover: 'rgba(255,255,255,.06)', press: 'rgba(255,255,255,.1)', ring: 'rgba(255,255,255,.1)',
      shadow: '0 1px 2px rgba(0,0,0,.4), 0 12px 32px -8px rgba(0,0,0,.6)',
    },
  };
  var BRAND = '#d97959';  // --primary from the template
  var DANGER = '#dc2828'; // --destructive
  var OKGREEN = '#2f9e64';
  var UI_FONT = "Figtree, Figtree_400Regular, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  var UI_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";

  function vars(t) {
    return Object.keys(t)
      .map(function (k) { return '--bw-' + k + ':' + t[k]; })
      .join(';');
  }

  /** 12px line icons: a faint box plus the edge(s) the control governs. */
  function glyph(inner) {
    return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.1" stroke-linecap="round">' + inner + '</svg>';
  }
  var BOXPATH = '<rect x="1.75" y="1.75" width="8.5" height="8.5" rx="1.75" opacity=".32"/>';
  var ICONS = {
    x: glyph(BOXPATH + '<path d="M3.7 3.5v5M8.3 3.5v5"/>'),
    y: glyph(BOXPATH + '<path d="M3.5 3.7h5M3.5 8.3h5"/>'),
    t: glyph(BOXPATH + '<path d="M3.5 3.7h5"/>'),
    r: glyph(BOXPATH + '<path d="M8.3 3.5v5"/>'),
    b: glyph(BOXPATH + '<path d="M3.5 8.3h5"/>'),
    l: glyph(BOXPATH + '<path d="M3.7 3.5v5"/>'),
    // Toggle glyphs: a box inside a box is "one padding all round"; adding the
    // two outer rules is "each edge on its own". The button shows the mode it
    // is currently in, so the icon and the fields below it always agree.
    up: '<svg width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.2 4.4 3.5 2.1l2.3 2.3"/></svg>',
    down: '<svg width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.2 2.6 3.5 4.9l2.3-2.3"/></svg>',
    plus: '<svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round"><path d="M4.5 1.4v6.2M1.4 4.5h6.2"/></svg>',
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
    combined: glyph('<rect x="1.6" y="1.6" width="8.8" height="8.8" rx="2"/>' +
      '<rect x="4.3" y="4.3" width="3.4" height="3.4" rx="1"/>'),
    // Proportions taken off the reference: a portrait box (5:8), an inner mark
    // ~37% of its width, and outer rules ~62% of the box height sitting close
    // in — the whole glyph reads wider than tall.
    individual: glyph('<rect x="3.5" y="2" width="5" height="8" rx="1.6"/>' +
      '<rect x="5.05" y="4.5" width="1.9" height="3" rx=".7"/>' +
      '<path d="M1.65 3.5v5M10.35 3.5v5"/>'),
  };

  var P = '[data-tw-editor="panel"]';
  var PP = '[data-tw-editor="popover"]';
  // Both surfaces carry the same tokens: the popover lives on <body>, not
  // inside the panel, so it cannot inherit them.
  var SURFACES = P + ',' + PP;
  /** Same rule on both surfaces: both(' .bw-x') → '[…panel] .bw-x,[…popover] .bw-x'. */
  function both(sel) { return P + sel + ',' + PP + sel; }

  function styleSheet() {
    return [
      SURFACES + '{' + vars(TOKENS.light) + ';--bw-brand:' + BRAND + ';--bw-danger:' + DANGER +
        ';--bw-ok:' + OKGREEN + ';font:13px/1.45 ' + UI_FONT + ';-webkit-font-smoothing:antialiased}',
      // both() and not SURFACES + '[…]': an attribute appended to a comma list
      // binds only to its last item, which left the panel permanently dark.
      both('[data-theme="dark"]') + '{' + vars(TOKENS.dark) + '}',
      PP + ' *{box-sizing:border-box;margin:0}',
      PP + ' button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;padding:0}',
      P + '{',
      '  position:fixed;top:16px;right:16px;width:300px;max-height:calc(100vh - 32px);',
      '  z-index:2147483647;display:none;flex-direction:column;overflow:hidden;',
      '  background:var(--bw-card);color:var(--bw-fg);border:1px solid var(--bw-border);',
      '  border-radius:12px;box-shadow:var(--bw-shadow);font:13px/1.45 ' + UI_FONT + ';',
      '  -webkit-font-smoothing:antialiased;user-select:none;text-align:left}',
      P + ' *{box-sizing:border-box;margin:0}',
      P + ' button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;padding:0}',

      /* header */
      P + ' .bw-h{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      '  padding:9px 10px 9px 12px;border-bottom:1px solid var(--bw-hair);cursor:move;flex:0 0 auto}',
      P + ' .bw-h strong{font:600 12px/1.2 ' + UI_FONT + ';letter-spacing:-.01em}',
      both(' .bw-x') + '{width:22px;height:22px;border-radius:6px;color:var(--bw-faint);',
      '  font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center}',
      both(' .bw-x:hover') + '{background:var(--bw-hover);color:var(--bw-fg)}',

      /* body */
      P + ' .bw-body{padding:10px 12px;display:flex;flex-direction:column;gap:9px;overflow-y:auto}',
      P + ' .bw-row{display:flex;align-items:center;gap:8px}',
      P + ' .bw-row.top{align-items:flex-start}',
      P + ' .bw-lbl{flex:0 0 auto;width:58px;font:500 11px/1.3 ' + UI_FONT + ';color:var(--bw-muted);white-space:nowrap}',
      P + ' .bw-row.top > .bw-lbl{padding-top:8px}',

      /* segmented stepper */
      P + ' .bw-field{flex:1;min-width:0;display:flex;align-items:stretch;height:28px;',
      '  background:var(--bw-sunken);border:1px solid var(--bw-border);border-radius:6px;overflow:hidden}',
      P + ' .bw-val{flex:1;min-width:0;width:100%;padding:0 4px;border:0;background:transparent;',
      '  font:11px/1 ' + UI_MONO + ';color:var(--bw-fg);text-align:left}',
      P + ' .bw-val:focus{outline:none;color:var(--bw-fg);font-style:normal}',
      P + ' .bw-val::placeholder{color:var(--bw-faint)}',
      P + ' .bw-val.is-text{display:flex;align-items:center;padding-left:8px;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      P + ' .bw-val::-webkit-outer-spin-button,' + P + ' .bw-val::-webkit-inner-spin-button{',
      '  -webkit-appearance:none;margin:0}',
      /* stacked up/down */
      P + ' .bw-spin{flex:0 0 17px;display:flex;flex-direction:column;align-self:stretch;',
      '  border-left:1px solid var(--bw-hair)}',
      P + ' .bw-step{flex:1;display:flex;align-items:center;justify-content:center;',
      '  color:var(--bw-faint);min-height:0}',
      P + ' .bw-step:first-child{border-bottom:1px solid var(--bw-hair)}',
      P + ' .bw-step:hover{background:var(--bw-hover);color:var(--bw-fg)}',
      P + ' .bw-step:active{background:var(--bw-press)}',
      P + ' .bw-val.is-inherited{color:var(--bw-faint);font-style:italic}',
      P + ' .bw-val.is-unset{color:var(--bw-faint)}',

      /* spacing: label, a 2-up grid of inputs, then the per-side toggle */
      P + ' .bw-stack{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}',
      P + ' .bw-toggle{width:24px;height:28px;border-radius:6px;color:var(--bw-faint);',
      '  display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
      P + ' .bw-toggle:hover{background:var(--bw-hover);color:var(--bw-fg)}',
      P + ' .bw-toggle[aria-pressed="true"]{background:var(--bw-press);color:var(--bw-fg)}',
      P + ' .bw-pair{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      P + ' .bw-pair.is-hidden{display:none}',
      P + ' .bw-pair.is-single{grid-template-columns:1fr}',
      P + ' .bw-addstrip{flex:1;display:flex;flex-wrap:wrap;gap:5px}',
      P + ' .bw-addchip{display:flex;align-items:center;gap:5px;padding:4px 9px 4px 7px;',
      '  border-radius:999px;font:500 11px/1.2 ' + UI_FONT + ';color:var(--bw-muted);',
      '  box-shadow:inset 0 0 0 1px var(--bw-border)}',
      P + ' .bw-addchip:hover{background:var(--bw-hover);color:var(--bw-fg)}',
      P + ' .bw-ico{flex:0 0 auto;display:flex;align-items:center;justify-content:center;',
      '  width:20px;color:var(--bw-faint);padding-left:5px}',
      P + ' .bw-input{min-width:0}',

      /* colour field */
      P + ' .bw-color{align-items:center;padding-right:3px}',
      P + ' .bw-ctoken{flex:1;min-width:0;display:flex;align-items:center;gap:7px;',
      '  height:100%;padding:0 6px;overflow:hidden}',
      P + ' .bw-ctoken:hover{background:var(--bw-hover)}',
      both(' .bw-chip') + '{flex:0 0 auto;width:14px;height:14px;border-radius:4px;',
      '  box-shadow:inset 0 0 0 1px var(--bw-ring)}',
      P + ' .bw-chip.is-empty{background:repeating-linear-gradient(45deg,var(--bw-hair) 0 3px,transparent 3px 6px)}',
      P + ' .bw-cname{font:11px/1 ' + UI_MONO + ';color:var(--bw-fg);overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      P + ' .bw-cname.is-unset{color:var(--bw-faint)}',
      P + ' .bw-alpha{flex:0 0 auto;display:flex;align-items:center;gap:1px;',
      '  padding-left:4px;border-left:1px solid var(--bw-hair)}',
      P + ' .bw-alpha-in{width:24px;border:0;background:transparent;text-align:right;',
      '  font:11px/1 ' + UI_MONO + ';color:var(--bw-fg)}',
      P + ' .bw-alpha-in:focus{outline:none}',
      P + ' .bw-pct{font:10px/1 ' + UI_FONT + ';color:var(--bw-faint);padding-right:3px}',
      P + ' .bw-detach{flex:0 0 auto;width:22px;height:22px;border-radius:5px;opacity:0;',
      '  display:flex;align-items:center;justify-content:center;color:var(--bw-faint)}',
      P + ' .bw-color:hover .bw-detach{opacity:1}',
      P + ' .bw-detach:hover{background:var(--bw-hover);color:var(--bw-fg)}',

      /* colour popover */
      PP + '{position:fixed;width:200px;max-height:300px;z-index:2147483647;',
      '  display:none;flex-direction:column;overflow:hidden;background:var(--bw-card);',
      '  color:var(--bw-fg);border:1px solid var(--bw-border);border-radius:10px;',
      '  box-shadow:var(--bw-shadow);user-select:none}',
      PP + ' .bw-pop-h{display:flex;align-items:center;gap:6px;padding:7px 6px 7px 10px;',
      '  border-bottom:1px solid var(--bw-hair)}',
      PP + ' .bw-pop-h strong{flex:1;font:600 11px/1.2 ' + UI_FONT + ';text-transform:capitalize}',
      PP + ' .bw-pop-back{width:18px;height:18px;border-radius:4px;color:var(--bw-faint);',
      '  display:flex;align-items:center;justify-content:center}',
      PP + ' .bw-pop-back:hover{background:var(--bw-hover);color:var(--bw-fg)}',
      PP + ' .bw-pop-body{overflow-y:auto;padding:4px}',
      PP + ' .bw-pop-group{padding:7px 8px 3px;font:600 9px/1 ' + UI_FONT + ';',
      '  letter-spacing:.07em;text-transform:uppercase;color:var(--bw-faint)}',
      PP + ' .bw-hue{display:flex;align-items:center;gap:9px;width:100%;padding:5px 7px;',
      '  border-radius:6px;font:12px/1.2 ' + UI_MONO + ';color:var(--bw-fg);text-align:left;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      PP + ' .bw-hue:hover{background:var(--bw-hover)}',
      PP + ' .bw-shades{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:2px}',
      PP + ' .bw-shade{height:34px;border-radius:6px;display:flex;align-items:flex-end;',
      '  justify-content:center;padding-bottom:3px;box-shadow:inset 0 0 0 1px var(--bw-ring)}',
      PP + ' .bw-shade:hover{box-shadow:inset 0 0 0 1px var(--bw-ring),0 0 0 2px var(--bw-card),0 0 0 3.5px var(--bw-brand)}',
      PP + ' .bw-shade-n{font:9px/1 ' + UI_MONO + ';color:#fff;mix-blend-mode:difference}',

      /* swatches */
      P + ' .bw-sws{flex:1;display:flex;gap:6px;align-items:center}',
      P + ' .bw-sw{flex:0 0 auto;width:22px;height:22px;border-radius:6px;',
      '  box-shadow:inset 0 0 0 1px var(--bw-ring);transition:transform .08s ease}',
      P + ' .bw-sw:hover{transform:scale(1.08)}',
      P + ' .bw-sw[aria-pressed="true"]{box-shadow:inset 0 0 0 1px var(--bw-ring),',
      '  0 0 0 2px var(--bw-card),0 0 0 3.5px var(--bw-brand)}',

      /* text mirror */
      P + ' .bw-text{flex:1;min-width:0;min-height:28px;padding:6px 8px;background:var(--bw-sunken);',
      '  border:1px solid var(--bw-border);border-radius:6px;font:12px/1.35 ' + UI_FONT + ';',
      '  color:var(--bw-fg);max-height:60px;overflow-y:auto;word-break:break-word}',
      P + ' .bw-text.is-off{color:var(--bw-faint);font-style:italic}',

      /* class string */
      P + ' .bw-code{padding:8px 9px;background:var(--bw-inset);border:1px solid var(--bw-hair);',
      '  border-radius:6px;font:11px/1.5 ' + UI_MONO + ';color:var(--bw-muted);',
      '  word-break:break-word;max-height:76px;overflow-y:auto;user-select:text}',

      /* footer */
      P + ' .bw-foot{flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:10px 12px;',
      '  border-top:1px solid var(--bw-hair);background:var(--bw-bg)}',
      P + ' .bw-save{font:600 12px/1 ' + UI_FONT + ';color:#fff;background:var(--bw-brand);',
      '  border-radius:6px;padding:8px 12px;box-shadow:0 1px 2px rgba(0,0,0,.08);white-space:nowrap}',
      P + ' .bw-save:hover{filter:brightness(1.06)}',
      P + ' .bw-save:disabled{background:transparent;color:var(--bw-faint);',
      '  box-shadow:inset 0 0 0 1px var(--bw-border);cursor:default}',
      P + ' .bw-status{flex:1;min-width:0;font:11px/1.35 ' + UI_FONT + ';color:var(--bw-muted);word-break:break-word}',
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
    mark.innerHTML = ICONS[opts.icon];
    mark.title = opts.name;

    var readout = document.createElement('input');
    readout.className = 'bw-val';
    readout.type = 'text';
    readout.inputMode = 'numeric';
    readout.autocomplete = 'off';
    readout.spellcheck = false;
    readout.placeholder = '—';

    var spin = el('div', 'bw-spin');
    var up = el('button', 'bw-step');
    var down = el('button', 'bw-step');
    up.innerHTML = ICONS.up;
    down.innerHTML = ICONS.down;
    up.setAttribute('data-tw-step', 'up');
    down.setAttribute('data-tw-step', 'down');
    up.title = 'increase ' + opts.name;
    down.title = 'decrease ' + opts.name + ' — below 0 removes the class';
    up.addEventListener('click', function () { stepSpacing(prefix, side, 1); });
    down.addEventListener('click', function () { stepSpacing(prefix, side, -1); });
    spin.appendChild(up);
    spin.appendChild(down);

    // Typing commits on Enter or blur; empty clears the class outright.
    function commit() {
      var raw = readout.value.trim();
      if (raw === '' || raw === '—') return setSpacing(prefix, side, null);
      var n = parseFloat(raw);
      if (isNaN(n) || n < 0) return refresh(); // reject, restore what was there
      setSpacing(prefix, side, n);
    }
    readout.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); readout.blur(); }
      else if (e.key === 'Escape') { e.stopPropagation(); refresh(); readout.blur(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); stepSpacing(prefix, side, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); stepSpacing(prefix, side, -1); }
    });
    readout.addEventListener('blur', commit);
    readout.addEventListener('focus', function () { readout.select(); });

    field.appendChild(mark);
    field.appendChild(readout);
    field.appendChild(spin);
    row.appendChild(field);

    readouts.push(function () {
      if (document.activeElement === readout) return; // don't fight the typist
      var state = readSpacing(selected, prefix, side);
      if (state.value === null) {
        readout.value = '';
        readout.className = 'bw-val is-unset';
        readout.title = opts.name + ': not set';
        return;
      }
      // Explicit values read at full contrast; values merely inherited from a
      // broader class (p-* under px-*, px-* under pl-*) are dimmed and italic,
      // so it is obvious which classes this element actually owns.
      readout.value = String(state.value);
      readout.className = 'bw-val' + (state.source === 'explicit' ? '' : ' is-inherited');
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
    toggle.innerHTML = ICONS.combined;
    toggle.setAttribute('data-tw-toggle', box.prefix);
    toggle.setAttribute('aria-pressed', 'false');
    toggle.title = 'Edit ' + box.label.toLowerCase() + ' per side';

    var shut = box.collapsed || AXES;
    var open = box.expanded || SIDES;

    function view(list, hidden) {
      var v = el('div', 'bw-pair' + (list.length === 1 ? ' is-single' : '') + (hidden ? ' is-hidden' : ''));
      list.forEach(function (f) {
        v.appendChild(spacingField(box.prefix, f.side, {
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
      toggle.innerHTML = open ? ICONS.individual : ICONS.combined;
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
      if (!expanded[box.prefix]) {
        var finer = open.some(function (f) {
          return readSpacing(selected, box.prefix, f.side).source === 'explicit';
        });
        if (finer) expanded[box.prefix] = true;
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
      });
      row.style.display = missing.length ? '' : 'none';
      strip.innerHTML = '';
      missing.forEach(function (box) {
        var chip = el('button', 'bw-addchip');
        chip.setAttribute('data-tw-add', box.prefix);
        chip.innerHTML = ICONS.plus;
        chip.appendChild(el('span', null, box.label));
        chip.title = 'Show ' + box.label.toLowerCase() + ' controls';
        chip.addEventListener('click', function () {
          revealed[box.prefix] = true;
          refresh();
        });
        strip.appendChild(chip);
      });
    });

    return row;
  }

  // ------------------------------------------------------- other controls

  function fontRow() {
    var row = el('div', 'bw-row');
    row.setAttribute('data-tw-field', 'font');
    row.appendChild(el('span', 'bw-lbl', 'Font size'));

    var field = el('div', 'bw-field');
    // Font sizes are names (text-lg), not numbers, so this value is read-only —
    // but it wears the same chrome as the spacing inputs so the rows line up.
    var readout = el('code', 'bw-val is-text', '—');
    var spin = el('div', 'bw-spin');
    var up = el('button', 'bw-step');
    var down = el('button', 'bw-step');
    up.innerHTML = ICONS.up;
    down.innerHTML = ICONS.down;
    up.setAttribute('data-tw-step', 'up');
    down.setAttribute('data-tw-step', 'down');

    function step(dir) {
      if (!selected) return;
      var classes = classesOf(selected);
      var current = FONT_SIZES.findIndex(function (v) { return classes.indexOf(v) !== -1; });
      if (current === -1) current = FONT_FALLBACK;
      var next = Math.max(0, Math.min(FONT_SIZES.length - 1, current + dir));
      applyClass(selected, FONT_SIZES[next], FAMILY.fontSize);
    }
    up.title = 'larger';
    down.title = 'smaller';
    up.addEventListener('click', function () { step(1); });
    down.addEventListener('click', function () { step(-1); });
    spin.appendChild(up);
    spin.appendChild(down);

    field.appendChild(readout);
    field.appendChild(spin);
    row.appendChild(field);

    readouts.push(function () {
      var classes = classesOf(selected);
      var hit = FONT_SIZES.find(function (v) { return classes.indexOf(v) !== -1; });
      readout.textContent = hit || '—';
      readout.className = 'bw-val is-text' + (hit ? '' : ' is-unset');
    });

    return row;
  }

  function textRow() {
    var row = el('div', 'bw-row top');
    row.setAttribute('data-tw-field', 'text');
    var label = el('span', 'bw-lbl', 'Text');
    label.style.paddingTop = '6px';
    row.appendChild(label);

    var box = el('div', 'bw-text', '');
    row.appendChild(box);

    readouts.push(function () {
      if (!TEXT_ENABLED) {
        box.textContent = 'text editing is HTML-only for now';
        box.className = 'bw-text is-off';
        box.title = 'JSX text is whitespace-significant; not safe to rewrite yet';
        return;
      }
      if (!textEditable) {
        box.textContent = 'has child elements — pick one to edit its text';
        box.className = 'bw-text is-off';
        box.title = 'only leaf elements can be typed into';
        return;
      }
      var value = selected.textContent.trim();
      box.textContent = value || '(empty)';
      box.className = 'bw-text' + (value ? '' : ' is-off');
      box.title = 'click the element on the page and type';
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
    var found = { bg: {}, text: {} };

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
  var popState = { prefix: null, hue: null, anchor: null };

  function closePopover() {
    if (popover) popover.style.display = 'none';
    popState.prefix = null;
    popState.anchor = null;
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
  function placePopover(anchor) {
    var a = anchor.getBoundingClientRect();
    var box = panel.getBoundingClientRect();
    var w = popover.offsetWidth || 200;
    var h = popover.offsetHeight || 300;
    var gap = 8;

    var left = box.left - w - gap;
    if (left < gap) left = box.right + gap;
    if (left + w > window.innerWidth - gap) left = Math.max(gap, window.innerWidth - w - gap);

    var top = a.top - 6;
    if (top + h > window.innerHeight - gap) top = window.innerHeight - h - gap;
    if (top < gap) top = gap;

    popover.style.left = Math.round(left) + 'px';
    popover.style.top = Math.round(top) + 'px';
  }

  function renderPopover() {
    popover.innerHTML = '';
    var head = el('div', 'bw-pop-h');

    if (popState.hue) {
      var back = el('button', 'bw-pop-back');
      back.innerHTML = ICONS.back;
      back.title = 'All colours';
      back.addEventListener('click', function () { popState.hue = null; renderPopover(); });
      head.appendChild(back);
    }
    head.appendChild(el('strong', null, popState.hue || 'Colour'));
    var shut = el('button', 'bw-x', '×');
    shut.addEventListener('click', closePopover);
    head.appendChild(shut);
    popover.appendChild(head);

    var body = el('div', 'bw-pop-body');

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
    ui.title = el('strong', null, 'nothing selected');
    var close = el('button', 'bw-x', '×');
    close.title = 'Deselect (Esc)';
    close.addEventListener('click', deselect);
    header.appendChild(ui.title);
    header.appendChild(close);
    panel.appendChild(header);
    makeDraggable(panel, header);

    var body = el('div', 'bw-body');
    body.appendChild(textRow());
    BOXES.forEach(function (box) { body.appendChild(boxSection(box)); });
    body.appendChild(addRow());
    body.appendChild(fontRow());
    body.appendChild(colorRow('bg', 'Background'));
    body.appendChild(colorRow('text', 'Text color'));

    ui.classes = el('div', 'bw-code', '');
    body.appendChild(ui.classes);
    panel.appendChild(body);

    var footer = el('div', 'bw-foot');
    ui.save = el('button', 'bw-save', 'Saved');
    ui.save.setAttribute('data-tw-save', '');
    ui.save.addEventListener('click', save);
    ui.status = el('span', 'bw-status', '');
    ui.status.setAttribute('data-tw-status', '');
    footer.appendChild(ui.save);
    footer.appendChild(ui.status);
    panel.appendChild(footer);

    document.body.appendChild(panel);
    buildPopover();
  }

  function makeDraggable(box, handle) {
    var dragging = false;
    var offsetX = 0;
    var offsetY = 0;

    handle.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      var rect = box.getBoundingClientRect();
      dragging = true;
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      box.style.right = 'auto';
      box.style.left = rect.left + 'px';
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = Math.max(0, e.clientX - offsetX) + 'px';
      box.style.top = Math.max(0, e.clientY - offsetY) + 'px';
    });

    window.addEventListener('mouseup', function () { dragging = false; });
  }

  function refresh() {
    if (!selected) return;
    ui.title.textContent = '<' + selected.tagName.toLowerCase() + '>  ' +
      shortId(selected) + (textEditable ? '  ✎' : '');
    readouts.forEach(function (update) { update(); });
    ui.classes.textContent = liveClasses(selected) || '(no classes)';
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

  function updateFooter() {
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
    revealed = {}; // reveals are per-selection, not sticky across elements
    buildColorModel(); // re-read: a client-routed page can swap its @theme
    setOutline(selected, SELECT_OUTLINE);
    textEditable = TEXT_ENABLED && enableTextEditing(selected);
    if (textEditable) focusText(selected, point);
    panel.style.display = 'flex';
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
    panel.style.display = 'none';
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
      if (entry.classes) edit.classes = liveClasses(el);
      if (entry.text && TEXT_ENABLED) {
        // A browser quirk may still have slipped a node in (a <br> from an odd
        // paste path). Flatten back to pure text so the write stays a leaf.
        if (el.children.length) el.textContent = el.textContent;
        edit.text = el.textContent;
      }
      edits.push(edit);
    });

    var saving = [];
    dirty.forEach(function (_entry, el) { saving.push(el); });

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
          saving.forEach(function (el) {
            if (el === selected) setOutline(el, SELECT_OUTLINE);
            else releaseOutline(el);
          });
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
      var el = editable(e.target);
      if (el === hovered) return;
      if (hovered && hovered !== selected) releaseOutline(hovered);
      hovered = el;
      if (hovered && hovered !== selected) setOutline(hovered, HOVER_OUTLINE);
    });

    document.addEventListener('mouseout', function (e) {
      if (!hovered) return;
      if (e.relatedTarget && hovered.contains(e.relatedTarget)) return;
      if (hovered !== selected) releaseOutline(hovered);
      hovered = null;
    });

    // Capture phase: the page's own links and buttons must not fire while editing.
    document.addEventListener('click', function (e) {
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
      if (e.key !== 'Escape') return;
      if (popoverOpen()) { closePopover(); return; }
      deselect();
    });

    var reflow = function () {
      if (popoverOpen() && popState.anchor) placePopover(popState.anchor);
    };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);

    console.log('[tw-editor] ready — click an element to edit it');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
