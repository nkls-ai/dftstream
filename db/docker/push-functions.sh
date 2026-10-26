#!/usr/bin/env bash
set -euo pipefail

# Push updated Convex functions to a running DFTStream Docker container.
# Zero downtime — the backend stays up, only functions get replaced.
#
# Usage:
#   ./push-functions.sh [URL]
#
# Admin key resolution order:
#   1. Host-mounted state dir (db/docker/state/.admin_key)
#   2. docker compose exec into the running container
#   3. CONVEX_SELF_HOSTED_ADMIN_KEY env var

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
db_dir="$(cd -- "$script_dir/.." && pwd)"
state_dir="$script_dir/state"

url="${1:-http://localhost:16767}"

# Read URL from state dir if available and no explicit arg given.
if [[ $# -eq 0 && -f "$state_dir/.url" ]]; then
  url="$(cat "$state_dir/.url")"
fi

if ! curl -fsS "$url/instance_name" >/dev/null 2>&1; then
  echo "error: Cannot reach Convex backend at $url" >&2
  echo "fix: start the container with 'docker compose up -d' from db/docker/" >&2
  exit 1
fi

# Resolve admin key.
admin_key=""
if [[ -f "$state_dir/.admin_key" ]]; then
  admin_key="$(cat "$state_dir/.admin_key")"
fi

if [[ -z "$admin_key" ]]; then
  # Fallback: try docker compose exec (works regardless of container name).
  admin_key="$(cd "$script_dir" && docker compose exec -T convex cat /convex/data/.admin_key 2>/dev/null || true)"
fi

if [[ -z "$admin_key" ]]; then
  admin_key="${CONVEX_SELF_HOSTED_ADMIN_KEY:-}"
fi

if [[ -z "$admin_key" ]]; then
  echo "error: No admin key found." >&2
  echo "fix: ensure the container is running, or set CONVEX_SELF_HOSTED_ADMIN_KEY" >&2
  exit 1
fi

echo "Pushing functions to $url (zero-downtime)"

cd "$db_dir"
# Admin key must not be world-readable on shared hosts: private temp file, not a fixed /tmp path.
env_file="$(mktemp)"
chmod 600 "$env_file"
trap 'rm -f "$env_file"' EXIT
cat > "$env_file" <<EOF
CONVEX_SELF_HOSTED_URL=${url}
CONVEX_SELF_HOSTED_ADMIN_KEY=${admin_key}
EOF

if bunx convex dev --once --env-file "$env_file" 2>&1; then
  echo "success: Functions pushed to $url"
else
  echo "error: Function push failed" >&2
  exit 1
fi
