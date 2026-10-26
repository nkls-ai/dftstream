#!/usr/bin/env bash
# tests/install/checksum-test.sh - unit-style test of install.sh's
# release-binary download path, including sha256 verification against
# checksums.txt.
#
# No network, no docker, no build toolchain: a fake GitHub "API" and a
# fake release directory live on disk and are served to install.sh over
# file:// URLs via DFTSTREAM_API_BASE. The fake release contains a
# one-line shell script standing in for the dftstream binary.
#
# Cases:
#   1. Valid archive + matching checksums.txt  -> install succeeds.
#   2. Corrupted archive (checksum mismatch)   -> install aborts, binary
#      is NOT installed, and there is no fall-back to a source build.
#   3. checksums.txt missing from the release  -> install aborts.
#
# Runs standalone (`bash tests/install/checksum-test.sh`) and as the
# first section of tests/install/test.sh.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(cd -- "$script_dir/../.." >/dev/null 2>&1 && pwd)"
install_sh="$repo_root/scripts/install.sh"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  bold()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
  ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
  red()   { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
  dim()   { printf '  \033[2m%s\033[0m\n' "$*"; }
else
  bold()  { printf '\n== %s ==\n' "$*"; }
  ok()    { printf '  ok: %s\n' "$*"; }
  red()   { printf '  FAIL: %s\n' "$*" >&2; }
  dim()   { printf '  %s\n' "$*"; }
fi

sandbox="$(mktemp -d -t dftstream-checksum-XXXXXX)"
cleanup() { rm -rf "$sandbox"; }
trap cleanup EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Same Os/Arch mapping as install.sh's detect_platform + the goreleaser
# archive name template, so the mocked asset matches what install.sh
# looks for on the machine running this test.
case "$(uname -s)" in
  Linux*)  t_os="Linux" ;;
  Darwin*) t_os="Darwin" ;;
  *) red "unsupported test OS: $(uname -s)"; exit 2 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  t_arch="x86_64" ;;
  arm64|aarch64) t_arch="arm64" ;;
  *) red "unsupported test arch: $(uname -m)"; exit 2 ;;
esac
asset="dftstream_0.0.0_${t_os}_${t_arch}.tar.gz"

# ----------------------------------------------------------------------
# Build the mocked release: archive + checksums.txt + API JSON.
# ----------------------------------------------------------------------

bold "Stage mocked GitHub release"
mock="$sandbox/mock"
release_dir="$mock/releases-download/v0.0.0"
api_dir="$mock/repos/nkls-ai/dftstream/releases"
mkdir -p "$release_dir" "$api_dir" "$sandbox/stage"

printf '#!/bin/sh\necho "dftstream version 0.0.0-checksum-test"\n' \
  > "$sandbox/stage/dftstream"
chmod +x "$sandbox/stage/dftstream"
tar -czf "$release_dir/$asset" -C "$sandbox/stage" dftstream
( cd "$release_dir" && printf '%s  %s\n' "$(sha256_of "$asset")" "$asset" > checksums.txt )

# The API response only needs the browser_download_url fields that
# install.sh greps for. `latest` is a file (not a directory) because
# curl fetches it as file://$mock/repos/.../releases/latest.
cat > "$api_dir/latest" <<EOF
{
  "tag_name": "v0.0.0",
  "assets": [
    { "browser_download_url": "file://$release_dir/$asset" },
    { "browser_download_url": "file://$release_dir/checksums.txt" }
  ]
}
EOF
dim "mock api:     file://$mock"
dim "mock release: $release_dir/$asset"

# run_install <case-name>
# Runs install.sh non-interactively against the mock in an isolated
# HOME, with bin/config dirs per case. Echoes nothing; the caller
# inspects $?, the log at $sandbox/<case>.log, and the bin dir.
run_install() {
  local case_name="$1"
  local home="$sandbox/$case_name/home"
  mkdir -p "$home"
  env -i \
    HOME="$home" \
    PATH="$PATH" \
    NO_COLOR=1 \
    DFTSTREAM_API_BASE="file://$mock" \
    bash "$install_sh" \
      --method binary \
      --mode online \
      --convex-url http://127.0.0.1:9 \
      --bin-dir "$sandbox/$case_name/bin" \
      --config-dir "$sandbox/$case_name/config" \
      --source "$sandbox/$case_name/src" \
      > "$sandbox/$case_name.log" 2>&1
}

# ----------------------------------------------------------------------
# Case 1: intact archive installs, and the log shows verification ran.
# ----------------------------------------------------------------------

bold "Case 1: valid checksum installs"
if ! run_install good; then
  red "install.sh failed on a valid mocked release"
  cat "$sandbox/good.log" >&2
  exit 1
fi
grep -q 'sha256 verified' "$sandbox/good.log" || {
  red "install log never mentions sha256 verification"
  cat "$sandbox/good.log" >&2
  exit 1
}
test -x "$sandbox/good/bin/dftstream" || {
  red "binary not installed after successful verification"
  exit 1
}
"$sandbox/good/bin/dftstream" | grep -q '0.0.0-checksum-test' || {
  red "installed binary is not the mocked one"
  exit 1
}
ok "verified + installed"

# ----------------------------------------------------------------------
# Case 2: corrupted archive must abort BEFORE install, no source fallback.
# ----------------------------------------------------------------------

bold "Case 2: corrupted archive is rejected"
printf 'garbage' >> "$release_dir/$asset"
if run_install corrupt; then
  red "install.sh accepted an archive whose checksum does not match"
  cat "$sandbox/corrupt.log" >&2
  exit 1
fi
grep -q 'Checksum mismatch' "$sandbox/corrupt.log" || {
  red "failure was not the checksum check"
  cat "$sandbox/corrupt.log" >&2
  exit 1
}
if [[ -e "$sandbox/corrupt/bin/dftstream" ]]; then
  red "binary was installed despite checksum mismatch"
  exit 1
fi
grep -q 'falling back to source build' "$sandbox/corrupt.log" && {
  red "checksum mismatch fell back to a source build — it must abort"
  exit 1
}
ok "mismatch aborts, nothing installed"

# Restore the archive for case 3.
tar -czf "$release_dir/$asset" -C "$sandbox/stage" dftstream

# ----------------------------------------------------------------------
# Case 3: release without checksums.txt is rejected.
# ----------------------------------------------------------------------

bold "Case 3: missing checksums.txt is rejected"
rm "$release_dir/checksums.txt"
if run_install nosums; then
  red "install.sh installed from a release without checksums.txt"
  cat "$sandbox/nosums.log" >&2
  exit 1
fi
grep -q 'checksums.txt' "$sandbox/nosums.log" || {
  red "failure did not mention checksums.txt"
  cat "$sandbox/nosums.log" >&2
  exit 1
}
if [[ -e "$sandbox/nosums/bin/dftstream" ]]; then
  red "binary was installed despite missing checksums.txt"
  exit 1
fi
ok "unverifiable release aborts, nothing installed"

bold "All checksum-verification checks passed"
