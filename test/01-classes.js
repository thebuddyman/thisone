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
  // Both float on <body>, not inside the panel — and they are two boxes now,
  // so the grid never has to be stepped back to: it is on screen the whole
  // time, and the ramp opens beside it.
  const pop = panel.page().locator('[data-tw-pop]');
  const shades = panel.page().locator('[data-tw-pop-shade]');
  await pop.locator(`[data-tw-hue="${hue}"]`).click();
  await shades.locator(`[data-tw-shade="${shade}"]`).click();
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

  // bump horizontal twice — a press is a pixel, on a field printing pixels
  await padPlus.click();
  const v1 = await padReadout.inputValue();
  check('stepped up a pixel', Number(v1) === Number(v0) + 1, `${v0} → ${v1}`);
  await padPlus.click();
  const v2 = await padReadout.inputValue();
  check('stepped up another', Number(v2) === Number(v1) + 1, `${v1} → ${v2}`);

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

  // ---- what the row carries beside the value, frames 7:620 and 7:622 ----
  //
  // The unlink in the field's right-hand slot and the minus in the tile beside
  // it, both on screen the whole time. They used to be two named rows in the
  // list the field opens, which is where they went when the field's own
  // controls were pulled out wholesale — a control beside the value reads as
  // "delete this" whatever its icon says. What made that true was that removal
  // lived there too; it is now in the toggle column, so the mark left in the
  // field is not a delete and cannot be read as one.
  // Away from the panel first: the unlink hides like the chevron, so what it
  // reads at rest is only true with nothing hovered.
  await page.mouse.move(0, 0);
  const chrome = await page.evaluate(() => {
    const p = document.querySelector('[data-tw-editor="panel"]');
    const r = p.querySelector('[data-tw-field="bgColor"]');
    const f = r.querySelector('.bw-color').getBoundingClientRect();
    const u = r.querySelector('.bw-unlink');
    const t = r.querySelector('[data-tw-color-none="bg"]');
    const tr = t.getBoundingClientRect();
    return {
      unlink: !!u.offsetParent,
      unlinkRest: getComputedStyle(u).opacity,
      // The frame ends the mark 10px in from the field's right edge.
      unlinkRight: Math.round(f.right - u.querySelector('svg').getBoundingClientRect().right),
      field: Math.round(f.width),
      tile: [Math.round(tr.width), Math.round(tr.height)],
      tileRight: Math.round(tr.right),
      gap: Math.round(tr.left - f.right),
      acts: p.querySelectorAll('[data-tw-pop] .bw-pop-act').length,
    };
  });
  check('a token colour offers the unlink, 10px in from the field edge',
    chrome.unlink && chrome.unlinkRight === 10, JSON.stringify(chrome));
  check('and holds it back until the cursor is on the field, like the chevron',
    chrome.unlinkRest === '0', chrome.unlinkRest);
  // 270 and not 310: the tile is 40 wide with the 12 beside it, and it pulls
  // 10 of that back with the negative margin that puts its MARK on the gutter
  // rather than its box.
  check('the field gives the tile the same 40x40 column a section toggle has',
    chrome.field === 270 && chrome.gap === 12 &&
    chrome.tile[0] === 40 && chrome.tile[1] === 40, JSON.stringify(chrome));
  check('and the list is a list of colours, with no actions under it',
    chrome.acts === 0, chrome.acts);

  // Two marks in one slot would be two marks on top of each other, since the
  // chevron appears exactly where the cursor puts the unlink under it.
  await panel.locator('[data-tw-field="bgColor"] .bw-color').hover();
  const hovered = await page.evaluate(() => {
    const r = document.querySelector('[data-tw-editor="panel"] [data-tw-field="bgColor"]');
    return {
      unlink: getComputedStyle(r.querySelector('.bw-unlink')).opacity,
      // No chevron in this field at all: the swatch is what opens the list, so
      // a mark at the far end promising the same thing would be pointing at
      // nothing.
      chev: r.querySelectorAll('.bw-chev').length,
    };
  });
  check('the cursor brings it out, and there is no chevron behind it',
    hovered.unlink === '1' && hovered.chev === 0, JSON.stringify(hovered));

  // The unlink keeps the colour and drops the token, which is the only way to
  // reach an opacity: `emerald-500` is a name on a scale, and `emerald-500/40`
  // is a fourth kind of thing again.
  // Painted, not compared as strings: the same colour arrives as oklch() from
  // a generated utility and rgb() from the hex the unlink writes, and three
  // false failures in this repo have come from reading those as different.
  const paintOf = () => card.evaluate((e) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const x = cv.getContext('2d');
    x.fillStyle = getComputedStyle(e).backgroundColor;
    x.fillRect(0, 0, 1, 1);
    return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
  });
  const painted = await paintOf();
  await panel.locator('[data-tw-detach="bg"]').click();
  const detached = await card.getAttribute('class');
  check('the unlink takes the token off and puts its own hex on',
    !detached.includes('bg-emerald-500') && /bg-\[#[0-9a-f]{6}\]/.test(detached), detached);
  check('every other class is left where it was',
    detached.split(' ').filter((c) => !c.startsWith('bg-')).join(' ') ===
    beforeColour.split(' ').filter((c) => !c.startsWith('bg-')).join(' '), detached);
  check('and the element paints exactly what it painted before',
    (await paintOf()) === painted, painted + ' vs ' + (await paintOf()));

  // Frame 7:622: opacity is a field of its own, not a corner of the colour
  // one. 201 + 12 + 57 is the 270 the colour field has to itself without it,
  // so the tile beside them never moves as the two states swap.
  const opacity = await page.evaluate(() => {
    const r = document.querySelector('[data-tw-editor="panel"] [data-tw-field="bgColor"]');
    const f = r.querySelector('.bw-color').getBoundingClientRect();
    const a = r.querySelector('.bw-alpha');
    const ar = a.getBoundingClientRect();
    const inp = r.querySelector('[data-tw-alpha="bg"]');
    return {
      shown: !!a.offsetParent,
      colour: Math.round(f.width), width: Math.round(ar.width),
      gap: Math.round(ar.left - f.right),
      pad: Math.round(inp.getBoundingClientRect().left - ar.left),
      value: inp.value,
      size: getComputedStyle(r.querySelector('.bw-pct')).fontSize,
      unlink: !!r.querySelector('.bw-unlink').offsetParent,
    };
  });
  // The 57 and the 12 beside it come out of the colour field and out of
  // nothing else, so the tile after them stands exactly where it stood.
  check('a hex grows an opacity field of its own, 201 + 12 + 57',
    opacity.shown && opacity.colour === 201 && opacity.gap === 12 && opacity.width === 57,
    JSON.stringify(opacity));
  check('reading 100% at the panel\u2019s own size, 10px in',
    opacity.value === '100' && opacity.size === '15px' && opacity.pad === 10,
    JSON.stringify(opacity));
  // Nothing left to come off a token, so the slot empties.
  check('a detached colour offers no unlink', !opacity.unlink);

  // An arbitrary colour is a literal, exactly as p-[13px] is, and this was the
  // one field in the panel that did not say so.
  await card.evaluate((el) => { el.className = 'bg-[#ffdb25] p-4'; });
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });
  const jit = await page.evaluate(() => {
    const r = document.querySelector('[data-tw-editor="panel"] [data-tw-field="bgColor"]');
    const snow = r.querySelector('.bw-snow');
    return {
      text: r.querySelector('.bw-cname').value.trim(),
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
      text: row.querySelector('.bw-cname').value.trim(),
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

  // ---- the minus takes the colour off, and the row folds back to its + ----
  //
  // The two tiles share a column, so the cursor that pressed one is over the
  // other: nothing is taken out from under it, which is what kept removal in
  // the popover from folding the row before. Frame 7:620 draws the minus in
  // the 40x40 tile a section toggle occupies, which is where the + lands.
  await card.evaluate((el) => { el.style.color = ''; el.className = 'bg-white p-4'; });
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });

  await panel.locator('[data-tw-color-none="bg"]').click();
  check('removing takes the class off and nothing else',
    (await card.getAttribute('class')) === 'p-4', await card.getAttribute('class'));
  check('and the element goes back to painting nothing',
    (await card.evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgba(0, 0, 0, 0)');
  check('the row folds back to the + that offers it again',
    !(await panel.locator('[data-tw-color-open="bg"]').isVisible()) &&
    (await panel.locator('[data-tw-reveal="bg"]').isVisible()));
  // Same tile, same 40x40, same column — which is the whole reason the fold is
  // safe here and was not in the list.
  const swap = await page.evaluate(() => {
    const p = document.querySelector('[data-tw-editor="panel"]');
    const t = p.querySelector('[data-tw-reveal="bg"] .bw-toggle').getBoundingClientRect();
    return [Math.round(t.width), Math.round(t.height), Math.round(t.right)];
  });
  check('and the + lands in the tile the minus was clicked in',
    swap[0] === 40 && swap[1] === 40 && swap[2] === chrome.tileRight,
    JSON.stringify(swap) + ' vs ' + chrome.tileRight);

  await panel.locator('[data-tw-add="bg"]').click();
  check('putting it back writes white, so the field has something to show',
    (await card.getAttribute('class')) === 'p-4 bg-white', await card.getAttribute('class'));

  // ---- the ramp is a dropdown of its own, beside the palette ----
  //
  // It used to be the palette's second view, reached by a hue and left by a
  // back chevron, so the eleven shades arrived exactly where the colours had
  // been. Two boxes say both at once — which only reads as one thing if the
  // grids line up and the squares match, so that is what is measured here.
  await panel.locator('[data-tw-color-open="bg"]').click();
  const shades = page.locator('[data-tw-pop-shade]');
  await page.locator('[data-tw-pop] [data-tw-hue="violet"]').click();
  const pair = await page.evaluate(() => {
    const a = document.querySelector('[data-tw-pop]');
    const b = document.querySelector('[data-tw-pop-shade]');
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    // The first square, not the grid box: the palette's grid opens with a
    // caption spanning the row, so grid to grid is out by a line of text.
    const ag = a.querySelector('.bw-swatch').getBoundingClientRect();
    const bg = b.querySelector('.bw-swatch').getBoundingClientRect();
    const cell = (n) => { const r = n.querySelector('.bw-swatch').getBoundingClientRect(); return [r.width, r.height]; };
    const row = Array.from(b.querySelectorAll('.bw-swatch')).map((n) => Math.round(n.getBoundingClientRect().top));
    return {
      title: b.querySelector('.bw-pop-h strong').textContent,
      gap: Math.round(ar.left - br.right),
      grids: Math.round(bg.top - ag.top),
      cells: [cell(a), cell(b)],
      rows: new Set(row).size,
      shades: row.length,
      // The grid stands on the same gutter its own title and close mark do.
      inset: [Math.round(bg.left - br.left),
        Math.round(br.right - b.querySelector('.bw-swatches').getBoundingClientRect().right)],
      lit: a.querySelectorAll('[data-tw-hue="violet"].is-open').length,
      palette: a.style.display,
    };
  });
  check('the ramp opens as a box of its own, 6px to the left of the palette',
    pair.title === 'violet' && pair.gap === 6, JSON.stringify(pair));
  check('the palette stays open behind it, with a ring on the hue that opened it',
    pair.palette === 'flex' && pair.lit === 1, pair.palette + ' ' + pair.lit);
  check('the two grids sit on one line, so the pair reads as one grid',
    pair.grids === 0, pair.grids);
  check('a shade is the square a hue is — 20x20 in both boxes',
    JSON.stringify(pair.cells) === JSON.stringify([[20, 20], [20, 20]]), JSON.stringify(pair.cells));
  // 21 and not 20: measured off the border box, so the popover's own 1px edge
  // is inside every one of these numbers.
  check('eleven shades on one row, on the panel\u2019s own 20px gutter',
    pair.shades === 11 && pair.rows === 1 && pair.inset[0] === 21 && pair.inset[1] === 21,
    JSON.stringify(pair));
  await shades.locator('[data-tw-shades-close]').click();
  check('shutting the ramp leaves the palette where it was',
    !(await shades.isVisible()) && (await page.locator('[data-tw-pop]').isVisible()));
  await page.locator('[data-tw-pop] [data-tw-hue="violet"]').click();
  await page.locator('[data-tw-pop-shade] [data-tw-shade="500"]').click();
  check('and picking a shade writes it, then takes both boxes away',
    (await card.getAttribute('class')).includes('bg-violet-500') &&
    !(await shades.isVisible()) && !(await page.locator('[data-tw-pop]').isVisible()),
    await card.getAttribute('class'));

  // ---- the picker, on top of the presets ----
  //
  // Two different acts on one surface: the square says any colour there is,
  // the grid under it says the ones this project has a name for. On top rather
  // than beside, because the popover is a column and a column costs no width.
  await panel.locator('[data-tw-color-open="bg"]').click();
  const pop = page.locator('[data-tw-pop]');
  const stack = await pop.evaluate((p) =>
    Array.from(p.querySelectorAll('.bw-pop-body > *')).map((n) => n.className));
  check('the picker sits above the presets, not beside them',
    stack[0] === 'bw-picker' && stack[1] === 'bw-swatches', stack.join(' > '));

  const paintOfCard = () => card.evaluate((e) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const x = cv.getContext('2d');
    x.fillStyle = getComputedStyle(e).backgroundColor;
    x.fillRect(0, 0, 1, 1);
    return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
  });

  const sv = await pop.locator('[data-tw-sv]').boundingBox();
  await page.mouse.move(sv.x + sv.width * 0.85, sv.y + sv.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(sv.x + sv.width * 0.9, sv.y + sv.height * 0.35);
  await page.mouse.move(sv.x + sv.width * 0.92, sv.y + sv.height * 0.4);
  await page.mouse.up();
  const picked = await card.getAttribute('class');
  check('dragging the square writes a hex, and takes the old class off',
    /bg-\[#[0-9a-f]{6}\]/.test(picked) && !picked.includes('bg-white'), picked);
  // The class exists in no source file, so Tailwind generated nothing for it:
  // if it paints, ensurePreviewRule did its job.
  const hex = picked.match(/bg-\[(#[0-9a-f]{6})\]/)[1];
  check('and the page actually paints it',
    (await paintOfCard()) === [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(','),
    hex + ' vs ' + (await paintOfCard()));

  const strip = await pop.locator('[data-tw-strip]').boundingBox();
  await page.mouse.move(strip.x + strip.width * 0.55, strip.y + strip.height / 2);
  await page.mouse.down();
  await page.mouse.move(strip.x + strip.width * 0.6, strip.y + strip.height / 2);
  await page.mouse.up();
  const hued = await card.getAttribute('class');
  check('the strip moves the hue and leaves a hex behind it',
    /bg-\[#[0-9a-f]{6}\]/.test(hued) && hued !== picked, hued);

  // A pointer crossing a 294px square fires far more often than once, and each
  // one of those writes a class. One drag is still one thing you did.
  await pop.locator('.bw-x').click();
  await panel.locator('[data-tw-undo]').click();
  check('a drag is one step in the ledger, not one per frame',
    (await card.getAttribute('class')) === picked, await card.getAttribute('class'));
  await panel.locator('[data-tw-undo]').click();
  check('and the step before it is the one that came before the drag',
    (await card.getAttribute('class')) === 'p-4 bg-violet-500', await card.getAttribute('class'));

  // ---- the value is a field, and the swatch is the button ----
  //
  // The whole field used to be the button, which left the one value in this
  // panel people most often arrive holding — a hex, out of a design file or
  // another tab — as the only one you could not paste.
  const typed = async (text) => {
    const box = panel.locator('[data-tw-color-text="bg"]');
    await box.click();
    await box.fill(text);
    await box.press('Enter');
    return card.getAttribute('class');
  };
  check('a hex typed into the value is written as one',
    (await typed('#4837CA')) === 'p-4 bg-[#4837ca]', await card.getAttribute('class'));
  check('and it paints, on a class no source file has',
    (await card.evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(72, 55, 202)');
  check('three digits and no hash are the same request',
    (await typed('48c')) === 'p-4 bg-[#4488cc]', await card.getAttribute('class'));
  check('a token name is a token, not a literal',
    (await typed('emerald-500')) === 'p-4 bg-emerald-500', await card.getAttribute('class'));
  check('the prefix is the panel\u2019s business, not the typist\u2019s',
    (await typed('bg-emerald-700/40')) === 'p-4 bg-emerald-700/40', await card.getAttribute('class'));
  check('and a word that is no colour puts the value back, writing nothing',
    (await typed('nonsense')) === 'p-4 bg-emerald-700/40', await card.getAttribute('class'));
  check('the field says what it put back',
    (await panel.locator('[data-tw-color-text="bg"]').inputValue()) === 'emerald-700',
    await panel.locator('[data-tw-color-text="bg"]').inputValue());

  await card.evaluate((el) => { el.className = 'p-4 bg-white'; });
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });
  const opener = await page.evaluate(() => {
    const r = document.querySelector('[data-tw-editor="panel"] [data-tw-field="bgColor"]');
    const b = r.querySelector('[data-tw-color-open="bg"]');
    const f = r.querySelector('.bw-color').getBoundingClientRect();
    const c = r.querySelector('.bw-chip').getBoundingClientRect();
    return {
      tag: b.tagName,
      holdsChip: b.contains(r.querySelector('.bw-chip')),
      width: Math.round(b.getBoundingClientRect().width),
      chipAt: Math.round(c.left - f.left),
      nameIsField: r.querySelector('.bw-cname').tagName,
    };
  });
  check('the swatch is the only thing that opens the list, and it is 40 wide',
    opener.tag === 'BUTTON' && opener.holdsChip && opener.width === 40 &&
    opener.chipAt === 12 && opener.nameIsField === 'INPUT', JSON.stringify(opener));

  await card.evaluate((el, cls) => { el.style.color = ''; el.className = cls; }, beforeColour);
  await page.keyboard.press('Escape');
  await card.click({ position: { x: 120, y: 6 } });

  const live = await card.getAttribute('class');
  // The arrows count pixels, so the two presses above land between rungs as
  // often as on one: px-5 and px-[18px] are the same statement in the two
  // shapes this panel writes.
  const AXIS = /(?:^| )px-(?:[\d.]+|\[[\d.]+px\])(?: |$)/;
  check('old bg-white stripped, no duplicates',
    !live.includes('bg-white') && live.includes('bg-emerald-500') && AXIS.test(live), live);
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
    diskCard.includes('bg-emerald-500') && AXIS.test(diskCard), diskCard.trim());
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
