/**
 * A static site, not a single page: several .html files, a stylesheet beside
 * them, and one editing session that saves more than once.
 *
 * The pages here are written in the hand of a real file (single quotes, an
 * unquoted value, a comment with odd spacing), because the claim is that a save
 * changes one span and the rest of the file comes back byte for byte.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const INDEX = process.env.TW_EDITOR_FILE;
const BASE = process.env.TW_EDITOR_URL || 'http://localhost:3000';
if (!INDEX) { console.error('TW_EDITOR_FILE not set - run via `npm test`'); process.exit(2); }
const SITE = path.dirname(INDEX);

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const ABOUT = [
  '<!DOCTYPE html>',
  '<html lang=en>',
  '<head>',
  '<meta charset="utf-8">',
  '<title>About &amp; contact</title>',
  '<script src="/tailwind-browser.js"></script>',
  "<link rel='stylesheet' href='styles.css'>",
  '</head>',
  '<body>',
  '<!--  hand   written  -->',
  "<main class='p-6'>",
  '  <h1 class="site-title text-2xl">About us</h1>',
  '  <p class="p-4 text-slate-500">We make things.</p>',
  '  <p class="p-2">Second paragraph.</p>',
  '  <img src=logo.png alt="" class=w-4>',
  '</main>',
  '</body>',
  '</html>',
  '',
].join('\n');

const BLOG = '<!DOCTYPE html>\n<html><body>\n<h1 class="p-4">Blog</h1>\n</body></html>\n';
const CSS = '.site-title { letter-spacing: 3px; }\n';

const aboutFile = path.join(SITE, 'about.html');
const read = (f) => fs.readFileSync(f, 'utf8');

async function step(panel, field, dir) {
  const input = panel.locator(`[data-tw-field="${field}"] input`);
  await input.focus();
  await input.press(dir === 'down' ? 'ArrowDown' : 'ArrowUp');
  await input.blur();
}

(async () => {
  fs.writeFileSync(aboutFile, ABOUT);
  fs.writeFileSync(path.join(SITE, 'styles.css'), CSS);
  fs.writeFileSync(path.join(SITE, 'logo.png'), '');
  fs.mkdirSync(path.join(SITE, 'blog'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'blog', 'index.html'), BLOG);
  const indexBefore = read(INDEX);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console error]', m.text()); });

  // ---------- the site is served, not one page ----------
  const css = await page.request.get(BASE + '/styles.css');
  check('the stylesheet beside the page is served',
    css.status() === 200 && /text\/css/.test(css.headers()['content-type']) && (await css.text()) === CSS,
    `${css.status()} ${css.headers()['content-type']}`);

  for (const url of ['/about.html', '/about', '/blog/', '/blog']) {
    const want = url.startsWith('/blog') ? 'blog/index.html' : 'about.html';
    const body = await (await page.request.get(BASE + url)).text();
    check(`${url} is stamped as ${want}`,
      body.includes(`data-thisone-loc="${want}:`) && body.includes('/editor.js'));
  }

  const missing = await page.request.get(BASE + '/nope.html');
  check('a page that is not there is a 404, not the index', missing.status() === 404, missing.status());

  await page.goto(BASE + '/about.html', { waitUntil: 'networkidle' });
  const spacing = await page.locator('h1').evaluate((el) => getComputedStyle(el).letterSpacing);
  check("the page's own stylesheet applies", spacing === '3px', spacing);

  // ---------- one session, three saves, no reload ----------
  await page.locator('[data-tw-mode]').click();
  const panel = page.locator('[data-tw-editor="panel"]');
  const saveBtn = panel.locator('[data-tw-save]');
  const saved = async () => {
    await page.evaluate(() => { document.querySelector('[data-tw-status]').textContent = ''; });
    await saveBtn.click();
    await page.waitForFunction(() => /written|failed|changed|>/.test(
      document.querySelector('[data-tw-status]')?.textContent || ''), null, { timeout: 5000 });
    return panel.locator('[data-tw-status]').textContent();
  };

  const first = page.locator('[data-thisone-loc^="about.html:13:3:"]');
  await first.click();
  await step(panel, 'p-x', 'up');
  const s1 = await saved();
  check('the first save names the file it wrote', s1.includes('about.html'), s1);

  const afterOne = read(aboutFile);
  const lines = (s) => s.split('\n');
  const changed = lines(ABOUT).filter((l, i) => l !== lines(afterOne)[i]);
  check('one line of about.html changed, and only its class value',
    changed.length === 1 && lines(afterOne).length === lines(ABOUT).length
      && /^ {2}<p class="[^"]*px-\[17px\][^"]*">We make things\.<\/p>$/.test(lines(afterOne)[12]),
    lines(afterOne)[12]);
  check('the quoting, the comment and the unquoted src are as they were typed',
    afterOne.includes("<main class='p-6'>") && afterOne.includes('<!--  hand   written  -->')
      && afterOne.includes('<img src=logo.png alt="" class=w-4>') && afterOne.includes('<html lang=en>'));
  check('index.html was not touched', read(INDEX) === indexBefore);

  // The ids on the page were stamped from bytes that no longer exist. Without
  // the rename this save is refused as stale.
  const second = page.locator('[data-thisone-loc^="about.html:14:3:"]');
  await second.click();
  await step(panel, 'p-x', 'up');
  const s2 = await saved();
  check('a second save in the same session is written, not refused as stale', s2.includes('written'), s2);
  check('and it landed on the second paragraph',
    /px-\[9px\]/.test(lines(read(aboutFile))[13]), lines(read(aboutFile))[13]);

  // Removing a line moves everything below it up one.
  await first.click();
  await page.locator('[data-tw-delete]').click();
  const s3 = await saved();
  check('a removal is written', s3.includes('written'), s3);
  const afterCut = read(aboutFile);
  check('the paragraph is gone and its line closed over',
    !afterCut.includes('We make things') && lines(afterCut).length === lines(ABOUT).length - 1);

  const img = page.locator('img[data-thisone-loc]');
  const imgId = await img.getAttribute('data-thisone-loc');
  check('the element below the cut was renamed up a line', imgId.startsWith('about.html:14:3:'), imgId);

  await page.locator('[data-thisone-loc^="about.html:13:3:"]').click();
  await step(panel, 'p-x', 'up');
  const s4 = await saved();
  check('and a save after the removal still lands', s4.includes('written')
    && /px-2\.5/.test(lines(read(aboutFile))[12]), `${s4} / ${lines(read(aboutFile))[12]}`);

  const renamed = await img.getAttribute('data-thisone-loc');
  await page.reload({ waitUntil: 'networkidle' });
  const fresh = await page.locator('img[data-thisone-loc]').getAttribute('data-thisone-loc');
  check('the renamed id is the id a fresh load stamps', fresh === renamed, `${renamed} / ${fresh}`);

  // ---------- the root is a wall ----------
  const outside = path.join(path.dirname(SITE), path.basename(SITE) + '-outside.html');
  fs.writeFileSync(outside, '<p class="a">x</p>\n');
  try {
    const hash = require('../html-adapter').hashOf(read(outside));
    const res = await page.request.post(BASE + '/edit', {
      data: { id: `../${path.basename(outside)}:1:1:${hash}`, classes: 'b' },
    });
    check('an id pointing outside the site is refused', res.status() === 404, res.status());
    check('and the file outside was not written', read(outside) === '<p class="a">x</p>\n');
  } finally {
    fs.rmSync(outside, { force: true });
  }

  // ---------- a site built with the Tailwind CLI: no compiler in the page ----------
  //
  // The stylesheet holds only the classes the source had when it was built, so
  // a class the editor invents renders nothing unless the preview sheet
  // supplies it. Built here with the real compiler, the way the CLI would.
  const BUILT = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><link rel="stylesheet" href="built.css"></head>',
    '<body>',
    '<section class="px-6 md:px-12">wide</section>',
    '<div class="p-4 bg-white">card</div>',
    '</body></html>',
    '',
  ].join('\n');
  const builtFile = path.join(SITE, 'built.html');
  const repoModules = path.join(__dirname, '..', 'node_modules');
  const linked = path.join(SITE, 'node_modules');
  if (!fs.existsSync(linked)) fs.symlinkSync(repoModules, linked, 'dir');

  const tailwind = require('tailwindcss');
  const twFile = (id) => require.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id);
  const compiler = await tailwind.compile('@import "tailwindcss" source(none);', {
    base: SITE,
    onDependency() {},
    loadStylesheet: async (id, base) => {
      const file = id.startsWith('.') ? path.resolve(base, id) : twFile(id);
      return { path: file, base: path.dirname(file), content: read(file) };
    },
    loadModule() { throw new Error('no modules'); },
  });
  fs.writeFileSync(path.join(SITE, 'built.css'), compiler.build(['px-6', 'md:px-12', 'p-4', 'bg-white']));
  fs.writeFileSync(builtFile, BUILT);
  // The input the build came from, where a real project keeps it.
  fs.mkdirSync(path.join(SITE, 'src'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'src', 'input.css'), '@import "tailwindcss" source(none);\n');
  const builtCssOnDisk = read(path.join(SITE, 'built.css'));

  const served = await (await page.request.get(BASE + '/built.html')).text();
  check('a page with no browser build is given the preview sheet and told to scope to it',
    served.includes('/thisone-palette.css') && served.includes('/editor.js?preview=1'));
  const jitPage = await (await page.request.get(BASE + '/about.html')).text();
  check('a page on the browser build is given neither', !jitPage.includes('thisone-palette')
    && !jitPage.includes('preview=1'));

  const sheet = await page.request.get(BASE + '/thisone-palette.css');
  const sheetCss = await sheet.text();
  check("the preview sheet is compiled by the site's own Tailwind, every rule scoped",
    /text\/css/.test(sheet.headers()['content-type'])
      && sheetCss.includes('[data-thisone-edited].bg-emerald-500')
      && !/^\.bg-emerald-500/m.test(sheetCss));

  // Edit mode is remembered for the session, so it is already on here.
  await page.goto(BASE + '/built.html', { waitUntil: 'networkidle' });
  const wide = page.locator('[data-thisone-loc^="built.html:4:1:"]');
  const builtCard = page.locator('[data-thisone-loc^="built.html:5:1:"]');
  const padOf = (loc) => loc.evaluate((el) => getComputedStyle(el).paddingLeft);
  check('the built stylesheet is what styles the page', (await padOf(builtCard)) === '16px', await padOf(builtCard));

  // Paint both, never compare the strings: one arrives as oklch().
  const painted = (css) => page.evaluate((c) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 1, 1);
    return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
  }, css);
  const emerald = (read(require.resolve('tailwindcss/theme.css')).match(/--color-emerald-500:\s*([^;]+);/) || [])[1];

  await builtCard.click();
  const reveal = panel.locator('[data-tw-reveal="bg"]');
  if (await reveal.isVisible()) await reveal.click();
  await panel.locator('[data-tw-color-open="bg"]').click();
  await page.locator('[data-tw-pop] [data-tw-hue="emerald"]').click();
  await page.locator('[data-tw-pop-shade] [data-tw-shade="500"]').click();

  const bgNow = await builtCard.evaluate((el) => getComputedStyle(el).backgroundColor);
  check('a colour the stylesheet never built previews at once',
    (await painted(bgNow)) === (await painted(emerald)), `${bgNow} vs ${emerald}`);

  // The editor writes its own rule for a colour. Alignment it does not: only
  // the preview sheet can make text-center render on a page that never built
  // it. Blank the sheet and this is the check that fails.
  await panel.locator('[data-tw-align="center"]').click();
  const alignNow = await builtCard.evaluate((el) => getComputedStyle(el).textAlign);
  check('a token only the preview sheet holds previews too', alignNow === 'center', alignNow);

  await wide.click();
  check('an untouched responsive element keeps its md: padding, the sheet does not outrank it',
    (await padOf(wide)) === '48px', await padOf(wide));

  const s5 = await saved();
  const builtAfter = read(builtFile);
  check('and the save changes that one class value in built.html', s5.includes('built.html')
    && builtAfter === BUILT.replace('class="p-4 bg-white"', 'class="p-4 bg-emerald-500 text-center"'),
    builtAfter.split('\n')[4]);

  // ---------- and the saved class still renders after a reload ----------
  //
  // built.css on disk predates the save, so it has no text-center and no
  // bg-emerald-500. Served as it is, the page reloads looking unedited while
  // the file says otherwise, which reads as "only my text was saved".
  await page.reload({ waitUntil: 'networkidle' });
  const reloadedCard = page.locator('[data-thisone-loc^="built.html:5:1:"]');
  check('nothing on the reloaded page is wearing the preview marker',
    (await page.locator('[data-thisone-edited]').count()) === 0);
  const alignAfter = await reloadedCard.evaluate((el) => getComputedStyle(el).textAlign);
  const bgAfter = await reloadedCard.evaluate((el) => getComputedStyle(el).backgroundColor);
  check('the saved classes render after a reload, from a stylesheet rebuilt off the input',
    alignAfter === 'center' && (await painted(bgAfter)) === (await painted(emerald)), `${alignAfter} ${bgAfter}`);
  check('the responsive padding still wins on the reloaded page', (await padOf(wide)) === '48px', await padOf(wide));
  check("the user's built.css on disk was not written", read(path.join(SITE, 'built.css')) === builtCssOnDisk);
  const plain = await page.request.get(BASE + '/styles.css');
  check('a stylesheet Tailwind did not build is served as the file', (await plain.text()) === CSS);

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
