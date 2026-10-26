#!/usr/bin/env bash
set -euo pipefail

# backup-restore - consistent snapshots of a self-hosted DFTStream Convex backend
#
# Uses `convex export` / `convex import` against the backend's HTTP interface
# (CONVEX_SELF_HOSTED_URL + admin key), which gives a transactionally consistent
# snapshot of every table plus, with file storage included, every uploaded
# artifact — no need to stop the backend. This is the supported mechanism for
# self-hosted Convex; copying the sqlite file while the backend runs is not.

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
backup-restore - snapshot and restore the DFTStream Convex backend

Usage:
  backup-restore backup <dest.zip|dest-dir> [options]
  backup-restore restore <src.zip> [options]
  backup-restore verify <snapshot.zip>

Commands:
  backup    Export every table plus artifact file storage into a snapshot ZIP.
            If DEST is a directory, a timestamped file is created inside it.
  restore   Import a snapshot ZIP, replacing ALL existing data in the
            deployment (tables and file storage). Destructive; asks first.
  verify    Print per-table document counts and stored-file count for a
            snapshot ZIP, without touching any backend.

Options:
  --url URL         Backend URL. Default: $DFTSTREAM_CONVEX_URL or
                    http://127.0.0.1:3210.
  --admin-key KEY   Deployment admin key. Default: $CONVEX_SELF_HOSTED_ADMIN_KEY,
                    else read from db/.convex/local/default/config.json when the
                    URL is a loopback address.
  --force           Allow a non-loopback URL. Without this the script refuses
                    anything that could be a shared or production deployment.
  --yes             Skip the interactive confirmation before a restore.

Environment:
  DFTSTREAM_SOURCE              DFTStream checkout. Defaults to this repo.
  DFTSTREAM_CONVEX_URL          Backend URL, same as --url.
  CONVEX_SELF_HOSTED_ADMIN_KEY   Admin key, same as --admin-key.
EOF
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source_dir="${DFTSTREAM_SOURCE:-$(cd -- "$script_dir/.." >/dev/null 2>&1 && pwd)}"
db_dir="$source_dir/db"

cmd="${1:-}"
if [[ -z "$cmd" || "$cmd" == "-h" || "$cmd" == "--help" || "$cmd" == "help" ]]; then
  usage
  [[ -n "$cmd" ]] && exit 0
  exit 2
fi
shift

url="${DFTSTREAM_CONVEX_URL:-http://127.0.0.1:3210}"
admin_key="${CONVEX_SELF_HOSTED_ADMIN_KEY:-}"
force=0
yes=0
path_arg=""

while (($#)); do
  case "$1" in
    --url)
      [[ $# -ge 2 ]] || { err "--url needs a value"; exit 2; }
      url="$2"; shift 2 ;;
    --admin-key)
      [[ $# -ge 2 ]] || { err "--admin-key needs a value"; exit 2; }
      admin_key="$2"; shift 2 ;;
    --force) force=1; shift ;;
    --yes|-y) yes=1; shift ;;
    -*)
      err "unknown option: $1"
      usage
      exit 2 ;;
    *)
      if [[ -n "$path_arg" ]]; then
        err "unexpected extra argument: $1"
        exit 2
      fi
      path_arg="$1"; shift ;;
  esac
done

require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun is required (the Convex CLI runs via bunx)."
    printf 'fix: install Bun from https://bun.sh, then rerun.\n' >&2
    exit 2
  fi
}

ensure_db() {
  if [[ ! -d "$db_dir" ]]; then
    err "cannot find db directory at $db_dir."
    printf 'fix: set DFTSTREAM_SOURCE to your DFTStream checkout.\n' >&2
    exit 2
  fi
  require_bun
  if [[ ! -d "$db_dir/node_modules" ]]; then
    bold "Installing Convex dependencies in $db_dir"
    (cd "$db_dir" && bun install)
  fi
}

# True when the URL points at this machine only. Everything else — cloud
# deployments (*.convex.cloud), any hostname or
# LAN address — is treated as potentially production.
is_loopback_url() {
  case "$1" in
    http://127.*|http://localhost:*|http://localhost/*|http://localhost|http://\[::1\]*) return 0 ;;
    *) return 1 ;;
  esac
}

guard_url() {
  if ! is_loopback_url "$url"; then
    if [[ "$force" != 1 ]]; then
      err "$url is not a loopback address — it may be a shared or production deployment."
      printf 'This tool refuses to run against anything that could be production by default.\n' >&2
      printf 'fix: pass --force if you are certain this is the deployment you mean.\n' >&2
      exit 1
    fi
    warn "--force given: operating on non-local deployment $url"
  fi
}

require_backend_up() {
  if ! command -v curl >/dev/null 2>&1; then
    err "curl is required to verify the backend is reachable."
    exit 2
  fi
  if ! curl -fsS --max-time 10 "$url/version" >/dev/null 2>&1; then
    err "no Convex backend is answering at $url."
    printf 'fix: start it (scripts/dftstream-db.sh for the local backend) or pass the right --url.\n' >&2
    exit 1
  fi
}

resolve_admin_key() {
  if [[ -n "$admin_key" ]]; then
    return 0
  fi
  # Only auto-read the local anonymous dev key for a loopback URL; a remote
  # deployment has its own key and the local one would be wrong anyway.
  local cfg="$db_dir/.convex/local/default/config.json"
  if is_loopback_url "$url" && [[ -f "$cfg" ]]; then
    if ! admin_key="$(cd "$db_dir" && bun -e 'const c = JSON.parse(await Bun.file(".convex/local/default/config.json").text()); if (!c.adminKey) throw new Error("no adminKey in config.json"); console.log(c.adminKey);')"; then
      err "could not read the admin key from $cfg."
      exit 1
    fi
    return 0
  fi
  err "no admin key available for $url."
  printf 'fix: pass --admin-key, or set CONVEX_SELF_HOSTED_ADMIN_KEY.\n' >&2
  printf '     (for the local backend: scripts/dftstream-db.sh admin-key)\n' >&2
  exit 1
}

run_convex() {
  # The CLI would otherwise auto-load db/.env.local, whose CONVEX_DEPLOYMENT
  # conflicts with self-hosted mode. --env-file makes it read exactly one file,
  # so write the target there (0600 via mktemp; removed right after).
  local subcmd="$1"; shift
  local env_file
  env_file="$(mktemp)"
  printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' \
    "$url" "$admin_key" >"$env_file"
  local rc=0
  (cd "$db_dir" && \
    env -u CONVEX_DEPLOYMENT -u CONVEX_URL \
      bunx convex "$subcmd" --env-file "$env_file" "$@") || rc=$?
  rm -f -- "$env_file" || warn "could not remove temp env file $env_file"
  return "$rc"
}

# Per-table document counts and stored-file count of a snapshot zip.
summarize_zip() {
  local zip="$1"
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found; skipping snapshot summary"
    return 0
  fi
  python3 - "$zip" <<'PY'
import sys, zipfile
path = sys.argv[1]
try:
    z = zipfile.ZipFile(path)
except Exception as e:  # unreadable/corrupt zip must be loud, not silent
    print(f"error: cannot read snapshot {path}: {e}", file=sys.stderr)
    sys.exit(1)
bad = z.testzip()
if bad is not None:
    print(f"error: snapshot {path} is corrupt (first bad member: {bad})", file=sys.stderr)
    sys.exit(1)
tables, files = {}, 0
for name in z.namelist():
    if name.endswith("/documents.jsonl"):
        table = name.rsplit("/", 2)[-2]
        with z.open(name) as f:
            tables[table] = sum(1 for line in f if line.strip())
    elif name.startswith("_storage/") and not name.endswith("/") and not name.endswith(".json"):
        files += 1
total = 0
for table in sorted(tables):
    if table.startswith("_"):  # Convex-internal metadata (_tables, _storage)
        continue
    print(f"  {tables[table]:>8}  {table}")
    total += tables[table]
print(f"  {total:>8}  total documents")
print(f"  {files:>8}  stored files (artifacts)")
PY
}

case "$cmd" in
  backup)
    if [[ -z "$path_arg" ]]; then
      err "backup needs a destination (.zip path or directory)."
      usage
      exit 2
    fi
    ensure_db
    guard_url
    require_backend_up
    resolve_admin_key
    dest="$path_arg"
    if [[ -d "$dest" ]]; then
      dest="${dest%/}/dftstream-backup-$(date -u +%Y%m%dT%H%M%SZ).zip"
    fi
    case "$dest" in
      *.zip) : ;;
      *)
        err "destination must be a .zip path or an existing directory: $dest"
        exit 2 ;;
    esac
    if [[ -e "$dest" ]]; then
      err "$dest already exists; refusing to overwrite a backup."
      exit 1
    fi
    mkdir -p -- "$(dirname -- "$dest")"
    bold "Exporting $url (all tables + file storage)"
    run_convex export --path "$dest" --include-file-storage
    ok "snapshot written to $dest"
    summarize_zip "$dest"
    ;;
  restore)
    if [[ -z "$path_arg" ]]; then
      err "restore needs a snapshot .zip to import."
      usage
      exit 2
    fi
    src="$path_arg"
    if [[ ! -f "$src" ]]; then
      err "snapshot not found: $src"
      exit 1
    fi
    ensure_db
    guard_url
    require_backend_up
    resolve_admin_key
    bold "Snapshot contents:"
    summarize_zip "$src"
    warn "restore REPLACES ALL data in $url — every table and all file storage."
    if [[ "$yes" != 1 ]]; then
      if [[ ! -t 0 ]]; then
        err "refusing to restore without confirmation (no terminal; pass --yes)."
        exit 1
      fi
      printf 'Type the word "restore" to continue: ' >&2
      read -r answer
      if [[ "$answer" != "restore" ]]; then
        err "aborted; nothing was changed."
        exit 1
      fi
    fi
    bold "Importing $src into $url"
    run_convex import --replace-all -y "$src"
    ok "restore complete"
    printf 'Verify with a fresh `backup` and compare document counts against the snapshot.\n' >&2
    ;;
  verify)
    if [[ -z "$path_arg" ]]; then
      err "verify needs a snapshot .zip."
      usage
      exit 2
    fi
    if [[ ! -f "$path_arg" ]]; then
      err "snapshot not found: $path_arg"
      exit 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
      err "python3 is required for verify."
      exit 2
    fi
    bold "Snapshot contents of $path_arg:"
    summarize_zip "$path_arg"
    ;;
  *)
    err "unknown command: $cmd"
    usage
    exit 2
    ;;
esac
