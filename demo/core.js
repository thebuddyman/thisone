/**
 * What the demo needs in both places it runs: the build, which prerenders the
 * page in Node, and the browser, which re-renders it after every save.
 *
 * It does not reimplement the loader or the writer. It runs next/loader.cjs and
 * next/jsx-adapter.js as they ship, behind a `require` that hands them the three
 * Node modules they touch. A second copy of either would be a demo of something
 * the package does not do.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThisoneDemo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ sha256
  //
  // The loader stamps, and the writer checks, sha256(source) cut to 8 hex. The
  // browser has only an async digest, and both call sites are synchronous.

  var K = [];
  (function () {
    var n = 2, found = 0;
    function frac(x) { return ((x - Math.floor(x)) * 0x100000000) >>> 0; }
    while (found < 64) {
      var prime = true;
      for (var d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (prime) K[found++] = frac(Math.pow(n, 1 / 3));
      n++;
    }
  })();

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Uint8Array.from(Buffer.from(str, 'utf8'));
  }

  function sha256Hex(str) {
    var bytes = utf8(str);
    var bitLen = bytes.length * 8;
    var padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    var view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    view.setUint32(padded.length - 4, bitLen >>> 0);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Uint32Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var sx = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var sy = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (sy + w[i - 7] + sx + w[i - 16]) | 0;
      }
      var A = H[0], B = H[1], C = H[2], D = H[3], E = H[4], F = H[5], G = H[6], HH = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (HH + (((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7)))
          + ((E & F) ^ (~E & G)) + K[i] + w[i]) | 0;
        var t2 = ((((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10)))
          + ((A & B) ^ (A & C) ^ (B & C))) | 0;
        HH = G; G = F; F = E; E = (D + t1) | 0;
        D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      H[0] = (H[0] + A) | 0; H[1] = (H[1] + B) | 0; H[2] = (H[2] + C) | 0; H[3] = (H[3] + D) | 0;
      H[4] = (H[4] + E) | 0; H[5] = (H[5] + F) | 0; H[6] = (H[6] + G) | 0; H[7] = (H[7] + HH) | 0;
    }
    return H.map(function (h) { return ('00000000' + (h >>> 0).toString(16)).slice(-8); }).join('');
  }

  // ------------------------------------------------- the package's modules

  var ROOT = '/project';
  var FILE = 'app/page.tsx';

  /**
   * Load loader.cjs and jsx-adapter.js from their source text. `sources` maps
   * each module's id to its file contents, byte for byte.
   */
  function boot(ts, sources) {
    var cache = {};
    var shims = {
      typescript: ts,
      crypto: {
        createHash: function () {
          var data = '';
          return {
            update: function (s) { data += s; return this; },
            digest: function () { return sha256Hex(data); },
          };
        },
      },
      path: {
        sep: '/',
        relative: function (from, to) {
          var prefix = from.replace(/\/$/, '') + '/';
          return to.indexOf(prefix) === 0 ? to.slice(prefix.length) : to;
        },
        join: function () { return Array.prototype.slice.call(arguments).join('/'); },
      },
      // loadTypeScript asks the project for its own copy first. There is only one.
      module: { createRequire: function () { return function (id) { return req(id); }; } },
    };
    function req(id) {
      if (shims[id]) return shims[id];
      var key = id.replace(/^\.\//, '').replace(/\.c?js$/, '');
      if (cache[key]) return cache[key].exports;
      if (!sources[key]) throw new Error('demo: no module ' + id);
      var mod = { exports: {} };
      cache[key] = mod;
      new Function('require', 'module', 'exports', sources[key])(req, mod, mod.exports);
      return mod.exports;
    }

    var adapter = req('./jsx-adapter');
    var loader = req('./loader');
    return {
      adapter: adapter,
      stamp: function (source) {
        return loader.call({
          getOptions: function () { return { root: ROOT }; },
          rootContext: ROOT,
          resourcePath: ROOT + '/' + FILE,
        }, source);
      },
    };
  }

  // ---------------------------------------------------------- JSX → HTML
  //
  // The page is static JSX with no imports and no state, so rendering it needs
  // a createElement that returns markup, not React.

  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var KEEP_CASE = { viewBox: 1, preserveAspectRatio: 1 };

  function Markup(html) { this.html = html; }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function attrName(k) {
    if (k === 'className') return 'class';
    if (k === 'htmlFor') return 'for';
    if (KEEP_CASE[k] || /^(aria|data)-/.test(k)) return k;
    return k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
  }

  function kids(list) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) out += kids(c);
      else if (c instanceof Markup) out += c.html;
      else out += esc(c);
    }
    return out;
  }

  function h(tag, props) {
    var children = Array.prototype.slice.call(arguments, 2);
    if (typeof tag === 'function') {
      return tag(Object.assign({}, props, { children: children }));
    }
    var out = '<' + tag;
    for (var k in props || {}) {
      var v = props[k];
      if (v == null || v === false || k === 'children' || k === 'key') continue;
      out += ' ' + attrName(k) + (v === true ? '' : '="' + esc(v) + '"');
    }
    if (VOID[tag]) return new Markup(out + '>');
    return new Markup(out + '>' + kids(children) + '</' + tag + '>');
  }

  function Fragment(props) { return new Markup(kids(props.children || [])); }

  /** Stamped TSX in, the markup its default export renders out. */
  function render(ts, stamped) {
    var js = ts.transpileModule(stamped, {
      fileName: FILE,
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        jsxFactory: 'h',
        jsxFragmentFactory: 'Fragment',
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
      },
    }).outputText;
    var exports = {};
    new Function('h', 'Fragment', 'exports', 'module', js)(h, Fragment, exports, { exports: exports });
    var page = exports.default;
    if (typeof page !== 'function') throw new Error('demo: ' + FILE + ' has no default export');
    return kids([page({})]);
  }

  return { sha256Hex: sha256Hex, boot: boot, render: render, FILE: FILE, ROOT: ROOT };
});
