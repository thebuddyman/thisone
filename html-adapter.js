'use strict';

/**
 * Stamp and rewrite a plain .html file.
 *
 * The same contract as the JSX writer: an element is known by where its start
 * tag sits in the source (`file:line:col:hash`), and a write replaces the bytes
 * of one attribute value, one text run or one element. Nothing is serialized.
 * The file the user saved is the file they get back, with one span changed.
 *
 * parse5 is the WHATWG parser, so the tree is the one the browser builds, and
 * with `sourceCodeLocationInfo` every node and attribute carries the offsets
 * it was read from. Elements the parser invents (an implied <tbody>) have no
 * location and are never stamped, so they can never be written to.
 */

const { parse } = require('parse5');
const { hashOf, parseLoc, applySpans } = require('./next/jsx-adapter');

const ID_ATTR = 'data-thisone-loc';

const REFUSALS = {
  'run-missing': 'that text is no longer in the source',
  'run-ambiguous': 'the same text appears more than once in this element',
  'has-children': 'the element contains other elements',
  'no-text': 'the element has no closing tag to write text before',
  'raw-text': 'the element holds code, not text',
};

// Their bodies are not text the page reads, and `<` inside them is not markup.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template']);

function parseDocument(source) {
  return parse(source, { sourceCodeLocationInfo: true });
}

function findBody(document) {
  const html = document.childNodes.find((n) => n.tagName === 'html');
  return html && html.childNodes.find((n) => n.tagName === 'body');
}

/**
 * Every element under <body> that the file actually spells out, keyed by the
 * 1-based line:col of its `<`. Document order, so two parses of the same
 * elements line up index for index.
 */
function hostElements(document) {
  const found = new Map();
  const body = findBody(document);
  if (!body) return found;
  (function walk(node) {
    for (const child of node.childNodes || []) {
      if (!child.tagName) continue;
      const loc = child.sourceCodeLocation;
      if (loc && loc.startTag) found.set(`${loc.startLine}:${loc.startCol}`, child);
      // A <template>'s children live on .content, not here, and never render.
      walk(child);
    }
  })(body);
  return found;
}

/** The offset just past the tag name, where a new attribute can be spliced. */
function afterTagName(node) {
  return node.sourceCodeLocation.startTag.startOffset + 1 + node.tagName.length;
}

/**
 * The page as served: the file's own bytes, plus an identity attribute on each
 * element and the overlay's script. Spliced in, so what the browser parses
 * differs from the file by exactly those insertions.
 */
function stamp(source, rel, scriptSrc, extra) {
  const document = parseDocument(source);
  const hash = hashOf(source);
  const inserts = [];

  hostElements(document).forEach((node, lineCol) => {
    inserts.push({ pos: afterTagName(node), text: ` ${ID_ATTR}="${rel}:${lineCol}:${hash}"` });
  });

  // The fingerprint is set by script, not written onto <body>, because a file
  // may leave <body> implied and then there is no start tag to splice into.
  const tail = (extra ? '\n' + extra : '') +
    `\n<script>document.body.setAttribute('data-tw-hash', ${JSON.stringify(hash)})</script>` +
    `\n<script src="${scriptSrc}"></script>\n`;
  const body = findBody(document);
  const bodyEnd = body && body.sourceCodeLocation && body.sourceCodeLocation.endTag;
  const html = document.childNodes.find((n) => n.tagName === 'html');
  const htmlEnd = html && html.sourceCodeLocation && html.sourceCodeLocation.endTag;
  const at = bodyEnd ? bodyEnd.startOffset : htmlEnd ? htmlEnd.startOffset : source.length;
  inserts.push({ pos: at, text: tail });

  // Back to front, so earlier offsets stay valid as we splice.
  inserts.sort((a, b) => b.pos - a.pos);
  let out = source;
  for (const ins of inserts) out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
  return { html: out, hash };
}

/** A class list may hold the quote it is about to be wrapped in: content-['x']. */
function escapeAttr(value, quote) {
  return quote === "'" ? value.replace(/'/g, '&#39;') : value.replace(/"/g, '&quot;');
}

/** Typed text is text. `<` must not become markup on the way to disk. */
function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Where an attribute's value sits in the source.
 *
 * { start, end, quote } between the quotes, { whole: {start, end} } when the
 * value is unquoted or missing and the attribute has to be rewritten entire,
 * or { insertAt } when the element has no such attribute.
 */
function attributeSpan(source, node, name) {
  const attrs = node.sourceCodeLocation.attrs || {};
  const loc = attrs[name];
  if (!loc) return { insertAt: afterTagName(node) };

  const raw = source.slice(loc.startOffset, loc.endOffset);
  const eq = raw.indexOf('=');
  if (eq === -1) return { whole: { start: loc.startOffset, end: loc.endOffset } };

  let i = eq + 1;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  const quote = raw[i];
  if ((quote === '"' || quote === "'") && raw[raw.length - 1] === quote && raw.length - 1 > i) {
    return { start: loc.startOffset + i + 1, end: loc.endOffset - 1, quote };
  }
  return { whole: { start: loc.startOffset, end: loc.endOffset } };
}

/** An attribute and the whitespace in front of it, for taking it out cleanly. */
function attributeCut(source, node, name) {
  const loc = node.sourceCodeLocation.attrs[name];
  let start = loc.startOffset;
  while (start > 0 && /\s/.test(source[start - 1])) start--;
  return { start, end: loc.endOffset };
}

function elementChildren(node) {
  return (node.childNodes || []).filter((n) => n.tagName);
}

/** The literal runs of an element: its own text nodes, markup left out. */
function textRunNodes(node) {
  return (node.childNodes || []).filter(
    (n) => n.nodeName === '#text' && n.sourceCodeLocation && n.value.trim());
}

/** Whitespace folds when it renders, so compare the way the page reads. */
function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * The words of a stretch of source, without the whitespace either side. That
 * space is the layout's: `Read the <a>docs</a>` renders as two words because
 * of the trailing one, and writing a trimmed value over it gives `Read thedocs`.
 */
function trimmed(source, start, end) {
  const raw = source.slice(start, end);
  const lead = raw.match(/^\s*/)[0].length;
  const tail = raw.match(/\s*$/)[0].length;
  if (lead === raw.length) return { start, end };
  return { start: start + lead, end: end - tail };
}

function textSpan(source, node) {
  if (RAW_TEXT.has(node.tagName)) return { reason: 'raw-text', detail: `<${node.tagName}>` };
  if (elementChildren(node).length) {
    return { reason: 'has-children', detail: 'replacing its text would delete them' };
  }
  const loc = node.sourceCodeLocation;
  if (!loc.endTag) return { reason: 'no-text', detail: `<${node.tagName}> is never closed in the file` };
  return trimmed(source, loc.startTag.endOffset, loc.endTag.startOffset);
}

/**
 * One literal, found by what it says and not by position. `from` is what the
 * overlay believed was there, so a file that has moved on is refused.
 */
function textRunSpan(source, node, from) {
  const hits = textRunNodes(node).filter((n) => collapse(n.value) === collapse(from));
  if (hits.length !== 1) {
    return {
      reason: hits.length ? 'run-ambiguous' : 'run-missing',
      detail: collapse(from).slice(0, 60),
    };
  }
  const loc = hits[0].sourceCodeLocation;
  return trimmed(source, loc.startOffset, loc.endOffset);
}

/**
 * The whole element. When it owns its lines outright, the indentation in
 * front and the newline behind go with it, so the cut closes over.
 */
function removeSpan(source, node) {
  const loc = node.sourceCodeLocation;
  let start = loc.startOffset;
  let end = loc.endOffset;

  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = source.indexOf('\n', end);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  if (/^\s*$/.test(source.slice(lineStart, start)) && /^\s*$/.test(source.slice(end, lineEnd))) {
    start = lineStart;
    end = nextNewline === -1 ? source.length : nextNewline + 1;
  }
  return { start, end };
}

/**
 * Apply several edits to one file against a single parse. Pure: source in,
 * source out. Any refusal aborts the file, because a partial write is worse
 * than none.
 *
 * Each edit is { id, loc, classes?, text?, runs?, remove? }, with `loc` from
 * parseLoc(id).
 */
function editFile(source, edits) {
  const stale = edits.find((e) => e.loc.hash && e.loc.hash !== hashOf(source));
  if (stale) {
    return { ok: false, refusals: [{ id: stale.id, reason: 'stale-hash', detail: `${stale.loc.file} changed on disk` }] };
  }

  const nodes = hostElements(parseDocument(source));
  const spans = [];
  const refusals = [];
  const refuse = (edit, tag, span) => refusals.push({
    id: edit.id, reason: span.reason, tag, detail: `${REFUSALS[span.reason]}: ${span.detail}`,
  });

  for (const edit of edits) {
    const node = nodes.get(`${edit.loc.line}:${edit.loc.col}`);
    if (!node) {
      refusals.push({ id: edit.id, reason: 'not-found', detail: `no element at ${edit.loc.line}:${edit.loc.col}` });
      continue;
    }
    const tag = node.tagName;

    if (edit.remove) {
      spans.push({ id: edit.id, span: removeSpan(source, node), tag, insertion: (v) => v, value: '', remove: true });
      continue;
    }

    if (edit.classes !== undefined) {
      const next = String(edit.classes).trim().replace(/\s+/g, ' ');
      const span = attributeSpan(source, node, 'class');
      if (span.insertAt !== undefined) {
        // No attribute and nothing to put in one: there is no edit to make.
        if (next) spans.push({ id: edit.id, span, tag, insertion: (v) => ` class="${v}"`, value: escapeAttr(next, '"') });
      } else if (!next) {
        // An emptied class list leaves no `class=""` behind.
        spans.push({ id: edit.id, span: attributeCut(source, node, 'class'), tag, insertion: (v) => v, value: '' });
      } else if (span.whole) {
        spans.push({ id: edit.id, span: span.whole, tag, insertion: (v) => v, value: `class="${escapeAttr(next, '"')}"` });
      } else {
        spans.push({ id: edit.id, span, tag, insertion: (v) => v, value: escapeAttr(next, span.quote) });
      }
    }

    if (edit.text !== undefined) {
      const span = textSpan(source, node);
      if (span.reason) { refuse(edit, tag, span); continue; }
      spans.push({ id: edit.id, span, tag, insertion: (v) => v, value: escapeText(String(edit.text).trim()) });
    }

    if (Array.isArray(edit.runs)) {
      for (const run of edit.runs) {
        const span = textRunSpan(source, node, run.from);
        if (span.reason) { refuse(edit, tag, span); break; }
        spans.push({ id: edit.id, span, tag, insertion: (v) => v, value: escapeText(String(run.to).trim()) });
      }
    }
  }

  if (refusals.length) return { ok: false, refusals };
  return applySpans(source, spans);
}

/**
 * Old id → new id, for a page that will not reload itself.
 *
 * A write moves every later element's line or column and changes the hash, so
 * the ids the browser holds all go stale at once. Under Next, HMR re-runs the
 * loader. Here nothing does, so the server works the mapping out: the elements
 * that survive keep their order, which makes it a zip of the two parses.
 * Returns null when the counts disagree, and the page should reload.
 */
function remap(before, after, rel, removedIds) {
  const gone = new Set();
  const oldNodes = hostElements(parseDocument(before));
  for (const id of removedIds) {
    const loc = parseLoc(id);
    const node = loc && oldNodes.get(`${loc.line}:${loc.col}`);
    if (!node) continue;
    (function mark(n) {
      gone.add(n);
      (n.childNodes || []).forEach(mark);
    })(node);
  }

  const oldKeys = [...oldNodes].filter(([, n]) => !gone.has(n)).map(([k]) => k);
  const newKeys = [...hostElements(parseDocument(after)).keys()];
  if (oldKeys.length !== newKeys.length) return null;

  const oldHash = hashOf(before);
  const newHash = hashOf(after);
  const ids = {};
  oldKeys.forEach((k, i) => { ids[`${rel}:${k}:${oldHash}`] = `${rel}:${newKeys[i]}:${newHash}`; });
  return ids;
}

module.exports = {
  ID_ATTR, REFUSALS, hashOf, parseLoc, parseDocument, hostElements, stamp,
  attributeSpan, textSpan, textRunSpan, removeSpan, editFile, remap,
};
