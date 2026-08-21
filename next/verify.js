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
  const dest = path.join(BACKUPS, path.basename(file) + '.' + Date.now() + '.bak');
  fs.copyFileSync(file, dest);
  return { file, dest, before: snapshot(file) };
}
function restore(g) {
  fs.writeFileSync(g.file, g.before);
  const ok = snapshot(g.file) === g.before;
  console.log(`${ok ? 'PASS' : 'FAIL'}  restored ${path.basename(g.file)} byte-exactly` +
    (ok ? '' : `  — BACKUP KEPT AT ${g.dest}`));
  if (ok) fs.unlinkSync(g.dest);
  return ok;
}

(async () => {
  const guards = [guard(PAGE), guard(LAYOUT)];
  const pageBefore = guards[0].before;
  const layoutBefore = guards[1].before;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(APP + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // ---- overlay reached a real Next page ----
  const panel = page.locator('[data-tw-editor="panel"]');
  check('overlay mounted in the Next app', (await panel.count()) === 1);

  const target = page.locator('[data-bw-loc^="src/app/page.tsx:5:5:"]');
  check('loader stamped the page.tsx element', (await target.count()) === 1,
    await target.getAttribute('data-bw-loc'));

  // ---- select and preview ----
  await target.click({ position: { x: 5, y: 5 } });
  check('panel opened', await panel.isVisible());
  check('panel names the source location',
    (await panel.locator('strong').first().textContent()).includes('page.tsx:5'),
    await panel.locator('strong').first().textContent());
  // Text editing is enabled for JSX now (a lone static JsxText child); the row
  // mirrors the element's own text, or explains why it cannot be edited.
  const textRow = await panel.locator('[data-tw-field="text"] div').textContent();
  check('Text row reflects the element', textRow.length > 0, JSON.stringify(textRow.slice(0, 60)));

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

  const SEL = '[data-bw-loc^="src/app/page.tsx:5:5:"]';
  const bgBefore = (await rgbOf(SEL)).actual;
  await pickColor(panel, 'bg', 'emerald', '500');
  const bgAfter = await rgbOf(SEL);
  check('INSTANT PREVIEW: computed background actually changed',
    bgAfter.actual !== bgBefore && bgAfter.actual === bgAfter.emerald,
    `${bgBefore} → ${bgAfter.actual} (emerald ${bgAfter.emerald})`);
  check('preview opt-in attribute was set',
    (await target.getAttribute('data-bw-edited')) !== null);

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
  await page.waitForTimeout(2500);
  const hmr = await page.evaluate(() => {
    const el = document.querySelector('[data-bw-loc^="src/app/page.tsx:5:5:"]');
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

  // ---- refusal: template-literal className must not be touched ----
  const loc = await page.evaluate(() => document.documentElement.getAttribute('data-bw-loc'));
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

  check('no page errors throughout', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: path.join(__dirname, '..', 'next-verify.png') });
  await browser.close();

  console.log('');
  guards.forEach((g) => results.push(restore(g)));

  const failed = results.filter((r) => !r).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
