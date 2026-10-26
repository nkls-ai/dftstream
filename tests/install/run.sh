#!/usr/bin/env bash
# tests/install/run.sh - run the install-script end-to-end test inside
# a clean ubuntu docker container, against the current working tree.
#
# Usage:
#   tests/install/run.sh              # build image + run test
#   tests/install/run.sh --rebuild    # force a fresh image build
#   tests/install/run.sh --shell      # drop into a shell in the container
#
# The container bind-mounts this repo read-only at /workspace and runs
# tests/install/test.sh as an unprivileged user. Any state the test
# creates (clones, builds, configs) lives inside the container and is
# discarded on exit.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(cd -- "$script_dir/../.." >/dev/null 2>&1 && pwd)"

image_tag="${DFTSTREAM_INSTALL_TEST_IMAGE:-dftstream-install-test:latest}"
rebuild=0
shell=0

while (($#)); do
  case "$1" in
    --rebuild) rebuild=1; shift ;;
    --shell)   shell=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  printf 'error: docker is required.\n' >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  printf 'error: docker daemon is not reachable. Start Docker Desktop and rerun.\n' >&2
  exit 2
fi

if (( rebuild )) || ! docker image inspect "$image_tag" >/dev/null 2>&1; then
  printf '▶ Building %s\n' "$image_tag"
  docker build -t "$image_tag" "$script_dir"
fi

# The repo gets mounted read-only because the test should not need to
# write into the working tree. Anything it does write lives under the
# sandbox HOME inside the container.
common_args=(
  --rm
  -v "$repo_root:/workspace:ro"
)

if (( shell )); then
  printf '▶ Opening shell in %s\n' "$image_tag"
  exec docker run -it "${common_args[@]}" "$image_tag" bash
fi

printf '▶ Running install test in %s\n' "$image_tag"
exec docker run "${common_args[@]}" "$image_tag"
