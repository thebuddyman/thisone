# thisone

A visual editor for Tailwind in the browser. Click an element on your running app,
change its classes or text, hit Save — the change goes into the source file it came from.

⚠️ **It writes to your source files.** Use it on a repo with a clean git status so you
can see exactly what it changed. Every save is a one-line diff; nothing else moves.

## What it does

- Turn on edit mode, click any element on the page
- Change padding, margin, gap, radius, border, colors, font, size, weight, alignment
- Edit the text
- Delete an element
- Save writes it into the `.tsx` (or `.html`) it came from — the real class, on the real line
- Undo/redo before you save; nothing hits disk until you press Save

## What it runs on today

- Next.js with Turbopack + Tailwind v4, App Router
- Node 20.9+
- Runs against your dev server, locally only. Not for production.

That list is what's supported so far, not what the tool is. The editing model —
point at a rendered element, resolve it back to the source that produced it, replace
a byte span — isn't specific to Next or to Tailwind, and other frameworks are the
direction of travel. Astro is the one that's been tried and doesn't work: it never
routes project files through Vite plugins, so there's nothing to hook.

## Install

```bash
npm i -D @designbuddy/thisone
```

The package is scoped; the command is not. You install
`@designbuddy/thisone` and you run `thisone`.

## Use

```bash
npx thisone --root . --check   # look at the project, change nothing
npx thisone --root . --wire    # add the editor to your project (one time)
npx thisone dev                # start your app + the editor together
```

Open your app, press **Edit mode** bottom right, click something.

Already running your own `next dev`? Run `npx thisone --root .` beside it instead of
`thisone dev` — but then you have to match the ports yourself (see below).

## What `--wire` changes in your repo

Three things, all reversible:

- `next.config.ts` — adds a Turbopack rule so your JSX gets tagged with its source location (dev only)
- `src/app/layout.tsx` — adds a script tag that loads the editor overlay (dev only)
- `tools/thisone-loader.cjs` — new file, 3 lines, requires the loader by package name

Originals are copied to `.thisone/backups/` first (gitignored, inside your project).

```bash
npx thisone --root . --unwire   # takes all three back out, byte-exact
```

## Ports

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

- **Editing a shared component changes every instance of it.** Delete warns you and
  counts them; class and text edits currently don't.
- Colors set with `style={{ }}` are read but can't be edited — an inline style beats
  any class, so writing one would do nothing.
- Text that comes from a variable (`{name}`) can't be edited. The panel says so.
- `cn()` is handled. `cva()` and template literals are refused, with a reason.
- Server binds 127.0.0.1 only, fresh random token every run, origin-checked.
