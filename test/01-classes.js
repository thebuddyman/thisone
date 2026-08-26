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
