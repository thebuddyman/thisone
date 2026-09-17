/**
 * Build the demo into a static folder.
 *
 *   node demo/build.mjs                  → demo/dist/thisone/
 *   node demo/build.mjs --out <dir>
 *
 * The page is prerendered here with the same loader and renderer the browser
 * uses after a save, so it is on screen before the TypeScript parser arrives.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);

const i = process.argv.indexOf('--out');
const OUT = i !== -1 ? resolve(process.argv[i + 1]) : join(HERE, 'dist', 'thisone');

const ts = require('typescript');
const core = require('./core.js');
const { HUES } = require('../next/palette.js');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Shipped files, byte for byte. The demo is only honest while these are the
// package's own.
const sources = {
  'jsx-adapter': read('next/jsx-adapter.js'),
  loader: read('next/loader.cjs'),
};

const source = read('demo/app/page.tsx');
const mods = core.boot(ts, sources);
const html = core.render(ts, mods.stamp(source));

// What next/server.js falls back to for a project whose theme it cannot read.
// The demo page is stock Tailwind, so the fallbacks are the right answer.
const colorRamps = require('../next/colors.json');
const config = {
  idAttr: 'data-thisone-loc',
  endpoint: '/__thisone/edit',
  text: true,
  textRuns: true,
  hmr: true,
  colors: { order: HUES.filter((h) => colorRamps[h]), ramps: colorRamps },
  textSizes: require('../next/text-sizes.json'),
  fontWeights: require('../next/font-weights.json'),
  radii: require('../next/radii.json'),
};

// Inside a <script>, `</script>` in a string would end the element.
const inScript = (s) => s.replace(/</g, '\\u003c');

const page = read('demo/index.html');
const filled = page
  .replace('<!--APP-->', () => html)
  .replace('<!--SOURCE-->', () => inScript(JSON.stringify(source)))
  .replace('/*CONFIG*/', () => inScript(JSON.stringify(config)));

// A marker that did not match would ship a page with a hole in it.
for (const mark of ['<!--APP-->', '<!--SOURCE-->', '/*CONFIG*/']) {
  if (filled.includes(mark) || !page.includes(mark)) throw new Error(`build: ${mark} was not filled`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), filled);
writeFileSync(join(OUT, 'sources.js'), `window.__THISONE_SOURCES__ = ${inScript(JSON.stringify(sources))};\n`);
copyFileSync(join(HERE, 'core.js'), join(OUT, 'core.js'));
copyFileSync(join(HERE, 'runtime.js'), join(OUT, 'runtime.js'));
copyFileSync(join(ROOT, 'editor.js'), join(OUT, 'editor.js'));
copyFileSync(require.resolve('typescript/lib/typescript.js'), join(OUT, 'typescript.js'));
copyFileSync(require.resolve('@tailwindcss/browser'), join(OUT, 'tailwind.js'));

console.log(`demo built → ${OUT}`);
