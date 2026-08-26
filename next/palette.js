'use strict';

/**
 * Compile the editor's fixed palette using the TARGET PROJECT'S own Tailwind.
 *
 * Tailwind v4 has no runtime JIT: a class the editor invents has no CSS until
 * it appears in scanned source. `@source inline(...)` pre-generates the whole
 * fixed palette, so preview is instant with no project config and no edits to
 * the project's CSS.
 *
 * Every rule is then scoped to an opt-in attribute. Unscoped, the palette's
 * plain `.px-6` outranks the app's own `.md:px-12` — unlayered beats layered —
 * which silently kills responsive variants. Measured on a real page: sections
 * written `px-6 md:px-12` rendered at 24px instead of 48px. Scoped, the palette
 * matches nothing until the editor opts an element in, and
 * `[data-bw-edited].px-6` (0,2,0) still beats `.md:px-12` (0,1,0).
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const SCOPE = '[data-bw-edited]';

/**
 * Read the colour ramps straight out of the project's own tailwind theme, so
 * the picker offers exactly what that project can render — including the hues
 * Tailwind added in 4.2 (mauve, mist, olive, taupe) and any @theme overrides.
 *
 * Values are left as authored (oklch); browsers render them directly, and the
 * overlay converts to hex only when a colour is detached.
 */
function extractColors(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const css = fs.readFileSync(req.resolve('tailwindcss/theme.css'), 'utf8');
  const ramps = {};
  const re = /--color-([a-z]+)-(\d+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css))) {
    const [, hue, shade, value] = m;
    (ramps[hue] || (ramps[hue] = {}))[shade] = value.trim();
  }
  // Pure black and white are separate vars with no shade.
  const plain = /--color-(white|black):\s*([^;]+);/g;
  while ((m = plain.exec(css))) ramps[m[1]] = { DEFAULT: m[2].trim() };
  return ramps;
}

/**
 * The font-size scale, read from the project's own theme.
 *
 * It cannot be discovered from the page: Tailwind v4 emits both utilities and
 * theme variables on demand, so a route using two sizes exposes exactly two.
 * The full ladder only exists on disk.
 */
function extractTextSizes(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const css = fs.readFileSync(req.resolve('tailwindcss/theme.css'), 'utf8');
  const sizes = {};
  const re = /--text-([a-z0-9]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css))) sizes[m[1]] = m[2].trim();
  return sizes;
}

/**
 * The border-radius ladder, from the project's own theme.
 *
 * Only xs..4xl are theme variables. `rounded-none` (0) and `rounded-full`
 * (calc(infinity * 1px)) are baked into the utility itself and appear nowhere
 * in theme.css, so the overlay owns those two ends of the ladder.
 */
function extractRadii(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const css = fs.readFileSync(req.resolve('tailwindcss/theme.css'), 'utf8');
  const radii = {};
  // The hyphen matters: bare `--radius: 0.25rem` is the legacy alias behind a
  // suffix-less `rounded`, not a rung on the scale.
  const re = /--radius-([a-z0-9]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css))) radii[m[1]] = m[2].trim();
  return radii;
}

/** The font-weight ladder, from the project's own theme. */
function extractFontWeights(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const css = fs.readFileSync(req.resolve('tailwindcss/theme.css'), 'utf8');
  const weights = {};
  const re = /--font-weight-([a-z]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css))) weights[m[1]] = m[2].trim();
  return weights;
}

// Must stay in step with the overlay's controls — same source of truth.
const HUES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'taupe', 'mauve', 'mist', 'olive',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

// Every colour the picker can offer must exist in the preview sheet, or
// choosing it would change nothing until the file is saved and Tailwind reruns.
const CANDIDATES = [
  // Must stay in step with SPACING in editor.js: every rung the dropdown
  // offers has to be renderable, or picking one previews nothing.
  '{p,m}{,x,y,t,r,b,l}-{0,0.5,1,1.5,2,2.5,3,3.5,4,5,6,8,10,12,16,20,24}',
  'gap{,-x,-y}-{0,0.5,1,1.5,2,2.5,3,3.5,4,5,6,8,10,12,16,20,24}',
  // Every offered token must be pre-generated, or picking one previews nothing.
  'text-{xs,sm,base,lg,xl,2xl,3xl,4xl,5xl,6xl,7xl,8xl,9xl}',
  'text-{left,center,right}',
  'font-{thin,extralight,light,normal,medium,semibold,bold,extrabold,black}',
  '{bg,text}-{white,black}',
  `{bg,text}-{${HUES.join(',')}}-{${SHADES.join(',')}}`,
].join(' ');

// Radius is deliberately NOT in that list. Unlike a colour ramp or the type
// scale, every project redefines the radius ladder, and `@theme inline` bakes
// the result straight into the utility: on the Cora route `.rounded-lg` is
// `var(--radius)` — 12px — while `--radius-lg` still resolves to the stock 8px.
// A pre-generated `[data-bw-edited].rounded-lg` would outrank the route's own
// rule and visibly shrink an element the moment it was touched. The overlay
// reads the rungs off the live page instead, and emits a rule only for the
// ones this route has never generated.
const SHEET = `@import "tailwindcss/theme.css" theme(reference);
@tailwind utilities source(none);
@source inline("${CANDIDATES}");
`;

async function compilePalette(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const tailwind = req('tailwindcss');

  const compiler = await tailwind.compile(SHEET, {
    base: root,
    onDependency() {},
    loadStylesheet(id) {
      const file = req.resolve(id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
    },
    loadModule() {
      throw new Error('the palette sheet loads no JS modules');
    },
  });

  const css = compiler.build([]);
  const scoped = css.replace(/^(\.[^\s{,]+)(\s*\{)/gm, SCOPE + '$1$2');

  return {
    css: scoped,
    rules: (css.match(/^\.[^\s{,]+\s*\{/gm) || []).length,
    version: req('tailwindcss/package.json').version,
  };
}

module.exports = {
  compilePalette, extractColors, extractTextSizes, extractFontWeights, extractRadii,
  CANDIDATES, SCOPE, HUES, SHADES,
};
