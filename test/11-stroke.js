const { chromium } = require('playwright');
const fs = require('fs');

/**
 * Stroke, laid out as frame 7:687 has it.
 *
 * The section is a colour across the row with a tile beside it and style
 * sharing the line below with width. What is checked here is mostly the seam
 * `border-` makes: four families wear the one word — border-2 is a width,
 * border-solid a style, border-oat a colour, border-b-2 one edge — and each
 * has to be readable, writable and strippable without touching the other
 * three. `border-collapse` is in here too, because it wears the word and is
 * not a stroke at all.
 */
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
  page.on('pageerror', e => { console.log('  [page error]', e.message); results.push(false); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.locator('[data-tw-mode]').click();

  const panel = page.locator('[data-tw-editor="panel"]');
  const row = panel.locator('[data-tw-section="stroke"]');
  const reveal = panel.locator('[data-tw-reveal="stroke"]');
  const swatch = panel.locator('[data-tw-section="stroke"] .bw-cname').first();
  const style = panel.locator('[data-tw-field="strokeStyle"] .bw-cname');
  const width = panel.locator('[data-tw-field="strokeWidth"] input');
  const minus = panel.locator('[data-tw-stroke-none]');

  const card = page.locator('[data-eid="8"]'); // bg-white rounded-xl shadow m-12 p-4
  const cls = () => card.getAttribute('class');
  const drawn = () => card.evaluate(el => {
    const s = getComputedStyle(el);
    return [s.borderTopWidth, s.borderTopStyle, s.borderTopColor].join(' ');
  });
  // Re-select: clicking the element that is already selected is a no-op, so
  // the panel would go on describing the classes it had before. The header's
  // × and not Escape, because the caret is usually in one of these fields by
  // then and Escape belongs to the field it is in — it leaves the box rather
  // than dropping the selection, so the handle stays where it was.
  //
  // x=120 and not the corner: the delete handle for the live selection sits on
  // the element's top-left and swallows the click there. y=3 is inside the
  // card's own p-4, above anything it holds.
  const reselect = async (className) => {
    const close = panel.locator('.bw-h .bw-x');
    if (await close.isVisible()) await close.click();
    if (className !== undefined) await card.evaluate((el, c) => { el.className = c; }, className);
    await card.click({ position: { x: 120, y: 3 } });
  };

  await card.click({ position: { x: 120, y: 3 } });

  // ---- the row stands in for itself, in its own slot ----
  const order = () => page.evaluate(() => Array.from(
    document.querySelectorAll('[data-tw-editor="panel"] .bw-body > *'))
    .filter((n) => n.offsetParent)
    .map((n) => (n.querySelector('.bw-lbl') || {}).textContent || ''));

  check('an element with no stroke keeps the row, with a + in it',
    (await reveal.isVisible()) && !(await row.isVisible()));
  const before = await order();
  check('and the slot is directly after Radius — both describe the same edge',
    before.join(' > ').includes('Radius > Stroke > Typography'), before.join(' > '));

  // ---- revealing writes the one stroke every route can draw ----
  await reveal.click();
  check('revealing writes 1px solid black, all three said out loud',
    (await cls()) === 'bg-white rounded-xl shadow m-12 p-4 border border-solid border-black',
    await cls());
  check('…and the page draws it, on a route that has generated no such rule',
    (await drawn()) === '1px solid rgb(0, 0, 0)', await drawn());
  check('the fields read it back: black, Solid, 1',
    (await swatch.inputValue()) === 'black' &&
    (await style.textContent()) === 'Solid' &&
    (await width.inputValue()) === '1',
    [await swatch.inputValue(), await style.textContent(), await width.inputValue()].join(' / '));
  check('and the + row has gone, because the section it stood in for is there',
    (await row.isVisible()) && !(await reveal.isVisible()));

  // ---- style: a list of four, and picking one clears the last ----
  await panel.locator('[data-tw-stroke-style]').click();
  const pop = page.locator('[data-tw-pop]');
  check('the list offers the four that draw something, and no more',
    (await pop.locator('[data-tw-stroke]').count()) === 4,
    String(await pop.locator('[data-tw-stroke]').count()));
  check('with the one that is set marked as current',
    (await pop.locator('[data-tw-stroke="solid"]').getAttribute('aria-current')) === 'true');
  await pop.locator('[data-tw-stroke="dashed"]').click();
  check('picking one clears the last — two styles cannot both be the style',
    (await cls()).includes('border-dashed') && !(await cls()).includes('border-solid'),
    await cls());
  check('…and the width beside it is untouched',
    (await cls()).split(/\s+/).includes('border'), await cls());
  check('the page draws the new style',
    (await drawn()) === '1px dashed rgb(0, 0, 0)', await drawn());

  // ---- width: pixels typed, a rung written, a literal marked ----
  await width.fill('2');
  await width.press('Enter');
  check('a rung is written as the rung, and clears the bare border',
    (await cls()).includes('border-2') && !(await cls()).split(/\s+/).includes('border'),
    await cls());
  await width.fill('3');
  await width.press('Enter');
  check('a length with no rung behind it goes arbitrary',
    (await cls()).includes('border-[3px]') && !(await cls()).includes('border-2'),
    await cls());
  check('…and is marked a literal, italic and snowflaked from the one condition',
    (await width.getAttribute('class')).includes('is-jit') &&
    (await panel.locator('[data-tw-field="strokeWidth"] .bw-snow').isVisible()));
  check('the page draws it — Tailwind generated nothing for this one',
    (await drawn()) === '3px dashed rgb(0, 0, 0)', await drawn());

  // ---- the arrows count pixels, and step off the bottom ----
  await width.focus();
  await width.press('ArrowDown');
  check('an arrow steps the width down one pixel',
    (await width.inputValue()) === '2', await width.inputValue());
  await width.press('ArrowDown');
  check('…and again', (await width.inputValue()) === '1', await width.inputValue());
  check('1 is written `border`, the bare utility these codebases actually use',
    (await cls()).split(/\s+/).includes('border'), await cls());
  await width.press('ArrowUp');
  check('up from the bare border is 2, written as the rung and not border-1',
    (await cls()).includes('border-2') && !(await cls()).split(/\s+/).includes('border'),
    await cls());
  await width.press('Shift+ArrowUp');
  check('Shift is ten of them, and a width off the rungs goes arbitrary',
    (await width.inputValue()) === '12' && (await cls()).includes('border-[12px]'),
    `${await width.inputValue()} — ${await cls()}`);
  await width.press('Shift+ArrowDown');
  check('…and back down again', (await width.inputValue()) === '2', await width.inputValue());
  // Ten below 2 is not a reason to lose the stroke: the leap stops at zero,
  // and pressing again on that zero is what takes the class off.
  await width.press('Shift+ArrowDown');
  check('a leap that would go under zero stops at zero',
    (await width.inputValue()) === '0' && (await cls()).includes('border-0'),
    `${await width.inputValue()} — ${await cls()}`);
  await width.press('ArrowDown');
  check('…and pressing again on that zero drops the width class',
    !/(?:^| )border(?:-0|-\[)?(?: |$)/.test(await cls()), await cls());
  await width.press('ArrowUp');
  check('and up from nothing is 1 again', (await cls()).split(/\s+/).includes('border'), await cls());

  // ---- a box colour takes the edge with it ----
  await reselect('bg-white rounded-xl shadow m-12 p-4 border border-b-red-500');
  check('a per-side colour shows the section by itself',
    await row.isVisible());
  await panel.locator('[data-tw-color-open="border"]').click();
  // The stroke's colour is the same object the two colour rows are, box and
  // all — not just the same field. The width test used to name bg and text
  // only, so `border` reached the colour body and opened it at a list's 220
  // with the eleven-square grid built for 322 spilling out the side. Measured
  // against text's own popover rather than against 322, because the number is
  // the grid's and either could move.
  const popBox = async () => pop.evaluate((e) => {
    const g = e.querySelector('.bw-swatches');
    return {
      w: Math.round(e.getBoundingClientRect().width),
      sw: Math.round(e.querySelector('.bw-swatch').getBoundingClientRect().width),
      cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      picker: !!e.querySelector('.bw-sv'),
      overflows: g.scrollWidth > g.clientWidth,
    };
  });
  const strokePop = await popBox();
  await page.keyboard.press('Escape');
  const textReveal = panel.locator('[data-tw-reveal="text"]');
  if (await textReveal.isVisible()) await textReveal.click();
  await panel.locator('[data-tw-color-open="text"]').click();
  const textPop = await popBox();
  check('the stroke opens the same colour dropdown the text row does',
    JSON.stringify(strokePop) === JSON.stringify(textPop),
    `stroke ${JSON.stringify(strokePop)} vs text ${JSON.stringify(textPop)}`);
  check('and its swatch grid is not clipped by the box around it',
    strokePop.picker && !strokePop.overflows && strokePop.cols === 11,
    JSON.stringify(strokePop));
  await page.keyboard.press('Escape');

  await panel.locator('[data-tw-color-open="border"]').click();
  await pop.locator('[data-tw-hue="emerald"]').click();
  await page.locator('[data-tw-pop-shade] [data-tw-shade="500"]').click();
  check('writing the box colour clears the edge, or one side would disagree',
    (await cls()).includes('border-emerald-500') && !(await cls()).includes('border-b-red-500'),
    await cls());

  // ---- the word is worn by things that are not strokes ----
  await reselect('bg-white rounded-xl shadow m-12 p-4 border-collapse');
  check('border-collapse is not a stroke, and offers a + like any unset row',
    (await reveal.isVisible()) && !(await row.isVisible()), await cls());

  // ---- the tile removes the stroke, not one part of it ----
  await reselect('bg-white rounded-xl shadow m-12 p-4 border-2 border-dotted border-black');
  check('an authored stroke shows without being revealed', await row.isVisible());
  check('and reads all three back',
    (await swatch.inputValue()) === 'black' &&
    (await style.textContent()) === 'Dotted' &&
    (await width.inputValue()) === '2',
    [await swatch.inputValue(), await style.textContent(), await width.inputValue()].join(' / '));
  await minus.click();
  check('the minus takes the whole stroke — colour, style and width together',
    (await cls()) === 'bg-white rounded-xl shadow m-12 p-4', await cls());
  check('…and the row folds back to the + that offers it again',
    (await reveal.isVisible()) && !(await row.isVisible()));

  // ---- and it reaches disk ----
  await reveal.click();
  await width.fill('4');
  await width.press('Enter');
  await panel.locator('[data-tw-save]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed/.test(el?.textContent || '');
  }, null, { timeout: 5000 });

  const disk = fs.readFileSync(INDEX, 'utf8');
  const line = disk.split('\n').find(l => l.includes('border-4'));
  check('the three classes are on disk together',
    !!line && line.includes('border-solid') && line.includes('border-black'),
    (line || '').trim());
  check('nothing else on the line moved',
    !!line && line.includes('shadow') && line.includes('m-12') && line.includes('p-4'),
    (line || '').trim());

  await page.screenshot({ path: `${__dirname}/stroke.png` });
  await browser.close();

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
