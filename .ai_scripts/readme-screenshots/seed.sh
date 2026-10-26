#!/usr/bin/env bash
# Seed the LOCAL Convex backend (127.0.0.1:3210) with real ORCA outputs for the
# README screenshots. Stages .examples/ and example_logs/ into the
#   <root>/<experiment>/<run>/<stem>.{inp,out,...}
# layout `dftstream import-experiments` wants, then imports.
#
# Experiment names are chosen to be distinct from the site-capture seed, so
# they land as the newest cards on the experiments page.
#
# Usage: .ai_scripts/readme-screenshots/seed.sh
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." >/dev/null 2>&1 && pwd)"
examples="$repo_dir/.examples"
logs="$repo_dir/example_logs"
root="${OS_SEED_ROOT:-/tmp/orca-projects}"
bin="${DFTSTREAM_BIN:-$repo_dir/wrapper/bin/dftstream}"
tracker="convex+http://127.0.0.1:3210"   # local only, never a cloud deployment

[[ -d "$examples" ]] || { printf 'no .examples at %s\n' "$examples" >&2; exit 1; }
[[ -x "$bin" ]] || { printf 'no dftstream binary at %s (cd wrapper && make build)\n' "$bin" >&2; exit 1; }

# stage_dir SRC_DIR EXPERIMENT RUN — copy an .examples run (plus one level of
# subfolders) flat into the run directory.
stage_dir() {
  local out="$root/$2/$3"
  mkdir -p "$out"
  find "$1" -maxdepth 2 -type f ! -name '.DS_Store' ! -name '._*' -print0 |
    while IFS= read -r -d '' f; do cp -n "$f" "$out/"; done
}

# stage_stem STEM EXPERIMENT RUN — copy every example_logs/STEM.* file.
stage_stem() {
  local out="$root/$2/$3"
  mkdir -p "$out"
  cp -n "$logs/$1".* "$out/"
  if compgen -G "$logs/$1_*" >/dev/null; then cp -n "$logs/$1"_* "$out/"; fi
}

bun "$(dirname -- "${BASH_SOURCE[0]}")/reset.ts" \
  malonaldehyde-proton-transfer malonaldehyde-nbo-analysis acrylophenone-conformers organoselenium-radical-ts \
  hcn-hnc-isomerization-neb formaldehyde-pes-scans water-pes-scans water-hf-basis-convergence \
  co2-protonation-ts dicopper-co2-activation-ts b1-open-shell-singlet
rm -rf "$root"

# ma1 = acrylophenone (C10H8O); ma2-r1 is a C16H17OSe radical; the IRC is real malonaldehyde.
stage_dir "$examples/goat_ma1_xtb"                acrylophenone-conformers      goat-gfn2
stage_dir "$examples/opt-freq_ma1_r2scan3c"       acrylophenone-conformers      opt-freq
stage_dir "$examples/nbo_ma1_pbe-svp"             acrylophenone-conformers      nbo-pbe
stage_dir "$examples/optts_ma2-r1_r2scan3c_2_009" organoselenium-radical-ts     optts-r2scan3c
stage_dir "$examples/irc_malonaldehyde_xtb"       malonaldehyde-proton-transfer irc-gfn2

stage_dir "$examples/neb-ci_hcn-hnc_xtb"          hcn-hnc-isomerization-neb     neb-ci-xtb

stage_dir "$examples/surfscan_h2co_xtb"           formaldehyde-pes-scans        torsion-1d
stage_dir "$examples/surfscan2d_h2co_xtb"         formaldehyde-pes-scans        scan-2d

stage_dir "$examples/surfscan2d_h2o_xtb"          water-pes-scans               scan-2d
stage_dir "$examples/surfscan3d_h2o_xtb"          water-pes-scans               scan-3d

stage_stem water_hf_def2svp_opt_freq              water-hf-basis-convergence    opt-freq-svp
stage_stem water_hf_def2svp_sp                    water-hf-basis-convergence    sp-svp
stage_stem water_hf_def2tzvp_sp                   water-hf-basis-convergence    sp-tzvp

stage_stem TS_A1_CO2_bending_H_plus_Trial_3       dicopper-co2-activation-ts    optts-m06
stage_stem sp_b1-oss_wb97x-v-qzvpp                b1-open-shell-singlet         sp-qzvpp

printf 'staged at %s\n' "$root"
exec "$bin" import-experiments -artifacts medium -tracker-url "$tracker" "$root"
