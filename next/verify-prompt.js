/**
 * Live verification of the Prompt tab against a real Next.js project.
 *
 *   node next/verify-prompt.js --root <project> [--app …] [--editor …]
 *
 * Separate from verify.js on purpose: this one spends money and takes a minute,
 * because it runs a real headless `claude -p` turn end to end. It is not part
 * of `npm test` and should not be — the rest of the suite is offline and
 * deterministic, and this is neither.
 *
 * Assumes `next dev` and `next/server.js --prompt` are already running.
 * Restores every file it touches.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { preamble } = require('./claude.js');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ROOT = path.resolve(arg('root', process.cwd()));
const APP = arg('app', 'http://localhost:3000');

const CORA = path.join(ROOT, 'src/app/experiments/cora/login/page.tsx');

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const snapshot = (f) => fs.readFileSync(f, 'utf8');

// Same rule as verify.js: backups live inside the repo, keyed on the relative
// path rather than the basename, and the restore runs in a finally.
const BACKUPS = path.join(__dirname, '..', '.backups');
function guard(file) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const dest = path.join(BACKUPS, path.relative(ROOT, file).replace(/[\\/]/g, '-') + '.bak');
  fs.copyFileSync(file, dest);
  return { file, dest, before: snapshot(file) };
}
function restore(g) {
  fs.writeFileSync(g.file, g.before);
  const ok = snapshot(g.file) === g.before;
  console.log(`${ok ? 'PASS' : 'FAIL'}  restored ${path.relative(ROOT, g.file)} byte-exactly` +
    (ok ? '' : `  — BACKUP KEPT AT ${g.dest}`));
  // Defensively: a throw in here runs inside the finally and masks whatever
  // actually failed, which is the one error you needed to see.
  if (ok) { try { fs.unlinkSync(g.dest); } catch { /* already gone */ } }
  return ok;
}

check('the styling rule is in the preamble, element or not',
  [preamble({ file: 'a.tsx', line: 1, col: 1, tag: 'div', classes: 'p-4' }), preamble(null)]
    .every((p) => /Do not add a style=/.test(p) && /arbitrary value/.test(p)));

(async () => {
  const guards = [guard(CORA)];
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(APP + '/experiments/cora/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    const panel = page.locator('[data-tw-editor="panel"]');
    await page.locator('[data-tw-mode]').click();

    // ---- the tab strip exists, and only because the backend offered it ----
    const tabs = panel.locator('[data-tw-tab]');
    check('the panel has two tabs', (await tabs.count()) === 2,
      (await tabs.allTextContents()).join(', '));

    // ---- with nothing selected there is nothing to switch between ----
    // Both tabs are about an element, so the strip folds away with the
    // selection exactly as the header does, and one line stands where it was.
    check('the strip is not on screen before anything is selected',
      !(await panel.locator('.bw-tabs').isVisible()));
    check('and the panel says what it is waiting for',
      await panel.locator('[data-tw-idle-msg]').isVisible());

    // ---- selecting an element brings the strip back, and aims it ----
    const target = page.locator('[data-bw-loc^="src/app/experiments/cora/login/page.tsx:"]').first();
    await target.click({ position: { x: 4, y: 4 } });
    check('selecting brings the strip back',
      await panel.locator('.bw-tabs').isVisible());
    check('Editor is the tab it opens on',
      (await panel.locator('[data-tw-tab="editor"]').getAttribute('aria-selected')) === 'true');
    // Read the line off the panel's own header rather than off the element we
    // aimed at: the editor selects the innermost stamped element under the
    // point, which is not always the one the locator matched.
    const head = (await panel.locator('.bw-h strong').textContent()).trim();
    await panel.locator('[data-tw-tab="prompt"]').click();
    // The header sits above both tabs and names the element on either, so the
    // prompt's own line carries only what the header cannot: how many elements
    // one source line renders. On a location rendering one, it says nothing.
    const onPrompt = (await panel.locator('.bw-h strong').textContent()).trim();
    check('the prompt aims at the same element the Editor tab does',
      onPrompt === head && /\.tsx:\d+/.test(onPrompt), `${onPrompt}  (editor tab: ${head})`);
    const ctx = (await panel.locator('.bw-pctx').textContent()).trim();
    check('and its own line adds the instance count, or stays out of the way',
      ctx === '' || /renders \d+ elements/.test(ctx), JSON.stringify(ctx));

    // ---- a pending edit blocks the turn ----
    // Claude reads these files off disk; a class change living only in the DOM
    // would be invisible to it and clobbered by its write.
    await panel.locator('[data-tw-tab="editor"]').click();
    // Whichever padding field this element actually shows: an element already
    // carrying pt-* opens to the four edges, which hides the axis pair — so a
    // fixed p-y here is a locator that works on some elements and hangs on
    // others.
    const pad = panel.locator('[data-tw-field^="p-"] input:visible').first();
    await pad.fill(String(Number(await pad.inputValue()) + 7));
    await pad.press('Enter');
    await page.waitForTimeout(200);
    check('the probe edit did mark the panel dirty',
      /^Save \d+ change/.test(await panel.locator('[data-tw-save]').textContent()),
      await panel.locator('[data-tw-save]').textContent());
    await panel.locator('[data-tw-tab="prompt"]').click();
    await panel.locator('[data-tw-field="prompt"]').fill('make it red');
    await panel.locator('[data-tw-send]').click();
    await page.waitForTimeout(300);
    const hint = await panel.locator('[data-tw-phint]').textContent();
    check('a pending edit refuses the turn, and says why',
      /pending change/.test(hint), hint);

    // Undo the probe class so the turn below runs against a clean tree. Save,
    // undo and redo are the editor's own ledger and are not on the Prompt tab
    // at all, so this steps back to press one and returns.
    await panel.locator('[data-tw-tab="editor"]').click();
    check('the ledger is on the Editor tab, not the Prompt one',
      await panel.locator('[data-tw-undo]').isVisible());
    await panel.locator('[data-tw-undo]').click();
    await page.waitForTimeout(200);
    await panel.locator('[data-tw-tab="prompt"]').click();

    // ---- the real turn ----
    const before = snapshot(CORA);
    await panel.locator('[data-tw-field="prompt"]').fill(
      'Add the comment /* bw-prompt-probe */ on its own line directly above this element. Change nothing else.'
    );
    await panel.locator('[data-tw-send]').click();
    check('the send button becomes Stop while a turn runs',
      (await panel.locator('[data-tw-send]').textContent()) === 'Stop');

    // Poll for the turn to finish — never a fixed wait. The turn is a network
    // round trip to a model and has no clock.
    await page.waitForFunction(
      () => document.querySelector('[data-tw-send]').textContent === 'Send',
      { timeout: 240000 }
    );

    const after = snapshot(CORA);
    check('the turn wrote the file', after !== before);
    check('and wrote the thing it was asked for', after.includes('bw-prompt-probe'));

    // A turn that worked reports nothing: the seconds it took and the share of
    // the plan's five-hour window it used are facts about the machinery, not
    // about the change you asked for, and they sat under the field until the
    // next thing you typed. The hint is still where a failure goes, which the
    // pending-edit refusal above is the proof of. A price is never shown
    // either way — the turn runs on the machine's own OAuth credentials and
    // nothing about it is billed per token.
    const spent = (await panel.locator('[data-tw-phint]').textContent()).trim();
    check('a turn that worked says nothing, and never a price',
      spent === '' && spent.indexOf('$') === -1, JSON.stringify(spent));

    const log = await panel.locator('.bw-plog').textContent();
    check('the transcript shows the prompt that was sent', log.includes('bw-prompt-probe'));
    check('and names the tools it used', /Edit|Read|Write/.test(log), log.slice(0, 200));

    // ---- the house rule holds where it is most tempting to break ----
    // A value with no stock utility behind it is exactly where a model reaches
    // for style={{}}. It should reach for an arbitrary value instead. Second
    // turn of the same session, so it costs about a tenth of the first.
    await panel.locator('[data-tw-field="prompt"]').fill(
      'Give this element a top padding of exactly 13px. Change nothing else.'
    );
    await panel.locator('[data-tw-send]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-tw-send]').textContent === 'Send',
      { timeout: 240000 }
    );
    const styled = snapshot(CORA);
    check('an odd value became an arbitrary class, not an inline style',
      /pt-\[13px\]/.test(styled) && !/style=\{\{/.test(styled),
      (styled.split('\n').find((l) => /pt-\[|style=\{\{/.test(l)) || 'neither found').trim());

    // ---- the conversation continues ----
    const sid = await panel.locator('[data-tw-view="prompt"]').getAttribute('data-tw-session');
    check('a session id was captured for --resume', typeof sid === 'string' && sid.length > 10, sid);

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    console.log('FAIL  the run threw  — ' + err.message.split('\n')[0]);
    results.push(false);
  } finally {
    if (browser) await browser.close();
    guards.forEach((g) => { if (!restore(g)) results.push(false); });
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
