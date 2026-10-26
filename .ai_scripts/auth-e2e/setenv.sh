#!/usr/bin/env bash
# Set (or with an empty value + UNSET=1, delete) env vars on the LOCAL Convex
# deployment through the admin REST API.  setenv.sh NAME VALUE
set -euo pipefail
url="${OS_CONVEX_URL:-http://127.0.0.1:3210}"
case "$url" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-local $url" >&2; exit 2;; esac
key="$(bash "$(dirname -- "$0")/../../scripts/dftstream-db.sh" admin-key 2>/dev/null)"
if [[ "${UNSET:-0}" == 1 ]]; then body=$(python3 -c 'import json,sys;print(json.dumps({"changes":[{"name":sys.argv[1]}]}))' "$1")
else body=$(python3 -c 'import json,sys;print(json.dumps({"changes":[{"name":sys.argv[1],"value":sys.argv[2]}]}))' "$1" "$2"); fi
curl -fsS -X POST -H "Authorization: Convex $key" -H "Content-Type: application/json" -d "$body" "$url/api/v1/update_environment_variables"
echo
