# thisone — handover

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
npm test                                   # 13 suites, ~85s
node cli.js --root ../uiux_experiment --check   # inspect a project
node cli.js --root ../uiux_experiment           # start the editor server (port 3500)
node cli.js --root ../uiux_experiment --prompt  # …with the Prompt tab enabled
cd ../uiux_experiment && npx next dev           # the app itself (port 3000)

PORT=3001 node server.js                   # the standalone HTML demo
node next/verify.js --root ../uiux_experiment   # 96 live checks against the real app
node next/verify-prompt.js --root ../uiux_experiment  # 14 live checks, needs --prompt
```

Without `--prompt` the route 404s and the overlay is told `promptEndpoint:null`,
so the tab is never drawn. Two tabs on screen means the flag is on.

`uiux_experiment` is already wired (`next.config.ts`, `src/app/layout.tsx`,
`tools/thisone-loader.cjs`). `cli.js --unwire` removes it, byte-exactly.

---

## Layout

| file | what it is |
|---|---|
| `editor.js` | the whole client overlay — panel, selection, all controls (~2900 lines) |
| `server.js` | HTML mode: tags, serves, writes back |
| `next/loader.cjs` | Turbopack loader — stamps `data-thisone-loc="file:line:col:hash"` |
| `next/jsx-adapter.js` | the writer: resolves a location, replaces or cuts a byte span |
| `next/palette.js` | compiles the dev preview stylesheet; extracts colours/sizes/weights/radii |
| `next/server.js` | the editor server for a Next project |
| `next/claude.js` | the Prompt tab's backend — one headless `claude -p` per turn |
| `next/verify-prompt.js` | live suite for the Prompt tab; spends real quota, not in `npm test` |
| `next/astro-locator.mjs` | written, **unused** — Astro is blocked, see below |
| `assets/` | the panel's icons, exported from Figma and inlined verbatim |
| `detect.js` / `cli.js` | framework detection and `thisone` |
| `test/` | 13 suites; `run.mjs` orchestrates |

Plans live at `~/.claude/plans/tailwind-editor-restructure.md` (current) and
`how-to-make-this-giggly-scone.md` (earlier, still accurate on security).

---

## Design decisions that were *not* obvious

Every one of these came from measuring the real codebases. Do not undo them
without re-measuring.

**The package is `thisone`, and only what reaches a stranger's repo was
renamed.** `this-one` is taken on npm by an abandoned package — 8 versions in 6
days in 2024, no README, 3 downloads a week — and `thisone` is free, which is
the better name anyway: you write it "this one" and you install `thisone`.
`this-one-editor` was rejected because "editor" is the same ceiling `tw-` would
have been, and the point is that the editing model is not specific to Tailwind
or to Next. About 46 sites moved: the bin, `tools/thisone-loader.cjs`,
`.thisone/backups/`, `NEXT_PUBLIC_THISONE_PORT`, the wire markers, and the
`data-thisone-*` attributes. The ~500 internal `bw-*` CSS classes and the 474
`data-tw-*` test hooks stayed exactly where they were: **`bw` is Bloomworks, the
studio prefix, not the product name.** That is the line — their repo speaks the
product's name, our own code speaks the house prefix.

**A rename adds to the marker lists; it never replaces them.** `detect.js` has
`LOADER_MARKS` and `SHIMS`, `cli.js` has `MARKS` and `hasMark()`, and each
carries every name this tool has ever written into a project. A project wired by
an older release still has the old name in its config and on disk, so a detector
that has forgotten it calls that project *unwired* — and `--unwire` then leaves
the block in place, which from the user's side is silent. This is not
hypothetical: it is what happened to `uiux_experiment` across the last rename,
and re-running the sed over `detect.js` reproduced it immediately, because a
blanket replace turns the legacy entry into a duplicate of the new one. `MARK`
is what `--wire` writes; `MARKS` is what everything else matches against.

**Writes are byte-span replacements, never AST reprints.** A save changes one
line; nothing else moves, no quote style or trailing comma shifts into the diff.
The loader and the writer share `hostElements()` so they cannot disagree about
what sits at `line:col`.

**Tailwind v4 has no runtime JIT.** A class the editor invents has no CSS until
it is in a source file. Preview comes from a dev-only palette compiled with the
*project's own* Tailwind, scoped to `[data-thisone-edited]`. Unscoped it beat the
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
pre-generated palette — a scoped `[data-thisone-edited].rounded-lg` would outrank
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

**`rounded-full` is the one rung with no length, so it says its own name.**
`calc(infinity * 1px)`, which computes to an eight-digit number no field should
print — 33554400 on this Chromium. It showed `∞` at first, which was true and
unreadable: a symbol nobody types, in a field you type into, standing for the
one rung whose class name is already the plainest thing about it. It now reads
`full` in the field and in the list, and the field **takes** `full` typed back,
because a field that prints a value and then refuses it cannot round-trip what
it is showing you. Every other rung is still a bare number, and the tooltip
still names the class.

**An arrow is a pixel, and Shift is ten of them.** Every length in the panel —
padding, margin, gap, radius, stroke width, font size — prints pixels, so the
arrows count pixels. They used to walk the ladder underneath instead, which made them the
one control here whose presses were unevenly sized: 6 to 8 was a press and 64
to 80 was a press, on a field showing the pixels either way, so what a press
was worth could only be found out by pressing it. The ladder has not gone
anywhere — a step writes the rung where one lands and `p-[17px]` where none
does, which is exactly what typing 17 does, so the two ways into a field agree,
and the rungs themselves are what the chevron beside it opens. Opacity already
counted this way and now merely says so: one and ten, in whatever unit the
field prints. `full` is the one value with no length to count from, so the one
press it takes is down, onto the tallest rung that is a number — up from it
would be a step past infinity. Font size is the one field where a press cannot
land on a rung at all, for the reason its own entry gives, so its first press
off a token detaches from it — which is the honest reading, since that ladder
is 12, 14, 16, 18, 20, 24, 30, 36 and was never something a count could walk.

**A press counts from the pixels on screen, and `1.5rem` is not 1.5 of them.**
A field can be showing a literal in some other unit — it has to keep the unit
or it says nothing — and `parseFloat` off that text reads 1.5, which stepped a
24px padding to 2.5px. The step now takes the number the field prints only
where that number is pixels, and what the element renders where it is not. A
comma pair still steps from the first of its numbers, because that is the one
the press is against.

**A step is the panel writing the value, not the typist typing it.** Every
readout leaves a focused field alone so `refresh()` cannot rewrite a word
mid-typing, and that guard was swallowing the marking a step had just earned:
an arrow that took a value off the ladder left the snowflake and the italic
behind until the field was blurred, so `17` sat there in an upright hand
looking like a rung. `stepping` says who wrote it and `typing()` reads it, so
the readouts are let through for the one case where the answer is "the panel".
Each stepper used to put its own new value in by hand for the same reason;
letting the readout run is that, the marking and the placeholder in one, and
the four hand-written assignments are gone.

**A leap that would go under zero stops at zero; a press on that zero is what
drops the class.** Ten below the bottom is still a number the field can show,
and losing the class outright is not what holding Shift asked for. Dropping is
otherwise unchanged, and it is still the only way back to an inherited value or
to a clean class string — what has changed is that reaching zero and leaving it
are two presses rather than one. The spacing one now marks the element dirty as
well, which it never had: the class came off the page and the save that would
have written it was never told.

**Four corners that disagree are said in full, comma separated.** An axis shows
`0, 8` for the same reason: one number would be a lie about the others, and
naming the disagreement ("Mixed") or averaging it tells you less than the four
values do. Typing one value over the list flattens all four; tabbing through it
does not, because a comma list parses as nothing writable and the field puts
itself back. Like the axis's pair, this is the state the unfolded view exists
for — decided when the element is selected, so the toggle owns it after that.

**Radius sits with padding and margin, not with typography.** It describes the
same box they do. Appended straight after the margin section in the body build
rather than at a fixed index, so it stays put as rows come and go. Stroke is
appended straight after it, for the same reason and to the same slot. Gap
follows the two, which is the one oddity: the BOXES loop puts gap last, and gap
shows on flex and grid containers only, so most selections never see the seam.

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

**Stroke is one section over three classes, and the colour is the same object
the two colour rows are.** Frame 7:687 draws it as the colour field across the
row with a tile beside it and style sharing the line under it with width —
which is 7:620 with a section's name above it and a pair underneath. So the
field itself was pulled out of `colorRow` into `colorField(prefix)` and the two
callers own what differs: the row around it, and what the tile beside it means.
Nothing about the colour is written twice, including the trap-free membership
read, the unlink, the opacity field and the inline-style refusal.

**`border-` is the trap four ways over, and every one of them is matched by an
exact test.** `border-2` is a width, `border-solid` a style, `border-oat` a
colour, `border-b-2` one edge's width — and `border-collapse` is not a stroke
at all. The colour goes through the same ramp membership `bg-`/`text-` use, so
`.border-solid` can never enter the map: it sets `border-style` and the read
requires `border-color`, which makes the discovery its own membership test the
way `.font-medium` is kept out of the family map. Measured on
`uiux_experiment`: 101 bare `border`, 38 colours, 7 per-side widths, one
`border-0`, and **zero** numbered widths or style utilities.

**1 is written `border`, never `border-1`.** The bare utility is the one
Tailwind ships and the one these codebases use — 101 sites against zero for
every numbered width put together. The ladder is 0, 1, 2, 4, 8 and anything off
it becomes `border-[3px]` with the snowflake, exactly as spacing and radius do.
There is no dropdown behind the width field because the frame draws none: the
chevron is on Solid beside it, and the arrows count pixels like every other
length here — which costs this field nothing, since 0, 1, 2, 4 and 8 are all
inside eight presses of each other.

**Revealing a stroke writes one, where revealing a padding writes nothing.**
The sharper version of the colour rows' reason. A padding field with no class
still tells you the element renders 0; a stroke reading 0 wide, no colour and a
style nothing is drawn in is three controls describing a property that is not
on the page. So the + writes `border border-solid border-black` — 1px solid
black, the one stroke every route can draw, said out loud in all three classes
rather than left half to preflight. Tokens and not lengths or hexes, so the
fields read them back as tokens.

**The style list offers the four that draw something, and reads all six.**
`border-hidden` and `border-none` render nothing while leaving the colour and
the width in the class list, so the element would say one thing in the file and
another on screen — and the tile beside the label already removes a stroke
outright, which is the honest way to say it. An element authored with one still
shows it and still gets a row for it in the list, the way a weight the font
does not ship keeps its row rather than vanishing from under the value it
names.

**The tile beside Stroke removes the stroke, not the colour.** On the two
colour rows the same 40x40 minus takes off the one colour that row is about;
here the row is a section and its label names the whole property. A minus that
left a width and a style behind would be taking the colour off something still
drawn on the page. It is also the only complete way out — the width steps down
to nothing, but the style list offers no "none" by the rule above.

**A width or a style rung the route has never generated gets a runtime rule,
and one it has does not.** The same gap an arbitrary colour has, met the same
way, and gated the same way: `discoverUtilities` now notes which `border` and
`border-<style>` rules the page already owns, because a scoped copy of one it
owns outranks its own responsive variants — the `px-6 md:px-12` failure again.
The style rule sets `--tw-border-style` as well as `border-style`: Tailwind v4's
width utilities read the style out of that variable, so a rule that set only
the property would be undone by the width class beside it. The width rule sets
`border-width` and nothing else, because preflight has already put
`border:0 solid` on every element.

**A box write clears the edges, both for width and for colour.** Same rule as
`px-*` clearing `pl-*`, met on the edge rather than the axis: a width that left
`border-b-2` standing would do nothing to the bottom edge, and a colour that
left `border-b-oat` standing would paint three sides and leave the fourth
saying something else. Zero per-side colours across both codebases — the
clearing costs a membership test, and not clearing costs a bug nobody would
look for.

**The stroke section shows for a border the page's own CSS draws, not only for
one in the class list.** That border is on screen, so a + row offering to add
it would be offering something the element already has. Same reason the padding
field prints what the page renders rather than a zero it cannot back up — and
the width field puts that number in its *placeholder* rather than its value, so
a number the element does not own is never mistaken for one it does. Four sides
that disagree are said in full, `1, 0, 0, 0`, because one of them would be a
lie about the others.

**The style list's specimen is a rule in the style it names, at 3px.** The one
exemption the family list's face already has: a style is the value here whose
*name* says least about it. 3 and not 2 because `double` is two lines with a
gap between them, and under three there is no room for the gap — it draws as
one solid line, which would make that the one row in the list showing the wrong
thing.

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

**A row's label lights to the value colour under the cursor.** `#dcdcdc`, which
is what a value is set in, up from the label's own `#8c8c8c` — the same move the
tab strip makes, and the only one available here: a label sits on the panel's own
surface, so it cannot take the `#2b2b2b` fill a tile does. Keyed on `.bw-row`, so
the whole row is the target, because the whole row is what the cursor is over.

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
the same panel, so they stand in the same place — 12px off every edge of the
bar, both 40px tall — rather than each keeping their own margins inside their
own view. 12 all round and not the 10 it started at vertically: the button is
aligned to the right gutter, so standing closer to the rule above it and to the
panel's foot than to that edge read as the bar being squeezed. Send is built
with the Prompt view it belongs to and parked in the footer.

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

**What you said is a box; what came back is a timeline.** The transcript is
one column of the same 13px text, so the two speakers are told apart by shape
rather than by colour or by a label on every line — a label would cost more
room than either message says. Your turn wears the composer's own box, 8px and
its 10/12 padding, so a sent message stands where it was typed, but bordered in
EDGE rather than filled: `#232323` is what a *field* wears and this one can no
longer be typed in. Everything that comes back — text, tool calls, errors —
takes a 5px dot at the gutter with the text 20px in, and a hairline joins one
dot to the next. That line is drawn by the entry *above* it, running from under
its own dot to 12px below itself, which is exactly the log's gap: an entry is as
tall as its own text, so only the node above knows the distance. `is-run` is
therefore set on the previous node as each reply lands, which also means a run
ending — at your next message, or at the end of a turn — simply has no line to
draw rather than one to clear.

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

**Every tile in that column hangs 10px into the gutter, so its mark lands where
the close button's does.** The header already sits this way — `0 10px 0 20px`,
a 20px glyph centred in a 40px tile — which puts the x's *mark* on the panel's
20px gutter and only its hover fill outside it. The toggles were flush with
that gutter instead, tile edge against field edge, so the mark inside them
stopped 10px short and the + column read as a second column half a tile in from
the x above it. `margin-right:-10px` is what buys the alignment, and it is a
negative margin rather than a nudge because the flex line gets those 10px back:
the field beside the tile grows into them and the 12px between the two is
untouched. Everything measured off that field moves with it — the colour row is
270 and its hex split 201 + 12 + 57, the radius corners are two 129px columns —
which is the frame's arithmetic done again with the tile out of the row rather
than a set of new numbers.

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

**The corner icons are the export's, and the toggle swaps two of them.**
`assets/ic-radius-{all,parts,tl,tr,bl,br}.svg`: four brackets, the one the
field owns lit and the other three stepped back to the export's `#505050`. The
all-corners mark carries the box as well as its four lit corners and `Parts` is
the same four without it, so the toggle reads the way padding's and margin's
do — the box while the row is one field, the parts while it is four. It wore
the all-corners mark in both states for a while, because the frame had no
`Parts` glyph for radius and drawing one would have been inventing; there is a
file for it now, so the pressed fill is no longer the only thing saying which
state the row is in. That is twice this has happened here: the mark before
these was a hand-drawn `radius` glyph, which existed only because the export
had no file for it either.

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

**The palette is a grid of colour, not a list of names — and a ramp is that
same grid in a box of its own beside it.** Eleven to a row at 20px, which is
what sets the popover's width rather than being set by it: `.is-swatches` is
322, which is 2 of border, 40 of gutter, eleven 20px squares and ten 6px gaps,
exactly. Eleven because a ramp is eleven and ten with one under it is an orphan
— and once the ramp is eleven the palette has to be, since the same square at
the same gap cannot run gutter to gutter on two different counts. Something has
to give and the count is the only one of the three nobody looks at. It was 312
for the panel's own row width with `1fr` tracks, which meant the square was
whatever the gaps left over: 21.6 in the palette, 19.1 in the ramp, 20 in the
field, three sizes for one object. A
name needs a row each and turns two dozen colours into a scroll; the tooltip
carries it, and a ramp's tooltip says it opens rather than applies, because
clicking it does. The Theme and Palette captions take a line of their own
rather than a cell, so the ordering that put project tokens first is still
legible — and they are set in the popover's own title voice, 15px muted and
capitalised, rather than the 9px letterspaced caption they were. Two type
styles for two headings on one surface was one style too many. The shade grid
had its own taller cell with the number printed across it in
`mix-blend-mode:difference`, which made two boxes of one popover look like two
controls — and the number was doing what a tooltip does everywhere else here.
Picking a shade is picking a colour; it looks like it now.

**A ramp is a dropdown of its own, 6px to the left of the palette, and the
palette stays open behind it.** It used to be the popover's second view,
reached by clicking a hue and left by a back chevron, so eleven shades arrived
exactly where the colours had been and the only way to compare a ramp against
the palette it came out of was to remember one of them. Two boxes say both at
once. The chevron went with the view it existed to leave, and `ICONS.back` with
it — that was its only use — and so did the branch in five copies of the test
helper that stepped back to the full list when the hue it wanted was not on
screen: the grid is never not on screen now. The hue whose ramp is open wears
the ring a hovered swatch wears, because the ramp itself has nothing in it that
says which of two dozen colours these eleven came from.

**The two are levelled on their first square — not on the boxes, and not on
the grids.** The boxes are nothing alike: one is a header over a row of eleven,
the other a header over a picker, a caption and three rows, so tops level put
the shades against the palette's picker and lined up nothing anyone was looking
at. Grid box to grid box is subtler and still wrong — the palette's grid begins
at its `Theme` caption, which spans the row, so the two rows come out exactly
one line of caption apart. That one measured as a pass while the screenshot
plainly showed the miss, which is the argument for measuring the thing you are
looking at. Square to square, with the same square and the same gap on both
sides of the seam, the pair reads as one grid that happens to be in two boxes.
Measured after placement rather than derived from the two headers, because the
palette's body scrolls and only the laid-out box knows where its first square
ended up.

**A list row's text stands on that gutter too, and its fill overhangs.** The
row's own 12px inset was measured from the body's 20, so reading down an open
list "Search" sat at 21 and "0px" at 33, and the meta on the right ended at 187
against the X's mark at 199 — 12px out at both ends on a surface whose entire
content is one column of left-aligned text. The 12 is handed back on both
sides rather than taken off the row: a row with no inset would put its fill
hard against the border and its text on the gutter with nothing in between.
What overhangs is the hover fill, which is the panel's own rule for a toggle
tile read on a different surface — what you see of a control at rest is its
mark, and the mark belongs on the gutter. Direct children of the body only, so
`.bw-picker` and `.bw-swatches` keep the 20 the swatch grid is measured from.

**A popover's content stands on the panel's 20px gutter, which is where its own
header already stands.** The title starts at 20 and the close button's mark ends
at 20 — a 40px tile holding a 20px glyph puts the glyph there and lets only the
hover fill overhang. The body was at 8, aligned to neither, and a swatch row
overhung the title on one side and the mark on the other by enough to read as a
grid slightly too wide rather than as a padding. Aligning to the tile's edge
instead was the same miss 10px further in: what you see of a button at rest is
its mark, not its hit area. 20 all round, so the vertical answers the
horizontal.

**The panel says "color", not "colour".** Every string the panel puts on screen
or in a tooltip — the popover's title, the unlink's, the minus's, the swatch's
— is US-spelled, because the classes it writes are (`text-color` has no `u` in
it and never will) and reading two spellings of one word in one window is a
seam. The prose in this file and in the source keeps its own voice; this is
about what the tool says out loud.

**The swatch is the button; the value is a field.** The whole field used to be
one button that opened the list, which left the one value in this panel people
most often arrive holding — a hex, out of a design file or another tab — as the
only one they could not paste. The colour block is the obvious half to keep as
the opener: it is what a picker looks like everywhere, and it wears the same
hover ring the swatches in the list do so it reads as pressable. It is 40 wide
— 12 of gutter, 20 of swatch, 8 after it — which is frame 4:551's geometry
unchanged, so the value still starts at 40 and the row still lines up with a
spacing field. The chevron went with the change: a mark at the far end of the
field promising "this opens" now points at nothing, since the thing that opens
is 250px to its left.

**The value takes a hex or a token, and refuses by putting itself back.**
`#4837ca`, `4837ca` and `#48c` are the same request; so are `emerald-500`,
`bg-emerald-500` and `bg-emerald-700/40` — the prefix is the panel's business,
not the typist's, and `/40` is the alpha the opacity field beside it owns. A
whole-name ramp is tried before a hue-plus-shade split, because `brand-teal` is
one token and only the map knows which of the two a name is. Anything that is
neither is not refused with a message: the field puts back what it was showing,
which is what a spacing field does with a word typed into it. And committing
what it already shows is not an edit, for the reason every other field in this
panel has that guard — blur fires on everything you tab through.

**Text color sits above Background color, and both of them say "color".** Text
is the one you reach for far more often: an element that sets a background is
usually a container, and a container's text belongs to its children — so it
goes where the eye lands first. "Background" alone was also the odd label out
beside "Text color"; both rows hold a colour and only one of them said so.

**The picker sits on top of the presets, not beside them.** Frames 7:620/7:622
gave the row its own controls; the popover got the one control that can say any
colour at all, and the grid under it stayed the shortcut to the ones this
project has names for. On top because the popover is a column and a column
costs no width — side by side wants ~560px against a 352px panel. On top rather
than under because the square is the general case and the grid is the
convenience.

**The square needs no canvas, and the hue is a custom property.** Black up the
vertical, white across the horizontal, `var(--bw-sv-hue)` behind both — three
layers of one box, so moving the hue strip is one property and never a repaint.
The state is HSV and it lives in `popState.hsv` rather than being read back off
the class each frame, which is what makes the square behave: white is `s=0` at
`v=1` and has no hue left in it, so a picker that re-derived its hue from the
colour would forget where the strip was the moment you dragged into a corner.
The knob is 12px and not 14 because at `s=0,v=1` it is centred on the square's
corner, 8px in from the popover's border — 6 of radius and 2 of ring is exactly
that 8, so the extreme of the control lands on the gutter instead of across the
edge of the window it is in.

**A drag is one step in the ledger, however many frames it took.** Text
coalesces on a timer, which works because keystrokes are discrete and a pause
between them is a real boundary; a drag has a beginning and an end it can
simply state, so `dragRun` states them — set after the drag's *first* write, so
that write opens the step the rest fold into. Writing per frame is otherwise
the normal path and not a special case: the DOM is the source of truth, the
field shows the live hex, `ensurePreviewRule` gives each hex a rule, and the
same point twice is skipped because a pointer at rest still fires and every
write costs a class, a rule and a step.

**No colour-picker package, and the reason is this repo rather than the
packages.** Pickr and Coloris are both MIT, both zero-dependency, both draw the
same square and strip. But `editor.js` is served verbatim by `server.js` with
no bundler anywhere in the project, so taking one means committing a `dist`
blob and a theme stylesheet, then overriding that stylesheet to `#171717` /
`#232323` / 8px / 40px and scoping it so it cannot leak onto whatever page the
overlay was injected into. The parts that are actually hard were already here —
`toHex` paints to a canvas, `withAlpha` writes the class, `ensurePreviewRule`
gives it a rule, the opacity field commits alpha — and what was missing was two
controls and about a hundred lines.

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
the membership test.** A family is offered if the route generated a
`.font-<name>` rule that sets `font-family`. `.font-medium` sets `font-weight`
and carries no family, so it can never enter the map and can never be stripped
by a family write: the `/^font-/` trap below is disarmed by construction rather
than by a second regex. On `uiux_experiment` this finds four
on Cora, one of them the project's own (`accent` → Square Peg): a bundled list
of web fonts would offer faces the page cannot render and miss that one.

**…and from `--font-*` in `@layer theme`, which is the half the generated
rules miss.** Tailwind v4 emits a utility only where the class is in the
source, so a token applied exclusively through `var(--font-volt-mono)` — which
is how every one of these projects wears its own face, on a `style={{ }}` at
the layout wrapper, inherited all the way down — has no `.font-volt-mono` to
be discovered by. Volt measured as three faces offered (sans/serif/mono,
resolving to the stock stacks) and neither of the two the route is actually
drawn in; murmur was the same with Inter. A theme key is still a writable
token: the utility appears the moment the class does, which is what a theme
key *means*, and the live suite asserts exactly that against the real build
rather than assuming it — save `font-volt-mono`, poll, and `.font-volt-mono`
is there.

**The layer is the membership test, and the `:root` selector is not.**
next/font declares `--font-geist-mono` on a CSS-module class
(`.geist_mono_8d43a2aa-module__…`), not in `@theme` — so it is a plain custom
property, and `font-geist-mono` would preview here through a runtime rule and
generate *nothing* on the real build. Tailwind puts its own theme block in
`@layer theme` and nothing else does, so walking with an `inTheme` flag and
taking `--font-*` only inside it separates the two exactly. `--font-weight-*`
is excluded by name: it is the same seam `font-` makes in a class list, one
level down.

**A family row's note is the CSS generic, never the project's slot name.**
`meridian`, `meridian-mono`, `volt`, `murmur-display` are names one codebase
invented, and they were sitting in the one column of this panel that ought to
read the same whatever project the editor is pointed at. It now says
`sans-serif`, `serif`, `monospace`, `cursive` or `fantasy` and nothing else —
the platform's own vocabulary, which is the only thing here that means the
same everywhere. The token is not lost by leaving the row: it is in the
tooltip beside the stack it resolves to, which is where this panel keeps the
exact thing behind every value. It also stopped the face being the half that
truncated — `Geist Mono` clipped to `Geist M…` beside a full-width
`meridian-mono`, which is the wrong half of a row whose job is to name a face.

**The generic comes from the first keyword in the *resolved* stack.** First and
not last, because Tailwind's own sans ends `…, "Noto Color Emoji"`, so reading
from the end finds a face rather than a keyword. Whole comma-separated entries
and never a substring, because `sans-serif` contains `serif` — the same trap
the class prefixes make one level up. The resolved stack and not the
declaration, since `.font-sans` is often just `var(--font-sans)` and a var says
nothing about what it holds.

**The list is ordered by that generic, with the project's own token leading its
run — and there are no headings.** Ordering keeps like with like, so the sans
faces stand together and the note down the right makes the runs legible without
a caption over each. Leading the run: on volt `sans` is a stock stack the route
never draws in and `volt` is the Geist it does. Nothing is dropped for being a
duplicate — two sans faces are two things you can pick.

**Five generics, and deliberately no sixth.** `serif`, `sans-serif`,
`monospace`, `cursive`, `fantasy` are what CSS offers, so a face resolving to
one of them can be named without guessing. A stack that names no generic at all
— `"Some Face", "Some Fallback"` — says nothing about what kind of type it is,
and an "other" is a label meaning "we could not tell". Such a token is **not
offered**. This editor has to hold for projects nobody here has measured, and a
rule that guesses guesses differently in each of them. The live suite pins both
halves with keys these projects do not have: a `cursive` one is said in full, a
name-only one is absent.

**A family from a variable needs a preview rule; one from a utility must not
get one.** The old note here said no rule is ever added — true while the map
held only generated utilities, and false the moment it holds theme keys as
well. `renderable.family` stays the record of what the page has already drawn
and `FAMILIES` is a *copy* with the utilities merged over the variables, so
`ensureFamilyRule` can skip by name: a scoped `[data-thisone-edited].font-sans`
over a route's own `.font-sans` is the `px-6 md:px-12` failure again. The
utility also wins the merge on value, because under `@theme inline` it is the
truer of the two — cora's `.font-mono` carries `ui-monospace, "Cascadia Code"`
while the variable it was built from is not emitted at all.

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
`border-` is the trap four ways over, and the worst of them: `border-2` is a
width, `border-solid` a style, `border-oat` a colour, `border-b-2` one edge —
and `border-collapse` and `border-spacing-2` are not strokes at all. Colour
membership is the ramp test the other prefixes use, which rules out every one
of the others by construction; the rest are exact patterns.

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

**What you can do to a colour is drawn in the row, not hidden in the list.**
Frames 7:620 and 7:622: the unlink in the field's right-hand slot, the minus in
the 40x40 tile beside it, both on screen the whole time. They spent a while as
named rows *inside* the popover, on the rule that "a control beside the value
reads as delete this, whatever its icon says" — and that was true while removal
was one of the two controls in the field. It is not one of them now: removal is
the tile in the toggle column, so the one mark left beside the value is not a
delete and cannot be read as one. The list went back to being a list of
colours, which is what you opened it to change.

**The minus and the + are the same tile, which is what makes the fold safe.**
Taking a colour off clears `revealed`, so the row folds straight back to the +
that offers it again — the thing removal was forbidden to do while it lived in
the popover, because the field vanished from under a cursor that had reached
into a list to remove it. Nothing vanishes from under this one: the tile it was
clicked in is the tile the + lands in, same 40x40, same column, and the suite
asserts the two land on the same pixel. Pressing the + writes white again, as
it always did.

**Opacity is a field of its own, and it is what a hex has.** Frame 7:622 splits
the row: the 57 it takes and the 12 beside it come out of the colour field and
out of nothing else, so the tile after them stands in the same place whichever
state the row is in. It was a 24px
monospace number wedged behind a hairline inside the colour field; it now
carries "100%" in the panel's own 15px, sized from a hidden sizer rather than
from `ch` — a `ch` is the width of a zero and these digits are not all a zero
wide, so `3ch` for "100" left a space that read as "100 %". A token has no
opacity field because `clay-100/40` is a fourth kind of thing again; the way to
one is the unlink, which is the whole reason it sits there.

**The unlink and the chevron share one slot, and hide the same way.** Both are
affordances rather than information — they say "this does something" to a
cursor that is already here — so the unlink is held at `opacity:0` until the
field is hovered, focused or open, exactly as the chevron is, and takes
`pointer-events` with it so a mark you cannot see is not a button you can
press. A mark standing on every colour row at rest would be a second thing to
read on a row whose whole job is to say one colour. They cannot both come out:
`has-unlink` takes the chevron out of the slot, since a token has the unlink
and anything else keeps the chevron. It writes the colour the element *renders* — `resolvedColor` follows
`var(--x)` against the selection, because a ramp entry is not always a literal
— so the paint does not change, only what the class says. The hand-drawn
12px glyph it replaced existed because `assets/` had no file for it; it does
now, and `ic-minus.svg` is the export's plus with its upright taken off, the
same `M4.16667 10H15.8333` on the same 20 grid.

**A hex colour is a literal, and this was the one field that never said so.**
Every other value in the panel that is not a token on a scale is italic, a
shade back, and carries the snowflake; an arbitrary colour showed the hex at
full contrast with nothing to mark it. It now takes `is-custom` and the
snowflake from the same condition — `kind === 'arbitrary'` — which is what the
cross-field assertion below requires, and the snowflake sits where a unit sits
so the chevron takes its place on hover exactly as elsewhere.

**The size field is a field; the chevron is the button.** The whole thing used
to be one button that opened a list, which left the one number in this section
people most often arrive holding — a size out of a design file or a spec — as
the only value in the panel that could be picked and not typed. Same change the
colour row went through, and the same half kept as the opener: there is no
swatch here to press, so the chevron takes the job and the value beside it
becomes an input, which is how spacing and radius have always been drawn. The
hover fill went with the button, as it did from the colour value — what you
type in is not a button — so the weight field beside it is now the only half of
that line that lights. The value stands on the same 12px gutter the bare token
does, from the same number: `.bw-field.is-bare > .bw-val` is `.bw-ctoken.is-bare`
read on an input.

**A number typed there is a length; a name is the token — and a number never
becomes one.** This is where the size field parts from padding, radius and
stroke width, which all write the rung the moment a typed pixel lands on it.
Their rungs are the length and nothing else, so `p-4` for 16 changes only what
the class is called. A `text-*` token is two declarations: it sets a
line-height as well, so `text-lg` for a typed 18 would move the leading nobody
asked about. 18 is therefore `text-[18px]`, snowflaked, even on a route where
`lg` is exactly 18 — and the token is a click away in the list, or its own name
typed into the same field. That is also what the list's custom row has always
written, so the two ways into the field agree. The arrows follow the same rule
— a press writes `text-[25px]`, never the rung 25 happens to be — so counting
off a token is what detaches from it.

**A note in a field asks for the centre; it does not get it for free.** A
`.bw-field` stretches its children, so a 13px note in a 40px field puts its text
flush against the top edge — the trap the leading icons were already fixed for,
one element along. It went unseen because every note in the panel until now sat
inside a `.bw-ctoken`, which centres its own row: the Size field's is the first
to be a child of the field itself, and the radius box's `+n` was the same bug
waiting on a logical class neither codebase has. `.bw-unit` now carries the two
properties `.bw-snow` already carried for the slot it shares. The suite measures
the **text** with a Range rather than the span, because a stretched box is
centred by definition and says nothing about where its line landed.

**The size field speaks the same bare pixels the others do, and keeps a unit
only where it is not one.** `24`, not `24px`, because every length in this panel
is in pixels and printing it on each one is noise — but `text-[1.5rem]` reads
`1.5rem`, since a literal in some other unit has to keep it or it says nothing.
That is spacing's own rule, met on the one length field that routinely holds
rem. An unset size puts what the page renders in the **placeholder** rather than
the value, which is the stroke width field's rule and the one a field you can
type in needs: a number this element does not own must never be mistaken for
one it does.

**A literal font size wears the snowflake alone, not a nearest rung beside
it.** The Size field was the one row naming the token it is nearest — `sm` in
the note slot where `lg` sits on a row that really is set to `lg`, a shade away
from claiming the element wears it. Radius and spacing take arbitrary values
just as often and say nothing; this was the odd one out, and `nearestToken`
had exactly one caller. The hint keeps the tooltip, where "nearest is sm at
14px" costs nothing to read past.

**Italic means one thing: this value is a literal.** It used to mean "inherited
from a broader class", which put top and bottom into italic the moment you typed
a vertical value — two unrelated ideas wearing one style. Inherited keeps the
dimmed colour, which is the half of that pair that reads as "not this element's
own". A literal is italic and a shade back (`#b4b4b4`), and carries the
snowflake: the two are set from the same condition and a test asserts they never
disagree on any field.

**Typography is one section, not three rows.** Frame `1:3`: the family across
the row, weight and size sharing the line below it, the alignment
segment below that — 40px rows, 12px apart, 8px under the label, 173px in
total, which the live suite asserts to the pixel. Three labels became one
because they name one thing, and because a 124px field cannot afford a label
beside it. Each field still decides its own visibility exactly as it did when
it owned a row, and the weight/size pair collapses to a single column rather
than leaving a hole.

**The section reserves the gutter its row has no toggle for.** Every other
section ends in a 40x40 tile, so its stack stops 270px in and its pair is two
129px columns. Typography has no tile — nothing about a family folds into
anything — so its stack ran the full 312 and the two fields under it came out
150 apiece: a family field a tile wider than the Padding above it, and a
weight/size pair whose columns missed the padding pair's by 21px on a panel
where those two rows sit four lines apart. `is-inset` is `margin-right:42px`,
which is the 12px between a stack and a tile plus the 30 a tile takes off the
flex line — its 40 less the 10 it hangs into the panel's gutter. Same
arithmetic as the toggle's negative margin, read from the other side, so the
column holds whether or not a row has anything to put in it.

**The alignment segment is the pair's first column, not a width of its own.**
6+28+14+28+14+28+6 is the frame's 124px exactly, and it sits directly under the
weight field — so once that field settled on the padding row's 129 the segment
stopped 5px inside a right edge it plainly lines up with. It asks for the
column by name now (`calc((100% - 12px) / 2)`), because a flex column stretches
its children and stretching gives it all 270. The 5px goes to its gutter rather
than its gaps: the three 28px tiles keep the frame's 14px rhythm and the box
around them widens, which is the half of a segment that is a container. The
live suite asserts it against the weight field rather than against 124, since
124 was only ever the number that column happened to be.

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
`currentColor`, because the design's colours are the point. Inlining is the
file with its newlines taken out and nothing else, which is what makes
`test/12-icons.js` possible: it re-derives every entry from `assets/` and fails
on any that has drifted. Twenty-one had, all at once, after one re-export from
the frame — an icon that is stale on disk looks like nothing at all until
somebody happens to screenshot the row it is in. The same suite refuses a file
in `assets/` that no entry claims, which is how the four-corner `Parts` glyph
sat unused, and refuses two exports sharing an id anything points at, since
they are pasted into one document and the second would wear the first's
clipPath. The four marks with
no file (the individual edges) stay hand-drawn on a 12 grid, rendered at 20 with
a 0.9 stroke so they land on the assets' 1.5.

**Gap wears the two exported marks, and the single gap asks the element which
one.** `ic-gap-hz` is a bar between two upright brackets, `ic-gap-vt` the same
turned a quarter, so `gap-x-*` takes the first and `gap-y-*` the second — fixed,
because `gap-x-*` is column gap wherever it appears. The lone `gap-4` is the one
that cannot be fixed: it is a *vertical* gap on a `flex-col` and a horizontal one
on a `flex-row`, the same class reading the opposite way round, so a static mark
there is wrong half the time. `gapOneIcon` reads the container's computed
`flex-direction` and the section's readout swaps the mark when the selection
changes — not on every readout, since rewriting the SVG under the cursor would
throw it away for nothing. Grid keeps the horizontal mark: there `gap-4` really
does set both axes, and of the two files the export ships, neither says "both".
This retired the last hand-drawn trio — a 2x2 grid and two bar pairs — which
existed only because `assets/` had no file for them. Five checks in
`02-spacing-sides` pin the pairing, `flex-row-reverse` and `grid` included.

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

**The Undo in that notice is bare, like the close button.** It wore the
`#232323` a field wears, which put a filled box inside a box that is already
tinted and outlined — two things to look at where the notice makes one
statement. It is now text on the notice's own ground, lighting from label grey
to value white under the cursor, which is the move every row label makes. 5px
above and below sets its 13px line on the same centre as the 15px heading
beside it, and nothing at the sides keeps it flush to the notice's 14px gutter.
The hover rule that was there before moved a `border-color` on an element with
`border:0` — it had never shown anything.

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

**Three things about wiring only go wrong once the editor is installed rather
than sitting next to the project, so nothing in a sibling checkout can catch
them.**

*Backups go in the project, at `.thisone/backups/`.* They used to live beside
this code, which is fine for a checkout and fatal for a dependency: `__dirname`
is then inside `node_modules`, the one directory `npm ci` deletes and a fresh
clone never has — so the only copy of the user's own `next.config.ts` and
`layout.tsx` would sit exactly where a reinstall wipes it, and `--unwire` reads
from there. They are named after the path inside the project and not the
basename, which is the collision the trap below already warns about. The
directory carries a self-ignoring `.gitignore` so it stays out of the project's
history without editing the project's own.

*The loader shim is resolved by package name.* It writes `tools/thisone-loader.cjs`
into the user's repo, under `tools/`, where they will commit it — so an
absolute path in it is one machine's path that breaks for every teammate and
every CI checkout the moment it is pushed. `require('<pkg>/loader')` needs the
subpath in `exports`, which is why package.json has one. Where the package does
*not* resolve from the project — this checkout run against a sibling, which is
how it is developed — it falls back to its own path and says `NOT PORTABLE` in
the file, rather than looking committable.

*The port is read when the page renders, not written in when it is wired.*
`overlayTags` used to bake the number into the layout. Wire once at the
default, later run `--port 3600`, and the overlay is fetched from the old port
and simply never loads: no error, no missing file, a page with no editor on it
and nothing saying why. It reads `NEXT_PUBLIC_THISONE_PORT ?? 3500` instead, and the
CLI prints the export line whenever the port is not the default.

The turbopack rule gained `:start`/`:end` markers to go with that, because both
snippets now change between versions and `--unwire` matched the rule by exact
string — a `replace` that does not match fails silently, reporting success
while the project still carries the block. It matches by marker and names any
file it could not take the block out of.

**The allowlist names files, not directories, and `assets/` is not on it.**
`files` in package.json used to be absent, so npm fell back to `.gitignore` and
shipped everything it does not hide: 69 files, 257kB, carrying 200kB of
Playwright suites nobody installing can run, both live `verify` scripts, the
unreachable `astro-locator.mjs`, and a 110kB handover document. It is 15 files
and 143kB now. Naming each file rather than `"next"` is the point of the
exercise: a directory entry is not an allowlist, and the next dev-only script to
land in `next/` would join the tarball silently the way `verify-prompt.js` did.
The failure it trades for is the loud one — a *runtime* file left off the list
does not resolve, and the first install test says so.

`assets/` is off it because nothing at runtime reads the files: the icons are
inlined into `editor.js` byte-for-byte, and the one thing that opens the SVGs is
`test/12-icons.js`, which does not ship either. Shipping them without their
guard would put a second copy of every icon in the tarball with nothing
checking that it still matches the one being drawn — which is the exact drift
that suite exists to catch, moved somewhere it cannot be caught.

**`engines` is Next's floor, not the language's.** Nothing in this code needs
more than Node 14 — `fs.rmSync` is the newest thing in it — so a floor derived
from the source would say `>=14` and be useless as a signal. `>=20.9.0` is what
`next` itself declares, and this tool is only interesting attached to such a
project. A floor is a claim about where it is known to work, and that is the
number the claim is worth making at.

**A free port is an answer about the past, so `dev` retries the pair.** The
probe asks "is this free", and the answer is about the moment it was asked, not
about the moment the child binds. `--wire` rewrites next.config.ts, Next fully
restarts on that, and the probe lands in the second or two while its port is
down: 3001 was genuinely free when asked and genuinely taken when Next reached
for it. Hit on the first try in a real trial, not in a fixture. The two numbers
also have to agree with each other — the app is spawned with the editor's port
in its environment, the editor with the app's origin in its allowlist, and
neither can be told later — so a failure on either side retires *both* and the
next pair is tried. Retrying one half alone would leave the other holding a
number its partner no longer has.

**A child that died is not proof that its port was taken.** Next refuses a
second dev server for the same *directory*, whatever port it is offered: it
starts, prints "Another next dev server is already running", and exits. Treating
every exit as a port collision turned that one clear failure into four restarts
that could not possibly succeed, each printing a full editor banner, and a
closing message blaming a restart loop. The tail of the child's output is read
now and the reason named — `duplicate` stops and quotes the running server,
`port-taken` is the only one worth another port, anything else stops and shows
what the app said. `whyItDied` lives in `detect.js` because it is pure string
work and `cli.js` executes on require, so it could not be tested where it was
first written. Its fixtures are verbatim Next 16.3.3 output.

**Read that complaint from the complaint, not from the top of the buffer.** Our
own child prints its banner — `- Local: http://localhost:3002` — a moment before
it discovers the conflict, so a search across the whole tail names the port that
just failed instead of the server to go to. The first version told the user to
visit the wrong one.

**"Something answered" has to mean a web server, not an open socket.** The
readiness check connected and called that success, which a process squatting on
a port satisfies happily while never replying — so it reported success against
precisely the case it existed to catch, and `dev` announced "Both up" on a port
its app had never got. It makes an HTTP request now and requires a response.
Any status will do: Next answers while it is still compiling, and a 404 is still
proof that the thing holding the port speaks HTTP. A child still alive when the
deadline passes also counts, because a first compile is not on a clock.

**Wiring throws away `.next/dev`, because wiring has just invalidated it.**
Turbopack caches module *resolutions*, failures included. Unwire while the dev
server is up and it caches "there is no such file"; wire again and the file is
back but the cache is not re-asked, so every page 500s with `Cannot find module
…/tools/thisone-loader.cjs` naming a path that is plainly sitting there. Nothing
short of clearing it recovers, and the message points at the file rather than at
the cache, so it reads as this tool's bug. `.next/dev` only: Next 16 keeps dev
and build output in separate trees and a production build is not ours to throw
away.

**`dev` owns all three numbers, because a user holding them cannot keep them
in step.** The app's port, the editor's port, and the origin the editor accepts
writes from have to agree, and the third fails in the worst way available:
everything looks right until Save, which is refused as a bad origin. Found by
running the tool as a stranger would with a real session already up — the
default ports were both taken, which is not exotic, it is what a second project
looks like. `thisone dev` picks both ports, sets `NEXT_PUBLIC_THISONE_PORT` in the
app's own environment and points the origin at it, so nobody types a number.

**The port probe has to bind the way the server it is testing for binds.**
`next dev` listens on every interface, the editor listens only on 127.0.0.1 —
and on macOS a loopback bind *succeeds* against a port a wildcard listener
already holds. Probing 127.0.0.1 for the app therefore called 3000 free while
another app was plainly on it, and Next died a second later. The standalone
server deliberately does not probe at all: the layout falls back to 3500, so a
server that quietly moved itself would leave the overlay looking for it at the
old number and failing in silence — the exact bug the runtime port lookup
exists to kill. Moving is safe only where we also own the app's environment.

**Wiring is setup, and setup is no reason to start a server.** `--wire` used to
fall through into running, which made it silently mean "run" on an
already-wired project, and made it fail *after* succeeding when the port was
busy — reading as though the wiring itself had broken. It is its own branch
now, ending in what to type next. It also took a server spawn out of
`06-detect`, which ran one on every `--wire` call and is a fair suspect for the
stale-port trap below.

**A busy port gets a sentence, not a stack trace.** Two editors is the normal
case, not the error case, so `EADDRINUSE` is caught and answered with the flag
that fixes it. `Unhandled 'error' event` reads as though the tool is broken
rather than as though you need an argument.

**The panel is told what the source looks like, because the DOM cannot say.**
`{name}` renders as ordinary characters, so an element the writer will refuse
looks exactly like one it will accept — which is why the overlay used to let
you type and object only at save. The loader stamps `data-thisone-text` with what
it saw, from the same `textShape` the writer's own refusal is derived from, so
the two cannot drift. Only the awkward shapes are named: `expr` for characters
with no literal behind them, `runs` for a literal interleaved with markup.
Empty and single-literal say nothing, being both the common case and the
editable one — stamping every element in an app to report "normal" is a great
many bytes to say nothing. A container of elements says nothing either: it is
not refusing anything, and a notice there would put one under every wrapper in
the app explaining why you cannot type into a `<div>` of `<li>`s.

**That one gets a line where the box would have been, rather than silence.**
Every other unwritable row simply is not drawn — the rule that a disabled
control explaining itself is the largest way to say nothing you can act on. Text
from an expression is the exception, because it is plainly *there* on the page:
a row that vanishes reads as a bug, where a row saying where the characters come
from reads as an answer.

**Text is edited a run at a time, because a run is what a literal is.** A `<p>`
holding text, an `<a>` and more text is not one string — it is several literals
with markup between them, each its own contiguous stretch of the file. Writing
one is the same operation as writing a class: replace a span, leave everything
else. The old refusal read as though the trouble were *several children*, but it
was only ever `Hello {name}`: one rendered string with no way to tell which
characters came from the literal. Siblings have no such ambiguity, and refusing
them cost the whole of the mixed-content majority.

**A run is found by what it says, not by where it sits.** The two sides count
differently — React emits `{" "}` as a text node of its own, so the overlay's
third text node is not the third `JsxText`. Content also makes the write
self-checking: `from` is what the panel believed was there, so a file that has
moved on is refused rather than overwritten, the same bargain `cn()` strikes by
sending a delta instead of a snapshot. Whitespace is folded before comparing,
since a run written across three source lines is one line on the page.

**The space either side of a run belongs to the layout, not to the sentence.**
`Read the <a>docs</a>` renders as two words *because* of the trailing space in
the literal. The field shows the words and hands back the words, so writing that
value straight over the node closes the gap and gives you `Read thedocs` — which
is what the first version did, in the DOM and on disk, while a test asserting
`line.includes('Start with the')` passed anyway. The gaps are kept aside and put
back on every write, and the test now compares the whole line. The JSX writer
never had the bug: its span already excludes surrounding whitespace, which is the
same rule arrived at from the other side.

**Both backends had to be taught, and their validators are separate copies.**
The panel is shared, so a field it offers must be writable in either mode —
`runs` reached the JSX writer, was accepted by the HTML server, and was rejected
by the Next server's own `validateEdit` with "nothing to edit". Caught only by
driving the real app; every fixture suite was green. The two validators remain
the most obvious place in this codebase for the next thing to drift.

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
| bare `border` (1px) | **101** | — |
| numbered `border-2` | **0** | — |
| `border-[3px]` and friends | 0 | — |
| border colour tokens | 38 | — |
| per-side `border-b` | 7 | — |
| `border-solid` / `-dashed` / `-dotted` | **0** | — |

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
   Removal now counts `[data-thisone-loc^="file:line:col:"]`, ghosts all of them and
   says "renders 19 elements … removes all 19" before you can save. **Class and
   text edits still say nothing** — same one-line count, same place to put it.
3. **Template literals** — 211 sites in gw-web. Only the leading static quasi is
   safely editable; the delta mechanism from `cn()` already does the hard part.
4. **Text from an expression is still not editable, and now says so.** A leaf
   whose text is `{variable}` no longer lets you type — the loader stamps
   `data-thisone-text="expr"` and the row says where the text comes from instead of
   offering a box. Text interleaved with *markup* is editable now, one literal
   run at a time. On Cora 59.6% of elements were `mixed-content`, most of which
   this reaches.
5. **Packaging** — the three things that only bite once it is a *dependency*
   are done (see below), and the tarball is now an allowlist: 15 files, 143kB,
   `private: true` gone, `engines` at `>=20.9.0`. What is left is a README, a
   `.` entry in `exports` — `main: server.js` is decorative today, since an
   `exports` map with no `.` makes `require('thisone')` throw
   `ERR_PACKAGE_PATH_NOT_EXPORTED` — and one install test against a fresh
   `create-next-app`. Still only worth finishing if other people will use it.
6. **The hex is still read-only as *text*.** The picker sets it and the opacity
   field sets its alpha, but there is nowhere to paste `#3f6212` into. gw-web is
   608 arbitrary colours, so "detached" is the norm there. A drag also leaves
   one preview rule per distinct hex in the dev-only stylesheet, which nothing
   ever collects — the same thing typing hexes would have done, now reachable a
   great deal faster.
7. **Logical radius utilities are read but never written.** `rounded-s-lg`,
   `rounded-ss-*` and friends depend on writing direction, so they are left
   exactly as authored — membership matching means they are never mistaken for
   a rung — and the Radius field appends `+n` and names them in its tooltip so
   it never shows one radius while the element means two. Zero sites across
   both codebases. The four *physical* corners do have fields now; the
   *physical* edges (`rounded-l-[2px]`) have none, but are read into the two
   corners they paint and cleared by an all-corners write.
8. **Per-side strokes are read, cleared and never written.** `border-b-2` and
   `border-b-oat` show the section, are counted by `strokeSet`, and are cleared
   by a box write so the field just used cannot be a no-op on one edge — but
   there are no fields for them, because frame 7:687 draws none. 7 per-side
   widths and zero per-side colours on `uiux_experiment`. Same shape as the
   physical radius edges, and the same reason to leave it.
9. **A rung a route has never used previews at the stock value.** Cora derives
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

`npm test` runs 13 suites: 4 pure-unit (`00`, `05`, `06`, `12`) and 9 browser suites
against `test/fixture.html` copied to a temp dir — the demo page is never
mutated. Tailwind is served locally (`@tailwindcss/browser`), not from a CDN, so
runs are offline-capable and deterministic.

`next/verify.js` is the live suite: 96 checks against the real Next app,
including refusals, security (401/403/415), and byte-exact restore of every file
it touches. The radius block runs against `experiments/cora/login` specifically
because Cora redefines the radius ladder — every number it asserts would be
wrong if the overlay read `--radius-*` instead of the generated rule. The
removal block runs against `volt/design-system` for the opposite reason: one
line there renders 19 elements, which is the case the warning exists for.
The family block is split across two routes, and the split is the point.
**Murmur** carries the discovery half — that a `--font-*` in `@layer theme`
with no generated utility is offered anyway (Inter, Space Grotesk), that
next/font's variables, which live outside that layer, are offered by nobody,
that every note is one of the five CSS generics and the ordering follows them,
that the tooltip still carries the token, and — with two keys injected at
runtime that these projects do not have — that a `cursive` face is said in full
while a stack naming no generic is not offered at all. **Volt** carries the write half:
pick, preview, save, and watch Tailwind generate the utility the theme key
promised.

They are split because of a trap. **Tailwind's dev server keeps a utility once
it has generated one, even after the class leaves the source again** — so the
route this suite writes to stops being a route with no utility the moment it
has run once, and `!utils['volt-mono']` passed exactly once and never again.
Nothing writes to murmur, so nothing spends it. Volt's own target is derived
from the page rather than written down, and the rule it asserts flips with the
state it finds: one runtime rule where the page owns none, *no* runtime rule
where it already does — which is the shadowing guard, and worth asserting in
its own right.
The per-corner block is on Cora too, and asserts 21.6px: a corner rung built
from the stock ladder instead would say 16px beside three 12px corners.

`test/11-stroke.js` owns the seam `border-` makes, which is the whole reason
that suite exists: that the four families are read apart and written apart,
that `border-collapse` offers a + like any unset row rather than a stroke,
that a box colour takes `border-b-red-500` with it, that revealing writes
exactly `border border-solid border-black` and the page draws it on a fixture
that has generated no such rule, that a rung is written as the rung and 3px is
not, that an arrow is a pixel and Shift is ten of them, that a leap under zero
stops at zero and the press after it drops the class, that the minus takes all
three classes at once, and that what is left reaches disk with nothing else on
the line moved. Its selections click the
card at x=120: the delete handle for the live selection sits on the element's
top-left corner and swallows a click at (3,3), and it closes the panel with the
header's × rather than Escape, because by then the caret is in a field and
Escape belongs to the field it is in.

`test/02-spacing-sides.js` owns the two cross-cutting halves of the steppers,
because spacing is where both were found: that a `1.5rem` literal steps from
the 24 it renders rather than the 1.5 it says, and that a step off the ladder
is italic and snowflaked while the field still holds focus. It owns the notes'
centring beside the icons', for the same reason and by the same measurement. It also owns the
reveal rows: that every property has
one whether or not it is set, in the order the panel reads in, that the + sits
in the same column a section toggle does, and that revealing writes nothing.
It owns the "could this do anything" rule too: gap offered on a flex container
with two children, refused on a block one and on a flex one with a single item
to space. The two-child case is a `<section>` and not the `<h2>` the block cases
use, which is also why its expected order carries no Text row — a container's
text belongs to its children.

`test/01-classes.js` owns the colour row's own chrome: that the swatch is the
only thing that opens the list and is 40 wide with its chip on the 12px gutter,
that the value is an `<input>` which takes `#4837CA`, `48c`, `emerald-500` and
`bg-emerald-700/40` alike and puts itself back on anything else, that a token
offers the unlink 10px in from the field's edge with no chevron behind it, that
the unlink keeps the paint and changes only the class, that the opacity field
takes its 57 and its 12 out of the colour field and not out of the row, and
that the minus folds the row back onto a + in the same 40x40 tile it was
clicked in. It owns the picker too — that it sits above the presets rather than beside them,
that dragging the square writes a hex that actually paints (the class is in no
source file, so if it paints, `ensurePreviewRule` did its job), and that a drag
undoes as one step. It owns the pair of boxes as well: that a hue opens a ramp
of its own 6px to the palette's left with the palette still open behind it and
a ring on the hue that opened it, that the two first squares sit on one line,
that a shade is the same 20x20 square a hue is, that eleven of them stand on
the 20px gutter at both ends, that shutting the ramp leaves the palette where
it was, and that picking a shade writes the class and takes both boxes away. It
compares colour by painting it, never as a string — the same green arrives as
`oklch()` from a generated utility and `rgb()` from the hex the picker writes.

`test/12-icons.js` is the only suite that reads `assets/` rather than the
panel: it re-derives every `ICONS` entry from its file, insists every file is
claimed by an entry, and insists no two exports share an id anything points at.
Pure unit, so it costs nothing and runs first.

`test/03-text.js` owns the three families sharing the `text-` prefix, which is
why the Size field's own checks are there rather than in a suite of their own:
that its value is an `<input>` with the chevron beside it as the opener, that a
token reads as the pixels it renders with the rung in the note, that a typed 18
is written `text-[18px]` and **not** `text-lg` on a route where `lg` is exactly
18, that a name — with or without the prefix — is how the token is asked for,
that another unit keeps itself in the field and in the class, that a word puts
the value back and writes nothing, that tabbing through is not an edit, that an
arrow is a pixel and Shift ten of them with the marking landing on the press
rather than at the next blur, and that clearing takes the size off while the
`text-indigo-600` beside it stays. Its
block runs on the `<h1>` and puts the heading back through the field itself,
which is also the check that a token typed in restores it.

`test/10-radius-corners.js` covers the seam the live suite cannot reach
cheaply — a corner overriding the box, the box clearing the corners, one value
typed into the box flattening all four, a comma list surviving a tab through
it, a corner counted a pixel at a time and ten at a time, stepping below zero
dropping the class rather than pinning it there, the view opening by itself on
an element authored per-corner, and the
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
