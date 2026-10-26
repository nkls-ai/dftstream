# Setup instructions for coding agents

You are a coding agent (Claude Code, Codex, Cursor or similar), and the user
asked you to install DFTStream. Work through these steps in order from the root
of this repository. Run the commands yourself, and ask the user only where a
step says **Ask**. Finish with the report in step 8.

Rules:

- Never modify ORCA's files (`.inp`, `.out`, `.gbw`, `.hess`, `.xyz`) and never
  work inside the user's calculation directories. Test data goes in a temporary
  directory.
- No root and no `sudo`. Everything installs into the user's home.
- Use only the local backend at `http://127.0.0.1:3210`, unless the user gives
  you the URL of a shared one.
- Leave auth off. Do not set `DFTSTREAM_AUTH_REQUIRED`.
- Start long-running processes (`dftstream-db`, `dftstream ui`) in the
  background. Never block on them.

## 1. Check the machine

```bash
uname -sm                  # Linux or macOS
ldd --version | head -1    # Linux: the local backend needs glibc 2.35+
git --version
go version                 # needs go1.26 or newer
bun --version              # optional; the installer can install it
command -v sbatch          # present on a SLURM cluster, see step 7
```

- Go missing or older than 1.26: **Ask** before installing. Without root,
  unpack the tarball from https://go.dev/dl/ into `~/.local/go` and add
  `~/.local/go/bin` to `PATH`.
- Bun missing: **Ask** whether the installer may fetch it (`--install-bun`).
- glibc older than 2.35: the local backend will not start. Tell the user they
  need a shared backend ([operations.md](operations.md)) and continue; the
  rest still installs.

## 2. Find ORCA

DFTStream does not include ORCA. Look for an existing installation:

```bash
command -v orca
ls -d /opt/orca* ~/orca* ~/opt/orca* /usr/local/orca* 2>/dev/null
module avail orca 2>&1 | head
```

A real ORCA directory contains helper programs such as `orca_scf`. If `orca`
has none next to it, it is probably the GNOME screen reader of the same name.

```bash
ls "$(dirname "$(readlink -f /path/to/orca)")/orca_scf"
```

**Ask** the user to confirm the path, or where ORCA is if you found none. If
ORCA is not installed, continue: everything except the test calculation works
without it.

## 3. Install

```bash
bash scripts/install.sh --method source --mode local \
  --repo "$PWD" --ref "$(git rev-parse --abbrev-ref HEAD)" \
  --install-bun     # or --no-install-bun if the user declined
export PATH="$HOME/.local/bin:$PATH"
dftstream version
```

This builds the UI and the binary and installs `dftstream` and `dftstream-db`
into `~/.local/bin`. The backend runs from a copy of the repository in
`~/.local/share/dftstream`. On a cluster, add `--source DIR` on scratch or
local disk instead of an NFS home.

If `~/.local/bin` is not on `PATH` in new shells, **ask** before adding the
`export` line to `~/.bashrc` or `~/.zshrc`.

## 4. Start the backend

```bash
dftstream-db            # in the background
dftstream-db wait
dftstream-db doctor
```

If `doctor` reports a network filesystem, writes will be slow. **Ask** before
running `dftstream-db relocate <dir on local disk>`. It copies the database and
keeps the original.

## 5. Point DFTStream at ORCA and test it

```bash
export DFTSTREAM_ORCA=/path/to/orca   # **Ask** before adding this to the shell profile
tmp="$(mktemp -d)"
mkdir -p "$tmp/setup-check/water-sp"
cp example_logs/water_hf_def2svp_sp.inp example_logs/water_hf_def2svp_sp.out "$tmp/setup-check/water-sp/"
dftstream import-experiments "$tmp"
dftstream list                        # shows setup-check
```

With ORCA available, also run a small calculation (a few seconds):

```bash
mkdir -p "$tmp/run" && cd "$tmp/run"
cat > water.inp <<'EOF'
! HF def2-SVP
* xyz 0 1
O   0.000000   0.000000   0.117790
H   0.000000   0.755453  -0.471161
H   0.000000  -0.755453  -0.471161
*
EOF
dftstream run water.inp --exp setup-check > water.out
tail -n 3 water.out                   # ends with ORCA TERMINATED NORMALLY
cd - >/dev/null
```

## 6. Open the UI

```bash
dftstream ui            # in the background
curl -fsS -o /dev/null http://127.0.0.1:3000 && echo ui-ok
```

The user opens http://127.0.0.1:3000 and should see `setup-check`. If port
3000 is taken, use `dftstream ui -port 3001`. On a remote machine the user
needs a tunnel from their own computer:

```bash
ssh -L 3000:localhost:3000 -L 3210:localhost:3210 user@host
```

Offer to delete `setup-check` afterwards (the ⋯ menu on its card).

## 7. On a cluster

If `sbatch` exists, tell the user about [clusters.md](clusters.md):
compute nodes usually have no network, so runs there journal locally and
`dftstream sync` on the login node uploads them. Never pass `-submit` to
`dftstream submit` without the user's go-ahead, since it queues real jobs.

## 8. Report

Tell the user briefly:

- the `dftstream version` output and where the binaries are;
- the ORCA path in use, or that none was found;
- whether the backend runs at http://127.0.0.1:3210, and anything `doctor` flagged;
- the UI address, plus the SSH tunnel command on a remote machine;
- the result of the import check and of the ORCA run;
- anything you changed in their shell startup files;
- how to start again after a reboot: `dftstream-db`, then `dftstream ui`;
- the everyday command: `dftstream run job.inp --exp <project> > job.out`.

If something fails, the troubleshooting table in
[operations.md](operations.md#troubleshooting) covers the common cases.
