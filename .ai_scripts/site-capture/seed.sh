#!/usr/bin/env bash
# Seed a Convex backend with the repo's own .examples/ ORCA outputs, laid out
# the way `dftstream import-experiments` wants:
#
#   <root>/<experiment>/<run>/<stem>.{inp,out,...}
#
# The staged root is what the UI shows as each run's input-file path, so it is
# a plausible scratch location rather than a giveaway temp directory.
#
# Usage:
#   DFTSTREAM_TRACKER_URL=convex+http://127.0.0.1:3310 .ai_scripts/site-capture/seed.sh
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." >/dev/null 2>&1 && pwd)"
src="$repo_dir/.examples"
root="${OS_SEED_ROOT:-/tmp/scratch/$USER}"
bin="${DFTSTREAM_BIN:-$repo_dir/wrapper/bin/dftstream}"

if [[ ! -d "$src" ]]; then
  printf 'no .examples directory at %s\n' "$src" >&2
  exit 1
fi
if [[ ! -x "$bin" ]]; then
  printf 'no dftstream binary at %s (build it with: cd wrapper && make build)\n' "$bin" >&2
  exit 1
fi

# Copy every regular file from the example run dir and any one-level
# subfolders (slurm/, stuff/) flat into the run directory, which is how the
# importer reads it. macOS metadata is skipped.
stage() {
  local src_run="$src/$1" out="$root/$2/$3"
  mkdir -p "$out"
  find "$src_run" -maxdepth 2 -type f ! -name '.DS_Store' ! -name '._*' -print0 \
  | while IFS= read -r -d '' f; do
      cp -n "$f" "$out/" 2>/dev/null || true
    done
}

rm -rf "$root"

# One meaty experiment carries the whole transition-state story; the scans and
# isomerization fill the experiment index out to six cards.
stage opt-freq_ma1_r2scan3c        malonaldehyde-tautomerization opt-freq-r2scan-3c
stage optts_ma2-r1_r2scan3c_2_009  malonaldehyde-tautomerization optts-r2scan-3c
stage irc_malonaldehyde_xtb        malonaldehyde-tautomerization irc-gfn2-xtb
stage nbo_ma1_pbe-svp              malonaldehyde-tautomerization nbo-pbe-def2svp
stage goat_ma1_xtb                 malonaldehyde-tautomerization goat-conformers-xtb
stage neb-ci_hcn-hnc_xtb           hcn-hnc-isomerization         neb-ci-gfn2-xtb
stage surfscan_h2co_xtb            h2co-torsion-scan             relaxed-scan-xtb
stage surfscan2d_h2o_xtb           h2o-bend-stretch-2d-scan      scan2d-gfn2-xtb
stage surfscan2d_h2co_xtb          h2co-2d-surface               scan2d-gfn2-xtb
stage surfscan3d_h2o_xtb           h2o-3d-surface                scan3d-gfn2-xtb

printf 'staged at %s\n' "$root"
exec "$bin" import-experiments -artifacts medium "$root"
