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

r = run('const a = <div className={cn("p-4", x)}>hi</div>;', [{ tag: 'div', classes: 'p-8' }]);
check('cn() refused', !r.ok && r.refusals[0].reason === 'cn-call', r.ok ? 'accepted!' : r.refusals[0].reason);

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
const mixedBatch = 'export const A = (\n  <div className="a">\n    <p className={cn("b")}>x</p>\n  </div>\n);\n';
r = run(mixedBatch, [
  { tag: 'div', classes: 'CHANGED' },
  { tag: 'p', classes: 'ALSO' },
]);
check('a refusal aborts the entire batch', !r.ok && r.refusals[0].reason === 'cn-call');

// ------------------------------------------------------------- staleness

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
