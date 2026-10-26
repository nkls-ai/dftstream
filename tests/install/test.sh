#!/usr/bin/env bash
# tests/install/test.sh - end-to-end check of `scripts/install.sh`.
#
# Designed to run in a fresh Linux environment (the docker container
# built by tests/install/Dockerfile, or a GitHub Actions ubuntu-latest
# runner) where:
#
#   - `go` is on PATH
#   - `curl`, `git`, `unzip`, `tar` are available
#   - network access reaches npm + bun.sh + go.dev module proxy
#
# The script overrides HOME / XDG paths to live inside a sandbox dir,
# so it never touches the host's real ~/.local/bin or ~/.config.
#
# It exercises three things:
#   1. The README's `curl ... | bash` install (via --method source against
#      a file:// URL pointing at this very repo, since we don't depend
#      on a published GitHub release).
#   2. The installed `dftstream`, `dftstream-db`, and embedded UI.
#   3. A wrapper run against a fake `orca` binary, then a read-back
#      query against the local Convex backend to confirm the run landed.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(cd -- "$script_dir/../.." >/dev/null 2>&1 && pwd)"

# Where the install script will clone from. Default to a file:// URL
# pointing at this working tree, which lets us test uncommitted
# branches just like a `curl | bash` install would test the live repo.
test_repo="${DFTSTREAM_TEST_REPO:-}"
test_ref="${DFTSTREAM_TEST_REF:-}"

sandbox="${DFTSTREAM_TEST_SANDBOX:-$(mktemp -d -t dftstream-install-XXXXXX)}"
export HOME="$sandbox/home"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"

bin_dir="$HOME/.local/bin"
config_dir="$XDG_CONFIG_HOME/dftstream"

export PATH="$bin_dir:$HOME/.bun/bin:/usr/local/go/bin:$PATH"

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

# Stage a writable bare clone of the repo inside the sandbox so install.sh
# can clone + fetch by commit SHA without us mutating the source tree (the
# source might be a read-only bind-mount in docker, or owned by another
# user in CI). The bare clone gets the config bits needed to serve
# install.sh's `git fetch --depth 1 origin <sha>`.
stage_repo="$sandbox/stage.git"
if [[ -z "$test_repo" ]]; then
  git clone --bare "$repo_root" "$stage_repo" >/dev/null
  # install.sh runs `git clone --filter=blob:none` and `git fetch --depth 1`
  # against this remote. Without these toggles the remote silently falls
  # back to a full clone and spams "filtering not recognized by server,
  # ignoring" on every fetch. Allowing filter + reachable-SHA1 makes the
  # install logs clean and matches how GitHub serves real clones.
  git -C "$stage_repo" config uploadpack.allowFilter true
  git -C "$stage_repo" config uploadpack.allowAnySHA1InWant true
  git -C "$stage_repo" config uploadpack.allowReachableSHA1InWant true
  test_repo="file://$stage_repo"
fi
if [[ -z "$test_ref" ]]; then
  test_ref="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo main)"
fi

dim "repo:    $test_repo"
dim "ref:     $test_ref"
dim "sandbox: $sandbox"

db_pid=""
ui_pid=""
cleanup() {
  if [[ -n "$ui_pid" ]] && kill -0 "$ui_pid" 2>/dev/null; then
    kill "$ui_pid" 2>/dev/null || true
  fi
  if [[ -n "$db_pid" ]] && kill -0 "$db_pid" 2>/dev/null; then
    kill "$db_pid" 2>/dev/null || true
    # Convex spawns child processes; give them a moment to exit.
    sleep 1
    pkill -P "$db_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ----------------------------------------------------------------------
# 0. Checksum verification of release downloads, against a mocked
#    release served over file:// (fast, offline; see checksum-test.sh).
# ----------------------------------------------------------------------

bold "Checksum verification (mocked release)"
bash "$script_dir/checksum-test.sh"
ok "release downloads are sha256-verified"

# ----------------------------------------------------------------------
# 1. Run the install script exactly as a user would — via stdin pipe.
# ----------------------------------------------------------------------

bold "Run install.sh (source build, local backend)"
# Cat the install script through bash to mimic the README's
# `curl ... | bash -s -- <flags>` flow. We force --method source
# because we don't expect a release tarball for the current commit.
cat "$repo_root/scripts/install.sh" | bash -s -- \
  --method source \
  --mode local \
  --repo "$test_repo" \
  --ref "$test_ref" \
  --install-bun

ok "install.sh completed"

# ----------------------------------------------------------------------
# 2. The two binaries are present and look right.
# ----------------------------------------------------------------------

bold "Installed commands"
test -x "$bin_dir/dftstream"     || { red "dftstream not installed"; exit 1; }
test -x "$bin_dir/dftstream-db"  || { red "dftstream-db not installed"; exit 1; }
ok "dftstream at $bin_dir/dftstream"
ok "dftstream-db at $bin_dir/dftstream-db"

version_out="$("$bin_dir/dftstream" version)"
dim "version: $version_out"
echo "$version_out" | grep -qi dftstream || { red "version output unexpected: $version_out"; exit 1; }
ok "dftstream version works"

# ----------------------------------------------------------------------
# 3. config.json points at the local backend.
# ----------------------------------------------------------------------

bold "Generated config"
test -f "$config_dir/config.json" || { red "config.json not written"; exit 1; }
cat "$config_dir/config.json"
grep -q '127.0.0.1:3210' "$config_dir/config.json" || {
  red "config.json does not point at the local Convex URL"
  exit 1
}
ok "config.json -> http://127.0.0.1:3210"

# ----------------------------------------------------------------------
# 4. Start the local Convex backend and wait for it.
# ----------------------------------------------------------------------

bold "Start Convex backend"
"$bin_dir/dftstream-db" start > "$sandbox/db.log" 2>&1 &
db_pid=$!
dim "dftstream-db pid: $db_pid"

if ! "$bin_dir/dftstream-db" wait; then
  red "Convex did not become reachable in 60s"
  tail -n 80 "$sandbox/db.log" >&2 || true
  exit 1
fi
ok "Convex backend reachable at http://127.0.0.1:3210"

# Convex's `dev` mode pushes functions in the background after the HTTP
# port comes up. Queries and mutations can become callable at different
# times during that push, so we wait until a mutation (the same kind the
# wrapper uses) actually executes successfully. Anything less can race.
for i in $(seq 1 30); do
  resp="$(curl -sf -m 5 http://127.0.0.1:3210/api/mutation \
       -H 'content-type: application/json' \
       -d '{"path":"experiments:ensure","args":{"name":"__install_test_warmup__"},"format":"json"}' 2>/dev/null || true)"
  if [[ -n "$resp" ]] && echo "$resp" | grep -q '"status":"success"'; then
    ok "Convex functions deployed (warmup mutation succeeded)"
    break
  fi
  sleep 2
  if (( i == 30 )); then
    red "Convex functions not deployed after 60s"
    dim "last response: $resp"
    tail -n 80 "$sandbox/db.log" >&2 || true
    exit 1
  fi
done

# ----------------------------------------------------------------------
# 5. Serve the embedded UI and check the bundle is reachable.
# ----------------------------------------------------------------------

bold "Serve UI bundle"
"$bin_dir/dftstream" ui > "$sandbox/ui.log" 2>&1 &
ui_pid=$!
dim "dftstream ui pid: $ui_pid"

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf http://127.0.0.1:3000/ -o "$sandbox/index.html"; then
    break
  fi
  sleep 1
  if (( i == 10 )); then
    red "UI did not respond on 127.0.0.1:3000"
    tail -n 80 "$sandbox/ui.log" >&2 || true
    exit 1
  fi
done

# The embedded UI bundle should be HTML referencing the DFTStream app.
grep -qi 'dftstream\|<title' "$sandbox/index.html" || {
  red "Served HTML does not look like the DFTStream UI"
  head -c 800 "$sandbox/index.html" >&2
  exit 1
}
ok "UI HTML served"

# The HTML should pull in JS assets; pick the first one and confirm it
# returns 200 too. This verifies the embedded bundle's static assets
# are wired up, not just index.html.
bundle_js="$(grep -Eo 'src="[^"]+\.js"' "$sandbox/index.html" | head -n1 | sed 's/src="//; s/"$//')"
if [[ -n "$bundle_js" ]]; then
  status="$(curl -sw '%{http_code}' -o "$sandbox/bundle.js" "http://127.0.0.1:3000${bundle_js}")"
  if [[ "$status" != "200" ]]; then
    red "UI bundle asset $bundle_js returned $status"
    exit 1
  fi
  ok "UI bundle JS asset served (${bundle_js}, $(wc -c <"$sandbox/bundle.js") bytes)"
else
  dim "No <script src> in index.html; skipping asset check"
fi

# ----------------------------------------------------------------------
# 6. Run a wrapper job against a fake ORCA and confirm the run lands.
# ----------------------------------------------------------------------

bold "Wrapper run (fake ORCA)"
fake_orca="$sandbox/fake-orca"
cat > "$fake_orca" <<'FAKE'
#!/usr/bin/env bash
# Smallest-possible fake of ORCA's stdout: enough landmarks for the
# parser to advance through SCF + final-energy + termination states
# without crashing. We're testing the install + wrapper plumbing, not
# the parser itself (which has its own unit tests).
cat <<'OUT'
       * O   R   C   A *

         Program Version 6.0.0 (fake, install-test only)

                       SCF ITERATIONS
  0  -1.10000000   0.000000  0.000000  0.000000  0.000000
  1  -1.12000000  -0.020000  0.000000  0.000000  0.000000

FINAL SINGLE POINT ENERGY      -1.12000000

                       ****ORCA TERMINATED NORMALLY****
TOTAL RUN TIME: 0 days 0 hours 0 minutes 0 seconds 100 msec
OUT
FAKE
chmod +x "$fake_orca"

cat > "$sandbox/h2.inp" <<'INP'
! HF DEF2-SVP
* xyz 0 1
H 0.0 0.0 0.0
H 0.0 0.0 0.74
*
INP

exp_name="install-test-$$"
cd "$sandbox"
if ! "$bin_dir/dftstream" run h2.inp \
       --orca "$fake_orca" \
       --exp "$exp_name" \
       --name h2-smoke \
       > h2.stdout 2> h2.stderr; then
  red "dftstream run failed"
  echo "--- stderr ---" >&2
  cat h2.stderr >&2 || true
  echo "--- stdout ---" >&2
  head -c 2000 h2.stdout >&2 || true
  exit 1
fi
grep -q 'ORCA TERMINATED NORMALLY' h2.stdout || {
  red "fake ORCA stdout did not pass through to captured stdout"
  exit 1
}
ok "wrapper ran fake ORCA and exited 0"

# ----------------------------------------------------------------------
# 7. Read back through Convex to confirm the run landed.
# ----------------------------------------------------------------------

bold "Verify run lands in Convex"
resp="$(curl -sf http://127.0.0.1:3210/api/query \
    -H 'content-type: application/json' \
    -d "{\"path\":\"experiments:getByName\",\"args\":{\"name\":\"$exp_name\"},\"format\":\"json\"}")"
dim "experiments:getByName -> $resp"
echo "$resp" | grep -q '"status":"success"' || {
  red "Convex query failed: $resp"
  exit 1
}
echo "$resp" | grep -q "\"name\":\"$exp_name\"" || {
  red "experiment $exp_name not in Convex: $resp"
  exit 1
}
ok "experiment $exp_name visible to Convex"

bold "All install-test checks passed"
