const { chromium } = require('playwright');
const fs = require('fs');
/** Pick a Tailwind colour through the popover: open → hue → shade. */
async function pickColor(panel, prefix, hue, shade) {
  await panel.locator(`[data-tw-color-open="${prefix}"]`).click();
  const pop = panel.page().locator('[data-tw-pop]'); // floats on <body>, not inside the panel
  // The popover opens on the element's current hue when it has one, so step
  // back to the full list if the hue we want is not on screen.
  if (!(await pop.locator(`[data-tw-hue="${hue}"]`).count())) {
    await pop.locator('.bw-pop-back').click();
  }
  await pop.locator(`[data-tw-hue="${hue}"]`).click();
  await pop.locator(`[data-tw-shade="${shade}"]`).click();
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
  const textBox = panel.locator('[data-tw-field="text"] div');
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
  check('panel title shows the pencil', (await panel.locator('strong').first().textContent()).includes('✎'));
  check('panel mirrors current text', (await textBox.textContent()).includes('Edit this page in the browser.'));

  check('a single click focused it — no second click needed',
    await h1.evaluate(el => document.activeElement === el));
  check('caret landed inside the element',
    await h1.evaluate(el => el.contains(getSelection().anchorNode)));

  // type: select all inside the element, replace
  await selectAllIn(page);
  await page.keyboard.type('Rewritten in the browser');
  check('DOM text updated live', (await h1.textContent()) === 'Rewritten in the browser');
  check('panel preview follows typing', (await textBox.textContent()).includes('Rewritten in the browser'));
  check('class attribute untouched by typing',
    (await h1.getAttribute('class')) === 'text-4xl font-bold', await h1.getAttribute('class'));

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
  check('panel explains why', (await textBox.textContent()).includes('has child elements'));
  check('no pencil for containers', !(await panel.locator('strong').first().textContent()).includes('✎'));

  // container save still works and must not send text
  await panel.locator('[data-tw-field="p-x"] [data-tw-step="up"]').click();
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

  await page.locator('[data-eid="6"]').click();
  await page.screenshot({ path: `${__dirname}/text.png`, clip: { x: 0, y: 0, width: 1280, height: 620 } });
  await browser.close();

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
