#!/usr/bin/env node
'use strict';

/**
 * bw-edit — detect a project, wire the editor into it, run it.
 *
 *   bw-edit --root ../uiux_experiment          inspect and start
 *   bw-edit --root ../uiux_experiment --wire   add the loader + overlay first
 *   bw-edit --root ../uiux_experiment --unwire remove them again
 *   bw-edit --root ../uiux_experiment --check  report only, change nothing
 *
 * Wiring edits the target's own config, so every touched file is copied to
 * .backups/ first and `--unwire` restores it. Where an unambiguous anchor
 * cannot be found the snippet is printed rather than guessed at.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const { detect, detectWiring } = require('./detect');

const HERE = __dirname;
const MARK = 'bw-editor';
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
function backupDir(root) {
  return path.join(root, '.bw-edit', 'backups');
}

function backup(root, abs) {
  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // Ours to keep, not theirs to commit. Self-ignoring, so it stays out of the
  // project's history without editing the project's own .gitignore.
  const ignore = path.join(root, '.bw-edit', '.gitignore');
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
 * The shim written into the project as `tools/bw-loader.cjs`.
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
  return `// Added by bw-edit. Dev-only source-location stamper; delete with --unwire.
// ${note}
module.exports = require(${JSON.stringify(target)});
`;
}

const TURBOPACK_RULE = `
  // ${MARK}:start — dev-only source-location stamping. Remove with \`bw-edit --unwire\`.
  turbopack: {
    rules: {
      "*.{tsx,jsx}": {
        condition: { all: [{ not: "foreign" }, "development"] },
        loaders: [
          { loader: require("node:path").join(process.cwd(), "tools/bw-loader.cjs"),
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
  '\\n[ \\t]*// ' + MARK + ':start[\\s\\S]*?' + MARK + ':end'
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
        {/* ${MARK}:start — dev-only. Remove with \`bw-edit --unwire\`. */}
        {process.env.NODE_ENV === "development" && (
          <>
            <link
              rel="stylesheet"
              href={\`http://127.0.0.1:\${process.env.NEXT_PUBLIC_BW_PORT ?? ${DEFAULT_PORT}}/palette.css\`}
            />
            <script
              src={\`http://127.0.0.1:\${process.env.NEXT_PUBLIC_BW_PORT ?? ${DEFAULT_PORT}}/overlay.js\`}
              async
            />
          </>
        )}
        {/* ${MARK}:end */}`;
const OVERLAY_BLOCK = new RegExp(
  '\\n[ \\t]*\\{/\\* ' + MARK + ':start[\\s\\S]*?' + MARK + ':end \\*/\\}'
);

function wireNext(plan) {
  const done = [];
  const manual = [];

  const shim = path.join(plan.root, 'tools/bw-loader.cjs');
  if (!fs.existsSync(shim)) {
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, loaderShim(plan.root));
    done.push('tools/bw-loader.cjs (new)');
  }

  const configAbs = path.join(plan.root, plan.configFile);
  let config = fs.readFileSync(configAbs, 'utf8');
  if (config.includes(MARK)) {
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
    if (entry.includes(MARK)) {
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

  const shim = path.join(plan.root, 'tools/bw-loader.cjs');
  if (fs.existsSync(shim)) {
    fs.unlinkSync(shim);
    try { fs.rmdirSync(path.dirname(shim)); } catch { /* not empty; leave it */ }
    removed.push('tools/bw-loader.cjs');
  }

  for (const rel of [plan.configFile, plan.entryFile].filter(Boolean)) {
    const abs = path.join(plan.root, rel);
    if (!fs.existsSync(abs)) continue;
    const before = fs.readFileSync(abs, 'utf8');
    if (!before.includes(MARK)) continue;
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
    ? `\n${green('Unwired')} — reverted: ${removed.join(', ')}   ${dim('(originals in .bw-edit/backups/)')}`
    : `\n${dim('Nothing to unwire.')}`);
  for (const rel of stuck) {
    console.log(`${red('Left in place: ' + rel)} — it carries a ${MARK} block this version ` +
      'does not recognise (wired by an older release, or edited since). Remove it by hand.');
  }
  console.log('');
  process.exit(stuck.length ? 1 : 0);
}

const app = arg('app', `http://localhost:${plan.appPort}`);

if (plan.framework !== 'html') {
  const ready = wiring.loader && wiring.overlay && wiring.loaderShim;
  if (!ready) {
    if (!flag('wire')) {
      console.log(`\n${red('Not wired yet.')} Run with ${bold('--wire')} to add it, or ${bold('--check')} to inspect only.\n`);
      process.exit(1);
    }
    const { done, manual } = wireNext(plan);
    if (done.length) console.log(`\n${green('Wired')} — ${done.join(', ')}   ${dim('(originals in .bw-edit/backups/)')}`);
    for (const [file, why, snippet] of manual) {
      console.log(`\n${red('Manual step for ' + file)}: ${why}\n${snippet}`);
    }
    if (manual.length) process.exit(1);
  }
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
    `${bold('NEXT_PUBLIC_BW_PORT=' + port)} or the overlay will not load.`);
}
console.log('');
process.on('SIGINT', () => { server.kill(); process.exit(0); });
server.on('exit', (code) => process.exit(code || 0));
