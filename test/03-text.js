const { chromium } = require('playwright');
const fs = require('fs');

/**
 * Nudge a spacing field by one pixel.
 *
 * The stepper buttons are gone — the field takes a typed value and a chevron
 * opens the token list — but the arrow keys still step, which is what these
 * checks are really about.
 */
async function step(panel, field, dir) {
  const input = panel.locator(`[data-tw-field="${field}"] input`);
  await input.focus();
  await input.press(dir === 'down' ? 'ArrowDown' : 'ArrowUp');
  await input.blur();
}
/** Pick a Tailwind colour through the popover: open → hue → shade. */
async function pickColor(panel, prefix, hue, shade) {
  // A colour that is not set stands in for itself with a + row, so open it the
  // way a user would before reaching for the field.
  const reveal = panel.locator(`[data-tw-reveal="${prefix}"]`);
  if (await reveal.isVisible()) await reveal.click();
  await panel.locator(`[data-tw-color-open="${prefix}"]`).click();
  // Both float on <body>, not inside the panel — and they are two boxes now,
  // so the grid never has to be stepped back to: it is on screen the whole
  // time, and the ramp opens beside it.
  const pop = panel.page().locator('[data-tw-pop]');
  const shades = panel.page().locator('[data-tw-pop-shade]');
  await pop.locator(`[data-tw-hue="${hue}"]`).click();
  await shades.locator(`[data-tw-shade="${shade}"]`).click();
}

const INDEX = process.env.TW_EDITOR_FILE;
const BASE = process.env.TW_EDITOR_URL || 'http://localhost:3000';
if (!INDEX) { console.error('TW_EDITOR_FILE not set - run via `npm test`'); process.exit(2); }

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}
const disk = () => fs.readFileSync(INDEX, 'utf8');

// Platform-independent "select everything inside the focused editable element".
const selectAllIn = page => page.evaluate(() => {
  const el = document.activeElement;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') console.log('  [console error]', m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // The editor is off until it is asked for: nothing is selectable, and the
  // page's own clicks are its own, until edit mode is on.
  await page.locator('[data-tw-mode]').click();

  const panel = page.locator('[data-tw-editor="panel"]');
  // The Text row is a real field now, not a mirror: read its value, and its
  // placeholder for the cases it refuses.
  const textBox = panel.locator('[data-tw-text]');
  const textShows = async () =>
    (await textBox.isDisabled()) ? (await textBox.getAttribute('placeholder')) : (await textBox.inputValue());
  const saveAndWait = async () => {
    await panel.locator('[data-tw-save]').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-tw-status]');
      return /written|failed/.test(el?.textContent || '');
    }, null, { timeout: 5000 });
    return (await panel.locator('[data-tw-status]').textContent()).trim();
  };

  // ---- leaf element: the h1 ----
  const h1 = page.locator('[data-eid="6"]');
  await h1.click();
  check('leaf selection is contenteditable', await h1.evaluate(el => el.isContentEditable));
  check('the title is just the element, no status glyph',
    !/✎/.test(await panel.locator('strong').first().textContent()),
    await panel.locator('strong').first().textContent());
  check('the field holds the element\'s text',
    (await textShows()).includes('Edit this page in the browser.'), await textShows());
  check('and it is editable', !(await textBox.isDisabled()));


  check('a single click focused it — no second click needed',
    await h1.evaluate(el => document.activeElement === el));
  check('caret landed inside the element',
    await h1.evaluate(el => el.contains(getSelection().anchorNode)));

  // type: select all inside the element, replace
  await selectAllIn(page);
  await page.keyboard.type('Rewritten in the browser');
  check('DOM text updated live', (await h1.textContent()) === 'Rewritten in the browser');
  check('panel preview follows typing', (await textShows()).includes('Rewritten in the browser'));
  check('class attribute untouched by typing',
    (await h1.getAttribute('class')) === 'text-4xl font-bold', await h1.getAttribute('class'));
  check('the panel field followed the typing on the page',
    (await textShows()) === (await h1.textContent()),
    `${await textShows()} vs ${await h1.textContent()}`);

  // Enter must not inject <br>/<div>
  await page.keyboard.press('Enter');
  await page.keyboard.type('!');
  check('Enter did not create child nodes', (await h1.evaluate(el => el.children.length)) === 0);
  check('text stayed one line', (await h1.textContent()) === 'Rewritten in the browser!');

  // also nudge a class in the same session, then save both at once
  await pickColor(panel, 'text', 'indigo', '600');
  let status = await saveAndWait();
  check('save reported success', status.includes('written'), status);

  let file = disk();
  check('disk has the new text', file.includes('>Rewritten in the browser!</h1>'),
    file.split('\n').find(l => l.includes('<h1')));
  check('disk has the new class in the same write',
    /<h1 class="text-4xl font-bold text-indigo-600">/.test(file));
  check('no contenteditable leaked to disk', !file.includes('contenteditable'));
  check('no spellcheck leaked to disk', !file.includes('spellcheck'));

  // ---- escaping: typed markup must not become real markup ----
  const footerP = page.locator('[data-eid="13"]');
  await footerP.click();
  await selectAllIn(page);
  await page.keyboard.type('<script>alert(1)</script> AT&T "quoted" 5 < 6');
  status = await saveAndWait();
  check('escaped save succeeded', status.includes('written'), status);

  file = disk();
  const footerLine = file.split('\n').find(l => l.includes('AT&amp;T'));
  check('typed markup was escaped on disk', !!footerLine && footerLine.includes('&lt;script&gt;'), footerLine);
  check('no live script tag written', !/<script>alert/.test(file));
  check('ampersand escaped', file.includes('AT&amp;T'));

  // ---- reload: text round-trips back through the parser ----
  await page.reload({ waitUntil: 'networkidle' });
  const reloaded = await page.locator('[data-eid="13"]').textContent();
  check('entities decode back to the typed text',
    reloaded === '<script>alert(1)</script> AT&T "quoted" 5 < 6', JSON.stringify(reloaded));
  check('h1 text persisted across reload',
    (await page.locator('[data-eid="6"]').textContent()) === 'Rewritten in the browser!');

  // ---- container element: refuses text editing ----
  const card = page.locator('[data-eid="8"]');
  await card.click({ position: { x: 3, y: 3 } });
  check('container is not contenteditable', !(await card.evaluate(el => el.isContentEditable)));
  check('a container gets no Text row at all',
    !(await panel.locator('[data-tw-field="text"]').isVisible()));

  // container save still works and must not send text
  await step(panel, 'p-x', 'up');
  status = await saveAndWait();
  check('container class-only save succeeded', status.includes('written'), status);
  check('container children survived the save',
    disk().includes('<h2 class="text-2xl font-bold">The card</h2>'));

  // server-side guard, independent of the client
  const guard = await page.evaluate(() => fetch('/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eid: 8, text: 'nuke the card' }),
  }).then(r => r.json().then(j => ({ status: r.status, j }))));
  check('server rejects text on a container', guard.status === 409 && guard.j.ok === false, guard.j.error);
  check('card markup intact after rejected write', disk().includes('The card'));

  // ---- editing text does not disturb selection of other elements ----
  await page.keyboard.press('Escape');
  check('escape cleaned contenteditable off the page',
    (await page.locator('[contenteditable]').count()) === 0);

  // ---- alignment: the third family sharing the text- prefix ----
  const h1b = page.locator('[data-eid="6"]');
  await h1b.click();
  const align = (n) => panel.locator(`[data-tw-align="${n}"]`);
  check('the align control shows on an element with text', await align('center').isVisible());
  check('nothing is pressed while it is unset',
    (await align('center').getAttribute('aria-pressed')) === 'false');

  const beforeAlign = await h1b.getAttribute('class');
  await align('center').click();
  const afterAlign = await h1b.getAttribute('class');
  check('picking centre writes text-center', /(^| )text-center( |$)/.test(afterAlign), afterAlign);
  check('and marks itself pressed',
    (await align('center').getAttribute('aria-pressed')) === 'true');
  check('the size and colour classes it shares a prefix with are untouched',
    beforeAlign.split(' ').every((c) => afterAlign.includes(c)),
    `${beforeAlign} → ${afterAlign}`);
  check('it actually renders centred',
    (await h1b.evaluate(el => getComputedStyle(el).textAlign)) === 'center',
    await h1b.evaluate(el => getComputedStyle(el).textAlign));

  await align('right').click();
  check('switching replaces rather than stacks',
    /text-right/.test(await h1b.getAttribute('class')) &&
    !/text-center/.test(await h1b.getAttribute('class')),
    await h1b.getAttribute('class'));

  await align('right').click();
  check('pressing the set one clears it',
    !/text-(left|center|right)/.test(await h1b.getAttribute('class')),
    await h1b.getAttribute('class'));
  check('and the classes are back where they started',
    (await h1b.getAttribute('class')) === beforeAlign,
    `${beforeAlign} → ${await h1b.getAttribute('class')}`);

  // ---- the size field is a field too: a length typed, the ladder behind
  // the chevron ----
  //
  // The first of the three families sharing the text- prefix, and the one that
  // used to be a button end to end. What is checked here is the seam typing
  // opens: that a number is a length and a name is a token, and that the two
  // are not quietly swapped for each other.
  const size = panel.locator('[data-tw-field="font"]');
  const sizeIn = size.locator('input');
  const sizeCls = () => h1b.getAttribute('class');
  const sizeNote = () => size.locator('.bw-unit').textContent();
  const sizePx = () => h1b.evaluate(el => getComputedStyle(el).fontSize);
  const pending = async () => (await panel.locator('[data-tw-save]').textContent()).trim();

  check('the value is an input, and the chevron beside it is what opens the list',
    (await sizeIn.evaluate(e => e.tagName)) === 'INPUT' &&
    (await size.locator('[data-tw-font-open]').count()) === 1);
  check('a token reads as the pixels it renders, with the rung beside it',
    (await sizeIn.inputValue()) === '36' && (await sizeNote()) === '4xl',
    `${await sizeIn.inputValue()} / ${await sizeNote()}`);
  check('and stands on the same 12px gutter the bare token beside it does',
    (await sizeIn.evaluate(e => getComputedStyle(e).paddingLeft)) === '12px',
    await sizeIn.evaluate(e => getComputedStyle(e).paddingLeft));

  // 18 is exactly what lg renders here, and it must not become text-lg: that
  // token sets a line-height as well, so a number typed into a size field
  // would move the leading nobody asked about. Every other length field snaps
  // to its rung because there the rung is the length and nothing else.
  await sizeIn.fill('18');
  await sizeIn.press('Enter');
  check('a typed number is a length, and stays a literal even on a rung',
    /(^| )text-\[18px\]( |$)/.test(await sizeCls()) && !/text-lg/.test(await sizeCls()),
    await sizeCls());
  check('…and it paints, on a class no source file has',
    (await sizePx()) === '18px', await sizePx());
  check('…and is marked a literal, italic and snowflaked from the one condition',
    (await sizeIn.getAttribute('class')).includes('is-jit') &&
    await size.locator('.bw-snow').isVisible(),
    await sizeIn.getAttribute('class'));

  await sizeIn.fill('lg');
  await sizeIn.press('Enter');
  check('a token name is how you ask for the token, line-height and all',
    /(^| )text-lg( |$)/.test(await sizeCls()) && (await sizeNote()) === 'lg' &&
    (await sizePx()) === '18px', await sizeCls());
  await sizeIn.fill('text-2xl');
  await sizeIn.press('Enter');
  check('the prefix is the panel’s business, not the typist’s',
    /(^| )text-2xl( |$)/.test(await sizeCls()) && !/text-lg/.test(await sizeCls()),
    await sizeCls());

  await sizeIn.fill('1.5rem');
  await sizeIn.press('Enter');
  check('a length in another unit keeps it, in the field and in the class',
    /(^| )text-\[1\.5rem\]( |$)/.test(await sizeCls()) &&
    (await sizeIn.inputValue()) === '1.5rem', await sizeCls());

  const junkBefore = await sizeCls();
  await sizeIn.fill('banana');
  await sizeIn.press('Enter');
  check('a word is no size: the field puts itself back and writes nothing',
    (await sizeCls()) === junkBefore && (await sizeIn.inputValue()) === '1.5rem',
    await sizeCls());

  const tabBefore = await pending();
  await sizeIn.focus();
  await sizeIn.blur();
  check('tabbing through it is not an edit', (await pending()) === tabBefore,
    `${tabBefore} → ${await pending()}`);

  await sizeIn.fill('');
  await sizeIn.press('Enter');
  // By membership, not by prefix — text-indigo-600 is on this element too, and
  // it is a colour. Clearing a size that took it with it would be the /^text-/
  // trap, one field along from where the family map already refuses it.
  const SIZE_CLASS = /(^| )text-(?:\[[^\]]+\]|xs|sm|base|lg|[2-9]?xl)( |$)/;
  check('empty takes the size class off, and only that one',
    !SIZE_CLASS.test(await sizeCls()) && /text-indigo-600/.test(await sizeCls()),
    await sizeCls());
  check('…and what the page renders goes in the placeholder, not the value',
    (await sizeIn.inputValue()) === '' &&
    Number(await sizeIn.getAttribute('placeholder')) > 0 &&
    (await sizeNote()) === 'inherited',
    `"${await sizeIn.inputValue()}" ph ${await sizeIn.getAttribute('placeholder')} / ${await sizeNote()}`);

  // Put the heading back the size it was, through the field itself.
  await sizeIn.fill('4xl');
  await sizeIn.press('Enter');
  check('and the token typed back restores it',
    /(^| )text-4xl( |$)/.test(await sizeCls()) && (await sizePx()) === '36px',
    await sizeCls());

  // ---- and the arrows count pixels here too ----
  //
  // A press writes what typing that number writes: a literal, never the rung
  // it lands on. The first press off a token therefore detaches from it, which
  // is the honest reading — this ladder is 12, 14, 16, 18, 20, 24, 30, 36, and
  // was never something a count could walk.
  await sizeIn.focus();
  await sizeIn.press('ArrowUp');
  check('an arrow steps the size up one pixel, straight to a literal',
    (await sizeIn.inputValue()) === '37' &&
    /(^| )text-\[37px\]( |$)/.test(await sizeCls()), await sizeCls());
  check('…and the marking lands with the step, not at the next blur',
    (await sizeIn.getAttribute('class')).includes('is-jit') &&
    await size.locator('.bw-snow').isVisible(),
    await sizeIn.getAttribute('class'));
  await sizeIn.press('Shift+ArrowUp');
  check('Shift is ten of them', (await sizeIn.inputValue()) === '47', await sizeIn.inputValue());
  await sizeIn.press('Shift+ArrowDown');
  check('…both ways', (await sizeIn.inputValue()) === '37' && (await sizePx()) === '37px',
    await sizePx());
  await sizeIn.blur();

  // Restore it once more, now that the arrows have been over it.
  await sizeIn.fill('4xl');
  await sizeIn.press('Enter');
  check('the heading is back at 4xl for the checks below',
    /(^| )text-4xl( |$)/.test(await sizeCls()), await sizeCls());

  // ---- the Text field is a field: typing in it writes through ----
  //
  // Deliberately last. Filling it moves focus into the panel, which is exactly
  // what the page-typing checks above are asserting does not happen by itself.
  const leaf = page.locator('[data-eid="6"]');
  await leaf.click();
  const classesBefore = await leaf.getAttribute('class');
  await textBox.fill('Typed from the panel');
  check('panel typing reached the element',
    (await leaf.textContent()) === 'Typed from the panel', await leaf.textContent());
  check('and counted as a pending change',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Save 1 change',
    await panel.locator('[data-tw-save]').textContent());
  check('the class attribute is untouched by panel typing',
    (await leaf.getAttribute('class')) === classesBefore, await leaf.getAttribute('class'));
  status = await saveAndWait();
  check('panel-typed text reaches disk', status.includes('written') &&
    />Typed from the panel</.test(disk()),
    disk().split('\n').find(l => l.includes('<h1')));

  // ---- text broken up by markup is edited one run at a time ----
  //
  // `Read the <a>docs</a> or the <a>guide</a> first.` is not one string: it is
  // three literals with markup between them, and each is its own stretch of the
  // file. The whole element used to be refused as `has-children`.
  await page.keyboard.press('Escape');
  const mixed = page.locator('footer p').nth(1);
  await mixed.click();
  const runFields = panel.locator('[data-tw-text-run]');
  check('a field for each literal run, and none for the markup between them',
    (await runFields.count()) === 3, String(await runFields.count()));
  check('the single-text box is not offered for this element',
    !(await panel.locator('[data-tw-text]').isVisible()));
  check('each field holds its own run, not the whole element',
    (await runFields.nth(0).inputValue()) === 'Read the'
    && (await runFields.nth(2).inputValue()) === 'first.',
    `${await runFields.nth(0).inputValue()} | ${await runFields.nth(2).inputValue()}`);

  await runFields.nth(0).fill('Start with the');
  await runFields.nth(2).fill('to begin.');
  check('typing a run reaches the page without disturbing the links',
    (await mixed.locator('a').count()) === 2
    && (await mixed.textContent()).includes('Start with the')
    && (await mixed.textContent()).includes('docs'),
    await mixed.textContent());

  status = await saveAndWait();
  const line = (disk().split('\n').find((l) => l.includes('underline')) || '').trim();
  // The whole line, not `includes` of the words: the first version of this
  // check passed while the write was silently closing the gaps either side of
  // each run — `Read the <a>docs</a>` had become `Read thedocs`. Only the
  // exact bytes catch that, which is the standard everywhere else here.
  const want = '<p class="text-sm text-slate-500">Start with the '
    + '<a href="#" class="underline">docs</a> or the '
    + '<a href="#" class="underline">guide</a> to begin.</p>';
  check('both runs reach disk, and nothing else on the line moves',
    status.includes('written') && line === want, line);
  check('...including the space either side of each run, which is what keeps '
    + 'the words apart', / the <a/.test(line) && /<\/a> to begin/.test(line), line);

  // ---- text with nothing writable behind it says so, before you type ----
  //
  // `<p>{name}</p>` renders as ordinary characters, so the overlay cannot tell
  // it from a literal — it used to let you type and refuse at save. The loader
  // stamps the shape it saw and the panel reads that. Set here rather than in
  // the fixture: adding an element would renumber every data-eid the other
  // suites address.
  const expr = page.locator('[data-eid="6"]');
  await page.keyboard.press('Escape');
  await expr.evaluate((el) => el.setAttribute('data-bw-text', 'expr'));
  await expr.click();
  check('the Text row is still on screen — silence would read as a bug',
    await panel.locator('[data-tw-field="text"]').isVisible());
  check('...but it explains itself instead of offering a box',
    await panel.locator('[data-tw-text-note]').isVisible());
  check('...and says where the text actually comes from',
    /expression/.test(await panel.locator('[data-tw-text-note]').textContent()),
    await panel.locator('[data-tw-text-note]').textContent());
  check('the box is gone, so there is nothing to type into',
    !(await panel.locator('[data-tw-text]').isVisible()));
  check('and the page will not take typing either',
    !(await expr.evaluate((el) => el.isContentEditable)));
  await expr.evaluate((el) => el.removeAttribute('data-bw-text'));

  await page.locator('[data-eid="6"]').click();
  await page.screenshot({ path: `${__dirname}/text.png`, clip: { x: 0, y: 0, width: 1280, height: 620 } });
  await browser.close();

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
