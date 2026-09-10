# Contributing to thisone

Thanks for looking. This is a small tool with a lot of reasoning behind it,
and the reasoning is written down. The fastest way in is to read before you
change.

## Read first

- `CLAUDE.md`: the short rules, the commands, and the traps. Written for
  Claude Code, but it is the contract for humans too.
- `docs/DECISIONS.md`: why each non-obvious thing is the way it is, with the
  number behind it. About to change something that looks arbitrary? Search
  this file for it first.
- `docs/TESTING.md`: which suite owns which behaviour.
- `docs/RELEASE.md`: commits, changelog, versions.

## Setup

```bash
git clone https://github.com/thebuddyman/bw-pl-browsereditor.git thisone
cd thisone
npm ci
npx playwright install chromium
npm test            # 13 suites, about 85 seconds, offline
```

To try it on a real Next app, clone one next to this checkout and point the
CLI at it: `node cli.js --root ../your-app --check`. The live suites assume
`../uiux_experiment`. The offline suite needs nothing outside the repo.

## Making a change

1. Find the decision. If `docs/DECISIONS.md` has an entry for the behaviour,
   your change either follows it or measures again and updates the entry.
2. Add a check to the suite that owns the behaviour. A change with no check is
   one nobody can defend later.
3. Run `npm test`, one run at a time. Free port 3131 first if a previous run
   left it held.
4. If it is user-facing, add a line under `[Unreleased]` in `CHANGELOG.md`.
5. Commit with a Conventional Commits subject (`feat:`, `fix:`, `docs:`,
   `refactor:`, `test:`, `chore:`), the why in the body, and the suite count on
   its own line. `docs/RELEASE.md` has the full rules.

## What will not be merged

- Anything that reprints an AST. Writes replace a byte span.
- A class family matched by prefix (`/^text-/`, `/^font-/`, `/^border-/`).
- A redrawn icon. Icons come from `assets/` and are inlined byte for byte.
- A panel colour, size or radius that is not from the Figma frame.
- A guess where a refusal with a reason belongs.
- A fixed wait for HMR, or a colour compared as a string.

## Reporting a bug

Say the framework and versions (`npx thisone --root . --check` prints them),
what you clicked, what the panel said, and what reached disk. If a save wrote
something wrong, the diff of the file is the most useful thing to paste.

## Security

The editor writes to source files on the machine it runs on. It binds to
127.0.0.1 only, uses a fresh token every run, and checks the origin of every
write. If you find a way around any of that, open a private security advisory
on GitHub rather than a public issue.
