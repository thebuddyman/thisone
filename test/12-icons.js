/**
 * The icons are the exported files, inlined byte for byte.
 *
 * That rule is stated in CLAUDE.md and it is the one thing about `assets/`
 * that cannot be seen by looking at the panel: an icon re-exported from the
 * frame and not re-inlined leaves the editor drawing last month's mark, and
 * the only tell is a screenshot nobody happens to take. Twenty-one of them had
 * drifted that way at once. This is the check that says so out loud.
 *
 * It also insists the map is complete in the other direction, because that is
 * how the four-corner Parts glyph sat unused: the file arrived in `assets/`
 * and nothing pointed at it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

// The registry. Not derivable — `close` is ic-x and `snow` is ic-snowflake —
// so it is written down, and the "every file is claimed" check below is what
// keeps it honest.
const MAP = {
  close: 'ic-x', chevron: 'ic-chevron-down', snow: 'ic-snowflake',
  alignLeft: 'ic-align-left', alignCenter: 'ic-align-center', alignRight: 'ic-align-right',
  padHz: 'ic-padding-hz', padVt: 'ic-padding-vt', padTop: 'ic-padding-top',
  padRight: 'ic-padding-right', padBottom: 'ic-padding-bottom', padLeft: 'ic-padding-left',
  padHzVt: 'ic-padding-hzvt', padParts: 'ic-padding-parts',
  marHz: 'ic-margin-hz', marVt: 'ic-margin-vt', marTop: 'ic-margin-top',
  marRight: 'ic-margin-right', marBottom: 'ic-margin-bottom', marLeft: 'ic-margin-left',
  marHzVt: 'ic-margin-hzvt', marParts: 'ic-margin-parts',
  radAll: 'ic-radius-all', radParts: 'ic-radius-parts', radTl: 'ic-radius-tl',
  radTr: 'ic-radius-tr', radBl: 'ic-radius-bl', radBr: 'ic-radius-br',
  gapHz: 'ic-gap-hz', gapVt: 'ic-gap-vt',
  plus: 'ic-plus', minus: 'ic-minus', unlink: 'ic-unlink',
  undo: 'ic-undo', redo: 'ic-redo',
};

const src = fs.readFileSync(path.join(ROOT, 'editor.js'), 'utf8');
// Inlining is the file with its newlines taken out and nothing else: the
// export is pretty-printed and the object is one line per icon.
const inlined = (file) =>
  fs.readFileSync(path.join(ROOT, 'assets', file + '.svg'), 'utf8').split('\n').join('');

const stale = [], absent = [];
for (const [key, file] of Object.entries(MAP)) {
  const m = new RegExp('^    ' + key + ': (".*?"),$', 'm').exec(src);
  if (!m) { absent.push(key); continue; }
  if (JSON.parse(m[1]) !== inlined(file)) stale.push(key);
}
check('every icon in the map has an entry in ICONS', absent.length === 0, absent.join(', '));
check('and every entry is its export, inlined verbatim', stale.length === 0,
  stale.length ? `re-inline: ${stale.join(', ')}` : `${Object.keys(MAP).length} icons`);

// The other direction: a file nobody points at is a mark that was drawn and
// never reached the panel.
const files = fs.readdirSync(path.join(ROOT, 'assets'))
  .filter((f) => f.endsWith('.svg')).map((f) => f.replace(/\.svg$/, ''));
const claimed = new Set(Object.values(MAP));
const orphans = files.filter((f) => !claimed.has(f));
check('and every file in assets/ is claimed by one of them', orphans.length === 0,
  orphans.join(', '));

// They are pasted into one document, so a clipPath id shared by two of them
// would have the second silently wearing the first's clip. Only ids that are
// pointed at count: Figma names half the nodes in every file `Frame` and
// `Vector`, and nothing resolves those, so insisting they be unique would be
// insisting on something the export cannot give and the browser never reads.
const owner = {}, dupes = [];
const referenced = new Set();
for (const f of files) {
  const svg = inlined(f);
  for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) referenced.add(m[1]);
  for (const m of svg.matchAll(/id="([^"]+)"/g)) {
    (owner[m[1]] = owner[m[1]] || []).push(f);
  }
}
for (const id of referenced) {
  const held = [...new Set(owner[id] || [])];
  if (held.length !== 1) dupes.push(`${id}: ${held.join(' and ') || 'defined nowhere'}`);
}
check('no two exports share an id anything points at — they land in one document',
  dupes.length === 0, dupes.length ? dupes.join('; ') : `${referenced.size} referenced`);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
