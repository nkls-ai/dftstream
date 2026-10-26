# site

The project website: landing page, docs, changelog and privacy page. It is a
static Next.js export, so `bun run build` writes a plain directory (`out/`)
that any static host can serve.

```bash
bun install
bun run dev      # http://localhost:4000
bun run build    # writes out/
```

The docs pages render the repository's `docs/*.md` and the changelog page
renders `CHANGELOG.md`, so neither is duplicated here. To add a doc page, add
the file to `docs/` and an entry to `DOC_NAV` in `lib/nav.ts`; the build fails
if the two disagree.

Colors come from the app's design tokens in `app/globals.css`. Screenshots in
`public/shots/` are real captures (`.ai_scripts/site-capture/`).
