# thisone: tests

`npm test` is offline and repeatable. The two `next/verify*.js` scripts are
not: they drive the real Next app in `../uiux_experiment`, and the prompt one
spends real Claude quota. This file says which suite owns which behaviour, so a
new check lands where the next person will look for it.

## The offline suite

`npm test` runs 13 suites through `test/run.mjs`:

- **4 unit suites**, no browser: `00-families`, `05-jsx-adapter`, `06-detect`,
  `12-icons`.
- **9 browser suites** (Playwright, Chromium) against a temp copy of
  `test/fixture.html`. The demo `index.html` is never touched. Tailwind is
  served locally from `@tailwindcss/browser`, not a CDN, so runs work offline.

All browser suites share one `server.js` on port 3131, so run one `npm test` at
a time and free the port first:

```bash
lsof -ti tcp:3131 | xargs -r kill -9
```

Then check the port is actually free before running. The runner's own
`server.kill()` does not always take, and a held port makes the next run's
suites talk to a dead server's fixture. The symptom is failures that wander
between suites and runs.

## Who owns what

| suite | owns |
|---|---|
| `00-families` | The class-family regexes: which prefix means what. Unit. |
| `01-classes` | The colour row and the picker. |
| `02-spacing-sides` | Steppers, reveal rows, the "could a + do anything" rule. |
| `03-text` | The three families behind the `text-` prefix, and the Size field. |
| `04-safety` | The three bugs that made the first version untrustworthy: unsaved edits vanishing on refresh, the all-sides control ignoring `px-*`/`py-*`, and a stale id writing to the wrong element after an out-of-band edit. |
| `05-jsx-adapter` | The writer: resolving a location, replacing or cutting a span. Unit. |
| `06-detect` | Framework detection, wiring and unwiring, `whyItDied`. Unit. |
| `07-delete` | Removal in HTML mode. Nothing is destroyed until Save, so most checks are about what has not happened yet. |
| `08-edit-mode` | The editor is off until asked for. Most checks are about the editor not acting. |
| `09-history` | The button bar outliving the selection, and undo/redo restoring the page and the pending count together. |
| `10-radius-corners` | The four-corner radius view. |
| `11-stroke` | The four families behind the `border-` prefix. |
| `12-icons` | `assets/` against the inlined `ICONS`. Unit. |

### `01-classes`: colour

- The swatch is the only thing that opens the list. It is 40px wide with its
  chip on the 12px gutter.
- The value is an `<input>`. It takes `#4837CA`, `48c`, `emerald-500` and
  `bg-emerald-700/40` alike, and puts itself back on anything else.
- A token shows the unlink 10px in from the field's edge, with no chevron
  behind it. The unlink keeps the paint and changes only the class.
- The opacity field takes its 57px and its 12px gap out of the colour field,
  not out of the row.
- The minus folds the row back onto a + in the same 40x40 tile it was clicked
  in.
- The picker sits above the presets. Dragging the square writes a hex that
  actually paints (the class is in no source file, so if it paints,
  `ensurePreviewRule` worked). A drag undoes as one step.
- A hue opens a ramp 6px to the palette's left with the palette still open
  behind it and a ring on the hue. The two first squares sit on one line. A
  shade is the same 20x20 square a hue is, and eleven of them stand on the 20px
  gutter at both ends. Closing the ramp leaves the palette in place. Picking a
  shade writes the class and closes both.
- Colour is compared by painting it, never as a string. The same green arrives
  as `oklch()` from a utility and `rgb()` from the picker.

### `02-spacing-sides`: steppers and reveal rows

- A `1.5rem` literal steps from the 24px it renders, not the 1.5 it says.
- A step off the ladder is italic and snowflaked while the field still has
  focus.
- Notes are centred beside the icons, measured the same way.
- Every property has a reveal row whether or not it is set, in the order the
  panel reads in. The + sits in the same column a section toggle does.
  Revealing writes nothing.
- gap is offered on a flex container with two children, and refused on a block
  element and on a flex container with one item. The two-child case is a
  `<section>`, so its expected order has no Text row: a container's text
  belongs to its children.
- Five checks pin the gap icon pairing, including `flex-row-reverse` and
  `grid`.

### `03-text`: the `text-` prefix and the Size field

- The Size value is an `<input>` with the chevron as the opener.
- A token reads as the pixels it renders, with the rung in the note.
- A typed 18 is written `text-[18px]` and not `text-lg`, even where `lg` is
  exactly 18.
- A name, with or without the `text-` prefix, asks for the token.
- Another unit keeps itself in the field and in the class.
- A word puts the value back and writes nothing. Tabbing through is not an
  edit.
- An arrow is one pixel and Shift is ten. The marking lands on the press, not
  at the next blur.
- Clearing takes the size off while `text-indigo-600` beside it stays.
- The block runs on the `<h1>` and restores the heading through the field
  itself, which also checks that a typed token restores it.

### `10-radius-corners`

- A corner overrides the box. The box clears the corners.
- One value typed into the box flattens all four.
- A comma list survives a tab through it.
- A corner counts one pixel at a time and ten with Shift. Stepping below zero
  drops the class rather than pinning it.
- The four-corner view opens by itself on an element authored per-corner.
- The class reaches disk beside the box rung with nothing else on the line
  moved.
- Its last selection clicks the card at x=120, not the corner. By then the card
  has a 16px radius and (3,3) is outside the arc, on the `<main>` behind it.

### `11-stroke`: the `border-` prefix

- The four families (width, style, colour, per-side) are read apart and written
  apart.
- `border-collapse` offers a + like any unset row, not a stroke.
- A box colour takes `border-b-red-500` with it.
- Revealing writes exactly `border border-solid border-black`, and the page
  draws it on a fixture that has generated no such rule.
- A rung is written as the rung. 3px is written `border-[3px]`.
- An arrow is one pixel and Shift is ten. A leap under zero stops at zero, and
  the press after it drops the class.
- The minus takes all three classes at once.
- What is left reaches disk with nothing else on the line moved.
- Selections click the card at x=120: the delete handle sits on the element's
  top-left corner and swallows a click at (3,3). The panel is closed with the
  header's × rather than Escape, because by then the caret is in a field.

### `12-icons`

The only suite that reads `assets/`. It re-derives every `ICONS` entry from its
file, requires every file to be claimed by an entry, and refuses two exports
that share an id. Pure unit, so it runs first and costs nothing.

## The live suites

### `next/verify.js`: 96 checks

Runs against the real app. Covers refusals, security (401, 403, 415), and a
byte-exact restore of every file it touches. Some blocks are pinned to specific
routes on purpose:

- **Radius** runs on `experiments/cora/login` because Cora redefines the
  radius ladder. Every number it asserts would be wrong if the overlay read
  `--radius-*` instead of the generated rule. The per-corner block is on Cora
  too and asserts 21.6px, where a corner built from the stock ladder would say
  16px.
- **Removal** runs on `volt/design-system` because one line there renders 19
  elements, which is what the warning exists for.
- **Font families** are split across two routes, and the split matters.
  **Murmur** carries discovery: a `--font-*` in `@layer theme` with no
  generated utility is offered anyway (Inter, Space Grotesk), next/font's
  variables outside that layer are not, every note is one of the five CSS
  generics, the ordering follows them, the tooltip carries the token, and two
  keys injected at runtime show that a `cursive` face is named in full while a
  stack naming no generic is not offered. **Volt** carries the write: pick,
  preview, save, and watch Tailwind generate the utility.

They are split because of a trap. **Tailwind's dev server keeps a utility once
it has generated one, even after the class leaves the source.** So a route the
suite writes to stops being a route with no utility after the first run, and
`!utils['volt-mono']` passed once and never again. Nothing writes to Murmur, so
nothing spends it. Volt's target is derived from the page, and the rule it
asserts flips with what it finds: one runtime rule where the page owns none,
no runtime rule where it already does. That second case is the shadowing guard
and is worth asserting on its own.

### `next/verify-prompt.js`: 14 checks

The Prompt tab's suite. It ends in a real Claude turn that edits
`cora/login/page.tsx`, then restores it byte-exact. It is deliberately not in
`npm test`: the rest of the suite is offline and deterministic, and a turn that
calls a model is neither, and spends real quota. Run it by hand with the server
started `--prompt`.

## The bar

Every change here has ended with a real edit to a real file and a byte-level
diff assertion. Keep that bar.
