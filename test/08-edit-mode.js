/**
 * The editor is off until it is asked for.
 *
 * The point of the gate is that a page carrying the overlay is still just a
 * page: its links work, its buttons fire, nothing highlights under the cursor.
 * Most of these checks are about the editor NOT acting.
 */
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

const INDEX = process.env.TW_EDITOR_FILE;
const BASE = process.env.TW_EDITOR_URL || 'http://localhost:3000';
if (!INDEX) { console.error('TW_EDITOR_FILE not set - run via `npm test`'); process.exit(2); }

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}
const disk = () => fs.readFileSync(INDEX, 'utf8');

/** Count clicks the page itself receives, so "swallowed" is measured not assumed. */
const countPageClicks = (page) => page.evaluate(() => {
  window.__hits = 0;
  document.addEventListener('click', () => { window.__hits++; });
});
const hits = (page) => page.evaluate(() => window.__hits);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  const panel = page.locator('[data-tw-editor="panel"]');
  const toggle = page.locator('[data-tw-mode]');
  const ring = page.locator('[data-tw-editor="ring"]');
  const card = page.locator('[data-eid="8"]');
  await countPageClicks(page);

  // ---- off: the page is just the page ----
  check('the toggle is the only thing showing', await toggle.isVisible() && !(await panel.isVisible()));
  check('it reports itself as off', (await toggle.getAttribute('aria-pressed')) === 'false');
  check('no viewport ring while off', !(await ring.isVisible()));

  await card.hover();
  check('nothing highlights under the cursor',
    (await card.evaluate(el => getComputedStyle(el).outlineStyle)) === 'none',
    await card.evaluate(el => getComputedStyle(el).outlineStyle));

  await card.click();
  check('clicking an element selects nothing', !(await panel.isVisible()));
  check("the page's own click went through", (await hits(page)) === 1, String(await hits(page)));

  // ---- on ----
  await toggle.click();
  check('it reports itself as on', (await toggle.getAttribute('aria-pressed')) === 'true');
  check('a ring marks that clicks are being held', await ring.isVisible());
  check('turning it on selects nothing by itself',
    (await panel.getAttribute('data-tw-idle')) !== null);
  check('but the button bar is there from the start',
    await panel.locator('[data-tw-save]').isVisible());

  const before = await hits(page);
  await card.click();
  check('now clicking an element opens the panel', await panel.locator('.bw-body').isVisible());
  check("the page's own click was swallowed", (await hits(page)) === before,
    `${before} → ${await hits(page)}`);

  // A leaf, deliberately: hovering a container lands on whichever child owns
  // its centre, and the editor highlights the innermost stamped element.
  const other = page.locator('[data-eid="6"]');
  await other.hover();
  check('hovering highlights while on',
    (await other.evaluate(el => getComputedStyle(el).outlineStyle)) === 'dashed',
    await other.evaluate(el => getComputedStyle(el).outlineStyle));

  // ---- escape steps out one layer at a time ----
  await page.keyboard.press('Escape');
  check('escape drops the selection first', (await panel.getAttribute('data-tw-idle')) !== null);
  check('…and stays in edit mode', (await toggle.getAttribute('aria-pressed')) === 'true');
  await page.keyboard.press('Escape');
  check('escape again leaves edit mode', (await toggle.getAttribute('aria-pressed')) === 'false');

  // ---- unsaved work survives leaving the mode ----
  await toggle.click();
  await card.click();
  const diskBefore = disk();
  await step(panel, 'p-x', 'up');
  check('an edit is pending',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Save 1 change');

  await toggle.click();
  check('leaving edit mode does not discard it',
    (await toggle.locator('.bw-count').textContent()).trim() === '1',
    JSON.stringify(await toggle.locator('.bw-count').textContent()));
  check('the element keeps its unsaved marker',
    (await card.evaluate(el => getComputedStyle(el).outlineStyle)) === 'dashed',
    await card.evaluate(el => getComputedStyle(el).outlineStyle));
  const onDisk = disk();
  check('and nothing was written', onDisk === diskBefore);

  await toggle.click();
  await card.click();
  check('coming back, the change is still pending',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Save 1 change',
    await panel.locator('[data-tw-save]').textContent());
  await panel.locator('[data-tw-save]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|refus/.test(el?.textContent || '');
  }, null, { timeout: 8000 });
  check('it saves normally afterwards', disk() !== onDisk,
    disk() === onDisk ? 'FILE UNCHANGED' : 'ok');
  check('the count clears once saved',
    (await toggle.locator('.bw-count').textContent()).trim() === '');

  // ---- the choice is kept for the tab, not the browser ----
  await page.reload({ waitUntil: 'networkidle' });
  check('a reload in the same tab stays in edit mode',
    (await page.locator('[data-tw-mode]').getAttribute('aria-pressed')) === 'true');

  const fresh = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await fresh.goto(BASE + '/', { waitUntil: 'networkidle' });
  check('a fresh tab starts off',
    (await fresh.locator('[data-tw-mode]').getAttribute('aria-pressed')) === 'false');
  await fresh.close();

  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
