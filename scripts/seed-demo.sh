#!/usr/bin/env bash
# Seed a demo backend with the example runs.
#
# Stages the local `.examples/` tree into the layout that
# `dftstream import-experiments` expects (via
# scripts/stage-examples-for-import.sh) and imports it into the backend
# you name: a read-only demo deployment, or a scratch deployment while
# developing it.
#
# The backend must be named explicitly — there is no default, so the
# script can never accidentally point at production or at a local dev
# database you did not mean to touch.
#
# Requirements (both are gitignored — present only on machines that
# have the example corpus):
#   • .examples/                          — the example ORCA runs
#   • scripts/stage-examples-for-import.sh — the staging map
#
# Usage:
#   scripts/seed-demo.sh <backend-url> [extra import-experiments flags...]
#
#   scripts/seed-demo.sh http://127.0.0.1:3210
#   scripts/seed-demo.sh convex+https://demo-backend.example.org
#   scripts/seed-demo.sh http://127.0.0.1:3210 --force --artifacts all
#
# <backend-url> may be a plain http(s) URL or a full convex+ DSN; the
# convex+ prefix is added when missing. Extra flags are passed through
# to `dftstream import-experiments` unchanged (e.g. --force to
# re-import over an existing seed, --org for an authed deployment).
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_dir="$(cd -- "$script_dir/.." >/dev/null 2>&1 && pwd)"

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  [[ $# -ge 1 ]] && exit 0
  printf '\nerror: missing <backend-url>\n' >&2
  exit 2
fi

backend="$1"
shift

# Normalize to the convex+ DSN the wrapper expects.
case "$backend" in
  convex+http://*|convex+https://*) tracker_url="$backend" ;;
  http://*|https://*)               tracker_url="convex+$backend" ;;
  *)
    printf 'error: backend must be an http(s) URL or convex+ DSN, got: %s\n' "$backend" >&2
    exit 2
    ;;
esac

# --- Pre-flight: the example corpus is gitignored and may be absent ----------
examples_dir="$repo_dir/.examples"
stage_script="$script_dir/stage-examples-for-import.sh"

if [[ ! -d "$examples_dir" ]]; then
  printf 'error: example corpus not found at %s\n' "$examples_dir" >&2
  printf 'The .examples/ tree is gitignored and only exists on machines that have the\n' >&2
  printf 'example ORCA runs. Copy it from a machine that has it, then re-run.\n' >&2
  exit 1
fi
if [[ ! -f "$stage_script" ]]; then
  printf 'error: staging script not found at %s\n' "$stage_script" >&2
  printf 'scripts/stage-examples-for-import.sh is gitignored alongside .examples/;\n' >&2
  printf 'copy it from the same machine as the example corpus.\n' >&2
  exit 1
fi

# --- Resolve the wrapper binary ----------------------------------------------
if [[ -n "${DFTSTREAM_BIN:-}" ]]; then
  if [[ ! -x "$DFTSTREAM_BIN" ]]; then
    printf 'error: DFTSTREAM_BIN is set but not executable: %s\n' "$DFTSTREAM_BIN" >&2
    exit 2
  fi
  bin="$DFTSTREAM_BIN"
elif command -v dftstream >/dev/null 2>&1; then
  bin="$(command -v dftstream)"
else
  printf '▶ building wrapper (no dftstream on PATH, DFTSTREAM_BIN unset)\n' >&2
  bin="$(mktemp -t dftstream-seed-XXXX)"
  (cd "$repo_dir/wrapper" && go build -o "$bin" ./cmd/dftstream)
fi

# --- Stage the examples into an import tree ----------------------------------
stage_root="$(mktemp -d -t dftstream-seed-demo-XXXX)"
# Best-effort cleanup of the staged copy on exit; a leftover temp dir is harmless.
trap 'rm -rf "$stage_root" || printf "warning: could not remove %s\n" "$stage_root" >&2' EXIT

printf '▶ staging examples\n' >&2
DFTSTREAM_IMPORT_ROOT="$stage_root" "$stage_script" >&2

# --- Import ------------------------------------------------------------------
printf '▶ importing into %s\n' "$tracker_url" >&2
"$bin" import-experiments --tracker-url "$tracker_url" "$@" "$stage_root"

printf '\n▶ done — seeded %s from %s\n' "$tracker_url" "$examples_dir" >&2
