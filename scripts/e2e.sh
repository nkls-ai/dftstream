#!/usr/bin/env bash
# scripts/e2e.sh — end-to-end smoke test for DFTStream.
#
# Walks every moving part: wrapper build, ORCA passthrough, per-level
# artifact capture, concurrent writers, noop backend swap, Convex query
# read-back. Designed to be safe to re-run.
#
# Requirements:
#   - Convex local backend running on 127.0.0.1:3210 (see db/AGENTS.md)
#   - Go toolchain
#   - ORCA binary, with its path in $DFTSTREAM_ORCA
#   - python3 for JSON parsing
#
# Usage:
#   DFTSTREAM_ORCA=/path/to/orca scripts/e2e.sh

set -euo pipefail

# ---------- locations ----------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
WRAPPER_DIR="$REPO_ROOT/wrapper"

CONVEX_URL="${DFTSTREAM_TRACKER_URL_HTTP:-http://127.0.0.1:3210}"
EXP_NAME="e2e-$(date +%Y%m%d-%H%M%S)-$$"
TMPDIR_SELF="$(mktemp -d -t dftstream-e2e-XXXXXX)"
BIN="$TMPDIR_SELF/dftstream"

PASS=0
FAIL=0

cleanup() {
  rm -rf "$TMPDIR_SELF"
}
trap cleanup EXIT

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

check() {
  local name="$1"; shift
  if "$@"; then
    green "  ✓ $name"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

# ---------- pre-flight ----------

bold "▶ Pre-flight checks"

if [[ -z "${DFTSTREAM_ORCA:-}" ]]; then
  red "DFTSTREAM_ORCA is not set."
  echo  "  Set it to your ORCA binary, e.g."
  echo  "  DFTSTREAM_ORCA=/path/to/orca scripts/e2e.sh"
  exit 2
fi
if [[ ! -x "$DFTSTREAM_ORCA" ]]; then
  red "DFTSTREAM_ORCA=$DFTSTREAM_ORCA is not executable."
  exit 2
fi
dim "  ORCA: $DFTSTREAM_ORCA"

if ! command -v go    >/dev/null; then red "go not on PATH"; exit 2; fi
if ! command -v python3 >/dev/null; then red "python3 not on PATH"; exit 2; fi
if ! curl -sfo /dev/null "$CONVEX_URL/version"; then
  red "Convex backend not reachable at $CONVEX_URL/version."
  echo "  Start it from db/ with:"
  echo "    TZ=UTC CONVEX_TMPDIR=\$PWD/.convex/tmp bunx convex dev"
  exit 2
fi
dim "  Convex: $CONVEX_URL"
dim "  Experiment name: $EXP_NAME"
dim "  Workdir: $TMPDIR_SELF"

# ---------- build ----------

bold "▶ Build wrapper"
( cd "$WRAPPER_DIR" && go build -o "$BIN" ./cmd/dftstream )
green "  built $BIN"

# ---------- helper: Convex HTTP query ----------

cx_call() {
  # cx_call <mutation|query> <module:fn> <json-args>
  local kind="$1" path="$2" args="$3"
  curl -sf "$CONVEX_URL/api/$kind" \
    -H 'content-type: application/json' \
    -d "{\"path\":\"$path\",\"args\":$args,\"format\":\"json\"}"
}

# Run a python helper that hits Convex and prints the value.
cx_value() {
  python3 - "$@" <<'PY'
import json, os, sys, urllib.request
kind, path, args = sys.argv[1], sys.argv[2], sys.argv[3]
url = os.environ["CONVEX_URL"] + "/api/" + kind
req = urllib.request.Request(
    url,
    data=json.dumps({"path": path, "args": json.loads(args), "format": "json"}).encode(),
    headers={"content-type": "application/json"},
)
resp = json.load(urllib.request.urlopen(req))
if resp.get("status") != "success":
    sys.stderr.write(f"convex {path} error: {resp.get('errorMessage')}\n")
    sys.exit(1)
json.dump(resp["value"], sys.stdout)
PY
}
export CONVEX_URL

# ---------- 1. wrapper passes ORCA stdout through ----------

bold "▶ Stdout passthrough (single-point HF)"
SP_DIR="$TMPDIR_SELF/sp"
mkdir -p "$SP_DIR"
cat > "$SP_DIR/h2.inp" <<'INP'
! HF DEF2-SVP
* xyz 0 1
H 0.0 0.0 0.0
H 0.0 0.0 0.74
*
INP
( cd "$SP_DIR" && "$BIN" run h2.inp --exp "$EXP_NAME" --name sp-passthru > stdout.captured 2>err.log )
check "ORCA exit 0" test -s "$SP_DIR/stdout.captured"
check "stdout contains 'TERMINATED NORMALLY'" grep -q "ORCA TERMINATED NORMALLY" "$SP_DIR/stdout.captured"

# ---------- 2. artifact levels ----------

bold "▶ Artifact levels"
LVL_DIR="$TMPDIR_SELF/levels"
mkdir -p "$LVL_DIR"

for lvl in none essential medium all; do
  run_dir="$LVL_DIR/$lvl"
  mkdir -p "$run_dir"
  cat > "$run_dir/h2.inp" <<'INP'
! HF DEF2-SVP Opt Freq
* xyz 0 1
H 0.0 0.0 0.0
H 0.0 0.0 0.80
*
INP
  ( cd "$run_dir" && "$BIN" run h2.inp --exp "$EXP_NAME" --name "L-$lvl" --artifacts "$lvl" > out 2> err )
done

# Lookup the experiment id once and reuse.
EXP_ID="$(cx_value query experiments:getByName "{\"name\":\"$EXP_NAME\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["_id"])')"
dim "  experiment id: $EXP_ID"

runs_json="$(cx_value query runs:listByExperiment "{\"experimentId\":\"$EXP_ID\"}")"

# For each level, fetch the artifact names and assert the right set of
# extensions is present / absent. This is more robust than exact counts
# because ORCA's output file set depends on the input.
check_artifacts() {
  # check_artifacts <level> <must-include-globs csv> <must-exclude-globs csv>
  local lvl="$1" must="$2" must_not="$3"
  local rid
  rid="$(python3 -c '
import sys, json
for r in json.loads(sys.argv[1]):
    if r["name"] == sys.argv[2]:
        print(r["_id"]); break
' "$runs_json" "L-$lvl")"
  if [[ -z "$rid" ]]; then
    red "  ✗ $lvl: no run found"
    FAIL=$((FAIL + 1))
    return
  fi
  local names
  names="$(cx_value query artifacts:listForRun "{\"runId\":\"$rid\"}" \
    | python3 -c 'import sys,json; print(" ".join(a["name"] for a in json.load(sys.stdin)))')"
  local ok=1 detail=""
  if [[ -n "$must" ]]; then
    local IFS=,
    for pat in $must; do
      [[ "$names " == *"$pat "* ]] || { ok=0; detail="missing $pat"; }
    done
  fi
  if [[ -n "$must_not" ]]; then
    local IFS=,
    for pat in $must_not; do
      [[ "$names " == *"$pat "* ]] && { ok=0; detail="should not include $pat"; }
    done
  fi
  if (( ok == 1 )); then
    green "  ✓ $lvl level [$names]"
    PASS=$((PASS + 1))
  else
    red   "  ✗ $lvl level: $detail (got [$names])"
    FAIL=$((FAIL + 1))
  fi
}

# Note: file names are <stem>.<ext>; we use "h2" stem. The captured
# stdout artifact is "<stem>.stdout.out".
check_artifacts none ""                                                                ""
check_artifacts essential "h2.inp,h2.stdout.out,h2.xyz"                                  "h2.property.txt,h2.engrad,h2.gbw"
check_artifacts medium    "h2.inp,h2.stdout.out,h2.xyz,h2.property.txt,h2.bibtex"        "h2.engrad,h2.opt,h2.gbw,h2.densities,h2.densitiesinfo"
check_artifacts all       "h2.inp,h2.stdout.out,h2.xyz,h2.property.txt,h2.engrad,h2.opt" "h2.gbw,h2.densities,h2.densitiesinfo"

# ---------- 3. metrics + events captured ----------

bold "▶ Metrics + events for one opt run"
opt_rid="$(python3 -c '
import sys, json
for r in json.loads(sys.argv[1]):
    if r["name"] == "L-medium":
        print(r["_id"]); break
' "$runs_json")"

ev_count="$(cx_value query events:listForRun "{\"runId\":\"$opt_rid\"}" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
scf_count="$(cx_value query metrics:byRunKey "{\"runId\":\"$opt_rid\",\"key\":\"scf_iter_energy\"}" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
geom_count="$(cx_value query geometries:listForRun "{\"runId\":\"$opt_rid\"}" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
run_row="$(cx_value query runs:get "{\"runId\":\"$opt_rid\"}")"
last_e="$(echo "$run_row" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r.get("lastEnergy"))')"
status="$(echo "$run_row" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r["status"])')"

check "run status is 'finished'"     [ "$status" = "finished" ]
check "events recorded (>5)"         [ "$ev_count" -gt 5 ]
check "scf_iter metric points (>5)"  [ "$scf_count" -gt 5 ]
check "geometries (>=2)"             [ "$geom_count" -ge 2 ]
check "lastEnergy in expected H2 HF range" \
  python3 -c "import sys; v=float(sys.argv[1]); sys.exit(0 if -1.2 < v < -1.0 else 1)" "$last_e"

# ---------- 4. concurrent writers ----------

bold "▶ Concurrent writers (3 in parallel)"
PAR_DIR="$TMPDIR_SELF/par"
mkdir -p "$PAR_DIR"
for i in 1 2 3; do
  mkdir -p "$PAR_DIR/$i"
  cat > "$PAR_DIR/$i/h.inp" <<'INP'
! HF DEF2-SVP
* xyz 0 1
H 0.0 0.0 0.0
H 0.0 0.0 0.74
*
INP
done

(
  cd "$PAR_DIR/1" && "$BIN" run h.inp --exp "$EXP_NAME" --name par-1 > out 2> err
) &
(
  cd "$PAR_DIR/2" && "$BIN" run h.inp --exp "$EXP_NAME" --name par-2 > out 2> err
) &
(
  cd "$PAR_DIR/3" && "$BIN" run h.inp --exp "$EXP_NAME" --name par-3 > out 2> err
) &
wait

par_runs="$(cx_value query runs:listByExperiment "{\"experimentId\":\"$EXP_ID\"}" | python3 -c '
import sys, json
rs = [r for r in json.load(sys.stdin) if r["name"].startswith("par-")]
ok = all(r["status"] == "finished" and r.get("exitCode") == 0 for r in rs)
print(len(rs), "ok" if ok else "bad")
')"
check "3 concurrent runs finished cleanly" [ "$par_runs" = "3 ok" ]

# ---------- 5. noop backend (no data lands) ----------

bold "▶ Noop tracker swap"
NOOP_DIR="$TMPDIR_SELF/noop"
NOOP_EXP="$EXP_NAME-noop-only"
mkdir -p "$NOOP_DIR"
cat > "$NOOP_DIR/h.inp" <<'INP'
! HF DEF2-SVP
* xyz 0 1
H 0.0 0.0 0.0
H 0.0 0.0 0.74
*
INP
( cd "$NOOP_DIR" && "$BIN" run h.inp --tracker-url noop:// --exp "$NOOP_EXP" --name noop > out 2> err )

noop_exp="$(cx_value query experiments:getByName "{\"name\":\"$NOOP_EXP\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin))')"
check "noop:// writes nothing to Convex" [ "$noop_exp" = "None" ] || [ "$noop_exp" = "null" ]

# ---------- 6. unit tests ----------

bold "▶ Wrapper unit tests"
( cd "$WRAPPER_DIR" && go test ./... >"$TMPDIR_SELF/gotest.log" 2>&1 )
check "go test ./... passes" tail -1 "$TMPDIR_SELF/gotest.log" >/dev/null

# ---------- summary ----------

echo
bold "▶ Summary"
echo "  experiment created on backend: $EXP_NAME"
echo "  pass: $PASS    fail: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  red "FAIL ($FAIL)"
  exit 1
fi
green "OK ($PASS)"
