# thisone on React Native

A staged plan for making the editor work on a React Native project that styles
with Tailwind classes. Nothing here is built. Nothing here is decided — this is
the shape of the work and the order it has to happen in, written so the first
stage can kill the rest cheaply.

`docs/DECISIONS.md` currently ends with one line refusing React Native. That line
stays until stage 0 produces numbers. This file is what stage 0 is for.

---

## 1 · The refusal, re-read

> **React Native / Expo is out.** No DOM, Metro runs no loader, Tailwind v3, and
> components are capitalised so "host element" means something else.

Four claims. Checked against the landscape in September 2026:

| claim | still true? |
|---|---|
| **No DOM** | On native, yes. On **Expo Web** no: `react-native-web` renders `View` to a real `div`, and `dataSet={{ thisoneLoc: … }}` reaches the DOM as `data-thisone-loc`. Two surfaces, not one. |
| **Metro runs no loader** | True about webpack loaders, wrong about the conclusion. Metro runs **Babel**, and a Babel plugin can splice an attribute after a tag name exactly the way `next/loader.cjs` does. The seam exists; it has a different name. |
| **Tailwind v3** | True of NativeWind v4. **NativeWind v5 is built on Tailwind v4** and is in pre-release, "not intended for production use". This is now a fork in the road, not a wall. |
| **Capitalised components** | True, and the sharpest of the four. `hostElements()` (`next/jsx-adapter.js:70`) keeps a node only when `/^[a-z]/` matches the tag. On RN every element is `View`, `Text`, `Pressable` — the filter rejects all of them, and the filter is shared by the locator and the writer *on purpose*, so it cannot be changed on one side. |

Two of four have moved. That is enough to plan against and **not** enough to
change the refusal, because none of it has been measured on a real project. Do
not delete the DECISIONS line before stage 0 runs.

---

## 2 · What the three seams cost

`detect.js` names the seams: **locator** (how a node learns its source
location), **writer** (how a class is edited in source), **theme** (how Tailwind
is configured). A fourth is already formalised but unnamed: the **client
contract**, `window.__TW_EDITOR__`, read at `editor.js:23-44` and written at
`next/server.js:334-348`.

| seam | today | on RN | cost |
|---|---|---|---|
| **writer** | `next/jsx-adapter.js`, 559 lines | **Almost entirely reusable.** NativeWind styles `.tsx` with `className="…"`. `classNameSpan`, `textSpan`, `textRunSpan`, `removeSpan`, `editFile`, the `cn()`/`cva()`/template-literal refusals, the back-to-front splicing, the stale-hash check — all of it is about JSX syntax, not about the browser. | **one change**: the `/^[a-z]/` predicate |
| **locator** | `next/loader.cjs`, a Turbopack loader | **Rewrite, same shape.** A Babel plugin visiting `JSXOpeningElement`, stamping after the tag name so byte offsets and line counts stay honest. ~70 lines, and it must import `hostElements` from the writer for the same reason the loader does. | **new file**, small |
| **theme** | `next/palette.js` → CSS text, scoped to `[data-thisone-edited]` | **The `@source inline(…)` idea ports; the CSS output does not.** NativeWind compiles CSS to a JSON stylesheet at build time and resolves it in a runtime. There is no `insertRule`, no `document.styleSheets`, no cascade to outrank. | **rethink** |
| **client** | `editor.js`, ~2900 lines of overlay | **Splits in half.** The panel, the history stack, the dirty set, the save batching, the family regexes, the icon set, the refusal display — framework-free. Everything that calls `getComputedStyle` (~20 sites), `document.styleSheets` (`:4845`), `insertRule` (`:1151`, `:1347`, `:3634`, `:3950`), `classList` or a 1×1 canvas (`:3474`, `:3711`, `:5160`) is browser-only. | **extract a read/write adapter** |
| **server** | `next/server.js` `/edit` | **Reusable as-is.** The protocol is `{ id: "file:line:col:hash", classes, text, runs, remove }` and knows nothing about Next. | **none** |

The honest summary: **the writer is the hard part and it is already written.**
What is missing is a way to point at something and a way to show a change before
it is saved.

---

## 3 · Two surfaces, and they are not the same product

### A · Expo Web (`react-native-web`)

There is a DOM. NativeWind on web emits real CSS classes. `dataSet` puts our
attribute on the node. **Most of `editor.js` runs unchanged** — `getComputedStyle`
works, the preview stylesheet works, the cascade works.

What it buys: a real RN codebase, edited in a real browser, writing to the same
`.tsx` files the native app renders from.

What it is not: native layout. `Platform.select`, native-only components,
anything on a Skia canvas, and every place web and native flexbox defaults
disagree will look wrong or not render at all. **This must be said in the panel,
not in a README.** An editor that silently shows you the wrong layout is worse
than one that refuses.

### B · Native (iOS / Android)

No DOM, no CSSOM, no canvas, no `elementFromPoint`. Everything in the read/write
adapter is new:

- **hit-testing** — walk the fiber tree for stamped host elements, or use the
  inspector machinery RN already ships.
- **highlight** — an absolutely-positioned overlay `View` above the app, measured
  with `onLayout` / `measureInWindow`, instead of an outline style.
- **reading current values** — from the *authored className string* plus
  NativeWind's resolved style object. This is different from the web path and in
  one way better: the class list is the truth, rather than something inferred
  back out of computed CSS.
- **colour comparison** — the rule survives, the implementation changes.
  "Paint to a 1×1 canvas" becomes `processColor()`, which normalises any colour
  form to one integer. **Never compare colours as strings** still holds.
- **preview** — see §5.

**Order matters: A before B.** A proves the writer and the Babel locator against a
real RN codebase with the browser still available to debug in. B is then only the
adapter.

---

## 4 · Do not read the source location off React

`_debugSource` was removed from fibers in React 19, and `_debugStack` is not a
replacement — it cannot be resolved to a filesystem path without symbolication.
Expo SDK 55 runs React 19. Every "click the component, open the file" tool built
on fiber internals is broken or symbolicating around it.

thisone is not exposed to this, because it never asked React. It stamps its own
attribute and reads its own attribute. **That is the architectural advantage on
this platform and the plan should not trade it away.** Under the automatic JSX
runtime `__source` is set for us and adding `transform-react-jsx-source`
*errors* — so the plugin stamps a prop we own, under a name in `LOADER_MARKS`,
and never relies on React surfacing anything.

---

## 5 · Preview is the genuinely new problem

On the web the rule is: Tailwind v4 has no runtime JIT, so pre-generate a fixed
palette with the project's own Tailwind and scope it to `[data-thisone-edited]`
so it cannot outrank the route's responsive variants (measured: `px-6 md:px-12`
rendering at 24px instead of 48px).

On native there is no cascade to outrank and no stylesheet to inject into.
NativeWind compiles CSS into a JSON stylesheet with lightningcss at build time
and a runtime resolves it. So:

- **The `@source inline(…)` half ports directly.** The palette's classes have to
  exist in the compiled stylesheet or picking one previews nothing — the same
  constraint, for the same reason, with a different build.
- **The scoping half has no counterpart** and should not be invented. Nothing
  outranks anything; a className either resolves or it does not.
- **Applying the preview needs a runtime override.** The overlay cannot set a
  prop on a component it does not own. NativeWind v5's import rewrite means every
  styled element already passes through one wrapper — that wrapper is the natural
  place to consult an override registry keyed by stamped location. **Confirm this
  in stage 0.** If v5's internals are not reachable, the fallback is our own thin
  wrapper injected by the same Babel plugin that stamps the location, which costs
  a render path in dev and is the sort of thing that must be measured before it
  is committed to.

**A class NativeWind cannot render must not be offered.** `CANDIDATES`
(`next/palette.js:106`) offers the whole spacing / colour / type grid on the
assumption that the browser renders all of it. RN has no `grid`, a reduced
`position`, and its own gaps. Offering a control that writes a real class and
changes nothing on screen is the failure mode this codebase already refuses
elsewhere; the palette needs a per-platform filter and stage 0 needs to produce
the list.

---

## 6 · The Tailwind version fork

| | NativeWind v4 | NativeWind v5 |
|---|---|---|
| Tailwind | v3 | **v4** |
| status | stable, what projects ship | **pre-release, "not intended for production use"** |
| `@source inline(…)` | no | yes |
| `tailwind.compile()` | no | yes |
| fits thisone today | no — `detect.js` requires `major >= 4` | yes |

`detectTailwind` already returns `strategy: major >= 4 ? 'source-inline' : 'safelist'`
(`detect.js:51`). **The `safelist` branch has never been used.** It was written
for exactly this case and cashing it in is the v4 path: a generated safelist
instead of a generated sheet.

**Recommendation: target NativeWind v5 first**, because it keeps one theme
strategy and one Tailwind generation, and only add the safelist branch once
something real is working. Riding a pre-release is the cost, and it is a smaller
cost than carrying two theme strategies through every other stage. Revisit if
stage 0 finds the projects worth editing are all on v4.

---

## 7 · Stages

Each stage ends with something that can be run and a decision to continue or
stop. No stage begins before the one above it has numbers.

### Stage 0 · Measure, on a real project — **blocking**

There is no Expo + NativeWind project on this machine. `uiux_experiment` and
`gw-web` are what every decision in `DECISIONS.md` was measured against; this
platform needs its own. Get one (`tama-app` is Expo SDK 55 but does not appear to
use Tailwind — it styles from `constants/theme.ts`, so it is not the fixture).

Count, the way §"Measured facts about these codebases" counts:

1. **`className=` sites vs `style={…}` sites vs `StyleSheet.create` sites.**
   This is the whole question. Known gap #1 says `uiux_experiment` has 714
   `style={{` against 1336 `className=`, and inline style is invisible to the
   editor. On RN, `StyleSheet.create` plus `style={styles.foo}` is the *native
   idiom* — if a NativeWind codebase is still half styled that way, an editor
   that only understands `className` reaches half the screen and has to say so.
2. **Shape of the className values** — plain literal, `cn()`, `cva()`, template
   literal, `Platform.select`. The first is editable today; the next three are
   already refused by name; the last is new and needs a refusal.
3. **Blast radius.** Measured on web: cora 42% of elements come from a shared
   component, polaris 72%, volt 78%. RN codebases are component-heavy by
   construction, so expect worse. Known gap #2 — class and text edits still warn
   about nothing — stops being a gap and becomes a blocker if the number is 90%.
4. **Which Tailwind utilities NativeWind actually renders**, for §5's filter.
5. **Whether the runtime override in §5 is reachable** without forking NativeWind.

Output: a numbers table in `DECISIONS.md`, and a go/no-go. **A no-go here is a
good outcome** — it costs a week and is written down, the way Astro's was.

### Stage 1 · The writer, offline

Teach `hostElements()` a pluggable element predicate. Today it is `/^[a-z]/`
inline; it becomes a parameter with the lowercase rule as the default, and an RN
rule that keeps known RN host components (`View`, `Text`, `Pressable`,
`ScrollView`, `Image`, `TextInput`, …) plus anything else carrying a `className`.
The locator and the writer must be given the *same* predicate from one place —
they share this function precisely so they cannot disagree about what sits at
`line:col`, and a per-platform predicate is a new way for them to drift.

Extend `05-jsx-adapter.js` with RN fixtures. **No device, no Metro, no browser.**
This stage is pure unit work and either passes or does not.

### Stage 2 · The Babel locator + Expo Web end to end

- `babel/locator.cjs` — visit `JSXOpeningElement`, splice
  `dataSet={{ thisoneLoc: "file:line:col:hash" }}` after the tag name.
  Same splice discipline as `next/loader.cjs`: back to front, line count
  unchanged, never break a build over instrumentation.
- `detect.js` learns `expo`, with `locator: 'babel'`, `entryFile:
  'app/_layout.tsx'`, `devCommand: 'expo start'`. The `UNSUPPORTED` entry comes
  out only when this lands, and the reason string changes to name what is and is
  not supported rather than refusing the framework whole.
- `--wire` writes `babel.config.js` and, for web, the overlay tag. Note there is
  no `</body>` to anchor to — `wireNext` uses it (`cli.js:228`) and the Expo path
  needs its own anchor. `MARKS` gains nothing; **a rename adds, never replaces**,
  and this is not a rename.
- A `verify-expo.js` beside `next/verify.js`, driving the real app: back up every
  file a probe touches, name the backup after the **full path**, restore in
  `finally`, assert a byte-exact restore. Poll for Fast Refresh, never
  `waitForTimeout` — Metro's recompile is no more on a clock than Turbopack's.

End of stage 2 is a real capability: **edit an Expo app in a browser, with the
panel saying plainly that it is showing you web layout.**

### Stage 3 · Native transport and hit-testing

- The panel moves off-device: it stays a browser page, talking to the app over a
  socket. The alternative — an in-app RN panel — means porting 2900 lines of
  overlay to RN primitives and re-drawing the Figma frame in `View`s, against the
  rule that the panel's look comes from the frame and nothing is invented.
  **Keep the panel in the browser.**
- Hit-testing, highlight and value-reading land behind the adapter §2 asks for.
- **Transport is a real problem, not a detail.** A simulator reaches
  `localhost:3500`; a phone on wifi does not. Expo already solves this for its own
  dev server and the answer should be borrowed rather than invented, including
  what happens when the LAN address changes. `127.0.0.1`-only listening
  (`next/server.js:412`) is a deliberate safety property and widening it is a
  decision, not a fix.

### Stage 4 · Native preview

Whatever §5 decides. This is the stage most likely to send the plan back to §5,
which is why it is last and why stage 0 asks about it.

### Stage 5 · NativeWind v4 / Tailwind v3

Only if stage 0 says the projects are there. Cash in `detect.js`'s `safelist`
branch.

---

## 8 · Refusals this adds

The rule is **refuse with a reason, never guess**, and the panel shows the
reason. New entries for `REFUSALS` (`next/jsx-adapter.js:82`):

| reason | when |
|---|---|
| `rn-stylesheet` | the element is styled by `style={styles.x}` — a class would change the file and nothing on screen |
| `rn-inline-style` | `style={{ … }}` on the element, per-property, same guard as the web colour rows |
| `platform-select` | the class comes from `Platform.select()` |
| `rn-unsupported-utility` | the class is real Tailwind that NativeWind does not render |
| `web-only-preview` | (panel state, not a write refusal) you are looking at web layout for a native app |

The first two are the same bug as known gap #1 and are expected to be *larger*
here than the 714 sites measured on the web. If stage 0 says most of a codebase
is `StyleSheet.create`, the right answer may be that thisone refuses RN for a
sharper reason than the current one-liner — and that is a result, written down.

---

## 9 · Risks, ranked

1. **`StyleSheet.create` is the native idiom.** If NativeWind codebases still
   reach for it, the editor is blind to most of the screen. Stage 0, question 1.
   This is the one that kills the project.
2. **Preview on native may need a fork of NativeWind.** §5. Stage 0, question 5.
3. **Blast radius.** Editing one element changes every instance, and RN is
   component-heavy. Known gap #2 is already open on the web; here it may be a
   precondition rather than a gap.
4. **NativeWind v5 is pre-release.** Building on a moving target. Mitigated by
   the version fork being in `detect.js` already, and by refusing with a reason.
5. **Transport on a real device.** Solvable, but it widens a deliberate safety
   boundary and that needs a decision.
6. **Two surfaces, one panel.** Web and native will disagree, and the moment the
   panel stops being explicit about which one you are looking at, the tool starts
   lying.

---

## 10 · What does not change

- Writes replace a byte span. **Never reprint an AST.**
- The locator and the writer share one element walk.
- Refuse with a reason. Never guess.
- Never compare colours as strings — `processColor()` is the native form of the
  canvas, not an excuse to compare strings.
- The overlay never removes nodes. React owns them, on both platforms.
- Icons come from `assets/`, inlined byte for byte, never redrawn.
- A rename adds to the marker lists. It never replaces them.
- Every change ends with a real edit to a real file and a byte-level diff check.
- Back up every file a probe could touch, name the backup after the full path,
  restore in `finally`.
