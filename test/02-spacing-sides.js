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
const INDEX = process.env.TW_EDITOR_FILE;
const BASE = process.env.TW_EDITOR_URL || 'http://localhost:3000';
if (!INDEX) { console.error('TW_EDITOR_FILE not set - run via `npm test`'); process.exit(2); }

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') console.log('  [console error]', m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // The editor is off until it is asked for: nothing is selectable, and the
  // page's own clicks are its own, until edit mode is on.
  await page.locator('[data-tw-mode]').click();

  const panel = page.locator('[data-tw-editor="panel"]');
  const field = k => panel.locator(`[data-tw-field="${k}"]`);
  // Address the spinner by role, not DOM order — position changed once already.
  const minus = k => ({ click: () => step(panel, k, 'down') });
  const plus = k => ({ click: () => step(panel, k, 'up') });
  const read = async k => (await field(k).locator('input').inputValue()).trim() || '—';
  // computed, not inline: the panel is styled by a scoped stylesheet
  const style = async k => field(k).locator('input').evaluate(el => getComputedStyle(el).fontStyle);

  // The ladder, read out of the panel's own dropdown rather than written down
  // here — it has moved once already and every number below follows from it.
  await page.locator('[data-eid="8"]').click({ position: { x: 3, y: 3 } });
  await field('p-x').locator('[data-tw-spacing-open]').click();
  // Read as the panel shows them — pixel lengths, not scale numbers.
  const RUNGS = await page.locator('[data-tw-spacing] .bw-sizename').allTextContents();
  await page.locator('[data-tw-pop] .bw-x').click();
  // Deselect before the suite's own first click: a live selection puts the
  // delete handle on the card's corner, and it dodges the tall panel onto
  // exactly the spot the click below aims at.
  await page.keyboard.press('Escape');
  check('the dropdown offers a ladder of pixel values',
    RUNGS.length > 4 && RUNGS.every(v => /^\d+px$/.test(v)), RUNGS.join(','));
  // The dropdown spells the unit out; the panel's own fields do not.
  const LADDER = RUNGS.map(v => v.replace('px', ''));
  const next = (v, d = 1) =>
    LADDER[Math.max(0, Math.min(LADDER.length - 1, LADDER.indexOf(v) + d))];
  const prev = (v) => next(v, -1);
  // The field speaks the same language the box model does, so these compare directly.
  const px = (v) => v + 'px';
  /** Step a field and assert it landed on the neighbouring rung. */
  const stepped = async (k, dir, label) => {
    const before = await read(k);
    await (dir === 'up' ? plus(k) : minus(k)).click();
    const after = await read(k);
    const want = String(dir === 'up' ? next(before) : prev(before));
    check(label, after === want, `${before} → ${after} (expected ${want})`);
    return after;
  };

  const card = page.locator('[data-eid="8"]');
  const pad = async () => card.evaluate(el => {
    const s = getComputedStyle(el);
    return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' ');
  });

  // start state on disk: bg-white rounded-xl shadow m-12 p-4
  await card.click({ position: { x: 3, y: 3 } });
  check('panel opened on the card', await panel.isVisible());
  // collapsed by default: two axis inputs, both inheriting from p-4
  const shown = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-tw-editor] [data-tw-field]')]
      .filter(e => e.offsetParent !== null).map(e => e.getAttribute('data-tw-field')));
  check('collapsed shows the two axes, not the four edges',
    JSON.stringify(await shown()).includes('"p-y","p-x"') && !(await shown()).includes('p-t'),
    (await shown()).join(','));
  check('horizontal reads the value inherited from p-4', (await read('p-x')) === '16',
    await read('p-x'));
  check('inherited value is rendered italic', (await style('p-x')) === 'italic');

  // the axis input writes px-*, touching only left and right
  const hx = await stepped('p-x', 'up', 'horizontal stepped one rung');
  check('horizontal is now explicit (upright)', (await style('p-x')) === 'normal');
  check('vertical still inherited from p-4', (await read('p-y')) === '16' && (await style('p-y')) === 'italic');
  check('only left/right changed',
    (await pad()) === `16px ${px(hx)} 16px ${px(hx)}`, await pad());
  check('the axis class was added, p-4 not evicted',
    /(?:^| )p-4(?: |$)/.test(await card.getAttribute('class')) &&
    /(?:^| )px-[\d.]+(?: |$)/.test(await card.getAttribute('class')),
    await card.getAttribute('class'));

  // reveal the four edges
  await panel.locator('[data-tw-toggle="p"]').click();
  check('toggle reveals the four edges',
    (await shown()).includes('p-t') && !(await shown()).includes('p-x'), (await shown()).join(','));
  check('toggling wrote nothing', /(?:^| )p-4(?: |$)/.test(await card.getAttribute('class')));
  check('left inherits from the axis class we just set',
    (await read('p-l')) === hx && (await style('p-l')) === 'italic');

  // bump only the top
  const pt = await stepped('p-t', 'up', 'T stepped one rung');
  check('T is now explicit (upright)', (await style('p-t')) === 'normal');
  check('right still inherits from the axis', (await read('p-r')) === hx && (await style('p-r')) === 'italic');
  check('only padding-top changed',
    (await pad()) === `${px(pt)} ${px(hx)} 16px ${px(hx)}`, await pad());
  check('the per-side class was added alongside p-4 and the axis',
    /(?:^| )pt-[\d.]+(?: |$)/.test(await card.getAttribute('class')),
    await card.getAttribute('class'));

  // per-side left/right/bottom are independent
  await stepped('p-l', 'up', 'L stepped one rung');
  const pl = await stepped('p-l', 'up', 'L stepped a second rung');
  const pb = await stepped('p-b', 'down', 'B stepped down one rung');
  check('each edge holds its own value, R still inherited',
    (await read('p-t')) === pt && (await read('p-r')) === hx,
    [await read('p-l'), await read('p-b'), await read('p-t'), await read('p-r')].join('/'));
  check('computed box matches T R B L',
    (await pad()) === `${px(pt)} ${px(hx)} ${px(pb)} ${px(pl)}`, await pad());

  // stepping below zero clears the override and falls back to inherited
  // Walk it down to zero, then once more: below zero drops the class.
  // Bounded: an unbounded wait on a value that never arrives hangs the whole
  // run instead of failing, which is exactly what a units mismatch did here.
  let guard = 0;
  while ((await read('p-b')) !== '0' && guard++ < 30) await minus('p-b').click();
  check('B walked down to 0', (await read('p-b')) === '0', `${await read('p-b')} after ${guard} steps`);
  await minus('p-b').click();
  check('below zero cleared the pb override',
    (await read('p-b')) === '16' && (await style('p-b')) === 'italic', await read('p-b'));
  check('pb-* gone from class string', !/(?:^| )pb-/.test(await card.getAttribute('class')), await card.getAttribute('class'));
  check('computed bottom back to inherited 16px',
    (await pad()) === `${px(pt)} ${px(hx)} 16px ${px(pl)}`, await pad());

  // margin works the same and does not touch padding
  const marginBefore = await card.evaluate(el => getComputedStyle(el).marginTop);
  check('margin axes read 48px, inherited from m-12', (await read('m-x')) === '48', await read('m-x'));
  check('margin toggles independently of padding', !(await shown()).includes('m-t'), (await shown()).join(','));
  await panel.locator('[data-tw-toggle="m"]').click();
  const mt = await stepped('m-t', 'down', 'margin T stepped down one rung');
  check('the margin class applied, the left edge untouched at 12',
    (await card.evaluate(el => getComputedStyle(el).marginTop)) === px(mt) &&
    (await card.evaluate(el => getComputedStyle(el).marginLeft)) === '48px',
    `top ${await card.evaluate(el => getComputedStyle(el).marginTop)}, ` +
    `left ${await card.evaluate(el => getComputedStyle(el).marginLeft)}`);
  check('padding untouched by margin edits',
    (await pad()) === `${px(pt)} ${px(hx)} 16px ${px(pl)}`, await pad());

  // reads inherited values off px-*/py-* too
  await page.locator('[data-eid="9"]').evaluate(el => { el.className = 'text-2xl font-bold py-8 px-2'; });
  await page.locator('[data-eid="9"]').click({ position: { x: 3, y: 3 } });
  check('py-8 seen as inherited top/bottom',
    (await read('p-t')) === '32' && (await read('p-b')) === '32',
    [await read('p-t'), await read('p-b')].join('/'));
  check('px-2 seen as inherited left/right',
    (await read('p-l')) === '8' && (await read('p-r')) === '8',
    [await read('p-l'), await read('p-r')].join('/'));
  check('the axis inputs read their own classes explicitly',
    (await read('p-x')) === '8' && (await read('p-y')) === '32');
  await page.keyboard.press('Escape');

  // save the card and confirm the round trip
  await card.click({ position: { x: 3, y: 3 } });
  const live = await card.getAttribute('class');
  await panel.locator('[data-tw-save]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed/.test(el?.textContent || '');
  }, null, { timeout: 5000 });
  check('save reported success', (await panel.locator('[data-tw-status]').textContent()).includes('written'));

  const diskLine = fs.readFileSync(INDEX, 'utf8').split('\n').find(l => l.includes('rounded-xl'));
  const diskClasses = diskLine.match(/class="([^"]*)"/)[1];
  check('disk class string matches the live one', diskClasses === live, diskClasses);
  check('disk has the per-side classes',
    /pt-[\d.]+/.test(diskClasses) && /pl-[\d.]+/.test(diskClasses) &&
    /mt-[\d.]+/.test(diskClasses) && !/pb-/.test(diskClasses), diskClasses);

  await page.reload({ waitUntil: 'networkidle' });
  const card2 = page.locator('[data-eid="8"]');
  const padAfter = await card2.evaluate(el => {
    const s = getComputedStyle(el);
    return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' ');
  });
  check('hard refresh preserves the per-side look',
    padAfter === `${px(pt)} ${px(hx)} 16px ${px(pl)}`, padAfter);

  // ---- every field icon sits on its field's vertical centre ----
  //
  // A 20px icon in a 40px field that stretches its children lands flush at the
  // top unless it asks for the centre itself. The dropdowns were fine because
  // their button centres them; the steppers were not.
  await card2.click({ position: { x: 3, y: 3 } });
  const offCentre = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('[data-tw-editor="panel"] .bw-field').forEach((f) => {
      const ico = f.querySelector('.bw-ico');
      if (!ico) return;
      const fr = f.getBoundingClientRect(), ir = ico.getBoundingClientRect();
      if (!fr.height) return; // a row that is folded away
      const top = ir.top - fr.top, bottom = fr.bottom - ir.bottom;
      if (Math.abs(top - bottom) > 1) {
        bad.push(`${f.closest('[data-tw-field]')?.getAttribute('data-tw-field')} ${top}/${bottom}`);
      }
    });
    return bad;
  });
  check('every field icon is centred in its field', offCentre.length === 0, offCentre.join(', '));

  // ---- a folded axis speaks for both of its edges ----
  //
  // A py-* lookup cannot see pt-*/pb-*, so an element written per-side used to
  // show nothing at all in the folded view.
  const h2b = page.locator('[data-eid="9"]');
  await h2b.evaluate(el => { el.className = 'text-2xl font-bold pt-5 pb-2 pl-6 pr-6'; });
  await h2b.click({ position: { x: 3, y: 3 } });
  check('uneven edges open the four-edge view by themselves',
    (await shown()).includes('p-t'), (await shown()).join(','));

  await panel.locator('[data-tw-toggle="p"]').click();
  check('folding by hand is respected', (await shown()).includes('p-y'), (await shown()).join(','));
  check('vertical reads before horizontal',
    (await shown()).join(',').indexOf('p-y') < (await shown()).join(',').indexOf('p-x'),
    (await shown()).join(','));
  check('an axis whose edges disagree shows both, comma separated',
    (await read('p-y')) === '20, 8', await read('p-y'));
  check('an axis whose edges agree shows the one value',
    (await read('p-x')) === '24', await read('p-x'));

  // The bug: any refresh used to re-run the auto-open rule and snap the view
  // back to the four edges mid-edit.
  const hxIn = field('p-x').locator('input');
  await hxIn.fill('32');
  await hxIn.press('Enter');
  await page.waitForTimeout(150);
  check('typing into a folded axis leaves it folded',
    (await shown()).includes('p-x') && !(await shown()).includes('p-t'), (await shown()).join(','));
  check('and the typed value went to both edges',
    (await h2b.evaluate(el => getComputedStyle(el).paddingLeft)) === '32px' &&
    (await h2b.evaluate(el => getComputedStyle(el).paddingRight)) === '32px',
    await h2b.evaluate(el => getComputedStyle(el).paddingLeft + '/' + getComputedStyle(el).paddingRight));
  await page.keyboard.press('Escape');

  // ---- an unset side reads 0, not a dash ----
  //
  // On a fresh element: by this point the card has had every side set by hand.
  await page.locator('[data-eid="6"]').click();

  //
  // Padding and margin are not inherited and preflight zeroes the browser's
  // defaults, so "no class" renders zero — and a field that knows the answer
  // should say it rather than showing an empty box.
  const zeros = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-tw-editor="panel"] [data-tw-field]').forEach((r) => {
      const i = r.querySelector('input.bw-val');
      if (!i || !r.getBoundingClientRect().height) return;
      out.push({ field: r.getAttribute('data-tw-field'), value: i.value,
                 unset: i.className.includes('is-unset'), title: i.title });
    });
    return out;
  });
  const unset = zeros.filter((z) => z.unset);
  check('there is an unset side to look at', unset.length > 0, `${unset.length} of ${zeros.length}`);
  check('every unset side that renders zero shows 0',
    unset.every((z) => (/renders 0/.test(z.title) ? z.value === '0' : true)),
    unset.map((z) => `${z.field}=${JSON.stringify(z.value)}`).join(' '));
  check('and shows it greyed, so it still reads as unset',
    unset.every((z) => z.unset));
  check('a side that IS set is not greyed',
    zeros.filter((z) => !z.unset).every((z) => z.value !== ''),
    zeros.filter((z) => !z.unset).map((z) => `${z.field}=${z.value}`).join(' '));

  await card2.click({ position: { x: 3, y: 3 } });

  await page.screenshot({ path: `${__dirname}/sides.png` });
  await browser.close();

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
