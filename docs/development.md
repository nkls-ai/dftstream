# Development

## Layout

| Path | Contents |
| --- | --- |
| `wrapper/` | Go binary: CLI, ORCA runner, output parser, backend clients. Embeds the built UI. |
| `db/` | Convex backend: schema, queries, mutations, HTTP routes |
| `ui/` | React UI, built with Bun |
| `site/` | project website (Next.js, static export); renders `docs/` and `CHANGELOG.md` |
| `presets/` | method, job and solvent presets for the input builder (YAML) |
| `scripts/` | installer, `dftstream-db`, backup, end-to-end test, release checklist |
| `packaging/` | Docker image, Lmod module, conda recipe |
| `tests/install/` | installer tests |
| `.ai_scripts/` | one-off tooling (seeding, screenshots, load tests); not shipped |

## How it fits together

`dftstream run` starts ORCA, passes its output through to the terminal
unchanged, parses the same stream, and writes runs, events, metrics, geometries,
frequencies and files to the backend in batches. The UI subscribes to Convex
queries, so it updates as data arrives.

Boundaries to keep:

- The Go runner and parser never talk to Convex directly. They go through the
  tracker interfaces in `wrapper/internal/tracker`.
- UI components read data through `DataSource` (`ui/src/data`), never through
  Convex imports.
- TypeScript uses the generated API in `db/convex/_generated`. Go uses the
  Convex HTTP API.
- High-volume data (events, metrics, geometries, samples) lives in its own
  tables, so a run document is not rewritten on every parser event.

## Setup

You need Go 1.26+ and Bun.

```bash
(cd db && bun install) && (cd ui && bun install)
bash scripts/dftstream-db.sh                         # local backend on :3210
(cd ui && BUN_PUBLIC_CONVEX_URL=http://127.0.0.1:3210 bun --hot src/index.ts)   # UI on :3000
(cd wrapper && make build)                           # wrapper/bin/dftstream with the UI embedded
```

`make build` builds the UI first. A plain `go build` fails until the UI bundle
exists.

## Checks

```bash
(cd wrapper && gofmt -l . && go vet ./... && go test ./...)
(cd ui && bunx tsc --noEmit && bun test && bun run build)
(cd db && bunx tsc --noEmit -p convex && bunx vitest run)   # vitest, not bun test
(cd site && bun run build)
DFTSTREAM_ORCA=/path/to/orca scripts/e2e.sh                # end to end with real ORCA
tests/install/run.sh                                        # installer, in Docker
```

CI sets `DFTSTREAM_REQUIRE_CORPUS=1`, which makes the parser tests fail rather
than skip when a corpus fixture is missing. The corpus of real ORCA 5 and 6
outputs lives in `wrapper/internal/parser/testdata/corpus/`.

Test against the local backend on port 3210, never against a shared or
production deployment.

## Rules

- ORCA's files are read-only. Run ORCA from the input's directory, and run
  tools like `orca_plot` only on copies in a scratch directory.
- Tracking must never block or change a calculation. A backend failure is
  reported, and ORCA keeps running.
- Never drop an error silently. In Go, check every error; in TypeScript, handle
  every rejected promise and give every `catch {}` a comment saying why it is
  safe. The details are in [AGENTS.md](../AGENTS.md).
- Parsers ignore unknown lines and reset on malformed sections instead of
  panicking. Add a test for every new parsed quantity.
- Configuration uses typed structs, enums and YAML, not loose strings.

## UI conventions

- Sequences of structures (optimization cycles, scan points, NEB images,
  conformers) use `usePlayback` and `PlaybackBar`, with keyboard control.
- Energy charts sit next to their structure viewer (`struct-energy-split`), and
  clicking a point on the chart selects that structure.
- Colors come from CSS variables, never literals. The light theme only
  overrides variables.
- Loading states use skeletons, not "Loading…" text.
- Long explanations go behind an `InfoTip`, not on the page.
- Reuse `Section`, `Headline`, `StatGrid`, `EnergyChart` and `StructureViewer`
  before writing a new layout.

## Releasing

1. Move the `Unreleased` notes in `CHANGELOG.md` under `## vX.Y.Z (date)`.
2. Tag: `git tag -a vX.Y.Z -m "DFTStream vX.Y.Z"`.
3. Run `scripts/release-checklist.sh` on the tagged commit. It checks the
   changelog, builds with the version stamped and runs the Go tests.
4. Push the tag. `.github/workflows/release.yml` runs GoReleaser, which builds
   Linux, macOS and Windows binaries (Windows untested) with `checksums.txt`.
   `install.sh` verifies downloads against it.

Packaging that still needs setting up:

- Homebrew: create the public tap repo `nkls-ai/homebrew-dftstream` and add a
  `HOMEBREW_TAP_GITHUB_TOKEN` secret. Until then the cask is skipped.
- Docker: the image in `packaging/docker/` is built on release but not pushed.
  To publish, set `skip_push: "false"` in `.goreleaser.yaml` and give the
  workflow `packages: write`. ORCA is not in the image.
- conda-forge: `packaging/conda/meta.yaml` is a draft. It needs a source
  tarball that includes the prebuilt UI, because conda-forge has no Bun.
- Lmod: `packaging/lmod/dftstream.lua` is an example for cluster admins to copy.
