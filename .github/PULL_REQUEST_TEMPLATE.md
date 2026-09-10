## What changed

<!-- One paragraph. What a user of the tool sees differently, or, for internal work, what is now true that was not. -->

## Why

<!-- The measurement or the failure that prompted it. If this overturns an entry in docs/DECISIONS.md, name the entry and say what was re-measured. -->

## Checks

- [ ] `npm test` is green, and the count is in the commit body
- [ ] The check that would catch a regression is in the suite that owns the seam (`docs/TESTING.md`)
- [ ] `CHANGELOG.md` has a line under `[Unreleased]` if this is user-facing
- [ ] `docs/DECISIONS.md` is updated if a decision was taken or overturned
- [ ] If it touches `--wire`, the shim, or the loader: tested against a real install (`npm pack`, then `npm i -D` the tarball in a fresh app)
