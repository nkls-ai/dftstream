#!/usr/bin/env bash
set -euo pipefail

# Install DFTStream. Defaults to downloading a prebuilt binary from
# the latest GitHub release and (for --mode local) cloning the source
# tree so the local Convex backend has its functions available. Fall
# back to building from source when no matching release exists or
# when --from-source is requested.

repo_slug="${DFTSTREAM_REPO_SLUG:-nkls-ai/dftstream}"
repo_url="${DFTSTREAM_REPO_URL:-https://github.com/${repo_slug}.git}"
ref="${DFTSTREAM_REF:-main}"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
source_dir="${DFTSTREAM_HOME:-$data_home/dftstream}"
bin_dir="${DFTSTREAM_BIN_DIR:-$HOME/.local/bin}"
config_dir="${DFTSTREAM_CONFIG_DIR:-$config_home/dftstream}"
mode="${DFTSTREAM_MODE:-ask}"           # local | online | ask
online_url="${DFTSTREAM_CONVEX_URL:-}"
install_bun="${DFTSTREAM_INSTALL_BUN:-ask}"
install_method="${DFTSTREAM_METHOD:-auto}"   # auto | binary | source
release_tag="${DFTSTREAM_RELEASE_TAG:-}"     # empty = latest
do_uninstall=0
do_purge=0

if [[ -n "${NO_COLOR:-}" || ! -t 2 ]]; then
  bold() { printf '%s\n' "$*" >&2; }
  ok() { printf 'success: %s\n' "$*" >&2; }
  warn() { printf 'warning: %s\n' "$*" >&2; }
  err() { printf 'error: %s\n' "$*" >&2; }
else
  bold() { printf '\033[1m%s\033[0m\n' "$*" >&2; }
  ok() { printf '\033[32msuccess:\033[0m %s\n' "$*" >&2; }
  warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
  err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
fi

usage() {
  cat >&2 <<'EOF'
Install DFTStream from GitHub.

Usage:
  curl -fsSL https://raw.githubusercontent.com/nkls-ai/dftstream/main/scripts/install.sh | bash

Options:
  --repo-slug <owner/repo>  GitHub repo slug. Defaults to nkls-ai/dftstream.
  --repo <url>              Git repo URL (used for source builds + local clones).
  --ref <ref>               Branch, tag, or commit for source builds. Defaults to main.
  --source <dir>            Source checkout directory.       Defaults to ~/.local/share/dftstream.
  --bin-dir <dir>           Binary directory.                Defaults to ~/.local/bin.
  --config-dir <dir>        Where to write config.json.      Defaults to ~/.config/dftstream.
  --mode <local|online|docker>
                            Backend choice (prompted if omitted).
                              local  - clone repo + install Convex deps + write config.
                              online - just write the Convex URL into config.
                              docker - point at a self-hosted Convex Docker container.
  --convex-url <url>        For --mode online/docker: the deployment URL to record.
  --method <auto|binary|source>
                            How to obtain dftstream.
                              auto   - try latest release binary, fall back to source.
                              binary - download release binary (fail if none).
                              source - clone + build from source (needs bun + go).
  --release <tag>           Specific release tag, e.g. v0.1.0. Defaults to latest.
  --install-bun             Install Bun automatically if it is missing.
  --no-install-bun          Cancel instead of installing Bun if it is missing.
  --uninstall               Remove installed binaries (dftstream, dftstream-db).
                            Keeps config and the source/data directory unless
                            --purge is also given.
  --purge                   With --uninstall: also delete the config directory
                            and the source checkout, INCLUDING any local Convex
                            database stored under it. Prompts for confirmation.
  -h, --help                Show this help.

Environment equivalents:
  DFTSTREAM_REPO_SLUG, DFTSTREAM_REPO_URL, DFTSTREAM_REF,
  DFTSTREAM_HOME, DFTSTREAM_BIN_DIR, DFTSTREAM_CONFIG_DIR,
  DFTSTREAM_MODE, DFTSTREAM_CONVEX_URL,
  DFTSTREAM_METHOD, DFTSTREAM_RELEASE_TAG,
  DFTSTREAM_INSTALL_BUN=1|0|ask,
  DFTSTREAM_API_BASE (GitHub API base URL override; used by the
                       install tests to mock releases — not for users)

Release downloads are verified against the release's checksums.txt
(sha256). A mismatch aborts the install.

EOF
}

while (($#)); do
  case "$1" in
    --repo-slug) repo_slug="${2:?missing value for --repo-slug}"; repo_url="https://github.com/${repo_slug}.git"; shift 2 ;;
    --repo) repo_url="${2:?missing value for --repo}"; shift 2 ;;
    --ref) ref="${2:?missing value for --ref}"; shift 2 ;;
    --source) source_dir="${2:?missing value for --source}"; shift 2 ;;
    --bin-dir) bin_dir="${2:?missing value for --bin-dir}"; shift 2 ;;
    --config-dir) config_dir="${2:?missing value for --config-dir}"; shift 2 ;;
    --mode) mode="${2:?missing value for --mode}"; shift 2 ;;
    --convex-url) online_url="${2:?missing value for --convex-url}"; shift 2 ;;
    --method) install_method="${2:?missing value for --method}"; shift 2 ;;
    --release) release_tag="${2:?missing value for --release}"; shift 2 ;;
    --install-bun) install_bun=1; shift ;;
    --no-install-bun) install_bun=0; shift ;;
    --uninstall) do_uninstall=1; shift ;;
    --purge) do_purge=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 2 ;;
  esac
done

case "$mode" in
  local|online|docker|ask) ;;
  *) err "Invalid --mode: $mode"; printf 'fix: use local, online, docker, or ask.\n' >&2; exit 2 ;;
esac
case "$install_method" in
  auto|binary|source) ;;
  *) err "Invalid --method: $install_method"; printf 'fix: use auto, binary, or source.\n' >&2; exit 2 ;;
esac
if [[ "$do_purge" == "1" && "$do_uninstall" != "1" ]]; then
  err "--purge only makes sense together with --uninstall."
  exit 2
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "$1 is required but was not found on PATH."
    case "$1" in
      git) printf 'fix: install Git or load it as a cluster module.\n' >&2 ;;
      go) printf 'fix: install Go 1.23+ or load a Go module.\n' >&2 ;;
      bun) printf 'fix: install Bun from https://bun.sh or load it as a cluster module.\n' >&2 ;;
      curl) printf 'fix: install curl.\n' >&2 ;;
      tar) printf 'fix: install tar.\n' >&2 ;;
    esac
    exit 2
  fi
}

ask_one() {
  local prompt="$1" default="$2" reply
  if [[ ! -r /dev/tty ]]; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s [%s] ' "$prompt" "$default" >/dev/tty
  IFS= read -r reply </dev/tty || reply=""
  printf '%s\n' "${reply:-$default}"
}

ask_yes_no() {
  local prompt="$1" reply
  if [[ ! -r /dev/tty ]]; then
    return 1
  fi
  while true; do
    printf '%s [y/N] ' "$prompt" >/dev/tty
    IFS= read -r reply </dev/tty || return 1
    case "$reply" in
      y|Y|yes|YES|Yes) return 0 ;;
      n|N|no|NO|No|"") return 1 ;;
      *) printf 'Please answer yes or no.\n' >/dev/tty ;;
    esac
  done
}

resolve_mode_interactive() {
  if [[ "$mode" != "ask" ]]; then return 0; fi
  if [[ ! -r /dev/tty ]]; then mode="local"; return 0; fi
  cat >/dev/tty <<'EOF'

Backend choice:
  local   - Run a local Convex backend on this machine. Needs Bun (the installer
            can fetch it for you). Best for laptops / single workstations.
            NOTE: will not work on headless servers or HPC nodes.
  online  - Point at an already-running Convex cloud deployment. No local
            Convex install needed; no Bun needed if using a release binary.
  docker  - Point at a self-hosted Convex backend running in a Docker
            container on your server. See db/docker/ for the compose file.

EOF
  while true; do
    local reply
    printf 'Choose backend (local/online/docker) [local]: ' >/dev/tty
    IFS= read -r reply </dev/tty || reply=""
    reply="${reply:-local}"
    case "$reply" in
      local|LOCAL|Local) mode="local"; return 0 ;;
      online|ONLINE|Online) mode="online"; return 0 ;;
      docker|DOCKER|Docker) mode="docker"; return 0 ;;
      *) printf 'Please answer local, online, or docker.\n' >/dev/tty ;;
    esac
  done
}

detect_platform() {
  local os arch raw_arch
  case "$(uname -s)" in
    Linux*)  os="Linux" ;;
    Darwin*) os="Darwin" ;;
    MINGW*|MSYS*|CYGWIN*) os="Windows" ;;
    *) err "Unsupported OS: $(uname -s)"; exit 2 ;;
  esac
  raw_arch="$(uname -m)"
  case "$raw_arch" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "Unsupported arch: $raw_arch"; exit 2 ;;
  esac
  printf '%s %s\n' "$os" "$arch"
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then return 0; fi
  warn "Bun is required for the local Convex backend but was not found on PATH."
  case "$install_bun" in
    1|true|yes|YES) : ;;
    0|false|no|NO)
      err "Bun installation disabled."
      printf 'fix: install Bun from https://bun.sh and rerun.\n' >&2
      exit 2
      ;;
    ask|"")
      if ! ask_yes_no "Install Bun now with the official bun.sh installer?"; then
        err "Installation canceled because Bun is missing."
        exit 2
      fi
      ;;
    *)
      err "Invalid DFTSTREAM_INSTALL_BUN value: $install_bun"
      exit 2
      ;;
  esac
  need curl
  if ! command -v unzip >/dev/null 2>&1; then
    warn "unzip is required by the official Bun installer but was not found."
    if [[ "$(id -u)" == "0" ]] && command -v apt-get >/dev/null 2>&1; then
      bold "Installing unzip with apt-get"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update && apt-get install -y unzip
    else
      err "Cannot install Bun automatically because unzip is missing."
      exit 2
    fi
  fi
  bold "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun installer completed, but bun is still not on PATH."
    exit 2
  fi
  ok "Installed $(bun --version) at $(command -v bun)"
}

# fetch_release_asset_url <os> <arch>
# Resolves a release tarball URL via the GitHub REST API and echoes it
# on stdout. Returns 1 if no matching asset is found.
fetch_release_asset_url() {
  local os="$1" arch="$2"
  local api ext name
  # api_base is overridable so the install tests can point at a mocked
  # release layout served over file:// (see tests/install/checksum-test.sh).
  local api_base="${DFTSTREAM_API_BASE:-https://api.github.com}"
  if [[ -z "$release_tag" || "$release_tag" == "latest" ]]; then
    api="${api_base}/repos/${repo_slug}/releases/latest"
  else
    api="${api_base}/repos/${repo_slug}/releases/tags/${release_tag}"
  fi
  ext="tar.gz"
  if [[ "$os" == "Windows" ]]; then ext="zip"; fi
  # Asset name matches the goreleaser template:
  #   dftstream_<version>_<Os>_<Arch>.<ext>
  local body
  if ! body="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null)"; then
    return 1
  fi
  # crude grep — avoid jq dependency. file:// is accepted so the
  # offline install tests can serve a mocked release from disk.
  name="$(printf '%s\n' "$body" \
    | grep -Eo '"browser_download_url"[^"]*"[^"]+"' \
    | grep -Eo '(https|file)://[^"]+' \
    | grep -F "_${os}_${arch}.${ext}" \
    | head -n1)"
  if [[ -z "$name" ]]; then
    return 1
  fi
  printf '%s\n' "$name"
}

# sha256_file <file>
# Echo the sha256 hex digest of a file. Portable across sha256sum
# (linux) and shasum (macos). Returns 1 if neither tool exists.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# verify_release_checksum <archive> <asset-url>
# Every release publishes a checksums.txt next to its archives (see
# .goreleaser.yaml). Download it from the same directory as <asset-url>
# and require that <archive> matches the entry for its filename.
# Any failure here EXITS the script — a download that cannot be
# verified must never fall back to "install it anyway".
verify_release_checksum() {
  local archive="$1" url="$2"
  local sums_url="${url%/*}/checksums.txt"
  local asset_name="${url##*/}"
  local sums expected actual
  if ! sums="$(curl -fsSL "$sums_url")"; then
    err "Could not download checksums.txt from the release (${sums_url})."
    printf 'fix: retry, or pin a release that has checksums with --release <tag>.\n' >&2
    exit 1
  fi
  # checksums.txt lines look like: <sha256>  <filename>
  # (a leading "*" on the filename marks binary mode; accept both).
  expected="$(printf '%s\n' "$sums" \
    | awk -v f="$asset_name" '$2 == f || $2 == "*" f { print $1; exit }')"
  if [[ -z "$expected" ]]; then
    err "checksums.txt has no entry for ${asset_name}."
    printf 'fix: the release looks malformed — report this at https://github.com/%s/issues\n' "$repo_slug" >&2
    exit 1
  fi
  if ! actual="$(sha256_file "$archive")"; then
    err "Neither sha256sum nor shasum is available — cannot verify the download."
    printf 'fix: install coreutils (sha256sum) or perl (shasum) and rerun.\n' >&2
    exit 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    err "Checksum mismatch for ${asset_name} — refusing to install."
    printf 'expected: %s\n' "$expected" >&2
    printf 'actual:   %s\n' "$actual" >&2
    printf 'fix: retry (a truncated download is the usual cause). If it persists,\n' >&2
    printf '     the release may be corrupted or tampered with — do not install it.\n' >&2
    exit 1
  fi
  ok "sha256 verified (${asset_name})"
}

install_binary_from_release() {
  local os arch url tmpdir archive bin_name
  read -r os arch < <(detect_platform)
  bold "Looking for release binary (${os}/${arch})"
  if ! url="$(fetch_release_asset_url "$os" "$arch")"; then
    return 1
  fi
  ok "Found $url"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN
  if [[ "$os" == "Windows" ]]; then
    archive="$tmpdir/dftstream.zip"
    curl -fsSL -o "$archive" "$url"
    verify_release_checksum "$archive" "$url"
    need unzip
    unzip -q "$archive" -d "$tmpdir/extract"
    bin_name="dftstream.exe"
  else
    archive="$tmpdir/dftstream.tar.gz"
    curl -fsSL -o "$archive" "$url"
    verify_release_checksum "$archive" "$url"
    mkdir -p "$tmpdir/extract"
    tar -xzf "$archive" -C "$tmpdir/extract"
    bin_name="dftstream"
  fi
  local found
  found="$(find "$tmpdir/extract" -type f -name "$bin_name" | head -n1)"
  if [[ -z "$found" ]]; then
    err "Release archive did not contain $bin_name."
    return 1
  fi
  install -m 0755 "$found" "$bin_dir/$bin_name"
  ok "Installed $bin_dir/$bin_name"
}

install_from_source() {
  need git
  need go
  ensure_bun  # source builds require bun for the UI bundle

  if [[ -d "$source_dir/.git" ]]; then
    bold "Updating existing checkout"
    if ! git -C "$source_dir" diff --quiet || ! git -C "$source_dir" diff --cached --quiet; then
      err "Existing checkout at $source_dir has local changes."
      exit 1
    fi
    git -C "$source_dir" fetch --depth 1 origin "$ref"
    git -C "$source_dir" checkout --detach FETCH_HEAD
  else
    bold "Cloning DFTStream"
    git clone --filter=blob:none "$repo_url" "$source_dir"
    git -C "$source_dir" fetch --depth 1 origin "$ref"
    git -C "$source_dir" checkout --detach FETCH_HEAD
  fi

  bold "Building from source"
  (
    cd "$source_dir/wrapper"
    export GOMODCACHE="${GOMODCACHE:-$source_dir/.cache/go/pkg/mod}"
    export GOCACHE="${GOCACHE:-$source_dir/.cache/go/build}"
    mkdir -p "$GOMODCACHE" "$GOCACHE"
    GOBIN="$bin_dir" make install
  )
  ok "Installed $bin_dir/dftstream"
}

clone_source_for_local_mode() {
  # Local mode needs the repo regardless of install method, because
  # the Convex local backend reads ./db/convex at runtime.
  if [[ -d "$source_dir/.git" ]]; then
    bold "Updating Convex source checkout at $source_dir"
    if git -C "$source_dir" diff --quiet && git -C "$source_dir" diff --cached --quiet; then
      git -C "$source_dir" fetch --depth 1 origin "$ref"
      git -C "$source_dir" checkout --detach FETCH_HEAD || true
    else
      warn "Checkout has local changes — leaving it untouched."
    fi
  else
    bold "Cloning Convex source for the local backend"
    git clone --filter=blob:none "$repo_url" "$source_dir"
    git -C "$source_dir" fetch --depth 1 origin "$ref"
    git -C "$source_dir" checkout --detach FETCH_HEAD || true
  fi
}

write_shim() {
  local name="$1" target="$2"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'export DFTSTREAM_SOURCE=%q\n' "$source_dir"
    printf 'exec %q "$@"\n' "$target"
  } > "$bin_dir/$name"
  chmod +x "$bin_dir/$name"
}

run_uninstall() {
  bold "Uninstalling DFTStream"
  local removed=0 f
  for f in "$bin_dir/dftstream" "$bin_dir/dftstream.exe" "$bin_dir/dftstream-db"; do
    if [[ -e "$f" ]]; then
      rm -f "$f"
      ok "Removed $f"
      removed=1
    fi
  done
  if [[ "$removed" == "0" ]]; then
    warn "No DFTStream binaries found in $bin_dir."
  fi

  if [[ "$do_purge" == "1" ]]; then
    if [[ ! -d "$config_dir" && ! -d "$source_dir" ]]; then
      ok "Nothing to purge."
      ok "DFTStream uninstall complete"
      return 0
    fi
    warn "--purge will delete:"
    [[ -d "$config_dir" ]] && printf '  %s (config)\n' "$config_dir" >&2
    [[ -d "$source_dir" ]] && printf '  %s (source checkout; a local Convex backend stores its DATABASE under db/.convex here)\n' "$source_dir" >&2
    if ! ask_yes_no "Really delete these directories? Runs tracked in a local database are lost forever."; then
      err "Purge canceled — directories left in place (binaries were still removed)."
      printf 'fix: rerun interactively with --uninstall --purge to confirm.\n' >&2
      exit 1
    fi
    rm -rf "$config_dir" "$source_dir"
    ok "Removed $config_dir and $source_dir"
  else
    [[ -d "$config_dir" ]] && printf 'kept: %s (config)\n' "$config_dir" >&2
    [[ -d "$source_dir" ]] && printf 'kept: %s (source checkout + any local Convex database)\n' "$source_dir" >&2
  fi
  ok "DFTStream uninstall complete"
}

# --- Main ---

if [[ "$do_uninstall" == "1" ]]; then
  run_uninstall
  exit 0
fi

need curl
resolve_mode_interactive

if [[ "$mode" == "online" || "$mode" == "docker" ]]; then
  if [[ -z "$online_url" ]]; then
    if [[ ! -r /dev/tty ]]; then
      if [[ "$mode" == "docker" ]]; then
        err "Docker mode needs --convex-url or DFTSTREAM_CONVEX_URL when stdin is not a TTY."
      else
        err "Online mode needs --convex-url or DFTSTREAM_CONVEX_URL when stdin is not a TTY."
      fi
      exit 2
    fi
    if [[ "$mode" == "docker" ]]; then
      online_url="$(ask_one 'Convex Docker container URL' 'http://your-server:16767')"
    else
      online_url="$(ask_one 'Convex deployment URL' 'https://your-deployment.convex.cloud')"
    fi
  fi
  case "$online_url" in
    http://*|https://*) ;;
    *) err "Convex URL must start with http:// or https://"; exit 2 ;;
  esac
fi

mkdir -p "$bin_dir" "$config_dir" "$(dirname -- "$source_dir")"

bold "Installing DFTStream"
printf 'mode:   %s\n' "$mode" >&2
printf 'method: %s\n' "$install_method" >&2
printf 'bin:    %s\n' "$bin_dir" >&2
printf 'config: %s\n' "$config_dir" >&2
printf 'repo:   %s (%s)\n' "$repo_slug" "$ref" >&2

installed_via_binary=0
case "$install_method" in
  binary)
    need tar
    if ! install_binary_from_release; then
      err "No release binary available for this platform."
      printf 'fix: rerun with --method source to build from source.\n' >&2
      exit 1
    fi
    installed_via_binary=1
    ;;
  source)
    install_from_source
    ;;
  auto)
    need tar
    if install_binary_from_release; then
      installed_via_binary=1
    else
      warn "No release binary available — falling back to source build."
      install_from_source
    fi
    ;;
esac

if [[ "$mode" == "local" ]]; then
  if [[ "$installed_via_binary" == "1" ]]; then
    need git
    clone_source_for_local_mode
  fi
  bold "Installing Convex local backend dependencies"
  ensure_bun
  (cd "$source_dir/db" && bun install)
  mkdir -p "$source_dir/db/.convex/tmp"
  if [[ -x "$source_dir/scripts/dftstream-db.sh" ]]; then
    write_shim dftstream-db "$source_dir/scripts/dftstream-db.sh"
    ok "Installed $bin_dir/dftstream-db"
  fi
fi

config_file="$config_dir/config.json"
if [[ "$mode" == "online" || "$mode" == "docker" ]]; then
  resolved_convex_url="$online_url"
else
  resolved_convex_url="http://127.0.0.1:3210"
fi
if [[ -f "$config_file" ]]; then
  warn "Config file $config_file already exists — leaving it untouched."
  printf 'fix: edit it by hand if you want to change the Convex URL.\n' >&2
else
  printf '{\n  "convexUrl": "%s"\n}\n' "$resolved_convex_url" > "$config_file"
  ok "Wrote $config_file"
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    warn "$bin_dir is not on PATH."
    printf 'fix: add this to your shell profile:\n' >&2
    printf '  export PATH=%q:"$PATH"\n' "$bin_dir" >&2
    ;;
esac

printf '\n' >&2
"$bin_dir/dftstream" version 2>/dev/null | sed 's/^/installed: /' >&2 || true

printf '\nNext steps:\n' >&2
step=1
if [[ "$mode" == "local" ]]; then
  printf '  %d. Start the local backend (keep this running):\n' "$step" >&2
  printf '       dftstream-db\n\n' >&2
  step=$((step + 1))
fi
if [[ "$mode" == "docker" ]]; then
  printf '  %d. Start the Convex Docker container on your server:\n' "$step" >&2
  printf '       cd <dftstream-source>/db\n' >&2
  printf '       docker compose -f docker/docker-compose.yml up -d\n\n' >&2
  step=$((step + 1))
  printf '  %d. (After function changes) push updated functions:\n' "$step" >&2
  printf '       bash db/docker/push-functions.sh %s\n\n' "$resolved_convex_url" >&2
  step=$((step + 1))
fi
printf '  %d. Run an ORCA job through dftstream:\n' "$step" >&2
printf '       export DFTSTREAM_ORCA=/path/to/orca\n' >&2
if [[ "$mode" == "online" || "$mode" == "docker" ]]; then
  printf '       export DFTSTREAM_TRACKER_URL=convex+%s\n' "$resolved_convex_url" >&2
fi
printf '       dftstream run my-input.inp --exp my-experiment > my-input.out\n\n' >&2
step=$((step + 1))
printf '  %d. Open the web UI (browse to http://127.0.0.1:3000):\n' "$step" >&2
printf '       dftstream ui\n\n' >&2

cat >&2 <<EOF
Tip: change the Convex URL later by editing $config_file
     or by passing --convex-url to \`dftstream ui\`.
EOF
ok "DFTStream install complete"
