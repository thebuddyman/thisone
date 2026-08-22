/**
 * Pure unit tests for the JSX writer — no filesystem, no browser, no project.
 *
 * `editFile` is bytes-in/bytes-out by design, so every refusal path and every
 * whitespace subtlety is testable as a plain string comparison.
 */
const { loadTypeScript, editFile, hashOf } = require('../next/jsx-adapter');

const ts = loadTypeScript(__dirname);
const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

/** Locate the nth `<tag` in the source, so positions are never hand-counted. */
function at(source, tag, nth = 0) {
  const re = new RegExp('<' + tag + '(?=[\\s/>])', 'g');
  let m, i = 0;
  while ((m = re.exec(source))) {
    if (i++ === nth) {
      const before = source.slice(0, m.index);
      const line = before.split('\n').length;
      const col = m.index - (before.lastIndexOf('\n') + 1) + 1;
      return { line, col };
    }
  }
  throw new Error(`no <${tag}> #${nth} in source`);
}

const run = (source, edits) =>
  editFile(
    ts,
    'test.tsx',
    source,
    edits.map((e) => {
      const pos = at(source, e.tag, e.nth || 0);
      return { id: 'test.tsx', loc: { file: 'test.tsx', line: pos.line, col: pos.col, hash: null }, ...e };
    })
  );

// ---------------------------------------------------------------- className

let r = run('const a = <div className="p-4 bg-white">hi</div>;', [{ tag: 'div', classes: 'p-8 bg-rose-500' }]);
check('className replaced in place', r.ok && r.contents === 'const a = <div className="p-8 bg-rose-500">hi</div>;', r.contents);

r = run('const a = <div>hi</div>;', [{ tag: 'div', classes: 'p-4' }]);
check('className inserted when absent', r.ok && r.contents === 'const a = <div className="p-4">hi</div>;', r.contents);

r = run('const a = <div className={cn("p-4", x)}>hi</div>;',
  [{ tag: 'div', classes: 'p-8', removed: ['p-4'], added: ['p-8'] }]);
check('cn() is edited, not refused', r.ok && /cn\("p-8", x\)/.test(r.contents), r.contents);

r = run('const a = <div className={`p-4 ${x}`}>hi</div>;', [{ tag: 'div', classes: 'p-8' }]);
check('interpolated template refused', !r.ok && r.refusals[0].reason === 'template-literal');

r = run('const a = <div className={`p-4`}>hi</div>;', [{ tag: 'div', classes: 'p-8' }]);
check('un-interpolated template accepted', r.ok && r.contents.includes('`p-8`'), r.contents);

r = run('const a = <div className={styles.x}>hi</div>;', [{ tag: 'div', classes: 'p-8' }]);
check('variable className refused', !r.ok && r.refusals[0].reason === 'dynamic-classname');

// --------------------------------------------------------------------- text

r = run('const a = <p>Hello</p>;', [{ tag: 'p', text: 'Goodbye' }]);
check('text replaced', r.ok && r.contents === 'const a = <p>Goodbye</p>;', r.contents);

const indented = 'export const A = (\n  <p className="x">\n    hello there\n  </p>\n);\n';
r = run(indented, [{ tag: 'p', text: 'new copy' }]);
check('indentation and line count preserved',
  r.ok && r.contents === 'export const A = (\n  <p className="x">\n    new copy\n  </p>\n);\n', JSON.stringify(r.contents));

r = run('const a = <p>Hello {name}</p>;', [{ tag: 'p', text: 'nope' }]);
check('text + expression refused', !r.ok && r.refusals[0].reason === 'mixed-content',
  r.ok ? 'accepted!' : r.refusals[0].detail);

r = run('const a = <p>a<b>c</b></p>;', [{ tag: 'p', text: 'nope' }]);
check('text + child element refused', !r.ok && r.refusals[0].reason === 'mixed-content');

r = run('const a = <img src="x" />;', [{ tag: 'img', text: 'nope' }]);
check('self-closing element refused', !r.ok && r.refusals[0].reason === 'no-text');

r = run('const a = <p>x</p>;', [{ tag: 'p', text: 'a < b > c {d} & e' }]);
check('JSX-breaking characters escaped',
  r.ok && r.contents === 'const a = <p>a &lt; b &gt; c &#123;d&#125; &amp; e</p>;', r.contents);

r = run('const a = <p></p>;', [{ tag: 'p', text: 'filled' }]);
check('text inserted into an empty element', r.ok && r.contents === 'const a = <p>filled</p>;', r.contents);

// -------------------------------------------------------------- cn() / cva

// The rendered class string is the union of every argument, so the whole string
// must NOT be written back into argument one — only this literal's own share.
r = run('const a = <div className={cn("p-4 bg-white", big && "text-xl")}>hi</div>;',
  [{ tag: 'div', classes: 'p-8 bg-white text-xl', removed: ['p-4'], added: ['p-8'] }]);
check('cn(): first literal edited by delta',
  r.ok && r.contents === 'const a = <div className={cn("p-8 bg-white", big && "text-xl")}>hi</div>;', r.contents);

r = run('const a = <div className={cn("p-4", big && "text-xl")}>hi</div>;',
  [{ tag: 'div', classes: 'p-4 text-xl bg-rose-500', removed: [], added: ['bg-rose-500'] }]);
check('cn(): an added class lands in the literal, conditionals untouched',
  r.ok && r.contents === 'const a = <div className={cn("p-4 bg-rose-500", big && "text-xl")}>hi</div>;', r.contents);

r = run('const a = <div className={cn("p-4", big && "text-xl")}>hi</div>;',
  [{ tag: 'div', classes: 'p-4', removed: ['text-xl'], added: [] }]);
check('cn(): removing a class the literal does not own leaves it alone',
  r.ok && r.contents === 'const a = <div className={cn("p-4", big && "text-xl")}>hi</div>;', r.contents);

r = run('const a = <div className={clsx("p-4", x)}>hi</div>;',
  [{ tag: 'div', classes: 'p-8', removed: ['p-4'], added: ['p-8'] }]);
check('clsx() is handled too', r.ok && /clsx\("p-8", x\)/.test(r.contents), r.contents);

r = run('const a = <div className={cn(base, x)}>hi</div>;',
  [{ tag: 'div', classes: 'p-8', removed: [], added: ['p-8'] }]);
check('cn() with no string argument is refused',
  !r.ok && r.refusals[0].reason === 'cn-no-literal', r.ok ? 'accepted!' : r.refusals[0].reason);

r = run('const a = <div className={cva("p-4", { variants: {} })}>hi</div>;',
  [{ tag: 'div', classes: 'p-8', removed: ['p-4'], added: ['p-8'] }]);
check('cva() is refused by name', !r.ok && r.refusals[0].reason === 'cva-call',
  r.ok ? 'accepted!' : r.refusals[0].reason);

r = run('const a = <div className={other("p-4")}>hi</div>;',
  [{ tag: 'div', classes: 'p-8', removed: ['p-4'], added: ['p-8'] }]);
check('an unknown helper is still refused', !r.ok && r.refusals[0].reason === 'cn-call');

// a plain literal is a full replacement, not a delta
r = run('const a = <div className="p-4 bg-white">hi</div>;',
  [{ tag: 'div', classes: 'p-8 bg-rose-500', removed: ['p-4','bg-white'], added: ['p-8','bg-rose-500'] }]);
check('a plain string literal is still replaced wholesale',
  r.ok && r.contents === 'const a = <div className="p-8 bg-rose-500">hi</div>;', r.contents);

// ------------------------------------------------------- combined + batching

r = run('const a = <p className="a">one</p>;', [{ tag: 'p', classes: 'b', text: 'two' }]);
check('class and text in one edit', r.ok && r.contents === 'const a = <p className="b">two</p>;', r.contents);

const two = 'export const A = (\n  <div className="a">\n    <p className="b">first</p>\n  </div>\n);\n';
r = run(two, [
  { tag: 'div', classes: 'A' },
  { tag: 'p', classes: 'B', text: 'second' },
]);
check('two elements in one file, offsets stay valid',
  r.ok && r.contents === 'export const A = (\n  <div className="A">\n    <p className="B">second</p>\n  </div>\n);\n',
  JSON.stringify(r.contents));

// one bad edit must abort the whole file, not half-apply it
const mixedBatch = 'export const A = (\n  <div className="a">\n    <p className={styles.x}>x</p>\n  </div>\n);\n';
r = run(mixedBatch, [
  { tag: 'div', classes: 'CHANGED' },
  { tag: 'p', classes: 'ALSO' },
]);
check('a refusal aborts the entire batch', !r.ok && r.refusals[0].reason === 'dynamic-classname',
  r.ok ? 'accepted!' : r.refusals[0].reason);

// ------------------------------------------------------------- staleness

// ------------------------------------------------------------------- remove

const PAGE = [
  'export default function Page() {',
  '  return (',
  '    <div className="wrap">',
  '      <p>keep me</p>',
  '      <span className="gone">bye</span>',
  '      <p>keep me too</p>',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

r = run(PAGE, [{ tag: 'span', remove: true }]);
check('child element removed, whole line and all',
  r.ok && r.contents === PAGE.replace('      <span className="gone">bye</span>\n', ''),
  r.ok ? JSON.stringify(r.contents.split('\n')[4]) : r.refusals[0].detail);
check('no blank line left behind', r.ok && !/\n\s*\n/.test(r.contents));
check('the siblings are untouched byte for byte',
  r.ok && r.contents.split('\n').filter((l) => l.includes('keep me')).length === 2);

// An element with children goes as a whole, closing tag included.
const NESTED = PAGE.replace('<span className="gone">bye</span>',
  '<span className="gone"><b>b</b><i>i</i></span>');
r = run(NESTED, [{ tag: 'span', remove: true }]);
check('an element with children goes as one span',
  r.ok && !/<span|<b>|<i>/.test(r.contents), r.ok ? '' : r.refusals[0].detail);

// Inline, sharing its line with other content: cut exactly, no line surgery.
r = run('const a = <p>one <em>two</em> three</p>;', [{ tag: 'em', remove: true }]);
check('an inline element takes only its own bytes',
  r.ok && r.contents === 'const a = <p>one  three</p>;', JSON.stringify(r.ok ? r.contents : ''));

// ---- refusals: the three shapes that would not parse afterwards ----

r = run('export default function P() {\n  return <div className="root">x</div>;\n}\n',
  [{ tag: 'div', remove: true }]);
check('a component root is refused',
  !r.ok && r.refusals[0].reason === 'root-element', r.ok ? 'ACCEPTED' : r.refusals[0].detail);

r = run('const a = <div>{open && <span>x</span>}</div>;', [{ tag: 'span', remove: true }]);
check('the value of a {expression} is refused',
  !r.ok && r.refusals[0].reason === 'unsupported-parent', r.ok ? 'ACCEPTED' : r.refusals[0].detail);

r = run('const a = <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;', [{ tag: 'li', remove: true }]);
check('a .map() body is refused',
  !r.ok && r.refusals[0].reason === 'root-element', r.ok ? 'ACCEPTED' : r.refusals[0].detail);
check('a refusal writes nothing at all', !r.ok && r.contents === undefined);

// A fragment IS a valid parent — its children are a children list.
r = run('const a = <>\n  <p>a</p>\n  <p>b</p>\n</>;', [{ tag: 'p', nth: 1, remove: true }]);
check('a fragment child may be removed',
  r.ok && r.contents === 'const a = <>\n  <p>a</p>\n</>;', r.ok ? '' : r.refusals[0].detail);

// ---- remove combined with other edits in one batch ----

r = run(PAGE, [{ tag: 'span', remove: true }, { tag: 'p', nth: 1, classes: 'edited' }]);
check('a sibling edit still applies alongside a removal',
  r.ok && !/gone/.test(r.contents) && /<p className="edited">keep me too<\/p>/.test(r.contents),
  r.ok ? '' : r.refusals[0].detail);

// The dangerous one: editing a child of the element being cut. Applying that
// splice first would move the bytes the cut is measuring from.
r = run(NESTED, [{ tag: 'span', remove: true }, { tag: 'b', classes: 'doomed' }]);
check('an edit inside a removed element is dropped, not spliced',
  r.ok && !/doomed/.test(r.contents) && !/<span/.test(r.contents),
  r.ok ? JSON.stringify(r.contents) : r.refusals[0].detail);
check('dropping it left the rest of the file intact',
  r.ok && r.contents.split('\n').filter((l) => l.includes('keep me')).length === 2);

// Removing a parent and its child in the same batch: the inner cut is dropped.
r = run(NESTED, [{ tag: 'span', remove: true }, { tag: 'b', remove: true }]);
check('a removal nested inside a removal collapses to one cut',
  r.ok && !/<span|<b>/.test(r.contents) && !/\n\s*\n/.test(r.contents),
  r.ok ? '' : r.refusals[0].detail);

const src = 'const a = <p>x</p>;';
r = editFile(ts, 'test.tsx', src, [
  { id: 'x', loc: { file: 'test.tsx', line: 1, col: 11, hash: 'deadbeef' }, text: 'y' },
]);
check('stale hash refused', !r.ok && r.refusals[0].reason === 'stale-hash');

r = editFile(ts, 'test.tsx', src, [
  { id: 'x', loc: { file: 'test.tsx', line: 1, col: 11, hash: hashOf(src) }, text: 'y' },
]);
check('matching hash accepted', r.ok && r.contents === 'const a = <p>y</p>;');

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
