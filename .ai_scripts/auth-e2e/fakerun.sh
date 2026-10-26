#!/usr/bin/env bash
# One tracked fake-ORCA run on a staged COPY of the example input.
#   fakerun.sh <workdir> <experiment> [dftstream run flags...]
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$here/../.." && pwd)"
src="$repo/.examples/opt-freq_ma1_r2scan3c"
work="$1"; exp="$2"; shift 2
mkdir -p "$work"
cp "$src/opt-freq_ma1_r2scan3c.inp" "$work/"
cd "$work"
FAKE_ORCA_SRC="$src" FAKE_ORCA_SCF_DELAY="${FAKE_ORCA_SCF_DELAY:-0}" FAKE_ORCA_CYCLE_DELAY="${FAKE_ORCA_CYCLE_DELAY:-0}" \
  exec "$here/cli.sh" run -orca "$repo/.ai_scripts/readme-screenshots/fake-orca.sh" -exp "$exp" -artifacts io "$@" opt-freq_ma1_r2scan3c.inp
