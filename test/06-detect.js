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
const { detect, detectWiring } = require('../detect');

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
check('--check reports without wiring', /wired/.test(out) && !/bw-editor/.test(configBefore));
check('--check changed nothing', fs.readFileSync(configPath, 'utf8') === configBefore);

out = run(['--root', root]);
check('refuses to run unwired', /Not wired yet/.test(out), out.trim().split('\n').pop());

run(['--root', root, '--wire']);
const configWired = fs.readFileSync(configPath, 'utf8');
const layoutWired = fs.readFileSync(layoutPath, 'utf8');
check('--wire added the turbopack rule', /turbopack/.test(configWired) && /bw-editor/.test(configWired));
check('--wire added the overlay to the layout', /overlay\.js/.test(layoutWired));
check('--wire created the loader shim', fs.existsSync(path.join(root, 'tools/bw-loader.cjs')));
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
check('--unwire removed the shim', !fs.existsSync(path.join(root, 'tools/bw-loader.cjs')));

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

fs.rmSync(work, { recursive: true, force: true });

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
