'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// The page to edit. Overridable so the test suites run against a throwaway
// fixture instead of mutating the demo page.
const INDEX_FILE = process.env.TW_EDITOR_FILE
  ? path.resolve(process.env.TW_EDITOR_FILE)
  : path.join(ROOT, 'index.html');
const EDITOR_FILE = path.join(ROOT, 'editor.js');

// Keep comments, doctype and raw <script>/<style> bodies intact so that
// re-serializing the tree round-trips the file rather than rewriting it.
const PARSE_OPTS = {
  comment: true,
  blockTextElements: { script: true, noscript: true, style: true, pre: true },
};

/** Fingerprint of the file as it is on disk right now. */
function hashOf(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
}

function loadDocument() {
  const html = fs.readFileSync(INDEX_FILE, 'utf8');
  const root = parse(html, PARSE_OPTS);
  const body = root.querySelector('body');
  if (!body) throw new Error('index.html has no <body> element');
  return { root, body, hash: hashOf(html) };
}

/**
 * The single source of truth for element identity.
 *
 * Depth-first, document order, elements only (no text/comment nodes),
 * starting inside <body>. GET and POST both call this against the same
 * on-disk bytes, so index N means the same element in both directions.
 */
function collectElements(body) {
  const elements = [];
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue; // ELEMENT_NODE
      elements.push(child);
      walk(child);
    }
  })(body);
  return elements;
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// Serve an annotated copy of index.html. The data-eid attributes and the
// editor <script> exist only in this response; the file on disk stays clean.
app.get('/', (req, res) => {
  try {
    const { root, body, hash } = loadDocument();
    collectElements(body).forEach((el, i) => el.setAttribute('data-eid', String(i)));
    // The page carries the fingerprint of the bytes its eids were derived from.
    // Every write quotes it back, so a file edited out of band can never have a
    // stale eid applied to whatever element now sits at that index.
    body.setAttribute('data-tw-hash', hash);
    // Injected after tagging, so the editor script itself never gets an eid.
    body.insertAdjacentHTML('beforeend', '\n<script src="/editor.js"></script>\n');
    res.type('html').send(root.toString());
  } catch (err) {
    console.error(err);
    res.status(500).type('text').send(`Failed to render index.html: ${err.message}`);
  }
});

// The overlay is served with a config prelude, exactly as the Next editor
// server does it, so both modes run the same client with the same colour data.
const COLOR_RAMPS = require('./next/colors.json');
const { HUES } = require('./next/palette');
const TEXT_SIZES = require('./next/text-sizes.json');
const FONT_WEIGHTS = require('./next/font-weights.json');
const RADII = require('./next/radii.json');

// Served locally rather than from a CDN: the test suite must not depend on a
// network fetch, which made runs intermittently fail with unstyled pages.
app.get('/tailwind-browser.js', (req, res) => {
  res.type('application/javascript').sendFile(require.resolve('@tailwindcss/browser'));
});

app.get('/editor.js', (req, res) => {
  const prelude =
    'window.__TW_EDITOR__ = ' +
    JSON.stringify({ colors: { order: HUES.filter((h) => COLOR_RAMPS[h]), ramps: COLOR_RAMPS }, textSizes: TEXT_SIZES, fontWeights: FONT_WEIGHTS, radii: RADII }) +
    ';\n';
  res.type('application/javascript').send(prelude + fs.readFileSync(EDITOR_FILE, 'utf8'));
});

// node-html-parser writes textContent through verbatim, so anything typed in
// the browser would land in the file as live markup. Escape it into a text
// node; the parser decodes these entities again on the way back out.
function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hasElementChildren(element) {
  return element.childNodes.some((node) => node.nodeType === 1);
}

/**
 * The overlay sends an opaque `id` (the value of whatever identity attribute
 * this backend stamped). For the HTML backend that is the positional index;
 * `eid` stays accepted so direct callers and older payloads keep working.
 */
function eidOf(edit) {
  return Number(edit && (edit.id !== undefined ? edit.id : edit.eid));
}

/** Validate one {id, classes, text} entry, returning an error string or null. */
function validateEdit(edit) {
  const index = eidOf(edit);
  if (!Number.isInteger(index) || index < 0) {
    return `invalid eid: ${JSON.stringify(edit && (edit.id !== undefined ? edit.id : edit.eid))}`;
  }
  if (edit.classes !== undefined && typeof edit.classes !== 'string') {
    return 'classes must be a string';
  }
  if (edit.text !== undefined && typeof edit.text !== 'string') {
    return 'text must be a string';
  }
  if (edit.remove !== undefined && typeof edit.remove !== 'boolean') {
    return 'remove must be a boolean';
  }
  if (edit.classes === undefined && edit.text === undefined && !edit.remove) {
    return 'nothing to edit: send classes, text and/or remove';
  }
  return null;
}

// Write-back: re-read and re-traverse the file on disk, apply every edit in the
// batch against one parse, and serialize the whole document back out once.
//
// Accepts either a single {eid, classes, text} or {edits: [...]}. A batch is not
// a convenience: saving N elements as N requests would invalidate the hash after
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
    const { root, body, hash } = loadDocument();

    // Optimistic concurrency. Without this a stale eid — from a file edited in
    // an editor, or reformatted, or checked out on another branch — is applied
    // to whatever element now occupies that index.
    if (payload.hash !== undefined && payload.hash !== hash) {
      return res.status(409).json({
        ok: false,
        reason: 'stale-hash',
        error: 'index.html changed on disk since this page loaded',
        hash,
      });
    }

    const elements = collectElements(body);
    const applied = [];

    for (const edit of list) {
      const index = eidOf(edit);
      const element = elements[index];
      if (!element) {
        return res.status(404).json({ ok: false, reason: 'not-found', error: `no element with eid ${index}` });
      }

      // Resolved before anything else: an element on its way out has no use
      // for a class or text edit.
      if (edit.remove) {
        if (!element.parentNode) {
          return res.status(409).json({
            ok: false,
            reason: 'root-element',
            error: `eid ${index} <${element.rawTagName}> has no parent; refusing to remove it`,
          });
        }
        // Take the indentation in front of it too. Left behind, it serializes
        // as a blank line full of trailing spaces where the element used to be.
        const siblings = element.parentNode.childNodes;
        const before = siblings[siblings.indexOf(element) - 1];
        if (before && before.nodeType === 3 && !before.rawText.trim()) before.remove();
        element.remove();
        applied.push(`#${index} <${element.rawTagName}> removed`);
        continue;
      }

      if (edit.classes !== undefined) {
        const next = edit.classes.trim().replace(/\s+/g, ' ');
        if (next) element.setAttribute('class', next);
        else element.removeAttribute('class');
      }

      if (edit.text !== undefined) {
        // Replacing the children of a container would silently delete markup, so
        // only leaf elements may have their text rewritten.
        if (hasElementChildren(element)) {
          return res.status(409).json({
            ok: false,
            reason: 'has-children',
            error: `eid ${index} <${element.rawTagName}> contains child elements; refusing to replace its text`,
          });
        }
        element.textContent = escapeText(edit.text);
      }

      applied.push(`#${index} <${element.rawTagName}>`);
    }

    const serialized = root.toString();
    writeAtomic(INDEX_FILE, serialized);
    console.log(`wrote ${applied.length} edit(s): ${applied.join(', ')}`);
    res.json({ ok: true, hash: hashOf(serialized) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Write to a sibling temp file and rename, so a crash mid-write can never
// leave index.html truncated.
function writeAtomic(file, contents) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

app.listen(PORT, () => {
  console.log(`visual tailwind editor -> http://localhost:${PORT}`);
  console.log(`editing ${INDEX_FILE}`);
});
