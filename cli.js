#!/usr/bin/env node
'use strict';

/**
 * thisone — detect a project, wire the editor into it, run it.
 *
 *   thisone --root ../uiux_experiment          inspect and start
 *   thisone --root ../uiux_experiment --wire   add the loader + overlay first
 *   thisone --root ../uiux_experiment --unwire remove them again
 *   thisone --root ../uiux_experiment --check  report only, change nothing
 *
 * Wiring edits the target's own config, so every touched file is copied to
 * .backups/ first and `--unwire` restores it. Where an unambiguous anchor
 * cannot be found the snippet is printed rather than guessed at.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const { detect, detectWiring, whyItDied } = require('./detect');

const HERE = __dirname;
// The name written into a project today, and every name written by a release
// before it. `MARK` is what --wire puts in; `MARKS` is what --unwire looks for,
// so a rename cannot leave an already-wired project carrying a block this tool
// no longer recognises. Same rule as detect.js's LOADER_MARKS, and the same
// reason: the failure is silent from the user's side — the block simply stays.
const MARKS = ['thisone', 'bw-editor', 'tw-editor'];
const MARK = MARKS[0];
const ANY_MARK = '(?:' + MARKS.join('|') + ')';
const hasMark = (src) => MARKS.some((m) => src.includes(m));
const PKG = require('./package.json').name;

// The port the overlay is fetched from when nothing says otherwise. It is a
// default and not a decision: what `--wire` writes into the layout reads the
// env var at runtime, so wiring once at 3500 and later running on another port
// still works. See overlayTags.
const DEFAULT_PORT = 3500;

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes('--' + name);

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

/**
 * Where the originals of the files we edit are kept.
 *
 * In the project, not beside this code. Installed as a dependency, `__dirname`
 * is inside node_modules — which `npm ci` deletes and a fresh checkout never
 * has — so the only copy of the user's own next.config and layout would be in
 * the one directory guaranteed not to survive. `--unwire` reads from here too.
 */
/**
 * Drop Turbopack's dev cache, because wiring has just invalidated it.
 *
 * `--wire` and `--unwire` both change next.config.ts and both add or remove
 * `tools/thisone-loader.cjs`, and Turbopack caches module *resolutions* — including
 * the failed ones. Unwire while the dev server is up and it caches "there is no
 * such file"; wire again and the file is back but the cache is not asked again,
 * so every page 500s with `Cannot find module .../tools/thisone-loader.cjs` naming a
 * path that is plainly there. Nothing short of clearing it recovers, and the
 * error points at the file rather than at the cache, so it reads as our bug.
 *
 * Only `.next/dev`. Next 16 keeps dev and build output in separate trees, and
 * a production build is not ours to throw away.
 */
function clearDevCache(root) {
  const dir = path.join(root, '.next', 'dev');
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function backupDir(root) {
  return path.join(root, '.thisone', 'backups');
}

function backup(root, abs) {
  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // Ours to keep, not theirs to commit. Self-ignoring, so it stays out of the
  // project's history without editing the project's own .gitignore.
  const ignore = path.join(root, '.thisone', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  // Named after the path inside the project and not the basename: `layout.tsx`
  // and `page.tsx` repeat across a Next app, and two guards taken in the same
  // millisecond would collide on one name — losing the only copy of a file, in
  // the code whose whole job is not to do that.
  const rel = path.relative(root, abs).split(path.sep).join('__');
  const dest = path.join(dir, `${rel}.${Date.now()}.orig`);
  fs.copyFileSync(abs, dest);
  return dest;
}

// ------------------------------------------------------------------ wiring

/**
 * The shim written into the project as `tools/thisone-loader.cjs`.
 *
 * By package name wherever the editor resolves from the project, because this
 * file is committed with the repo: an absolute path here is one machine's
 * path, and it breaks for every teammate and every CI checkout the moment the
 * file is pushed.
 *
 * The fallback is for running this checkout directly against a sibling project
 * that has not installed it — the way it is developed. That path IS machine
 * specific, so the file says so rather than looking portable.
 */
function loaderShim(root) {
  let byName = false;
  try {
    createRequire(path.join(root, 'package.json')).resolve(PKG + '/loader');
    byName = true;
  } catch {
    /* not installed here; fall back to this copy */
  }
  const target = byName ? PKG + '/loader' : path.join(HERE, 'next/loader.cjs');
  const note = byName
    ? 'Resolved by name, so this file is safe to commit.'
    : `NOT PORTABLE: absolute path to a checkout on this machine, because\n// ${PKG} does not resolve from this project. Install it and re-run --wire\n// before committing this file.`;
  return `// Added by thisone. Dev-only source-location stamper; delete with --unwire.
// ${note}
module.exports = require(${JSON.stringify(target)});
`;
}

const TURBOPACK_RULE = `
  // ${MARK}:start — dev-only source-location stamping. Remove with \`thisone --unwire\`.
  turbopack: {
    rules: {
      "*.{tsx,jsx}": {
        condition: { all: [{ not: "foreign" }, "development"] },
        loaders: [
          { loader: require("node:path").join(process.cwd(), "tools/thisone-loader.cjs"),
            options: { root: process.cwd() } },
        ],
      },
    },
  },
  // ${MARK}:end`;

// Bracketed the same way the overlay block is, so --unwire takes out exactly
// what --wire put in even after this snippet's own text changes between
// versions. An exact-string match on the constant would quietly stop matching
// the moment the constant was edited, and a replace that does not match fails
// silently — which is the one failure mode this file cannot afford.
const TURBOPACK_BLOCK = new RegExp(
  '\\n[ \\t]*// ' + ANY_MARK + ':start[\\s\\S]*?' + ANY_MARK + ':end'
);

// Bracketed by explicit markers so --unwire removes exactly what --wire added,
// including the leading newline and indent, whatever the file's own formatting.
/**
 * What goes into the layout — with the port read when the page renders, not
 * baked in when it was wired.
 *
 * Writing the number in was the quietest way to break this: wire once at the
 * default, later run `--port 3600`, and the overlay simply never loads. No
 * error, no missing file, just a page with no editor on it and nothing saying
 * why. The env var is read through NEXT_PUBLIC_ so it survives whether the
 * layout renders on the server or is pulled into a client component.
 */
const overlayTags = () => `
        {/* ${MARK}:start — dev-only. Remove with \`thisone --unwire\`. */}
        {process.env.NODE_ENV === "development" && (
          <>
            <link
              rel="stylesheet"
              href={\`http://127.0.0.1:\${process.env.NEXT_PUBLIC_THISONE_PORT ?? ${DEFAULT_PORT}}/palette.css\`}
            />
            <script
              src={\`http://127.0.0.1:\${process.env.NEXT_PUBLIC_THISONE_PORT ?? ${DEFAULT_PORT}}/overlay.js\`}
              async
            />
          </>
        )}
        {/* ${MARK}:end */}`;
const OVERLAY_BLOCK = new RegExp(
  '\\n[ \\t]*\\{/\\* ' + ANY_MARK + ':start[\\s\\S]*?' + ANY_MARK + ':end \\*/\\}'
);

function wireNext(plan) {
  const done = [];
  const manual = [];

  const shim = path.join(plan.root, 'tools/thisone-loader.cjs');
  if (!fs.existsSync(shim)) {
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, loaderShim(plan.root));
    done.push('tools/thisone-loader.cjs (new)');
  }

  const configAbs = path.join(plan.root, plan.configFile);
  let config = fs.readFileSync(configAbs, 'utf8');
  if (hasMark(config)) {
    done.push(`${plan.configFile} (already wired)`);
  } else if (/turbopack\s*:/.test(config)) {
    manual.push([plan.configFile, 'it already defines `turbopack`; merge this in by hand:', TURBOPACK_RULE]);
  } else {
    const anchor = config.match(/const\s+nextConfig(?:\s*:\s*NextConfig)?\s*=\s*\{/);
    if (!anchor) {
      manual.push([plan.configFile, 'could not find `const nextConfig = {`:', TURBOPACK_RULE]);
    } else {
      backup(plan.root, configAbs);
      const at = anchor.index + anchor[0].length;
      fs.writeFileSync(configAbs, config.slice(0, at) + TURBOPACK_RULE + config.slice(at));
      done.push(plan.configFile);
    }
  }

  const entryAbs = plan.entryFile && path.join(plan.root, plan.entryFile);
  if (!entryAbs || !fs.existsSync(entryAbs)) {
    manual.push(['(layout)', 'no layout file found; add before </body>:', overlayTags()]);
  } else {
    const entry = fs.readFileSync(entryAbs, 'utf8');
    if (hasMark(entry)) {
      done.push(`${plan.entryFile} (already wired)`);
    } else if (!entry.includes('</body>')) {
      manual.push([plan.entryFile, 'no </body> to anchor to; add:', overlayTags()]);
    } else {
      backup(plan.root, entryAbs);
      const at = entry.lastIndexOf('</body>');
      fs.writeFileSync(entryAbs, entry.slice(0, at) + overlayTags() + entry.slice(at));
      done.push(plan.entryFile);
    }
  }

  return { done, manual };
}

/** Strip our blocks back out; anything we could not add we also do not remove. */
function unwireNext(plan) {
  const removed = [];
  const stuck = [];

  const shim = path.join(plan.root, 'tools/thisone-loader.cjs');
  if (fs.existsSync(shim)) {
    fs.unlinkSync(shim);
    try { fs.rmdirSync(path.dirname(shim)); } catch { /* not empty; leave it */ }
    removed.push('tools/thisone-loader.cjs');
  }

  for (const rel of [plan.configFile, plan.entryFile].filter(Boolean)) {
    const abs = path.join(plan.root, rel);
    if (!fs.existsSync(abs)) continue;
    const before = fs.readFileSync(abs, 'utf8');
    if (!hasMark(before)) continue;
    backup(plan.root, abs);
    const after = before.replace(rel === plan.configFile ? TURBOPACK_BLOCK : OVERLAY_BLOCK, '');
    if (after !== before) {
      fs.writeFileSync(abs, after);
      removed.push(rel);
    } else {
      // The file says it is wired and the block would not come out — an older
      // version wrote a snippet this one no longer recognises, or it has been
      // edited since. Say which file and leave it alone; a silent no-op here
      // reads as "unwired" while the project is still carrying the block.
      stuck.push(rel);
    }
  }
  return { removed, stuck };
}

// -------------------------------------------------------------------- main

function report(plan, wiring) {
  console.log(`\n${bold(plan.name)}  ${dim(plan.root)}`);
  console.log(`  framework  ${plan.framework || dim('none')}${plan.version ? ' ' + plan.version : ''}`);
  console.log(`  bundler    ${plan.bundler || dim('n/a')}${plan.locator ? dim('  → locator: ' + plan.locator) : ''}`);
  console.log(`  writers    ${(plan.writers || []).join(', ') || dim('none')}`);
  console.log(`  tailwind   ${plan.tailwind.found ? plan.tailwind.version + dim('  → ' + plan.tailwind.strategy) : dim('not found')}`);
  if (plan.configFile) console.log(`  config     ${plan.configFile}`);
  if (wiring) {
    const mark = (b) => (b ? green('yes') : dim('no'));
    console.log(`  wired      loader ${mark(wiring.loader)}  overlay ${mark(wiring.overlay)}  shim ${mark(wiring.loaderShim)}`);
  }
}

const root = path.resolve(arg('root', process.cwd()));
const port = Number(arg('port', DEFAULT_PORT));
const plan = detect(root);
const wiring = plan.supported && plan.framework !== 'html' ? detectWiring(plan) : null;
report(plan, wiring);

if (!plan.supported) {
  console.log(`\n${red('Not supported.')} ${plan.reason}\n`);
  process.exit(1);
}
if (flag('check')) process.exit(0);

if (flag('unwire')) {
  const { removed, stuck } = unwireNext(plan);
  console.log(removed.length
    ? `\n${green('Unwired')} — reverted: ${removed.join(', ')}   ${dim('(originals in .thisone/backups/)')}`
    : `\n${dim('Nothing to unwire.')}`);
  for (const rel of stuck) {
    console.log(`${red('Left in place: ' + rel)} — it carries a ${MARK} block this version ` +
      'does not recognise (wired by an older release, or edited since). Remove it by hand.');
  }
  if (removed.length && clearDevCache(plan.root)) {
    console.log(dim('Cleared .next/dev — a dev server still running would otherwise keep '
      + 'a cached resolution of the loader that is no longer there.'));
  }
  console.log('');
  process.exit(stuck.length ? 1 : 0);
}

const app = arg('app', `http://localhost:${plan.appPort}`);

const wired = plan.framework === 'html'
  || (wiring.loader && wiring.overlay && wiring.loaderShim);

/**
 * Wiring is setup, and setup is not a reason to start a server.
 *
 * Its own branch rather than a step on the way to running, so it behaves the
 * same whether or not there was anything left to do — falling through meant
 * `--wire` on an already-wired project silently became "run", and `--wire` on
 * a busy port failed *after* having succeeded, which reads as though the
 * wiring itself broke.
 */
if (flag('wire')) {
  if (plan.framework === 'html') {
    console.log(`\n${dim('Nothing to wire — this project is served directly.')}\n`);
    process.exit(0);
  }
  if (wired) {
    console.log(`\n${dim('Already wired — nothing to do.')}`);
  } else {
    const { done, manual } = wireNext(plan);
    if (done.length) console.log(`\n${green('Wired')} — ${done.join(', ')}   ${dim('(originals in .thisone/backups/)')}`);
    for (const [file, why, snippet] of manual) {
      console.log(`\n${red('Manual step for ' + file)}: ${why}\n${snippet}`);
    }
    if (manual.length) process.exit(1);
  }
  if (clearDevCache(plan.root)) {
    console.log(dim('Cleared .next/dev — Turbopack caches which files the loader rule '
      + 'resolves to, including the ones that were missing a moment ago.'));
  }
  console.log(`\nNext: ${bold('thisone dev')} starts your app and the editor together.`);
  console.log(`${dim('Or run ' + (plan.devCommand || 'the app') + ' yourself and ')}${bold('thisone')}${dim(' beside it.')}\n`);
  process.exit(0);
}

if (!wired) {
  console.log(`\n${red('Not wired yet.')} Run ${bold('thisone --wire')} to add it, or ${bold('--check')} to inspect only.\n`);
  process.exit(1);
}

/**
 * The first port at or above `from` that nothing is listening on.
 *
 * `host` must match how the server being tested for will bind, or the answer is
 * wrong: `next dev` listens on every interface and the editor listens only on
 * 127.0.0.1, and on macOS a loopback bind SUCCEEDS against a port already held
 * by a wildcard listener.
 *
 * This is a starting guess and nothing more. It answers "free right now", and
 * right now is not when the child binds — a server restarting frees its port
 * for a second or two, which is a window wide enough to walk straight into.
 * `--wire` rewrites next.config.ts, Next restarts on that, and the probe lands
 * in the gap: 3001 was genuinely free when asked and genuinely taken a moment
 * later. Whoever calls this must expect to be wrong and try the next one.
 */
function freePort(from, host) {
  const net = require('net');
  const tryPort = (p) => new Promise((resolve, reject) => {
    if (p >= from + 50) return reject(new Error(`no free port between ${from} and ${from + 50}`));
    const probe = net.createServer();
    probe.once('error', () => resolve(tryPort(p + 1)));
    // No host means every interface, which is what `next dev` does.
    const done = () => probe.close(() => resolve(p));
    if (host) probe.listen(p, host, done);
    else probe.listen(p, done);
  });
  return tryPort(from);
}

/**
 * Is a *web server* answering on this port yet?
 *
 * An HTTP request and a real response, not a bare TCP connect. Connecting only
 * proves something accepted the socket, which a process squatting on the port
 * does happily while never replying — and that is precisely the thing we are
 * trying to detect, so the cheap check reported success against the very case
 * it existed to catch. Any status line counts: Next answers while it is still
 * compiling, and a 404 or a 500 is still proof the port is held by something
 * that speaks HTTP.
 */
function answering(port) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once('error', () => resolve(false));
    req.once('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Did this child actually take the port, or did it fall over trying?
 *
 * Polled until it answers rather than waited out on a guess — the same rule the
 * HMR assertions follow, and for the same reason: a first compile is not on a
 * clock. A child that is still alive when the deadline passes counts as holding
 * it: `next dev` binds long before it has finished compiling, and a slow build
 * must not be read as a failure to start.
 */
/**
 * Spawn a child, show its output, and keep the tail of it.
 *
 * The tail is the only way to tell WHY a child gave up, and the difference
 * matters: a port taken from under us is worth trying the next one for, and
 * anything else is worth stopping for. Piped rather than inherited so it can be
 * read, and written straight back out so the user still sees it live.
 */
function spawnWatched(cmd, args, opts) {
  const proc = spawn(cmd, args, Object.assign({}, opts, { stdio: ['inherit', 'pipe', 'pipe'] }));
  let tail = '';
  const tap = (src, dest) => src && src.on('data', (chunk) => {
    dest.write(chunk);
    tail = (tail + chunk.toString()).slice(-4000);
  });
  tap(proc.stdout, process.stdout);
  tap(proc.stderr, process.stderr);
  proc.tail = () => tail;
  return proc;
}

async function holds(proc, port, waitMs) {
  let dead = false;
  proc.once('exit', () => { dead = true; });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (dead) return false;
    if (await answering(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !dead;
}

/**
 * `thisone dev` — the app and the editor, from one command.
 *
 * Three numbers have to agree: the app's port, the editor's port, and the
 * origin the editor accepts writes from. Left to the user they are three
 * chances to be wrong, and the third fails in the worst way — everything looks
 * right until Save, which is refused as a bad origin.
 *
 * They are also circular, which is what makes this fiddly. The app is started
 * with the editor's port in its environment, so the editor must go first; the
 * editor is started with the app's origin in its allowlist, so the app must.
 * Neither can be told later — an env var is fixed at spawn and the allowlist is
 * built at boot. So the PAIR is chosen, tried, and retried together: if either
 * half cannot hold its port, both are torn down and the next pair is tried.
 * Retrying only the failed half would leave the other holding a number its
 * partner no longer has.
 */
async function runDev() {
  if (plan.framework === 'html') {
    console.log(`\n${red('`dev` is for framework projects.')} This one is served directly; run ${bold('thisone')}.\n`);
    process.exit(1);
  }
  const [bin, ...rest] = (plan.devCommand || 'next dev').split(' ');
  let bwFrom = Number(arg('port', DEFAULT_PORT));
  let appFrom = Number(arg('app-port', plan.appPort));

  for (let attempt = 0; attempt < 4; attempt++) {
    const bwPort = await freePort(bwFrom, '127.0.0.1');
    const appPort = await freePort(appFrom, null);
    const origin = `http://localhost:${appPort}`;

    const editor = spawn(process.execPath,
      [path.join(HERE, 'next/server.js'), '--root', plan.root, '--port', String(bwPort),
        '--app', origin].concat(flag('prompt') ? ['--prompt'] : []),
      { stdio: 'inherit' });
    if (!(await holds(editor, bwPort, 8000))) {
      editor.kill();
      bwFrom = bwPort + 1;
      continue;
    }

    const app = spawnWatched('npx', [bin, ...rest, '--port', String(appPort)], {
      cwd: plan.root,
      // Read when the layout renders, which is what lets the editor live
      // anywhere without the number being written into the user's source.
      env: { ...process.env, NEXT_PUBLIC_THISONE_PORT: String(bwPort) },
    });
    if (!(await holds(app, appPort, 40000))) {
      app.kill();
      editor.kill();
      const died = whyItDied(app.tail());

      // Next refuses a second dev server for the same DIRECTORY, whatever port
      // it is offered — it starts, says so, and exits. No port is going to fix
      // that, so retrying is four restarts that cannot succeed and a closing
      // message blaming the wrong thing. It even names the one already running.
      if (died.kind === 'duplicate') {
        const { at, pid } = died;
        console.log(`\n${red('A dev server for this project is already running.')}`);
        if (at) console.log(`  It is at ${bold(at)}${pid ? dim(`  (pid ${pid})`) : ''}.`);
        console.log(`  ${plan.devCommand || 'The dev server'} allows one per directory, so this cannot start beside it.`);
        console.log(`\n  Either stop it${pid ? ` — ${bold('kill ' + pid)}` : ''} and run ${bold('thisone dev')} again,`);
        console.log(`  or leave it and run ${bold('thisone')} on its own beside it.\n`);
        process.exit(1);
      }

      // Only a port collision is worth another port.
      if (died.kind !== 'port-taken') {
        console.log(`\n${red('The app did not start.')} Its output is above.\n`);
        process.exit(1);
      }
      console.log(dim(`  port ${appPort} went while we were looking at it — trying the next pair`));
      appFrom = appPort + 1;
      continue;
    }

    console.log(`\n${green('Both up.')}  app ${bold(origin)}   editor ${bold('127.0.0.1:' + bwPort)}`);
    console.log(`${dim('open ' + origin + ' and press ')}${bold('Edit mode')}${dim(' — bottom right')}\n`);

    process.on('SIGINT', () => { app.kill(); editor.kill(); process.exit(0); });
    // Neither is useful alone: an editor with no app has nothing to edit, and
    // an app whose editor died silently stops being able to save.
    app.on('exit', (code) => { editor.kill(); process.exit(code || 0); });
    editor.on('exit', (code) => { app.kill(); process.exit(code || 0); });
    return;
  }
  throw new Error(`no pair of ports would hold after 4 tries, starting from ${arg('app-port', plan.appPort)} and ${arg('port', DEFAULT_PORT)} — something is taking them as fast as they are found`);
}

if (process.argv[2] === 'dev' || flag('dev')) {
  runDev().catch((err) => {
    console.error(`\n${red(err.message)}\n`);
    process.exit(1);
  });
  return;
}

const server = plan.framework === 'html'
  ? spawn(process.execPath, [path.join(HERE, 'server.js')],
      { stdio: 'inherit', env: { ...process.env, TW_EDITOR_FILE: path.join(plan.root, 'index.html') } })
  : spawn(process.execPath,
      [path.join(HERE, 'next/server.js'), '--root', plan.root, '--port', String(port), '--app', app]
        .concat(flag('prompt') ? ['--prompt'] : []),
      { stdio: 'inherit' });

console.log(`\n${dim('start your app separately: ' + (plan.devCommand || 'n/a') + '  →  ' + app)}`);
if (port !== DEFAULT_PORT) {
  // The layout reads this at render time; without it the overlay is fetched
  // from the default port and nothing loads, silently.
  console.log(`${bold('non-default port')} — start your app with ` +
    `${bold('NEXT_PUBLIC_THISONE_PORT=' + port)} or the overlay will not load.`);
}
console.log('');
process.on('SIGINT', () => { server.kill(); process.exit(0); });
server.on('exit', (code) => process.exit(code || 0));
