#!/usr/bin/env bash
# release-checklist.sh — pre-release verification, run on the tagged commit.
#
# Usage:
#   scripts/release-checklist.sh [vX.Y.Z]
#
# With no argument the tag is derived from HEAD (git describe
# --exact-match), i.e. run it right after `git tag vX.Y.Z`.
#
# Checks:
#   1. HEAD is the tagged commit.
#   2. CHANGELOG.md has a `## vX.Y.Z` heading for the tag.
#   3. The wrapper builds with the version stamped and
#      `dftstream version` reports the tag.
#   4. `go test ./...` is green (corpus fixtures required).
#   5. The goreleaser config is valid (skipped when goreleaser is not
#      installed — CI runs it via the goreleaser action anyway).
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

step() { printf '\n==> %s\n' "$*"; }
ok()   { printf 'OK: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# --- resolve the tag --------------------------------------------------
tag=${1:-}
if [ -z "$tag" ]; then
  tag=$(git describe --tags --exact-match HEAD 2>/dev/null) ||
    fail "HEAD is not tagged and no tag was given.
  fix: run on the tagged commit, or pass the tag: scripts/release-checklist.sh vX.Y.Z"
fi
case "$tag" in
  v[0-9]*) ;;
  *) fail "'$tag' does not look like a version tag (expected vX.Y.Z)." ;;
esac

step "Checking tag $tag"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null ||
  fail "tag $tag does not exist.
  fix: git tag $tag"

head_sha=$(git rev-parse HEAD)
tag_sha=$(git rev-parse "$tag^{commit}")
if [ "$head_sha" != "$tag_sha" ]; then
  fail "HEAD ($head_sha) is not the commit tagged $tag ($tag_sha).
  fix: git checkout $tag  # the checklist verifies the tagged tree, not this one"
fi
ok "HEAD is the commit tagged $tag"

# --- 1. CHANGELOG heading ---------------------------------------------
step "Checking CHANGELOG.md heading"
if ! grep -Eq "^## ${tag}( |\$)" CHANGELOG.md; then
  fail "CHANGELOG.md has no '## $tag' heading.
  fix: add a '## $tag (YYYY-MM-DD)' section describing this release"
fi
ok "CHANGELOG.md has a '## $tag' heading"

# --- 2. build with the version stamped --------------------------------
step "Building wrapper with VERSION=$tag"
make -C wrapper build VERSION="$tag" ||
  fail "wrapper build failed (see output above)"

version_out=$(./wrapper/bin/dftstream version)
printf '%s\n' "$version_out"
case "$version_out" in
  "dftstream $tag"*) ok "dftstream version reports $tag" ;;
  *) fail "'dftstream version' does not report the tag.
  got:  $version_out
  want: dftstream $tag ...
  fix: the version stamp is injected via -ldflags; check wrapper/Makefile LDFLAGS" ;;
esac

# --- 3. go test --------------------------------------------------------
step "Running go test ./... (corpus required)"
(cd wrapper && DFTSTREAM_REQUIRE_CORPUS=1 go test ./...) ||
  fail "go test ./... failed"
ok "go test ./... green"

# --- 4. goreleaser config ----------------------------------------------
step "Validating goreleaser config"
if command -v goreleaser >/dev/null 2>&1; then
  goreleaser check || fail "goreleaser config is invalid"
  ok "goreleaser config valid"
else
  echo "SKIP: goreleaser not installed; the Release workflow validates it in CI."
fi

printf '\nAll release checks passed for %s.\n' "$tag"
