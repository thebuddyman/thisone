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
  const minus = k => field(k).locator('[data-tw-step="down"]');
  const plus = k => field(k).locator('[data-tw-step="up"]');
  const read = async k => (await field(k).locator('input').inputValue()).trim() || '—';
  // computed, not inline: the panel is styled by a scoped stylesheet
  const style = async k => field(k).locator('input').evaluate(el => getComputedStyle(el).fontStyle);

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
    JSON.stringify(await shown()).includes('"p-x","p-y"') && !(await shown()).includes('p-t'),
    (await shown()).join(','));
  check('horizontal reads value inherited from p-4', (await read('p-x')) === '4');
  check('inherited value is rendered italic', (await style('p-x')) === 'italic');

  // the axis input writes px-*, touching only left and right
  await plus('p-x').click();
  check('horizontal stepped to 6', (await read('p-x')) === '6');
  check('horizontal is now explicit (upright)', (await style('p-x')) === 'normal');
  check('vertical still inherited from p-4', (await read('p-y')) === '4' && (await style('p-y')) === 'italic');
  check('only left/right changed', (await pad()) === '16px 24px 16px 24px', await pad());
  check('px-6 added, p-4 not evicted',
    /(?:^| )p-4(?: |$)/.test(await card.getAttribute('class')) &&
    /(?:^| )px-6(?: |$)/.test(await card.getAttribute('class')),
    await card.getAttribute('class'));

  // reveal the four edges
  await panel.locator('[data-tw-toggle="p"]').click();
  check('toggle reveals the four edges',
    (await shown()).includes('p-t') && !(await shown()).includes('p-x'), (await shown()).join(','));
  check('toggling wrote nothing', /(?:^| )p-4(?: |$)/.test(await card.getAttribute('class')));
  check('left inherits from the px-6 we just set',
    (await read('p-l')) === '6' && (await style('p-l')) === 'italic');

  // bump only the top
  await plus('p-t').click();
  check('T stepped to 6', (await read('p-t')) === '6');
  check('T is now explicit (upright)', (await style('p-t')) === 'normal');
  check('right still inherits from px-6', (await read('p-r')) === '6' && (await style('p-r')) === 'italic');
  check('only padding-top changed', (await pad()) === '24px 24px 16px 24px', await pad());
  check('pt-6 added alongside p-4 and px-6',
    /(?:^| )pt-6(?: |$)/.test(await card.getAttribute('class')),
    await card.getAttribute('class'));

  // per-side left/right/bottom are independent
  await plus('p-l').click(); await plus('p-l').click();
  await minus('p-b').click();
  check('L=12, B=2, T=6, R inherited 6',
    (await read('p-l')) === '12' && (await read('p-b')) === '2' && (await read('p-t')) === '6' && (await read('p-r')) === '6',
    [await read('p-l'), await read('p-b'), await read('p-t'), await read('p-r')].join('/'));
  check('computed box matches T R B L', (await pad()) === '24px 24px 8px 48px', await pad());

  // stepping below zero clears the override and falls back to inherited
  await minus('p-b').click();
  check('B stepped down to 0', (await read('p-b')) === '0');
  await minus('p-b').click();
  check('below zero cleared the pb override', (await read('p-b')) === '4' && (await style('p-b')) === 'italic');
  check('pb-* gone from class string', !/(?:^| )pb-/.test(await card.getAttribute('class')), await card.getAttribute('class'));
  check('computed bottom back to inherited 16px', (await pad()) === '24px 24px 16px 48px', await pad());

  // margin works the same and does not touch padding
  const marginBefore = await card.evaluate(el => getComputedStyle(el).marginTop);
  check('margin axes read 12, inherited from m-12', (await read('m-x')) === '12', marginBefore);
  check('margin toggles independently of padding', !(await shown()).includes('m-t'), (await shown()).join(','));
  await panel.locator('[data-tw-toggle="m"]').click();
  await minus('m-t').click();
  check('margin T explicit 8', (await read('m-t')) === '8');
  check('mt-8 applied, ml untouched at 12',
    (await card.evaluate(el => getComputedStyle(el).marginTop)) === '32px' &&
    (await card.evaluate(el => getComputedStyle(el).marginLeft)) === '48px');
  check('padding untouched by margin edits', (await pad()) === '24px 24px 16px 48px');

  // reads inherited values off px-*/py-* too
  await page.locator('[data-eid="9"]').evaluate(el => { el.className = 'text-2xl font-bold py-8 px-2'; });
  await page.locator('[data-eid="9"]').click({ position: { x: 3, y: 3 } });
  check('py-8 seen as inherited top/bottom', (await read('p-t')) === '8' && (await read('p-b')) === '8');
  check('px-2 seen as inherited left/right', (await read('p-l')) === '2' && (await read('p-r')) === '2');
  check('the axis inputs read their own classes explicitly',
    (await read('p-x')) === '2' && (await read('p-y')) === '8');
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
    /pt-6/.test(diskClasses) && /pl-12/.test(diskClasses) && /mt-8/.test(diskClasses) && !/pb-/.test(diskClasses));

  await page.reload({ waitUntil: 'networkidle' });
  const card2 = page.locator('[data-eid="8"]');
  const padAfter = await card2.evaluate(el => {
    const s = getComputedStyle(el);
    return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' ');
  });
  check('hard refresh preserves the per-side look', padAfter === '24px 24px 16px 48px', padAfter);

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
