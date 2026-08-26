# bw-pl-browsereditor — handover

A visual Tailwind editor: turn on edit mode, click an element in the browser,
change its classes and text or remove it outright, and the edit is written back
into the source file it came from.

Two modes share one client:

- **HTML** — `server.js` tags elements as it serves a flat `index.html`.
- **Next.js** — a Turbopack loader stamps each JSX host element with its source
  location; `next/server.js` runs as a separate process and writes the `.tsx`.

Working today against `../uiux_experiment` (Next 16.2.4, Tailwind 4.2.4).
21 commits, `npm test` green.

---

## Run it

```bash
npm test                                   # 11 suites, ~80s
node cli.js --root ../uiux_experiment --check   # inspect a project
node cli.js --root ../uiux_experiment           # start the editor server (port 3500)
node cli.js --root ../uiux_experiment --prompt  # …with the Prompt tab enabled
cd ../uiux_experiment && npx next dev           # the app itself (port 3000)

PORT=3001 node server.js                   # the standalone HTML demo
node next/verify.js --root ../uiux_experiment   # 79 live checks against the real app
node next/verify-prompt.js --root ../uiux_experiment  # 14 live checks, needs --prompt
```

Without `--prompt` the route 404s and the overlay is told `promptEndpoint:null`,
so the tab is never drawn. Two tabs on screen means the flag is on.

`uiux_experiment` is already wired (`next.config.ts`, `src/app/layout.tsx`,
`tools/bw-loader.cjs`). `cli.js --unwire` removes it, byte-exactly.

---

## Layout

| file | what it is |
|---|---|
| `editor.js` | the whole client overlay — panel, selection, all controls (~2900 lines) |
| `server.js` | HTML mode: tags, serves, writes back |
| `next/loader.cjs` | Turbopack loader — stamps `data-bw-loc="file:line:col:hash"` |
| `next/jsx-adapter.js` | the writer: resolves a location, replaces or cuts a byte span |
| `next/palette.js` | compiles the dev preview stylesheet; extracts colours/sizes/weights/radii |
| `next/server.js` | the editor server for a Next project |
| `next/claude.js` | the Prompt tab's backend — one headless `claude -p` per turn |
| `next/verify-prompt.js` | live suite for the Prompt tab; spends real quota, not in `npm test` |
| `next/astro-locator.mjs` | written, **unused** — Astro is blocked, see below |
| `assets/` | the panel's icons, exported from Figma and inlined verbatim |
| `detect.js` / `cli.js` | framework detection and `bw-edit` |
| `test/` | 11 suites; `run.mjs` orchestrates |

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

**Radius is one field over four, not one view swapped for another.** Frame
2:270: the box field across the full width with a 40x40 toggle beside it, and
the four corners in a 2x2 grid underneath — top row then bottom, the order
`border-radius` says them in. The corners sit *under* the summary rather than
replacing it, which is where this parts from padding and margin: their toggle
swaps two axes for four edges because `px-*` and `pt-*` are the same kind of
thing, and here there is no middle level to swap to. The field above is the
summary, and it earns its line while the four are open because when they
disagree it is the only place all four are said at once.

**Radius is spoken in pixels too, box and corners alike.** All five are the
same field — `radiusField(target)`, `side: null` for the box — and all five
show a bare number: 12, not `xl`, and no `12px` note beside it. The rung is
still what gets written where one lands (`rounded-lg`, `rounded-tl-lg`), and
anything else becomes `rounded-[13px]` with the snowflake on it, exactly as
spacing does. The reason is the same reason spacing gives: `lg` is 12 here and
8 somewhere else, so a token name makes you look it up before you can read your
own element. The name survives in the tooltip and in the dropdown's filter.

**`rounded-full` is the one rung with no length, so it keeps the symbol.**
`calc(infinity * 1px)`, which computes to an eight-digit number no field should
print. It shows `∞`, in the field and in the list, and the tooltip names the
class.

**Four corners that disagree are said in full, comma separated.** An axis shows
`0, 8` for the same reason: one number would be a lie about the others, and
naming the disagreement ("Mixed") or averaging it tells you less than the four
values do. Typing one value over the list flattens all four; tabbing through it
does not, because a comma list parses as nothing writable and the field puts
itself back. Like the axis's pair, this is the state the unfolded view exists
for — decided when the element is selected, so the toggle owns it after that.

**Radius sits with padding and margin, not with typography.** It describes the
same box they do. Appended straight after the margin section in the body build
rather than at a fixed index, so it stays put as rows come and go. Gap follows
it, which is the one oddity: the BOXES loop puts gap last, and gap shows on
flex and grid containers only, so most selections never see the seam.

**gap shows the gap the element is using, and offers no switch.** `gap-4`,
`gap-x-4` and `gap-y-4` are three different statements about a container, and
the panel shows the one being made: one field for `gap-4`, one for whichever
axis is set, two when both are. A container saying `gap-x-4` is saying nothing
about its rows, so a row-gap field there is a control for a decision nobody
took — and a toggle between "one gap" and "two gaps" is a question about the
class list rather than about the page. Nothing set yet is the one gap, which is
what `gap-4` means and what the + row reveals into. Padding and margin keep
their toggle: `px-*` and `pt-*` really are two views of the same four edges,
where these three are three different classes.

**A property that is not set keeps its row, with a + in it.** Frame 4:407 draws
Margin that way — a 40px line, the label on the left, a + in the same 40x40
tile a section's toggle occupies — sitting in Margin's own slot between Padding
and Typography. That placement is the point, and it is what the strip of chips
at the foot of the panel got wrong: every unset property had been moved out of
the order the panel otherwise reads in, so finding one meant knowing to look at
the end, and revealing it made the layout jump as the row appeared somewhere
else. A row already in place only fills in. Revealing still writes nothing.

**A + is only offered where the property could change the page.** A row that is
merely unset keeps its slot; a row that could do nothing whatever you set in it
has no slot at all, because opening it hands you controls that are inert. Two
of them fail that test on ordinary elements. **Typography** needs text under it
— its own or a descendant's, since type cascades and a card holding a heading
really can be given a family — so an `<img>`, a spacer or an empty div offers
nothing. The looser test is deliberate: `hasOwnText`, which is what the section's
own fields use, would leave the + on no element at all, since an element that
passes it is already showing the section. **gap** needs a container that is flex
or grid *and* has two things to stand between: one item lays out identically at
every value gap can take, and text counts, because a bare string inside a flex
parent is an anonymous flex item like any other. The rule is the + row's alone
in both cases — an element already carrying `gap-4` keeps its field however few
children it has, so a stale class stays removable.

**The reveal row is a button, not a row with a button in it.** A 20px + is a
small thing to hit for something this coarse, and the row has one meaning end
to end — so the whole 312px takes the click and the label is part of the target
rather than text sitting beside one. One element, so nothing is nested inside
it: the tile at the right is a span drawn to look like the toggle it stands in
for, and it lights on hover of the row, not of itself.

**The hairlines are each row's own, and which row goes without one is decided
in code.** Frame 4:407 puts a line edge to edge between rows, centred in the
20px between them — at `#333333`, not the frame's `#232323`, because that is
the same value as a field's background: every line that ran past a field
disappeared into it and the rule only showed in the gaps. `#333333` is the
panel's other hairline, the one around a dropdown, so it is a colour the design
already uses for this job rather than an invented shade.

**Every row stands 20px off its line, and the two kinds of row buy it
differently.** The frame measures 20 on both sides — 167 to a Padding label at
186.5, 280 to a Margin one at 299.5. A reveal row already has it: its 15px
label is centred in a 40px box, so half the air is inside the box. An open row
starts at its label with only the 10px half-gap above it, so it takes the other
10 as `margin`, never `padding` — three suites measure those row boxes to the
pixel (69 and 173 among them), and this is space around a row rather than part
of one. `top` on the line is measured from the border box, so a row standing
10px further off has its line drawn 10px further away. The first row on screen
has no line to stand off from and the last has the footer: `has-rule` already
names the first, and `markDividers` sets `is-last` beside it. It is drawn as the row's `::before`, 20px outside it
on both sides, so it travels with the row — which means `.bw-body` needs
`overflow-x:hidden`, because `overflow-y:auto` alone computes overflow-x to
`auto` and hangs a scrollbar off that 20px. The top row must have no line, and
`:first-child` cannot see that the rows above it are `display:none`, so
`markDividers()` runs after every readout has decided who is on screen.

**A section says whether it showed; its + row does not work it out again.**
`shown[key]`, set by the section's own readout and read by the reveal row's —
the row is appended after the section, so its readout runs after. The
alternative was re-deriving each field's own visibility test in a second place,
which is the shape of thing that drifts.

**Typography reveals as one section, not as four fields.** The frame draws it
as one thing, and a + standing in for a 124px field would be a control wider
than what it offers. So the four `revealed.family/weight/font/align` keys
became one `revealed.typography`, and the row offers the section.

**One bar at the foot of the panel, holding whichever row the tab owns.** Send
and Save are the same kind of button doing the same kind of thing at the end of
the same panel, so they stand in the same place — 12px from the right edge,
10px from the bottom, both 40px tall — rather than each keeping their own
margins inside their own view. Send is built with the Prompt view it belongs to
and parked in the footer.

**Save, undo and redo are not on the Prompt tab at all**, pending edits or
none: they are the editor's ledger, and Claude's writes go straight to disk
without joining it. Nothing is stranded by that the way a background click used
to strand them — the Editor tab is one click away and brings the bar back with
its count intact.

**The footer's rule is keyed on the selection, not on `data-tw-idle`.** Idle
means the editor's controls are folded, which the Prompt tab does too — and
there the footer has a composer above it to be divided from. `data-tw-empty`
says the thing the rule actually cares about: with nothing selected the footer
IS the panel, so there is nothing above it to divide. Its colour is EDGE like
every other rule, for the reason the row dividers are.

**The Prompt tab reads in the order a chat reads: context, then what has been
said, then the box you say the next thing in.** The composer used to sit at the
top with the transcript growing under it, which put the newest reply furthest
from the field that produced it. 20px of air above the first message and below
the last, which is why the log's bottom padding is 0 — the composer's own 20px
is what stands under the transcript, and a padding there would have been added
to it. Measured 15 above against 34 below before that. The log carries no top
border either: the tab strip's rule already divides it from the tabs, and with
an empty context line the two sat on top of each other.

**A turn that worked reports nothing back.** The seconds it took and the share
of the plan's five-hour window it used are facts about the machinery, not about
the change you asked for, and they sat under the field until the next thing you
typed. The hint is still where a failure goes.

**The tab strip has no padding at its top, and 20 at its foot.** The 60px
header already leaves 19px under the title it centres, so the strip's own 20
made a 39px void between the title and the tabs where everything else in the
panel sits 20 apart. The 20 below stays, so the tabs stand off their own rule
the way a row stands off a divider — and `.bw-pform` is 20 all round for the
same reason, where 12 had the composer crowding the line while sitting 20 off
the sides.

**The + is the export's too.** `assets/ic-plus.svg`, 20x20 on the frame's grid
in the design's `#aaa`, replacing a 9x9 `currentColor` glyph drawn back when
the export had no file for it. It sits in a `.bw-toggle` — the same tile and
the same hover fill every section toggle uses — so the right-hand column holds
still whichever of the two a row is showing.

**The all-corners write clears every `rounded*` on the element.** Same rule as
`px-*` over `pl-*`: leaving a more specific class in place means the field you
just used does nothing. Picking `md` on an element wearing `rounded-tl-[3px]`
has to take the corner with it, or `Mixed` stays `Mixed` and the pick reads as
broken. The corners have fields of their own to put a value back into, which is
what makes the clearing safe — the four-corner view is already open whenever
they disagree.

**A per-corner rung always needs a runtime rule, even where the whole-box one
does not.** The rule that leaves a route's own `.rounded-lg` alone does not
apply to `.rounded-tl-lg`: Tailwind has generated nothing for it whatever the
route uses. So it gets one — built from the live value where there is one, so
the corner lands on the same number the box rung does. On Cora, `2xl` on a
corner previews at 21.6px, not the stock 16px, which is the live suite's
assertion.

**The corner icons are the export's, and the toggle wears the all-corners one
twice.** `assets/ic-radius-{all,tl,tr,bl,br}.svg`: four brackets, the one the
field owns lit and the other three stepped back to the export's `#414141`.
Padding and margin have a distinct `Parts` glyph for the open state; radius has
no such file in the frame, and drawing one would be inventing — so the toggle
keeps the all-corners mark in both states and the pressed fill, which every
toggle already has, is what says which state it is in. This replaced the
hand-drawn `radius` glyph, which existed only because the export had no file
for it and now does.

**A list row is a list row: one size, one weight, whatever it names.** The
size list used to set each rung's name at the size it names and the weight
list to set each name in the weight it names, in the element's own face. Both
had to be capped to keep a row a row — so they stopped drawing the real value
exactly where the values got interesting — and the number on the right was
carrying the truth the whole time. It now carries it alone. The one specimen
that stays is the family list, because a typeface is the one value here whose
*name* is not the point.

**The weight list says what it ships by what it lists.** The caption above it
("5 of 9 shipped by this font") named a fact the rows already made plain: a
weight the font does not have is not offered, and one that is set but not
shipped is kept on its own row labelled `faux`.

**The palette is a grid of colour, not a list of names.** Nine swatches to a
row inside the popover's own 8px, which puts a swatch at 16px — what a 220px
popover has room for with nine on a line. A name needs a row each and turns
two dozen colours into a scroll; the tooltip carries it, and a ramp's tooltip
says it opens rather than applies, because clicking it does. The Theme and
Palette captions take a line of their own rather than a cell, so the ordering
that put project tokens first is still legible. The shade view underneath
already worked this way.

**Revealing a colour writes white; revealing anything else writes nothing.**
The one exception to the rule above it, and for the reason the colour rows hide
at all: a padding field with no class still tells you the element renders 0,
where a colour field with no class is a dash and an empty swatch. So the + puts
a value there, and white is the one value that is white on every route rather
than a guess at the project's palette. It lands as `bg-white` / `text-white` —
a token, not `#FFF`, so it reads as a token in the field — and `ensurePreviewRule`
gives it a rule on a route that has never generated one.

**The rung dropdown is a list of lengths, and nothing else.** It used to draw
a corner at true scale beside each row, capped so a row stayed a row — and the
cap was the tell: past it every rung drew the same quarter circle, so the
preview stopped distinguishing exactly where the values got interesting. It
used to name the rung too. Both are gone, and the row is `12px` the way the
spacing list's row is `16px`. `tokenList` already filtered on the token as well
as the label, so typing `xl` still finds it.

**Font sizes and weights come from the server, not the page.** Opposite of
colours, because Tailwind v4 emits utilities *and* theme variables on demand — a
route using two sizes exposes exactly two. The full ladder only exists in
`theme.css`.

**Font *families* come from the page, like colours — and the read is itself
the membership test.** A family is only offered if the route generated a
`.font-<name>` rule that sets `font-family`. `.font-medium` sets `font-weight`
and carries no family, so it can never enter the map and can never be stripped
by a family write: the `/^font-/` trap below is disarmed by construction rather
than by a second regex. It also means no rule is ever added to preview one —
the utility is in the list *because* the page already has it, which is the
opposite of the `px-6 md:px-12` failure. On `uiux_experiment` this finds four
on Cora, one of them the project's own (`accent` → Square Peg): a bundled list
of web fonts would offer faces the page cannot render and miss that one.

**A family declaration is not always a stack.** `@theme inline` bakes the value
in, but a plain `@theme` emits `font-family:var(--font-sans)` — and
`var(--font-sans)` is not the name of a typeface, which is what the panel
showed at first. The chain is followed by painting it onto a probe rather than
by parsing, because a var may point at another var and only the cascade knows.
The probe sits inside a host wearing a sentinel family: a var resolving to
nothing is invalid at computed-value time and *inherits*, so without the
sentinel a dead token would report whatever the panel happens to inherit as
though the element rendered in it. Measured on the real app: `/` gives
`var(--font-geist-sans)` → Geist, volt/polaris/meridian give `var(--font-sans)`
→ `ui-sans-serif`, Cora needs no resolving at all.

**`cn()` is edited by delta, not by snapshot.** The rendered class string is the
union of every argument, so writing it into argument one would duplicate what the
conditionals contributed. The client sends `added`/`removed` against a baseline
captured at selection.

**Family matching is by membership, not prefix.** `font-medium` is a weight,
`font-sans` is a family — `/^font-/` would delete `font-sans` on every weight
change (150 and 438 uses at risk). Same for colours: `text-lg` is a size,
`text-clay` a colour. `gap-` needs a lookahead because `gap-x-4` starts with it.
`rounded-` is the same trap twice over: `rounded-sm` is a rung, `rounded-s` is
the two start corners, and `rounded-t-lg` is neither. Four levels wear the one
word now — the box, the edges, the corners, the logical forms — and `radiusOn`
separates them by matching the base whole and then testing the tail for
membership, so `rounded` can never swallow `rounded-tl-lg`.
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
cannot see `pt-*`, so reading an axis reads its edges. Disagreement is the only
reason the four-edge view opens: `pt-0 pb-0 pl-4 pr-4` reads perfectly well as
0 and 16, and two inputs beat four for saying the same thing. Folded, a
disagreeing pair shows comma separated and upright — two real values are not one
inherited one — with `0` for an edge that owns no class, because `, 8` reads as
a missing number.
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

**The colour field wears its swatch the size the frame draws it.** Frame
4:551: 20x20 at a 3px radius on the 12px gutter, name 8px after it, so the
value starts at 40 — the same place a spacing field's value starts behind its
20px mark, which is why the two rows line up. Sized on `.bw-color .bw-chip`
rather than on `.bw-chip`, because the same class draws the swatches in the
dropdown list and the frame keeps those small.

**A colour with nothing set stands in for itself, like every other optional
row.** Background and Text color were the last two always on show, and an
element that sets neither got two controls describing nothing: a dash and an
empty checkerboard swatch. They now hide behind the + row, on `revealed.bg` and
`revealed.text`. The four `pickColor` helpers across the suites open that row
first when it is showing, which is what a person does.

**A colour set by a `style` attribute is read, and refused.** 714 elements in
uiux_experiment carry a `style` prop and 263 of them set a colour — this is an
idiom, not an edge. There is nothing in the class list to read, so the panel
called such an element unset, drew a dash and an empty swatch, and once the
colour rows learned to hide, offered a + for a colour plainly on screen. It now
reads `el.style.color` / `el.style.backgroundColor`, paints the swatch with
what is actually computed, and prints the hex. And it stops there: an inline
declaration outranks every class, so a class written here would be inert — the
field disables itself and the title says where the colour comes from. Same rule
as `px-*` clearing `pl-*`, met from the other side. Every *other* field has the
same blind spot against an inline style; only colour is handled.

**What you can do to a colour lives in the list, not in the field.** The field
used to grow a small unlink button under the cursor, beside the value — which
reads as "delete this" whatever its icon says — and removing a colour had no
home at all: the palette could only ever put one on. Since a revealed row now
starts at white, that meant a colour you could add and not take off. Both
actions are named rows under the swatches, under *both* views, because a token
colour opens straight into its own shade grid and actions only on the palette
would be actions you never see. Removing also sets `revealed`, or the row would
have nothing to show, fold back to its + and take the field out from under the
cursor that just used it — and that + writes white.

**A hex colour is a literal, and this was the one field that never said so.**
Every other value in the panel that is not a token on a scale is italic, a
shade back, and carries the snowflake; an arbitrary colour showed the hex at
full contrast with nothing to mark it. It now takes `is-custom` and the
snowflake from the same condition — `kind === 'arbitrary'` — which is what the
cross-field assertion below requires, and the snowflake sits where a unit sits
so the chevron takes its place on hover exactly as elsewhere.

**Italic means one thing: this value is a literal.** It used to mean "inherited
from a broader class", which put top and bottom into italic the moment you typed
a vertical value — two unrelated ideas wearing one style. Inherited keeps the
dimmed colour, which is the half of that pair that reads as "not this element's
own". A literal is italic and a shade back (`#b4b4b4`), and carries the
snowflake: the two are set from the same condition and a test asserts they never
disagree on any field.

**Typography is one section, not three rows.** Frame `1:3`: the family across
the full width, weight and size sharing the line below it, the alignment
segment below that — 40px rows, 12px apart, 8px under the label, 173px in
total, which the live suite asserts to the pixel. Three labels became one
because they name one thing, and because a 124px field cannot afford a label
beside it. Each field still decides its own visibility exactly as it did when
it owned a row, and the weight/size pair collapses to a single column rather
than leaving a hole.

**These fields are bare — no leading mark — and that is why.** Two of them
share one 260px line, so a 20px icon with its 10px margins would eat a third
of what each is left with. The dropdowns that still have a row to themselves —
radius, the two colours — keep their marks. The one exception is the family's
`Ag`, which is not an icon but the face itself, set in the face: a typeface is
the one value in this panel whose *name* is not the point.

**A family is named by its typeface, with the token beside it.** `font-sans`
is Euclid Circular B here and Inter somewhere else; "sans" is only the slot
holding it. Both are shown — face on the left, token on the right — because
which slot it came from is real information too. Only the *first* entry of the
stack is ever named: the rest are understudies the page uses when the first is
missing, so on `ui-monospace, "Cascadia Code"` naming Cascadia Code would name
the wrong font.

**The focus ring is an outline, not an inset shadow.** A child's background
paints over its parent's inset shadow, and the token button fills its field
edge to edge — so the ring on an open dropdown was being drawn the whole time
and hidden under `.bw-ctoken:hover`, which is exactly where the cursor is after
the click that opened it. `outline` is painted over descendants; at
`outline-offset:-1px` it lands where the shadow did and follows the same 8px
radius.

**A generic is not a typeface, so the name is measured — by painting it.**
`ui-sans-serif` is a request, the platform answers it, and CSS never says
what it answered. So the answer is drawn and compared: render a probe string
in the stack, render it again in each candidate face, hash the *bitmaps*.
The same move as the colours, for the same reason — the serialised value does
not tell you what you will see. Bitmaps rather than widths because the pairs
that matter are the metric-compatible clones: Arial and Liberation Sans are
designed to measure identically and to draw differently. A candidate that is
not installed falls through a bogus second entry onto the browser default,
which is what the control measures, so a missing font is skipped rather than
matched and can never be named.

**Verified that the canvas answers the same question the page does.** Measured
both ways across fourteen stacks: the DOM's width groups and the canvas's ink
groups partition identically, so the fingerprint is representative. That check
also turned up the thing worth knowing — this Chromium supports **none** of
`ui-sans-serif` / `ui-serif` / `ui-monospace`, in CSS or canvas. They fall
straight through, which is why the same `ui-monospace` leads to Menlo on volt
(via `SFMono-Regular, Menlo`) and to Courier on Cora (via the default
`monospace`), and why printing that keyword was naming the one string
guaranteed *not* to be on screen.

**Where measuring cannot name it, the fallback is stated, never invented.**
macOS draws `ui-sans-serif` with `.AppleSystemUIFont`, which no addressable
family matches — the installed "SF Pro" is present and measurably different,
being an optical variant Chromium does not use here. But matching `system-ui`
*proves* it is the platform UI font, so a small table then says what that font
is called (macOS SF Pro, Windows Segoe UI, Android Roboto; desktop Linux has
no one answer and gets none). The cascade is measured → placed → the first
name the author actually wrote in the stack → the token, each tier less
certain than the last, and the tooltip carries the true stack throughout.

**A family names itself in its own face — in the list and in the field.** The
specimen and the label are one object, which is how any type picker worth
using shows a font, and the field keeps the face after you pick from it. This
needs headroom the panel's own type does not: `.bw-cname` is 15px/**1** with
`overflow:hidden` for the ellipsis, which clips both axes, so a script face
loses its ascenders and tail to it — `is-face` buys line-height 1.6 and leaves
the size at the frame's 15px, because the field sits beside `400` and `16px`.

**Two `margin-left:auto` in one row split the free space between them.** The
note carried one and the chevron carried another, which stranded `inherited`
halfway across a wide field instead of against the chevron. The name takes the
slack now (`flex:1`) and the note sits at its natural width. `flex:1` on that
name then needed `text-align:left`, because the token is a `<button>` and a
button centres its text — invisible while the span was auto-width, obvious the
moment it owned the whole field.

**`flex:1` on a `.bw-field` means *height* once the field is in a column.**
The family field collapsed from 40px to the 15px of its own line box. The two
in the pair below it are grid items, which ignore `flex` — which is exactly
why only one of the three broke, and why it looked like a family-only bug.

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

**The Prompt tab runs its own session, because the one in VSCode cannot be
driven from outside.** This was tried first and the extension refuses it by
name: `claude-vscode.editor.open` does take an `initialPrompt`, but `createPanel`
answers a session that is already open with *"Session is already open. Your
prompt was not applied — enter it manually"*, and even on the new-session path
the webview only calls `setInputText` — a prefill, never a submit. The websocket
advertised in `~/.claude/ide/<port>.lock` is the extension serving *terminal*
CLI sessions, and its whole method surface is `get_current_selection`,
`selection_changed`, `at_mentioned`, `openDiff`, `executeCode`: nothing there
submits a turn. So the editor spawns `claude -p` itself, which it can finish a
turn with. Re-check this against the extension bundle before trying again.

**A turn is a child process, not a daemon.** `--resume` carries the conversation
forward, so there is no long-lived process to supervise, no stdin protocol to
keep in sync, and a hung turn is ended by killing a pid. Measured: the second
turn of a session costs about a tenth of the first, because the prompt cache
does the work a persistent process would have been kept alive for.

**What the panel reports after a turn is seconds and the plan's five-hour
window — never dollars.** `claude -p` authenticates with the OAuth credentials
already on the machine, the same ones the CLI and the extension use, so a turn
draws on the subscription's rolling windows. `total_cost_usd` in the result
envelope is an equivalent computed at list prices, not a charge anyone is
billed; printing it beside a subscription turn is a plausible-looking lie. The
real number is in `rate_limit_event.unifiedWindows.five_hour.utilization`.

**The prompt points at the element rather than describing it.** The loader has
already stamped `file:line:col` on it, so the preamble can name the file, the
line, the tag and the current className — which is the whole reason this beats
typing the same sentence into a terminal. Where one location renders several
elements the count goes in too, since that is the case the person cannot see.

**A pending edit refuses the turn.** Class changes live in the DOM until Save;
Claude reads the file off disk. A turn started with edits pending reasons about
a version of the file that does not exist, and its write silently drops them.
The refusal names the count and says why.

**The fence is a deny list, not an allow list.** `--allowed-tools` is the
auto-approve list — passing it an empty string still leaves every tool available.
What keeps Bash out of the session is `--disallowed-tools`, and the network
tools go with it so a prompt typed into a web page cannot reach off the machine.

**`/prompt` is opt-in where `/edit` is not.** They wear the same lock — same
origin check, same token, same 415 — but they are not the same kind of route.
`/edit` replaces a byte span in a `.tsx` under the root and `safeResolve` is what
makes that true; `/prompt` hands a sentence to a coding agent, and no amount of
path checking bounds what comes out. Same gate, categorically larger blast
radius, so it is off unless asked for and the tab is not drawn without it.

**The tabs are the panel's top edge, and a drag handle like the rest of the
chrome.** They sit above the header rather than inside it because the header
folds away with the selection and the tabs must not: switching to Prompt is
exactly what you do when nothing is selected. For the same reason `data-tw-idle`
now means "the editor controls have nothing to show", not "the panel is empty" —
folding the body on the Prompt tab would fold away the tab just switched to.

---

## Measured facts about these codebases

These drove the design; re-check them if the target changes.

| | uiux_experiment | gw-web |
|---|---|---|
| static `className="…"` | 1372 | 1956 (86%) |
| `cn()` | 0 | 47 |
| template literals | 26 | 217 (7.3%) |
| `style={{ }}` sites | **714** | — |
| &nbsp;&nbsp;static `color: "…"` | **381** | — |
| &nbsp;&nbsp;static `background(Color): "…"` | **176** | — |
| &nbsp;&nbsp;static `fontSize: "…"` | 78 | — |
| &nbsp;&nbsp;dynamic `color: {expr}` | 35 | — |
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

1. **Inline `style={{ }}` is invisible to the editor, and it is not rare.**
   Measured on `uiux_experiment` only after a locked Text color row prompted
   the question: **714** `style={{` sites against 1336 `className="`, carrying
   **381** static `color`, 176 `background`, 78 `fontSize`. Every one of those
   colours is refused, and correctly — an inline declaration outranks every
   class, so writing `text-slate-600` would change the file and nothing on
   screen — but refusing 381 of them is a coverage hole, not a corner case.
   **91% are static string literals in an object literal**, the same shape the
   byte-span writer already replaces for `className`; the 35 `{expr}` ones
   would be refused by name the way `cn()` and `cva()` are. The guard is also
   per-property and only the colour rows have it: the Size field on an element
   whose `style` sets `fontSize` still writes `text-3xl` to the file and
   previews nothing. Verified on `meridian/design-system/page.tsx:61`.
2. **Blast radius — warned about on removal only.** Editing an element inside a
   shared component changes every instance. Measured: cora 42% of elements,
   polaris 72%, volt **78%**, worst case one location rendering 19 elements.
   Removal now counts `[data-bw-loc^="file:line:col:"]`, ghosts all of them and
   says "renders 19 elements … removes all 19" before you can save. **Class and
   text edits still say nothing** — same one-line count, same place to put it.
3. **Template literals** — 211 sites in gw-web. Only the leading static quasi is
   safely editable; the delta mechanism from `cn()` already does the hard part.
4. **Text editing refuses late.** A leaf whose text is `{variable}` lets you type
   and only refuses at save. The panel should say so up front. On Cora only
   25.7% of elements have writable text; 59.6% are `mixed-content`.
5. **Packaging** — not installable by anyone else. Largest remaining chunk, and
   only worth it if other people will use it.
6. **HSV colour picker** — the detached/hex path shows a read-only hex. gw-web
   is 608 arbitrary colours, so "detached" is the norm there.
7. **Logical radius utilities are read but never written.** `rounded-s-lg`,
   `rounded-ss-*` and friends depend on writing direction, so they are left
   exactly as authored — membership matching means they are never mistaken for
   a rung — and the Radius field appends `+n` and names them in its tooltip so
   it never shows one radius while the element means two. Zero sites across
   both codebases. The four *physical* corners do have fields now; the
   *physical* edges (`rounded-l-[2px]`) have none, but are read into the two
   corners they paint and cleared by an all-corners write.
8. **A rung a route has never used previews at the stock value.** Cora derives
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

**`req.on('close')` is not "the client went away".** On a Node request it fires
as soon as the body has been read, which for `/prompt` is a moment *after* every
turn starts — so the abort handler killed each turn within milliseconds and
reported it as `claude exited null`, a signal death wearing a crash's clothes.
`res.on('close')` is the one that means the client disconnected. Guard it with a
`settled` flag either way, or the normal `res.end()` re-enters it.

**One `npm test` at a time.** Every browser suite shares one `server.js` on port
3131, and the suites run sequentially against it. A second run cannot bind the
port, dies, and leaves its suites talking to the *first* run's server — whose
fixture is a different temp file, so `/edit` answers 409 stale-hash. Symptoms
wander between suites and look like flakiness in whatever was touched last;
they were 11/11 both before and after, with nothing else running.

**Stale servers give misleading results.** Three times a `lsof | kill` did not
take, the new server died with `EADDRINUSE`, and an old one kept serving. Always
`pkill -f next-server; pkill -f "next dev"` and verify the port is free before
concluding anything. `run.mjs`'s own `server.kill()` is one of the ones that
does not always take: a finished `npm test` can leave 3131 held, so the *next*
run's server dies with `EADDRINUSE` and its suites talk to the previous run's
server — whose temp fixture has been deleted. The tell is failures that wander
between suites and between runs (a 409 stale-hash in one, a padding read of 24
where the fixture says 16 in the next). `lsof -ti tcp:3131 | xargs -r kill -9`
before every run, and confirm the port is free after the kill, not before.

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

`npm test` runs 11 suites: 3 pure-unit (`00`, `05`, `06`) and 8 browser suites
against `test/fixture.html` copied to a temp dir — the demo page is never
mutated. Tailwind is served locally (`@tailwindcss/browser`), not from a CDN, so
runs are offline-capable and deterministic.

`next/verify.js` is the live suite: 79 checks against the real Next app,
including refusals, security (401/403/415), and byte-exact restore of every file
it touches. The radius block runs against `experiments/cora/login` specifically
because Cora redefines the radius ladder — every number it asserts would be
wrong if the overlay read `--radius-*` instead of the generated rule. The
removal block runs against `volt/design-system` for the opposite reason: one
line there renders 19 elements, which is the case the warning exists for.
The per-corner block is on Cora too, and asserts 21.6px: a corner rung built
from the stock ladder instead would say 16px beside three 12px corners.

`test/02-spacing-sides.js` also owns the reveal rows: that every property has
one whether or not it is set, in the order the panel reads in, that the + sits
in the same column a section toggle does, and that revealing writes nothing.
It owns the "could this do anything" rule too: gap offered on a flex container
with two children, refused on a block one and on a flex one with a single item
to space. The two-child case is a `<section>` and not the `<h2>` the block cases
use, which is also why its expected order carries no Text row — a container's
text belongs to its children.

`test/10-radius-corners.js` covers the seam the live suite cannot reach
cheaply — a corner overriding the box, the box clearing the corners, one value
typed into the box flattening all four, a comma list surviving a tab through
it, stepping below the first rung dropping the class rather than pinning a
zero, the view opening by itself on an element authored per-corner, and the
class reaching disk beside the box rung with nothing else on the line moved.
Its last selection clicks the card at x=120, not the corner: by then the card
wears a 16px radius and (3,3) is outside the arc, on the `<main>` behind it.

`next/verify-prompt.js` is the Prompt tab's live suite: 14 checks, ending in a
real turn that edits `cora/login/page.tsx` and a byte-exact restore. It is
deliberately **not** part of `npm test` — the rest of the suite is offline and
deterministic, and a turn that calls a model is neither, and spends real quota.
Run it by hand, with the server started `--prompt`.

Every change here has ended with a real edit to a real file and a byte-level diff
assertion. Keep that bar.
