/**
 * End-to-end verification against a real Next.js project.
 *
 *   node next/verify.js --root <project> [--app http://localhost:3000] [--editor http://127.0.0.1:3500]
 *
 * Assumes `next dev` and `next/server.js` are already running. Restores every
 * file it touches.
 */
const { chromium } = require('playwright');
const fs = require('fs');
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


/**
 * Select the first element on a route that owns its own text, and open the
 * typography section on it. Two blocks below need the same three steps and
 * the same reason for them: a wrapper has no typography controls, only the +
 * row standing in for them, and measuring a section that is correctly absent
 * reads as a broken panel.
 */
async function selectTyped(page, panel, locPrefix, skip = 0) {
  const cands = page.locator(`[data-thisone-loc^="${locPrefix}"]`);
  const total = await cands.count();
  let seen = 0;
  for (let i = 0; i < total; i++) {
    const c = cands.nth(i);
    const own = await c.evaluate((el) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.nodeValue.trim().length > 2) return true;
      }
      return false;
    });
    if (!own) continue;
    // Skipping is how a caller forces a FRESH selection: discovery re-runs in
    // select(), and re-clicking the element already selected is a no-op, so a
    // stylesheet added since would never be read.
    if (seen++ < skip) continue;
    await c.scrollIntoViewIfNeeded();
    await c.click({ force: true });
    await page.waitForTimeout(300);
    const reveal = panel.locator('[data-tw-reveal="typography"]');
    if (await reveal.isVisible()) { await reveal.click(); await page.waitForTimeout(150); }
    return c;
  }
  throw new Error('no element with its own text under ' + locPrefix);
}

/** Every generated .font-* rule and every --font-* theme key on this page. */
const readFontSources = (page) => page.evaluate(() => {
  const utils = {}, themeVars = {}, otherVars = {};
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    const walk = (rs, inTheme) => { for (const r of rs) {
      if (r.selectorText && r.style) {
        const m = /^\.font-([a-zA-Z][a-zA-Z0-9-]*)$/.exec(r.selectorText);
        if (m && r.style.fontFamily) utils[m[1]] = r.style.fontFamily;
        for (let i = 0; i < r.style.length; i++) {
          const prop = r.style[i];
          if (prop.indexOf('--font-') !== 0 || prop.indexOf('--font-weight-') === 0) continue;
          const bag = inTheme && r.selectorText.indexOf(':root') !== -1 ? themeVars : otherVars;
          bag[prop.slice(7)] = r.style.getPropertyValue(prop).trim();
        }
      }
      if (r.cssRules && r.cssRules.length) walk(r.cssRules, inTheme || r.name === 'theme');
    } };
    if (rules) walk(rules, false);
  }
  return { utils, themeVars, otherVars };
});

const path = require('path');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ROOT = path.resolve(arg('root', process.cwd()));
const APP = arg('app', 'http://localhost:3000');
const EDITOR = arg('editor', 'http://127.0.0.1:3500');

const PAGE = path.join(ROOT, 'src/app/page.tsx');
const LAYOUT = path.join(ROOT, 'src/app/layout.tsx');
// The radius checks need a route that redefines the ladder; Cora does, and its
// login page has a static className carrying rounded-full.
const CORA = path.join(ROOT, 'src/app/experiments/cora/login/page.tsx');
// Volt's design system renders 19 elements from one line — the worst blast
// radius measured on these routes, and the reason a removal states a count.
const VOLT = path.join(ROOT, 'src/app/experiments/volt/design-system/page.tsx');

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const snapshot = (f) => fs.readFileSync(f, 'utf8');

/**
 * Back up every file this run may write, INSIDE the repo — not a temp dir.
 * A previous run kept its only copies in a scratch directory that was cleaned
 * mid-session, which left an edit stranded in a file git did not track.
 */
const BACKUPS = path.join(__dirname, '..', '.backups');
function guard(file) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  // Keyed on the relative path, not the basename: three of the guarded files
  // are called page.tsx, and two guards taken in the same millisecond used to
  // land on one filename — silently throwing away the first file's only copy.
  const dest = path.join(BACKUPS, path.relative(ROOT, file).replace(/[\\/]/g, '-') + '.bak');
  fs.copyFileSync(file, dest);
  return { file, dest, before: snapshot(file) };
}
function restore(g) {
  fs.writeFileSync(g.file, g.before);
  const ok = snapshot(g.file) === g.before;
  // Relative, not basename: three of the guarded files are called page.tsx.
  console.log(`${ok ? 'PASS' : 'FAIL'}  restored ${path.relative(ROOT, g.file)} byte-exactly` +
    (ok ? '' : `  — BACKUP KEPT AT ${g.dest}`));
  if (ok) fs.unlinkSync(g.dest);
  return ok;
}

(async () => {
  const guards = [guard(PAGE), guard(LAYOUT), guard(CORA), guard(VOLT)];
  const pageBefore = guards[0].before;
  const layoutBefore = guards[1].before;

  // Every write below happens inside the try. A thrown locator — a renamed
  // selector, a route that moved — used to skip the restore entirely and leave
  // a test edit sitting in the user's file, which is exactly the accident this
  // harness exists to prevent. The finally is the whole point of the backups.
  let browser;
  try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(APP + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // ---- overlay reached a real Next page ----
  const panel = page.locator('[data-tw-editor="panel"]');
  check('overlay mounted in the Next app', (await panel.count()) === 1);

  // Edit mode is off until asked for: the app is just the app until then. The
  // choice is kept for the tab, so the route changes below inherit it.
  const mode = page.locator('[data-tw-mode]');
  check('the editor starts off, with only its toggle showing',
    (await mode.count()) === 1 && (await mode.getAttribute('aria-pressed')) === 'false',
    await mode.getAttribute('aria-pressed'));
  await page.locator('[data-thisone-loc^="src/app/page.tsx:5:5:"]').click({ position: { x: 4, y: 4 } });
  check('clicking the page selects nothing while it is off', !(await panel.isVisible()));
  await mode.click();
  check('turning it on says so', (await mode.getAttribute('aria-pressed')) === 'true');

  const target = page.locator('[data-thisone-loc^="src/app/page.tsx:5:5:"]');
  check('loader stamped the page.tsx element', (await target.count()) === 1,
    await target.getAttribute('data-thisone-loc'));

  // ---- select and preview ----
  await target.click({ position: { x: 5, y: 5 } });
  // The panel outlives the selection now — `data-tw-idle` is what says whether
  // anything is selected, and the button bar below it is always on screen.
  check('panel opened', (await panel.getAttribute('data-tw-idle')) === null);
  check('the button bar is on screen', await panel.locator('[data-tw-save]').isVisible());
  check('panel names the source location',
    (await panel.locator('strong').first().textContent()).includes('page.tsx:5'),
    await panel.locator('strong').first().textContent());
  // The Text row is an editable field, and only appears where there is text to
  // edit. This element is a container, so it should not have one.
  check('no Text row on a container',
    !(await panel.locator('[data-tw-field="text"]').isVisible()),
    String(await panel.locator('[data-tw-text]').inputValue()));

  // Compare RESOLVED RGB. The palette emits a literal oklch() while the app's
  // own theme resolves to lab(); they serialise differently and paint the same.
  const rgbOf = (sel) => page.evaluate((s) => {
    const px = (css) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const x = cv.getContext('2d');
      x.fillStyle = css;
      x.fillRect(0, 0, 1, 1);
      return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
    };
    return {
      actual: px(getComputedStyle(document.querySelector(s)).backgroundColor),
      emerald: px('oklch(69.6% 0.17 162.48)'),
    };
  }, sel);

  const SEL = '[data-thisone-loc^="src/app/page.tsx:5:5:"]';
  const bgBefore = (await rgbOf(SEL)).actual;
  await pickColor(panel, 'bg', 'emerald', '500');
  const bgAfter = await rgbOf(SEL);
  check('INSTANT PREVIEW: computed background actually changed',
    bgAfter.actual !== bgBefore && bgAfter.actual === bgAfter.emerald,
    `${bgBefore} → ${bgAfter.actual} (emerald ${bgAfter.emerald})`);
  check('preview opt-in attribute was set',
    (await target.getAttribute('data-thisone-edited')) !== null);

  // ---- save to the .tsx ----
  const saveBtn = panel.locator('[data-tw-save]');
  check('save button reflects one pending change',
    (await saveBtn.textContent()).trim() === 'Save 1 change', await saveBtn.textContent());
  await saveBtn.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-tw-status]');
    return /written|failed|changed|<|classes/.test(el?.textContent || '');
  }, null, { timeout: 8000 });

  const pageAfter = snapshot(PAGE);
  check('page.tsx on disk now has the new class', /bg-emerald-500/.test(pageAfter),
    pageAfter.split('\n').find((l) => l.includes('className')) || '');
  check('the old class was replaced, not appended', !/bg-\[var\(--idx-bg\)\]/.test(pageAfter));

  // the splice must not disturb a single byte outside the className
  const diffLines = pageBefore.split('\n').filter((l, i) => l !== pageAfter.split('\n')[i]);
  check('exactly one line changed', diffLines.length === 1, JSON.stringify(diffLines));
  check('line count unchanged', pageBefore.split('\n').length === pageAfter.split('\n').length);

  // ---- HMR picks it up ----
  // Compare RESOLVED RGB, not the serialized string: the palette emits a
  // literal oklch() while the app's own theme resolves to lab(), and the two
  // serialize differently while painting the identical colour.
  // Turbopack's recompile is not on a clock. A fixed wait here failed about one
  // run in five — poll for the result, then assert on it.
  const settled = (fn) => page.waitForFunction(fn, null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  await settled(() => {
    const el = document.querySelector('[data-thisone-loc^="src/app/page.tsx:5:5:"]');
    if (!el) return false;
    const px = (css) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const x = cv.getContext('2d');
      x.fillStyle = css;
      x.fillRect(0, 0, 1, 1);
      return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
    };
    return px(getComputedStyle(el).backgroundColor) === px('oklch(69.6% 0.17 162.48)');
  });
  const hmr = await page.evaluate(() => {
    const el = document.querySelector('[data-thisone-loc^="src/app/page.tsx:5:5:"]');
    if (!el) return { missing: true };
    const px = (css) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const x = cv.getContext('2d');
      x.fillStyle = css;
      x.fillRect(0, 0, 1, 1);
      return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
    };
    return { actual: px(getComputedStyle(el).backgroundColor), emerald: px('oklch(69.6% 0.17 162.48)') };
  });
  check('HMR rendered the saved class from source',
    !hmr.missing && hmr.actual === hmr.emerald, `${hmr.actual} vs emerald ${hmr.emerald}`);

  // ---- border radius, on a route that redefines the ladder ----
  //
  // Cora sets --radius: 0.75rem and derives its rungs from it, and `@theme
  // inline` bakes the result into the utility: `.rounded-lg` is var(--radius),
  // 12px, while --radius-lg still resolves to the stock 8px. Every number
  // below would be wrong if the overlay read the variable instead of the rule.
  await page.goto(APP + '/experiments/cora/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const coraBefore = snapshot(CORA);

  const btn = page.locator('button.rounded-full').first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForTimeout(300);
  const handle = await btn.elementHandle(); // the class is about to change under it

  const radiusRow = panel.locator('[data-tw-field="radius"]');
  const boxRadius = panel.locator('[data-tw-field="radius-all"] input');
  check('Radius row shows on a painted element', await radiusRow.isVisible());
  // The field gives a length, not a token name. `full` is the one rung with no
  // length behind it — calc(infinity * 1px) — so it says its own name rather
  // than printing the eight-digit number it computes to, and the tooltip
  // carries the class either way.
  check('Radius row reads what the element renders, and names it in the title',
    (await boxRadius.inputValue()).trim() === 'full' &&
    /rounded-full/.test(await boxRadius.getAttribute('title')),
    `${await boxRadius.inputValue()}  (${await boxRadius.getAttribute('title')})`);

  // Tailwind's half steps are 12% of this project's spacing classes, and an
  // integers-only pattern read every one of them as unset.
  const pyField = panel.locator('[data-tw-field="p-y"] input');
  check('a half-step padding class reads as the 14px it renders',
    (await pyField.inputValue()) === '14' && !(await pyField.getAttribute('class')).includes('is-unset'),
    `${await pyField.inputValue()}  (${await pyField.getAttribute('title')})`);
  const pxField = panel.locator('[data-tw-field="p-x"] input');
  check('a side with nothing on it reads 0, not a dash',
    (await pxField.inputValue()) === '0',
    `${JSON.stringify(await pxField.inputValue())}  (${await pxField.getAttribute('title')})`);

  await panel.locator('[data-tw-radius-open]').click();
  const rpop = page.locator('[data-tw-pop]');
  const rungs = await rpop.locator('[data-tw-radius]').evaluateAll(
    (ns) => ns.map((x) => x.getAttribute('data-tw-radius')));
  check('ladder is theme order with the utility ends attached',
    rungs.join(',') === 'none,xs,sm,md,lg,xl,2xl,3xl,4xl,full', rungs.join(','));
  check('current rung is marked',
    (await rpop.locator('[data-tw-radius="full"]').getAttribute('aria-current')) === 'true');
  // The row IS the length now, the way the spacing list's rows are — so the
  // number is the name, not a note beside it.
  const lgLabel = await rpop.locator('[data-tw-radius="lg"] .bw-sizename').textContent();
  check("rung reports THIS route's value, not --radius-lg", lgLabel === '12px', lgLabel);
  const rungLabels = await rpop.locator('[data-tw-radius] .bw-sizename').allTextContents();
  check('every row is a pixel length, with no rung name to translate',
    rungLabels.every((v) => /^\d+px$/.test(v) || v === 'full'), rungLabels.join(','));

  await rpop.locator('[data-tw-radius="lg"]').click();
  await page.waitForTimeout(600); // the button is transition-all duration-200
  const rendered = await handle.evaluate((x) => getComputedStyle(x).borderTopLeftRadius);
  check('preview used the route\'s own rule, not the stock one', rendered === '12px', rendered);
  const rcls = await handle.evaluate((x) => x.getAttribute('class'));
  check('rounded-full was replaced, not duplicated',
    rcls.includes('rounded-lg') && !rcls.includes('rounded-full'),
    rcls.split(' ').filter((c) => c.startsWith('rounded')).join(' ') || '(none)');

  await panel.locator('[data-tw-save]').click();
  await page.waitForTimeout(1200);
  const coraAfter = snapshot(CORA);
  const coraDiff = coraBefore.split('\n')
    .map((l, i) => [i, l, coraAfter.split('\n')[i]])
    .filter(([, a, b]) => a !== b);
  check('exactly one line changed in the Cora page', coraDiff.length === 1,
    coraDiff.map(([i]) => i + 1).join(','));
  if (coraDiff.length === 1) {
    // The writer re-appends a swapped class in the non-cn() path, so the token
    // moves within the line. What must hold is that ONE token changed.
    const list = (l) => (/className="([^"]*)"/.exec(l) || [, l])[1].trim().split(/\s+/);
    const B = list(coraDiff[0][1]), A = list(coraDiff[0][2]);
    check('the only token that changed is the radius',
      B.filter((t) => !A.includes(t)).join() === 'rounded-full' &&
      A.filter((t) => !B.includes(t)).join() === 'rounded-lg' && A.length === B.length,
      `-${B.filter((t) => !A.includes(t)).join(' ')} +${A.filter((t) => !B.includes(t)).join(' ')}`);
  }

  // The escape hatch. gw-web writes 180 arbitrary radii against 90 named ones,
  // so this path is the majority idiom there, not a corner case.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const btn2 = page.locator('button.rounded-lg').first();
  await btn2.scrollIntoViewIfNeeded();
  await btn2.click();
  await page.waitForTimeout(300);
  const handle2 = await btn2.elementHandle();
  await panel.locator('[data-tw-radius-open]').click();
  await page.locator('[data-tw-radius-filter]').fill('13');
  await page.waitForTimeout(150);
  check('typing a number offers an arbitrary radius',
    await page.locator('[data-tw-radius-custom]').isVisible());
  await page.locator('[data-tw-radius-custom]').click();
  await page.waitForTimeout(600);
  const custom = await handle2.evaluate((x) => getComputedStyle(x).borderTopLeftRadius);
  check('arbitrary radius previews, with no rule in any source file',
    custom === '13px', custom);

  // ---- the four corners ----
  // The live-only half of the per-corner work. A route that renders
  // `.rounded-lg` has generated nothing for `.rounded-tl-lg`, so the overlay
  // must emit one — and emit it from THIS route's value. Built from the stock
  // ladder instead, the corner would snap to 8px beside three 12px ones, which
  // is the `px-6 md:px-12` failure wearing a different utility.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const coraCorner = snapshot(CORA);
  const btn3 = page.locator('button.rounded-lg').first();
  await btn3.scrollIntoViewIfNeeded();
  await btn3.click();
  await page.waitForTimeout(300);
  const handle3 = await btn3.elementHandle();

  await panel.locator('[data-tw-toggle="radius"]').click();
  const cornerIn = (c) => panel.locator(`[data-tw-field="radius-${c}"] input`);
  const cornerVals = [];
  for (const c of ['tl', 'tr', 'bl', 'br']) cornerVals.push(await cornerIn(c).inputValue());
  check("each corner reads the route's own rung, not the stock ladder",
    cornerVals.every((v) => v === '12'), cornerVals.join('/'));

  await panel.locator('[data-tw-radius-corner="tl"]').click();
  await page.locator('[data-tw-radius="2xl"]').click();
  await page.waitForTimeout(600);
  const cornerCss = await handle3.evaluate((x) => {
    const s = getComputedStyle(x);
    return s.borderTopLeftRadius + ' / ' + s.borderTopRightRadius;
  });
  const cornerCls = await handle3.evaluate((x) => x.getAttribute('class'));
  check('a per-corner rung is written as rounded-tl-*',
    /(?:^| )rounded-tl-2xl(?: |$)/.test(cornerCls) && /(?:^| )rounded-lg(?: |$)/.test(cornerCls),
    cornerCls.split(' ').filter((c) => c.startsWith('rounded')).join(' ') || '(none)');
  // 21.6px, not the stock 16: Cora derives 2xl from --radius too, so this is
  // the number that says the corner's runtime rule was built from the live
  // value rather than from the ladder theme.css ships.
  check('it previews on that corner alone, and the other three hold at 12px',
    /^[\d.]+px \/ 12px$/.test(cornerCss) && !cornerCss.startsWith('12px'), cornerCss);

  await panel.locator('[data-tw-save]').click();
  await page.waitForTimeout(1200);
  const cornerDiff = coraCorner.split('\n')
    .map((l, i) => [i, l, snapshot(CORA).split('\n')[i]])
    .filter(([, a, b]) => a !== b);
  check('exactly one line changed writing a corner', cornerDiff.length === 1,
    cornerDiff.map(([i]) => i + 1).join(','));
  if (cornerDiff.length === 1) {
    const list = (l) => (/className="([^"]*)"/.exec(l) || [, l])[1].trim().split(/\s+/);
    const B = list(cornerDiff[0][1]), A = list(cornerDiff[0][2]);
    check('the corner class was added and nothing was taken away',
      A.filter((t) => !B.includes(t)).join() === 'rounded-tl-2xl' &&
      B.every((t) => A.includes(t)),
      `+${A.filter((t) => !B.includes(t)).join(' ')} -${B.filter((t) => !A.includes(t)).join(' ')}`);
  }

  // A radius shows nothing on an element with no edge to round, so the row
  // stays off — and stays one click away in the Add strip.
  await page.locator('fieldset').first().click({ position: { x: 3, y: 3 } });
  await page.waitForTimeout(300);
  check('unpainted element: the controls are off and the row offers them',
    !(await radiusRow.isVisible()) &&
    (await panel.locator('[data-tw-reveal="radius"]').isVisible()));

  // ---- typography: one section, and a family read off the page ----
  // Still on Cora: the route declares four families, one of them the project's
  // own (Square Peg behind `accent`), which is the case a list of Google's
  // fonts would get wrong in both directions.
  await page.goto(APP + '/experiments/cora/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const typo = await page.evaluate(() => {
    // What the overlay itself can see, by the rule it uses: a generated
    // .font-<name> whose declaration sets font-family. A weight utility sets
    // font-weight and cannot land here, which is the whole membership test.
    const out = {};
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      const walk = (rs) => { for (const r of rs) {
        if (r.selectorText && r.style) {
          const m = /^\.font-([a-zA-Z][a-zA-Z0-9-]*)$/.exec(r.selectorText);
          if (m && r.style.fontFamily) out[m[1]] = r.style.fontFamily;
        }
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
      } };
      if (rules) walk(rules);
    }
    return out;
  });
  check('families come off the page, not a config or a font service',
    Object.keys(typo).length >= 2 && !!typo.sans, Object.keys(typo).join(' '));
  check('a weight utility never reads as a family', !typo.medium && !typo.bold,
    Object.keys(typo).filter((k) => /^(medium|bold|semibold|light)$/.test(k)).join(' ') || 'none');

  // Addressed by what the loader stamped, never by a class: the radius block
  // above rewrites this same button's rounded-* on disk, so a selector naming
  // one is stale by the time this runs. If the section is standing in for
  // itself with a + row, that + is clicked, so the geometry below is measured
  // on all four fields whatever this element happens to carry.
  // It must carry TEXT OF ITS OWN — the section's `applies: hasText` means a
  // wrapper has neither the controls nor the + row standing in for them, and
  // measuring a section that correctly is not there reads as a broken panel.
  // It must also live in the Cora page, because the write below diffs that
  // file and that file is the one this run guarded.
  const typoCands = page.locator('[data-thisone-loc^="src/app/experiments/cora/login/page.tsx:"]');
  const typoTotal = await typoCands.count();
  let typoBtn = null;
  for (let i = 0; i < typoTotal; i++) {
    const c = typoCands.nth(i);
    const own = await c.evaluate((el) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.nodeValue.trim().length > 2) return true;
      }
      return false;
    });
    if (own) { typoBtn = c; break; }
  }
  if (!typoBtn) throw new Error('no element with its own text in the Cora page');
  await typoBtn.scrollIntoViewIfNeeded();
  await typoBtn.click({ force: true });
  await page.waitForTimeout(300);
  const typoReveal = panel.locator('[data-tw-reveal="typography"]');
  if (await typoReveal.isVisible()) {
    await typoReveal.click();
    await page.waitForTimeout(150);
  }

  // The frame: the family field across the stack, weight and size sharing the
  // line below it 12px apart, the alignment segment on the weight field's own
  // column under that. The
  // stack stops 42px short of the panel's edge — the space a section toggle
  // takes on every other row — so these three land on the padding row's
  // columns rather than a tile wider than them.
  const geo = await panel.evaluate((p) => {
    const box = (sel) => {
      const el = p.querySelector('[data-tw-section="typography"] ' + sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
    };
    return {
      label: p.querySelector('[data-tw-section="typography"] .bw-lbl').textContent,
      family: box('[data-tw-field="family"]'),
      weight: box('[data-tw-field="weight"]'),
      size: box('[data-tw-field="font"]'),
      align: box('[data-tw-field="align"]'),
    };
  });
  check('one section label, not three', geo.label === 'Typography', geo.label);
  check('the family field spans the pair beneath it',
    geo.family.w === geo.weight.w + 12 + geo.size.w && geo.family.h === 40,
    `${geo.family.w} vs ${geo.weight.w}+12+${geo.size.w}, h${geo.family.h}`);
  check('weight and size share the next line, 12px apart',
    geo.weight.y === geo.size.y && geo.size.x - (geo.weight.x + geo.weight.w) === 12,
    `gap ${geo.size.x - (geo.weight.x + geo.weight.w)}`);
  check('the rows sit 12px apart and 40px tall',
    geo.weight.y - (geo.family.y + geo.family.h) === 12 &&
    geo.align.y - (geo.weight.y + geo.weight.h) === 12 && geo.align.h === 40,
    `${geo.weight.y - (geo.family.y + geo.family.h)} / ${geo.align.y - (geo.weight.y + geo.weight.h)}`);
  // Not the frame's own 124: the segment asks for the pair's first column, so
  // it stands on the weight field's two edges rather than 5px inside its
  // right-hand one. A stretching column would give it all 270, which is the
  // other way this goes wrong.
  check('the segment is the column the weight field is, to the pixel',
    geo.align.w === geo.weight.w && geo.align.x === geo.weight.x,
    `${geo.align.w} at ${geo.align.x} vs ${geo.weight.w} at ${geo.weight.x}`);

  // ---- write a family, and prove exactly one token moved ----
  const famBefore = snapshot(CORA);
  await panel.locator('[data-tw-family-open]').click();
  const fpop = page.locator('[data-tw-pop]');
  await page.waitForTimeout(250);
  const listed = await fpop.locator('.bw-hue').count();
  check('the list offers exactly the families the page can render',
    listed === Object.keys(typo).length, `${listed} of ${Object.keys(typo).length}`);

  const pickName = Object.keys(typo).find((k) => !['sans', 'serif', 'mono'].includes(k)) || 'serif';
  const typoEl = await typoBtn.elementHandle();
  const famRenderedBefore = await typoEl.evaluate((x) => getComputedStyle(x).fontFamily);
  const clsBefore = (await typoEl.evaluate((x) => x.getAttribute('class'))).split(/\s+/);
  await fpop.locator(`[data-tw-family="${pickName}"]`).click();
  await page.waitForTimeout(400);
  const famRenderedAfter = await typoEl.evaluate((x) => getComputedStyle(x).fontFamily);
  check('the family previews with no rule added anywhere',
    famRenderedAfter !== famRenderedBefore, `${famRenderedBefore} → ${famRenderedAfter}`);

  // The font- trap, checked on the element itself: setting a family strips
  // families by membership, so a weight sharing the prefix must be untouched.
  const famCls = (await typoEl.evaluate((x) => x.getAttribute('class'))).split(/\s+/);
  const kept = clsBefore.filter((c) => c.indexOf('font-') !== 0 || !typo[c.slice(5)]);
  check('every class that was not a family survived the write',
    kept.every((c) => famCls.includes(c)),
    kept.filter((c) => !famCls.includes(c)).join(' ') || '(none lost)');
  check('the element wears exactly one family, the new one',
    famCls.filter((c) => c.indexOf('font-') === 0 && typo[c.slice(5)]).join() === 'font-' + pickName,
    famCls.filter((c) => c.indexOf('font-') === 0).join(' ') || '(none)');

  await panel.locator('[data-tw-save]').click();
  await page.waitForTimeout(1200);
  check('the family write was not refused',
    !/refus|cannot|failed/i.test(await panel.locator('[data-tw-status]').textContent()),
    (await panel.locator('[data-tw-status]').textContent()).slice(0, 90));
  const famAfter = snapshot(CORA);
  const famDiff = famBefore.split('\n')
    .map((l, i) => [i, l, famAfter.split('\n')[i]])
    .filter(([, a, b]) => a !== b);
  check('exactly one line changed writing the family', famDiff.length === 1,
    famDiff.map(([i]) => i + 1).join(',') || '(no line changed)');
  if (famDiff.length === 1) {
    const list = (l) => (/className="([^"]*)"/.exec(l) || [, l])[1].trim().split(/\s+/);
    const B = list(famDiff[0][1]), A = list(famDiff[0][2]);
    const added = A.filter((t) => !B.includes(t));
    const gone = B.filter((t) => !A.includes(t));
    check('the only token added on disk is the family',
      added.join() === 'font-' + pickName, `+${added.join(' ')} -${gone.join(' ')}`);
    check('nothing but a family was removed on disk',
      gone.every((t) => t.indexOf('font-') === 0 && typo[t.slice(5)]),
      gone.join(' ') || '(nothing removed)');
  }
  check('line count unchanged by the family write',
    famBefore.split('\n').length === famAfter.split('\n').length);

  // ---- a family the page uses but has generated no utility for ----
  //
  // Every one of these routes applies its own faces the way this one does —
  // `style={{ fontFamily: "var(--font-murmur)" }}` on the layout wrapper,
  // inherited all the way down — so the class `font-murmur` appears nowhere
  // in the source and Tailwind v4, which generates on demand, emits no rule
  // for it. Reading families off generated rules alone therefore offered the
  // three stock stacks the route barely uses and not the two it is drawn in.
  //
  // Murmur and not volt for the discovery half, and the reason is a trap:
  // Tailwind's dev server KEEPS a utility once it has generated one, even
  // after the class leaves the source again. So the route this suite writes
  // to stops being a route with no utility the moment it has run once, and an
  // assertion pinned there passes exactly once. Nothing below writes to
  // murmur, so nothing below spends it.
  await page.goto(APP + '/experiments/murmur/profile', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const murFonts = await readFontSources(page);
  check('the route declares theme keys it has generated no utility for',
    !!murFonts.themeVars.murmur && !murFonts.utils.murmur &&
    !!murFonts.themeVars['murmur-display'] && !murFonts.utils['murmur-display'],
    Object.keys(murFonts.themeVars).join(' ') + ' | utils ' + Object.keys(murFonts.utils).join(' '));
  // The reason `@layer theme` is the test rather than the `:root` selector:
  // next/font puts its own variables on a CSS-module class, and a
  // `font-geist-mono` written from one would preview here through a runtime
  // rule and generate nothing at all on the real build.
  check("next/font's variables sit outside the theme layer",
    !murFonts.themeVars['geist-mono'] && !!murFonts.otherVars['geist-mono'],
    Object.keys(murFonts.otherVars).join(' ') || '(none)');

  await selectTyped(page, panel, 'src/');
  await panel.locator('[data-tw-family-open]').click();
  await page.waitForTimeout(250);
  const mpop = page.locator('[data-tw-pop]');
  // face = note = tooltip, read in document order.
  const rowsOf = (pop) => pop.locator('.bw-hue').evaluateAll((els) => els.map((e) => ({
    token: e.getAttribute('data-tw-family'),
    face: e.querySelector('.bw-sizename').textContent,
    note: e.querySelector('.bw-sizepx').textContent,
    title: e.getAttribute('title'),
  })));
  const murRows = await rowsOf(mpop);
  const asText = murRows.map((r) => `${r.face}=${r.note}`).join(' ');
  check('a var-only family is offered, named by the face it resolves to',
    murRows.some((r) => r.token === 'murmur' && r.face === 'Inter') &&
    murRows.some((r) => r.token === 'murmur-display' && r.face === 'Space Grotesk'), asText);
  check('a variable outside the theme layer is offered by nobody',
    !murRows.some((r) => /geist/.test(r.token)), murRows.map((r) => r.token).join(' '));
  // The note is the CSS generic and never the project's own slot name, which
  // is the one column that has to read the same whatever project this is
  // pointed at. Ordered by that generic too, so like stands with like — the
  // project's own token leading its run, since on murmur `sans` is a stock
  // stack the route never draws in and `murmur` is the Inter it does.
  const GENERICS = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];
  check('every note is one of the five CSS generics, and nothing else',
    murRows.every((r) => GENERICS.includes(r.note)),
    murRows.map((r) => r.note).join(' '));
  check('the list is ordered by generic, project token leading its run',
    asText === 'Inter=sans-serif Space Grotesk=sans-serif SF Pro=sans-serif ' +
      'Georgia=serif Menlo=monospace', asText);
  // The token is not lost by leaving the row — it is in the tooltip with the
  // stack it resolves to, which is where this panel keeps the exact thing
  // behind every value.
  check('the tooltip still names the class and the stack behind it',
    murRows.every((r) => r.title.indexOf('font-' + r.token + ' \u2014 ') === 0),
    murRows.map((r) => r.title.slice(0, 24)).join(' | '));
  // A row's mark stands on the popover's 20px gutter, where the header above
  // it already stands.
  const capX = await mpop.evaluate((p) => {
    const base = p.getBoundingClientRect().left;
    const tx = (e) => { const r = document.createRange(); r.selectNodeContents(e); return Math.round(r.getBoundingClientRect().left - base); };
    return {
      title: tx(p.querySelector('.bw-pop-h strong') || p.querySelector('.bw-search-in')),
      spec: tx(p.querySelector('.bw-pop-body > .bw-hue .bw-sizesample')),
    };
  });
  check('specimen and title stand on one gutter',
    capX.spec === capX.title, JSON.stringify(capX));
  await page.keyboard.press('Escape');

  // The shelving rule is the CSS language's, not this project's, so it is
  // tested with keys this project does not have. One resolves to a generic
  // nobody here uses; the other resolves to no generic at all, and a stack
  // that names none says nothing about what kind of type it is — so it is not
  // offered rather than filed under a heading that would be a guess. That
  // matters far past these three routes: the editor has to hold for projects
  // nobody has measured, and a rule that guesses guesses differently in each.
  await page.addStyleTag({ content:
    '@layer theme { :root, :host {' +
    '  --font-bwprobe-script: "Probe Script", cursive;' +
    '  --font-bwprobe-nameonly: "Probe Face A", "Probe Face B";' +
    '} }' });
  // Discovery re-runs in select(), and re-clicking the element already
  // selected does not re-enter it — so this asks for a different one.
  await selectTyped(page, panel, 'src/', 1);
  await panel.locator('[data-tw-family-open]').click();
  await page.waitForTimeout(250);
  const probeRows = await rowsOf(mpop);
  const last = probeRows[probeRows.length - 1];
  check('a generic this project never uses is still said in full',
    last.token === 'bwprobe-script' && last.note === 'cursive',
    probeRows.map((r) => r.token + '=' + r.note).join(' '));
  check('a stack that names no generic is not offered at all',
    !probeRows.some((r) => /nameonly/.test(r.token)),
    probeRows.map((r) => r.token).join(' '));
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('style')) {
      if (s.textContent.indexOf('--font-bwprobe-') !== -1) s.remove();
    }
  });

  // ---- and writing one, on the route this suite is allowed to touch ----
  await page.goto(APP + '/experiments/volt/design-system', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const voltFonts = await readFontSources(page);
  // Derived, never written down, for the dev-server reason above: whichever
  // theme key still has no utility is the one worth writing, and if a
  // previous run has spent them all the branch below asserts the other half
  // of the same rule instead.
  const varOnly = Object.keys(voltFonts.themeVars).filter((t) => !voltFonts.utils[t]);
  const famTarget = varOnly.includes('volt-mono') ? 'volt-mono' : (varOnly[0] || 'volt-mono');
  const famPreBuilt = !!voltFonts.utils[famTarget];
  const voltEl = await selectTyped(page, panel, 'src/app/experiments/volt/design-system/page.tsx:');
  await panel.locator('[data-tw-family-open]').click();
  await page.waitForTimeout(250);
  const vpop = page.locator('[data-tw-pop]');

  const voltFileBefore = snapshot(VOLT);
  await vpop.locator(`[data-tw-family="${famTarget}"]`).click();
  await page.waitForTimeout(400);
  // Against the stack the token resolves to, not against "it changed": which
  // face a key lands on is the project's business, and a key that happens to
  // name the face already inherited would make a changed/unchanged assertion
  // vacuous without saying so.
  const facePaint = await page.evaluate(([stack, sel]) => {
    const el = document.querySelector(sel);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;left:-9999px;font-family:' + stack;
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).fontFamily;
    probe.remove();
    return { want, got: getComputedStyle(el).fontFamily };
  }, [voltFonts.themeVars[famTarget], `[data-thisone-loc="${await voltEl.getAttribute('data-thisone-loc')}"]`]);
  check('the family the token names is the family the element renders',
    facePaint.got === facePaint.want, `${facePaint.got} vs ${facePaint.want}`);

  // The rule the page does not have, and the rule it must not be given: a
  // scoped copy over a utility the route already owns outranks that route's
  // own responsive variants, which is the px-6 md:px-12 failure.
  const dynFam = await page.evaluate((t) => {
    const s = document.querySelector('style[data-tw-editor="dynamic"]');
    return s ? Array.from(s.sheet.cssRules).map((r) => r.cssText)
      .filter((x) => x.indexOf('font-' + t) !== -1) : [];
  }, famTarget);
  check(famPreBuilt
    ? 'no runtime rule where the page already owns one'
    : 'one runtime rule where the page owns none',
    dynFam.length === (famPreBuilt ? 0 : 1),
    `${famTarget}: ${dynFam.join(' | ').slice(0, 80) || '(none)'}`);
  await panel.locator('[data-tw-family-open]').click();
  await page.waitForTimeout(250);
  await vpop.locator('[data-tw-family="sans"]').click();
  await page.waitForTimeout(300);
  const dynSans = await page.evaluate(() => {
    const s = document.querySelector('style[data-tw-editor="dynamic"]');
    return s ? Array.from(s.sheet.cssRules).map((r) => r.cssText)
      .filter((x) => x.indexOf('font-sans') !== -1) : [];
  });
  check('a family the page generated is never given a scoped copy',
    dynSans.length === 0, dynSans.join(' | ').slice(0, 80) || '(none)');
  await panel.locator('[data-tw-family-open]').click();
  await page.waitForTimeout(250);
  await vpop.locator(`[data-tw-family="${famTarget}"]`).click();
  await page.waitForTimeout(400);

  await panel.locator('[data-tw-save]').click();
  await page.waitForTimeout(1200);
  check('the theme-key family write was not refused',
    !/refus|cannot|failed/i.test(await panel.locator('[data-tw-status]').textContent()),
    (await panel.locator('[data-tw-status]').textContent()).slice(0, 90));
  const voltFileAfter = snapshot(VOLT);
  const voltDiff = voltFileBefore.split('\n')
    .map((l, i) => [i, l, voltFileAfter.split('\n')[i]])
    .filter(([, a, b]) => a !== b);
  check('exactly one line changed writing the theme-key family', voltDiff.length === 1,
    voltDiff.map(([i]) => i + 1).join(',') || '(no line changed)');
  if (voltDiff.length === 1) {
    const list = (l) => (/className="([^"]*)"/.exec(l) || [, l])[1].trim().split(/\s+/);
    const added = list(voltDiff[0][2]).filter((t) => !list(voltDiff[0][1]).includes(t));
    check('the only token added on disk is the theme-key family',
      added.join() === 'font-' + famTarget, '+' + added.join(' '));
  }

  // The assertion the whole second source rests on: a theme key really does
  // become a utility once the class is in the source. Poll, never wait a fixed
  // number of milliseconds — Turbopack's recompile is not on a clock.
  const built = await page.waitForFunction((t) => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      const walk = (rs) => { for (const r of rs) {
        if (r.selectorText === '.font-' + t && r.style && r.style.fontFamily) return true;
        if (r.cssRules && r.cssRules.length && walk(r.cssRules)) return true;
      } return false; };
      if (rules && walk(rules)) return true;
    }
    return false;
  }, famTarget, { timeout: 20000 }).then(() => true).catch(() => false);
  check('Tailwind generated the utility the theme key promised', built,
    built ? 'font-' + famTarget : 'never appeared');

  await page.goto(APP + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // ---- refusal: template-literal className must not be touched ----
  const loc = await page.evaluate(() => document.documentElement.getAttribute('data-thisone-loc'));
  const refusal = await page.evaluate(
    async ([ed, id]) => {
      const r = await fetch(ed + '/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.__TW_EDITOR__.token },
        body: JSON.stringify({ edits: [{ id, classes: 'p-4' }] }),
      });
      return { status: r.status, body: await r.json() };
    },
    [EDITOR, loc]
  );
  check('template-literal className refused', refusal.status === 422, JSON.stringify(refusal.body).slice(0, 120));
  check('refusal names the reason', refusal.body.reason === 'template-literal', refusal.body.reason);
  check('layout.tsx byte-identical after refusal', snapshot(LAYOUT) === layoutBefore);

  // ---- security ----
  const sec = await page.evaluate(
    async ([ed, id]) => {
      const post = (headers, body) =>
        fetch(ed + '/edit', { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.status);
      const tok = window.__TW_EDITOR__.token;
      return {
        noToken: await post({ 'Content-Type': 'application/json' }, { edits: [] }),
        badToken: await post({ 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, { edits: [] }),
        badType: await post({ 'Content-Type': 'text/plain', Authorization: 'Bearer ' + tok }, { edits: [] }),
        escape: await post(
          { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
          { edits: [{ id: '../../../etc/passwd:1:1:deadbeef', classes: 'p-4' }] }
        ),
      };
    },
    [EDITOR, loc]
  );
  check('missing token → 401', sec.noToken === 401, String(sec.noToken));
  check('bad token → 401', sec.badToken === 401, String(sec.badToken));
  check('non-JSON content-type → 415', sec.badType === 415, String(sec.badType));
  check('path escape → 403', sec.escape === 403, String(sec.escape));

  // ---- removing an element ----
  //
  // Nothing is destroyed until Save, so most of this is about what has NOT
  // happened yet.
  const xHandle = page.locator('[data-tw-delete]');
  const notice = panel.locator('[data-tw-field="removed"]');

  // A component root cannot go: removing it would leave nothing to return.
  await page.goto(APP + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const rootBefore = snapshot(PAGE);
  await page.locator('[data-thisone-loc^="src/app/page.tsx:5:5:"]').click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(250);
  check('the delete handle appears on a selection', await xHandle.isVisible());
  await xHandle.click();
  await panel.locator('[data-tw-save]').click();
  await page.waitForTimeout(1200);
  const rootStatus = await panel.locator('[data-tw-status]').textContent();
  check('removing a component root is refused, by name',
    /returns|render/i.test(rootStatus), JSON.stringify(rootStatus));
  check('the refusal wrote nothing', snapshot(PAGE) === rootBefore);
  check('the pending removal is kept, not silently dropped',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Save 1 change',
    await panel.locator('[data-tw-save]').textContent());
  await panel.locator('[data-tw-undo-remove]').click();

  // Blast radius: one line, nineteen elements, all ghosted and all counted.
  await page.goto(APP + '/experiments/volt/design-system', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const voltBefore = snapshot(VOLT);
  const shared = page.locator('[data-thisone-loc^="src/app/experiments/volt/design-system/page.tsx:555:9:"]').first();
  await shared.scrollIntoViewIfNeeded();
  await shared.click();
  await page.waitForTimeout(250);
  await xHandle.click();
  await page.waitForTimeout(250);
  const noticeText = await notice.textContent();
  check('the panel names the blast radius before you can save',
    /renders 19 elements/.test(noticeText) && /removes all 19/.test(noticeText),
    JSON.stringify(noticeText));
  check('all 19 instances are ghosted, not just the one clicked',
    (await page.locator('[data-tw-removed]').count()) === 19,
    String(await page.locator('[data-tw-removed]').count()));
  check('marking wrote nothing to disk', snapshot(VOLT) === voltBefore);
  await panel.locator('[data-tw-undo-remove]').click();
  await page.waitForTimeout(200);
  check('undo clears all 19 ghosts', (await page.locator('[data-tw-removed]').count()) === 0);
  check('undo drops the pending change',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Saved');

  // Same line, same nineteen elements, this time for a class. Removal has
  // always shown the whole group; a class change used to move one element and
  // leave the other eighteen sitting still, which is the preview disagreeing
  // with the save that is about to happen.
  const SHARED = '[data-thisone-loc^="src/app/experiments/volt/design-system/page.tsx:555:9:"]';
  const group = page.locator(SHARED);
  const carrying = (cls) => group.evaluateAll(
    (els, c) => els.filter((e) => e.classList.contains(c)).length, cls);
  const classList = async () =>
    ((await shared.getAttribute('class')) || '').split(/\s+/).filter(Boolean);

  await shared.scrollIntoViewIfNeeded();
  await shared.click({ force: true });
  await page.waitForTimeout(300);
  const before = await classList();
  const padField = panel.locator('[data-tw-field="p-y"] input').first();
  await padField.fill('28');
  await padField.press('Enter');
  await page.waitForTimeout(400);

  // Derived, never hardcoded: 28px lands on a rung or on an arbitrary value
  // depending on what this route has already generated, and the mirror is
  // about the class travelling rather than about which class it is.
  const added = (await classList()).filter((c) => before.indexOf(c) === -1);
  check('the padding edit added exactly one class', added.length === 1, added.join(' '));
  check('a class written on one instance shows on all 19',
    (await carrying(added[0])) === 19,
    `${added[0]} on ${await carrying(added[0])} of ${await group.count()}`);
  check('every instance is marked so the preview stylesheet reaches it',
    (await page.locator(SHARED + '[data-thisone-edited]').count()) === 19,
    String(await page.locator(SHARED + '[data-thisone-edited]').count()));
  check('the group is still one pending change, not nineteen',
    (await panel.locator('[data-tw-save]').textContent()).trim() === 'Save 1 change',
    (await panel.locator('[data-tw-save]').textContent()).trim());
  check('mirroring wrote nothing to disk', snapshot(VOLT) === voltBefore);

  await panel.locator('[data-tw-undo]').click();
  await page.waitForTimeout(400);
  check('undo takes the class off all 19', (await carrying(added[0])) === 0,
    String(await carrying(added[0])));
  check('undo clears the preview marker across the group',
    (await page.locator(SHARED + '[data-thisone-edited]').count()) === 0,
    String(await page.locator(SHARED + '[data-thisone-edited]').count()));

  // And now a real one, written and diffed.
  await page.goto(APP + '/experiments/cora/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const cutOrig = snapshot(CORA).split('\n');
  // NOT by class: the radius block rewrote this button's rounded-full to
  // rounded-lg earlier in the same run. type is what does not move.
  const doomed = page.locator('button[type="submit"]').first();
  await doomed.scrollIntoViewIfNeeded();
  await doomed.click();
  await page.waitForTimeout(250);
  await xHandle.click();
  await page.waitForTimeout(200);
  check('a one-instance location says so plainly',
    /cut from the source file/.test(await notice.textContent()),
    JSON.stringify(await notice.textContent()));
  await panel.locator('[data-tw-save]').click();
  await page.waitForTimeout(1500);

  // The exact property: the file is the original minus ONE contiguous run of
  // lines. A reflow, a moved brace or a stray second edit all break it.
  const cutAfter = snapshot(CORA).split('\n');
  let head = 0;
  while (head < cutAfter.length && cutAfter[head] === cutOrig[head]) head++;
  let tail = 0;
  while (tail < cutAfter.length - head &&
         cutAfter[cutAfter.length - 1 - tail] === cutOrig[cutOrig.length - 1 - tail]) tail++;
  const cut = cutOrig.slice(head, cutOrig.length - tail);
  check('the file is the original minus one contiguous run of lines',
    head + tail === cutAfter.length &&
    cutOrig.slice(0, head).concat(cutOrig.slice(cutOrig.length - tail)).join('\n') === cutAfter.join('\n'),
    `${cut.length} lines cut at ${head + 1}`);
  check('the run that went is exactly the element',
    /<button/.test(cut[0]) && /<\/button>/.test(cut[cut.length - 1]),
    JSON.stringify([cut[0].trim(), cut[cut.length - 1].trim()]));
  check('no blank line was left where it stood', !/\n[ \t]+\n/.test(cutAfter.join('\n')));
  // The overlay must NOT take it off the page itself — pulling a node out from
  // under React makes the next reconcile throw. HMR is what removes it.
  check('HMR re-rendered the page without it',
    await settled(() => !document.querySelector('button[type="submit"]')));

  check('no page errors throughout', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: path.join(__dirname, '..', 'next-verify.png') });
  } catch (err) {
    check('the run completed without throwing', false, err.message.split('\n')[0]);
  } finally {
    if (browser) await browser.close();
    console.log('');
    guards.forEach((g) => results.push(restore(g)));
  }

  const failed = results.filter((r) => !r).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
