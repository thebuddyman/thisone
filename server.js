'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const html = require('./html-adapter');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// The page `/` serves. Overridable so the test suites run against a throwaway
// fixture instead of mutating the demo page.
// Real paths, so a symlinked temp dir cannot make the page look outside its root.
const INDEX_FILE = fs.realpathSync(process.env.TW_EDITOR_FILE
  ? path.resolve(process.env.TW_EDITOR_FILE)
  : path.join(ROOT, 'index.html'));
// Every .html under here can be edited, and everything else is served as it is.
const SITE_ROOT = path.dirname(INDEX_FILE);
const EDITOR_FILE = path.join(ROOT, 'editor.js');

/** "about.html" → its absolute path, or null when it points outside the site. */
function resolveInSite(rel) {
  const file = path.resolve(SITE_ROOT, rel);
  if (file !== SITE_ROOT && !file.startsWith(SITE_ROOT + path.sep)) return null;
  return file;
}

/** The .html file a URL path means, the way a static host would read it. */
function pageFor(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath).replace(/^\/+/, ''); } catch { return null; }
  if (rel === '') return INDEX_FILE;
  const file = resolveInSite(rel);
  if (!file) return null;
  const tries = rel.endsWith('/') ? [path.join(file, 'index.html')]
    : /\.html?$/i.test(rel) ? [file]
    : path.extname(rel) ? [] : [file + '.html', path.join(file, 'index.html')];
  return tries.find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) || null;
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// The overlay is served with a config prelude, exactly as the Next editor
// server does it, so both modes run the same client with the same colour data.
const COLOR_RAMPS = require('./next/colors.json');
const { HUES, compilePalette, SCOPE } = require('./next/palette');
const TEXT_SIZES = require('./next/text-sizes.json');
const FONT_WEIGHTS = require('./next/font-weights.json');
const RADII = require('./next/radii.json');

// Served locally rather than from a CDN: the test suite must not depend on a
// network fetch, which made runs intermittently fail with unstyled pages.
app.get('/tailwind-browser.js', (req, res) => {
  res.type('application/javascript').sendFile(require.resolve('@tailwindcss/browser'));
});

// A page running Tailwind's browser build compiles any class the moment it
// appears, so a preview costs nothing. A page with a built stylesheet has only
// the classes that were in the source when it was built, and the ones the
// editor invents need the same scoped palette the Next backend uses.
const RUNTIME_JIT = /@tailwindcss\/browser|tailwind-browser\.js|cdn\.tailwindcss\.com/;
const PREVIEW_ATTR = SCOPE.slice(1, -1);

// Compiled on first use with the site's own Tailwind: a site on the browser
// build never asks. A failure is not cached, so installing Tailwind and
// reloading is enough.
let palette = null;
app.get('/thisone-palette.css', (req, res) => {
  palette = palette || compilePalette(SITE_ROOT).then((p) => {
    console.log(`palette: ${p.rules} rules from tailwind ${p.version}`);
    return p.css;
  });
  palette.then(
    (css) => res.type('text/css').send(css),
    (err) => {
      palette = null;
      console.error(`no preview stylesheet: ${err.message}`);
      res.type('text/css').send(`/* thisone: no preview stylesheet. ${String(err.message).replace(/\*\//g, '')} */`);
    });
});

app.get('/editor.js', (req, res) => {
  const prelude =
    'window.__TW_EDITOR__ = ' +
    JSON.stringify({ idAttr: html.ID_ATTR, previewAttr: req.query.preview ? PREVIEW_ATTR : null, colors: { order: HUES.filter((h) => COLOR_RAMPS[h]), ramps: COLOR_RAMPS }, textSizes: TEXT_SIZES, fontWeights: FONT_WEIGHTS, radii: RADII, textRuns: true }) +
    ';\n';
  res.type('application/javascript').send(prelude + fs.readFileSync(EDITOR_FILE, 'utf8'));
});

/** Validate one {id, classes, text, runs, remove} entry, returning an error string or null. */
function validateEdit(edit) {
  const loc = html.parseLoc(edit && edit.id);
  if (!loc || !loc.hash) return `invalid id: ${JSON.stringify(edit && edit.id)}`;
  if (edit.classes !== undefined && typeof edit.classes !== 'string') {
    return 'classes must be a string';
  }
  if (edit.text !== undefined && typeof edit.text !== 'string') {
    return 'text must be a string';
  }
  if (edit.runs !== undefined) {
    if (!Array.isArray(edit.runs)) return 'runs must be an array';
    for (const r of edit.runs) {
      if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') {
        return 'each run needs a from and a to, both strings';
      }
    }
  }
  if (edit.remove !== undefined && typeof edit.remove !== 'boolean') {
    return 'remove must be a boolean';
  }
  if (edit.classes === undefined && edit.text === undefined
      && edit.runs === undefined && !edit.remove) {
    return 'nothing to edit: send classes, text, runs and/or remove';
  }
  return null;
}

// Write-back. Every edit names its file, line and column and quotes the hash
// of the bytes it was stamped from, so a file edited out of band is refused
// and never written to at the wrong place.
//
// Accepts either a single edit or {edits: [...]}. A batch is not a
// convenience: saving N elements as N requests would invalidate the hash after
// the first one, so "save all" is only correct as a single atomic write.
app.post('/edit', (req, res) => {
  const payload = req.body || {};
  const list = Array.isArray(payload.edits) ? payload.edits : [payload];

  if (!list.length) {
    return res.status(400).json({ ok: false, error: 'no edits supplied' });
  }
  for (const edit of list) {
    const problem = validateEdit(edit);
    if (problem) return res.status(400).json({ ok: false, error: problem });
  }

  try {
    const byFile = new Map();
    for (const edit of list) {
      const loc = html.parseLoc(edit.id);
      const file = resolveInSite(loc.file);
      if (!file || !/\.html?$/i.test(file) || !fs.existsSync(file)) {
        return res.status(404).json({ ok: false, reason: 'not-found', error: `no page at ${loc.file}` });
      }
      if (!byFile.has(file)) byFile.set(file, { rel: loc.file, edits: [] });
      byFile.get(file).edits.push({ ...edit, loc });
    }

    // Resolve every file before writing any of them, so a refusal in the
    // second leaves the first untouched.
    const writes = [];
    for (const [file, { rel, edits }] of byFile) {
      const before = fs.readFileSync(file, 'utf8');
      const result = html.editFile(before, edits);
      if (!result.ok) {
        const first = result.refusals[0];
        const status = first.reason === 'not-found' ? 404 : 409;
        return res.status(status).json({
          ok: false,
          reason: first.reason,
          error: first.detail,
          refusals: result.refusals,
        });
      }
      writes.push({ file, rel, before, after: result.contents, edits, applied: result.applied });
    }

    // Nothing reloads a static page, so say what every surviving element is
    // called now. Without this the second save of a session is always stale.
    let ids = {};
    for (const w of writes) {
      writeAtomic(w.file, w.after);
      const map = html.remap(w.before, w.after, w.rel, w.edits.filter((e) => e.remove).map((e) => e.id));
      ids = map && ids ? Object.assign(ids, map) : null;
      console.log(`wrote ${w.rel}: ${w.edits.length} edit(s) on <${w.applied.join('>, <')}>`);
    }

    res.json({
      ok: true,
      hash: html.hashOf(writes[0].after),
      files: writes.map((w) => w.rel),
      ids,
      reload: !ids,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Pages are stamped on the way out: an identity attribute per element and the
// overlay's script, spliced into the file's own bytes. The file on disk stays
// clean.
app.get(/.*/, (req, res, next) => {
  const file = pageFor(req.path);
  if (!file) return next();
  try {
    const rel = path.relative(SITE_ROOT, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    const stamped = RUNTIME_JIT.test(source)
      ? html.stamp(source, rel, '/editor.js')
      : html.stamp(source, rel, '/editor.js?preview=1', '<link rel="stylesheet" href="/thisone-palette.css">');
    res.type('html').send(stamped.html);
  } catch (err) {
    console.error(err);
    res.status(500).type('text').send(`Failed to render ${req.path}: ${err.message}`);
  }
});

// A stylesheet Tailwind built holds the classes the site had at build time. A
// class saved since then is in the .html and in no CSS, so the page reloads
// without the change that was just written. Under Next the dev server rebuilds.
// Here this does: the same input, compiled by the site's own Tailwind, against
// the site as it is on disk now. Served, never written: the file on disk is the
// user's build output and their build is what updates it.
const BUILT_BY_TAILWIND = /^\/\*! tailwindcss v/;
const TAILWIND_INPUT = /@import\s+["']tailwindcss["' /]/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.thisone']);

function walkSite(dir, want, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSite(abs, want, out);
    else if (want.test(entry.name)) out.push(abs);
  }
  return out;
}

/** The one stylesheet that imports Tailwind, or null when there are none or several. */
function tailwindInput() {
  const inputs = walkSite(SITE_ROOT, /\.css$/i).filter((f) => {
    const css = fs.readFileSync(f, 'utf8');
    return !BUILT_BY_TAILWIND.test(css) && TAILWIND_INPUT.test(css);
  });
  return inputs.length === 1 ? inputs[0] : null;
}

/** Anything in the site's markup and scripts that could be a class. Tailwind drops the rest. */
function siteCandidates() {
  const found = new Set();
  for (const file of walkSite(SITE_ROOT, /\.(html?|js|mjs)$/i)) {
    for (const token of fs.readFileSync(file, 'utf8').split(/[\s"'`<>=]+/)) {
      if (token && token.length < 200) found.add(token);
    }
  }
  return [...found];
}

async function rebuildCss(input) {
  const { createRequire } = require('module');
  const req = createRequire(path.join(SITE_ROOT, 'package.json'));
  const resolveCss = (id, base) => (id.startsWith('.') || path.isAbsolute(id)
    ? path.resolve(base, id)
    : req.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id));
  const compiler = await req('tailwindcss').compile(fs.readFileSync(input, 'utf8'), {
    base: path.dirname(input),
    onDependency() {},
    loadStylesheet: async (id, base) => {
      const file = resolveCss(id, base);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
    },
    loadModule: async (id, base) => {
      const file = id.startsWith('.') ? path.resolve(base, id) : req.resolve(id);
      return { path: file, base: path.dirname(file), module: req(file) };
    },
  });
  return compiler.build(siteCandidates());
}

let toldAboutRebuild = false;
app.get(/\.css$/i, (req, res, next) => {
  let file;
  try { file = resolveInSite(decodeURIComponent(req.path).replace(/^\/+/, '')); } catch { return next(); }
  if (!file || !fs.existsSync(file)) return next();
  if (!BUILT_BY_TAILWIND.test(fs.readFileSync(file, 'utf8').slice(0, 64))) return next();

  const input = tailwindInput();
  if (!input) {
    // No input, or several: which one built this file would be a guess.
    if (!toldAboutRebuild) {
      toldAboutRebuild = true;
      console.log(`${req.path} was built by Tailwind, but its input could not be told apart. ` +
        'Classes saved from here render after your own build runs.');
    }
    return next();
  }
  rebuildCss(input).then(
    (css) => {
      if (!toldAboutRebuild) {
        toldAboutRebuild = true;
        console.log(`${req.path}: served fresh from ${path.relative(SITE_ROOT, input)}, so a saved class ` +
          'renders on reload. The file on disk is untouched. Run your build before you deploy.');
      }
      res.set('Cache-Control', 'no-store').type('text/css').send(css);
    },
    (err) => {
      console.error(`could not rebuild ${req.path}: ${err.message}`);
      next();
    });
});

// Stylesheets, images, fonts: a page is more than its markup.
app.use(express.static(SITE_ROOT));

// Write to a sibling temp file and rename, so a crash mid-write can never
// leave index.html truncated.
function writeAtomic(file, contents) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

// This process writes files, so it answers this machine only. Bound to every
// interface, anyone on the same network could post to /edit.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`thisone -> http://localhost:${PORT}`);
  console.log(`editing ${SITE_ROOT}`);
});
