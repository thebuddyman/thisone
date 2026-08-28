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
const { runTurn } = require('./claude');
const {
  compilePalette, extractColors, extractTextSizes, extractFontWeights, extractRadii, HUES,
} = require('./palette');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(arg('root', process.cwd()));
const PORT = Number(arg('port', 3500));
const APP = arg('app', 'http://localhost:3000');

// Off unless asked for, and the tab is not even drawn without it.
//
// /edit and /prompt are not the same kind of route wearing the same lock.
// /edit replaces a byte span inside a .tsx under the root, and safeResolve is
// what makes that true; /prompt hands a sentence to a coding agent, and no
// amount of path checking bounds what comes out the other side. Same token,
// same origin, categorically larger blast radius — so it is opt-in, the way
// anything you would not want on by default has to be.
const PROMPT_ENABLED = process.argv.includes('--prompt');
const PROMPT_MODEL = arg('prompt-model', undefined);
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

let textSizes = {};
try {
  textSizes = extractTextSizes(ROOT);
} catch {
  textSizes = require('./text-sizes.json');
}

let fontWeights = {};
try {
  fontWeights = extractFontWeights(ROOT);
} catch {
  fontWeights = require('./font-weights.json');
}

let radii = {};
try {
  radii = extractRadii(ROOT);
} catch {
  radii = require('./radii.json');
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

/**
 * The three checks every writing route shares. Returns false once it has
 * answered the request itself.
 *
 * Factored out when /prompt arrived rather than copied: the second copy of a
 * security gate is the one that drifts.
 */
function guard(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    json(res, 403, { ok: false, error: `origin not allowed: ${origin || '(none)'}` });
    return false;
  }
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    // The three content types a cross-origin form can send without preflight
    // are exactly the ones to refuse here.
    json(res, 415, { ok: false, error: 'expected application/json' });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(res, 401, { ok: false, error: 'bad or missing token' });
    return false;
  }
  return true;
}

/** Read a JSON body, refusing anything that looks like it is not one. */
function readJson(req, res, limit, then) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > limit) req.destroy();
  });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON' });
    }
    then(payload);
  });
}

// One turn at a time. Two headless sessions editing the same file from the same
// panel is a race with no upside — and the panel has one text box, so a second
// turn can only be an accident.
let turnInFlight = null;

function handlePrompt(req, res, payload) {
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    return json(res, 400, { ok: false, error: 'prompt must be a non-empty string' });
  }
  if (payload.prompt.length > 8000) {
    return json(res, 400, { ok: false, error: 'prompt too long' });
  }
  if (turnInFlight) {
    return json(res, 409, { ok: false, error: 'a turn is already running' });
  }

  // Server-sent events rather than a JSON reply: a turn takes tens of seconds
  // and the panel has to show that something is happening.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let settled = false;
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.t === 'done') {
      settled = true;
      turnInFlight = null;
      res.end();
    }
  };

  const ctx = payload.context && typeof payload.context === 'object' ? payload.context : null;
  console.log(`prompt: ${JSON.stringify(payload.prompt.slice(0, 80))}${ctx ? ` @ ${ctx.file}:${ctx.line}` : ''}`);

  turnInFlight = runTurn(
    {
      cwd: ROOT,
      prompt: payload.prompt,
      context: ctx,
      sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      model: PROMPT_MODEL,
    },
    send
  );

  // The tab was closed, or Stop was pressed. Either way nobody is reading the
  // answer, and a turn nobody is reading is still writing to their files.
  //
  // On the RESPONSE, never on the request: `req`'s 'close' fires as soon as the
  // body has been read, which is a moment after every turn starts — it killed
  // each one within milliseconds and reported it as `claude exited null`, a
  // signal death dressed up as a crash. `res` closes when the client actually
  // goes away, which is the thing being asked about.
  res.on('close', () => {
    if (settled) return;
    settled = true;
    if (turnInFlight) {
      turnInFlight.kill();
      turnInFlight = null;
    }
  });
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
    if (edit.remove !== undefined && typeof edit.remove !== 'boolean') {
      return json(res, 400, { ok: false, error: 'remove must be a boolean' });
    }
    if (edit.runs !== undefined) {
      if (!Array.isArray(edit.runs)) {
        return json(res, 400, { ok: false, error: 'runs must be an array' });
      }
      for (const r of edit.runs) {
        if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') {
          return json(res, 400, { ok: false, error: 'each run needs a from and a to, both strings' });
        }
      }
    }
    if (edit.classes === undefined && edit.text === undefined
        && edit.runs === undefined && !edit.remove) {
      return json(res, 400, { ok: false, error: 'nothing to edit: send classes, text, runs and/or remove' });
    }
    const abs = safeResolve(loc.file);
    if (!abs) return json(res, 403, { ok: false, reason: 'outside-root', error: `refusing path: ${loc.file}` });
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push({
      id: edit.id, loc, classes: edit.classes, text: edit.text, runs: edit.runs,
      remove: edit.remove === true,
      // What actually changed, for spans that own only part of the class list.
      added: Array.isArray(edit.added) ? edit.added : undefined,
      removed: Array.isArray(edit.removed) ? edit.removed : undefined,
    });
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
        idAttr: 'data-thisone-loc',
        previewAttr: 'data-thisone-edited',
        endpoint: `http://localhost:${PORT}/edit`,
        promptEndpoint: PROMPT_ENABLED ? `http://localhost:${PORT}/prompt` : null,
        token: TOKEN,
        text: true, // a lone static JsxText child, written whole
        // ...and each literal run of a mixed element, written one at a time.
        textRuns: true,
        // The dev server re-renders from the new source after a write, so the
        // overlay must not take removed nodes out of the DOM itself.
        hmr: true,
        colors: colors,
        textSizes: textSizes,
        fontWeights: fontWeights,
        radii: radii,
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
    if (!guard(req, res)) return;
    readJson(req, res, 262144, (payload) => {
      try {
        handleEdit(req, res, payload);
      } catch (err) {
        console.error(err);
        json(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/prompt') {
    if (!PROMPT_ENABLED) {
      return json(res, 404, { ok: false, error: 'prompt disabled; start the server with --prompt' });
    }
    if (!guard(req, res)) return;
    readJson(req, res, 16384, (payload) => {
      try {
        handlePrompt(req, res, payload);
      } catch (err) {
        console.error(err);
        turnInFlight = null;
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
    // A port already in use is a normal thing to hit — a second project is
    // being edited, or the last run is still up — so it gets a sentence and an
    // exit code, not an unhandled 'error' event and a stack trace. Reading
    // `Unhandled 'error' event` makes it look like the tool is broken rather
    // than like you need a flag.
    server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') throw err;
      console.error(`\nport ${PORT} is already in use.`);
      console.error('Another thisone is probably running (one per project).');
      console.error(`Give this one its own port:  thisone --port ${PORT + 100}`);
      console.error('...and start the app with NEXT_PUBLIC_THISONE_PORT set to match,');
      console.error('or use `thisone dev`, which starts both and picks the ports itself.\n');
      process.exit(1);
    });

    server.listen(PORT, '127.0.0.1', () => {
      const addr = server.address();
      if (addr.address !== '127.0.0.1') throw new Error(`refusing to listen on ${addr.address}`);
      console.log(`bw editor  -> http://127.0.0.1:${PORT}  (project: ${ROOT})`);
      console.log(`app origin -> ${APP}`);
      console.log(`prompt tab -> ${PROMPT_ENABLED ? 'on (claude may write anywhere under the root)' : 'off (--prompt to enable)'}`);
    });
  });
