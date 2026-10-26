#!/usr/bin/env bash
set -euo pipefail

port="${CONVEX_PORT:-16767}"
site_port="${CONVEX_SITE_PORT:-16768}"
instance_name="${CONVEX_INSTANCE_NAME:-dftstream}"

# Use the official image's credential management.
export INSTANCE_NAME="$instance_name"
export DATA_DIR="/convex/data"
source /convex/read_credentials.sh

db_file="$DATA_DIR/convex_local_backend.sqlite3"
storage_dir="$DATA_DIR/storage"
mkdir -p "$storage_dir"

echo "Starting convex-local-backend on 0.0.0.0:${port}"
/convex/convex-local-backend \
  --port "$port" \
  --site-proxy-port "$site_port" \
  --instance-name "$INSTANCE_NAME" \
  --instance-secret "$INSTANCE_SECRET" \
  --local-storage "$storage_dir" \
  "$db_file" &
backend_pid=$!

# Wait for backend to become healthy.
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if curl -fsS "http://127.0.0.1:${port}/instance_name" >/dev/null 2>&1; then
    echo "Backend healthy"
    break
  fi
  sleep 0.5
done

if ! kill -0 "$backend_pid" 2>/dev/null; then
  echo "ERROR: backend process died" >&2
  exit 1
fi

# Generate admin key using the official binary.
admin_key="$(/convex/generate_key "$INSTANCE_NAME" "$INSTANCE_SECRET")"
echo "Admin key generated — pushing functions"

cd /app/db
cat > /tmp/.env.convex <<EOF
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${port}
CONVEX_SELF_HOSTED_ADMIN_KEY=${admin_key}
EOF
# Also export so commands that don't take --env-file (e.g. `convex env set`)
# still target this self-hosted deployment.
export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:${port}"
export CONVEX_SELF_HOSTED_ADMIN_KEY="${admin_key}"

# Convex requires every env var *named* in auth.config.ts to exist in the
# deployment — even ones behind an `if` guard that go unused. auth.config.ts
# references CLERK_JWT_ISSUER_DOMAIN (for hosted Clerk auth); in this no-auth
# image it isn't set, which aborts the function push with "… is used in auth
# config file but its value was not set". Seed it (empty = no Clerk provider) so
# the push succeeds. Override by passing CLERK_JWT_ISSUER_DOMAIN to the
# container to actually enable Clerk. Best-effort: a failure here just surfaces
# in the push step below.
bunx convex env set CLERK_JWT_ISSUER_DOMAIN "${CLERK_JWT_ISSUER_DOMAIN:-}" 2>&1 \
  || echo "WARNING: could not seed CLERK_JWT_ISSUER_DOMAIN env var" >&2

if bunx convex dev --once --env-file /tmp/.env.convex 2>&1; then
  echo "Functions pushed successfully"
else
  echo "WARNING: function push failed — backend is running but functions may be stale" >&2
fi

# Write admin key to volume so external tools can read it. Owner-only: the key
# grants full admin on the deployment.
printf '%s' "$admin_key" > "$DATA_DIR/.admin_key"
chmod 600 "$DATA_DIR/.admin_key"

# Also write to host-mounted state dir if available.
if [[ -d /convex/state ]]; then
  printf '%s' "$admin_key" > /convex/state/.admin_key
  chmod 600 /convex/state/.admin_key
  printf '%s' "http://127.0.0.1:${port}" > /convex/state/.url
fi

echo "Convex backend ready on port ${port}"
wait "$backend_pid"
