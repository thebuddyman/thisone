'use strict';

/**
 * Turbopack/webpack loader: stamp every JSX host element with its source
 * location plus the file's fingerprint.
 *
 *   data-bw-loc="src/app/page.tsx:24:7:a1b2c3d4"
 *
 * The attribute is spliced in immediately after the tag name, so byte offsets
 * of everything else are unchanged and the line count is identical to the
 * input — line numbers stay honest with no source map.
 *
 * The fingerprint rides along so staleness is self-healing: after a write the
 * file hash changes, HMR re-runs this loader, and every element in the file
 * gets the new hash without the client managing anything.
 *
 * Element discovery is `hostElements` from the writer, deliberately: if the two
 * sides disagreed about which node sits at line:col, edits would land on the
 * wrong element.
 */

const path = require('path');
const { loadTypeScript, hostElements, hashOf, textShape } = require('./jsx-adapter');

module.exports = function bwLoader(source) {
  const opts = (typeof this.getOptions === 'function' && this.getOptions()) || {};
  const root = opts.root || this.rootContext || process.cwd();
  const file = this.resourcePath || '';

  // Cheap prefilter: no '<' means no JSX, so skip the parse entirely.
  if (typeof source !== 'string' || source.indexOf('<') === -1) return source;

  let ts;
  try {
    ts = loadTypeScript(root);
  } catch {
    return source; // never break a build over instrumentation
  }

  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return source;
  }

  const nodes = hostElements(ts, sourceFile);
  if (!nodes.size) return source;

  const rel = path.relative(root, file).split(path.sep).join('/');
  const hash = hashOf(source);

  const inserts = [];
  nodes.forEach((node, lineCol) => {
    // The shape rides along only where there is something to say. The panel
    // cannot read it off the DOM — `{name}` renders as ordinary characters —
    // so without this it can only find out by asking for a write and being
    // refused, which is why it used to let you type first and object after.
    const shape = textShape(ts, sourceFile, node);
    inserts.push({
      pos: node.tagName.getEnd(),
      attr: ` data-bw-loc="${rel}:${lineCol}:${hash}"` + (shape ? ` data-bw-text="${shape}"` : ''),
    });
  });

  // Back to front, so earlier offsets stay valid as we splice.
  inserts.sort((a, b) => b.pos - a.pos);
  let out = source;
  for (const ins of inserts) {
    out = out.slice(0, ins.pos) + ins.attr + out.slice(ins.pos);
  }
  return out;
};
