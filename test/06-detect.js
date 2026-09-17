/**
 * Detection and wiring, against synthetic project fixtures.
 *
 * Fixtures rather than the real repos: deterministic, and wire/unwire can be
 * exercised destructively without any chance of touching someone's work.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, detectWiring, whyItDied } = require('../detect');

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-detect-'));
const CLI = path.join(__dirname, '..', 'cli.js');

/** A throwaway project: package.json, configs, and a fake installed tailwind. */
function fixture(name, { deps = {}, files = {}, tailwind = null }) {
  const root = path.join(work, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name, dependencies: deps }, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (tailwind) {
    const tw = path.join(root, 'node_modules/tailwindcss');
    fs.mkdirSync(tw, { recursive: true });
    fs.writeFileSync(path.join(tw, 'package.json'),
      JSON.stringify({ name: 'tailwindcss', version: tailwind, main: 'index.js' }));
    fs.writeFileSync(path.join(tw, 'index.js'), 'module.exports={};');
  }
  return root;
}

const NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`;

const LAYOUT = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
`;

// ------------------------------------------------------------------ detect

let p = detect(fixture('next-app', {
  deps: { next: '16.2.4' }, tailwind: '4.2.4',
  files: { 'next.config.ts': NEXT_CONFIG, 'src/app/layout.tsx': LAYOUT },
}));
check('Next + TW4 is supported', p.supported && p.framework === 'next');
check('...with the turbopack locator and jsx writer',
  p.locator === 'turbopack' && p.writers.join() === 'jsx', `${p.locator}/${p.writers}`);
check('...and the v4 strategy', p.tailwind.strategy === 'source-inline', p.tailwind.strategy);

p = detect(fixture('astro-site', {
  deps: { astro: '^7.2.0' }, tailwind: '4.3.3',
  files: { 'astro.config.mjs': 'export default {};' },
}));
check('Astro detected with the vite locator', p.framework === 'astro' && p.locator === 'vite');
check('...and both writers, astro first', p.writers.join() === 'astro,jsx', p.writers.join());
check('...on its own default port', p.appPort === 4321, String(p.appPort));
// Recognised and refused are different answers, and Astro gets the second one.
// It reported `supported` for a while on the strength of a config file and a v4
// Tailwind, which sent it down the Next wiring path: astro.config.mjs asked for
// `const nextConfig = {`, a turbopack block offered for a key Astro has not got,
// and a React overlay tag printed for a layout file it does not keep.
check('...but refused, because the locator cannot be reached', !p.supported);
check('...naming the build, not the config', /never routes project files/.test(p.reason), p.reason);

p = detect(fixture('vite-app', {
  deps: { vite: '^7.0.0' }, tailwind: '4.3.3',
  files: { 'vite.config.ts': 'export default {};' },
}));
check('a bare Vite project is refused too', !p.supported && p.framework === 'vite');
check('...because the only locator written is turbopack\'s',
  /only locator that exists is the turbopack loader/.test(p.reason), p.reason);

p = detect(fixture('expo-app', {
  deps: { expo: '~57.0.0', 'react-native': '0.86.2' }, tailwind: '3.4.19',
}));
check('Expo refused', !p.supported && p.framework === 'expo');
check('...for the real reason, not a generic error',
  /no DOM/.test(p.reason) && /Metro/.test(p.reason), p.reason.slice(0, 48) + '…');

p = detect(fixture('next-tw3', {
  deps: { next: '14.2.0' }, tailwind: '3.4.19',
  files: { 'next.config.js': 'module.exports={};' },
}));
check('Next on Tailwind v3 refused', !p.supported, p.reason.slice(0, 50) + '…');
check('...naming the version', /3\.4\.19/.test(p.reason));

p = detect(fixture('next-no-config', { deps: { next: '16.0.0' }, tailwind: '4.2.4' }));
check('Next without a config refused', !p.supported && /next\.config/.test(p.reason));

p = detect(fixture('plain-html', { files: { 'index.html': '<html></html>' } }));
check('a bare index.html falls back to html mode',
  p.supported && p.framework === 'html' && p.locator === 'server');

// A generator's output folder: editable today, wiped by the next build.
const eleventy = fixture('eleventy-site', { files: { '_site/index.html': '<html></html>' } });
p = detect(path.join(eleventy, '_site'));
check('_site/ beside a package.json is refused as build output',
  !p.supported && p.framework === 'html' && /build output/.test(p.reason) && /package\.json/.test(p.reason),
  p.reason);

const hugo = fixture('hugo-site', { files: { 'hugo.toml': '', 'public/index.html': '<html></html>' } });
p = detect(path.join(hugo, 'public'));
check("public/ beside Hugo's config is refused", !p.supported && /hugo\.toml/.test(p.reason), p.reason);

const served = fixture('static-host', { files: { 'public/index.html': '<html></html>' } });
p = detect(path.join(served, 'public'));
check('public/ with no Hugo beside it is a site like any other', p.supported && p.framework === 'html');

fs.mkdirSync(path.join(work, 'loose', 'dist'), { recursive: true });
fs.writeFileSync(path.join(work, 'loose', 'dist', 'index.html'), '<html></html>');
p = detect(path.join(work, 'loose', 'dist'));
check('a dist/ with no generator beside it is not refused on its name alone', p.supported);

p = detect(fixture('nothing', {}));
check('an unrecognisable project is refused', !p.supported && p.framework === null);

// ----------------------------------------------------------- wire / unwire

const root = fixture('wire-me', {
  deps: { next: '16.2.4' }, tailwind: '4.2.4',
  files: { 'next.config.ts': NEXT_CONFIG, 'src/app/layout.tsx': LAYOUT },
});
const configPath = path.join(root, 'next.config.ts');
const layoutPath = path.join(root, 'src/app/layout.tsx');
const configBefore = fs.readFileSync(configPath, 'utf8');
const layoutBefore = fs.readFileSync(layoutPath, 'utf8');

const run = (args) => {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
};

let out = run(['--root', root, '--check']);
check('--check reports without wiring', /wired/.test(out) && !/thisone/.test(configBefore));
check('--check changed nothing', fs.readFileSync(configPath, 'utf8') === configBefore);

out = run(['--root', root]);
check('refuses to run unwired', /Not wired yet/.test(out), out.trim().split('\n').pop());

run(['--root', root, '--wire']);
const configWired = fs.readFileSync(configPath, 'utf8');
const layoutWired = fs.readFileSync(layoutPath, 'utf8');
check('--wire added the turbopack rule', /turbopack/.test(configWired) && /thisone/.test(configWired));
check('--wire added the overlay to the layout', /overlay\.js/.test(layoutWired));
check('--wire created the loader shim', fs.existsSync(path.join(root, 'tools/thisone-loader.cjs')));
// Read now, asserted below: --unwire deletes it before those checks run.
const shimUninstalled = fs.readFileSync(path.join(root, 'tools/thisone-loader.cjs'), 'utf8');
check('the loader rule is dev+non-foreign gated',
  /not.*foreign/.test(configWired) && /development/.test(configWired));
check('overlay is guarded by NODE_ENV', /NODE_ENV === "development"/.test(layoutWired));
check('detectWiring now agrees', (() => {
  const w = detectWiring(detect(root));
  return w.loader && w.overlay && w.loaderShim;
})());

run(['--root', root, '--unwire']);
check('--unwire restored next.config byte-exactly',
  fs.readFileSync(configPath, 'utf8') === configBefore,
  JSON.stringify(fs.readFileSync(configPath, 'utf8').slice(0, 60)));
check('--unwire restored the layout byte-exactly',
  fs.readFileSync(layoutPath, 'utf8') === layoutBefore);
check('--unwire removed the shim', !fs.existsSync(path.join(root, 'tools/thisone-loader.cjs')));

// ------------------------------------------ what makes it safe to install
//
// Three things only bite once the editor is a dependency rather than a sibling
// checkout, so nothing above can catch them.

// 1. The originals go in the PROJECT. Installed, `__dirname` is inside
//    node_modules — which `npm ci` deletes — so backups kept beside the code
//    are backups that vanish exactly when someone reinstalls.
const backups = path.join(root, '.thisone/backups');
check('backups are kept in the project, not beside the tool',
  fs.existsSync(backups) && fs.readdirSync(backups).length >= 2,
  fs.existsSync(backups) ? fs.readdirSync(backups).join(', ') : '(no .thisone/backups)');
check('...named after the path, so two page.tsx cannot collide',
  fs.readdirSync(backups).some((f) => f.startsWith('src__app__layout.tsx')),
  fs.readdirSync(backups).join(', '));
check('...and kept out of the project history by their own .gitignore',
  fs.readFileSync(path.join(root, '.thisone/.gitignore'), 'utf8').trim() === '*');

// 2. The port is read when the page renders, not written in when it is wired.
//    Baked in, wiring at the default and later running on another port leaves
//    a page with no editor on it and nothing saying why.
check('the layout carries no hardcoded port',
  !/127\.0\.0\.1:\d+/.test(layoutWired), (layoutWired.match(/127\.0\.0\.1:[^/]*/) || [])[0]);
check('...it reads NEXT_PUBLIC_THISONE_PORT instead, with a default',
  /NEXT_PUBLIC_THISONE_PORT \?\? 3500/.test(layoutWired));

// 3. The shim is committed with the user's repo, so it must not name a path
//    that exists on one machine. By name where the package resolves from the
//    project; where it does not, it says so rather than looking portable.
check('an uninstalled project gets the fallback, marked NOT PORTABLE',
  /NOT PORTABLE/.test(shimUninstalled) && shimUninstalled.includes(path.join(__dirname, '..')),
  shimUninstalled.split('\n')[1]);

const PKG = require('../package.json').name;
const linked = fixture('installed-here', {
  deps: { next: '16.2.4' }, tailwind: '4.2.4',
  files: { 'next.config.ts': NEXT_CONFIG, 'src/app/layout.tsx': LAYOUT },
});
// A scoped name is a directory and then a link, not one link: npm lays out
// `node_modules/@designbuddy/thisone`, so the scope has to exist before the
// symlink can land in it. Derived from PKG rather than written out, so this
// keeps working whichever of the two shapes the package name takes next.
const linkPath = path.join(linked, 'node_modules', PKG);
fs.mkdirSync(path.dirname(linkPath), { recursive: true });
fs.symlinkSync(path.join(__dirname, '..'), linkPath, 'dir');
run(['--root', linked, '--wire']);
const shimInstalled = fs.readFileSync(path.join(linked, 'tools/thisone-loader.cjs'), 'utf8');
check('an installed project gets the shim by package name',
  shimInstalled.includes(`require("${PKG}/loader")`) && !shimInstalled.includes(__dirname),
  shimInstalled.trim().split('\n').pop());
// The claim the shim makes, actually exercised: `exports` has to expose the
// subpath or this throws, and a shim that cannot load is worse than a path.
check('...and that name really loads the loader from inside the project',
  typeof require(path.join(linked, 'tools/thisone-loader.cjs')) === 'function');

// Turbopack caches module resolutions, including failed ones. Unwire while the
// dev server is up and it caches "no such file"; wire again and the file is
// back but the cache is not re-asked, so every page 500s with `Cannot find
// module .../tools/thisone-loader.cjs` naming a path that is plainly there. Hit in a
// real trial, and it reads as the tool's bug rather than as a cache.
const cached = fixture('stale-cache', {
  deps: { next: '16.2.4' }, tailwind: '4.2.4',
  files: {
    'next.config.ts': NEXT_CONFIG,
    'src/app/layout.tsx': LAYOUT,
    '.next/dev/build/chunks/stale.js': '// pretend Turbopack was here',
    '.next/BUILD_ID': 'a-production-build',
  },
});
run(['--root', cached, '--wire']);
check('wiring drops the dev cache it has just invalidated',
  !fs.existsSync(path.join(cached, '.next/dev')));
// Next 16 keeps dev and build output in separate trees, and a production build
// is not ours to throw away.
check('...and leaves the production build alone',
  fs.existsSync(path.join(cached, '.next/BUILD_ID')));
run(['--root', cached, '--unwire']);
check('unwiring drops it too — a running server would keep resolving a loader '
  + 'that is no longer there',
  !fs.existsSync(path.join(cached, '.next/dev')));

// ------------------------------------------- why a dev server gave up
//
// Only one of these three is worth another port, and getting it wrong is what
// turned one clear failure into six restarts that could never succeed. Verbatim
// output from Next 16.3.3, captured from the run that found this.
const DUPLICATE = `✓ Running next.config.ts took 57ms
▲ Next.js 16.3.3 (Turbopack)
- Local:         http://localhost:3002
- Network:       http://192.168.1.213:3002
✓ Ready in 888ms
⨯ Another next dev server is already running.

- Local:        http://localhost:3001
- PID:          17944
- Dir:          /tmp/my-app
`;
let d = whyItDied(DUPLICATE);
check('a second dev server for the same directory is named as that',
  d.kind === 'duplicate', d.kind);
// Our own child prints its banner before it discovers the conflict, so reading
// from the top of the buffer reports the port that FAILED (3002) rather than
// the one to go to (3001). That is what the first version did.
check('...and points at the server already running, not the one that just failed',
  d.at === 'http://localhost:3001', d.at);
check('...and carries the pid, because the fix is to kill it',
  d.pid === '17944', d.pid);

d = whyItDied('Error: listen EADDRINUSE: address already in use :::3001');
check('a taken port is the one case worth another port', d.kind === 'port-taken', d.kind);

d = whyItDied('SyntaxError: Unexpected token in next.config.ts');
check('anything else stops rather than cycling through ports',
  d.kind === 'unknown', d.kind);

// A block this version cannot match must be named, not silently skipped. An
// older release wrote a different snippet, and a replace that does not match
// fails quietly — reporting success while the project still carries the block.
const legacy = fixture('legacy-block', {
  deps: { next: '16.2.4' }, tailwind: '4.2.4',
  files: {
    'next.config.ts': NEXT_CONFIG.replace('reactStrictMode: true,',
      '// thisone: block from an older release\n  turbopack: { rules: {} },'),
    'src/app/layout.tsx': LAYOUT,
  },
});
out = run(['--root', legacy, '--unwire']);
check('an unrecognised block is reported, not silently left behind',
  /Left in place: next\.config\.ts/.test(out), out.trim().split('\n').pop());

// a config that already defines turbopack must be left alone, not merged blindly
const busy = fixture('busy-config', {
  deps: { next: '16.2.4' }, tailwind: '4.2.4',
  files: {
    'next.config.ts': 'const nextConfig = {\n  turbopack: { rules: {} },\n};\nexport default nextConfig;\n',
    'src/app/layout.tsx': LAYOUT,
  },
});
const busyBefore = fs.readFileSync(path.join(busy, 'next.config.ts'), 'utf8');
out = run(['--root', busy, '--wire']);
check('an existing turbopack block is not clobbered',
  fs.readFileSync(path.join(busy, 'next.config.ts'), 'utf8') === busyBefore);
check('...and the snippet is printed instead', /Manual step/.test(out) && /turbopack/.test(out));

// ------------------------------------------------ --json and the exit codes
//
// What an agent setting the tool up reads. It never sees the prose, so the
// status and the exit code are the whole answer and must agree with detect().

const runCode = (args) => {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }), code: 0 };
  } catch (e) {
    return { out: e.stdout || '', code: e.status };
  }
};
const json = (args) => {
  const r = runCode(args);
  try { return { ...r, body: JSON.parse(r.out) }; } catch { return { ...r, body: null }; }
};

const unwired = fixture('json-unwired', {
  deps: { next: '16.2.4' }, tailwind: '4.2.4',
  files: { 'next.config.ts': NEXT_CONFIG, 'src/app/layout.tsx': LAYOUT },
});
const unwiredConfig = fs.readFileSync(path.join(unwired, 'next.config.ts'), 'utf8');
let r = json(['--root', unwired, '--check', '--json']);
check('--json prints nothing but one JSON object', r.body !== null);
check('an unwired Next project is needs-wiring, exit 2',
  r.body?.status === 'needs-wiring' && r.code === 2, `${r.body?.status} / ${r.code}`);
check('...and names the step', r.body?.next === 'thisone --wire');
check('the JSON carries what detect() found',
  r.body?.framework === 'next' && r.body?.configFile === detect(unwired).configFile
    && r.body?.tailwind?.version === '4.2.4');
check('--json alone does not wire', runCode(['--root', unwired, '--json']).code === 2
  && fs.readFileSync(path.join(unwired, 'next.config.ts'), 'utf8') === unwiredConfig);
check('--check without --json agrees on exit 2', runCode(['--root', unwired, '--check']).code === 2);
check('running it unwired exits 2', runCode(['--root', unwired]).code === 2);

run(['--root', unwired, '--wire']);
r = json(['--root', unwired, '--check', '--json']);
check('a wired project is ready, exit 0', r.body?.status === 'ready' && r.code === 0,
  `${r.body?.status} / ${r.code}`);
check('...and names thisone dev', r.body?.next === 'thisone dev');
check('...with the wiring it found', !!(r.body?.wiring?.loader && r.body.wiring.overlay));
check('--check without --json agrees on exit 0', runCode(['--root', unwired, '--check']).code === 0);
run(['--root', unwired, '--unwire']);

const astro = fixture('json-astro', {
  deps: { astro: '5.0.0' }, tailwind: '4.2.4', files: { 'astro.config.mjs': 'export default {};\n' },
});
r = json(['--root', astro, '--check', '--json']);
check('astro is refused, exit 1', r.body?.status === 'refused' && r.code === 1,
  `${r.body?.status} / ${r.code}`);
check('...with the reason detect() gives, verbatim', r.body?.reason === detect(astro).reason);
check('...and no next step', r.body?.next === null);

const oldTw = fixture('json-tw3', {
  deps: { next: '16.2.4' }, tailwind: '3.4.0',
  files: { 'next.config.ts': NEXT_CONFIG, 'src/app/layout.tsx': LAYOUT },
});
r = json(['--root', oldTw, '--check', '--json']);
check('tailwind v3 is refused, exit 1', r.body?.status === 'refused' && r.code === 1,
  `${r.body?.status} / ${r.code}`);

const page = fixture('json-html', { files: { 'index.html': '<!doctype html><body></body>\n' } });
r = json(['--root', page, '--check', '--json']);
check('a plain page is ready, and names thisone rather than dev',
  r.body?.status === 'ready' && r.code === 0 && r.body?.next === 'thisone', `${r.body?.status} / ${r.code}`);

// What an agent pastes. A folder of .html files has nothing installed, and the
// unscoped name is not this package on npm, so the command has to carry the scope.
check('...with a command that runs from a folder with nothing installed',
  r.body?.command === `npx ${PKG} --root ${page}`, r.body?.command);
r = json(['--root', unwired, '--check', '--json']);
check('the command for an unwired Next project is the wire step, scoped',
  r.body?.command === `npx ${PKG} --wire --root ${unwired}`, r.body?.command);
check('a refusal has no command to offer', json(['--root', astro, '--check', '--json']).body?.command === null);
check('nothing to wire on a plain page, and it says so with exit 0',
  runCode(['--root', page, '--wire']).code === 0 && runCode(['--root', page, '--unwire']).code === 0);

check('--wire with a manual step exits 2', runCode(['--root', busy, '--wire']).code === 2);

fs.rmSync(work, { recursive: true, force: true });

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
