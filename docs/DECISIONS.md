# thisone: design decisions

Every entry here records a decision that was *not* obvious and the measurement
that settled it. Most were taken against `../uiux_experiment` and `gw-web`; the
numbers are in the table near the end. Grep this file for a concept before
changing a behaviour that looks arbitrary, and do not undo an entry without
re-measuring. When you add a decision, add it here in the same commit as the
code, with the number that justified it.

The root `CLAUDE.md` holds the short rules and the traps; this file is the why.

## Design decisions that were *not* obvious

Every one of these came from measuring the real codebases. Do not undo them
without re-measuring.

**The package is `thisone`, and only what reaches a stranger's repo was
renamed.** `this-one` is taken on npm by an abandoned package (8 versions in 6
days in 2024, no README, 3 downloads a week) and `thisone` is free.
`this-one-editor` was rejected because "editor" is the same ceiling `tw-` would
have been. About 46 sites moved: the bin, `tools/thisone-loader.cjs`,
`.thisone/backups/`, `NEXT_PUBLIC_THISONE_PORT`, the wire markers, and the
`data-thisone-*` attributes. The ~500 internal `bw-*` CSS classes and the 474
`data-tw-*` test hooks stayed: **`bw` is Bloomworks, the studio prefix, not the
product name.**

**The package is scoped and the command is not, because npm would not have
the bare name.** npm strips punctuation before comparing, so `thisone` collides
with `this-one` and the typosquatting rule refuses it at publish time. It ships
as `@designbuddy/thisone`. **The bin stays `thisone`**, because a bin name is
independent of the package name. Almost nothing moved: `PKG` is read from
`package.json`, so the shim writes `require("@designbuddy/thisone/loader")` on
its own, and the shim's filename is hardcoded `tools/thisone-loader.cjs`.
Verified against a real install: the bin symlink and the scoped subpath both
resolve.

**A rename adds to the marker lists and never replaces them.** `detect.js` has
`LOADER_MARKS` and `SHIMS`, `cli.js` has `MARKS` and `hasMark()`, and each
carries every name this tool has ever written into a project. A project wired
by an older release still has the old name on disk, so a detector that forgot
it calls that project unwired and `--unwire` silently leaves the block in
place. This happened to `uiux_experiment` across the last rename, and re-running
the sed over `detect.js` reproduced it, because a blanket replace turns the
legacy entry into a duplicate of the new one. `MARK` is what `--wire` writes,
`MARKS` is what everything else matches against.

**Writes are byte-span replacements, never AST reprints.** A save changes one
line and nothing else moves into the diff. The loader and the writer share
`hostElements()` so they cannot disagree about what sits at `line:col`.

**Tailwind v4 has no runtime JIT.** A class the editor invents has no CSS until
it is in a source file. Preview comes from a dev-only palette compiled with the
project's own Tailwind, scoped to `[data-thisone-edited]`. Unscoped it beat the
app's own responsive variants: `px-6 md:px-12` rendered at 24px instead of 48px.

**Colours are discovered from generated utility rules on the live page, not
from config files or CSS variables.** `@theme inline`, which every one of these
projects uses, substitutes token values into utilities and emits no `--color-*`
at all. On the Cora route `--color-clay` appears zero times while `.text-clay`
is right there. Rule-scanning also says what this page can actually render.

**The radius ladder comes from the page, like colours, not from the theme.**
`@theme inline` bakes the token into the utility and emits no `--radius-*`. On
the Cora route `.rounded-lg` is `var(--radius)`, 12px, while `--radius-lg`
still resolves to the stock 8px. Radius is the one control kept out of the
pre-generated palette, because a scoped `[data-thisone-edited].rounded-lg`
would outrank the route's own rule, the same failure as the `px-6 md:px-12`
bug. Rungs a route has never generated get a runtime rule from the server's
ladder.

**Radius is one field over four, not one view swapped for another.** Frame
2:270: the box field across the full width with a 40x40 toggle beside it, and
the four corners in a 2x2 grid underneath, in the order `border-radius` says
them. Padding and margin swap two axes for four edges because `px-*` and `pt-*`
are the same kind of thing. Here there is no middle level, so the box field
stays as the summary, and when the four disagree it is the only place all four
are said at once.

**Radius is spoken in pixels too, box and corners alike.** All five are the
same field, `radiusField(target)` with `side: null` for the box, and all show a
bare number: 12, not `xl`, and no `12px` note. The rung is still written where
one lands (`rounded-lg`, `rounded-tl-lg`), and anything else becomes
`rounded-[13px]` with the snowflake, as spacing does. `lg` is 12 here and 8
somewhere else, so a token name makes you look it up. The name survives in the
tooltip and the dropdown's filter.

**`rounded-full` is the one rung with no length, so it says its own name.**
`calc(infinity * 1px)` computes to 33554400 on this Chromium, which no field
should print. It showed `∞` at first, a symbol nobody types in a field you type
into. It now reads `full` in the field and in the list, and the field takes
`full` typed back, because a field that prints a value and refuses it cannot
round-trip. Every other rung is a bare number, and the tooltip still names the
class.

**An arrow is a pixel, and Shift is ten of them.** Every length in the panel
(padding, margin, gap, radius, stroke width, font size) prints pixels, so the
arrows count pixels, where walking the ladder made 6 to 8 one press and 64 to
80 another. A step still writes the rung where one lands and `p-[17px]` where
none does, which is what typing 17 does, and the rungs are what the chevron
opens. Opacity counts the same way, one and ten in whatever unit the field
prints, and `full` has no length to count from, so its one press is down, onto
the tallest numeric rung. Font size cannot land on a rung at all, so its first
press off a token detaches from it: that ladder is 12, 14, 16, 18, 20, 24, 30,
36 and was never something a count could walk.

**A press counts from the pixels on screen, and `1.5rem` is not 1.5 of them.**
A field showing a literal in another unit has to keep the unit, and
`parseFloat` off that text read 1.5, which stepped a 24px padding to 2.5px.
The step now takes the number the field prints only where it is pixels, and
what the element renders where it is not. A comma pair steps from its first
number, because that is the one the press is against.

**A step is the panel writing the value, not the typist typing it.** Every
readout leaves a focused field alone so `refresh()` cannot rewrite a word
mid-typing. That guard swallowed the marking a step had earned: an arrow that
took a value off the ladder left the snowflake and the italic behind until
blur, so `17` sat there upright looking like a rung. `stepping` says who wrote
it and `typing()` reads it, so readouts are let through when the answer is "the
panel". Letting the readout run replaced the four hand-written assignments in
the steppers.

**A leap that would go under zero stops at zero, and a press on that zero is
what drops the class.** Ten below the bottom is still a number the field can
show, and losing the class is not what holding Shift asked for. Dropping is
still the only way back to an inherited value or a clean class string, so
reaching zero and leaving it are two presses rather than one. The spacing one
now marks the element dirty too, which it never had: the class came off the
page and the save was never told.

**Four corners that disagree are said in full, comma separated.** An axis
shows `0, 8` for the same reason: one number would be a lie about the others,
and "Mixed" or an average tells you less than the four values. Typing one value
over the list flattens all four. Tabbing through does not, because a comma list
parses as nothing writable and the field puts itself back. This is decided when
the element is selected, and the toggle owns it after that.

**Radius sits with padding and margin, not with typography.** It describes the
same box they do. It is appended straight after the margin section in the body
build rather than at a fixed index, so it stays put as rows come and go, and
Stroke is appended straight after it. Gap follows the two because the BOXES
loop puts gap last, and gap shows on flex and grid containers only, so most
selections never see the seam.

**gap shows the gap the element is using, and offers no switch.** `gap-4`,
`gap-x-4` and `gap-y-4` are three different statements about a container, and
the panel shows the one being made: one field for `gap-4`, one for whichever
axis is set, two when both are. A container saying `gap-x-4` says nothing about
its rows, so a row-gap field there is a control for a decision nobody took.
Nothing set yet is the one gap, which is what `gap-4` means and what the + row
reveals into. Padding and margin keep their toggle because `px-*` and `pt-*`
are two views of the same four edges.

**Stroke is one section over three classes, and the colour is the same object
the two colour rows are.** Frame 7:687 draws it as the colour field across the
row with a tile beside it, and style sharing the line under it with width,
which is 7:620 with a section's name above and a pair underneath. So the field
was pulled out of `colorRow` into `colorField(prefix)` and the two callers own
the row around it and what the tile means. Nothing about the colour is written
twice: the membership read, the unlink, the opacity field and the inline-style
refusal.

**`border-` is the trap four ways over, and every one of them is matched by an
exact test.** `border-2` is a width, `border-solid` a style, `border-oat` a
colour, `border-b-2` one edge's width, and `border-collapse` is not a stroke at
all. The colour goes through the same ramp membership `bg-`/`text-` use, so
`.border-solid` can never enter the map: it sets `border-style` and the read
requires `border-color`, the way `.font-medium` is kept out of the family map.
Measured on `uiux_experiment`: 101 bare `border`, 38 colours, 7 per-side
widths, one `border-0`, and zero numbered widths or style utilities.

**1 is written `border`, never `border-1`.** The bare utility is the one
Tailwind ships and the one these codebases use: 101 sites against zero for
every numbered width. The ladder is 0, 1, 2, 4, 8 and anything off it becomes
`border-[3px]` with the snowflake. There is no dropdown behind the width field
because the frame draws none. The chevron is on Solid beside it, and the arrows
count pixels, which costs nothing since 0, 1, 2, 4 and 8 are all inside eight
presses of each other.

**Revealing a stroke writes one, where revealing a padding writes nothing.** A
padding field with no class still says the element renders 0. A stroke reading
0 wide, no colour and no style is three controls describing a property not on
the page. So the + writes `border border-solid border-black`, 1px solid black,
the one stroke every route can draw, said in all three classes rather than left
half to preflight. Tokens, not lengths or hexes, so the fields read them back
as tokens.

**The style list offers the four that draw something, and reads all six.**
`border-hidden` and `border-none` render nothing while leaving the colour and
width in the class list, so the file and the screen would disagree. The tile
beside the label already removes a stroke outright. An element authored with
one still shows it and gets a row in the list, the way a weight the font does
not ship keeps its row.

**The tile beside Stroke removes the stroke, not the colour.** On the colour
rows the same 40x40 minus takes off one colour. Here the label names the whole
property, and a minus that left a width and a style behind would take the
colour off something still drawn. It is also the only complete way out: the
width steps down to nothing, but the style list offers no "none".

**A width or a style rung the route has never generated gets a runtime rule,
and one it has does not.** `discoverUtilities` notes which `border` and
`border-<style>` rules the page already owns, because a scoped copy of one it
owns outranks its own responsive variants, the `px-6 md:px-12` failure again.
The style rule sets `--tw-border-style` as well as `border-style`: Tailwind
v4's width utilities read the style out of that variable, so a rule setting
only the property would be undone by the width class beside it. The width rule
sets `border-width` and nothing else, because preflight has already put
`border:0 solid` on every element.

**A box write clears the edges, both for width and for colour.** Same rule as
`px-*` clearing `pl-*`, on the edge rather than the axis. A width that left
`border-b-2` standing would do nothing to the bottom edge, and a colour that
left `border-b-oat` standing would paint three sides. Zero per-side colours
across both codebases: the clearing costs a membership test, and not clearing
costs a bug nobody would look for.

**The stroke section shows for a border the page's own CSS draws, not only for
one in the class list.** That border is on screen, so a + row would offer
something the element already has. The width field puts that number in its
placeholder rather than its value, so a number the element does not own is
never mistaken for one it does. Four sides that disagree are said in full,
`1, 0, 0, 0`.

**The style list's specimen is a rule in the style it names, at 3px.** A style
is the value whose name says least about it, the same exemption the family
list's face has. 3 and not 2 because `double` is two lines with a gap, and
under three there is no room for the gap, so it draws as one solid line.

**A property that is not set keeps its row, with a + in it.** Frame 4:407
draws Margin that way: a 40px line, the label on the left, a + in the same
40x40 tile a section's toggle occupies, in Margin's own slot between Padding
and Typography. The old strip of chips at the foot of the panel moved every
unset property out of the panel's reading order, and revealing one made the
layout jump. A row already in place only fills in. Revealing still writes
nothing.

**A + is only offered where the property could change the page.** A row that
could do nothing whatever you set in it has no slot at all, because its
controls are inert. **Typography** needs text under it, its own or a
descendant's, since type cascades, so an `<img>`, a spacer or an empty div
offers nothing. `hasOwnText`, which the section's own fields use, would leave
the + on no element at all, since an element passing it already shows the
section. **gap** needs a container that is flex or grid and has two things to
stand between, and text counts, because a bare string inside a flex parent is
an anonymous flex item. The rule is the + row's alone: an element already
carrying `gap-4` keeps its field however few children it has, so a stale class
stays removable.

**A row's label lights to the value colour under the cursor.** `#dcdcdc`,
which is what a value is set in, up from the label's own `#8c8c8c`, the same
move the tab strip makes. A label sits on the panel's own surface, so it cannot
take the `#2b2b2b` fill a tile does. Keyed on `.bw-row`, so the whole row is
the target.
**The reveal row is a button, not a row with a button in it.** A 20px + is a small target, and the row has one meaning end to end, so the whole 312px takes the click and the label is part of the target. Nothing is nested inside it: the tile at the right is a span drawn to look like the toggle, and it lights on hover of the row, not of itself.

**The hairlines are each row's own, and which row goes without one is decided in code.** Frame 4:407 puts a line edge to edge between rows, centred in the 20px between them. It is `#333333`, not the frame's `#232323`, because that is a field's background and every line running past a field vanished into it. `#333333` is the panel's other hairline, the one around a dropdown, so the design already uses it.

**Every row stands 20px off its line, and the two kinds of row buy it differently.** The frame measures 20 on both sides: 167 to a Padding label at 186.5, 280 to a Margin one at 299.5. A reveal row has it already, its 15px label centred in a 40px box. An open row starts at its label with only the 10px half-gap above, so it takes the other 10 as `margin`, never `padding`, since three suites measure row boxes to the pixel (69 and 173 among them). `top` on the line is measured from the border box, so a row standing 10px further off has its line drawn 10px further away. The line is the row's `::before`, 20px outside it on both sides, so `.bw-body` needs `overflow-x:hidden`: `overflow-y:auto` alone computes overflow-x to `auto` and hangs a scrollbar off that 20px. The first row has no line and the last has the footer: `has-rule` names the first, `markDividers` sets `is-last`. `:first-child` cannot see that rows above it are `display:none`, so `markDividers()` runs after every readout.

**A section says whether it showed, and its + row does not work it out again.** `shown[key]` is set by the section's own readout and read by the reveal row's, which runs after because the row is appended after the section. Re-deriving each field's visibility test in a second place is what drifts.

**Typography reveals as one section, not as four fields.** The frame draws it as one thing, and a + standing in for a 124px field would be wider than what it offers. The four `revealed.family/weight/font/align` keys became one `revealed.typography`.

**One bar at the foot of the panel, holding whichever row the tab owns.** Send and Save are the same kind of button at the end of the same panel, so they stand in the same place: 12px off every edge of the bar, both 40px tall. 12 all round and not the 10 it started at vertically, because the button is aligned to the right gutter and sitting closer to the rule above read as squeezed. Send is built with the Prompt view and parked in the footer.

**Save, undo and redo are not on the Prompt tab at all**, pending edits or none. They are the editor's ledger, and Claude's writes go straight to disk without joining it. Nothing is stranded: the Editor tab is one click away and brings the bar back with its count intact.

**The footer's rule is keyed on the selection, not on `data-tw-idle`.** Idle means the editor's controls are folded, which the Prompt tab does too, and there the footer has a composer above it to divide from. `data-tw-empty` says what matters: with nothing selected the footer is the panel, so there is nothing above it. Its colour is EDGE like every other rule.

**The Prompt tab reads in the order a chat reads: context, then what has been said, then the box you say the next thing in.** The composer used to sit at the top with the transcript under it, putting the newest reply furthest from the field. 20px of air above the first message and below the last, so the log's bottom padding is 0: the composer's own 20px stands under the transcript. Measured 15 above against 34 below before that. The log has no top border, since the tab strip's rule already divides it from the tabs.

**What you said is a box, and what came back is a timeline.** The transcript is one column of the same 13px text, so the speakers are told apart by shape, not colour or a label. Your turn wears the composer's own box, 8px and its 10/12 padding, bordered in EDGE rather than filled: `#232323` is what a field wears and this cannot be typed in. Everything that comes back takes a 5px dot at the gutter with the text 20px in, and a hairline joins one dot to the next. That line is drawn by the entry above, from under its own dot to 12px below itself, which is the log's gap, because only the node above knows the distance. `is-run` is set on the previous node as each reply lands, so a run ending simply has no line to draw.

**A turn that worked reports nothing back.** The seconds it took and the share of the plan's five-hour window it used are facts about the machinery, not the change, and they sat under the field until the next thing typed. The hint is still where a failure goes.

**The tab strip has no padding at its top, and 20 at its foot.** The 60px header already leaves 19px under the title, so the strip's own 20 made a 39px void where everything else sits 20 apart. The 20 below stays, so the tabs stand off their own rule as a row stands off a divider. `.bw-pform` is 20 all round for the same reason, where 12 had the composer crowding the line.

**The + is the export's too.** `assets/ic-plus.svg`, 20x20 on the frame's grid in the design's `#aaa`, replacing a 9x9 `currentColor` glyph drawn when the export had no file for it. It sits in a `.bw-toggle`, the same tile and hover fill every section toggle uses, so the right-hand column holds still whichever of the two a row shows.

**Every tile in that column hangs 10px into the gutter, so its mark lands where the close button's does.** The header already sits this way: `0 10px 0 20px`, a 20px glyph centred in a 40px tile, puts the x's mark on the panel's 20px gutter and only its hover fill outside it. The toggles were flush with that gutter, so their mark stopped 10px short and the + column read as half a tile in from the x. `margin-right:-10px` buys the alignment, and the flex line gets those 10px back: the field grows into them and the 12px between the two is untouched. Everything measured off that field moves with it: the colour row is 270 and its hex split 201 + 12 + 57, the radius corners are two 129px columns.

**The all-corners write clears every `rounded*` on the element.** Same rule as `px-*` over `pl-*`: a more specific class left in place means the field just used does nothing. Picking `md` on an element wearing `rounded-tl-[3px]` has to take the corner with it, or `Mixed` stays `Mixed`. Clearing is safe because the four-corner view is already open whenever the corners disagree, so each has a field to put a value back into.

**A per-corner rung always needs a runtime rule, even where the whole-box one does not.** The rule that leaves a route's own `.rounded-lg` alone does not apply to `.rounded-tl-lg`: Tailwind has generated nothing for it. The rule is built from the live value where there is one, so the corner lands on the box rung's number. On Cora, `2xl` on a corner previews at 21.6px, not the stock 16px, which the live suite asserts.

**The corner icons are the export's, and the toggle swaps two of them.** `assets/ic-radius-{all,parts,tl,tr,bl,br}.svg`: four brackets, the one the field owns lit and the other three in the export's `#505050`. The all-corners mark carries the box as well as its four lit corners and `Parts` is the same four without it, so the toggle reads the way padding's and margin's do. It wore the all-corners mark in both states for a while, because the frame had no `Parts` glyph and drawing one would have been inventing. Before these it was a hand-drawn `radius` glyph, which existed only because the export had no file either.

**A list row is a list row: one size, one weight, whatever it names.** The size list used to set each rung's name at the size it names, and the weight list each name in its weight, in the element's own face. Both had to be capped to keep a row a row, so they stopped drawing the real value where it got interesting, while the number on the right carried the truth. It now carries it alone. The family list keeps its specimen, because a typeface is the one value whose name is not the point.

**The weight list says what it ships by what it lists.** The caption ("5 of 9 shipped by this font") named a fact the rows already made plain. A weight the font lacks is not offered, and one set but not shipped keeps its own row labelled `faux`.

**The palette is a grid of colour, not a list of names, and a ramp is that same grid in a box of its own beside it.** Eleven to a row at 20px, which sets the popover's width: `.is-swatches` is 322, which is 2 of border, 40 of gutter, eleven 20px squares and ten 6px gaps. Eleven because a ramp is eleven, and the same square at the same gap cannot run gutter to gutter on two counts. It was 312 with `1fr` tracks, so the square was whatever the gaps left: 21.6 in the palette, 19.1 in the ramp, 20 in the field. A name needs a row each and turns two dozen colours into a scroll, so the tooltip carries it, and a ramp's tooltip says it opens rather than applies. The Theme and Palette captions take a line of their own, in the popover's title voice, 15px muted and capitalised, rather than the 9px letterspaced caption they were. The shade grid had a taller cell with the number printed across it in `mix-blend-mode:difference`, which made two boxes of one popover look like two controls.

**A ramp is a dropdown of its own, 6px to the left of the palette, and the palette stays open behind it.** It used to be the popover's second view, reached by clicking a hue and left by a back chevron, so a ramp could only be compared against its palette from memory. Two boxes say both at once. The chevron went, and `ICONS.back` with it, and so did the branch in five copies of the test helper that stepped back to the full list. The hue whose ramp is open wears the ring a hovered swatch wears, because nothing in the ramp says which colour it came from.

**The two are levelled on their first square, not on the boxes and not on the grids.** The boxes are nothing alike, one a header over a row of eleven and the other a header over a picker, a caption and three rows, so tops level lined up nothing. Grid box to grid box is still wrong: the palette's grid begins at its `Theme` caption, which spans the row, so the two rows come out one line of caption apart. That measured as a pass while the screenshot showed the miss. It is measured after placement, because the palette's body scrolls and only the laid-out box knows where its first square ended up.

**A list row's text stands on that gutter too, and its fill overhangs.** The row's 12px inset was measured from the body's 20, so "Search" sat at 21, "0px" at 33, and the meta on the right ended at 187 against the X's mark at 199. The 12 is handed back on both sides rather than taken off the row, so the fill still stands off the border. What overhangs is the hover fill, the toggle tile's rule on another surface: what you see of a control at rest is its mark, and the mark belongs on the gutter. Direct children of the body only, so `.bw-picker` and `.bw-swatches` keep the 20 the swatch grid is measured from.

**A popover's content stands on the panel's 20px gutter, which is where its own header already stands.** The title starts at 20 and the close button's mark ends at 20, since a 40px tile holding a 20px glyph lets only the hover fill overhang. The body was at 8, aligned to neither, so a swatch row overhung the title on one side and the mark on the other. Aligning to the tile's edge would be the same miss 10px further in. 20 all round, so the vertical answers the horizontal.

**The panel says "color", not "colour".** Every string the panel shows or puts in a tooltip is US-spelled, because the classes it writes are (`text-color` has no `u` in it) and two spellings of one word in one window is a seam. The prose in this file and in the source keeps its own voice.

**The swatch is the button, and the value is a field.** The whole field used to be one button that opened the list, so a hex out of a design file was the only value that could not be pasted. The colour block is the opener: it is what a picker looks like everywhere, and it wears the hover ring the list's swatches wear. It is 40 wide, 12 of gutter, 20 of swatch, 8 after it, which is frame 4:551's geometry, so the value still starts at 40 and lines up with a spacing field. The chevron went, because the thing that opens is 250px to its left.

**The value takes a hex or a token, and refuses by putting itself back.** `#4837ca`, `4837ca` and `#48c` are the same request, and so are `emerald-500`, `bg-emerald-500` and `bg-emerald-700/40`: the prefix is the panel's business and `/40` is the alpha the opacity field owns. A whole-name ramp is tried before a hue-plus-shade split, because `brand-teal` is one token and only the map knows. Anything else puts back what the field was showing, as a spacing field does with a word. Committing what it already shows is not an edit, because blur fires on everything you tab through.

**Text color sits above Background color, and both of them say "color".** Text is reached for far more often: an element that sets a background is usually a container, and a container's text belongs to its children. "Background" alone was the odd label out beside "Text color".

**The picker sits on top of the presets, not beside them.** Frames 7:620/7:622 gave the row its own controls, so the popover got the one control that can say any colour, with the grid under it as the shortcut to named ones. On top because a column costs no width, where side by side wants ~560px against a 352px panel. On top rather than under because the square is the general case.

**The square needs no canvas, and the hue is a custom property.** Black up the vertical, white across the horizontal, `var(--bw-sv-hue)` behind both, so moving the hue strip is one property and never a repaint. The state is HSV in `popState.hsv`, not read back off the class each frame: white is `s=0` at `v=1` and has no hue left, so a picker re-deriving its hue would forget the strip the moment you dragged into a corner. The knob is 12px and not 14 because at `s=0,v=1` it is centred on the square's corner, 8px in from the popover's border, and 6 of radius plus 2 of ring is exactly that 8.

**A drag is one step in the ledger, however many frames it took.** Text coalesces on a timer because keystrokes are discrete, but a drag has a beginning and an end, so `dragRun` states them, set after the drag's first write so that write opens the step. Writing per frame is the normal path: the DOM is the source of truth, the field shows the live hex, and `ensurePreviewRule` gives each hex a rule. The same point twice is skipped, because a pointer at rest still fires and every write costs a class, a rule and a step.
**No colour-picker package, because this repo has no bundler.** Pickr and Coloris are both MIT, zero-dependency, and draw the same square and strip. But `editor.js` is served verbatim by `server.js`, so taking one means committing a `dist` blob and a theme stylesheet, then overriding it to `#171717` / `#232323` / 8px / 40px and scoping it so it cannot leak onto the host page. The hard parts were already here: `toHex` paints to a canvas, `withAlpha` writes the class, `ensurePreviewRule` gives it a rule, the opacity field commits alpha. What was missing was two controls and about a hundred lines.

**Revealing a colour writes white. Revealing anything else writes nothing.** A padding field with no class still says the element renders 0. A colour field with no class is a dash and an empty swatch, which is why the colour rows hide at all. So the + puts a value there, and white is white on every route rather than a guess at the project's palette. It lands as `bg-white` / `text-white`, a token and not `#FFF`, so it reads as a token, and `ensurePreviewRule` gives it a rule on a route that never generated one.

**The rung dropdown is a list of lengths, and nothing else.** It used to draw a corner at true scale beside each row, capped so a row stayed a row, so past the cap every rung drew the same quarter circle and the preview stopped distinguishing exactly where the values got interesting. It used to name the rung too. Both are gone, and the row is `12px` the way the spacing list's row is `16px`. `tokenList` already filtered on the token as well as the label, so typing `xl` still finds it.

**Font sizes and weights come from the server, not the page.** Opposite of colours: Tailwind v4 emits utilities *and* theme variables on demand, so a route using two sizes exposes exactly two. The full ladder only exists in `theme.css`.

**Font *families* come from the page, like colours, and the read is itself the membership test.** A family is offered if the route generated a `.font-<name>` rule that sets `font-family`. `.font-medium` sets `font-weight` and carries no family, so it can never enter the map and can never be stripped by a family write: the `/^font-/` trap below is disarmed by construction. On `uiux_experiment` this finds four on Cora, one of them the project's own (`accent` → Square Peg). A bundled list of web fonts would offer faces the page cannot render and miss that one.

**…and from `--font-*` in `@layer theme`, which is the half the generated rules miss.** Tailwind v4 emits a utility only where the class is in the source, so a token applied only through `var(--font-volt-mono)` on a `style={{ }}` at the layout wrapper has no `.font-volt-mono` to be discovered by. Volt measured as three faces offered (sans/serif/mono, resolving to the stock stacks) and neither of the two the route is drawn in. murmur was the same with Inter. A theme key is still a writable token: the utility appears the moment the class does, and the live suite asserts that against the real build. Save `font-volt-mono`, poll, and `.font-volt-mono` is there.

**The layer is the membership test, and the `:root` selector is not.** next/font declares `--font-geist-mono` on a CSS-module class (`.geist_mono_8d43a2aa-module__…`), not in `@theme`. It is a plain custom property, so `font-geist-mono` would preview through a runtime rule and generate *nothing* on the real build. Tailwind puts its theme block in `@layer theme` and nothing else does, so walking with an `inTheme` flag and taking `--font-*` only inside it separates the two exactly. `--font-weight-*` is excluded by name: the same seam `font-` makes in a class list, one level down.

**A family row's note is the CSS generic, never the project's slot name.** `meridian`, `meridian-mono`, `volt`, `murmur-display` are names one codebase invented, sitting in the one column that should read the same whatever project the editor points at. It now says `sans-serif`, `serif`, `monospace`, `cursive` or `fantasy` and nothing else. The token stays in the tooltip beside the stack it resolves to. It also stopped the face being the half that truncated: `Geist Mono` clipped to `Geist M…` beside a full-width `meridian-mono`.

**The generic comes from the first keyword in the *resolved* stack.** First and not last, because Tailwind's own sans ends `…, "Noto Color Emoji"`, so reading from the end finds a face rather than a keyword. Whole comma-separated entries and never a substring, because `sans-serif` contains `serif`. The resolved stack and not the declaration, since `.font-sans` is often just `var(--font-sans)` and a var says nothing about what it holds.

**The list is ordered by that generic, with the project's own token leading its run, and there are no headings.** Ordering keeps like with like, and the note down the right makes the runs legible without a caption over each. Leading the run: on volt `sans` is a stock stack the route never draws in and `volt` is the Geist it does. Nothing is dropped as a duplicate. Two sans faces are two things you can pick.

**Five generics, and deliberately no sixth.** `serif`, `sans-serif`, `monospace`, `cursive`, `fantasy` are what CSS offers, so a face resolving to one of them can be named without guessing. A stack naming no generic, `"Some Face", "Some Fallback"`, says nothing about what kind of type it is, and an "other" label means "we could not tell". Such a token is **not offered**, because a rule that guesses guesses differently in every unmeasured project. The live suite pins both halves with keys these projects do not have: a `cursive` one is said in full, a name-only one is absent.

**A family from a variable needs a preview rule. One from a utility must not get one.** The old note said no rule is ever added, which was true while the map held only generated utilities and false once it holds theme keys too. `renderable.family` stays the record of what the page has drawn and `FAMILIES` is a *copy* with the utilities merged over the variables, so `ensureFamilyRule` can skip by name. A scoped `[data-thisone-edited].font-sans` over a route's own `.font-sans` is the `px-6 md:px-12` failure again. The utility also wins the merge on value, because under `@theme inline` it is the truer of the two: cora's `.font-mono` carries `ui-monospace, "Cascadia Code"` while the variable it was built from is not emitted at all.

**A family declaration is not always a stack.** `@theme inline` bakes the value in, but a plain `@theme` emits `font-family:var(--font-sans)`, and `var(--font-sans)` is not the name of a typeface, which is what the panel showed at first. The chain is followed by painting it onto a probe, not by parsing, because a var may point at another var and only the cascade knows. The probe sits inside a host wearing a sentinel family: a var resolving to nothing is invalid at computed-value time and *inherits*, so without the sentinel a dead token would report whatever the panel happens to inherit. Measured on the real app: `/` gives `var(--font-geist-sans)` → Geist, volt/polaris/meridian give `var(--font-sans)` → `ui-sans-serif`, Cora needs no resolving at all.

**`cn()` is edited by delta, not by snapshot.** The rendered class string is the union of every argument, so writing it into argument one would duplicate what the conditionals contributed. The client sends `added`/`removed` against a baseline captured at selection.

**Family matching is by membership, not prefix.** `font-medium` is a weight and `font-sans` a family, so `/^font-/` would delete `font-sans` on every weight change (150 and 438 uses at risk). `gap-` needs a lookahead because `gap-x-4` starts with it. `rounded-` is the trap twice over: `rounded-sm` is a rung, `rounded-s` the two start corners, `rounded-t-lg` neither, so `radiusOn` matches the base whole and tests the tail for membership, and `rounded` can never swallow `rounded-tl-lg`. `text-` is the trap three ways: `text-lg` a size, `text-clay` a colour, `text-center` an alignment, each matched by an exact set. `border-` is the trap four ways over: `border-2` a width, `border-solid` a style, `border-oat` a colour, `border-b-2` one edge, and `border-collapse` and `border-spacing-2` not strokes at all. Colour membership is the ramp test, which rules out the others by construction, and the rest are exact patterns.

**Undo/redo is by snapshot, not by command.** Every control already writes straight to the DOM and to `dirty`, so recording the state after each mutation is cheaper and harder to get wrong than teaching a dozen call sites to describe and invert themselves. A state is one entry per element the session has touched, and sessions touch a handful. Pristine state is captured in `select()`, not in `markDirty()`: every mutation acts on the current selection, so selection is the last moment the element is untouched.

**Undo stops at a save.** The file has already changed, so stepping back could only stage the reverse as a fresh edit while claiming to have undone something. The saved state becomes the new starting point.

**The button bar outlives the selection, and the panel is anchored to the bottom.** Save, undo and redo have nothing to do with which element is selected, and losing Save by clicking the background stranded unsaved work behind a click. Bottom-anchored, the bar holds still and the panel grows *upward* above it. Top-anchored, every selection shoved Save down the screen.

**Everything in the panel grows upward out of the button row, including dragging.** The bar is the drag handle as well as the header, because the header folds away exactly when the bar is all there is. Dragging pins the *bottom* edge. Pinning `top`, as it was first written, meant that after a drag the next selection pushed the bar back down the screen. The status message sits *above* the buttons for the same reason: underneath them, a message appearing or clearing changed the footer's height and slid the buttons 22px.

**The delete handle belongs to its element's top edge, not to the viewport.** Clamping it into view unconditionally left it stuck to the top of the screen after the element had scrolled away, pointing at nothing. It may be nudged into view by up to its own size, which is what an element flush against an edge needs, and past that it hides. The two candidate positions are the element's top corners only. The second exists to dodge the panel, not to follow the scroll.

**The panel wears one scheme, and it is not invented.** Colours, radii, field heights and type sizes come from a Figma frame (file `gYjihaL4o8QTceS1REp3fY`, node 1:2 for the panel, 2:202 for the dropdown, 2:188/2:194 for the close button): `#171717` surfaces, `#232323` fields, `#dcdcdc` values, `#8c8c8c` labels, `#505050` borders, `#aaa` icon marks, `#212121` hairlines, `#2b2b2b` a row under the cursor. 12px on a container and 8px on a field, 40px fields and rows, a 60px header, 15px text, 20px gutter, 12px between controls, 8px under a label. The close button is 40x40 and transparent until hovered. It replaced a light/dark pair: a light variant of a dark design would be an invention, so both theme keys carry the same scheme.

**Spacing is spoken in pixels, and written in Tailwind.** The fields show and take a pixel count, 16 and not 4, because nobody should have to multiply by four to use a panel. The class written is still the rung where one lands (`p-4`), and only a length with no rung behind it becomes `p-[13px]`, which is what the snowflake marks. Typed values are no longer snapped: `ensureSpacingRule` emits a runtime rule for anything off the pre-generated ladder. The old comment was right that an unsnapped `p-13` would have previewed as nothing.

**The Text row is a field, not a mirror.** It is a textarea that writes straight through to the element, the same as typing on the page does, so the DOM stays the one source of truth and the save path reads it either way. Where the text cannot be rewritten (a container, or JSX that refuses) the field is disabled and the reason is its placeholder.

**An axis field owns the two edges beneath it, both ways.** A `py-*` lookup cannot see `pt-*`, so reading an axis reads its edges. Disagreement is the only reason the four-edge view opens: `pt-0 pb-0 pl-4 pr-4` reads perfectly well as 0 and 16. Folded, a disagreeing pair shows comma separated and upright, with `0` for an edge that owns no class, because `, 8` reads as a missing number. Writing has to clear them too: leaving `pl-6` in place while writing `px-8` means the more specific class wins and the field you just typed into does nothing.

**The four-edge view opens once per selection, not once per refresh.** The rule that opens it for an element already carrying `pt-*` used to re-run on every readout, so collapsing such an element lasted until the next keystroke and typing into a folded axis snapped the view back mid-edit. It is now decided when the element is selected and the toggle owns it after that.

**Committing what a field already shows is not an edit.** Blur fires on every field you tab through. Without that guard each one marked the element dirty and pushed a history step that undid to itself. Worse, stepping below zero drops the class, so the blur that followed wrote the inherited value straight back.

**A field that is not set still knows its answer.** Padding and margin are not inherited, and preflight zeroes the browser defaults, so no class means zero: the field shows `0`, greyed, rather than an empty box. Where the page's own CSS has put something there, it shows that instead, because a `0` the panel cannot back up is a lie. Half steps count too: `py-2.5` and friends are 97 of the 802 spacing classes in `uiux_experiment`, and an integers-only pattern read every one of them as unset.

**The colour field wears its swatch the size the frame draws it.** Frame 4:551: 20x20 at a 3px radius on the 12px gutter, name 8px after it, so the value starts at 40, the same place a spacing field's value starts behind its 20px mark, which is why the two rows line up. Sized on `.bw-color .bw-chip` rather than on `.bw-chip`, because the same class draws the swatches in the dropdown list and the frame keeps those small.

**A colour with nothing set stands in for itself, like every other optional row.** Background and Text color were the last two always on show, and an element that sets neither got a dash and an empty checkerboard swatch. They now hide behind the + row, on `revealed.bg` and `revealed.text`. The four `pickColor` helpers across the suites open that row first when it is showing.

**A colour set by a `style` attribute is read, and refused.** 714 elements in uiux_experiment carry a `style` prop and 263 of them set a colour, so this is an idiom, not an edge. The panel used to call such an element unset, and once the colour rows learned to hide, offered a + for a colour plainly on screen. It now reads `el.style.color` / `el.style.backgroundColor`, paints the swatch with what is actually computed, and prints the hex. An inline declaration outranks every class, so a class written here would be inert: the field disables itself and the title says where the colour comes from, the `px-*` clearing `pl-*` rule met from the other side. Every *other* field has the same blind spot against an inline style. Only colour is handled.

**What you can do to a colour is drawn in the row, not hidden in the list.** Frames 7:620 and 7:622: the unlink in the field's right-hand slot, the minus in the 40x40 tile beside it, both on screen the whole time. They spent a while as named rows *inside* the popover, because a control beside the value reads as delete whatever its icon says. That was true while removal was one of the two controls in the field. Removal is now the tile in the toggle column, so the one mark left beside the value cannot be read as a delete, and the list went back to being a list of colours.

**The minus and the + are the same tile, which is what makes the fold safe.** Taking a colour off clears `revealed`, so the row folds straight back to the + that offers it again. Removal was forbidden to do that while it lived in the popover, because the field vanished from under a cursor that had reached into a list to remove it. Here the tile it was clicked in is the tile the + lands in, same 40x40, same column, and the suite asserts the two land on the same pixel. Pressing the + writes white again.

**Opacity is a field of its own, and it is what a hex has.** Frame 7:622 splits the row: the 57 it takes and the 12 beside it come out of the colour field and out of nothing else, so the tile after them stands in the same place whichever state the row is in. It was a 24px monospace number behind a hairline inside the colour field. It now carries "100%" in the panel's own 15px, sized from a hidden sizer rather than from `ch`: a `ch` is the width of a zero and these digits are not, so `3ch` for "100" left a space that read as "100 %". A token has no opacity field because `clay-100/40` is a fourth kind of thing. The way to one is the unlink.

**The unlink and the chevron share one slot, and hide the same way.** Both are affordances rather than information, so the unlink is held at `opacity:0` until the field is hovered, focused or open, exactly as the chevron is, and takes `pointer-events` with it so a mark you cannot see is not a button you can press. They cannot both come out: `has-unlink` takes the chevron out of the slot, since a token has the unlink and anything else keeps the chevron. The unlink writes the colour the element *renders*, `resolvedColor` following `var(--x)` against the selection because a ramp entry is not always a literal, so the paint does not change, only what the class says. The hand-drawn 12px glyph it replaced existed because `assets/` had no file for it. `ic-minus.svg` is the export's plus with its upright taken off, the same `M4.16667 10H15.8333` on the same 20 grid.

**A hex colour is a literal, and this was the one field that never said so.** Every other value in the panel that is not a token on a scale is italic, a shade back, and carries the snowflake. An arbitrary colour showed the hex at full contrast with nothing to mark it. It now takes `is-custom` and the snowflake from the same condition, `kind === 'arbitrary'`, which is what the cross-field assertion below requires. The snowflake sits where a unit sits, so the chevron takes its place on hover exactly as elsewhere.
**The size field is a field, and the chevron is the button.** The whole field used to be one button that opened a list, so a size out of a design file could be picked but not typed. Same change the colour row went through: there is no swatch here, so the chevron is the opener and the value becomes an input, as spacing and radius are drawn. The hover fill went with the button, so the weight field is now the only half of that line that lights. The value stands on the same 12px gutter as the bare token: `.bw-field.is-bare > .bw-val` is `.bw-ctoken.is-bare` read on an input.

**A number typed there is a length, a name is the token, and a number never becomes one.** Padding, radius and stroke width write the rung when a typed pixel lands on it, because their rungs are the length and nothing else: `p-4` for 16 changes only the class name. A `text-*` token also sets a line-height, so `text-lg` for a typed 18 would move the leading. 18 is therefore `text-[18px]`, snowflaked, even where `lg` is exactly 18. The token is a click away in the list or its own name typed in, which is what the list's custom row has always written. The arrows follow the same rule: a press writes `text-[25px]`, never the rung 25 happens to be, so counting off a token detaches from it.

**A note in a field asks for the centre and does not get it for free.** A `.bw-field` stretches its children, so a 13px note in a 40px field sits flush against the top edge. It went unseen because every earlier note sat inside a `.bw-ctoken`, which centres its own row. The Size field's is the first to be a child of the field itself, and the radius box's `+n` was the same bug waiting on a logical class neither codebase has. `.bw-unit` now carries the two properties `.bw-snow` already had for the slot they share. The suite measures the **text** with a Range rather than the span, because a stretched box is centred by definition.

**The size field speaks the same bare pixels the others do, and keeps a unit only where it is not one.** `24`, not `24px`, because every length in this panel is in pixels. But `text-[1.5rem]` reads `1.5rem`, since a literal in another unit has to keep it or it says nothing. That is spacing's rule, met on the one length field that routinely holds rem. An unset size puts what the page renders in the **placeholder**, not the value, which is the stroke width field's rule: a number the element does not own must never look like one it does.

**A literal font size wears the snowflake alone, not a nearest rung beside it.** The Size field used to name the nearest token, `sm`, in the note slot where `lg` sits on a row really set to `lg`, a shade away from claiming the element wears it. Radius and spacing take arbitrary values as often and say nothing, and `nearestToken` had exactly one caller. The tooltip keeps the hint, where "nearest is sm at 14px" costs nothing.

**Italic means one thing: this value is a literal.** It used to also mean "inherited from a broader class", which put top and bottom into italic the moment you typed a vertical value. Inherited keeps only the dimmed colour. A literal is italic, a shade back (`#b4b4b4`), and carries the snowflake. The two are set from one condition and a test asserts they never disagree on any field.

**Typography is one section, not three rows.** Frame `1:3`: the family across the row, weight and size sharing the line below, the alignment segment under that. 40px rows, 12px apart, 8px under the label, 173px in total, which the live suite asserts to the pixel. Three labels became one because they name one thing, and a 124px field cannot afford a label beside it. Each field still decides its own visibility, and the weight/size pair collapses to one column rather than leaving a hole.

**The section reserves the gutter its row has no toggle for.** Every other section ends in a 40x40 tile, so its stack stops 270px in and its pair is two 129px columns. Typography has no tile, so its stack ran the full 312 and the two fields below came out 150 apiece, a weight/size pair missing the padding pair's columns by 21px. `is-inset` is `margin-right:42px`: the 12px between a stack and a tile plus the 30 a tile takes off the flex line, its 40 less the 10 it hangs into the gutter. Same arithmetic as the toggle's negative margin, read from the other side.

**The alignment segment is the pair's first column, not a width of its own.** 6+28+14+28+14+28+6 is the frame's 124px exactly, and it sits under the weight field. Once that field settled on the padding row's 129 the segment stopped 5px inside a right edge it plainly lines up with. It asks for the column by name now (`calc((100% - 12px) / 2)`), because a flex column stretches its children to all 270. The 5px goes to its gutter, not its gaps: the three 28px tiles keep the frame's 14px rhythm and the box widens. The live suite asserts it against the weight field rather than against 124.

**These fields are bare, with no leading mark, and that is why.** Two of them share one 260px line, so a 20px icon with its 10px margins would eat a third of each. The dropdowns with a row to themselves, radius and the two colours, keep their marks. The one exception is the family's `Ag`, which is not an icon but the face itself, set in the face.

**A family is named by its typeface, with the token beside it.** `font-sans` is Euclid Circular B here and Inter somewhere else, so "sans" is only the slot. Both are shown, face left and token right, because the slot is real information too. Only the *first* entry of the stack is named: the rest are fallbacks, so on `ui-monospace, "Cascadia Code"` naming Cascadia Code would name the wrong font.

**The focus ring is an outline, not an inset shadow.** A child's background paints over its parent's inset shadow, and the token button fills its field edge to edge. So the ring on an open dropdown was drawn the whole time and hidden under `.bw-ctoken:hover`, where the cursor is after the click that opened it. `outline` paints over descendants. At `outline-offset:-1px` it lands where the shadow did and follows the same 8px radius.

**A generic is not a typeface, so the name is measured by painting it.** `ui-sans-serif` is a request the platform answers, and CSS never says what it answered. So a probe string is rendered in the stack and again in each candidate face, and the *bitmaps* are hashed. Bitmaps rather than widths because the pairs that matter are metric-compatible clones: Arial and Liberation Sans measure identically and draw differently. A candidate that is not installed falls through a bogus second entry onto the browser default, which is what the control measures, so a missing font is skipped and can never be named.

**Verified that the canvas answers the same question the page does.** Measured both ways across fourteen stacks: the DOM's width groups and the canvas's ink groups partition identically. That check also showed this Chromium supports **none** of `ui-sans-serif` / `ui-serif` / `ui-monospace`, in CSS or canvas. They fall straight through, which is why `ui-monospace` leads to Menlo on volt (via `SFMono-Regular, Menlo`) and to Courier on Cora (via the default `monospace`), and why printing that keyword named the one string guaranteed *not* to be on screen.

**Where measuring cannot name it, the fallback is stated, never invented.** macOS draws `ui-sans-serif` with `.AppleSystemUIFont`, which no addressable family matches. The installed "SF Pro" is measurably different, an optical variant Chromium does not use here. Matching `system-ui` *proves* it is the platform UI font, so a small table names it (macOS SF Pro, Windows Segoe UI, Android Roboto, desktop Linux gets none). The cascade is measured → placed → the first name the author wrote in the stack → the token, and the tooltip carries the true stack throughout.

**A family names itself in its own face, in the list and in the field.** The specimen and the label are one object, and the field keeps the face after you pick. This needs headroom: `.bw-cname` is 15px/**1** with `overflow:hidden` for the ellipsis, which clips both axes, so a script face loses its ascenders and tail. `is-face` buys line-height 1.6 and leaves the size at the frame's 15px, because the field sits beside `400` and `16px`.

**Two `margin-left:auto` in one row split the free space between them.** The note carried one and the chevron another, which stranded `inherited` halfway across a wide field. The name takes the slack now (`flex:1`) and the note sits at its natural width. `flex:1` on that name then needed `text-align:left`, because the token is a `<button>` and a button centres its text.

**`flex:1` on a `.bw-field` means *height* once the field is in a column.** The family field collapsed from 40px to the 15px of its own line box. The two in the pair below are grid items, which ignore `flex`, which is why only one of the three broke and it looked like a family-only bug.

**Icons are the exported files, inlined byte-for-byte, never redrawn.** They live in `assets/` and are pasted into `ICONS` exactly as exported, keeping their own `#aaa` / `#505050` / `#858585` fills rather than `currentColor`. Inlining is the file with its newlines taken out, which is what lets `test/12-icons.js` re-derive every entry from `assets/` and fail on any that drifted. Twenty-one had, all at once, after one re-export from the frame. The same suite refuses a file in `assets/` no entry claims, which is how the four-corner `Parts` glyph sat unused, and refuses two exports sharing an id anything points at, since the second would wear the first's clipPath. The four marks with no file (the individual edges) stay hand-drawn on a 12 grid, rendered at 20 with a 0.9 stroke so they land on the assets' 1.5.

**Gap wears the two exported marks, and the single gap asks the element which one.** `ic-gap-hz` is a bar between two upright brackets, `ic-gap-vt` the same turned a quarter. `gap-x-*` takes the first and `gap-y-*` the second, fixed, because `gap-x-*` is column gap everywhere. The lone `gap-4` is a *vertical* gap on a `flex-col` and a horizontal one on a `flex-row`, so a static mark is wrong half the time. `gapOneIcon` reads the computed `flex-direction` and the readout swaps the mark only when the selection changes, since rewriting the SVG under the cursor on every readout would throw it away for nothing. Grid keeps the horizontal mark: there `gap-4` sets both axes and neither file says "both". This retired the last hand-drawn trio, a 2x2 grid and two bar pairs. Five checks in `02-spacing-sides` pin the pairing, `flex-row-reverse` and `grid` included.

**Edit mode is off until it is asked for.** While it is on, every click is swallowed in the capture phase so the app's own links and buttons cannot fire, which makes the page selectable and unusable as an app. A page carrying the overlay is just a page until the toggle is pressed. The choice is kept in `sessionStorage`, so a reload or route change keeps you editing and a fresh tab starts on the page as its users see it. Leaving the mode never discards pending edits: their markers stay on the page and the count stays on the toggle.

**Removal is marked, not done.** Clicking the × ghosts the element and every other instance of its source location, folds the panel to a notice and an Undo, and writes nothing. Save is what cuts the source. Ghosting rather than hiding is deliberate: a hidden element cannot be clicked, so it could not be undone.

**The Undo in that notice is bare, like the close button.** It wore the `#232323` a field wears, a filled box inside a box already tinted and outlined. It is now text on the notice's own ground, lighting from label grey to value white under the cursor, as every row label does. 5px above and below sets its 13px line on the same centre as the 15px heading, and nothing at the sides keeps it flush to the notice's 14px gutter. The old hover rule moved a `border-color` on an element with `border:0` and had never shown anything.

**An element may only be removed from a JSX children list.** That is the one position where lifting the node out still parses. A component root has to return something, `{open && <div/>}` would be left as `{open && }`, and a `.map()` arrow's body is the value it yields. Each is refused by name. The cut takes the element's own lines whole, indentation and trailing newline included, so no blank line is left in the diff.

**The overlay must not take removed nodes off the page under Next.** The dev server re-renders from the new source, and pulling a node out from under React makes its next reconcile throw `removeChild` on something it no longer owns. The backend says which world it is in (`hmr: true`), and only the HTML one, where nothing re-renders, has its DOM updated by hand.

**Three things about wiring only go wrong once the editor is installed rather than sitting next to the project, so nothing in a sibling checkout can catch them.**

*Backups go in the project, at `.thisone/backups/`.* They used to live beside this code, where `__dirname` is inside `node_modules`, the one directory `npm ci` deletes and a fresh clone never has. So the only copy of the user's `next.config.ts` and `layout.tsx` sat exactly where a reinstall wipes it, and `--unwire` reads from there. They are named after the path inside the project, not the basename, which is the collision the trap below warns about. The directory carries a self-ignoring `.gitignore` so it stays out of the project's history.

*The loader shim is resolved by package name.* It writes `tools/thisone-loader.cjs` into the user's repo under `tools/`, where they will commit it, so an absolute path in it breaks for every teammate and CI checkout. `require('<pkg>/loader')` needs the subpath in `exports`, which is why package.json has one. Where the package does *not* resolve from the project, as in this checkout run against a sibling, it falls back to its own path and says `NOT PORTABLE` in the file.

*The port is read when the page renders, not written in when it is wired.* `overlayTags` used to bake the number into the layout. Wire at the default, later run `--port 3600`, and the overlay is fetched from the old port and never loads, with nothing saying why. It reads `NEXT_PUBLIC_THISONE_PORT ?? 3500` instead, and the CLI prints the export line whenever the port is not the default.

The turbopack rule gained `:start`/`:end` markers to go with that, because both snippets now change between versions and `--unwire` matched the rule by exact string. A `replace` that does not match fails silently, reporting success while the project still carries the block. It matches by marker now and names any file it could not take the block out of.
**The allowlist names files, not directories, and `assets/` is not on it.**
A directory entry is not an allowlist: the next dev-only script to land in
`next/` would join the tarball silently, the way `verify-prompt.js` did. With
`files` absent, npm fell back to `.gitignore` and shipped 69 files, 257kB,
including 200kB of Playwright suites, both live `verify` scripts, the unreachable
`astro-locator.mjs` and a 110kB handover document. It is 15 files and 143kB now,
each named rather than `"next"`. A runtime file left off the list fails loudly,
since it does not resolve and the first install test says so.

`assets/` is off it because nothing at runtime reads the files. The icons are
inlined into `editor.js` byte-for-byte, and the only thing that opens the SVGs is
`test/12-icons.js`, which does not ship either. Shipping them without that guard
would put a second copy of every icon in the tarball with nothing checking it
matches the one drawn.

**`engines` is Next's floor, not the language's.** Nothing here needs more than
Node 14, `fs.rmSync` being the newest thing in it, so a floor read from the
source would say `>=14` and mean nothing. `>=20.9.0` is what `next` declares,
and this tool is only useful attached to such a project. A floor is a claim
about where it is known to work.

**A free port is an answer about the past, so `dev` retries the pair.** The
probe answers for the moment it was asked, not the moment the child binds.
`--wire` rewrites next.config.ts, Next fully restarts, and the probe lands while
its port is down: 3001 was free when asked and taken when Next reached for it.
Hit on the first try in a real trial. The app is spawned with the editor's port
and the editor with the app's origin, and neither can be told later, so a
failure on either side retires both and the next pair is tried.

**A child that died is not proof that its port was taken.** Next refuses a
second dev server for the same directory on any port: it prints "Another next
dev server is already running" and exits. Treating every exit as a collision
turned that into four restarts that could not succeed and a message blaming a
restart loop. The tail of the child's output is read now: `duplicate` stops and
quotes the running server, `port-taken` is the only reason worth another port,
anything else stops and shows what the app said. `whyItDied` lives in
`detect.js` because `cli.js` executes on require and cannot be unit tested. Its
fixtures are verbatim Next 16.3.3 output.

**Read that complaint from the complaint, not from the top of the buffer.** Our
own child prints `- Local: http://localhost:3002` a moment before it finds the
conflict, so a search over the whole tail named the port that just failed
instead of the server to go to. The first version sent the user to the wrong one.

**"Something answered" has to mean a web server, not an open socket.** A
process squatting on a port accepts a connection and never replies, so the old
check passed exactly the case it existed to catch, and `dev` announced "Both up"
on a port its app never got. It makes an HTTP request now and requires a
response. Any status will do, since Next answers while compiling and a 404 still
proves the port speaks HTTP. A child still alive at the deadline also counts,
because a first compile is not on a clock.

**Wiring throws away `.next/dev`, because wiring has just invalidated it.**
Turbopack caches module resolutions, failures included. Unwire with the dev
server up and it caches "there is no such file". Wire again and every page
500s with `Cannot find module …/tools/thisone-loader.cjs`, naming a path that is
plainly there, so it reads as this tool's bug. `.next/dev` only: Next 16 keeps
dev and build output in separate trees, and a production build is not ours.

**`dev` owns all three numbers, because a user holding them cannot keep them
in step.** The app's port, the editor's port and the origin the editor accepts
writes from must agree, and the third fails worst: everything looks right until
Save is refused as a bad origin. Found by running the tool with a real session
already up, so both default ports were taken, which is what a second project
looks like. `thisone dev` picks both ports, sets `NEXT_PUBLIC_THISONE_PORT` in
the app's environment and points the origin at it.

**The port probe has to bind the way the server it is testing for binds.**
`next dev` listens on every interface, the editor only on 127.0.0.1, and on macOS
a loopback bind succeeds against a port a wildcard listener holds. Probing
127.0.0.1 called 3000 free while another app was on it, and Next died a second
later. The standalone server does not probe at all: the layout falls back to
3500, so a server that quietly moved would leave the overlay failing in silence.
Moving is safe only where we also own the app's environment.

**Wiring is setup, and setup is no reason to start a server.** `--wire` used to
fall through into running, so it silently meant "run" on an already-wired
project and failed after succeeding when the port was busy, as if the wiring had
broken. It is its own branch now, ending in what to type next. That also took a
server spawn out of `06-detect`, a fair suspect for the stale-port trap below.

**A busy port gets a sentence, not a stack trace.** Two editors is the normal
case, so `EADDRINUSE` is caught and answered with the flag that fixes it.
`Unhandled 'error' event` reads as a broken tool rather than a missing argument.

**The panel is told what the source looks like, because the DOM cannot say.**
`{name}` renders as ordinary characters, so an element the writer will refuse
looks exactly like one it accepts, and the overlay used to object only at save.
The loader stamps `data-thisone-text` from the same `textShape` the writer's
refusal uses, so the two cannot drift. Only the awkward shapes are named: `expr`
for characters with no literal behind them, `runs` for a literal interleaved
with markup. Empty and single-literal say nothing, being the common and editable
case. A container of elements says nothing either, or every wrapper would carry
a notice about why you cannot type into a `<div>` of `<li>`s.

**That one gets a line where the box would have been, rather than silence.**
Every other unwritable row is simply not drawn, since a disabled control
explaining itself is a large way to say nothing. Text from an expression is
plainly there on the page, so a vanished row reads as a bug and a row saying
where the characters come from reads as an answer.

**Text is edited a run at a time, because a run is what a literal is.** A `<p>`
holding text, an `<a>` and more text is several literals with markup between
them, each its own stretch of the file. Writing one is the same operation as
writing a class: replace a span, leave everything else. The old refusal was
only ever about `Hello {name}`, one rendered string with no way to tell which
characters came from the literal. Siblings have no such ambiguity, and refusing
them cost the whole mixed-content majority.

**A run is found by what it says, not by where it sits.** React emits `{" "}`
as a text node of its own, so the overlay's third text node is not the third
`JsxText`. Content also makes the write self-checking: `from` is what the panel
believed was there, so a file that has moved on is refused, the same bargain
`cn()` strikes with a delta. Whitespace is folded before comparing, since a run
written across three source lines is one line on the page.

**The space either side of a run belongs to the layout, not to the sentence.**
`Read the <a>docs</a>` renders as two words because of the trailing space in the
literal. The field hands back the words, so writing them straight over the node
gave `Read thedocs`, in the DOM and on disk, while a test asserting
`line.includes('Start with the')` passed anyway. The gaps are kept aside and put
back on every write, and the test compares the whole line. The JSX writer never
had the bug: its span already excludes surrounding whitespace.

**Both backends had to be taught, and their validators are separate copies.**
The panel is shared, so a field it offers must be writable in either mode.
`runs` reached the JSX writer and the HTML server, and the Next server's own
`validateEdit` rejected it with "nothing to edit". Caught only by driving the
real app, with every fixture suite green. The two validators are the most
obvious place for the next thing to drift.

**Anything unsafe is refused with a reason, never guessed at.** `cn()` with no
string literal, `cva()`, interpolated templates, text mixed with `{expressions}`,
paths outside the root. Refusals surface in the panel.

**The Prompt tab runs its own session, because the one in VSCode cannot be
driven from outside.** `claude-vscode.editor.open` takes an `initialPrompt`, but
`createPanel` answers an open session with "Session is already open" and asks
you to enter the prompt manually, and on the new-session path the webview only
calls `setInputText`, a prefill and never a submit. The websocket in
`~/.claude/ide/<port>.lock` serves terminal CLI sessions, and its whole method
surface is `get_current_selection`, `selection_changed`, `at_mentioned`,
`openDiff`, `executeCode`: nothing submits a turn. So the editor spawns
`claude -p` itself. Re-check the extension bundle before trying again.

**A turn is a child process, not a daemon.** `--resume` carries the
conversation forward, so there is no long-lived process to supervise and a hung
turn is ended by killing a pid. Measured: the second turn of a session costs
about a tenth of the first, because the prompt cache does the work a persistent
process would have been kept alive for.

**What the panel reports after a turn is seconds and the plan's five-hour
window, never dollars.** `claude -p` uses the OAuth credentials already on the
machine, so a turn draws on the subscription's rolling windows. `total_cost_usd`
in the result envelope is a list-price equivalent, not a charge, so printing it
is a plausible-looking lie. The real number is in
`rate_limit_event.unifiedWindows.five_hour.utilization`.

**The prompt points at the element rather than describing it.** The loader has
stamped `file:line:col` on it, so the preamble names the file, the line, the tag
and the current className, which is why this beats typing into a terminal.
Where one location renders several elements the count goes in too, since that
is the case the person cannot see.

**A pending edit refuses the turn.** Class changes live in the DOM until Save,
and Claude reads the file off disk, so a turn started with edits pending reasons
about a file that does not exist and its write silently drops them. The refusal
names the count and says why.

**The fence is a deny list, not an allow list.** `--allowed-tools` is the
auto-approve list, and an empty string still leaves every tool available. What
keeps Bash out is `--disallowed-tools`, and the network tools go with it so a
prompt typed into a web page cannot reach off the machine.

**`/prompt` is opt-in where `/edit` is not.** They wear the same lock, same
origin check, token and 415, but `/edit` replaces a byte span in a `.tsx` under
the root and `safeResolve` bounds that. `/prompt` hands a sentence to a coding
agent, and no path check bounds what comes out. Larger blast radius, so it is
off unless asked for and the tab is not drawn without it.

**The tabs are the panel's top edge, and a drag handle like the rest of the
chrome.** They sit above the header because the header folds away with the
selection and the tabs must not: switching to Prompt is what you do when
nothing is selected. So `data-tw-idle` now means "the editor controls have
nothing to show", not "the panel is empty", or the Prompt tab would fold away
the tab just switched to.

**The root `CLAUDE.md` is a short contract, and the reasons live here.** The
handover was one 1,809-line, 116 kB file loaded into every session. Anthropic's
own guidance targets under 200 lines and says a bloated file gets its rules
ignored. The well-run open-source repos measured (Cloudflare workers-sdk,
Sentry, Astro, claude-code-action) all sit between 54 and 143 lines with the
same shape: commands, layout, rules, tests, git, traps, pointers. So the root
file keeps the rules and the traps, this file keeps the why, `docs/TESTING.md`
keeps the suite map, and `docs/RELEASE.md` keeps the commit and release steps.
Nothing was deleted in the split. The prose here was condensed from 18,000
words to 14,343 with a checker confirming all 605 identifiers and numbers
survived. Commits use Conventional Commits from 2026-09-10, on Thomas's
decision, so the log can be read by type at a glance and matches the studio's
other repos. The commits before that date are plain sentences and are left
as they are.

**Two edits on one line collapse when they agree and are refused when they do
not.** A component rendered several times is one line of source and many
elements on screen, so editing two of them and saving once sends two edits that
resolve to the same bytes. `editFile` spliced both back to front, which applied
the second against offsets the first had already moved: it ate the closing
quote off a `className` and left the file unparseable. Found in a real project,
where Next pointed at `py-3.5` two lines below the damage, because a stray
number is the first thing a JSX parser cannot use once a string runs on. Same
value is the ordinary case and now applies once. Two different values have no
answer to give, since there is one line to write, so the save is refused with
`shared-location` rather than silently discarding one of them. A general
overlap check sits behind the grouping for any span shape it does not name.

**The writer's suite parses what it writes.** All 48 checks in
`05-jsx-adapter` compared strings and none asked whether the result was still
source, which is how a `className` missing its closing quote passed. Every
successful write is now kept and parsed in one check at the end of the suite,
so the whole class of damage fails there rather than in a user's project.

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
   Measured on `uiux_experiment`: **714** `style={{` sites against 1336
   `className="`, carrying **381** static `color`, 176 `background`, 78
   `fontSize`. Every colour is refused, correctly, since an inline declaration
   outranks every class and `text-slate-600` would change the file and nothing
   on screen. **91% are static string literals in an object literal**, the shape
   the byte-span writer already replaces for `className`. The 35 `{expr}` ones
   would be refused by name like `cn()` and `cva()`. The guard is per-property
   and only the colour rows have it: the Size field on an element whose `style`
   sets `fontSize` still writes `text-3xl` and previews nothing. Verified on
   `meridian/design-system/page.tsx:61`.
2. **Blast radius is warned about on removal only.** Editing an element inside
   a shared component changes every instance. Measured: cora 42% of elements,
   polaris 72%, volt **78%**, worst case one location rendering 19 elements.
   Removal counts `[data-thisone-loc^="file:line:col:"]`, ghosts all of them and
   says "renders 19 elements … removes all 19" before you can save. **Class and
   text edits still say nothing**, and the same one-line count belongs there.
   The writer no longer corrupts the file when two instances are edited before
   one save, but a user still has no warning until the save is refused.
3. **Template literals** are 211 sites in gw-web. Only the leading static quasi
   is safely editable, and the delta mechanism from `cn()` does the hard part.
4. **Text from an expression is still not editable, and now says so.** A leaf
   whose text is `{variable}` no longer lets you type: the loader stamps
   `data-thisone-text="expr"` and the row says where the text comes from. Text
   interleaved with markup is editable, one literal run at a time. On Cora
   59.6% of elements were `mixed-content`, most of which this reaches.
5. **Packaging is done.** The tarball is an allowlist: 17 files, 146kB,
   `private: true` gone, `engines` at `>=20.9.0`, MIT, README, repository and
   keywords. Install tested on a fresh `create-next-app` on Next 16.3.3 /
   Tailwind 4.3.3 with `npm i -D` the tarball, `--wire`, `thisone dev`: shim
   resolved by name, overlay served, 30 elements stamped. **There is no `.`
   export and no `main`, which reverses what this list used to ask for.**
   `main: server.js` was decorative because `server.js` calls `app.listen()` at
   module load with no `require.main` guard and exports nothing, so a `.` entry
   would make `require('thisone')` bind a port and return `{}`.
   `ERR_PACKAGE_PATH_NOT_EXPORTED` is the honest answer: the CLI is `bin`, the
   loader is `./loader`, and there is no library to enter.
6. **The hex is still read-only as text.** The picker sets it and the opacity
   field sets its alpha, but there is nowhere to paste `#3f6212` into. gw-web
   has 608 arbitrary colours, so "detached" is the norm there. A drag also
   leaves one preview rule per distinct hex in the dev-only stylesheet, which
   nothing ever collects.
7. **Logical radius utilities are read but never written.** `rounded-s-lg`,
   `rounded-ss-*` and friends depend on writing direction, so they are left as
   authored. Membership matching never mistakes them for a rung, and the Radius
   field appends `+n` and names them in its tooltip so it never shows one radius
   while the element means two. Zero sites across both codebases. The physical
   corners have fields now. The physical edges (`rounded-l-[2px]`) have none,
   but are read into the two corners they paint and cleared by an all-corners
   write.
8. **Per-side strokes are read, cleared and never written.** `border-b-2` and
   `border-b-oat` show the section, are counted by `strokeSet`, and are cleared
   by a box write so the field just used cannot be a no-op on one edge. There
   are no fields for them because frame 7:687 draws none. 7 per-side widths and
   zero per-side colours on `uiux_experiment`, the same shape as the physical
   radius edges.
9. **A rung a route has never used previews at the stock value.** Cora derives
   its ladder from `--radius: 0.75rem`, so `rounded-3xl` should be 26.4px, but
   Tailwind generated no rule for it and the fallback says 24px. The multiplier
   cannot be inferred from the rungs that exist: cora's live/stock ratios run
   1.8, 1.6, 1.5, 1.4, 1.35. Corrects itself on save.

**Astro is blocked, and `detect.js` has to say so, which for a while it did
not.** `supported` was `!!config && tailwind.supported`, so a real Astro project
with a v4 Tailwind reported supported and went down the Next wiring path. It
asked `astro.config.mjs` for `const nextConfig = {`, offered a turbopack block
for a key Astro lacks, printed a React overlay tag for a layout file Astro does
not keep, and left `tools/thisone-loader.cjs` in the repo. Found by running the
published package against `bloomworks-web`. Vite had the same hole for the same
cause, no locator but the turbopack loader, so both now report
`supported: false` with a reason naming the build rather than the config.

**Astro is blocked.** Astro 7 never routes project files through Vite plugins:
instrumented, **1,271 plugin calls, zero for anything under `src/`**. The locator
logic works (10/10 stamped offline). None of Astro's twelve integration hooks is
transform-shaped. `next/astro-locator.mjs` is finished but unreachable.

**React Native / Expo is out.** No DOM, Metro runs no loader, Tailwind v3, and
components are capitalised so "host element" means something else.

---
