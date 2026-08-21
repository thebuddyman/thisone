/**
 * Vite plugin: stamp every element in an `.astro` template with its source
 * location.
 *
 *   data-bw-loc="src/pages/index.astro:9:7:a1b2c3d4"
 *
 * Runs with `enforce: 'pre'` so it sees the raw `.astro` source, before Astro's
 * own plugin compiles the template away.
 *
 * Astro 7 parses with `@astrojs/compiler-rs` (the Rust rewrite — NOT the older
 * `@astrojs/compiler`, which is only present in projects that also pull in
 * @astrojs/check or mdx). It models the template as JSX: JSXOpeningElement with
 * byte-accurate `start`/`end`. That makes this walk nearly identical to the
 * Turbopack loader's, and the attribute is spliced in the same way — right
 * after the tag name, so every other byte and the line count are untouched.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';

export function hashOf(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 8);
}

function tagNameOf(node) {
  const n = node.name;
  if (!n) return null;
  if (typeof n.name === 'string') return n.name; // JSXIdentifier
  // JSXMemberExpression (<Foo.Bar>) — a component, never a host element.
  return null;
}

/**
 * Every host element in the template, with the offset just past its tag name.
 *
 * Exported so the writer resolves a location with the same walk the locator
 * used; the two must never disagree about what sits at line:col.
 */
export function astroElements(ast, source) {
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);

    if (node.type === 'JSXOpeningElement' && typeof node.start === 'number') {
      const name = tagNameOf(node);
      // Lowercase means a real element. Capitalised is an Astro component, whose
      // markup lives in another file — stamping it would point at the wrong place.
      if (name && /^[a-z]/.test(name)) {
        const after = node.start + 1 + name.length;
        if (source.slice(node.start, after) === '<' + name) {
          out.push({ name, insertAt: after, start: node.start, attributes: node.attributes || [] });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key !== 'type' && node[key] && typeof node[key] === 'object') walk(node[key]);
    }
  })(ast);
  return out;
}

/** 0-based offset → 1-based line and column, matching the JSX locator. */
export function lineColOf(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

export function createAstroLocator({ root }) {
  const req = createRequire(path.join(root, 'package.json'));
  let compiler;

  return {
    name: 'bw-editor-astro-locator',
    enforce: 'pre', // before Astro compiles the template away
    apply: 'serve', // dev only; never part of `astro build`
    async transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.astro') || file.includes('node_modules')) return null;

      if (compiler === undefined) {
        try {
          compiler = req('@astrojs/compiler-rs');
        } catch {
          compiler = null;
        }
      }
      if (!compiler) return null; // nothing to parse with; leave the file alone

      let parsed;
      try {
        parsed = await compiler.parse(code, { position: true });
      } catch {
        return null; // never break a build over instrumentation
      }

      const found = astroElements(parsed.ast, code);
      if (!found.length) return null;

      const rel = path.relative(root, file).split(path.sep).join('/');
      const hash = hashOf(code);

      // Back to front, so earlier offsets stay valid as we splice.
      found.sort((a, b) => b.insertAt - a.insertAt);
      let out = code;
      for (const el of found) {
        const { line, col } = lineColOf(code, el.start);
        out = out.slice(0, el.insertAt) +
          ` data-bw-loc="${rel}:${line}:${col}:${hash}"` +
          out.slice(el.insertAt);
      }
      return { code: out, map: null };
    },
  };
}

export default createAstroLocator;
