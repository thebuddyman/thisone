# Changelog

User-facing changes only, in present-tense product prose from the user's side.
Categories are Added / Changed / Fixed / Removed. Refactors, dependencies,
tests and docs do not appear here. New entries go under `[Unreleased]` in the
same commit as the change; `release X.Y.Z` rolls them into a dated section.
The full rules are in `docs/RELEASE.md`.

## [Unreleased]

## [0.3.0] - 2026-09-16

### Added
- `thisone --check --json` prints what it found as one JSON object, with a
  `status` of `ready`, `needs-wiring` or `refused` and the command to run next,
  so a script or a coding agent can set the tool up without reading the prose.
  `--json` only reports. It never wires or starts anything.

### Changed
- A project that can be edited once you take one more step now exits with 2
  instead of 1. That covers `--check` or a plain run on an unwired project, and
  `--wire` when it prints a snippet for you to paste. A project that cannot be
  edited at all still exits with 1, so the two are no longer the same answer.

## [0.2.0] - 2026-09-10

### Changed
- Changing a class on an element that appears several times on the page now
  updates every one of them straight away, instead of moving the one you
  clicked and leaving the rest until after the save. They come from one line of
  source, so they were always going to change together. It still counts as one
  pending change, and undo takes it off all of them.

### Fixed
- Editing two elements that come from the same line of source and saving once
  no longer corrupts the file. It used to write both edits over the same bytes,
  which cut the closing quote off the class list and left the project unable to
  build. Both edits asking for the same value now write it once, and two edits
  asking for different values are refused with a reason, because one line
  cannot hold two answers.

## [0.1.1] - 2026-08-28 (never published to npm)

### Changed
- Astro and Vite projects are refused with a reason naming the build, instead
  of being wired as though they were Next.js and leaving a loader shim behind.

  This version was tagged in the source but never reached npm, so the change
  above first ships to users in 0.2.0.

## [0.1.0] - 2026-08-28

First release, as `@designbuddy/thisone`. The command is `thisone`.

### Added
- Edit mode for a running Next.js (App Router, Turbopack, Tailwind v4) app:
  click an element, change padding, margin, gap, radius, stroke, text and
  background colour, font family, weight, size and alignment, or its text, and
  Save writes the class or the literal into the `.tsx` it came from.
- Removal: the × marks an element and every other instance of its source
  location, counts them, and Save cuts the lines whole.
- Undo and redo before Save; undo stops at a save.
- `thisone --wire` / `--unwire` add and remove the Turbopack rule, the overlay
  tag and the loader shim, byte-exact, with backups in `.thisone/backups/`.
- `thisone dev` starts the app and the editor together and keeps their ports
  in step.
- A Prompt tab, behind `--prompt`, that hands the selected element to
  `claude -p`.
- A standalone HTML mode for a flat `index.html`.

[Unreleased]: https://github.com/thebuddyman/thisone/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/thebuddyman/thisone/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/thebuddyman/thisone/compare/v0.1.0...v0.2.0
[0.1.1]: https://github.com/thebuddyman/thisone/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/thebuddyman/thisone/releases/tag/v0.1.0
