# Clusters

Installing on a shared machine, submitting to SLURM, and tracking jobs on
compute nodes that have no network.

## Install without root

Install into your home or scratch directory:

```bash
bash scripts/install.sh --method source --mode local --repo "$PWD" \
  --source "$SCRATCH/dftstream" --bin-dir "$HOME/bin"
```

Keep `--source` on local or scratch disk if you can. The local backend stores
its database there, and on an NFS home every write waits for the network
(`dftstream-db doctor` measures it).

The local backend needs glibc 2.35 or newer. On older systems (RHEL 8 and 9)
run the backend somewhere else, for example in Docker on a group server
([operations.md](operations.md#docker)), and point the CLI at it with
`dftstream config set-url`.

One person on a login node can use a local backend. A group sharing results
needs a shared backend that every node can reach.

To open a backend that runs on the cluster from your laptop, forward the ports:

```bash
ssh -L 3000:localhost:3000 -L 3210:localhost:3210 user@cluster
```

## Submit jobs

`dftstream submit` stages each input into its own job directory, together with
every `.xyz`, `.hess`, `.allxyz` and `.gbw` it references. It reads cores and
memory from `%pal` and `%maxcore` and writes a SLURM script that runs on
node-local scratch and copies the results back.

```bash
dftstream submit -dry-run job.inp      # print the script, change nothing
dftstream submit -submit job.inp       # stage it and queue it
dftstream submit -array -submit all    # every input in the folder as one job array
```

Nothing is queued without `-submit`. Array jobs run at most `-throttle` tasks at
once and skip inputs that already finished normally, so rerunning after a
partial failure only redoes the failures.

Partitions, walltimes, ORCA paths and scratch layout come from a cluster file.
The built-in file is a template with two example clusters: `example` (shared
ORCA install, node-local `/tmp`) and `modules` (ORCA from environment modules,
a `/scratch` filesystem). Copy it and edit every value marked `EDIT`:

```bash
dftstream submit -print-config > ~/.config/dftstream/clusters.yaml
```

At minimum set `orca_binary` to the full path of `orca` on the compute nodes
(ORCA needs the full path to run in parallel) and the partition names
(`sinfo -s` lists them). Until `orca_binary` and `dftstream_binary` are real
paths, `-submit` refuses to queue anything and the other modes print a warning.

DFTStream reads `-config FILE`, then `$DFTSTREAM_CLUSTERS`, then
`./clusters.yaml`, then `~/.config/dftstream/clusters.yaml`, then the built-in
file.

## Watch and cancel queued jobs

Submitted jobs appear on the experiment page as soon as SLURM accepts them. The
backend cannot reach the scheduler, so a login node reports their state:

```bash
dftstream queue status        # poll once
dftstream queue watch         # poll every 30 s, and carry out cancels requested in the UI
dftstream queue cancel 4242   # cancel by job id or input name
```

The Cancel button in the UI only requests the cancel. It happens at the next
poll of `queue watch`.

## Compute nodes without network

Most clusters block outbound traffic from compute nodes. DFTStream handles that
in two ways.

- If the backend becomes unreachable during a run, the wrapper switches to a
  local journal and says so once. ORCA is not affected.
- `dftstream run -offline` (or `DFTSTREAM_OFFLINE=1`) skips the backend from
  the start, so a job spends no walltime on connection timeouts.

Journals go to `~/.local/state/dftstream/spool/` (or `$DFTSTREAM_SPOOL_DIR`).
Home is usually shared with the login nodes, so upload from there:

```bash
dftstream sync          # every journal, oldest first
dftstream sync -keep    # keep synced journals instead of deleting them
```

Sync can be interrupted and rerun. Nothing is uploaded twice, and a journal
with a damaged end still uploads everything before the damage.

In the cluster file, `compute_nodes_offline: true` makes `dftstream submit`
write offline jobs that try a sync after ORCA finishes.

## Batch jobs on a backend with auth

A batch job cannot open a browser for `dftstream login`. An org admin creates a
machine token under Settings → Machine tokens, and the job uses it:

```bash
export DFTSTREAM_TOKEN=ost_...
dftstream run job.inp
```

The token belongs to one organization, is read only from the environment, and
can be revoked in the UI at any time. Every task of a job array can share one
token.
