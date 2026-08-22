'use strict';

/**
 * Rewrite a className string literal in a .tsx/.jsx file.
 *
 * This is a SPAN REPLACEMENT, not a tree edit: we already know the node from
 * the source location, so we replace the bytes strictly between the quotes and
 * leave every other byte alone. No printer runs, so nothing can reformat the
 * file, change quote style, or move a trailing comma into your diff.
 *
 * It also means the loader and the writer share one parse function, so their
 * idea of "the element at line:col" cannot drift apart.
 */

const crypto = require('crypto');
const path = require('path');
const { createRequire } = require('module');

/** Short fingerprint of a file's bytes; must match the loader's. */
function hashOf(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 8);
}

/**
 * Resolve the project's OWN typescript where possible, so a TS 5 project is
 * never parsed by a TS 6 parser or vice versa. Falls back to ours for projects
 * that ship no TypeScript (plain .jsx) and for unit tests.
 */
function loadTypeScript(root) {
  // TypeScript 7 (the native port) does not expose the classic compiler API
  // from its CommonJS entry — `createSourceFile` and friends are simply absent.
  // Probe for it rather than crashing three frames deeper on `ts.ScriptTarget`.
  const usable = (mod) => mod && typeof mod.createSourceFile === 'function' && mod.ScriptTarget;

  try {
    const projectTs = createRequire(path.join(root, 'package.json'))('typescript');
    if (usable(projectTs)) return projectTs;
  } catch {
    /* fall through to ours */
  }

  const ours = require('typescript');
  if (usable(ours)) return ours;

  throw new Error(
    `no usable TypeScript compiler API found (project: ${root}). ` +
      'TypeScript 7 does not expose createSourceFile from its CommonJS entry; ' +
      'install typescript@5 or typescript@6 in the project.'
  );
}

/** "src/app/page.tsx:24:7:a1b2c3d4" → { file, line, col, hash } */
function parseLoc(id) {
  const bits = String(id || '').split(':');
  if (bits.length < 3) return null;
  const hash = bits.length >= 4 ? bits.pop() : null;
  const col = Number(bits.pop());
  const line = Number(bits.pop());
  const file = bits.join(':');
  if (!file || !Number.isInteger(line) || !Number.isInteger(col)) return null;
  return { file, line, col, hash };
}

/** Every JSX host element in a source file, keyed by 1-based line:col. */
function hostElements(ts, sourceFile) {
  const found = new Map();
  (function walk(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      if (/^[a-z]/.test(tag)) {
        const start = node.getStart(sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
        found.set(`${line + 1}:${character + 1}`, node);
      }
    }
    ts.forEachChild(node, walk);
  })(sourceFile);
  return found;
}

// Composition helpers whose first string argument holds the base classes.
const CN_CALLEES = new Set(['cn', 'clsx', 'classnames', 'classNames', 'cx', 'twMerge', 'twJoin']);

const REFUSALS = {
  'cn-call': 'classes are built by a function call',
  'cn-no-literal': 'the composition call has no plain string to edit',
  'cva-call': 'classes come from a cva() variant definition',
  'template-literal': 'classes are built by a template literal',
  'dynamic-classname': 'classes come from a variable',
  'unsupported-shape': 'unsupported className expression',
  'mixed-content': 'text is mixed with markup or an expression',
  'no-text': 'element has no text body',
  'root-element': 'the element is what its component returns',
  'unsupported-parent': 'the element is not a child of other JSX',
};

/**
 * `{`, `}`, `<` and `>` are JSX *syntax*, so typing one would break the file.
 * JSX text honours HTML entities, so escape rather than refuse.
 */
function escapeJsxText(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

/**
 * The editable span of an element's text body.
 *
 * Only a lone JsxText child qualifies. `<p>Hello {name}</p>` renders as one
 * string but is two nodes, and nothing tells us which typed characters belong
 * to the literal and which to the expression — so that case is refused rather
 * than guessed at.
 *
 * The span deliberately excludes surrounding whitespace: JSX strips leading and
 * trailing whitespace on lines containing newlines, so the source indentation
 * must survive the rewrite untouched.
 */
function textSpan(ts, sourceFile, opening, source) {
  if (ts.isJsxSelfClosingElement(opening)) {
    return { reason: 'no-text', detail: 'self-closing element' };
  }
  const element = opening.parent;
  if (!element || !ts.isJsxElement(element)) {
    return { reason: 'no-text', detail: 'no element body' };
  }

  const kids = element.children.filter(
    (c) => !(ts.isJsxText(c) && c.getText(sourceFile).trim() === '')
  );

  if (kids.length === 0) {
    return { insertAt: element.openingElement.getEnd() };
  }
  if (kids.length !== 1 || !ts.isJsxText(kids[0])) {
    const kinds = kids.map((c) => (ts.isJsxExpression(c) ? '{expression}' : ts.isJsxText(c) ? 'text' : 'element'));
    return { reason: 'mixed-content', detail: kinds.join(' + ') };
  }

  const node = kids[0];
  const full = source.slice(node.pos, node.end);
  const leading = full.match(/^\s*/)[0].length;
  const trailing = full.match(/\s*$/)[0].length;
  return { start: node.pos + leading, end: node.end - trailing };
}

/**
 * The byte span to cut when removing an element.
 *
 * Only a child of another JSX element or fragment may go. That is the one
 * position where lifting the node out leaves the file parsing: a component's
 * root has to return something, `{open && <div/>}` would be left as
 * `{open && }`, and the body of a `.map()` arrow is the value it yields. Each
 * of those is refused by name rather than guessed at.
 *
 * When the element owns its lines outright, the indentation in front of it and
 * the newline behind it go with it, so the cut closes over instead of leaving a
 * blank line in the diff.
 */
function removeSpan(ts, sourceFile, node, source) {
  const element = ts.isJsxSelfClosingElement(node) ? node : node.parent;
  if (!element || !(ts.isJsxElement(element) || ts.isJsxSelfClosingElement(element))) {
    return { reason: 'unsupported-parent', detail: 'the element could not be resolved' };
  }

  const parent = element.parent;
  if (!parent || !(ts.isJsxElement(parent) || ts.isJsxFragment(parent))) {
    if (parent && (ts.isReturnStatement(parent) || ts.isParenthesizedExpression(parent) ||
        ts.isArrowFunction(parent) || ts.isVariableDeclaration(parent))) {
      return { reason: 'root-element', detail: 'removing it would leave nothing to render' };
    }
    if (parent && ts.isJsxExpression(parent)) {
      return { reason: 'unsupported-parent', detail: 'it is the value of a {expression}' };
    }
    return {
      reason: 'unsupported-parent',
      detail: 'its parent is ' + (parent ? ts.SyntaxKind[parent.kind] : 'nothing'),
    };
  }

  let start = element.getStart(sourceFile);
  let end = element.getEnd();

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
 * Locate the editable span of an element's className.
 *
 * Returns { start, end } of the characters BETWEEN the quotes, or
 * { insertAt } when the element has no className attribute at all, or
 * { reason, detail } when the shape is not safe to rewrite.
 */
function classNameSpan(ts, sourceFile, node) {
  const attr = node.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText(sourceFile) === 'className'
  );

  if (!attr) return { insertAt: node.tagName.getEnd() };

  const init = attr.initializer;
  if (!init) return { insertAt: node.tagName.getEnd() };

  // className="a b c"
  if (ts.isStringLiteral(init)) {
    return { start: init.getStart(sourceFile) + 1, end: init.getEnd() - 1 };
  }

  if (ts.isJsxExpression(init)) {
    const expr = init.expression;
    if (!expr) return { reason: 'unsupported-shape', detail: 'empty expression' };

    // className={"a b c"}
    if (ts.isStringLiteral(expr)) {
      return { start: expr.getStart(sourceFile) + 1, end: expr.getEnd() - 1 };
    }
    // className={`a b c`} with no ${}
    if (ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { start: expr.getStart(sourceFile) + 1, end: expr.getEnd() - 1 };
    }
    if (ts.isTemplateExpression(expr)) {
      return { reason: 'template-literal', detail: expr.getText(sourceFile).slice(0, 60) };
    }
    if (ts.isCallExpression(expr)) {
      const callee = ts.isIdentifier(expr.expression) ? expr.expression.text : null;
      if (callee === 'cva') {
        return { reason: 'cva-call', detail: expr.getText(sourceFile).slice(0, 60) };
      }
      if (callee && CN_CALLEES.has(callee)) {
        // Edit the first plain string argument — by convention the base
        // classes. The others are conditional or forwarded, and rewriting the
        // whole call from the rendered string would duplicate what they add,
        // which is why this span is applied as a delta rather than replaced.
        const literal = expr.arguments.find(
          (a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)
        );
        if (!literal) {
          return { reason: 'cn-no-literal', detail: expr.getText(sourceFile).slice(0, 60) };
        }
        return {
          start: literal.getStart(sourceFile) + 1,
          end: literal.getEnd() - 1,
          delta: true,
          via: callee,
        };
      }
      return { reason: 'cn-call', detail: expr.getText(sourceFile).slice(0, 60) };
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      return { reason: 'dynamic-classname', detail: expr.getText(sourceFile).slice(0, 60) };
    }
    return { reason: 'unsupported-shape', detail: expr.getText(sourceFile).slice(0, 60) };
  }

  return { reason: 'unsupported-shape', detail: String(init.kind) };
}

/**
 * Pure: source bytes in, source bytes out. Never touches the filesystem, so
 * every refusal path is unit-testable without a project on disk.
 */
function editSource(ts, filePath, source, loc, classes) {
  if (loc.hash && loc.hash !== hashOf(source)) {
    return { ok: false, reason: 'stale-hash', detail: `${loc.file} changed on disk` };
  }

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = hostElements(ts, sourceFile).get(`${loc.line}:${loc.col}`);
  if (!node) {
    return { ok: false, reason: 'not-found', detail: `no host element at ${loc.file}:${loc.line}:${loc.col}` };
  }

  const tag = node.tagName.getText(sourceFile);
  const span = classNameSpan(ts, sourceFile, node);

  if (span.reason) {
    return { ok: false, reason: span.reason, tag, detail: `${REFUSALS[span.reason]}: ${span.detail}` };
  }

  const next = String(classes).trim().replace(/\s+/g, ' ');

  if (span.insertAt !== undefined) {
    const attr = ` className="${next}"`;
    return { ok: true, tag, contents: source.slice(0, span.insertAt) + attr + source.slice(span.insertAt) };
  }

  return {
    ok: true,
    tag,
    contents: source.slice(0, span.start) + next + source.slice(span.end),
  };
}

/**
 * Apply several edits to one file against a single parse.
 *
 * Sequential single edits would be wrong twice over: the first splice shifts
 * the byte offsets every later edit was resolved against, and it changes the
 * file so the next hash check fails. So resolve every span first, then splice
 * back to front. Any refusal aborts the whole file — a partial write is worse
 * than none.
 */
function editFile(ts, filePath, source, edits) {
  const stale = edits.find((e) => e.loc.hash && e.loc.hash !== hashOf(source));
  if (stale) {
    return { ok: false, refusals: [{ id: stale.id, reason: 'stale-hash', detail: `${stale.loc.file} changed on disk` }] };
  }

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes = hostElements(ts, sourceFile);

  const spans = [];
  const refusals = [];

  for (const edit of edits) {
    const node = nodes.get(`${edit.loc.line}:${edit.loc.col}`);
    if (!node) {
      refusals.push({ id: edit.id, reason: 'not-found', detail: `no host element at ${edit.loc.line}:${edit.loc.col}` });
      continue;
    }
    const tag = node.tagName.getText(sourceFile);

    // Resolved first and on its own: an element that is going away has no use
    // for a class or text edit, and letting one through would leave the cut
    // holding offsets that the earlier splice had already moved.
    if (edit.remove) {
      const span = removeSpan(ts, sourceFile, node, source);
      if (span.reason) {
        refusals.push({ id: edit.id, reason: span.reason, tag, detail: `${REFUSALS[span.reason]}: ${span.detail}` });
        continue;
      }
      spans.push({ span, tag, insertion: (v) => v, value: '', remove: true });
      continue;
    }

    if (edit.classes !== undefined) {
      const span = classNameSpan(ts, sourceFile, node);
      if (span.reason) {
        refusals.push({ id: edit.id, reason: span.reason, tag, detail: `${REFUSALS[span.reason]}: ${span.detail}` });
        continue;
      }
      let value = String(edit.classes).trim().replace(/\s+/g, ' ');
      if (span.delta) {
        // Only this literal is ours to change; everything else in the rendered
        // class string came from the call's other arguments.
        const current = source.slice(span.start, span.end).trim().split(/\s+/).filter(Boolean);
        const removed = new Set(edit.removed || []);
        const incoming = (edit.added || []).filter((c) => current.indexOf(c) === -1);

        // Substitute in place rather than strike-then-append: swapping p-4 for
        // p-8 should leave the literal's order alone, so the diff is one token
        // rather than a reshuffled line.
        const out = [];
        for (const c of current) {
          if (!removed.has(c)) { out.push(c); continue; }
          if (incoming.length) out.push(incoming.shift());
        }
        for (const c of incoming) out.push(c);
        value = out.join(' ');
      }
      spans.push({ span, tag, insertion: (v) => ` className="${v}"`, value });
    }

    if (edit.text !== undefined) {
      const span = textSpan(ts, sourceFile, node, source);
      if (span.reason) {
        refusals.push({ id: edit.id, reason: span.reason, tag, detail: `${REFUSALS[span.reason]}: ${span.detail}` });
        continue;
      }
      spans.push({ span, tag, insertion: (v) => v, value: escapeJsxText(String(edit.text).trim()) });
    }
  }

  if (refusals.length) return { ok: false, refusals };

  // Back to front, so every offset resolved above stays valid.
  const posOf = (s) => (s.span.insertAt !== undefined ? s.span.insertAt : s.span.start);

  // A span sitting inside one that is being cut has nothing left to apply to,
  // and splicing it first would change the length the cut is measuring from.
  // Dropping it covers both the nested-delete case and an edit made to a child
  // of a deleted parent in the same batch.
  const cuts = spans.filter((s) => s.remove);
  const live = spans.filter((s) => !cuts.some(
    (c) => c !== s && posOf(s) >= c.span.start && posOf(s) < c.span.end));

  live.sort((a, b) => posOf(b) - posOf(a));

  let out = source;
  for (const item of live) {
    if (item.span.insertAt !== undefined) {
      out = out.slice(0, item.span.insertAt) + item.insertion(item.value) + out.slice(item.span.insertAt);
    } else {
      out = out.slice(0, item.span.start) + item.value + out.slice(item.span.end);
    }
  }

  return { ok: true, contents: out, applied: [...new Set(live.map((s) => s.tag))] };
}

module.exports = { hashOf, loadTypeScript, parseLoc, hostElements, classNameSpan, textSpan, removeSpan, escapeJsxText, editSource, editFile, REFUSALS };
