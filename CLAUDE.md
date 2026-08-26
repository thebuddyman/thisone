# bw-pl-browsereditor — handover

A visual Tailwind editor: turn on edit mode, click an element in the browser,
change its classes and text or remove it outright, and the edit is written back
into the source file it came from.

Two modes share one client:

- **HTML** — `server.js` tags elements as it serves a flat `index.html`.
- **Next.js** — a Turbopack loader stamps each JSX host element with its source
  location; `next/server.js` runs as a separate process and writes the `.tsx`.

Working today against `../uiux_experiment` (Next 16.2.4, Tailwind 4.2.4).
19 commits, working tree clean, `npm test` green.

---

## Run it

```bash
npm test                                   # 10 suites, ~70s
node cli.js --root ../uiux_experiment --check   # inspect a project
node cli.js --root ../uiux_experiment           # start the editor server (port 3500)
cd ../uiux_experiment && npx next dev           # the app itself (port 3000)

PORT=3001 node server.js                   # the standalone HTML demo
node next/verify.js --root ../uiux_experiment   # 55 live checks against the real app
```

`uiux_experiment` is already wired (`next.config.ts`, `src/app/layout.tsx`,
`tools/bw-loader.cjs`). `cli.js --unwire` removes it, byte-exactly.

---

## Layout

| file | what it is |
|---|---|
| `editor.js` | the whole client overlay — panel, selection, all controls (~2600 lines) |
| `server.js` | HTML mode: tags, serves, writes back |
| `next/loader.cjs` | Turbopack loader — stamps `data-bw-loc="file:line:col:hash"` |
| `next/jsx-adapter.js` | the writer: resolves a location, replaces or cuts a byte span |
| `next/palette.js` | compiles the dev preview stylesheet; extracts colours/sizes/weights/radii |
| `next/server.js` | the editor server for a Next project |
| `next/astro-locator.mjs` | written, **unused** — Astro is blocked, see below |
| `assets/` | the panel's icons, exported from Figma and inlined verbatim |
| `detect.js` / `cli.js` | framework detection and `bw-edit` |
| `test/` | 10 suites; `run.mjs` orchestrates |

Plans live at `~/.claude/plans/tailwind-editor-restructure.md` (current) and
`how-to-make-this-giggly-scone.md` (earlier, still accurate on security).

---

## Design decisions that were *not* obvious

Every one of these came from measuring the real codebases. Do not undo them
without re-measuring.

**Writes are byte-span replacements, never AST reprints.** A save changes one
line; nothing else moves, no quote style or trailing comma shifts into the diff.
The loader and the writer share `hostElements()` so they cannot disagree about
what sits at `line:col`.

**Tailwind v4 has no runtime JIT.** A class the editor invents has no CSS until
it is in a source file. Preview comes from a dev-only palette compiled with the
*project's own* Tailwind, scoped to `[data-bw-edited]`. Unscoped it beat the
app's own responsive variants — `px-6 md:px-12` rendered at 24px instead of 48px.
Scoped, it changes nothing until an element is selected.

**Colours are discovered from generated utility *rules* on the live page, not
from config files or CSS variables.** `@theme inline` — which every one of these
projects uses — substitutes token values into utilities and emits **no**
`--color-*` at all: on the Cora route `--color-clay` appears zero times while
`.text-clay` is right there. Rule-scanning also answers the question that
matters: what can this page actually render.

**The radius ladder comes from the page, like colours — not from the theme.**
Opposite of font size, and for the colour reason: `@theme inline` bakes the
token straight into the utility and emits no `--radius-*`. On the Cora route
`.rounded-lg` is `var(--radius)`, 12px, while `--radius-lg` still resolves to
the stock 8px. Radius is therefore the one control kept **out** of the
pre-generated palette — a scoped `[data-bw-edited].rounded-lg` would outrank
the route's own rule and visibly shrink an element the moment it was touched,
the same failure as the `px-6 md:px-12` bug. Rungs a route has never generated
get a runtime rule from the server's ladder instead.

**Font sizes and weights come from the server, not the page.** Opposite of
colours, because Tailwind v4 emits utilities *and* theme variables on demand — a
route using two sizes exposes exactly two. The full ladder only exists in
`theme.css`.

**`cn()` is edited by delta, not by snapshot.** The rendered class string is the
union of every argument, so writing it into argument one would duplicate what the
conditionals contributed. The client sends `added`/`removed` against a baseline
captured at selection.

**Family matching is by membership, not prefix.** `font-medium` is a weight,
`font-sans` is a family — `/^font-/` would delete `font-sans` on every weight
change (150 and 438 uses at risk). Same for colours: `text-lg` is a size,
`text-clay` a colour. `gap-` needs a lookahead because `gap-x-4` starts with it.
`rounded-` is the same trap twice over: `rounded-sm` is a rung, `rounded-s` is
the two start corners, and `rounded-t-lg` is neither.
`text-` is the trap three ways over once alignment exists: `text-lg` is a size,
`text-clay` a colour, `text-center` an alignment. Each is matched by an exact
set, so setting one leaves the other two alone.

**Undo/redo is by snapshot, not by command.** Every control already writes
straight to the DOM and to `dirty`, so recording the state after each mutation
is cheaper and far harder to get wrong than teaching a dozen call sites to
describe and invert themselves. A state is one entry per element the session has
touched, and these sessions touch a handful. Pristine state is captured in
`select()`, not in `markDirty()`: every mutation acts on the current selection,
so selection is the last moment the element is still untouched.

**Undo stops at a save.** The file has already changed by then, so stepping back
could only stage the reverse as a fresh edit while claiming to have undone
something. The saved state becomes the new starting point.

**The button bar outlives the selection, and the panel is anchored to the
bottom.** Save, undo and redo have nothing to do with which element is selected,
and losing the Save button by clicking the background was a way to strand unsaved
work behind a click. Bottom-anchored so the bar holds still and the panel grows
*upward* above it — top-anchored, every selection shoved Save down the screen.

**Everything in the panel grows upward out of the button row, including
dragging.** The bar is the drag handle as well as the header, because the header
is folded away exactly when the bar is all there is. Dragging therefore pins the
*bottom* edge; pinning `top`, which is how it was first written and how such
code usually is, meant that after a drag the next selection pushed the bar back
down the screen. For the same reason the status message sits *above* the
buttons: underneath them, a message appearing or clearing changed the footer's
height and slid the buttons 22px.

**The delete handle belongs to its element's top edge, not to the viewport.**
Clamping it into view unconditionally left it stuck to the top of the screen
long after the element had scrolled away above it, pointing at nothing. It may
be nudged into view by up to its own size — which is what an element sitting
flush against an edge needs — and past that it hides. The two candidate
positions are the element's top corners only; the second exists to dodge the
panel, not to follow the scroll.

**The panel wears one scheme, and it is not invented.** Colours, radii, field
heights and type sizes come from a Figma frame (file `gYjihaL4o8QTceS1REp3fY`,
node 1:2 for the panel, 2:202 for the dropdown, 2:188/2:194 for the close
button): `#171717` surfaces, `#232323` fields, `#dcdcdc` values, `#8c8c8c`
labels, `#505050` borders, `#aaa` icon marks, `#212121` hairlines, `#2b2b2b` a
row under the cursor. 12px on a container and 8px on a field, 40px fields and
rows, a 60px header, 15px text, 20px gutter, 12px between controls, 8px under a
label. The close button is 40x40 and transparent until hovered. It replaced a
light/dark pair — a light variant of a dark design would be an invention, so
both theme keys carry the same scheme.

**Spacing is spoken in pixels, and written in Tailwind.** The fields show and
take a pixel count — 16, not 4 — because nobody should have to multiply by four
to use a panel. The class written is still the rung where one lands (`p-4`), and
only a length with no rung behind it becomes `p-[13px]`, which is what the
snowflake marks. Typed values are no longer snapped: `ensureSpacingRule` emits a
runtime rule for anything off the pre-generated ladder, which is what made
snapping unnecessary — the old comment was right that an unsnapped `p-13` would
have previewed as nothing.

**The Text row is a field, not a mirror.** It is a textarea that writes straight
through to the element, the same as typing on the page does — the DOM stays the
one source of truth and the save path reads it either way. Where the text cannot
be rewritten (a container, or JSX that refuses) the field is disabled and the
reason is its placeholder, said in the field rather than beside it.

**An axis field owns the two edges beneath it — both ways.** A `py-*` lookup
cannot see `pt-*`, so reading an axis reads its edges. Edges that disagree open
the four-edge view by themselves; folded by hand they show comma separated,
upright — two real values are not one inherited one — with `0` for an edge that
owns no class, because `, 8` reads as a missing number.
Writing has to clear them for the same reason — leaving `pl-6` in place while
writing `px-8` means the more specific class wins and the field you just typed
into does nothing.

**The four-edge view opens once per selection, not once per refresh.** The rule
that opens it for an element already carrying `pt-*` used to re-run on every
readout, so collapsing such an element lasted until the next keystroke and typing
into a folded axis snapped the view back mid-edit. It is now decided when the
element is selected and the toggle owns it after that.

**Committing what a field already shows is not an edit.** Blur fires on every
field you tab through. Without that guard each one marked the element dirty and
pushed a history step that undid to itself — and worse, stepping below zero drops
the class, so the blur that followed wrote the inherited value straight back.

**A field that is not set still knows its answer.** Padding and margin are not
inherited, and preflight zeroes the defaults browsers ship, so no class means
zero — the field shows `0`, greyed, rather than an empty box. Where the page's
own CSS has put something there, it shows that instead, because a `0` the panel
cannot back up is a lie. Half steps count too: `py-2.5` and friends are 97 of
the 802 spacing classes in `uiux_experiment`, and an integers-only pattern read
every one of them as unset.

**Icons are the exported files, inlined byte-for-byte — never redrawn.** They
live in `assets/` and are pasted into `ICONS` exactly as exported, keeping their
own `#aaa` / `#505050` / `#858585` fills rather than being switched to
`currentColor`, because the design's colours are the point. The four marks with
no file (the individual edges) stay hand-drawn on a 12 grid, rendered at 20 with
a 0.9 stroke so they land on the assets' 1.5.

**Edit mode is off until it is asked for.** While it is on, every click is
swallowed in the capture phase so the app's own links and buttons cannot fire —
which is what makes the page selectable, and equally what makes it unusable as an
app: the target site could not be navigated, a form could not be filled, nothing
could be clicked without editing it. A page carrying the overlay is now just a
page until the toggle is pressed. The choice is kept in `sessionStorage`, so a
reload or a route change mid-session keeps you editing and a fresh tab always
starts on the page as its own users see it. Leaving the mode never discards
pending edits: their markers stay on the page and the count stays on the toggle.

**Removal is marked, not done.** Clicking the × ghosts the element and every
other instance of its source location, folds the panel down to a notice and an
Undo, and writes nothing. Save is what cuts the source. Ghosting rather than
hiding is deliberate: a hidden element cannot be clicked, so it could not be
undone, and the editor already marks unsaved edits on the page instead of
pretending they are committed.

**An element may only be removed from a JSX children list.** That is the one
position where lifting the node out still parses. A component root has to return
something, `{open && <div/>}` would be left as `{open && }`, and a `.map()`
arrow's body is the value it yields — each refused by name. The cut takes the
element's own lines whole, indentation and trailing newline included, so no
blank line is left in the diff.

**The overlay must not take removed nodes off the page under Next.** The dev
server re-renders from the new source; pulling a node out from under React makes
its next reconcile throw `removeChild` on something it no longer owns. The
backend says which world it is in (`hmr: true`), and only the HTML one — where
nothing re-renders — has its DOM updated by hand.

**Anything unsafe is refused with a reason, never guessed at.** `cn()` with no
string literal, `cva()`, interpolated templates, text mixed with `{expressions}`,
paths outside the root. Refusals surface in the panel.

---

## Measured facts about these codebases

These drove the design; re-check them if the target changes.

| | uiux_experiment | gw-web |
|---|---|---|
| static `className="…"` | 1372 | 1956 (86%) |
| `cn()` | 0 | 47 |
| template literals | 26 | 217 (7.3%) |
| **stock Tailwind palette colours** | **0** | **0** |
| semantic/project colour tokens | 63 | 19 |
| arbitrary `rgb()` colours | — | **608** |
| named font sizes | **2** | 198 |
| arbitrary `text-[13px]` | **497** | **832** |
| named font weights | 295 | 717 |
| arbitrary weights | 0 | 0 |
| named radius tokens | 171 | 90 |
| arbitrary `rounded-[3px]` | 66 | **180** |
| bare `rounded` (v3 alias) | 1 | 10 |
| per-corner `rounded-l-*` | 3 | 2 |

Editable coverage on gw-web: **91.4%** of 2881 host elements.

Fonts ship fewer weights than Tailwind offers: Space Mono declares **400 only**,
Space Grotesk 4, Euclid 5, Tiempos 6, Geist variable (all 9).

---

## Known gaps, ranked

1. **Blast radius — warned about on removal only.** Editing an element inside a
   shared component changes every instance. Measured: cora 42% of elements,
   polaris 72%, volt **78%**, worst case one location rendering 19 elements.
   Removal now counts `[data-bw-loc^="file:line:col:"]`, ghosts all of them and
   says "renders 19 elements … removes all 19" before you can save. **Class and
   text edits still say nothing** — same one-line count, same place to put it.
2. **Template literals** — 211 sites in gw-web. Only the leading static quasi is
   safely editable; the delta mechanism from `cn()` already does the hard part.
3. **Text editing refuses late.** A leaf whose text is `{variable}` lets you type
   and only refuses at save. The panel should say so up front. On Cora only
   25.7% of elements have writable text; 59.6% are `mixed-content`.
4. **Packaging** — not installable by anyone else. Largest remaining chunk, and
   only worth it if other people will use it.
5. **HSV colour picker** — the detached/hex path shows a read-only hex. gw-web
   is 608 arbitrary colours, so "detached" is the norm there.
6. **Per-corner radius is read but never written.** `rounded-l-[2px]` and
   friends are left exactly as authored — membership matching means they are
   never mistaken for a rung — and the Radius row appends `+n` and names them
   in its tooltip so it never shows one radius while the element means two.
   Only 5 sites across both codebases, so a per-corner mode is not yet earned.
7. **A rung a route has never used previews at the stock value.** Cora derives
   its ladder from `--radius: 0.75rem`, so `rounded-3xl` should be 26.4px, but
   Tailwind generated no rule for it and the fallback says 24px. The multiplier
   is not inferable from the rungs that do exist — cora's live/stock ratios run
   1.8, 1.6, 1.5, 1.4, 1.35. Corrects itself on save.

**Astro is blocked.** Astro 7 never routes project files through Vite plugins:
instrumented, **1,271 plugin calls, zero for anything under `src/`**. The locator
logic itself works (10/10 stamped offline). None of Astro's twelve integration
hooks is transform-shaped. `next/astro-locator.mjs` is finished but unreachable.

**React Native / Expo is out.** No DOM, Metro runs no loader, Tailwind v3, and
components are capitalised so "host element" means something else.

---

## Traps — these bit repeatedly

**Do not wait a fixed number of milliseconds for HMR.** Turbopack's recompile
is not on a clock: a `waitForTimeout(2500)` before the two HMR assertions in
`verify.js` failed about one run in five, and passing four times in a row is not
evidence. Poll for the result and then assert on it.

**Stale servers give misleading results.** Three times a `lsof | kill` did not
take, the new server died with `EADDRINUSE`, and an old one kept serving. Always
`pkill -f next-server; pkill -f "next dev"` and verify the port is free before
concluding anything.

**Back up every file a test *could* touch, not the one you expect.** Two files of
the user's were damaged this way (`cora/layout.tsx`, `meridian/design-system/
page.tsx`), both untracked so git could not help. `next/verify.js` does this
correctly — copies to `.backups/` and asserts byte-exact restore. Ad-hoc probes
must do the same.

**A backup is only a backup if the restore always runs.** `verify.js` used to
restore on the happy path only, so one thrown locator skipped it and left a test
edit sitting in the user's file. It happened again while adding removal. The
writes now live in a `try` and the restore in a `finally`.

**Name backups after the path, not the basename.** Three of the guarded files
are called `page.tsx`. Two guards taken in the same millisecond produced the
same `page.tsx.<ms>.bak` and one silently overwrote the other — the only copy of
a file, gone, in the code whose entire job is not to do that.

**Never compare colours as strings.** The same colour arrives as `rgb()`,
`oklch()` or `lab()` depending on where it came from. Paint it to a 1×1 canvas
and compare the resolved RGB. This produced three separate false failures.

**Assert that a patch matched.** A `str.replace()` whose anchor did not match
fails silently. One such no-op left three functions undefined and produced
`readFontSize is not defined` on every selection, surfacing as three unrelated
test failures.

**CSS nesting means every `CSSStyleRule` has a `cssRules` list.** Treating that
as "this is a group, recurse and skip" skipped all 1,580 real rules on the page.
Read the rule first, recurse only when the list is non-empty.

**Attributes bind to the last item in a comma-separated selector.**
`'[a],[b]' + '[data-theme]'` gives `[a],[b][data-theme]`. This made the panel
permanently dark. Use the `both()` helper.

**A visible panel no longer means something is selected.** The panel is on
screen for the whole of edit mode; only its body folds away. Four assertions
across three suites were using `panel.isVisible()` as a proxy for "an element is
selected". `[data-tw-idle]` on the panel is the signal.

**Hovering a container lands on whichever child owns its centre.** A test that
hovered a `<section>` and asserted the outline on that section found nothing —
Playwright aims at the centre point, the `<h1>` inside owns it, and the editor
highlights the innermost stamped element. Hover leaves, or assert on what is
actually under the point.

**Address elements by role, not DOM position.** Tests that used "first button" or
"last span in the panel" broke every time the UI moved. Use `data-tw-step`,
`data-tw-status`, `data-tw-field`, `data-tw-add`.

**Clean `.next` before asserting a production build is clean** — Next 16 keeps
dev and build output in separate trees, and a stale `.next/dev/` produced a false
positive.

---

## Test discipline

`npm test` runs 10 suites: 3 pure-unit (`00`, `05`, `06`) and 7 browser suites
against `test/fixture.html` copied to a temp dir — the demo page is never
mutated. Tailwind is served locally (`@tailwindcss/browser`), not from a CDN, so
runs are offline-capable and deterministic.

`next/verify.js` is the live suite: 55 checks against the real Next app,
including refusals, security (401/403/415), and byte-exact restore of every file
it touches. The radius block runs against `experiments/cora/login` specifically
because Cora redefines the radius ladder — every number it asserts would be
wrong if the overlay read `--radius-*` instead of the generated rule. The
removal block runs against `volt/design-system` for the opposite reason: one
line there renders 19 elements, which is the case the warning exists for.

Every change here has ended with a real edit to a real file and a byte-level diff
assertion. Keep that bar.
