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
const { detect, detectWiring } = require('./detect');

const HERE = __dirname;
const BACKUPS = path.join(HERE, '.backups');
const MARK = 'bw-editor';

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

function backup(abs) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const dest = path.join(BACKUPS, `${path.basename(abs)}.${Date.now()}.orig`);
  fs.copyFileSync(abs, dest);
  return dest;
}

// ------------------------------------------------------------------ wiring

const LOADER_SHIM = `// Added by bw-edit. Dev-only source-location stamper; delete with --unwire.
module.exports = require(${JSON.stringify(path.join(HERE, 'next/loader.cjs'))});
`;

const TURBOPACK_RULE = `
  // ${MARK}: dev-only source-location stamping. Remove with \`bw-edit --unwire\`.
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
  },`;

// Bracketed by explicit markers so --unwire removes exactly what --wire added,
// including the leading newline and indent, whatever the file's own formatting.
const overlayTags = (port) => `
        {/* ${MARK}:start — dev-only. Remove with \`bw-edit --unwire\`. */}
        {process.env.NODE_ENV === "development" && (
          <>
            <link rel="stylesheet" href="http://127.0.0.1:${port}/palette.css" />
            <script src="http://127.0.0.1:${port}/overlay.js" async />
          </>
        )}
        {/* ${MARK}:end */}`;
const OVERLAY_BLOCK = new RegExp(
  '\\n[ \\t]*\\{/\\* ' + MARK + ':start[\\s\\S]*?' + MARK + ':end \\*/\\}'
);

function wireNext(plan, port) {
  const done = [];
  const manual = [];

  const shim = path.join(plan.root, 'tools/bw-loader.cjs');
  if (!fs.existsSync(shim)) {
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, LOADER_SHIM);
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
      backup(configAbs);
      const at = anchor.index + anchor[0].length;
      fs.writeFileSync(configAbs, config.slice(0, at) + TURBOPACK_RULE + config.slice(at));
      done.push(plan.configFile);
    }
  }

  const entryAbs = plan.entryFile && path.join(plan.root, plan.entryFile);
  if (!entryAbs || !fs.existsSync(entryAbs)) {
    manual.push(['(layout)', 'no layout file found; add before </body>:', overlayTags(port)]);
  } else {
    const entry = fs.readFileSync(entryAbs, 'utf8');
    if (entry.includes(MARK)) {
      done.push(`${plan.entryFile} (already wired)`);
    } else if (!entry.includes('</body>')) {
      manual.push([plan.entryFile, 'no </body> to anchor to; add:', overlayTags(port)]);
    } else {
      backup(entryAbs);
      const at = entry.lastIndexOf('</body>');
      fs.writeFileSync(entryAbs, entry.slice(0, at) + overlayTags(port) + entry.slice(at));
      done.push(plan.entryFile);
    }
  }

  return { done, manual };
}

/** Strip our blocks back out; anything we could not add we also do not remove. */
function unwireNext(plan) {
  const removed = [];

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
    backup(abs);
    let after = before;
    if (rel === plan.configFile) after = after.replace(TURBOPACK_RULE, '');
    else after = after.replace(OVERLAY_BLOCK, '');
    if (after !== before) {
      fs.writeFileSync(abs, after);
      removed.push(rel);
    }
  }
  return removed;
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
const port = Number(arg('port', 3500));
const plan = detect(root);
const wiring = plan.supported && plan.framework !== 'html' ? detectWiring(plan) : null;
report(plan, wiring);

if (!plan.supported) {
  console.log(`\n${red('Not supported.')} ${plan.reason}\n`);
  process.exit(1);
}
if (flag('check')) process.exit(0);

if (flag('unwire')) {
  const removed = unwireNext(plan);
  console.log(removed.length
    ? `\n${green('Unwired')} — reverted: ${removed.join(', ')}\n`
    : `\n${dim('Nothing to unwire.')}\n`);
  process.exit(0);
}

const app = arg('app', `http://localhost:${plan.appPort}`);

if (plan.framework !== 'html') {
  const ready = wiring.loader && wiring.overlay && wiring.loaderShim;
  if (!ready) {
    if (!flag('wire')) {
      console.log(`\n${red('Not wired yet.')} Run with ${bold('--wire')} to add it, or ${bold('--check')} to inspect only.\n`);
      process.exit(1);
    }
    const { done, manual } = wireNext(plan, port);
    if (done.length) console.log(`\n${green('Wired')} — ${done.join(', ')}   ${dim('(originals in .backups/)')}`);
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
      [path.join(HERE, 'next/server.js'), '--root', plan.root, '--port', String(port), '--app', app],
      { stdio: 'inherit' });

console.log(`\n${dim('start your app separately: ' + (plan.devCommand || 'n/a') + '  →  ' + app)}\n`);
process.on('SIGINT', () => { server.kill(); process.exit(0); });
server.on('exit', (code) => process.exit(code || 0));
