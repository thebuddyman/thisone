/**
 * The button bar, and undo/redo.
 *
 * Two things are being checked here. That the bar — save, undo, redo — outlives
 * the selection and does not move when one arrives, and that stepping back and
 * forward restores the page and the pending-change count together.
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
  await step(panel, 'p-x', 'up');
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
  await step(panel, 'p-y', 'up');
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
  await step(panel, 'p-x', 'up');
  const viaMouse = await classOf(card);
  await page.keyboard.press('Control+z');
  check('ctrl+z undoes', (await classOf(card)) === original, await classOf(card));
  await page.keyboard.press('Control+Shift+z');
  check('ctrl+shift+z redoes', (await classOf(card)) === viaMouse, await classOf(card));

  // ---- a write is the end of the line ----
  const before = disk();
  const barPreSave = await save.boundingBox();
  await save.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|refus/.test(el?.textContent || '');
  }, null, { timeout: 8000 });
  check('it saved', disk() !== before);
  check('undo cannot reach across the write', await undo.isDisabled());
  check('neither can redo', await redo.isDisabled());
  check('and the bar is still there', await save.isVisible());
  // The status message grows upward like everything else. Below the buttons it
  // changed the footer's height and slid them 22px down as it came and went.
  check('a status message does not move the buttons',
    Math.abs((await save.boundingBox()).y - barPreSave.y) < 1,
    `${Math.round(barPreSave.y)} → ${Math.round((await save.boundingBox()).y)}` +
    `  (status: ${JSON.stringify((await panel.locator('[data-tw-status]').textContent()).trim())})`);

  // ---- folded, the bar itself is the handle ----
  //
  // The header it used to be dragged by is folded away exactly when the bar is
  // all that is on screen, so there was nothing left to grab.
  // Unfolded first: the header is a handle too, and has to say the same thing
  // the bar does. It used to say `move` while the bar said `grab`.
  await card.click();
  const cursorOf = (loc) => loc.evaluate(el => getComputedStyle(el).cursor);
  const foot = panel.locator('.bw-foot');
  check('unfolded, the header offers the open hand',
    (await cursorOf(panel.locator('.bw-h'))) === 'grab', await cursorOf(panel.locator('.bw-h')));
  check('and the bar says exactly the same thing',
    (await cursorOf(foot)) === 'grab', await cursorOf(foot));
  check('buttons on a handle still point, they do not grab',
    (await cursorOf(panel.locator('.bw-x').first())) === 'pointer',
    await cursorOf(panel.locator('.bw-x').first()));
  // ---- the close button: 40x40, transparent until hovered ----
  const x = panel.locator('.bw-x').first();
  const xBox = await x.boundingBox();
  check('the close button is 40x40',
    Math.round(xBox.width) === 40 && Math.round(xBox.height) === 40,
    `${Math.round(xBox.width)}x${Math.round(xBox.height)}`);
  check('it carries the exported mark, not a text glyph',
    (await x.locator('svg').count()) === 1 && (await x.textContent()).trim() === '',
    JSON.stringify(await x.textContent()));
  const bgOf = (loc) => loc.evaluate(el => getComputedStyle(el).backgroundColor);
  check('transparent at rest', /rgba\(0, 0, 0, 0\)|transparent/.test(await bgOf(x)), await bgOf(x));
  await x.hover();
  await page.waitForTimeout(80);
  check('and #232323 under the cursor',
    (await bgOf(x)) === 'rgb(35, 35, 35)', await bgOf(x));
  await page.mouse.move(5, 5);

  check('a disabled one offers nothing',
    (await cursorOf(save)) === 'default', await cursorOf(save));

  await page.keyboard.press('Escape');

  // Grab the empty run between the history buttons and Save — no grip icon to
  // aim at, the whole bar is the handle.
  const rb = await redo.boundingBox();
  const sbx = await save.boundingBox();
  const wasAt = await panel.boundingBox();
  const from = { x: (rb.x + rb.width + sbx.x) / 2, y: rb.y + rb.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 300, from.y - 200, { steps: 8 });
  await page.mouse.up();
  const nowAt = await panel.boundingBox();
  check('the folded bar can be dragged',
    Math.abs(nowAt.x - (wasAt.x - 300)) < 2 && Math.abs(nowAt.y - (wasAt.y - 200)) < 2,
    `${Math.round(wasAt.x)},${Math.round(wasAt.y)} → ${Math.round(nowAt.x)},${Math.round(nowAt.y)}`);

  // The bottom anchor has to survive the move, or the next selection shoves the
  // bar back down the screen — which is what dragging by the top edge did.
  const barMoved = await save.boundingBox();
  await card.click();
  const barMovedOpen = await save.boundingBox();
  check('after a drag the bar still holds still when the panel opens',
    Math.abs(barMoved.y - barMovedOpen.y) < 1,
    `${Math.round(barMoved.y)} → ${Math.round(barMovedOpen.y)}`);

  // ---- pressing a control is not a drag ----
  await step(panel, 'p-x', 'up');
  await page.keyboard.press('Escape');
  const parked = await panel.boundingBox();
  const sb = await save.boundingBox();
  await page.mouse.move(sb.x + 6, sb.y + 6);
  await page.mouse.down();
  await page.mouse.move(sb.x - 150, sb.y - 120, { steps: 5 });
  await page.mouse.up();
  const stillParked = await panel.boundingBox();
  check('pressing a button does not drag the panel',
    Math.abs(stillParked.x - parked.x) < 2 && Math.abs(stillParked.y - parked.y) < 2,
    `${Math.round(parked.x)},${Math.round(parked.y)} → ${Math.round(stillParked.x)},${Math.round(stillParked.y)}`);

  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
