/**
 * The three bugs that made the POC untrustworthy:
 *   1. unsaved edits vanished silently on refresh
 *   2. the all-sides control ignored px-* / py-*
 *   3. a file edited out of band let a stale eid write to the wrong element
 */
const { chromium } = require('playwright');
const fs = require('fs');

/**
 * Nudge a spacing field by one rung.
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
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const disk = () => fs.readFileSync(INDEX, 'utf8');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // The editor is off until it is asked for: nothing is selectable, and the
  // page's own clicks are its own, until edit mode is on.
  await page.locator('[data-tw-mode]').click();

  const panel = page.locator('[data-tw-editor="panel"]');
  const saveBtn = panel.locator('[data-tw-save]');
  const status = () => panel.locator('[data-tw-status]').textContent();
  const padPlus = { click: () => step(panel, 'p-x', 'up') };

  // ---------- 2. the horizontal input owns px-* outright ----------
  await page.locator('[data-eid="9"]').evaluate(el => { el.className = 'text-2xl font-bold px-6'; });
  const h2 = page.locator('[data-eid="9"]');
  check('setup: px-6 gives 24px horizontal padding',
    (await h2.evaluate(el => getComputedStyle(el).paddingLeft)) === '24px');

  await h2.click({ position: { x: 3, y: 3 } });
  // The field is in pixels: px-6 renders 24, so 24 is what it says.
  check('horizontal input reads px-6 as its own, not inherited',
    (await panel.locator('[data-tw-field="p-x"] input').inputValue()) === '24' &&
    (await panel.locator('[data-tw-field="p-x"] input').evaluate(e => getComputedStyle(e).fontStyle)) === 'normal',
    await panel.locator('[data-tw-field="p-x"] input').inputValue());

  await padPlus.click();
  const stepped = await panel.locator('[data-tw-field="p-x"] input').inputValue();
  check('px-6 replaced, not duplicated',
    (await h2.getAttribute('class')).split(' ').filter(c => /^px-/.test(c)).length === 1 &&
    !/\bpx-6\b/.test(await h2.getAttribute('class')),
    await h2.getAttribute('class'));
  check('horizontal padding actually changed',
    (await h2.evaluate(el => getComputedStyle(el).paddingLeft)) === `${stepped}px`,
    await h2.evaluate(el => getComputedStyle(el).paddingLeft));

  // ---------- 1. dirty tracking ----------
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'networkidle' });

  check('save button starts clean', (await saveBtn.textContent()).trim() === 'Saved');
  check('save button starts disabled', await saveBtn.isDisabled());

  const card = page.locator('[data-eid="8"]');
  await card.click({ position: { x: 3, y: 3 } });
  await pickColor(panel, 'bg', 'emerald', '500');
  check('one edit → "Save 1 change"', (await saveBtn.textContent()).trim() === 'Save 1 change',
    await saveBtn.textContent());

  // move to a second element without saving — the first must stay marked
  const h1 = page.locator('[data-eid="6"]');
  await h1.click();
  // Assert the marker's *role* (a dashed outline distinct from the solid
  // selection ring), not its literal colour, so a restyle cannot break this.
  check('unsaved element keeps a dirty marker after deselect',
    /dashed/.test(await card.evaluate(el => el.style.outline)),
    await card.evaluate(el => el.style.outline));

  await pickColor(panel, 'text', 'indigo', '600');
  check('two edits → "Save 2 changes"', (await saveBtn.textContent()).trim() === 'Save 2 changes',
    await saveBtn.textContent());

  await saveBtn.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|changed/.test(el?.textContent || '');
  }, null, { timeout: 5000 });
  check('batch save reported success', (await status()).includes('written'), await status());
  check('button returns to clean', (await saveBtn.textContent()).trim() === 'Saved');

  const after = disk();
  check('BOTH elements were written in one request',
    /bg-emerald-500/.test(after) && /text-indigo-600/.test(after),
    after.split('\n').filter(l => /emerald|indigo/.test(l)).join(' // '));
  check('dirty marker cleared once saved',
    !/dashed/.test(await card.evaluate(el => el.style.outline || '')));

  // ---------- 3. stale hash ----------
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-eid="8"]').click({ position: { x: 3, y: 3 } });
  await pickColor(panel, 'bg', 'rose', '500');
  check('edit pending before the out-of-band change',
    (await saveBtn.textContent()).trim() === 'Save 1 change');

  // someone edits the file in their editor / a formatter runs / branch switch
  const beforeOOB = disk();
  fs.writeFileSync(INDEX, beforeOOB.replace('<footer', '<footer data-touched="1"'));
  const oob = disk();

  await saveBtn.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|changed/.test(el?.textContent || '');
  }, null, { timeout: 5000 });

  check('stale save was refused', (await status()).includes('changed on disk'), await status());
  check('the file was NOT overwritten', disk() === oob);
  check('the out-of-band edit survived', disk().includes('data-touched="1"'));
  // NB: bg-rose-500 already exists in the fixture (on the demo button), so this
  // must be scoped to the card's own line rather than the whole file.
  const cardLine = () => disk().split('\n').find(l => l.includes('rounded-xl')) || '';
  check('the pending colour did NOT reach the card on disk',
    !cardLine().includes('bg-rose-500'), cardLine().trim());
  check('pending edit is still pending, not silently dropped',
    (await saveBtn.textContent()).trim() === 'Save 1 change', await saveBtn.textContent());

  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
