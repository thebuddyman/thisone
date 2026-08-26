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
  const colour = async k => field(k).locator('input').evaluate(el => getComputedStyle(el).color);
  // --bw-faint, #858585: what a value the element does not own is dimmed to.
  const FAINT = 'rgb(133, 133, 133)';

  // The ladder, read out of the panel's own dropdown rather than written down
  // here — it has moved once already and every number below follows from it.
  await page.locator('[data-eid="8"]').click({ position: { x: 3, y: 3 } });
  await field('p-x').locator('[data-tw-spacing-open]').click();
  // Read as the panel shows them — pixel lengths, not scale numbers.
  const RUNGS = await page.locator('[data-tw-spacing] .bw-sizename').allTextContents();

  // The field whose list is open says so. data-tw-field sits on the .bw-field
  // itself for some rows and on a wrapper for others, so find it either way —
  // tying the ring to the row lit every dropdown except the spacing ones.
  // The ring is an outline, not an inset shadow: a child's background paints
  // over a parent's inset shadow, and the token button fills its field, so the
  // shadow form was invisible under .bw-ctoken:hover — which is where the
  // cursor sits right after the click that opened the list. Read both, so this
  // check is about the ring being visible rather than about which property
  // happens to draw it.
  const ringOf = () => page.evaluate(() => {
    const n = document.querySelector('[data-tw-field="p-x"]');
    const box = n.classList.contains('bw-field') ? n : n.querySelector('.bw-field');
    const cs = getComputedStyle(box);
    return cs.boxShadow + ' | ' + cs.outlineColor + ' ' + cs.outlineWidth + ' ' + cs.outlineStyle;
  });
  const ringOpen = await ringOf();
  check('the field lights up while its list is open',
    ringOpen.includes('rgb(223, 126, 70)'), ringOpen);

  await page.locator('[data-tw-pop] .bw-x').click();
  const ringShut = await ringOf();
  check('and goes dark again when it closes',
    !ringShut.includes('rgb(223, 126, 70)'), ringShut);
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
  // Italic is reserved for a literal value now; inherited is only dimmed.
  check('an inherited value is dimmed, and upright',
    (await colour('p-x')) === FAINT && (await style('p-x')) === 'normal',
    `${await colour('p-x')} / ${await style('p-x')}`);

  // the axis input writes px-*, touching only left and right
  const hx = await stepped('p-x', 'up', 'horizontal stepped one rung');
  check('horizontal is now explicit (upright)', (await style('p-x')) === 'normal');
  check('vertical still inherited from p-4',
    (await read('p-y')) === '16' && (await colour('p-y')) === FAINT,
    `${await read('p-y')} / ${await colour('p-y')}`);
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
    (await read('p-l')) === hx && (await colour('p-l')) === FAINT);

  // bump only the top
  const pt = await stepped('p-t', 'up', 'T stepped one rung');
  check('T is now explicit (upright)', (await style('p-t')) === 'normal');
  check('right still inherits from the axis',
    (await read('p-r')) === hx && (await colour('p-r')) === FAINT);
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
    (await read('p-b')) === '16' && (await colour('p-b')) === FAINT, await read('p-b'));
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
  // Deselect before every re-click: a live selection parks the delete handle on
  // the element's corner, which is the spot these clicks aim at.
  const reselect = async (cls) => {
    // A background click deselects; Escape would too, but with nothing selected
    // Escape steps out one more layer and leaves edit mode entirely — after
    // which every field is hidden and each check silently measures nothing.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await h2b.evaluate((el, c) => { el.className = c; }, cls);
    await h2b.click({ position: { x: 3, y: 3 } });
    if ((await panel.getAttribute('data-tw-idle')) !== null) {
      throw new Error('reselect(' + cls + ') selected nothing — the checks below would be meaningless');
    }
  };
  await reselect('text-2xl font-bold pt-5 pb-2 pl-6 pr-6');
  check('uneven edges open the four-edge view by themselves',
    (await shown()).includes('p-t'), (await shown()).join(','));

  await panel.locator('[data-tw-toggle="p"]').click();
  check('folding by hand is respected', (await shown()).includes('p-y'), (await shown()).join(','));
  check('vertical reads before horizontal',
    (await shown()).join(',').indexOf('p-y') < (await shown()).join(',').indexOf('p-x'),
    (await shown()).join(','));
  check('an axis whose edges disagree shows both, comma separated',
    (await read('p-y')) === '20, 8', await read('p-y'));
  // Two real values are not one inherited value, so they are not italicised.
  check('a comma pair reads upright, not italic',
    (await style('p-y')) === 'normal', await style('p-y'));
  check('an axis whose edges agree shows the one value',
    (await read('p-x')) === '24', await read('p-x'));

  // An edge with no class of its own still renders something: ', 8' reads as a
  // missing number where '0, 8' reads as a zero.
  await reselect('text-2xl font-bold pt-5');
  check('one-sided padding unfolds too', (await shown()).includes('p-t'), (await shown()).join(','));
  await panel.locator('[data-tw-toggle="p"]').click();
  check('an unset edge in a comma pair reads 0',
    (await read('p-y')) === '20, 0', await read('p-y'));

  // Four per-side classes that agree in pairs say nothing two fields cannot,
  // now that an axis reads its edges — so they fold.
  await reselect('text-2xl font-bold pt-0 pb-0 pl-4 pr-4');
  check('per-side classes that agree in pairs stay folded',
    (await shown()).includes('p-y') && !(await shown()).includes('p-t'),
    (await shown()).join(','));
  check('and the two folded fields state them',
    (await read('p-y')) === '0' && (await read('p-x')) === '16',
    [await read('p-y'), await read('p-x')].join(' / '));

  // Put the four-value element back for the checks below.
  await reselect('text-2xl font-bold pt-5 pb-2 pl-6 pr-6');
  await panel.locator('[data-tw-toggle="p"]').click();

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

  // ---- folded and unfolded must never contradict each other ----
  //
  // An axis used to report its own class while the edges reported theirs, so
  // mx-[100px] alongside ml-3 mr-3 read 100 folded and 12 / 12 unfolded.
  await reselect('text-2xl font-bold mx-[100px] ml-3 mr-3');
  const mView = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-tw-editor="panel"] [data-tw-field]')]
      .filter((e) => e.offsetParent !== null && /^m-/.test(e.getAttribute('data-tw-field')))
      .map((e) => e.getAttribute('data-tw-field')).join(','));
  if ((await mView()).includes('m-l')) await panel.locator('[data-tw-toggle="m"]').click();
  const foldedHz = await read('m-x');
  await panel.locator('[data-tw-toggle="m"]').click();
  const openL = await read('m-l');
  const openR = await read('m-r');
  check('the folded axis says what the two edges say',
    foldedHz === openL && openL === openR,
    `folded ${foldedHz}  unfolded ${openL} / ${openR}`);

  // ---- a snowflake and italic mean the same thing, and never disagree ----
  await reselect('text-2xl font-bold py-[13px] px-4');
  const marked = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-tw-editor="panel"] [data-tw-field]').forEach((r) => {
      if (!r.getBoundingClientRect().height) return;
      const txt = r.querySelector('input.bw-val, .bw-cname');
      if (!txt) return;
      const snow = r.querySelector('.bw-snow');
      out.push({
        field: r.getAttribute('data-tw-field'),
        snow: !!(snow && snow.offsetParent !== null),
        italic: getComputedStyle(txt).fontStyle === 'italic',
      });
    });
    return out;
  });
  check('a literal value is snowflaked AND italic',
    marked.some((m) => m.field === 'p-y' && m.snow && m.italic),
    JSON.stringify(marked.find((m) => m.field === 'p-y')));
  check('the two never disagree on any field',
    marked.every((m) => m.snow === m.italic),
    JSON.stringify(marked.filter((m) => m.snow !== m.italic)));

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

  // ---- a property that is not set keeps its row, with a + in it ----
  //
  // Frame 4:407: Margin unset is a 40px line reading "Margin" with a + where
  // the fields go, in Margin's own slot. Not a chip in a strip at the end of
  // the panel — that moved every unset property out of the order the panel
  // otherwise reads in, and revealing one made the layout jump.
  await page.locator('[data-eid="9"]').evaluate((el) => { el.className = 'p-4'; });
  // Not the corner: the delete handle for the live selection sits there.
  await page.locator('[data-eid="9"]').click({ position: { x: 60, y: 20 } });

  const order = () => page.evaluate(() => Array.from(
    document.querySelectorAll('[data-tw-editor="panel"] .bw-body > *'))
    .filter((n) => n.offsetParent)
    .map((n) => (n.querySelector('.bw-lbl') || {}).textContent || ''));

  const labels = await order();
  check('every property has a row, set or not',
    labels.join(' > ') === 'Text > Padding > Margin > Radius > Typography > Background > Text color',
    labels.join(' > '));
  check('and no Add strip at the end to go looking in',
    (await panel.locator('[data-tw-add-row]').count()) === 0);
  // A colour the element does not set is the same case as a margin it does
  // not set: the field could only say so with a dash and an empty swatch.
  check('a colour with nothing set stands in for itself too',
    (await panel.locator('[data-tw-reveal="bg"]').isVisible()) &&
    (await panel.locator('[data-tw-reveal="text"]').isVisible()) &&
    !(await panel.locator('[data-tw-color-open="bg"]').isVisible()));
  // A colour is the one kind of row whose + writes something. Every other one
  // reveals a field that already has an answer — padding with no class still
  // renders 0 — where a colour with no class is a dash and an empty swatch,
  // which is what the row was hiding. So it starts at white.
  await panel.locator('[data-tw-reveal="bg"]').click();
  check('and its + brings the field out, starting at white',
    (await panel.locator('[data-tw-color-open="bg"]').isVisible()) &&
    !(await panel.locator('[data-tw-reveal="bg"]').isVisible()) &&
    (await page.locator('[data-eid="9"]').getAttribute('class')) === 'p-4 bg-white',
    await page.locator('[data-eid="9"]').getAttribute('class'));
  check('and white actually paints, with no rule in any source file',
    (await page.locator('[data-eid="9"]').evaluate(
      (e) => getComputedStyle(e).backgroundColor)) === 'rgb(255, 255, 255)');

  const reveal = panel.locator('[data-tw-reveal="m"]');
  check('the unset margin row is the frame\'s 40px line', 
    (await reveal.boundingBox()).height === 40, (await reveal.boundingBox()).height);
  check('its label sits beside the +, not above it',
    await reveal.evaluate((n) => {
      const l = n.querySelector('.bw-lbl').getBoundingClientRect();
      const b = n.querySelector('.bw-toggle').getBoundingClientRect();
      return Math.abs((l.top + l.height / 2) - (b.top + b.height / 2)) < 2 && l.right <= b.left;
    }));
  check('the + sits in the same column a section toggle does',
    await page.evaluate(() => {
      const p = document.querySelector('[data-tw-editor="panel"]');
      const add = p.querySelector('[data-tw-reveal="m"] .bw-toggle').getBoundingClientRect();
      const tog = p.querySelector('[data-tw-toggle="p"]').getBoundingClientRect();
      return Math.round(add.right) === Math.round(tog.right) && add.width === tog.width;
    }));
  // The whole row is the button, not the 20px mark at the end of it.
  check('the row itself is the control, end to end',
    await reveal.evaluate((n) => n.tagName === 'BUTTON' &&
      n.hasAttribute('data-tw-add') && n.querySelectorAll('button').length === 0));

  // ---- the frame's hairlines ----
  const rules = () => page.evaluate(() => Array.from(
    document.querySelectorAll('[data-tw-editor="panel"] .bw-body > *'))
    .filter((n) => n.offsetParent)
    .map((n) => n.classList.contains('has-rule')));
  const marks = await rules();
  check('every row on screen carries a divider except the top one',
    marks.length > 3 && marks[0] === false && marks.slice(1).every(Boolean),
    marks.join(','));
  check('a divider runs the full width of the panel, and hangs no scrollbar off it',
    await page.evaluate(() => {
      const b = document.querySelector('[data-tw-editor="panel"] .bw-body');
      const row = b.querySelector('.has-rule');
      const line = getComputedStyle(row, '::before');
      return b.scrollWidth === b.clientWidth &&
        line.left === '-20px' && line.height === '1px';
    }));
  // 20px of air on both sides of every line, which is what the frame measures:
  // 167 to a Padding label at 186.5, 280 to a Margin one at 299.5.
  //
  // Measured to what is drawn, not to the row box. An open row starts at its
  // label, so the two are the same thing; a reveal row is a 15px label centred
  // in a 40px box, so half its air is already inside it and its box would read
  // 10 where the eye sees 20. Two ways of buying the same gap — which is why
  // this asks about the gap and not about a margin.
  const air = await page.evaluate(() => {
    const body = document.querySelector('[data-tw-editor="panel"] .bw-body');
    const rows = Array.from(body.children).filter((n) => n.offsetParent);
    const edge = (r, side) => {
      const box = r.classList.contains('bw-reveal')
        ? r.querySelector('.bw-lbl').getBoundingClientRect()
        : r.getBoundingClientRect();
      return box[side];
    };
    const out = [];
    let prev = null;
    for (const r of rows) {
      if (r.classList.contains('has-rule')) {
        const line = r.getBoundingClientRect().top +
          parseFloat(getComputedStyle(r, '::before').top);
        out.push([line - edge(prev, 'bottom'), edge(r, 'top') - line]);
      }
      prev = r;
    }
    return out;
  });
  check('every row stands 20px off its divider, on both sides',
    air.length > 3 && air.every((pair) => pair.every((v) => Math.abs(v - 20) <= 2)),
    air.map((p) => p.map((v) => Math.round(v)).join('/')).join(' '));

  // A line the same colour as a field vanishes wherever it crosses one, which
  // is most of its length — so this is the whole reason it is not the frame's
  // #232323.
  check('and is not the colour of the fields it runs past',
    await page.evaluate(() => {
      const p = document.querySelector('[data-tw-editor="panel"]');
      const line = getComputedStyle(p.querySelector('.bw-body > .has-rule'), '::before');
      const field = getComputedStyle(p.querySelector('.bw-field'));
      return line.backgroundColor !== field.backgroundColor;
    }),
    await page.evaluate(() => getComputedStyle(
      document.querySelector('[data-tw-editor="panel"] .bw-body > .has-rule'),
      '::before').backgroundColor));

  // gap only means something on a flex or grid container, so it is not offered
  // on this one — nothing is hidden beyond reach, but nothing useless is added.
  check('gap is not offered on a block element',
    !(await panel.locator('[data-tw-reveal="gap"]').isVisible()));
  // Escape first: clicking an element that is already selected is a no-op, so
  // the panel would still be describing the block version of it.
  await page.keyboard.press('Escape');
  await page.locator('[data-eid="9"]').evaluate((el) => { el.className = 'p-4 flex'; });
  await page.locator('[data-eid="9"]').click({ position: { x: 60, y: 20 } });
  // A heading holding one line of text is one flex item, and one item lays out
  // identically at every value gap can take. Same empty offer Typography makes
  // on an element with no text under it.
  check('nor on a flex one with a single item to space',
    !(await panel.locator('[data-tw-reveal="gap"]').isVisible()));
  await page.keyboard.press('Escape');
  await page.locator('[data-eid="5"]').evaluate((el) => { el.className = 'p-12 flex'; });
  await page.locator('[data-eid="5"]').click({ position: { x: 200, y: 6 } });
  check('…and is, on a flex one with two',
    await panel.locator('[data-tw-reveal="gap"]').isVisible());
  // In gap's own slot, after Radius — and with no Text row above it, which is
  // the container's own answer: the text on screen belongs to its children.
  const gapOrder = await order();
  check('offered in the slot gap reads in, after Radius',
    gapOrder.join(' > ') ===
      'Padding > Margin > Radius > Gap > Typography > Background > Text color',
    gapOrder.join(' > '));

  // ---- gap shows the gap the element is using, and no switch ----
  //
  // gap-4, gap-x-4 and gap-y-4 are three different statements about a
  // container. A container saying one of them is saying nothing about the
  // other axis, so a field for it is a control for a decision nobody took.
  const gapShows = async (cls) => {
    // Move the selection away first: re-clicking the selected element is a
    // no-op, so the panel would still describe the old classes.
    await card.click({ position: { x: 200, y: 6 } });
    await page.locator('[data-eid="9"]').evaluate((e, c) => { e.className = c; }, cls);
    const box = await page.locator('[data-eid="9"]').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return page.evaluate(() => Array.from(
      document.querySelectorAll('[data-tw-editor="panel"] [data-tw-field^="gap"]'))
      .filter((n) => n.offsetParent)
      .map((n) => n.getAttribute('data-tw-field').replace('gap-', ''))
      .join(' + ') || '(none)');
  };
  const gapCases = [
    ['flex p-4 gap-4', 'all'],
    ['flex p-4 gap-x-6', '-x'],
    ['flex p-4 gap-y-8', '-y'],
    ['flex p-4 gap-x-6 gap-y-8', '-x + -y'],
  ];
  for (const [cls, want] of gapCases) {
    const got = await gapShows(cls);
    check(`${cls.replace('flex p-4 ', '')} shows ${want}`, got === want, got);
  }
  // ---- the single gap points the way the container actually pushes ----
  //
  // `gap-4` is a vertical gap on a flex-col and a horizontal one on a flex-row,
  // so a fixed mark on that field is wrong half the time. The axis fields have
  // no such problem — `gap-x-*` is column gap wherever it appears — so only the
  // single field asks the element, and only it is expected to change here.
  const gapMark = async (cls) => {
    await card.click({ position: { x: 200, y: 6 } });
    await page.locator('[data-eid="9"]').evaluate((e, c) => { e.className = c; }, cls);
    const box = await page.locator('[data-eid="9"]').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return page.evaluate(() => {
      const f = document.querySelector(
        '[data-tw-editor="panel"] [data-tw-field="gap-all"] .bw-ico');
      if (!f || !f.offsetParent) return '(no single gap field)';
      const svg = f.innerHTML;
      // Told apart by the first path of each exported asset, since the files
      // carry no id to key on.
      if (svg.includes('M2.5 2H3.5')) return 'hz';
      if (svg.includes('M18 2.5L18 3.5')) return 'vt';
      return 'other';
    });
  };
  const markCases = [
    ['flex p-4 gap-4', 'hz', 'a row pushes items apart across'],
    ['flex flex-col p-4 gap-4', 'vt', 'a column pushes them apart down'],
    ['flex flex-row-reverse p-4 gap-4', 'hz', 'reversed is still an axis'],
    ['flex flex-col-reverse p-4 gap-4', 'vt', 'and so is reversed the other way'],
    ['grid p-4 gap-4', 'hz', 'grid sets both axes and keeps the across mark'],
  ];
  for (const [cls, want, why] of markCases) {
    const got = await gapMark(cls);
    check(`${why} — ${cls.replace('p-4 ', '')}`, got === want, got);
  }
  check('and there is no switch between one gap and two',
    (await panel.locator('[data-tw-toggle="gap"]').count()) === 0);

  // Put it back the way the margin check below expects to find it. The section
  // and not the heading, so Gap is on screen for the order check below: a
  // heading is one flex item, and gap is not offered where it can do nothing.
  await card.click({ position: { x: 200, y: 6 } });
  await page.locator('[data-eid="9"]').evaluate((e) => { e.className = 'p-4'; });
  await page.locator('[data-eid="5"]').evaluate((e) => { e.className = 'p-12 flex'; });
  await page.locator('[data-eid="5"]').click({ position: { x: 200, y: 6 } });

  // Clicked at the label end, which is the half of the row that used to do
  // nothing at all.
  const target = await panel.locator('[data-tw-reveal="m"]').boundingBox();
  await page.mouse.click(target.x + 30, target.y + target.height / 2);
  check('the + fills the row in where it already stood',
    !(await panel.locator('[data-tw-reveal="m"]').isVisible()) &&
    (await panel.locator('[data-tw-field="m-y"]').isVisible()));
  check('revealing wrote nothing',
    (await page.locator('[data-eid="5"]').getAttribute('class')) === 'p-12 flex',
    await page.locator('[data-eid="5"]').getAttribute('class'));
  const after = await order();
  check('and the panel still reads in the same order',
    after.join(' > ') ===
      'Padding > Margin > Radius > Gap > Typography > Background > Text color',
    after.join(' > '));

  await page.screenshot({ path: `${__dirname}/sides.png` });
  await browser.close();

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
