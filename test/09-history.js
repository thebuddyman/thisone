/**
 * The button bar, and undo/redo.
 *
 * Two things are being checked here. That the bar — save, undo, redo — outlives
 * the selection and does not move when one arrives, and that stepping back and
 * forward restores the page and the pending-change count together.
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
  await page.locator('[data-tw-mode]').click();

  const panel = page.locator('[data-tw-editor="panel"]');
  const body = panel.locator('.bw-body');
  const save = panel.locator('[data-tw-save]');
  const undo = panel.locator('[data-tw-undo]');
  const redo = panel.locator('[data-tw-redo]');
  const card = page.locator('[data-eid="8"]');
  const h1 = page.locator('[data-eid="6"]');
  const classOf = (loc) => loc.evaluate(el => el.getAttribute('class'));

  // ---- the bar exists before any selection does ----
  check('the bar shows with nothing selected',
    await save.isVisible() && await undo.isVisible() && await redo.isVisible());
  check('the panel body is not showing yet', !(await body.isVisible()));
  check('the panel says it is idle', (await panel.getAttribute('data-tw-idle')) !== null);
  check('undo and redo start disabled',
    await undo.isDisabled() && await redo.isDisabled());

  // ---- selecting grows the panel upward, it does not shove the bar down ----
  const barIdle = await save.boundingBox();
  await card.click();
  const barBusy = await save.boundingBox();
  check('the panel body appears on selection', await body.isVisible());
  check('the panel is no longer idle', (await panel.getAttribute('data-tw-idle')) === null);
  check('the bar did not move when the panel opened',
    Math.abs(barIdle.y - barBusy.y) < 1 && Math.abs(barIdle.x - barBusy.x) < 1,
    `y ${Math.round(barIdle.y)} → ${Math.round(barBusy.y)}`);
  check('the panel grew above the bar',
    (await body.boundingBox()).y + (await body.boundingBox()).height <= barBusy.y + 1);

  // ---- one edit, back, forward ----
  const original = await classOf(card);
  await panel.locator('[data-tw-field="p-x"] [data-tw-step="up"]').click();
  const edited = await classOf(card);
  check('the edit landed', edited !== original, `${original} → ${edited}`);
  check('undo woke up', !(await undo.isDisabled()));
  check('redo is still nothing to do', await redo.isDisabled());
  check('one pending change', (await save.textContent()).trim() === 'Save 1 change');

  await undo.click();
  check('undo put the classes back', (await classOf(card)) === original, await classOf(card));
  check('undo put the count back too', (await save.textContent()).trim() === 'Saved',
    await save.textContent());
  check('redo woke up', !(await redo.isDisabled()));
  check('undo is spent', await undo.isDisabled());

  await redo.click();
  check('redo re-applied the classes', (await classOf(card)) === edited, await classOf(card));
  check('redo restored the count', (await save.textContent()).trim() === 'Save 1 change');

  // ---- a new edit abandons the redo branch ----
  await undo.click();
  await panel.locator('[data-tw-field="p-y"] [data-tw-step="up"]').click();
  check('editing after an undo drops what was ahead', await redo.isDisabled());

  // ---- the bar works with nothing selected ----
  await page.keyboard.press('Escape');
  check('deselecting leaves the bar behind', await save.isVisible() && !(await body.isVisible()));
  check('and undo is still reachable', !(await undo.isDisabled()));
  await undo.click();
  check('undo works with nothing selected', (await classOf(card)) === original, await classOf(card));
  check('back to no pending changes', (await save.textContent()).trim() === 'Saved');

  // ---- a run of keystrokes is one step, not one per character ----
  await h1.click();
  const wasText = await h1.textContent();
  await h1.click({ clickCount: 3 });
  await page.keyboard.type('Hello');
  check('typing changed the text', (await h1.textContent()) !== wasText, await h1.textContent());
  await undo.click();
  check('one undo takes back the whole run',
    (await h1.textContent()) === wasText, JSON.stringify(await h1.textContent()));

  // ---- removal is a step like any other ----
  await card.click();
  await page.locator('[data-tw-delete]').click();
  check('the element is marked', (await card.getAttribute('data-tw-removed')) !== null);
  await undo.click();
  check('undo takes back a removal', (await card.getAttribute('data-tw-removed')) === null);
  check('and clears its pending change', (await save.textContent()).trim() === 'Saved');

  // ---- the keyboard does the same thing ----
  await card.click();
  await panel.locator('[data-tw-field="p-x"] [data-tw-step="up"]').click();
  const viaMouse = await classOf(card);
  await page.keyboard.press('Control+z');
  check('ctrl+z undoes', (await classOf(card)) === original, await classOf(card));
  await page.keyboard.press('Control+Shift+z');
  check('ctrl+shift+z redoes', (await classOf(card)) === viaMouse, await classOf(card));

  // ---- a write is the end of the line ----
  const before = disk();
  await save.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|refus/.test(el?.textContent || '');
  }, null, { timeout: 8000 });
  check('it saved', disk() !== before);
  check('undo cannot reach across the write', await undo.isDisabled());
  check('neither can redo', await redo.isDisabled());
  check('and the bar is still there', await save.isVisible());

  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
