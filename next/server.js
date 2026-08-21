'use strict';

/**
 * Editor server for a Next.js project — a SEPARATE PROCESS on its own port.
 *
 * Deliberately not a Route Handler or middleware: keeping the file-writing code
 * out of the app's build graph entirely is a stronger guarantee that it can
 * never reach production than any NODE_ENV check. It is also what lets the same
 * binary serve a Vite or Astro app later.
 *
 *   node next/server.js --root /path/to/project [--port 3500] [--app http://localhost:3000]
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { loadTypeScript, parseLoc, editFile } = require('./jsx-adapter');
const { compilePalette, extractColors, HUES } = require('./palette');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(arg('root', process.cwd()));
const PORT = Number(arg('port', 3500));
const APP = arg('app', 'http://localhost:3000');
const OVERLAY_FILE = path.join(__dirname, '..', 'editor.js');

// Next treats localhost and 127.0.0.1 as different origins; allow both forms or
// this breaks depending on which one the developer happens to type.
const ALLOWED_ORIGINS = new Set([APP, APP.replace('localhost', '127.0.0.1'), APP.replace('127.0.0.1', 'localhost')]);

// Minted per run and baked into the overlay we serve. A hostile page can
// <script src> the overlay but cannot read its body, so the token stays put.
const TOKEN = crypto.randomBytes(24).toString('hex');

const EDITABLE_EXT = new Set(['.tsx', '.jsx']);
const DENY_SEGMENTS = new Set(['node_modules', '.next', '.git', 'dist', 'build']);

let paletteCss = '/* palette not compiled */';

// The picker offers what THIS project can render, so read its theme; the
// snapshot is only a fallback for projects without a resolvable tailwind.
let colors;
try {
  const raw = extractColors(ROOT);
  colors = { order: HUES.filter((h) => raw[h]), ramps: raw };
} catch {
  const raw = require('./colors.json');
  colors = { order: HUES.filter((h) => raw[h]), ramps: raw };
}

/** Resolve a project-relative path, refusing anything that escapes the root. */
function safeResolve(rel) {
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) return null;
  if (rel.split('/').some((seg) => DENY_SEGMENTS.has(seg) || seg.startsWith('.'))) return null;
  if (!EDITABLE_EXT.has(path.extname(rel))) return null;

  const abs = path.resolve(ROOT, rel);
  let realDir;
  try {
    realDir = fs.realpathSync(path.dirname(abs));
  } catch {
    return null;
  }
  const realRoot = fs.realpathSync(ROOT);
  // realpath on both sides is what defeats a symlink inside the project that
  // points out of it.
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return null;
  return abs;
}

function writeAtomic(file, contents) {
  // Dot-prefixed and in the same directory: same filesystem so rename stays
  // atomic, and the bundler's watcher ignores it. A sibling `page.tsx.tmp-123`
  // would hand Turbopack a file it tries to reason about.
  const tmp = path.join(path.dirname(file), `.bw-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : undefined;
  fs.writeFileSync(tmp, contents, 'utf8');
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleEdit(req, res, payload) {
  const list = Array.isArray(payload.edits) ? payload.edits : [payload];
  if (!list.length) return json(res, 400, { ok: false, error: 'no edits supplied' });

  // Group by file: every file gets one parse and one write.
  const byFile = new Map();
  for (const edit of list) {
    const loc = parseLoc(edit.id);
    if (!loc) return json(res, 400, { ok: false, error: `unparseable id: ${JSON.stringify(edit.id)}` });
    if (edit.classes !== undefined && typeof edit.classes !== 'string') {
      return json(res, 400, { ok: false, error: 'classes must be a string' });
    }
    if (edit.text !== undefined && typeof edit.text !== 'string') {
      return json(res, 400, { ok: false, error: 'text must be a string' });
    }
    if (edit.classes === undefined && edit.text === undefined) {
      return json(res, 400, { ok: false, error: 'nothing to edit: send classes and/or text' });
    }
    const abs = safeResolve(loc.file);
    if (!abs) return json(res, 403, { ok: false, reason: 'outside-root', error: `refusing path: ${loc.file}` });
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push({ id: edit.id, loc, classes: edit.classes, text: edit.text });
  }

  const ts = loadTypeScript(ROOT);
  const planned = [];
  const refusals = [];

  // Resolve everything before writing anything: a batch that half-applies is
  // worse than one that is refused.
  for (const [abs, edits] of byFile) {
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      refusals.push({ id: edits[0].id, reason: 'not-found', detail: `cannot read ${edits[0].loc.file}` });
      continue;
    }
    const result = editFile(ts, abs, source, edits);
    if (!result.ok) refusals.push(...result.refusals);
    else planned.push({ abs, contents: result.contents, tags: result.applied, rel: edits[0].loc.file });
  }

  if (refusals.length) {
    const stale = refusals.some((r) => r.reason === 'stale-hash');
    return json(res, stale ? 409 : 422, { ok: false, reason: refusals[0].reason, refusals, error: refusals[0].detail });
  }

  for (const file of planned) writeAtomic(file.abs, file.contents);
  console.log(`wrote ${planned.map((f) => `${f.rel} (${f.tags.join(', ')})`).join('; ')}`);
  return json(res, 200, { ok: true, files: planned.map((f) => f.rel) });
}

const server = http.createServer((req, res) => {
  cors(req, res);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/overlay.js') {
    const prelude =
      'window.__TW_EDITOR__ = ' +
      JSON.stringify({
        idAttr: 'data-bw-loc',
        previewAttr: 'data-bw-edited',
        endpoint: `http://localhost:${PORT}/edit`,
        token: TOKEN,
        text: true, // only a lone static JsxText child is editable; the rest is refused
        colors: colors,
      }) +
      ';\n';
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(prelude + fs.readFileSync(OVERLAY_FILE, 'utf8'));
  }

  if (req.method === 'GET' && url.pathname === '/palette.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(paletteCss);
  }

  if (req.method === 'POST' && url.pathname === '/edit') {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: `origin not allowed: ${origin || '(none)'}` });
    }
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      // The three content types a cross-origin form can send without preflight
      // are exactly the ones to refuse here.
      return json(res, 415, { ok: false, error: 'expected application/json' });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(res, 401, { ok: false, error: 'bad or missing token' });
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 262144) req.destroy();
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, error: 'invalid JSON' });
      }
      try {
        handleEdit(req, res, payload);
      } catch (err) {
        console.error(err);
        json(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

compilePalette(ROOT)
  .then((p) => {
    paletteCss = p.css;
    console.log(`palette: ${p.rules} rules from tailwind ${p.version}`);
  })
  .catch((err) => console.error(`palette compile failed: ${err.message}`))
  .finally(() => {
    server.listen(PORT, '127.0.0.1', () => {
      const addr = server.address();
      if (addr.address !== '127.0.0.1') throw new Error(`refusing to listen on ${addr.address}`);
      console.log(`bw editor  -> http://127.0.0.1:${PORT}  (project: ${ROOT})`);
      console.log(`app origin -> ${APP}`);
    });
  });
