#!/usr/bin/env bash
# Stand-in "orca" binary for recording a live run on a host without ORCA.
# Replays a real ORCA output on stdout at a human pace (SCF iterations and
# optimization cycles are slowed down, everything else streams through), then
# drops the auxiliary files a real run would leave behind next to the input.
#
#   FAKE_ORCA_SRC=/path/to/real-run-dir   (must contain <stem>.out)
#   FAKE_ORCA_SCF_DELAY=0.25              seconds per SCF iteration line
#   FAKE_ORCA_CYCLE_DELAY=1.0             seconds per GEOMETRY OPTIMIZATION CYCLE
#
# Used only by record-live.sh. Operates on copies in a scratch dir; never
# touches the original files.
set -euo pipefail

src="${FAKE_ORCA_SRC:?set FAKE_ORCA_SRC}"
scf_delay="${FAKE_ORCA_SCF_DELAY:-0.25}"
cycle_delay="${FAKE_ORCA_CYCLE_DELAY:-1.0}"
out="$(find "$src" -maxdepth 1 -name '*.out' | head -n 1)"
[[ -n "$out" ]] || { printf 'fake-orca: no .out in %s\n' "$src" >&2; exit 2; }

scf_re='^[[:space:]]+[0-9]+[[:space:]]+-[0-9]+\.[0-9]+[[:space:]]'
while IFS= read -r line || [[ -n "$line" ]]; do
  printf '%s\n' "$line"
  if [[ "$line" =~ $scf_re ]]; then
    sleep "$scf_delay"
  elif [[ "$line" == *"GEOMETRY OPTIMIZATION CYCLE"* ]]; then
    sleep "$cycle_delay"
  fi
done < "$out"

# Leave the auxiliary files (trajectory, final xyz, hessian, ...) in the cwd,
# as ORCA would. Only files not already present, and never the .inp/.out.
find "$src" -maxdepth 2 -type f ! -name '*.inp' ! -name '*.out' -print0 |
  while IFS= read -r -d '' f; do cp -n "$f" ./; done
