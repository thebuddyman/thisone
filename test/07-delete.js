/**
 * Removing an element, end to end, in HTML mode.
 *
 * The whole point of the mark-then-save model is that nothing is destroyed
 * until Save, so most of these checks are about what has NOT happened yet.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const INDEX = process.env.TW_EDITOR_FILE;
const BASE = process.env.TW_EDITOR_URL || 'http://localhost:3000';
if (!INDEX) { console.error('TW_EDITOR_FILE not set - run via `npm test`'); process.exit(2); }

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}
const disk = () => fs.readFileSync(INDEX, 'utf8');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // The editor is off until it is asked for: nothing is selectable, and the
  // page's own clicks are its own, until edit mode is on.
  await page.locator('[data-tw-mode]').click();

  const panel = page.locator('[data-tw-editor="panel"]');
  const handle = page.locator('[data-tw-delete]');
  const before = disk();

  // ---- the handle only exists for a selection ----
  check('no delete handle before anything is selected', !(await handle.isVisible()));

  const button = page.locator('button.bg-rose-500');
  await button.click();
  check('handle appears on the selected element', await handle.isVisible());

  // It sits over the element's top-right corner, not somewhere arbitrary.
  const box = await button.boundingBox();
  const hb = await handle.boundingBox();
  check('handle sits on the top-right corner',
    Math.abs(hb.x + hb.width / 2 - box.x - box.width) < 3 &&
    Math.abs(hb.y + hb.height / 2 - box.y) < 3,
    `handle ${Math.round(hb.x)},${Math.round(hb.y)} vs corner ${Math.round(box.x + box.width)},${Math.round(box.y)}`);

  // ---- the handle belongs to the element, not to the viewport ----
  //
  // Clamped into view unconditionally it stuck to the top of the screen long
  // after the element had scrolled away above it, pointing at nothing. Tested
  // on an element near the top of the page: the fixture cannot scroll far
  // enough to push a mid-page one off the screen.
  await page.setViewportSize({ width: 1280, height: 380 });
  const near = page.locator('[data-eid="6"]');
  await page.evaluate(() => window.scrollTo(0, 0));
  await near.click();
  await page.waitForTimeout(150);
  check('the handle rides the element it belongs to', await handle.isVisible());
  const onScreen = await handle.boundingBox();
  const corner = await near.boundingBox();
  check('…on its top-right corner',
    Math.abs(onScreen.y + onScreen.height / 2 - corner.y) < 3,
    `${Math.round(onScreen.y)} vs corner ${Math.round(corner.y)}`);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);
  check('scrolling past the element takes the handle with it',
    !(await handle.isVisible()),
    await handle.evaluate(el => `${el.style.display} @${el.style.top}`));

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  check('scrolling back brings it back', await handle.isVisible());

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(150);
  await button.click(); // back to the element the rest of this suite removes

  // ---- marking is a preview, not a write ----
  await handle.click();
  check('the element is ghosted, not removed from the page',
    (await button.count()) === 1 && (await button.getAttribute('data-tw-removed')) !== null);
  check('ghost is visibly faded',
    parseFloat(await button.evaluate(el => getComputedStyle(el).opacity)) < 0.5,
    await button.evaluate(el => getComputedStyle(el).opacity));
  check('the handle hides once the element is marked', !(await handle.isVisible()));
  check('the panel says what will happen',
    await panel.locator('[data-tw-field="removed"]').isVisible());
  check('save button counts it as a change',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Save 1 change',
    await panel.locator('[data-tw-save]').textContent());
  check('every other control folds away',
    !(await panel.locator('[data-tw-field="text"]').isVisible()) &&
    !(await panel.locator('[data-tw-add-row]').isVisible()));
  check('NOTHING was written to disk yet', disk() === before);

  // ---- undo puts it back ----
  await panel.locator('[data-tw-undo-remove]').click();
  check('undo clears the ghost',
    (await button.getAttribute('data-tw-removed')) === null);
  check('undo drops the pending change',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Saved',
    await panel.locator('[data-tw-save]').textContent());
  check('undo brings the handle back', await handle.isVisible());
  check('the normal controls are back',
    await panel.locator('[data-tw-field="text"]').isVisible());

  // ---- mark again and save for real ----
  await handle.click();
  await panel.locator('[data-tw-save]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|refus/.test(el?.textContent || '');
  }, null, { timeout: 8000 });

  const after = disk();
  check('the button is gone from the file', !/Primary action/.test(after));
  check('its siblings are untouched',
    /The card/.test(after) && /Bump its padding/.test(after));
  check('exactly one line disappeared',
    before.split('\n').length - after.split('\n').length === 1,
    `${before.split('\n').length} → ${after.split('\n').length}`);
  check('no blank line was left where it stood', !/\n[ \t]+\n/.test(after));
  check('the element left the page too', (await button.count()) === 0);
  check('the panel went back to idle', (await panel.getAttribute('data-tw-idle')) !== null);
  check('the handle went with it', !(await handle.isVisible()));

  // ---- a second removal against the rewritten file ----
  // The eids were re-derived on reload; this proves the hash/index round trip
  // still lines up after the document lost an element.
  await page.reload({ waitUntil: 'networkidle' });
  const stale = disk();
  const nav = page.locator('span.text-sm.text-slate-500').first();
  await nav.click();
  // This one sits in the top-right band, right under the panel. The handle has
  // to get out from under it or the element simply cannot be deleted.
  const pb = await panel.boundingBox();
  const nb = await handle.boundingBox();
  check('handle escapes the panel for an element underneath it',
    nb.x + nb.width <= pb.x + 1 || nb.x >= pb.x + pb.width - 1 ||
    nb.y + nb.height <= pb.y + 1 || nb.y >= pb.y + pb.height - 1,
    `handle ${Math.round(nb.x)},${Math.round(nb.y)} vs panel ${Math.round(pb.x)},${Math.round(pb.y)} ${Math.round(pb.width)}x${Math.round(pb.height)}`);
  await handle.click();
  await panel.locator('[data-tw-save]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|refus/.test(el?.textContent || '');
  }, null, { timeout: 8000 });
  const twice = disk();
  check('a second removal lands on the right element',
    !/visual editor poc/.test(twice) && /Bloomworks/.test(twice),
    twice === stale ? 'FILE UNCHANGED' : 'ok');

  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
