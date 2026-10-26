# CLI reference

Every subcommand prints its flags with `-help`, for example
`dftstream run -help`.

## Commands

| Command | Purpose |
| --- | --- |
| `dftstream run job.inp` | Run ORCA and track it |
| `dftstream import-experiments DIR` | Import existing outputs from `DIR/<experiment>/<run>/` |
| `dftstream list` | List experiments |
| `dftstream ui` | Serve the web UI on http://127.0.0.1:3000 |
| `dftstream lint job.inp` | Check an input before you queue it |
| `dftstream restart run.out` | Diagnose a failed run and write a corrected input |
| `dftstream next KIND run.out` | Write the next step of the TS workflow |
| `dftstream submit job.inp` | Write and submit SLURM scripts ([clusters.md](clusters.md)) |
| `dftstream queue status` | Show and cancel submitted SLURM jobs ([clusters.md](clusters.md)) |
| `dftstream sync` | Upload journals written on offline compute nodes ([clusters.md](clusters.md)) |
| `dftstream reimport` | Re-parse stored outputs after an upgrade ([operations.md](operations.md#upgrading)) |
| `dftstream import-cubes RUN file.cube` | Attach cube files to a run |
| `dftstream config show` | Print the active configuration |
| `dftstream config set-url URL` | Point the CLI and UI at a backend |
| `dftstream login` / `logout` | Sign in when the backend has auth enabled ([auth.md](auth.md)) |
| `dftstream version` | Print the version |

## run

```bash
dftstream run [flags] job.inp [-- extra ORCA arguments]
```

ORCA's output goes to your terminal or the file you redirect to, unchanged.

| Flag | Default | Purpose |
| --- | --- | --- |
| `-orca PATH` | `$DFTSTREAM_ORCA` | ORCA executable. Required if the variable is unset. |
| `-exp NAME` | the input's directory name | Experiment. Created if missing. |
| `-name NAME` | the input's file name | Run name. |
| `-artifacts LEVEL` | `medium` | Which files to store, see below. |
| `-orbitals MODE` | `final` | Orbital cubes to render: `none`, `final`, `per-cycle`. |
| `-profile NAME` | `default` | `throughput` limits what each run writes, for large batches. |
| `-batch NAME` | none | Attach the run to a batch and use the throughput profile. |
| `-sysinterval DURATION` | `5s` | CPU and memory sampling interval, or `off`. |
| `-offline` | off | Write a local journal instead of contacting the backend. |
| `-lint on\|off` | `on` | Pre-flight input checks. They only warn. |
| `-tracker-url DSN` | config file, then `convex+http://127.0.0.1:3210` | Backend to write to. |
| `-org SLUG` | your default org | Organization, when auth is on. |
| `-log-level LEVEL` | `warn` | Wrapper logging: `debug`, `info`, `warn`, `error`, `off`. |

Backend DSNs are `convex+http://host:port`, `convex+https://host`, or
`noop://` to discard everything (useful for testing).

### Artifact levels

Files are collected when the run ends. Binary files such as `.gbw` and anything
over 50 MB are never stored.

| Level | Stores |
| --- | --- |
| `none` | nothing |
| `io` | input, `.out`, captured stdout |
| `essential` | `io` plus `.xyz`, `.allxyz`, trajectories |
| `medium` | `essential` plus property files, `.bibtex`, logs |
| `all` | `medium` plus every other text output ORCA writes |

## restart

`dftstream restart run.out` writes `run_restart.inp` next to the output. The
original files are only read.

| Failure | What the restart input does |
| --- | --- |
| SCF not converged | `SlowConv` and `%scf MaxIter 500`; a second restart escalates to `VerySlowConv` with level shift or damping |
| Max opt cycles | `Opt Freq` from the last geometry, reading the old `.gbw` when present |
| Out of memory | `%maxcore` raised to 75% of RAM per process, or a refusal if RAM is the limit |
| Unstable wavefunction | unrestricted reference with SCF stability analysis |
| Imaginary modes on a minimum | geometry displaced along the mode, reoptimized |
| Frequencies failed after a converged optimization | `Freq` only |
| NEB-TS that reached its TS phase | `OptTS Freq` with an exact initial Hessian |
| Disk, scratch or external tool failure | rerun as is (exit code 4) |
| Impossible charge/multiplicity, missing basis, input error, exploded geometry | no input; the diagnosis and the manual fix are printed (exit code 3) |

`-dry-run` shows the change as a diff without writing. Every generated input
passes `dftstream lint`.

## next

| Command | Writes |
| --- | --- |
| `next neb-ts reactant.out product.out` | NEB-TS input between two optimized minima |
| `next irc ts.out` | IRC from a TS with exactly one imaginary mode, reusing its `.hess` |
| `next opt-endpoints irc.out` | `Opt Freq` inputs for both IRC endpoints |
| `next sp run.out -method "! ..."` | single point on the final geometry |

Set `spMethod` in the config file to give `next sp` a default method.

## ui

| Flag | Purpose |
| --- | --- |
| `-port N` / `-addr HOST:PORT` | where to listen (default `127.0.0.1:3000`) |
| `-convex-url URL` | backend the browser talks to |
| `-auth-provider convex\|clerk` | sign-in screen, when auth is on ([auth.md](auth.md)) |
