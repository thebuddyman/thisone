'use strict';

/**
 * Work out what a project is, so the editor can wire itself up.
 *
 * The three seams the answer feeds:
 *   locator — how a DOM node learns its source location (per bundler)
 *   writer  — how a class is edited in source (per file syntax)
 *   theme   — how Tailwind is configured (v4 @source inline vs v3 safelist)
 *
 * Pure and filesystem-only: no project code is executed, so detecting a broken
 * or hostile project cannot run anything.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function firstExisting(root, names) {
  for (const name of names) {
    if (fs.existsSync(path.join(root, name))) return name;
  }
  return null;
}

/** Installed Tailwind, and which generation strategy that implies. */
function detectTailwind(root) {
  let version = null;
  try {
    version = createRequire(path.join(root, 'package.json'))('tailwindcss/package.json').version;
  } catch {
    /* not installed, or not resolvable from here */
  }
  if (!version) return { found: false, version: null, major: null, strategy: null };

  const major = Number(version.split('.')[0]);
  return {
    found: true,
    version,
    major,
    // v4 can pre-generate a preview sheet from `@source inline(...)`.
    // v3 has neither that nor the compile() API — it needs a safelist instead.
    strategy: major >= 4 ? 'source-inline' : 'safelist',
    supported: major >= 4,
  };
}

const UNSUPPORTED = {
  expo: 'React Native has no DOM to edit, and Metro runs no webpack-style loader, ' +
    'so nothing can be selected or saved. Expo web would need a Babel locator ' +
    'and dataSet-based markers.',
  'react-native': 'React Native has no DOM to edit. See the Expo note.',
};

/**
 * @returns a plan describing how (or whether) this project can be edited.
 */
function detect(root) {
  root = path.resolve(root);
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const tailwind = detectTailwind(root);

  const base = { root, name: pkg.name || path.basename(root), tailwind };

  for (const blocked of Object.keys(UNSUPPORTED)) {
    if (deps[blocked]) {
      return { ...base, framework: blocked, supported: false, reason: UNSUPPORTED[blocked] };
    }
  }

  if (deps.next) {
    const config = firstExisting(root, ['next.config.ts', 'next.config.mjs', 'next.config.js']);
    return {
      ...base,
      framework: 'next',
      version: deps.next,
      bundler: 'turbopack',
      locator: 'turbopack',
      writers: ['jsx'],
      configFile: config,
      entryFile: firstExisting(root, [
        'src/app/layout.tsx', 'app/layout.tsx', 'src/app/layout.jsx', 'app/layout.jsx',
      ]),
      devCommand: 'next dev',
      appPort: 3000,
      supported: !!config && tailwind.supported,
      reason: !config ? 'no next.config.* found'
        : !tailwind.supported ? tailwindReason(tailwind) : null,
    };
  }

  if (deps.astro) {
    const config = firstExisting(root, ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']);
    return {
      ...base,
      framework: 'astro',
      version: deps.astro,
      bundler: 'vite',
      locator: 'vite',
      // .astro templates are the bulk of these projects; JSX only for islands.
      writers: ['astro', 'jsx'],
      configFile: config,
      entryFile: null, // Astro injects via its integration, not a layout file
      devCommand: 'astro dev',
      appPort: 4321,
      // Astro is recognised and refused, which is not the same as unrecognised:
      // the locator was written (next/astro-locator.mjs) and cannot be reached.
      // Astro 7 never routes project files through Vite plugins — instrumented,
      // 1,271 plugin calls, zero for anything under src/ — and none of its twelve
      // integration hooks is transform-shaped. Saying `supported` here sent an
      // Astro project down the Next wiring path, which asks astro.config.mjs for
      // `const nextConfig = {`, offers a turbopack block it has no key for, and
      // prints a React overlay tag for a layout file Astro does not have.
      supported: false,
      reason: 'astro is not supported: its build never routes project files '
        + 'through a plugin, so there is nowhere to stamp source locations',
    };
  }

  if (deps.vite) {
    const config = firstExisting(root, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
    return {
      ...base,
      framework: 'vite',
      bundler: 'vite',
      locator: 'vite',
      writers: ['jsx'],
      configFile: config,
      devCommand: 'vite',
      appPort: 5173,
      // Same correction as astro above: there is no vite locator, and the only
      // wiring this CLI can write is the turbopack rule plus a JSX layout tag.
      // A bare Vite project claiming support got Next's instructions verbatim.
      supported: false,
      reason: 'vite is not supported yet: the only locator that exists is the '
        + 'turbopack loader, so nothing would stamp source locations',
    };
  }

  // A plain page needs no bundler at all: the server tags it as it serves it.
  if (fs.existsSync(path.join(root, 'index.html'))) {
    return {
      ...base,
      framework: 'html',
      bundler: null,
      locator: 'server',
      writers: ['html'],
      configFile: null,
      devCommand: null,
      appPort: 3000,
      supported: true,
      reason: null,
    };
  }

  return {
    ...base,
    framework: null,
    supported: false,
    reason: 'no next, astro, vite or index.html found — nothing to attach to',
  };
}

function tailwindReason(tw) {
  if (!tw.found) return 'tailwindcss is not installed (or not resolvable from this root)';
  return `Tailwind ${tw.version} is not supported yet — v4 is required for the preview ` +
    'sheet (`@source inline` and the compile API are both v4-only)';
}

/** Has this project already had the editor wired into it? */
function detectWiring(plan) {
  const has = (file, needle) => {
    if (!file) return false;
    const abs = path.join(plan.root, file);
    try {
      return fs.readFileSync(abs, 'utf8').includes(needle);
    } catch {
      return false;
    }
  };
  // Every name this tool has shipped under, newest first. A rename must *add*
  // to this list, never replace it: a project wired by an older release still
  // carries the old name in its config and on disk, and a detector that has
  // forgotten it calls that project unwired — which is how uiux_experiment
  // became undetectable, and unwirable, after the last one.
  const LOADER_MARKS = ['thisone-loader', 'bw-loader', 'tw-editor'];
  const SHIMS = ['tools/thisone-loader.cjs', 'tools/bw-loader.cjs'];
  return {
    loader: LOADER_MARKS.some((m) => has(plan.configFile, m)),
    overlay: has(plan.entryFile, 'overlay.js'),
    loaderShim: SHIMS.some((f) => fs.existsSync(path.join(plan.root, f))),
  };
}

/**
 * Why did the app give up, and is another port going to help?
 *
 * Three answers, and only one of them is worth retrying. Pure string work, kept
 * out of the spawn loop so it can be tested without starting a dev server.
 */
function whyItDied(out) {
  if (/Another .* dev server is already running/i.test(out)) {
    // Read from the complaint onwards, not from the top of the buffer: our own
    // child prints its banner — `- Local: http://localhost:3002` — a moment
    // before it discovers the conflict, so a search over the whole tail reports
    // the port that failed instead of the one to go to.
    const said = out.slice(out.search(/Another .* dev server is already running/i));
    return {
      kind: 'duplicate',
      at: (said.match(/Local:\s+(\S+)/) || [])[1],
      pid: (said.match(/PID:\s+(\d+)/) || [])[1],
    };
  }
  if (/EADDRINUSE/.test(out)) return { kind: 'port-taken' };
  return { kind: 'unknown' };
}

module.exports = { detect, detectWiring, detectTailwind, whyItDied };
