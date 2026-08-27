const { chromium } = require('playwright');
const fs = require('fs');

/**
 * Radius, laid out as frame 2:270 has it.
 *
 * The section is the all-corners field with a toggle beside it and the four
 * corners in a 2x2 grid underneath. What is being checked here is the seam
 * between the two: a corner that overrides the box, a box that clears the
 * corners, and the fields telling the truth about which of the two is winning.
 */
const INDEX = process.env.TW_EDITOR_FILE;
const BASE = process.env.TW_EDITOR_URL || 'http://localhost:3000';
if (!INDEX) { console.error('TW_EDITOR_FILE not set - run via `npm test`'); process.exit(2); }

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

const CORNERS = ['tl', 'tr', 'bl', 'br'];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') console.log('  [console error]', m.text()); });
  page.on('pageerror', e => { console.log('  [page error]', e.message); results.push(false); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.locator('[data-tw-mode]').click();

  const panel = page.locator('[data-tw-editor="panel"]');
  const row = panel.locator('[data-tw-field="radius"]');
  const grid = row.locator('.bw-pair');
  const toggle = panel.locator('[data-tw-toggle="radius"]');
  // The box is the fifth field, addressed exactly like the four: same shape,
  // same idiom, `all` where a corner names itself.
  const corner = c => panel.locator(`[data-tw-field="radius-${c}"] input`);
  const name = async () => (await corner('all').inputValue()).trim();
  const read = async c => (await corner(c).inputValue()).trim() || '—';
  const cls = async c => corner(c).getAttribute('class');
  const colour = c => corner(c).evaluate(el => getComputedStyle(el).color);
  // --bw-faint, #858585: what a value the element does not own is dimmed to.
  const FAINT = 'rgb(133, 133, 133)';

  const card = page.locator('[data-eid="8"]');   // bg-white rounded-xl shadow m-12 p-4
  const radii = () => card.evaluate(el => {
    const s = getComputedStyle(el);
    return [s.borderTopLeftRadius, s.borderTopRightRadius,
      s.borderBottomLeftRadius, s.borderBottomRightRadius].join(' ');
  });

  await card.click({ position: { x: 3, y: 3 } });
  check('the radius section is on show', await row.isVisible());
  check('the box field gives the radius as a length, like the corners do',
    (await name()) === '12', await name());
  check('folded by default — four corners agree, so two views would say one thing',
    (await grid.getAttribute('class')).includes('is-hidden'), await grid.getAttribute('class'));

  const folded = await row.boundingBox();
  check('folded, the section is a label over one 40px field',
    folded.width === 312 && folded.height === 69, `${folded.width}x${folded.height}`);

  // The frame had no Parts glyph for radius, so the toggle wore the
  // all-corners mark in both states and the pressed fill was the only thing
  // saying which it was in. ic-radius-parts.svg is that file: the boxed mark
  // while the row is one field, the four bare corners while it is four —
  // which is the swap padding and margin have always made. Told apart by the
  // box, because that is the whole difference between the two exports — the
  // drawn one at 2,2 and not the 20x20 rect every clipPath carries.
  const boxed = async () => /<rect x="2" y="2"/.test(await toggle.innerHTML());
  check('folded, the toggle wears the box with its corners', await boxed(),
    (await toggle.innerHTML()).slice(0, 140));

  await toggle.click();
  check('the toggle opens the four corners',
    !(await grid.getAttribute('class')).includes('is-hidden'));
  check('and says which state it is in', (await toggle.getAttribute('aria-pressed')) === 'true');
  check('…in its mark as well as its fill — open, the box is gone',
    !(await boxed()), (await toggle.innerHTML()).slice(0, 140));

  const open = await row.boundingBox();
  const one = await panel.locator('[data-tw-field="radius-tl"]').boundingBox();
  // Two columns of whatever the field above them is, halved: the field shares
  // its line with the 40px toggle, and the toggle pulls 10 of that back with
  // the negative margin that stands its mark on the gutter — so 270 across,
  // less the 12 between them, is 129 each.
  check('open, the grid is two 129px columns under the field',
    open.height === 173 && Math.round(one.width) === 129,
    `${open.width}x${open.height}, column ${Math.round(one.width)}`);

  const inherited = await Promise.all(CORNERS.map(read));
  check('every corner reads the box radius in pixels',
    inherited.every(v => v === '12'), inherited.join('/'));
  check('and reads it dimmed, because none of them owns it',
    (await Promise.all(CORNERS.map(colour))).every(c => c === FAINT));
  check('the corner tooltip names the class it came from',
    (await corner('tl').getAttribute('title')).includes('inherited from rounded-xl'),
    await corner('tl').getAttribute('title'));

  // ---- a corner overrides the box
  await corner('tl').fill('3');
  await corner('tl').press('Enter');
  check('a typed pixel value becomes an arbitrary corner class',
    /(?:^| )rounded-tl-\[3px\](?: |$)/.test(await card.getAttribute('class')),
    await card.getAttribute('class'));
  check('it previews instantly, and only on that corner',
    (await radii()) === '3px 12px 12px 12px', await radii());
  check('the other three still read 12', (await Promise.all(['tr', 'bl', 'br'].map(read))).join('/') === '12/12/12');
  check('the corner that IS set is not dimmed', (await colour('tl')) !== FAINT);
  check('a literal is italic and marked, the same as everywhere else',
    (await cls('tl')).includes('is-jit') &&
    await row.locator('[data-tw-field="radius-tl"] .bw-snow').isVisible(),
    await cls('tl'));

  // ---- and the box says so
  check('four corners that disagree are all four said in full, comma separated',
    (await name()) === '3, 12, 12, 12', await name());
  const mixed = await corner('all').getAttribute('title');
  check('and the tooltip says which is which',
    /top left 3/.test(mixed) && /top right 12/.test(mixed), mixed);
  check('tabbing through a comma list does not flatten it to the first value',
    await (async () => {
      await corner('all').focus();
      await corner('all').blur();
      return (await name()) === '3, 12, 12, 12';
    })(), await name());

  // ---- stepping: a pixel a press, ten with Shift held
  const nudge = async (key) => {
    await corner('tr').focus();
    await corner('tr').press(key);
    await corner('tr').blur();
  };
  await nudge('ArrowDown');
  const stepped = await read('tr');
  check('an arrow steps a corner down one pixel from where it renders',
    stepped === '11' && /rounded-tr-/.test(await card.getAttribute('class')),
    `${stepped} — ${await card.getAttribute('class')}`);
  await nudge('Shift+ArrowUp');
  check('Shift is ten of them', (await read('tr')) === '21', await read('tr'));
  await nudge('Shift+ArrowDown');
  check('…both ways', (await read('tr')) === '11', await read('tr'));

  let guard = 0;
  while ((await read('tr')) !== '0' && guard++ < 20) await nudge('ArrowDown');
  check('walked the corner down to 0', (await read('tr')) === '0', `after ${guard} steps`);
  await nudge('ArrowDown');
  check('below zero the override is dropped, not pinned there',
    !/rounded-tr-/.test(await card.getAttribute('class')), await card.getAttribute('class'));
  check('…and the corner falls back to the box radius, dimmed again',
    (await read('tr')) === '12' && (await colour('tr')) === FAINT, await read('tr'));

  // ---- the box clears what is beneath it
  await corner('all').click();   // focus so the chevron is on show
  await row.locator('[data-tw-radius-open]').click();
  await page.locator('[data-tw-radius="sm"]').click();
  const after = await card.getAttribute('class');
  check('picking a rung for the box writes it',
    /(?:^| )rounded-sm(?: |$)/.test(after) && !/rounded-xl/.test(after), after);
  check('and clears the corner that would have outranked it — the pick must not be a no-op',
    !/rounded-tl-/.test(after), after);
  const flat = await radii();
  check('all four corners now render the same', new Set(flat.split(' ')).size === 1, flat);
  check('the box field reads one length again', (await name()) === '4', await name());

  // The box is a field, not a label: one value typed there is all four.
  await corner('br').fill('9');
  await corner('br').press('Enter');
  check('a corner set again puts the box back into a comma list',
    (await name()) === '4, 4, 4, 9', await name());
  await corner('all').fill('16');
  await corner('all').press('Enter');
  check('typing one value into the box sets all four',
    (await name()) === '16' && !/rounded-br-/.test(await card.getAttribute('class')),
    `${await name()} — ${await card.getAttribute('class')}`);

  // ---- an element authored per-corner opens on its own
  await page.locator('[data-eid="9"]').evaluate(el => {
    el.className = 'bg-rose-500 p-4 rounded-lg rounded-br-[2px]';
  });
  await page.locator('[data-eid="9"]').click({ position: { x: 3, y: 3 } });
  check('an element wearing a per-corner class opens to the four corners',
    !(await grid.getAttribute('class')).includes('is-hidden'), await grid.getAttribute('class'));
  check('the authored corner reads its own value, the rest read the box',
    (await read('br')) === '2' && (await read('tl')) !== '2',
    `${await read('br')} vs ${await read('tl')}`);
  check('the toggle owns the view after that — collapsing it sticks',
    await (async () => {
      await toggle.click();
      await corner('tl').isVisible().catch(() => {});
      return (await grid.getAttribute('class')).includes('is-hidden');
    })(), await grid.getAttribute('class'));

  // ---- and it reaches disk
  // Not the corner: the card is wearing a 16px radius by now, and a click at
  // (3,3) lands outside the arc and on the <main> behind it.
  await card.click({ position: { x: 120, y: 6 } });
  await toggle.click();
  await corner('bl').fill('7');
  await corner('bl').press('Enter');
  await panel.locator('[data-tw-save]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed/.test(el?.textContent || '');
  }, null, { timeout: 5000 });

  const disk = fs.readFileSync(INDEX, 'utf8');
  // rounded-2xl: what the box was last set to, by typing 16 into it.
  const line = disk.split('\n').find(l => l.includes('rounded-2xl'));
  check('the corner class is on disk, beside the box rung',
    !!line && line.includes('rounded-bl-[7px]') && line.includes('rounded-2xl'),
    (line || '').trim());
  check('nothing else on the line moved',
    !!line && line.includes('shadow') && line.includes('m-12') && line.includes('p-4'),
    (line || '').trim());

  await page.screenshot({ path: `${__dirname}/radius.png` });
  await browser.close();

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
