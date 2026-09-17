/**
 * The playground: a Next page edited with no server.
 *
 * The demo is only worth showing while it does what the package does. So the
 * loader and writer it runs must be the shipped ones, the file it ends with
 * must be the file next/server.js would have written for the same edits, and
 * after every save the page on screen must be the page that file renders.
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const core = require('../demo/core.js');
const adapter = require('../next/jsx-adapter.js');

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SOURCE = read('demo/app/page.tsx');
const ABS = core.ROOT + '/' + core.FILE;
const locsOf = (html) => [...html.matchAll(/data-thisone-loc="([^"]+)"/g)].map((m) => m[1]);

// ------------------------------------------------------------------ unit

const samples = ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '★ 4.97 – é\n'.repeat(40), SOURCE];
check('the browser sha256 matches node crypto, multibyte and block edges included',
  samples.every((s) => core.sha256Hex(s) === crypto.createHash('sha256').update(s).digest('hex')));

const mods = core.boot(ts, { 'jsx-adapter': read('next/jsx-adapter.js'), loader: read('next/loader.cjs') });
const realStamp = require('../next/loader.cjs').call(
  { getOptions: () => ({ root: core.ROOT }), rootContext: core.ROOT, resourcePath: ABS }, SOURCE);
check('the shipped loader, run behind the shim, stamps byte for byte what it stamps in node',
  mods.stamp(SOURCE) === realStamp);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thisone-demo-'));
execFileSync(process.execPath, [path.join(ROOT, 'demo/build.mjs'), '--out', work], { stdio: 'pipe' });
const built = fs.readFileSync(path.join(work, 'index.html'), 'utf8');
check('the prerendered page carries the stamps node renders',
  JSON.stringify(locsOf(built)) === JSON.stringify(locsOf(core.render(ts, realStamp))),
  `${locsOf(built).length} elements`);
check('the build ships jsx-adapter.js and loader.cjs unchanged', (() => {
  const code = fs.readFileSync(path.join(work, 'sources.js'), 'utf8');
  const shipped = JSON.parse(code.slice(code.indexOf('=') + 1).trim().replace(/;$/, '').replace(/\\u003c/g, '<'));
  return shipped['jsx-adapter'] === read('next/jsx-adapter.js') && shipped.loader === read('next/loader.cjs');
})());

// --------------------------------------------------------------- browser

/** The file next/server.js would hold after the same batch. */
function serverWrites(source, batch) {
  const edits = batch.map((e) => ({ ...e, loc: adapter.parseLoc(e.id), remove: e.remove === true }));
  return adapter.editFile(ts, ABS, source, edits);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Every batch the overlay posts, so each save can be replayed through node.
  await page.addInitScript(() => {
    window.__batches = [];
    const orig = window.fetch;
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      get() { return this.__fetch || orig; },
      set(fn) {
        this.__fetch = function (input, init) {
          if (init && init.body && /edit$/.test(String(input))) window.__batches.push(JSON.parse(init.body).edits);
          return fn(input, init);
        };
      },
    });
  });

  try {
    await page.goto(pathToFileURL(path.join(work, 'index.html')).href, { waitUntil: 'load' });
    await page.evaluate(() => window.__DEMO__.ready);

    const panel = page.locator('[data-tw-editor="panel"]');
    const status = panel.locator('[data-tw-status]');
    const demoSource = () => page.evaluate(() => window.__DEMO__.source());
    const save = async () => {
      const before = (await page.evaluate(() => window.__batches.length));
      const renders = await page.evaluate(() => window.__DEMO__.renders);
      await panel.locator('[data-tw-save]').click();
      await page.waitForFunction(() => /written|failed|changed|<|several/.test(
        document.querySelector('[data-tw-status]')?.textContent || ''), null, { timeout: 8000 });
      const text = (await status.textContent()).trim();
      const batch = await page.evaluate((n) => window.__batches[n], before);
      // The reload lands a tick after the reply. A refusal never gets one.
      if (/written/.test(text)) {
        await page.waitForFunction((n) => window.__DEMO__.renders > n, renders, { timeout: 4000 });
      }
      return { text, batch };
    };

    check('it opens in edit mode with a title selected',
      await panel.isVisible() && (await panel.locator('strong, [data-tw-title]').first().textContent()).includes('h2'));

    // ---- a class change ----
    const badge = page.locator('#app span', { hasText: 'Guest favorite' });
    await badge.click();
    const px = panel.locator('[data-tw-field="p-x"] input');
    await px.focus();
    await px.press('ArrowUp');
    await px.blur();
    let r = await save();
    check('a class change saves', /written to page\.tsx/.test(r.text), r.text);
    let expected = serverWrites(SOURCE, r.batch);
    let now = await demoSource();
    check('...to the file next/server.js would have written', expected.ok && now === expected.contents);
    const changed = SOURCE.split('\n').filter((l, i) => l !== now.split('\n')[i]);
    check('...one line of it', changed.length === 1 && SOURCE.split('\n').length === now.split('\n').length, changed[0]?.trim());

    // ---- a second save, which only works if the reload refreshed the hash ----
    const title = page.locator('#app h2', { hasText: 'Oia, Greece' });
    await title.click();
    await panel.locator('[data-tw-text]').fill('Oia, Santorini');
    await panel.locator('[data-tw-text]').blur();
    let prev = now;
    r = await save();
    check('a second save is not refused as stale', /written to page\.tsx/.test(r.text), r.text);
    expected = serverWrites(prev, r.batch);
    now = await demoSource();
    check('...and matches the server byte for byte', expected.ok && now === expected.contents);

    // ---- a removal, where the reload replaces children rather than patching ----
    const fresh = page.locator('#app span', { hasText: 'New' });
    await fresh.click();
    await page.locator('[data-tw-delete]').click();
    prev = now;
    r = await save();
    check('a delete saves', /written to page\.tsx/.test(r.text), r.text);
    expected = serverWrites(prev, r.batch);
    now = await demoSource();
    check('...the same cut the server makes', expected.ok && now === expected.contents);
    check('...one line shorter', now.split('\n').length === prev.split('\n').length - 1);
    check('...and gone from the page', (await page.locator('#app span', { hasText: /^New$/ }).count()) === 0);

    // ---- the page on screen is the page the file renders ----
    const live = await page.evaluate(() => [...document.querySelectorAll('#app [data-thisone-loc]')]
      .map((el) => el.getAttribute('data-thisone-loc')));
    const want = locsOf(core.render(ts, mods.stamp(now)));
    check('after three saves every stamp on screen is the one the file renders',
      JSON.stringify(live) === JSON.stringify(want), `${live.length} vs ${want.length}`);

    // And one more save on top, through the replaced subtree.
    const price = page.locator('#app h2', { hasText: 'Bedugul, Bali' });
    await price.click();
    await panel.locator('[data-tw-text]').fill('Bedugul, Indonesia');
    await panel.locator('[data-tw-text]').blur();
    prev = now;
    r = await save();
    expected = serverWrites(prev, r.batch);
    check('an element in the replaced card still saves', /written/.test(r.text) && now !== (await demoSource())
      && (await demoSource()) === expected.contents, r.text);

    check('no page errors', errors.length === 0, errors.join(' | '));

    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => window.__DEMO__.ready);
    check('a reload starts the file over', (await demoSource()) === SOURCE);
  } finally {
    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
