# Running a backend

Where the data lives, how to share it with a group, configuration, upgrades and
backups.

## Backend options

| Setup | Use it for |
| --- | --- |
| Local (`dftstream-db`) | one person on one machine; the default |
| Docker on a group server | a group sharing results |
| Convex cloud | a group without a server to run |

The CLI and the UI find the backend through `~/.config/dftstream/config.json`.
Change it with `dftstream config set-url URL`, or per command with
`-tracker-url`.

## Local

```bash
dftstream-db            # start; keep it running
dftstream-db wait       # returns once http://127.0.0.1:3210 answers
dftstream-db doctor     # where the database lives and how fast it commits
```

The local backend listens on `127.0.0.1` only and keeps its database in the
install directory (`~/.local/share/dftstream/db/.convex`). On an NFS home every
write waits for the network, which can make tracking a hundred times slower.
`dftstream-db doctor` shows the numbers, and
`dftstream-db relocate /scratch/$USER/dftstream` moves the database to local
disk. Relocate copies first and keeps the original.

The local backend needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12 and
later). `dftstream-db` runs a Convex backend build that was tested with this
release; set `DFTSTREAM_CONVEX_BACKEND_VERSION=latest` to let Convex choose.
Newer builds need glibc 2.38.

## Docker

On the server:

```bash
cd db
docker compose -f docker/docker-compose.yml up -d
```

The backend listens on port 16767 and keeps its data in the
`dftstream-convex-data` volume. Point every client at it:

```bash
dftstream config set-url http://your-server:16767
```

After pulling a new version, push the updated functions:

```bash
bash db/docker/push-functions.sh http://your-server:16767
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONVEX_PORT` | `16767` | API port |
| `CONVEX_SITE_PORT` | `16768` | HTTP routes port |
| `CONVEX_INSTANCE_NAME` | `dftstream` | deployment name |
| `CONVEX_INSTANCE_SECRET` | generated | instance secret, persisted in the volume |

## Convex cloud

Create a project on convex.dev, then deploy from `db/`:

```bash
cd db && bunx convex deploy
dftstream config set-url https://<deployment>.convex.cloud
```

## Security

Auth is off by default, so anyone who can reach the backend port can read and
change every run. On a laptop that is only you, because the local backend
listens on `127.0.0.1`. A Docker backend on a lab network is shared like a
network folder. Never expose a backend without auth to the internet; to turn
auth on, see [auth.md](auth.md).

## Configuration

| Variable | Purpose |
| --- | --- |
| `DFTSTREAM_ORCA` | path to the ORCA executable |
| `DFTSTREAM_TRACKER_URL` | backend DSN, for example `convex+http://127.0.0.1:3210` |
| `DFTSTREAM_ARTIFACTS` | artifact level: `none`, `io`, `essential`, `medium`, `all` |
| `DFTSTREAM_PROFILE` | `default` or `throughput` |
| `DFTSTREAM_OFFLINE` | `1` to journal locally instead of contacting the backend |
| `DFTSTREAM_SPOOL_DIR` | where offline journals go |
| `DFTSTREAM_CLUSTERS` | cluster file for `dftstream submit` |
| `DFTSTREAM_TOKEN` | machine token for batch jobs ([auth.md](auth.md)) |
| `DFTSTREAM_UI_PORT` | port for `dftstream ui` |
| `DFTSTREAM_TELEMETRY` | `1` to send anonymous usage reports; off by default |
| `DFTSTREAM_TELEMETRY_ENDPOINT` | where those reports go; must be `https://` |

Telemetry sends only run type, ORCA version, error class, DFTStream version and
platform. It never sends molecules, file names or paths, and it stays off
unless both telemetry variables are set.

## Upgrading

Rerun the installer from a fresh clone, or `git pull` in your clone and run it
again. Config and data are kept.

The backend functions ship with the source, so bring the backend up to date
too: restart `dftstream-db` (it pushes functions on start), run
`push-functions.sh` for Docker, or `bunx convex deploy` for Convex cloud.

Each command checks that the binary and the backend match. On a mismatch it
prints one line with the command that fixes it. A backend at API version N
accepts binaries at N and N-1, so the backend can be upgraded before the
cluster nodes.

The parser improves between releases. To bring old runs up to the current
parser:

```bash
dftstream reimport                  # show what would change
dftstream reimport -fix             # apply it
dftstream reimport -experiment X    # only one experiment
```

Reimport rewrites only parser verdicts and measurements (convergence, error
class, thermochemistry, imaginary modes, energies). It never touches notes,
tags, run status or any ORCA file. Running it twice changes nothing the second
time.

### Coming from OrcaStream

DFTStream was called OrcaStream before v1.0.0. Rename `ORCASTREAM_*`
variables to `DFTSTREAM_*` (the CLI warns about any it still sees) and rerun
the installer. Existing runs, offline journals and UI settings carry over. CLI
logins have to be redone.

## Backups

`scripts/backup-restore.sh` snapshots a running backend into one ZIP with every
table and every stored file. No downtime is needed.

```bash
scripts/backup-restore.sh backup ~/backups/                # timestamped snapshot
scripts/backup-restore.sh verify ~/backups/snapshot.zip    # per-table counts
scripts/backup-restore.sh restore ~/backups/snapshot.zip   # replaces ALL data
```

It targets the local backend by default. For a Docker backend, run it on the
server with `--url http://127.0.0.1:16767 --admin-key "$(cat db/docker/state/.admin_key)"`.
The script refuses non-loopback URLs unless you pass `--force`, and restore
asks for confirmation.

## Uninstalling

```bash
bash scripts/install.sh --uninstall           # remove the binaries
bash scripts/install.sh --uninstall --purge   # also config, source and the local database
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `dftstream-db` fails with `GLIBC_2.xx not found` | glibc is older than 2.35: run the backend in Docker or on another machine |
| `dftstream-db wait` times out | read the `dftstream-db` output; on NFS run `dftstream-db doctor`, then `relocate` |
| a command prints a version mismatch | run the command it names |
| the UI loads but shows no data | the backend is not running, or the UI points elsewhere: `dftstream config show` |
| port 3000 is in use | `dftstream ui -port 3001` |
| `orca` starts a screen reader | that is GNOME's `orca`; set `DFTSTREAM_ORCA` to the full path of ORCA |
