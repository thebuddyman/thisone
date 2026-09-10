# Commit, changelog, version, publish

You say a short phrase, and the agent follows the matching contract below. The
human never types git commands and the agent never improvises. Every step here
is one that is actually done. If a step stops being done, delete it from here
too, because a dead step makes the whole document less trusted.

## Prompts

| You say | What happens |
| --- | --- |
| `commit` | The commit contract below |
| `commit, closes #42` | Same, with a `Closes #42` trailer |
| `commit as fix:` | Same, with the type forced |
| `split commit` | Propose a split across commits first, then wait |
| `release X.Y.Z` | The release steps below |
| `what would vX.Y.Z contain?` | Dry run: read `[Unreleased]` and report, change nothing |

## The commit contract

When told to commit:

1. Run `git status`, `git diff`, and read the last ten subjects in `git log`.
   Know what changed and the voice in use.
2. **Mixed work?**
   - Cleanly separable files: propose a split and wait for OK.
   - Tangled, with one main change: one commit, named for the main change.
   - **Don't split** for side-fixes under about five lines, rename fallout,
     lockfile churn, or when a split commit would have a red suite.
3. Run `npm test` if any runtime or test file changed. Free port 3131 first
   (`lsof -ti tcp:3131 | xargs -r kill -9`) and confirm it is free. Never
   report a red suite as green. Say what failed.
4. If the change is user-facing, add a line under `[Unreleased]` in
   `CHANGELOG.md`. Stage it in the same commit.
5. If the change rests on a measurement, or overturns an entry in
   `docs/DECISIONS.md`, write it there in the same commit.
6. **Stage by path.** Never `git add -A`. The tree may hold unrelated work and
   the user's own untracked files.
7. **Subject:** Conventional Commits. Pick the dominant type by this order:
   `feat` > `fix` > `perf` > `refactor` > `chore` > `docs` > `test`. No scope.
   Lowercase after the colon, present tense, no trailing period, under 72
   characters. Say what changed, not what file moved: "fix: tell a taken port
   from a dev server that owns the directory". Commits before 2026-09-10 are
   plain sentences; do not rewrite them.
8. **Body:** why, what was measured, what was tried and rejected, and the suite
   count on its own line ("13/13 suites, 48 checks in 06-detect"). Wrap at 72.
   Skip the body only when the subject really is the whole story.
9. Add `Closes #N` or `Refs #N` only when the user gives a number.
10. End with the `Co-Authored-By: Claude …` footer.
11. Don't push unless asked. After a push, say whether the accumulated changes
    look like a PATCH, MINOR, MAJOR, or "keep accumulating".

## Changelog rules

- **User-facing changes only.** Yes: new controls, behaviour changes, visible
  fixes, CLI flags, changed refusals, panel text. No: refactors, dependency
  bumps, test-only changes, docs, internal renames.
- Categories: Added, Changed, Fixed, Removed.
- **Present tense, from the user's side.** "Astro and Vite projects are refused
  with a reason naming the build", not "detect.js returns supported:false".
- A commit can add zero, one or several entries. Not sure if something is
  user-facing? Ask.
- The rules also sit at the top of `CHANGELOG.md`, so whoever edits it sees
  them.

## Versioning

Semantic versioning. One number, in `package.json` only. While the major is
`0`, a MINOR may break things and a PATCH may not.

| Bump | When |
| --- | --- |
| PATCH | A fix, a clearer refusal, a corrected preview. A wired project changes nothing. |
| MINOR | A new control, flag, or supported shape. Anything that changes what `--wire` writes. |
| MAJOR | The `data-thisone-*` attributes, the loader's export path, or the wire markers change shape. |

Never edit the version field by hand. `npm version` writes it, commits it, and
tags it. That is the only reason the tag exists.

## Release steps (`release X.Y.Z`)

1. `git status` clean, on `main`, suite green within the last hour.
2. Move `[Unreleased]` into a dated `[X.Y.Z]` section in `CHANGELOG.md`.
   Commit that alone: "Changelog for X.Y.Z".
3. `npm version X.Y.Z`. This bumps, commits `X.Y.Z`, and tags `vX.Y.Z`.
4. `npm pack --dry-run` and read the file list. It must be the `files`
   allowlist plus README and LICENSE, nothing else. A missing runtime file
   shows up here and nowhere earlier.
5. `npm publish --access public`. `prepublishOnly` runs the suite. A red run
   stops the publish.
6. `git push && git push --tags`.
7. Confirm with `npm view @designbuddy/thisone version`.

Tags mark releases and nothing else. Don't tag a version that was not
published. If a publish fails after `npm version`, fix forward with another
PATCH rather than moving the tag.

## When things go wrong

| Symptom | Do |
| --- | --- |
| A published version is broken | `npm deprecate @designbuddy/thisone@X.Y.Z "reason"`, then publish a PATCH. Never `unpublish` after the 72-hour window. |
| Which commit changed a panel behaviour? | `git log -S'<text from the panel>' -- editor.js` |
| Which commit added a decision? | `git log -S'<first words of the entry>' -- docs/DECISIONS.md CLAUDE.md` (entries lived in `CLAUDE.md` before 2026-09-10) |

Add a row whenever a debugging session touches git history.
