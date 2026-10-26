#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${NO_COLOR:-}" || ! -t 2 ]]; then
  bold() { printf '%s\n' "$*" >&2; }
  ok() { printf 'success: %s\n' "$*" >&2; }
  warn() { printf 'warning: %s\n' "$*" >&2; }
  err() { printf 'error: %s\n' "$*" >&2; }
else
  bold() { printf '\033[1m%s\033[0m\n' "$*" >&2; }
  ok() { printf '\033[32msuccess:\033[0m %s\n' "$*" >&2; }
  warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
  err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
fi

usage() {
  cat >&2 <<'EOF'
dftstream-db - manage the local DFTStream Convex backend

Usage:
  dftstream-db [start]
  dftstream-db once
  dftstream-db deploy [URL]
  dftstream-db wait
  dftstream-db env
  dftstream-db dashboard
  dftstream-db admin-key
  dftstream-db doctor
  dftstream-db relocate DIR

Commands:
  start       Start Convex local dev backend on http://127.0.0.1:3210.
  once        Push/typecheck Convex functions once, then exit.
  deploy      Push updated functions to a running Docker container (zero downtime).
  wait        Wait until the local backend answers /version.
  env         Print shell exports for wrapper/UI clients.
  dashboard  Print the local dashboard URL.
  admin-key  Print the local dashboard admin key.
  doctor      Report where the database lives and how fast it can commit.
  relocate    Move the database onto DIR (local disk) and symlink it back.

Environment:
  DFTSTREAM_SOURCE       DFTStream source checkout. Defaults to this script's repo.
  DFTSTREAM_CONVEX_URL   Local Convex URL. Defaults to http://127.0.0.1:3210.
  CONVEX_AGENT_MODE       Defaults to anonymous for local-first setup.
  DFTSTREAM_DB_SKIP_FSCHECK  Set to 1 to silence the network-filesystem warning.
  DFTSTREAM_CONVEX_BACKEND_VERSION  Convex local-backend build to run. Defaults to
                         one tested with this release; "latest" lets Convex pick.

EOF
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source_dir="${DFTSTREAM_SOURCE:-$(cd -- "$script_dir/.." >/dev/null 2>&1 && pwd)}"
db_dir="$source_dir/db"
deployment_config="$db_dir/.convex/local/default/config.json"
convex_url="${DFTSTREAM_CONVEX_URL:-http://127.0.0.1:3210}"
# Left alone, `convex dev` upgrades to the newest local-backend build, and
# builds from 2026-10 on need glibc 2.38+ (not on Ubuntu 22.04 or most
# clusters). Pin the build this release was tested with; it needs glibc 2.35.
backend_version="${DFTSTREAM_CONVEX_BACKEND_VERSION:-precompiled-2026-09-21-0cf49cb}"
backend_version_args=()
if [[ "$backend_version" != "latest" ]]; then
  backend_version_args=(--local-backend-version "$backend_version")
fi
cmd="${1:-start}"
if [[ "$cmd" == "start" ]]; then
  shift || true
else
  shift || true
fi

require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun is required to run the local Convex backend."
    printf 'fix: install Bun from https://bun.sh, or load it as a cluster module, then rerun dftstream-db.\n' >&2
    exit 2
  fi
}

ensure_db() {
  if [[ ! -d "$db_dir" ]]; then
    err "Cannot find db directory at $db_dir."
    printf 'fix: set DFTSTREAM_SOURCE to your DFTStream checkout.\n' >&2
    exit 2
  fi
  require_bun
  cd "$db_dir"
  mkdir -p .convex/tmp
  if [[ ! -d node_modules ]]; then
    bold "Installing Convex dependencies in $db_dir"
    bun install
  fi
}

# Convex refuses to push functions when an env var named in auth.config.ts is
# missing from the deployment — even one behind an `if` guard that goes unused
# (same failure the docker entrypoint fixes, see 2d15fd6). Seed
# CLERK_JWT_ISSUER_DOMAIN (empty = no Clerk provider) so anonymous/no-auth
# deployments push cleanly; pass CLERK_JWT_ISSUER_DOMAIN to enable Clerk.
# A fresh checkout has no deployment for `env set` to target yet, so bootstrap
# one with a throwaway `dev --once` (its push aborts on the same missing var —
# expected; the deployment config it writes is what we need).
seed_auth_env() {
  local probe
  probe="$(bunx convex env get CLERK_JWT_ISSUER_DOMAIN 2>&1 >/dev/null || true)"
  if [[ "$probe" == *"No CONVEX_DEPLOYMENT"* ]]; then
    bootstrap_dev_once
    if [[ ! -f "$deployment_config" ]]; then
      write_pinned_deployment_config
      bootstrap_dev_once
    fi
    probe="$(bunx convex env get CLERK_JWT_ISSUER_DOMAIN 2>&1 >/dev/null || true)"
  fi
  # Seed only when the var is unset in the deployment (never clobber a value
  # someone configured), or when the caller supplied an explicit value.
  if [[ -n "${CLERK_JWT_ISSUER_DOMAIN:-}" || "$probe" == *"not found"* ]]; then
    if ! bunx convex env set CLERK_JWT_ISSUER_DOMAIN "${CLERK_JWT_ISSUER_DOMAIN:-}"; then
      warn "could not seed CLERK_JWT_ISSUER_DOMAIN; Convex function push may fail"
    fi
  fi
}

bootstrap_dev_once() {
  # Failure is expected here (see seed_auth_env); what matters is the
  # deployment config and the downloaded binary it leaves behind.
  printf 'n\n' | bunx convex dev --once ${backend_version_args[@]+"${backend_version_args[@]}"} >/dev/null 2>&1 || true
}

# For a deployment without saved credentials, the Convex CLI (1.46) creates the
# admin key with the newest backend build, ignoring --local-backend-version.
# That build needs glibc 2.38+, so a first start fails on Ubuntu 22.04 and most
# clusters. Create the credentials with the pinned build instead; the CLI then
# treats the deployment as existing and never runs the newest build.
write_pinned_deployment_config() {
  [[ "$backend_version" == "latest" ]] && return 0
  local binary="$HOME/.cache/convex/binaries/$backend_version/convex-local-backend"
  if [[ ! -x "$binary" ]]; then
    warn "Convex backend $backend_version was not downloaded to $binary; the first start may fail"
    return 0
  fi
  local name="anonymous-db" secret admin_key
  secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  if ! admin_key="$("$binary" keygen admin-key --instance-name "$name" --instance-secret "$secret")"; then
    warn "could not create an admin key with $binary; the first start may fail"
    return 0
  fi
  mkdir -p "$(dirname "$deployment_config")"
  NAME="$name" SECRET="$secret" ADMIN_KEY="$admin_key" VERSION="$backend_version" CONFIG="$deployment_config" \
    bun -e 'const e = process.env; await Bun.write(e.CONFIG, JSON.stringify({ ports: { cloud: 3210, site: 3211 }, backendVersion: e.VERSION, adminKey: e.ADMIN_KEY, instanceSecret: e.SECRET, deploymentName: e.NAME }, null, 2) + "\n");'
}

# --- Storage location -------------------------------------------------------
#
# Every Convex mutation ends in an fsync. On a network home directory that
# fsync is a round trip: measured on one university box, 62.8 ms on an NFS4
# /home versus 0.8 ms on node-local /tmp — an ~80x difference that caps the
# backend at roughly 2 mutations/second no matter how fast the queries are. A
# single tracked ORCA run issues on the order of 30 writes, so a several-hundred
# job screen becomes unusable. Nothing about this is visible in the logs, which
# is why it gets its own warning and its own `doctor`.

# Filesystem type of a path (Linux `stat -f`; BSD/macOS spells the format
# differently, so anything else yields the empty string and the check is
# skipped rather than guessed at).
fs_type() {
  local path="$1"
  # Walk up to the nearest existing ancestor — the .convex dir may not exist yet.
  while [[ ! -e "$path" && "$path" != "/" ]]; do path="$(dirname -- "$path")"; done
  if [[ "$(uname -s)" != "Linux" ]]; then
    printf ''
    return 0
  fi
  stat -f -c '%T' -- "$path" 2>/dev/null || printf ''
}

# Network filesystems whose fsync is a round trip. Local journalled filesystems
# (ext*, xfs, btrfs, zfs, tmpfs, overlayfs) are all fine.
is_network_fs() {
  case "$1" in
    nfs|nfs4|nfsd|cifs|smb2|smb3|fuseblk|fuse.sshfs|fuse.rclone|lustre|gpfs|beegfs|afs|ceph|glusterfs) return 0 ;;
    *) return 1 ;;
  esac
}

# Average fsync latency in milliseconds for a directory, over `count` commits.
# Echoes the number, or nothing if the probe could not run.
fsync_ms() {
  local dir="$1" count="${2:-20}" probe start end
  probe="$dir/.fsync-probe.$$"
  if ! : >"$probe" 2>/dev/null; then
    rm -f -- "$probe" 2>/dev/null || true
    return 1
  fi
  start=$(date +%s%N)
  if ! dd if=/dev/zero of="$probe" bs=4096 count="$count" oflag=dsync >/dev/null 2>&1; then
    rm -f -- "$probe" 2>/dev/null || true
    return 1
  fi
  end=$(date +%s%N)
  if ! rm -f -- "$probe"; then
    warn "could not remove fsync probe file $probe"
  fi
  printf '%s' $(( (end - start) / 1000000 / count ))
}

# Warn once at startup when the database sits on a network filesystem. Never
# moves anything on its own — the database is the user's data, and `relocate`
# is the explicit, reversible way to act on this.
check_storage() {
  [[ "${DFTSTREAM_DB_SKIP_FSCHECK:-}" == "1" ]] && return 0
  local target="$db_dir/.convex" fs
  # A symlink means someone already relocated; report on where it actually points.
  [[ -L "$target" ]] && target="$(readlink -f -- "$target" 2>/dev/null || printf '%s' "$target")"
  fs="$(fs_type "$target")"
  if [[ -n "$fs" ]] && is_network_fs "$fs"; then
    warn "the database directory is on a $fs filesystem ($target)"
    printf 'Every write commits over the network there: expect roughly 2 mutations/second\n' >&2
    printf 'instead of the low hundreds, which a high-throughput batch will feel.\n' >&2
    printf 'fix: dftstream-db relocate /scratch/$USER/dftstream   (or any local disk)\n' >&2
    printf 'silence: DFTSTREAM_DB_SKIP_FSCHECK=1\n' >&2
  fi
}

# Refuse to touch the database files while a backend is serving them.
require_backend_stopped() {
  if command -v curl >/dev/null 2>&1 && curl -fsS "$convex_url/version" >/dev/null 2>&1; then
    err "a Convex backend is answering at $convex_url."
    printf 'fix: stop it first — moving its files while it runs would corrupt them.\n' >&2
    exit 1
  fi
}

deployment_name() {
  if [[ -f "$deployment_config" ]]; then
    (cd "$db_dir" && bun -e 'const c = JSON.parse(await Bun.file(".convex/local/default/config.json").text()); console.log(c.deploymentName ?? "anonymous-db");')
  else
    printf 'anonymous-db\n'
  fi
}

case "$cmd" in
  start)
    ensure_db
    export TZ=UTC
    export CONVEX_TMPDIR="$db_dir/.convex/tmp"
    export CONVEX_AGENT_MODE="${CONVEX_AGENT_MODE:-anonymous}"
    # The CLI gives the backend 30 s to open its sqlite file. That is generous
    # on local disk and not nearly enough on a network home: a 58 MB database
    # on NFS took 46-75 s to come up here, so the default fails with a timeout
    # that says nothing about the real cause. `doctor` and `relocate` are the
    # actual fix; this keeps `start` working meanwhile.
    export CONVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS="${CONVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS:-240}"
    check_storage
    seed_auth_env
    bold "Starting DFTStream Convex backend"
    printf 'backend:   %s\n' "$convex_url" >&2
    printf 'dashboard: http://127.0.0.1:6790/?d=%s\n' "$(deployment_name)" >&2
    exec bunx convex dev ${backend_version_args[@]+"${backend_version_args[@]}"} "$@"
    ;;
  once)
    ensure_db
    export TZ=UTC
    export CONVEX_TMPDIR="$db_dir/.convex/tmp"
    export CONVEX_AGENT_MODE="${CONVEX_AGENT_MODE:-anonymous}"
    # The CLI gives the backend 30 s to open its sqlite file. That is generous
    # on local disk and not nearly enough on a network home: a 58 MB database
    # on NFS took 46-75 s to come up here, so the default fails with a timeout
    # that says nothing about the real cause. `doctor` and `relocate` are the
    # actual fix; this keeps `start` working meanwhile.
    export CONVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS="${CONVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS:-240}"
    seed_auth_env
    exec bunx convex dev --once ${backend_version_args[@]+"${backend_version_args[@]}"} "$@"
    ;;
  wait)
    deadline=$((SECONDS + 60))
    while (( SECONDS < deadline )); do
      if command -v curl >/dev/null 2>&1 && curl -fsS "$convex_url/version" >/dev/null 2>&1; then
        ok "Convex is reachable at $convex_url"
        exit 0
      fi
      sleep 1
    done
    err "Convex did not become reachable at $convex_url within 60 seconds."
    printf 'fix: start it with `dftstream-db` and keep that terminal running.\n' >&2
    exit 1
    ;;
  env)
    printf 'export DFTSTREAM_TRACKER_URL=%q\n' "convex+${convex_url}"
    printf 'export BUN_PUBLIC_CONVEX_URL=%q\n' "$convex_url"
    ;;
  dashboard)
    ensure_db
    printf 'http://127.0.0.1:6790/?d=%s\n' "$(deployment_name)"
    ;;
  deploy)
    docker_dir="$source_dir/db/docker"
    if [[ ! -f "$docker_dir/push-functions.sh" ]]; then
      err "Cannot find push-functions.sh at $docker_dir"
      exit 2
    fi
    exec bash "$docker_dir/push-functions.sh" "$@"
    ;;
  admin-key)
    ensure_db
    if [[ ! -f "$deployment_config" ]]; then
      err "No local Convex admin key exists yet."
      printf 'fix: start the backend once with `dftstream-db`, then rerun `dftstream-db admin-key`.\n' >&2
      exit 1
    fi
    bun -e 'const c = JSON.parse(await Bun.file(".convex/local/default/config.json").text()); console.log(c.adminKey);'
    ;;
  doctor)
    ensure_db
    real="$db_dir/.convex"
    link_note=""
    if [[ -L "$real" ]]; then
      link_note=" (symlink from $db_dir/.convex)"
      real="$(readlink -f -- "$real" 2>/dev/null || printf '%s' "$real")"
    fi
    printf 'database   %s%s\n' "$real" "$link_note" >&2
    fs="$(fs_type "$real")"
    printf 'filesystem %s\n' "${fs:-unknown}" >&2
    mkdir -p "$real/tmp"
    if ms="$(fsync_ms "$real/tmp")"; then
      printf 'fsync      %s ms per commit\n' "$ms" >&2
      # Convex commits at least once per mutation, so the ceiling is 1000/fsync.
      if (( ms > 0 )); then
        printf 'ceiling    ~%s mutations/second\n' "$((1000 / ms))" >&2
      fi
      if (( ms > 10 )); then
        warn "that is slow enough to bottleneck a high-throughput batch"
        printf 'fix: dftstream-db relocate /scratch/$USER/dftstream\n' >&2
      else
        ok "commit latency is fine for high-throughput batches"
      fi
    else
      warn "could not measure fsync latency in $real/tmp"
    fi
    ;;
  relocate)
    ensure_db
    dest="${1:-}"
    if [[ -z "$dest" ]]; then
      err "relocate needs a destination directory on local disk."
      printf 'usage: dftstream-db relocate /scratch/$USER/dftstream\n' >&2
      exit 2
    fi
    require_backend_stopped
    if [[ -L "$db_dir/.convex" ]]; then
      err "$db_dir/.convex is already a symlink to $(readlink -f -- "$db_dir/.convex")."
      printf 'fix: remove that symlink first if you really want to point somewhere else.\n' >&2
      exit 1
    fi
    mkdir -p "$dest"
    dest="$(cd -- "$dest" && pwd)"
    if [[ -e "$dest/.convex" ]]; then
      err "$dest/.convex already exists; refusing to overwrite it."
      exit 1
    fi
    fs="$(fs_type "$dest")"
    if [[ -n "$fs" ]] && is_network_fs "$fs"; then
      warn "$dest is also on a $fs filesystem — this will not make writes faster"
    fi
    # Copy first, swap second, and never delete the original: if anything goes
    # wrong the untouched database is still sitting where it always was.
    if [[ -d "$db_dir/.convex" ]]; then
      bold "Copying the database to $dest/.convex"
      cp -a -- "$db_dir/.convex" "$dest/.convex"
      backup="$db_dir/.convex.before-relocate.$(date +%Y%m%d%H%M%S)"
      mv -- "$db_dir/.convex" "$backup"
      ok "previous copy kept at $backup — delete it once you are satisfied"
    else
      mkdir -p "$dest/.convex"
    fi
    ln -s -- "$dest/.convex" "$db_dir/.convex"
    mkdir -p "$db_dir/.convex/tmp"
    ok "database now lives on $dest/.convex"
    printf 'Run `dftstream-db doctor` to confirm the new commit latency.\n' >&2
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    err "Unknown command: $cmd"
    usage
    exit 2
    ;;
esac
