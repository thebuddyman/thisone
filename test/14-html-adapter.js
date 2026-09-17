/**
 * Pure unit tests for the HTML writer. No filesystem, no browser.
 *
 * The claim under test is the tool's first rule: a write replaces a byte span
 * and nothing else moves. So every check here names the exact output, and the
 * source is full of things a serializer would "fix": single quotes, unquoted
 * values, uppercase tags, a void element spelled `<br/>`, entities, CRLF.
 */
const html = require('../html-adapter');

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

/** The id of the nth `<tag` in the source, so positions are never hand-counted. */
function idOf(source, tag, nth = 0) {
  const re = new RegExp('<' + tag + '(?=[\\s/>])', 'gi');
  let m, i = 0;
  while ((m = re.exec(source))) {
    if (i++ === nth) {
      const before = source.slice(0, m.index);
      const line = before.split('\n').length;
      const col = m.index - (before.lastIndexOf('\n') + 1) + 1;
      return `page.html:${line}:${col}:${html.hashOf(source)}`;
    }
  }
  throw new Error(`no <${tag}> #${nth} in source`);
}

function edit(source, id, change) {
  return html.editFile(source, [{ id, loc: html.parseLoc(id), ...change }]);
}

/** One replacement and nothing else: the rest of the file is the same bytes. */
function expectSwap(name, source, result, from, to) {
  const want = source.replace(from, to);
  check(name, result.ok && source.includes(from) && result.contents === want,
    result.ok ? JSON.stringify(result.contents.slice(0, 160)) : JSON.stringify(result.refusals));
}

const HOSTILE = [
  '<!DOCTYPE html>',
  '<HTML lang=en>',
  '<head><title>a &amp; b</title></head>',
  '<BODY   class = "page"  >',
  "<div id='one' class='p-4 m-2'   data-x=1>",
  '  <img src="a.png" alt="" class=w-4 />',
  '  <br/>',
  '  <p>Fish &amp; chips &mdash; <a href="#" CLASS="underline">now</a>  or later</p>',
  '  <span>plain</span>',
  '  <input disabled class>',
  '</div>',
  '<!-- a comment  with   spaces -->',
  '<table><tr><td class="p-1">cell</td></tr></table>',
  '<ul>',
  '  <li>one',
  '  <li>two',
  '</ul>',
  '</BODY>',
  '</HTML>',
  '',
].join('\r\n');

// ---- identity ----
{
  const nodes = html.hostElements(html.parseDocument(HOSTILE));
  const tags = [...nodes.values()].map((n) => n.tagName).join(' ');
  check('only elements the file spells out are stamped: no implied <tbody>',
    tags === 'div img br p a span input table tr td ul li li', tags);

  const { html: served, hash } = html.stamp(HOSTILE, 'page.html', '/editor.js');
  const unstamped = served
    .replace(/ data-thisone-loc="[^"]*"/g, '')
    .replace(/\n<script>document\.body[^\n]*<\/script>\n<script src="\/editor\.js"><\/script>\n/, '');
  check('the served page is the file plus insertions, byte for byte', unstamped === HOSTILE);
  check('every stamp carries the file, a line, a column and the hash',
    (served.match(/data-thisone-loc="page\.html:\d+:\d+:[0-9a-f]{8}"/g) || []).length === nodes.size
      && served.includes(`:${hash}"`));
  check('the overlay script lands inside <body>',
    served.indexOf('/editor.js') < served.toUpperCase().indexOf('</BODY>'));

  const bare = '<p class="a">no body tag at all</p>\n';
  const s2 = html.stamp(bare, 'bare.html', '/editor.js').html;
  check('a file with no <body> tag is still stamped and scripted',
    s2.startsWith('<p data-thisone-loc="bare.html:1:1:') && s2.includes('/editor.js'));
}

// ---- classes ----
expectSwap('single quotes stay single', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'div'), { classes: 'p-8 m-2' }), "class='p-4 m-2'", "class='p-8 m-2'");

expectSwap('an unquoted value gets quotes, because the new one may hold a space', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'img'), { classes: 'w-4 h-4' }), 'class=w-4 />', 'class="w-4 h-4" />');

expectSwap('a bare `class` is given its value', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'input'), { classes: 'p-2' }), '<input disabled class>', '<input disabled class="p-2">');

expectSwap('an uppercase attribute name is found and left uppercase', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'a'), { classes: 'no-underline' }), 'CLASS="underline"', 'CLASS="no-underline"');

expectSwap('no class attribute: one is added after the tag name', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'span'), { classes: 'font-bold' }), '<span>plain', '<span class="font-bold">plain');

expectSwap('an emptied class list takes the attribute with it', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'td'), { classes: '' }), '<td class="p-1">', '<td>');

{
  const r = edit(HOSTILE, idOf(HOSTILE, 'span'), { classes: '  ' });
  check('no attribute and nothing to add is no change at all', r.ok && r.contents === HOSTILE);
}

expectSwap("a quote inside a class cannot close the attribute it sits in", HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'div'), { classes: "p-4 content-['x']" }),
  "class='p-4 m-2'", "class='p-4 content-[&#39;x&#39;]'");

expectSwap('an implied <li> with no closing tag still takes a class', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'li', 1), { classes: 'mt-2' }), '<li>two', '<li class="mt-2">two');

// ---- text ----
expectSwap('text is replaced between the tags', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'span'), { text: 'a < b & c' }), '<span>plain</span>', '<span>a &lt; b &amp; c</span>');

{
  const r = edit(HOSTILE, idOf(HOSTILE, 'p'), { text: 'gone' });
  check('text on an element with children is refused',
    !r.ok && r.refusals[0].reason === 'has-children', JSON.stringify(r.refusals || r.contents));

  const li = edit(HOSTILE, idOf(HOSTILE, 'li'), { text: 'uno' });
  check('text on an element the file never closes is refused',
    !li.ok && li.refusals[0].reason === 'no-text', JSON.stringify(li.refusals || 'accepted'));
}

expectSwap('a run is found by what the page shows, entities decoded, and its spacing kept', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'p'), { runs: [{ from: 'Fish & chips —', to: 'Pie & mash' }] }),
  '<p>Fish &amp; chips &mdash; <a', '<p>Pie &amp; mash <a');

expectSwap('the run after the markup is a separate literal', HOSTILE,
  edit(HOSTILE, idOf(HOSTILE, 'p'), { runs: [{ from: 'or later', to: 'or never' }] }),
  '</a>  or later</p>', '</a>  or never</p>');

{
  const r = edit(HOSTILE, idOf(HOSTILE, 'p'), { runs: [{ from: 'not there', to: 'x' }] });
  check('a run the file no longer holds is refused',
    !r.ok && r.refusals[0].reason === 'run-missing');
}

// ---- removal ----
{
  const r = edit(HOSTILE, idOf(HOSTILE, 'span'), { remove: true });
  check('an element alone on its line goes with its line',
    r.ok && r.contents === HOSTILE.replace('  <span>plain</span>\r\n', ''));

  const a = edit(HOSTILE, idOf(HOSTILE, 'a'), { remove: true });
  check('an inline element is cut out of its line and the line stays',
    a.ok && a.contents === HOSTILE.replace('<a href="#" CLASS="underline">now</a>', ''));

  const both = html.editFile(HOSTILE, [
    { id: idOf(HOSTILE, 'div'), loc: html.parseLoc(idOf(HOSTILE, 'div')), remove: true },
    { id: idOf(HOSTILE, 'span'), loc: html.parseLoc(idOf(HOSTILE, 'span')), classes: 'x' },
  ]);
  check('an edit inside a removed parent is dropped, not spliced',
    both.ok && !both.contents.includes('<span') && both.contents.includes('<!-- a comment  with   spaces -->'));
}

// ---- staleness ----
{
  const id = idOf(HOSTILE, 'span');
  const moved = HOSTILE.replace('plain', 'changed');
  const r = html.editFile(moved, [{ id, loc: html.parseLoc(id), classes: 'x' }]);
  check('an id stamped from other bytes is refused as stale',
    !r.ok && r.refusals[0].reason === 'stale-hash');

  const ghost = `page.html:999:1:${html.hashOf(HOSTILE)}`;
  const g = html.editFile(HOSTILE, [{ id: ghost, loc: html.parseLoc(ghost), classes: 'x' }]);
  check('a location with no element is refused', !g.ok && g.refusals[0].reason === 'not-found');
}

// ---- renaming ids after a write ----
{
  const divId = idOf(HOSTILE, 'div');
  const r = edit(HOSTILE, divId, { classes: 'p-10 m-2 flex' });
  const map = html.remap(HOSTILE, r.contents, 'page.html', []);
  check('every element gets a new id, and each new id resolves',
    map && Object.keys(map).length === 13
      && Object.values(map).every((id) => {
        const loc = html.parseLoc(id);
        return html.hostElements(html.parseDocument(r.contents)).has(`${loc.line}:${loc.col}`);
      }));
  check('an element later on the edited line moves column, and the map says where',
    map[divId] === idOf(r.contents, 'div') && map[idOf(HOSTILE, 'td')] === idOf(r.contents, 'td'));

  const spanId = idOf(HOSTILE, 'p');
  const cut = edit(HOSTILE, spanId, { remove: true });
  const after = html.remap(HOSTILE, cut.contents, 'page.html', [spanId]);
  check('a removed element and its children leave the map, and the rest shift up a line',
    after && !(spanId in after) && !(idOf(HOSTILE, 'a') in after)
      && after[idOf(HOSTILE, 'span')] === idOf(cut.contents, 'span'));

  // A second write, addressed by the renamed id, against the written bytes.
  const again = edit(cut.contents, after[idOf(HOSTILE, 'span')], { classes: 'italic' });
  check('a renamed id is good for the next write with no reload',
    again.ok && again.contents.includes('<span class="italic">plain</span>'));
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
