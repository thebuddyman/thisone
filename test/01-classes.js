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
/**
 * Resolve any CSS colour to plain RGB by painting it. Comparing serialised
 * strings is a trap: the same colour arrives as rgb(), oklch() or lab()
 * depending on where it came from.
 */
const rgb = (page, sel) => page.evaluate((s) => {
  const px = (css) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const x = cv.getContext('2d'); x.fillStyle = css; x.fillRect(0, 0, 1, 1);
    return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
  };
  // Reference comes from a probe wearing the class, so this holds regardless
  // of which Tailwind version the page loaded.
  const probe = document.createElement('div');
  probe.className = 'bg-emerald-500';
  probe.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(probe);
  const emerald = px(getComputedStyle(probe).backgroundColor);
  probe.remove();
  return { bg: px(getComputedStyle(document.querySelector(s)).backgroundColor), emerald };
}, sel);

/** Pick a Tailwind colour through the popover: open → hue → shade. */
async function pickColor(panel, prefix, hue, shade) {
  // A colour that is not set stands in for itself with a + row, so open it the
  // way a user would before reaching for the field.
  const reveal = panel.locator(`[data-tw-reveal="${prefix}"]`);
  if (await reveal.isVisible()) await reveal.click();
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
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') console.log('  [console error]', m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // The editor is off until it is asked for: nothing is selectable, and the
  // page's own clicks are its own, until edit mode is on.
  await page.locator('[data-tw-mode]').click();

  const card = page.locator('[data-eid="8"]');

  // Tailwind actually applied? (proves Play CDN is live)
  const bgBefore = await card.evaluate(el => getComputedStyle(el).backgroundColor);
  check('Tailwind CDN applied bg-white to card', bgBefore === 'rgb(255, 255, 255)', bgBefore);

  // hover highlights via inline outline, not classes
  const classBeforeHover = await card.getAttribute('class');
  await card.hover({ position: { x: 4, y: 4 } });
  const hoverOutline = await card.evaluate(el => el.style.outline);
  check('hover sets inline outline', /dashed/.test(hoverOutline), hoverOutline);
  check('hover did not touch class', (await card.getAttribute('class')) === classBeforeHover);

  // click the card's padding area (top-left corner), not a child
  await card.click({ position: { x: 4, y: 4 } });
  const panel = page.locator('[data-tw-editor="panel"]');
  check('panel visible after click', await panel.isVisible());
  const title = await panel.locator('strong').first().textContent();
  check('panel targets the card', title.includes('<div>') && title.includes('#8'), title);
  check('selection outline is solid', /solid/.test(await card.evaluate(el => el.style.outline)));

  // The panel is collapsed by default, so the horizontal axis is what is on
  // screen; it inherits its starting value from the card's p-4.
  const padPlus = { click: () => step(panel, 'p-x', 'up') };
  const padReadout = panel.locator('[data-tw-field="p-x"] input');
  // The field is in pixels, so p-4 reads as the 16 it renders.
  const v0 = await padReadout.inputValue();
  check('horizontal padding reads the 16px that p-4 renders', v0 === '16', v0);

  // bump horizontal twice; the ladder decides where it lands, not this test
  await padPlus.click();
  const v1 = await padReadout.inputValue();
  check('stepped up a rung', Number(v1) > Number(v0), `${v0} → ${v1}`);
  await padPlus.click();
  const v2 = await padReadout.inputValue();
  check('stepped up another', Number(v2) > Number(v1), `${v1} → ${v2}`);

  const padPx = await card.evaluate(el => {
    const c = getComputedStyle(el);
    return c.paddingLeft + '/' + c.paddingTop;
  });
  check('instant preview: horizontal grew, vertical untouched',
    padPx === `${v2}px/16px`, padPx);

  // emerald swatch on the Background row
  await pickColor(panel, 'bg', 'emerald', '500');
  const after = await rgb(page, '[data-eid="8"]');
  check('bg colour applied instantly', after.bg === after.emerald, `${after.bg} vs emerald ${after.emerald}`);

  // ---- the colour field, frame 4:551 ----
  //
  // A 20x20 swatch on the 12px gutter with the name 8px after it, so the value
  // starts at 40 — the same place a spacing field's does behind its 20px mark.
  //
  // The hex check below rewrites the card's classes to get an arbitrary colour
  // on screen, so the string it arrives with is put back verbatim afterwards —
  // the rest of this suite goes on to save it and read it off disk.
  const beforeColour = await card.getAttribute('class');
  const swatch = await page.evaluate(() => {
    const r = document.querySelector('[data-tw-editor="panel"] [data-tw-field="bgColor"]');
    const f = r.querySelector('.bw-field').getBoundingClientRect();
    const chip = r.querySelector('.bw-chip').getBoundingClientRect();
    const name = r.querySelector('.bw-cname').getBoundingClientRect();
    const snow = r.querySelector('.bw-snow');
    return {
      x: Math.round(chip.left - f.left), w: Math.round(chip.width), h: Math.round(chip.height),
      radius: getComputedStyle(r.querySelector('.bw-chip')).borderRadius,
      name: Math.round(name.left - f.left),
      snow: !!(snow && snow.offsetParent),
      italic: getComputedStyle(r.querySelector('.bw-cname')).fontStyle === 'italic',
    };
  });
  check('the swatch is 20x20 with a 3px radius, 12px in',
    swatch.x === 12 && swatch.w === 20 && swatch.h === 20 && swatch.radius === '3px',
    `${swatch.x}: ${swatch.w}x${swatch.h} r${swatch.radius}`);
  check('and the name starts at 40', swatch.name === 40, swatch.name);
  check('a token colour is neither snowflaked nor italic',
    !swatch.snow && !swatch.italic, JSON.stringify(swatch));

  // The chevron is an affordance, not information: hidden until the cursor is
  // on the field, kept on every field that opens a list.
  await panel.locator('[data-tw-field="bgColor"] .bw-field').hover();
  check('the chevron comes back on hover',
    (await page.evaluate(() => getComputedStyle(document.querySelector(
      '[data-tw-editor="panel"] [data-tw-field="bgColor"] .bw-chev')).opacity)) === '1');

  // An arbitrary colour is a literal, exactly as p-[13px] is, and this was the
  // one field in the panel that did not say so.
  await card.evaluate((el) => { el.className = 'bg-[#ffdb25] p-4'; });
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });
  const jit = await page.evaluate(() => {
    const r = document.querySelector('[data-tw-editor="panel"] [data-tw-field="bgColor"]');
    const snow = r.querySelector('.bw-snow');
    return {
      text: r.querySelector('.bw-cname').textContent.trim(),
      snow: !!(snow && snow.offsetParent),
      italic: getComputedStyle(r.querySelector('.bw-cname')).fontStyle === 'italic',
    };
  });
  check('a hex colour carries the snowflake, and is italic with it',
    jit.snow && jit.italic && /^#/.test(jit.text), JSON.stringify(jit));

  // ---- a colour the element paints on itself with a style attribute ----
  //
  // 714 elements in uiux_experiment carry a `style` prop and 263 of them set a
  // colour, so this is an idiom rather than an edge. There is nothing in the
  // class list to read, and an inline declaration outranks every class — so
  // the panel shows what is painted and refuses to write over it, rather than
  // calling the element unset and offering a + for a colour plainly on screen.
  await card.evaluate((el) => {
    el.className = 'p-4';
    el.style.color = 'rgb(255, 136, 0)';
  });
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });
  const inline = await page.evaluate(() => {
    const p = document.querySelector('[data-tw-editor="panel"]');
    const row = p.querySelector('[data-tw-field="textColor"]');
    return {
      shown: !!row.offsetParent,
      offered: !!p.querySelector('[data-tw-reveal="text"]').offsetParent,
      text: row.querySelector('.bw-cname').textContent.trim(),
      swatch: getComputedStyle(row.querySelector('.bw-chip')).backgroundColor,
      locked: p.querySelector('[data-tw-color-open="text"]').disabled,
    };
  });
  check('an inline colour is read, not called unset',
    inline.shown && !inline.offered && inline.text === '#FF8800',
    JSON.stringify(inline));
  check('and its swatch shows the colour that is actually painted',
    inline.swatch === 'rgb(255, 136, 0)', inline.swatch);
  check('the field refuses rather than writing a class an inline style outranks',
    inline.locked);

  // ---- what you can do to a colour lives in the list, not in the field ----
  //
  // A control beside the value that appears under the cursor reads as "delete
  // this" whatever its icon says, and removing a colour had no home at all —
  // the palette could only put one on, which since a revealed row starts at
  // white meant a colour you could add and not take off.
  await card.evaluate((el) => { el.style.color = ''; el.className = 'bg-white p-4'; });
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });
  check('the field carries no control of its own',
    (await panel.locator('.bw-detach').count()) === 0);

  await panel.locator('[data-tw-color-open="bg"]').click();
  check('the list names both things you can do to a colour that is set',
    (await page.locator('[data-tw-pop] .bw-pop-act').allTextContents())
      .join(' | ') === 'Detach to a hex | Remove background',
    (await page.locator('[data-tw-pop] .bw-pop-act').allTextContents()).join(' | '));

  await page.locator('[data-tw-color-none="bg"]').click();
  check('removing takes the class off and nothing else',
    (await card.getAttribute('class')) === 'p-4', await card.getAttribute('class'));
  check('and the element goes back to painting nothing',
    (await card.evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgba(0, 0, 0, 0)');
  // The row would otherwise have nothing to show, fold back to its + and take
  // the field out from under the cursor that just used it — and that + writes
  // white, so the way back to picking would be to add a colour first.
  check('the row stays open to pick again, rather than folding to its +',
    (await panel.locator('[data-tw-color-open="bg"]').isVisible()) &&
    !(await panel.locator('[data-tw-reveal="bg"]').isVisible()));

  await card.evaluate((el, cls) => { el.style.color = ''; el.className = cls; }, beforeColour);
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });

  const live = await card.getAttribute('class');
  check('old bg-white stripped, no duplicates',
    !live.includes('bg-white') && live.includes('bg-emerald-500') && /(?:^| )px-[\d.]+(?: |$)/.test(live), live);
  check('unrelated classes preserved',
    live.includes('rounded-xl') && live.includes('shadow') && live.includes('m-12') && live.includes('p-4'), live);

  // Save
  await panel.locator('[data-tw-save]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed/.test(el?.textContent || '');
  }, null, { timeout: 5000 });
  const status = await panel.locator('[data-tw-status]').textContent();
  check('save reported success', status.includes('written'), status);

  const disk = fs.readFileSync(INDEX, 'utf8');
  const diskCard = disk.split('\n').find(l => l.includes('rounded-xl'));
  check('index.html on disk has new classes',
    diskCard.includes('bg-emerald-500') && /px-[\d.]+/.test(diskCard), diskCard.trim());
  check('no data-eid written to disk', !disk.includes('data-eid'));
  check('no editor script written to disk', !disk.includes('/editor.js'));

  // Escape deselects
  await page.keyboard.press('Escape');
  // The panel outlives the selection now — only its body folds away.
  check('escape drops the selection', (await panel.getAttribute('data-tw-idle')) !== null);
  check('…and leaves the button bar behind', await panel.locator('[data-tw-save]').isVisible());
  // Park the cursor away from the card first. Deselecting does not stop hover
  // highlighting, so leaving the mouse on the element lets the next mouse event
  // re-apply the hover outline — which raced this assertion about 1 run in 10.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(50);
  check('escape restores clean style attr',
    (await card.evaluate(el => el.getAttribute('style'))) === null,
    JSON.stringify(await card.evaluate(el => el.getAttribute('style'))));

  // hard refresh preserves the look
  await page.reload({ waitUntil: 'networkidle' });
  const card2 = page.locator('[data-eid="8"]');
  const padReload = await card2.evaluate(el => getComputedStyle(el).paddingLeft);
  const reloaded = await rgb(page, '[data-eid="8"]');
  check('after hard refresh: bg persists', reloaded.bg === reloaded.emerald,
    `${reloaded.bg} vs emerald ${reloaded.emerald}`);
  check('after hard refresh: padding persists', padReload === `${v2}px`, padReload);

  await page.screenshot({ path: `${__dirname}/after.png`, fullPage: true });
  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
