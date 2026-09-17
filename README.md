# thisone

A visual editor for Tailwind in the browser. Click an element on your running
page, change its classes or text, hit Save. The change goes into the source
file it came from.

**[Try it in the playground →](https://playground.thomasbudiman.com/thisone/)**
It runs the real editor on a sample page, in your browser. Nothing to install,
and nothing is written anywhere.

⚠️ **On your own project it writes to your source files.** Use it on a repo with
a clean git status so you can see exactly what it changed. Every save is a
one-line diff; nothing else moves.

## What it does

- Turn on edit mode, click any element on the page
- Change padding, margin, gap, radius, border, colors, font, size, weight, alignment
- Edit the text
- Delete an element
- Save writes it into the `.tsx` or `.html` it came from: the real class, on the real line
- Undo/redo before you save; nothing hits disk until you press Save

## What it runs on today

| your project | works? | how to start |
|---|---|---|
| Next.js, App Router, Turbopack, Tailwind v4 | yes | [Next.js](#nextjs) below |
| A folder of plain `.html` files styled with Tailwind | yes | [Plain HTML](#plain-html) below |
| Astro, Vite, React Native | not yet | it tells you why and changes nothing |

Node 20.9 or newer. It runs on your machine against your own files. It is not
something you deploy.

The editing model (point at a rendered element, resolve it back to the source
that produced it, replace a byte span) isn't specific to Next or to Tailwind,
and other frameworks are the direction of travel. Astro is the one that's been
tried and doesn't work: it never routes project files through Vite plugins, so
there's nothing to hook.

Not sure which one you have? Ask it. This changes nothing:

```bash
npx @designbuddy/thisone --root . --check
```

## Plain HTML

Nothing to install and nothing to wire. From the folder that holds your
`index.html`:

```bash
npx @designbuddy/thisone --root .
```

Open the address it prints (`thisone -> http://localhost:3000`), press
**Edit mode** bottom right, click something, Save. The change is now in your
`.html` file. Stop it with Ctrl+C. It leaves nothing behind in your folder.

- Every `.html` page in the folder can be edited, and the stylesheets, images
  and fonts beside them are served too.
- **Tailwind from a `<script>` tag** (`cdn.tailwindcss.com` or
  `@tailwindcss/browser`), which is what most AI-generated pages use: nothing
  else to do.
- **Tailwind from the CLI** (you have an input `.css` and a built one): a new
  class shows up straight away and after a reload. Your built `.css` file is not
  touched, so run your build before you deploy, as you would after editing by
  hand.
- If 3000 is taken it uses the next free port and prints that instead.
  `--port 4000` picks where it starts.
- A folder that a build writes into (`_site/`, `dist/`, `build/`, `out/`) is
  refused, because your next build would overwrite the saves. Point `--root` at
  the source.
- Something a script on the page creates has no line in the file. Clicking it
  selects the nearest element that does.

## Next.js

```bash
npm i -D @designbuddy/thisone
npx thisone --root . --wire    # add the editor to your project (one time)
npx thisone dev                # start your app + the editor together
```

Open your app, press **Edit mode** bottom right, click something.

The package is scoped; the command is not. You install `@designbuddy/thisone`,
and once it is installed you run `thisone`.

## Set it up with a coding agent

Paste one of these into Claude Code, Cursor or any agent working in your repo:

> Set up thisone in this project and start it.

> Check whether thisone supports this project, and tell me why if it doesn't.

> Remove thisone from this project.

**For the agent.** Use the CLI and nothing else. Don't edit config or layout
files yourself: `--wire` writes marked blocks that `--unwire` finds again, and it
clears a Turbopack cache that would otherwise break every page. Always call it
by its scoped name, `npx @designbuddy/thisone`. A bare `npx thisone` only
works where the package is already installed, and a folder of `.html` files has
nothing installed.

1. Run `npx @designbuddy/thisone --root . --check --json`. It changes nothing.
2. Read `status` and the exit code:
   - `ready` (exit 0): run `command` as it is printed. It keeps running, so
     start it in the background, read the line `thisone -> http://localhost:…`
     from its output (or, for a Next app, the app's own URL), and give the user
     that address. Tell them to press **Edit mode**, bottom right.
   - `needs-wiring` (exit 2): run `command`, then check again. If it exits 2
     again, it printed a snippet the user has to place. Show it to them, don't
     place it yourself.
   - `refused` (exit 1): tell the user `reason` word for word and stop. Don't
     retry as a different framework, don't point `--root` somewhere else on
     your own, and don't wire by hand.
3. `framework` tells you which kind of project this is:
   - `next`: install first with `npm i -D @designbuddy/thisone`, so the wiring
     resolves by name and is safe to commit.
   - `html`: install nothing and wire nothing. The folder is served as it is,
     and saves go into the `.html` files. Don't add a `package.json` to it.
4. To remove it, run `npx @designbuddy/thisone --root . --unwire`. If it names a
   file it left in place, pass that on. For `html` there is nothing to remove:
   stop the command and say so.

Already running your own `next dev`? Run `npx thisone --root .` beside it instead of
`thisone dev` — but then you have to match the ports yourself (see below).

## What `--wire` changes in your repo (Next.js)

Three things, all reversible. Plain HTML has no wiring at all.

- `next.config.ts` — adds a Turbopack rule so your JSX gets tagged with its source location (dev only)
- `src/app/layout.tsx` — adds a script tag that loads the editor overlay (dev only)
- `tools/thisone-loader.cjs` — new file, 3 lines, requires the loader by package name

Originals are copied to `.thisone/backups/` first (gitignored, inside your project).

```bash
npx thisone --root . --unwire   # takes all three back out, byte-exact
```

## Ports (Next.js)

- App on 3000, editor on 3500 by default
- `thisone dev` picks both and keeps them in sync — nothing to type
- Running them separately on a non-default editor port? Your app needs to know:
  ```bash
  npx thisone --root . --port 3600
  NEXT_PUBLIC_THISONE_PORT=3600 npx next dev
  ```
  Without the env var the overlay just won't show up.

## Prompt tab (optional)

`npx thisone --root . --prompt` adds a tab that hands the selected element to Claude
Code — "make this a card", that kind of thing. Off by default: it spawns `claude -p`
and its writes go straight to disk. Without the flag the tab isn't even drawn.

## Things to know

- **Editing a shared component changes every instance of it.** A class change now
  shows that straight away: change one card's padding and every card drawn from
  that line moves with it, as one pending change. Delete warns you and counts
  them. Text edits still move only the one you clicked until you save.
- Colors set with `style={{ }}` are read but can't be edited — an inline style beats
  any class, so writing one would do nothing.
- Text that comes from a variable (`{name}`) can't be edited. The panel says so.
- `cn()` is handled. `cva()` and template literals are refused, with a reason.
- Both servers answer on 127.0.0.1 only. Under Next the editor server also takes a
  fresh random token every run and checks the origin.

## Changelog

Every released change is in [CHANGELOG.md](CHANGELOG.md), and each release is
listed at [Releases](https://github.com/thebuddyman/thisone/releases).
