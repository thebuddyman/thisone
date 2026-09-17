/**
 * The demo's stand-in for `thisone`'s editor server and for the dev server's
 * hot reload, both in the page.
 *
 * The overlay posts a save to CFG.endpoint exactly as it would under Next. That
 * request never leaves the tab: it is answered here by jsx-adapter's editFile()
 * over the file held in memory, then the page is re-rendered from the new
 * source the way Turbopack would re-render it. The file is never shown; the
 * page is what a visitor watches change, and a reload starts it over.
 */
(function () {
  'use strict';

  var core = window.ThisoneDemo;
  var CFG = window.__TW_EDITOR__;
  var FILE = core.FILE;
  var ABS = core.ROOT + '/' + FILE;

  var original = JSON.parse(document.getElementById('demo-source').textContent);
  var source = original;
  var app = document.getElementById('app');

  // What the last render produced, kept apart from the live DOM. The live
  // nodes carry the editor's own outlines and previews, and a re-render must
  // only change what the source changed, as React's reconcile does.
  var rendered = fragment(app.innerHTML);

  // TypeScript is 1.6 MB compressed. The page is already drawn, so it loads
  // after, and a save made before it arrives simply waits for it.
  var mods = null;
  var ready = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'typescript.js';
    s.onload = function () {
      try {
        mods = core.boot(window.ts, window.__THISONE_SOURCES__);
        resolve();
      } catch (err) { reject(err); }
    };
    s.onerror = function () { reject(new Error('could not load the TypeScript parser')); };
    document.head.appendChild(s);
  });

  // Exposed for test/13-demo.js, which checks the writer's output byte for byte.
  window.__DEMO__ = {
    ready: ready,
    source: function () { return source; },
    original: original,
    renders: 0,
  };

  // ------------------------------------------------------------ the server

  function reply(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json' } });
  }

  // The same checks, in the same order and with the same answers, as
  // handleEdit in next/server.js.
  function handleEdit(payload) {
    var list = Array.isArray(payload.edits) ? payload.edits : [payload];
    if (!list.length) return reply(400, { ok: false, error: 'no edits supplied' });

    var edits = [];
    for (var i = 0; i < list.length; i++) {
      var edit = list[i];
      var loc = mods.adapter.parseLoc(edit.id);
      if (!loc) return reply(400, { ok: false, error: 'unparseable id: ' + JSON.stringify(edit.id) });
      if (edit.classes !== undefined && typeof edit.classes !== 'string') {
        return reply(400, { ok: false, error: 'classes must be a string' });
      }
      if (edit.text !== undefined && typeof edit.text !== 'string') {
        return reply(400, { ok: false, error: 'text must be a string' });
      }
      if (edit.remove !== undefined && typeof edit.remove !== 'boolean') {
        return reply(400, { ok: false, error: 'remove must be a boolean' });
      }
      if (edit.runs !== undefined) {
        if (!Array.isArray(edit.runs)) return reply(400, { ok: false, error: 'runs must be an array' });
        for (var r = 0; r < edit.runs.length; r++) {
          var run = edit.runs[r];
          if (!run || typeof run.from !== 'string' || typeof run.to !== 'string') {
            return reply(400, { ok: false, error: 'each run needs a from and a to, both strings' });
          }
        }
      }
      if (edit.classes === undefined && edit.text === undefined && edit.runs === undefined && !edit.remove) {
        return reply(400, { ok: false, error: 'nothing to edit: send classes, text, runs and/or remove' });
      }
      if (loc.file !== FILE) return reply(403, { ok: false, reason: 'outside-root', error: 'refusing path: ' + loc.file });
      edits.push({
        id: edit.id, loc: loc, classes: edit.classes, text: edit.text, runs: edit.runs,
        remove: edit.remove === true,
        added: Array.isArray(edit.added) ? edit.added : undefined,
        removed: Array.isArray(edit.removed) ? edit.removed : undefined,
      });
    }

    var result = mods.adapter.editFile(window.ts, ABS, source, edits);
    if (!result.ok) {
      var stale = result.refusals.some(function (r) { return r.reason === 'stale-hash'; });
      return reply(stale ? 409 : 422, {
        ok: false, reason: result.refusals[0].reason, refusals: result.refusals, error: result.refusals[0].detail,
      });
    }

    source = result.contents;
    // After the reply, as a dev server's reload lands after its write: the
    // overlay finishes its own bookkeeping against the DOM it knows first.
    setTimeout(rerender, 0);
    return reply(200, { ok: true, files: [FILE] });
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url;
    if (url !== CFG.endpoint) return nativeFetch(input, init);
    return ready.then(function () {
      return handleEdit(JSON.parse((init && init.body) || '{}'));
    }).catch(function (err) {
      return reply(500, { ok: false, error: err.message });
    });
  };

  // ------------------------------------------------------------ the reload

  function fragment(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    return t.content;
  }

  function sameShape(a, b) {
    if (a.childNodes.length !== b.childNodes.length) return false;
    for (var i = 0; i < a.childNodes.length; i++) {
      var x = a.childNodes[i], y = b.childNodes[i];
      if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return false;
    }
    return true;
  }

  /**
   * Apply to `live` only what changed between `prev` and `next`.
   *
   * Attributes the source did not set, like the editor's outline, are left
   * alone. Where the children no longer line up, which is a removal, they are
   * replaced whole: React would drop the node too, and the overlay deselects
   * whatever it was holding that is no longer in the page.
   */
  function patch(live, prev, next) {
    if (next.nodeType === 1) {
      var names = {};
      for (var i = 0; i < next.attributes.length; i++) {
        var attr = next.attributes[i];
        names[attr.name] = 1;
        if (prev.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value);
      }
      for (i = 0; i < prev.attributes.length; i++) {
        if (!names[prev.attributes[i].name]) live.removeAttribute(prev.attributes[i].name);
      }
    } else if (next.nodeType === 3) {
      if (prev.data !== next.data) live.data = next.data;
      return;
    }

    if (!sameShape(prev, next) || live.childNodes.length !== prev.childNodes.length) {
      var copy = [];
      for (i = 0; i < next.childNodes.length; i++) copy.push(next.childNodes[i].cloneNode(true));
      live.replaceChildren.apply(live, copy);
      return;
    }
    for (i = 0; i < next.childNodes.length; i++) {
      patch(live.childNodes[i], prev.childNodes[i], next.childNodes[i]);
    }
  }

  function rerender() {
    var next = fragment(core.render(window.ts, mods.stamp(source)));
    patch(app, rendered, next);
    rendered = next;
    window.__DEMO__.renders++;
  }

  // Open with edit mode on and a title selected, so the first thing a visitor
  // clicks already does something.
  function start() {
    // Below 900px the panel covers the page it is editing. Leave the mode
    // button where it is and let the visitor choose.
    if (window.matchMedia('(max-width: 900px)').matches) return;
    var toggle = document.querySelector('[data-tw-mode]');
    if (toggle) toggle.click();
    var title = app.querySelector('h2');
    if (title) title.click();
  }
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', function () { setTimeout(start, 0); });
})();
