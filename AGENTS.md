# Notes for coding agents

Installing DFTStream for a user rather than developing it? Follow
[docs/setup-with-agent.md](docs/setup-with-agent.md) instead.

DFTStream exists to make ORCA calculations easier to follow, inspect, compare
and share. Judge a change by whether a chemist's next step becomes obvious, fast
and trustworthy. Nobody should have to reload a page, fight stale data or find a
hidden setting to get work done. Architecture, setup and checks are in
[docs/development.md](docs/development.md).

## Never modify ORCA's files

A chemist's `.gbw`, `.hess`, `.out` and `.xyz` must come out of a `dftstream
run` byte-for-byte identical to a plain `orca input.inp` run. They are
scientific data.

- Run ORCA from the input's directory (`cmd.Dir`) and pass the basename, like
  `cd dir && orca x.inp`. ORCA writes its working directory into the `.gbw`, so
  it must never inherit a stray cwd.
- Tools such as `orca_plot` and `orca_pltvib` re-save what they open. Copy the
  inputs to a temp scratch dir, run the tool there and copy back only the
  derived outputs.
- Snapshots and scratch go to a temp dir, never the user's directory.
- When in doubt, treat every ORCA file as read-only. Creating new files is fine.

## Never drop an error silently

This is the most important code rule here.

Go:

- Never write `val, _ := f()`. Check every error.
- An error that truly cannot be acted on (`fmt.Fprintf` to stderr,
  `http.ResponseWriter.Write`) gets
  `//nolint:errcheck — <why it is best-effort>`.
- For `strconv` parses of regex captures, use the `parseInt` / `parseFloat`
  helpers in `parser.go`, which return `(value, ok)`, and skip the row on
  `!ok`.
- `json.Marshal` on user data can fail (NaN, Inf). Check it.
- Check `io.ReadAll` before using the buffer, and log failures of `os.Remove`
  and `filepath.Glob`.
- Deferred `Close()` on writers checks the error. A deferred tracker `Close`
  gets a fresh timeout context, never a signal-cancelled one.

TypeScript:

- Handle the rejection of every promise. No fire-and-forget mutations or
  fetches.
- Every `catch {}` and `.catch(() => {})` carries a comment saying why
  swallowing is safe.
- Convex mutations in UI event handlers surface failures to the user (toast,
  error state or `console.error`).
- Wrap `localStorage`, `new Notification()` and other throwing browser APIs in
  try/catch. Handle both outcomes of `Notification.requestPermission()`.

In general, return errors rather than log and continue, and give every
deliberate swallow a one-line comment.

## Code

- Use classes, interfaces and enums for configuration and variants, not loose
  strings. Configuration files are YAML with typed models.
- Keep files small and do not repeat yourself.
- One-off scripts go in `.ai_scripts/`. Retired files go in `.old/`, which is
  not committed.
- Test on the local backend on port 3210. Never test against a shared or
  production deployment.
- Never delete `node_modules`, `db/.convex`, build state or `.env` files to
  simulate a clean checkout. Use a temp dir or a worktree.
