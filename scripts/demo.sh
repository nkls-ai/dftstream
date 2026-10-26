#!/usr/bin/env bash
# DFTStream end-to-end demo.
#
# Runs a small geometry-optimization + frequency calculation on twisted
# acrolein (CH2=CH-CHO) — a 7-atom conjugated system that planarizes
# during the opt. Showcases:
#
#   • a few-cycle opt (visible structure evolution in the UI)
#   • non-trivial HOMO/LUMO (π / π* of the C=C-C=O system)
#   • per-cycle orbital cubes — scrub the structure and watch the
#     HOMO/LUMO isosurfaces follow each cycle's wavefunction
#   • thermochemistry (Gibbs G, G-E(El)) from the Freq step
#
# Run time on a workstation: ~1-3 minutes for HF/def2-SVP.
#
# Requirements:
#   • DFTSTREAM_ORCA pointing at orca (and orca_plot in the same dir)
#   • a local Convex backend running (dftstream-db &  or  bun run dev in db/)
#   • the dftstream wrapper on PATH, or set DFTSTREAM_BIN to a
#     pre-built binary
#
# Usage:
#   DFTSTREAM_ORCA=/path/to/orca scripts/demo.sh
#   DFTSTREAM_ORCA=/path/to/orca scripts/demo.sh --molecule methanol
#   DFTSTREAM_ORCA=/path/to/orca scripts/demo.sh --no-percycle
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_dir="$(cd -- "$script_dir/.." >/dev/null 2>&1 && pwd)"

molecule="acrolein"
orbitals="per-cycle"
artifacts_level="medium"
ui_url="${DFTSTREAM_UI_URL:-http://localhost:3000}"
tracker_url="${DFTSTREAM_TRACKER_URL:-convex+http://127.0.0.1:3210}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --molecule)     molecule="$2"; shift 2 ;;
    --molecule=*)   molecule="${1#*=}"; shift ;;
    --no-percycle)  orbitals="final"; shift ;;
    --orbitals)     orbitals="$2"; shift 2 ;;
    --artifacts)    artifacts_level="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      printf 'unknown flag: %s\n' "$1" >&2
      exit 2 ;;
  esac
done

# Pretty output
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  bold() { printf '\033[1m%s\033[0m\n' "$*"; }
  ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
  warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
  err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
  dim()  { printf '  \033[2m%s\033[0m\n' "$*"; }
else
  bold() { printf '%s\n' "$*"; }
  ok()   { printf '  ok: %s\n' "$*"; }
  warn() { printf '  warning: %s\n' "$*"; }
  err()  { printf '  error: %s\n' "$*" >&2; }
  dim()  { printf '  %s\n' "$*"; }
fi

bold "▶ Pre-flight"
if [[ -z "${DFTSTREAM_ORCA:-}" ]]; then
  err "DFTSTREAM_ORCA not set"
  printf '    Set it to your ORCA executable, e.g.\n' >&2
  printf '    DFTSTREAM_ORCA=/path/to/orca %s\n' "$0" >&2
  exit 2
fi
if [[ ! -x "$DFTSTREAM_ORCA" ]]; then
  err "ORCA executable not accessible at $DFTSTREAM_ORCA"
  exit 2
fi
ok "ORCA: $DFTSTREAM_ORCA"

# Resolve the wrapper binary
if [[ -n "${DFTSTREAM_BIN:-}" && -x "$DFTSTREAM_BIN" ]]; then
  bin="$DFTSTREAM_BIN"
elif command -v dftstream >/dev/null 2>&1; then
  bin="$(command -v dftstream)"
else
  bold "▶ Build wrapper (one-time, ~5s)"
  bin="$(mktemp -t dftstream-XXXX)"
  (cd "$repo_dir/wrapper" && go build -o "$bin" ./cmd/dftstream)
  ok "built $bin"
fi

# Sanity-check the tracker host
host_port="${tracker_url#convex+http://}"
host_port="${host_port#convex+https://}"
if ! curl -s -o /dev/null --max-time 2 "http://${host_port}/version"; then
  warn "tracker at $tracker_url is not responding — start it with: dftstream-db & (or 'bun run dev' in db/)"
fi

# Materialize the input file
workdir="$(mktemp -d -t dftstream-demo-XXXX)"
case "$molecule" in
  acrolein)
    # CH2=CH-CHO starting from a twist that breaks π conjugation; the
    # opt planarizes the molecule across ~6-12 cycles, and the HOMO/LUMO
    # delocalize as the C=C and C=O π systems align.
    inp="$workdir/acrolein.inp"
    cat > "$inp" <<'EOF'
! HF def2-SVP Opt Freq TightSCF
%maxcore 1500
%pal nprocs 1 end
* xyz 0 1
C   0.000   0.000   0.000
O   1.215   0.000   0.000
H  -0.498   0.890   0.000
C  -0.800  -1.200   0.000
H  -0.300  -2.000   0.300
C  -2.150  -0.800   1.200
H  -2.500  -1.500   2.000
H  -2.700  -0.000   1.300
*
EOF
    runname="acrolein-hf-opt-freq"
    expname="demo-acrolein"
    ;;
  methanol)
    # Small + fast: CH3OH with a strained OH angle and rotated dihedral.
    inp="$workdir/methanol.inp"
    cat > "$inp" <<'EOF'
! HF def2-SVP Opt Freq TightSCF
%maxcore 1500
%pal nprocs 1 end
* xyz 0 1
C   0.000   0.000   0.000
O   1.400   0.000   0.000
H   1.700  -0.900   0.500
H  -0.400   1.030   0.000
H  -0.400  -0.500   0.900
H  -0.400  -0.500  -0.900
*
EOF
    runname="methanol-hf-opt-freq"
    expname="demo-methanol"
    ;;
  *)
    err "unknown --molecule '$molecule' (try: acrolein, methanol)"
    exit 2
    ;;
esac

bold "▶ Run"
dim "molecule:        $molecule"
dim "input:           $inp"
dim "experiment:      $expname"
dim "run name:        $runname"
dim "orbital mode:    $orbitals  (per-cycle = HOMO/LUMO cubes for every opt cycle)"
dim "artifact level:  $artifacts_level"

start_s=$(date +%s)
DFTSTREAM_TRACKER_URL="$tracker_url" \
  "$bin" run "$inp" \
    --exp "$expname" \
    --name "$runname" \
    --orca "$DFTSTREAM_ORCA" \
    --artifacts "$artifacts_level" \
    --orbitals "$orbitals" \
    > "$workdir/$(basename "$inp" .inp).stdout.out" \
    2> >(tee "$workdir/dftstream.stderr" >&2)
end_s=$(date +%s)
elapsed=$(( end_s - start_s ))
ok "ORCA finished in ${elapsed}s"
ok "wrapper messages:"
sed 's/^/    /' "$workdir/dftstream.stderr"

bold "▶ Browse the result"
dim "Open the UI:     $ui_url"
dim "Experiment:      $expname"
dim "Run name:        $runname"
dim "Workdir:         $workdir"
dim ""
dim "What to try in the Structure tab:"
dim "  • drag the slider through the opt cycles"
dim "  • pick HOMO / LUMO from the Orbital dropdown"
if [[ "$orbitals" == "per-cycle" ]]; then
  dim "  • watch the isosurfaces re-shape on each cycle (per-cycle orbitals)"
else
  dim "  • the isosurfaces stay locked to the final wavefunction in this mode"
fi
dim "  • Space toggles the looping playback"
