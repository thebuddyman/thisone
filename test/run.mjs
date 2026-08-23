/**
 * Test runner.
 *
 * Every browser suite mutates the page it edits — that is the whole point of
 * the tool — so each one gets a fresh copy of test/fixture.html in a temp dir.
 * The demo index.html is never touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE = join(HERE, 'fixture.html');
const PORT = process.env.PORT || 3131;
const URL = `http://localhost:${PORT}`;

const UNIT = ['00-families.js', '05-jsx-adapter.js', '06-detect.js'];
const BROWSER = ['01-classes.js', '02-spacing-sides.js', '03-text.js', '04-safety.js', '07-delete.js', '08-edit-mode.js', '09-history.js'];

const work = mkdtempSync(join(tmpdir(), 'tw-editor-test-'));
const page = join(work, 'index.html');
const results = [];

function run(file, env) {
  const label = file.replace(/\.js$/, '');
  const r = spawnSync(process.execPath, [join(HERE, file)], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  results.push({ label, ok: r.status === 0 });
  return r.status === 0;
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL + '/');
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

console.log('— unit —');
for (const file of UNIT) run(file, {});

console.log(`\n— browser (fixture: ${page}) —`);
copyFileSync(FIXTURE, page);

const server = spawn(process.execPath, [join(ROOT, 'server.js')], {
  env: { ...process.env, TW_EDITOR_FILE: page, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let exitCode = 0;
try {
  if (!(await waitForServer())) {
    console.error(`server never came up on ${URL} — is the port in use?`);
    exitCode = 1;
  } else {
    for (const file of BROWSER) {
      copyFileSync(FIXTURE, page); // pristine start state for every suite
      run(file, { TW_EDITOR_FILE: page, TW_EDITOR_URL: URL });
    }
  }
} finally {
  server.kill();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(46));
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}`);
console.log(`${results.length - failed.length}/${results.length} suites passed`);
process.exit(exitCode || (failed.length ? 1 : 0));
