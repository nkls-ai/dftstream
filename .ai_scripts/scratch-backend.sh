#!/usr/bin/env bash
# scratch-backend.sh — a throwaway Convex backend on local disk.
#
# For load tests, fixtures and anything else that should never touch the
# developer's own deployment. Two properties matter:
#
#   1. Its database lives under /tmp (or $DFTSTREAM_SCRATCH_ROOT), not in the
#      checkout. The checkout is usually an NFS home, where every commit is a
#      network round trip — ~2 mutations/second against hundreds on local disk,
#      and a 58 MB database that takes over a minute just to open.
#   2. It runs on its own ports with its own instance name, so `bun dev` on
#      3210 keeps running untouched and its data is never reset.
#
#   .ai_scripts/scratch-backend.sh start   # start it (foreground)
#   .ai_scripts/scratch-backend.sh url     # print the URL for CONVEX_URL
#   .ai_scripts/scratch-backend.sh stop    # stop it
#   .ai_scripts/scratch-backend.sh reset   # delete its data entirely
#
# Point a test at it with:
#   CONVEX_URL=$(.ai_scripts/scratch-backend.sh url) bun .ai_scripts/stress-multiuser.ts

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
scratch_root="${DFTSTREAM_SCRATCH_ROOT:-/tmp/dftstream-scratch-$USER}"
project="$scratch_root/db"
port="${DFTSTREAM_SCRATCH_PORT:-3510}"
site_port=$((port + 1))
url="http://127.0.0.1:$port"

err() { printf 'error: %s\n' "$*" >&2; }

# Build the scratch project: the convex functions are COPIED (the backend
# pushes from them and we never want a push racing the developer's tree), while
# node_modules is symlinked so this costs no install and no disk.
sync_project() {
  mkdir -p "$project"
  rm -rf "$project/convex"
  cp -a "$repo_root/db/convex" "$project/convex"
  # The generated client is part of the copy; the local .convex data dir is not.
  rm -rf "$project/convex/.convex"
  cp -a "$repo_root/db/package.json" "$project/package.json"
  [[ -f "$repo_root/db/tsconfig.json" ]] && cp -a "$repo_root/db/tsconfig.json" "$project/tsconfig.json"
  if [[ ! -e "$project/node_modules" ]]; then
    ln -s "$repo_root/db/node_modules" "$project/node_modules"
  fi
  mkdir -p "$project/.convex/tmp"
}

case "${1:-start}" in
  start)
    if curl -fsS --max-time 3 "$url/version" >/dev/null 2>&1; then
      printf 'already running at %s\n' "$url" >&2
      exit 0
    fi
    sync_project
    cd "$project"
    printf 'scratch backend: %s\n' "$url" >&2
    printf 'data:            %s/.convex\n' "$project" >&2
    printf 'your own dev deployment on 3210 is untouched.\n' >&2
    # Same env as db/package.json's dev script, with a distinct instance name
    # and ports so the two backends cannot collide.
    printf 'n\n' | \
      CONVEX_DEPLOYMENT=anonymous:dftstream-scratch \
      CONVEX_URL="$url" \
      CONVEX_SITE_URL="http://127.0.0.1:$site_port" \
      CLERK_JWT_ISSUER_DOMAIN=https://placeholder.local \
      DFTSTREAM_AUTH_REQUIRED=0 \
      TZ=UTC \
      CONVEX_AGENT_MODE=anonymous \
      CONVEX_TMPDIR="$project/.convex/tmp" \
      DFTSTREAM_DB_SKIP_FSCHECK=1 \
      exec bunx convex dev --local-cloud-port "$port" --local-site-port "$site_port"
    ;;
  url)
    printf '%s\n' "$url"
    ;;
  stop)
    # Match on the scratch data path so this can never kill the developer's
    # own backend, which stores its database inside the checkout.
    if pkill -f "convex-local-backend.*$project"; then
      printf 'stopped\n' >&2
    else
      printf 'nothing to stop\n' >&2
    fi
    ;;
  reset)
    if curl -fsS --max-time 3 "$url/version" >/dev/null 2>&1; then
      err "the scratch backend is still running; stop it first."
      exit 1
    fi
    rm -rf "$scratch_root"
    printf 'removed %s\n' "$scratch_root" >&2
    ;;
  *)
    err "unknown command: $1"
    printf 'usage: scratch-backend.sh [start|url|stop|reset]\n' >&2
    exit 2
    ;;
esac
