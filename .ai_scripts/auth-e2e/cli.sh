#!/usr/bin/env bash
# Run the built dftstream binary with ALL per-user state sandboxed under
# $E2E_ROOT/<profile>, so a live auth test never touches the real
# ~/.config/dftstream or ~/.local/state/dftstream.
#
#   E2E_ROOT=/tmp/.../e2e E2E_PROFILE=a .ai_scripts/auth-e2e/cli.sh login
set -euo pipefail
root="${E2E_ROOT:?set E2E_ROOT to a scratch directory}"
profile="${E2E_PROFILE:-default}"
base="$root/profiles/$profile"
mkdir -p "$base"/{home,config,state,cache,spool}
bin="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../wrapper/bin" && pwd)/dftstream"
export HOME="$base/home" XDG_CONFIG_HOME="$base/config" XDG_STATE_HOME="$base/state" \
  XDG_CACHE_HOME="$base/cache" DFTSTREAM_SPOOL_DIR="$base/spool" \
  DFTSTREAM_CREDENTIALS="${DFTSTREAM_CREDENTIALS:-$base/config/dftstream/credentials.json}"
exec "$bin" "$@"
