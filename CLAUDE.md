# thisone

Design mode for a running app. Turn on edit mode, click an element in the
browser, change its classes or text or delete it, and the change is written
back into the source file it came from. Published as `@designbuddy/thisone`.
The command is `thisone`.

Two modes share one client:

- **HTML**: `server.js` tags elements as it serves a flat `index.html`.
- **Next.js**: a Turbopack loader stamps each JSX element with its source
  location. `next/server.js` runs as a separate process and writes the `.tsx`.

Developed against `../uiux_experiment` (Next 16, Tailwind 4). Supported today:
Next.js App Router with Turbopack and Tailwind v4, Node 20.9 or newer. Astro,
Vite and React Native are recognised and refused. `docs/DECISIONS.md` says why.

## Commands

```bash
npm test                                        # 13 suites, about 85s, offline
node cli.js --root ../uiux_experiment --check   # inspect a project, change nothing
node cli.js --root ../uiux_experiment           # editor server (port 3500)
node cli.js --root ../uiux_experiment --prompt  # same, with the Prompt tab
node cli.js --root ../uiux_experiment dev       # app and editor together, ports picked for you
cd ../uiux_experiment && npx next dev           # the app itself (port 3000)

PORT=3001 node server.js                        # standalone HTML demo
node next/verify.js --root ../uiux_experiment          # 103 live checks against the real app
node next/verify-prompt.js --root ../uiux_experiment   # 14 live checks, needs --prompt, spends Claude quota
```

## Layout

| file | what it is |
|---|---|
| `editor.js` | the whole client overlay: panel, selection, every control. About 2900 lines, no bundler, served as-is |
| `server.js` | HTML mode: tags, serves, writes back |
| `next/loader.cjs` | Turbopack loader. Stamps `data-thisone-loc="file:line:col:hash"` |
| `next/jsx-adapter.js` | the writer. Resolves a location, replaces or cuts a byte span |
| `next/palette.js` | builds the dev preview stylesheet. Extracts colours, sizes, weights, radii |
| `next/server.js` | the editor server for a Next project |
| `next/claude.js` | the Prompt tab's backend. One headless `claude -p` per turn |
| `detect.js` / `cli.js` | framework detection and the `thisone` command |
| `assets/` | the panel's icons, exported from Figma and inlined into `editor.js` |
| `test/` | 13 suites. `run.mjs` runs them |
| `docs/` | the reasoning, the test map, the release contract |

## Where the reasoning lives

- `docs/DECISIONS.md`: every non-obvious design decision and the measurement
  behind it. **Before changing something that looks arbitrary, search this file
  for it.** Do not undo an entry without measuring again.
- `docs/TESTING.md`: which suite owns which behaviour, and the two live suites.
- `docs/RELEASE.md`: how to commit, log changes, bump the version and publish.
- `README.md`: what a user sees. Keep it about using the tool, not building it.

## Rules that always hold

- **Writes replace a byte span. Never reprint an AST.** A save changes one
  line and nothing else on it.
- **Refuse with a reason. Never guess.** `cn()` with no string literal,
  `cva()`, template literals, text from `{expressions}`, paths outside the
  root. The panel shows the reason.
- **Match class families by exact set, not by prefix.** `font-`, `text-`,
  `border-`, `rounded-` and `gap-` each cover several unrelated things.
- **Never compare colours as strings.** Paint to a 1×1 canvas and compare RGB.
- **Tailwind v4 has no runtime JIT.** Preview rules are scoped to
  `[data-thisone-edited]`. Never add a scoped copy of a rule the route already
  has, because the copy beats the route's responsive variants.
- **A rename adds to the marker lists. It never replaces them.** `LOADER_MARKS`,
  `SHIMS` and `MARKS` carry every name this tool has ever written into a
  project.
- **Icons come from `assets/`, inlined byte for byte.** Never redraw one.
  `test/12-icons.js` fails on any drift.
- **The panel's look comes from the Figma frame** (file `gYjihaL4o8QTceS1REp3fY`).
  No invented colours, radii or sizes. Panel text is US-spelled ("color").
- **`bw-*` classes and `data-tw-*` test hooks stay as they are.** They are the
  studio prefix. Only what lands in a user's repo says `thisone`.
- **Under Next, the overlay never removes DOM nodes.** React owns them. Only the
  HTML backend (`hmr: false`) edits the DOM directly.
- **`/prompt` is opt-in. `/edit` is not.** The tool fence is a deny list
  (`--disallowed-tools`). `--allowed-tools` only auto-approves.
- **Every change ends with a real edit to a real file and a byte-level diff
  check.** Keep that bar.

## Working style

- In tests, find elements by role (`data-tw-field`, `data-tw-step`,
  `data-tw-add`, `data-tw-status`). Never by DOM position.
- Check that a patch matched. A `str.replace()` that misses is silent.
- Comments say why, not what.
- A decision worth keeping goes into `docs/DECISIONS.md` in the same commit as
  the code, with the number that justified it. No planning files or summaries
  unless asked.
- Report test results as they are: the count, or the failing output. 0.1.0
  shipped without a green run (see `git show 726af5e`). Don't repeat that.
- The user's projects are not fixtures. Back up every file a probe could touch,
  name the backup after the full path, and restore in `finally`.

## Tests

- `npm test` runs 4 unit suites and 9 Playwright suites against a temp copy of
  `test/fixture.html`. **One run at a time.** They share port 3131.
- Before every run: `lsof -ti tcp:3131 | xargs -r kill -9`, then confirm the
  port is free.
- A new check goes in the suite that owns the behaviour (`docs/TESTING.md`). A
  new suite goes in `UNIT` or `BROWSER` in `test/run.mjs`.
- `next/verify.js` and `next/verify-prompt.js` run against a real app. They
  are not in `npm test`, and the second spends real quota.

## Commits, versions, releases

The full contract is `docs/RELEASE.md`. In short:

- Conventional Commits: `feat:` / `fix:` / `docs:` / `refactor:` / `perf:` /
  `test:` / `chore:`, no scope, lowercase, present tense, under 72 characters
  ("fix: tell a taken port from a dev server that owns the directory"). The
  body says why, what was measured, and the suite count. End with the
  `Co-Authored-By` footer. Commits before 2026-09-10 use plain sentences.
- Stage by path, never `git add -A`. Propose a split when the work separates
  cleanly, and wait for OK.
- User-facing changes get a line under `[Unreleased]` in `CHANGELOG.md`, in
  the same commit.
- Versions move only on "release X.Y.Z", through `npm version` (which commits
  and tags) and then `npm publish` (`prepublishOnly` runs the suite). Never
  edit the version field by hand.

## Traps

These each bit more than once.

- **Don't wait a fixed time for HMR.** Turbopack's recompile is not on a clock.
  A `waitForTimeout(2500)` in `verify.js` failed about one run in five, and
  passing four times in a row is not proof. Poll for the result, then assert.
- **`req.on('close')` does not mean the client left.** It fires as soon as the
  request body is read, which for `/prompt` is right after every turn starts.
  The abort handler killed each turn and reported `claude exited null`.
  `res.on('close')` is the one that means the client disconnected. Guard it
  with a `settled` flag either way, or `res.end()` re-enters it.
- **One `npm test` at a time.** The browser suites share `server.js` on port
  3131. A second run cannot bind the port, and its suites end up talking to
  the first run's server and fixture. `/edit` then answers 409 stale-hash and
  failures wander between suites.
- **Stale servers lie.** Three times a `lsof | kill` did not take, the new
  server died with `EADDRINUSE`, and an old one kept serving. Run
  `pkill -f next-server; pkill -f "next dev"` and confirm the port is free
  before concluding anything. `run.mjs`'s own `server.kill()` can leave 3131
  held too. The tell is failures that move between runs: a 409 in one, a
  padding read of 24 where the fixture says 16 in the next.
- **Back up every file a test could touch.** Two of the user's files were
  damaged (`cora/layout.tsx`, `meridian/design-system/page.tsx`), both
  untracked, so git could not help. `next/verify.js` copies to `.backups/` and
  asserts a byte-exact restore. Ad-hoc probes must do the same.
- **Restore in `finally`.** `verify.js` once restored only on the happy path.
  One thrown locator skipped it and left a test edit in the user's file. It
  happened twice.
- **Name backups after the path, not the basename.** Three guarded files are
  called `page.tsx`. Two backups in the same millisecond got the same name and
  one overwrote the other.
- **Never compare colours as strings.** The same colour arrives as `rgb()`,
  `oklch()` or `lab()`. Paint it to a canvas and compare RGB. This caused three
  false failures.
- **Check that a patch matched.** One silent `str.replace()` miss left three
  functions undefined and showed up as `readFontSize is not defined` on every
  selection.
- **Every `CSSStyleRule` has a `cssRules` list under CSS nesting.** Treating
  that as "a group, skip it" skipped all 1,580 real rules. Read the rule
  first, recurse only when the list is non-empty.
- **Attributes bind to the last item of a comma-separated selector.**
  `'[a],[b]' + '[data-theme]'` gives `[a],[b][data-theme]`. Use `both()`.
- **A visible panel does not mean something is selected.** The panel is on
  screen for all of edit mode. `[data-tw-idle]` is the signal.
- **Hovering a container lands on the child at its centre.** Playwright aims
  at the centre point and the editor picks the innermost stamped element.
  Hover a leaf, or assert on what is actually under the point.
- **Tailwind's dev server keeps a utility once generated**, even after the
  class leaves the source. A live check that a route has no utility passes
  once. Never write to the route whose absence you assert on.
- **Clean `.next` before checking a production build.** Next 16 keeps dev and
  build output in separate trees, and a stale `.next/dev/` gave a false pass.
- **Turbopack caches failed module resolutions.** Unwire with the dev server
  up, wire again, and every page 500s naming a file that exists. Wiring clears
  `.next/dev` for this reason.
